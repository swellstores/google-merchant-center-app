import { ensureDataSources, loadMarkets } from '../connection/markets';
import { loadConnection, type Connection } from '../connection/store';
import { accessTokenFor, markBroken } from '../connection/token';
import type { AppContext } from '../context';
import { GoogleApiError } from '../google/http';
import type { OfferDefaults } from '../mapping/offers';
import { Budget, iso, nextNoonUtc } from '../time';
import { setAlarm } from './alarm';
import { deliver, SEND_RESERVE_MS, type DeliveryEnv } from './deliver';
import { fullSyncPass } from './full-sync';
import { queueCount, settleQueue, takeQueue, unitsFromQueue } from './queue';
import { loadState, saveState, type FullSyncJob, type SyncState } from './state';

export const COURIER_BUDGET_MS = 7000;
/** A mark older than this belongs to a run the platform killed. */
export const RUNNING_TTL_MS = 30_000;
export const NEXT_RUN_MS = 15_000;
export const MAX_BACKOFF_MS = 15 * 60_000;
/** Clock skew allowed between a run and the time it was asked to come at. */
export const EARLY_TOLERANCE_MS = 2000;

const QUEUE_TAKE = 50;
const PASS_RESERVE_MS = SEND_RESERVE_MS + 500;
// Phase 1 has no settings for defaults yet (plan 3 adds them).
const DEFAULTS: OfferDefaults = { condition: 'new' };

export interface CourierOutcome {
  next: 'idle' | 'soon' | 'later' | 'paused' | 'early' | 'busy';
  sent: number;
}

/** Keeps sends under Google's per-minute limit. */
export function pacedDelay(sentOps: number, minuteLimit?: number | null): number {
  if (!minuteLimit) return NEXT_RUN_MS;
  return Math.max(NEXT_RUN_MS, Math.ceil((sentOps / minuteLimit) * 60_000));
}

async function work(ctx: AppContext, connection: Connection, state: SyncState, budget: Budget) {
  let sent = 0;
  let failure: GoogleApiError | undefined;
  let queueMore = false;

  const token = await accessTokenFor(ctx, connection);
  const markets = await ensureDataSources(ctx, token, connection.merchant_id!, await loadMarkets(ctx.swell));
  const env: DeliveryEnv = { ctx, accountId: connection.merchant_id!, token, markets, defaults: DEFAULTS, budget };

  // Fresh changes go first.
  while (!failure && budget.has(PASS_RESERVE_MS)) {
    const items = await takeQueue(ctx.swell, QUEUE_TAKE);
    if (!items.length) break;
    const report = await deliver(env, unitsFromQueue(items));
    await settleQueue(ctx, report.done, report.kept);
    sent += report.sentOps;
    failure = report.failure;
    queueMore = items.length === QUEUE_TAKE || report.kept.length > 0 || report.untouched.length > 0;
    if (!report.done.length || report.kept.length > 0 || items.length < QUEUE_TAKE) break;
  }

  let job: FullSyncJob | null | undefined = state.full_sync;
  while (!failure && !queueMore && job?.status === 'running' && budget.has(PASS_RESERVE_MS)) {
    const pass = await fullSyncPass(env, job);
    sent += pass.sentOps;
    failure = pass.failure;
    job = pass.job;
    if (!pass.progressed) break;
  }
  return { sent, failure, queueMore, job };
}

/**
 * One courier run: the queue, then the catalog sync, within a 7 s budget.
 * Ends by setting the alarm for the next run, or clearing it when idle.
 */
export async function runCourier(ctx: AppContext): Promise<CourierOutcome> {
  const budget = new Budget(ctx.now, COURIER_BUDGET_MS);
  const connection = await loadConnection(ctx.swell);
  if (connection?.status !== 'connected' || !connection.merchant_id) {
    await setAlarm(ctx, null);
    return { next: 'idle', sent: 0 };
  }

  const state = await loadState(ctx.swell);
  const now = ctx.now();
  // Every wake_at ever written runs once (the platform cancels nothing), so runs
  // come early and in pairs. A run before the time the last run asked for, or
  // while another run works, leaves everything as it is: the run scheduled for
  // that time still comes, and the working run sets the next alarm.
  const notBefore = state.not_before ? Date.parse(state.not_before) : 0;
  if (notBefore - now > EARLY_TOLERANCE_MS) return { next: 'early', sent: 0 };
  if (state.running_since && now - Date.parse(state.running_since) < RUNNING_TTL_MS) return { next: 'busy', sent: 0 };

  await saveState(ctx.swell, state.id, { running_since: iso(now) });
  let result: Awaited<ReturnType<typeof work>>;
  try {
    result = await work(ctx, connection, state, budget);
  } catch (error) {
    if (!(error instanceof GoogleApiError)) {
      const retryAt = ctx.now() + NEXT_RUN_MS;
      await saveState(ctx.swell, state.id, { running_since: null, not_before: iso(retryAt) }).catch(() => undefined);
      await setAlarm(ctx, retryAt).catch(() => undefined);
      throw error;
    }
    result = { sent: 0, failure: error, queueMore: true, job: state.full_sync };
  }

  const { sent, failure, queueMore, job } = result;
  const end = ctx.now();
  const patch: Record<string, unknown> = { running_since: null };
  if (job !== state.full_sync) patch.full_sync = { $set: job };

  if (failure?.kind === 'auth') {
    await saveState(ctx.swell, state.id, { ...patch, not_before: null, last_error: failure.message });
    await markBroken(ctx, connection, failure.message);
    await setAlarm(ctx, null);
    return { next: 'idle', sent };
  }
  if (failure?.kind === 'daily_quota') {
    const until = nextNoonUtc(end);
    await saveState(ctx.swell, state.id, { ...patch, not_before: iso(until), quota: { $set: { ...state.quota, exhausted_until: iso(until) } }, last_error: failure.message });
    await setAlarm(ctx, until);
    return { next: 'paused', sent };
  }
  if (failure) {
    const backoff = (state.backoff ?? 0) + 1;
    const at = end + Math.min(NEXT_RUN_MS * 2 ** backoff, MAX_BACKOFF_MS);
    await saveState(ctx.swell, state.id, { ...patch, backoff, not_before: iso(at), last_error: failure.message });
    await setAlarm(ctx, at);
    return { next: 'later', sent };
  }

  const more = queueMore || job?.status === 'running' || (await queueCount(ctx.swell)) > 0;
  if (more) {
    const at = end + pacedDelay(sent, state.quota?.minute_limit);
    await saveState(ctx.swell, state.id, { ...patch, backoff: 0, not_before: iso(at), last_error: null });
    await setAlarm(ctx, at);
    return { next: 'soon', sent };
  }
  await saveState(ctx.swell, state.id, { ...patch, backoff: 0, not_before: null, last_error: null });
  await setAlarm(ctx, null);
  return { next: 'idle', sent };
}
