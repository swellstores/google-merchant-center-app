import { ensureDataSources, marketsRead, type Market } from '../connection/markets';
import { connectionRead, connectionWrite, type Connection } from '../connection/store';
import { accessTokenFor, brokenPatch } from '../connection/token';
import type { AppContext } from '../context';
import { GoogleApiError } from '../google/http';
import type { OfferDefaults } from '../mapping/offers';
import { countOf, entryError, listOf, Outbox, recordOf, swellBatch } from '../swell-batch';
import { Budget, iso, nextNoonUtc } from '../time';
import { alarmRead, alarmWrite, type Alarm } from './alarm';
import { deliver, type DeliveryEnv } from './deliver';
import { fullSyncPass } from './full-sync';
import { readQuota } from './hourly';
import { itemsRead, settleWrites, takeRead, unitsFromQueue, type QueueItem } from './queue';
import { stateById, stateRead, stateWrite, type FullSyncJob, type SyncState } from './state';

export const COURIER_BUDGET_MS = 7000;
/** A mark older than this belongs to a run the platform killed. */
export const RUNNING_TTL_MS = 30_000;
export const NEXT_RUN_MS = 15_000;
export const MAX_BACKOFF_MS = 15 * 60_000;
/** Clock skew allowed between a run and the time it was asked to come at. */
export const EARLY_TOLERANCE_MS = 2000;
/** A product read and one Google batch: no pass starts with less time left. */
export const PASS_RESERVE_MS = 2500;

const QUEUE_TAKE = 50;
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

/** What a working run knows, and what it writes at its end. */
interface Run {
  ctx: AppContext;
  budget: Budget;
  outbox: Outbox;
  connection: Connection;
  /** A refreshed token, saved with the run's last writes */
  connectionPatch: Partial<Connection>;
  state: SyncState;
  quotaChanged: boolean;
  alarm: Alarm | null;
  markets: Market[];
  /** The queue head the start read took */
  queue: QueueItem[];
  /** Items behind the head */
  waiting: number;
  /** The state as the last round trip of the run read it */
  latest?: SyncState | null;
}

interface WorkResult {
  sent: number;
  failure?: GoogleApiError;
  queueMore: boolean;
  job: FullSyncJob | null | undefined;
}

/** Everything a run decides on, in one round trip. */
async function readStart(ctx: AppContext) {
  const answers = await swellBatch(ctx.swell, [connectionRead, stateRead, alarmRead, marketsRead, takeRead(QUEUE_TAKE)]);
  const queue = listOf<QueueItem>(answers[4], 'the queue');
  return {
    connection: listOf<Connection>(answers[0], 'the connection')[0] ?? null,
    state: listOf<SyncState>(answers[1], 'the sync state')[0] ?? null,
    alarm: listOf<Alarm>(answers[2], 'the alarm')[0] ?? null,
    markets: listOf<Market>(answers[3], 'the markets'),
    queue,
    waiting: countOf(answers[4]) - queue.length,
  };
}

/** The fields of an idle store's state that `state` does not have yet. */
function idleReset(state: SyncState | null): Record<string, unknown> | null {
  if (!state) return null;
  const patch: Record<string, unknown> = {};
  if (state.running_since) patch.running_since = null;
  if (state.not_before) patch.not_before = null;
  if (state.backoff) patch.backoff = 0;
  if (state.last_error) patch.last_error = null;
  return Object.keys(patch).length ? patch : null;
}

async function work(run: Run): Promise<WorkResult> {
  const { ctx, connection, state, budget, outbox } = run;
  let sent = 0;
  let failure: GoogleApiError | undefined;
  let job = state.full_sync;

  const token = await accessTokenFor(ctx, connection, (patch) => Object.assign(run.connectionPatch, patch));
  // Pacing needs the per-minute limit from the first run on.
  if (!state.quota?.date_checked) {
    const quota = await readQuota(ctx, token, connection.merchant_id!, state.quota);
    if (quota) {
      state.quota = quota;
      run.quotaChanged = true;
    }
  }
  const markets = await ensureDataSources(ctx, token, connection.merchant_id!, run.markets);
  const env: DeliveryEnv = { ctx, accountId: connection.merchant_id!, token, markets, defaults: DEFAULTS, budget, outbox };
  const reread = stateById(state.id);

  // Fresh changes go first. Each pass sends its writes with the reads that
  // settle it; the settling writes wait for the next round trip.
  let items = run.queue;
  let waiting = run.waiting;
  let left = false;
  const taken: string[] = [];
  while (items.length && budget.has(PASS_RESERVE_MS)) {
    const ids = items.map((item) => item.id);
    taken.push(...ids);
    const report = await deliver(env, unitsFromQueue(items));
    const [current, latest] = await outbox.send([itemsRead(ids), reread]);
    run.latest = recordOf<SyncState>(latest, 'the sync state');
    const settled = settleWrites(ctx, report.done, report.kept, listOf<QueueItem>(current, 'the taken queue items'));
    outbox.add(...settled.writes);
    items = [];
    sent += report.sentOps;
    failure = report.failure;
    left ||= settled.removed.length < ids.length;
    // Kept units wait for the next run: no retries in the same run.
    if (failure || report.kept.length || report.untouched.length || !waiting || !budget.has(PASS_RESERVE_MS)) break;
    const [next] = await outbox.send([takeRead(QUEUE_TAKE, taken)]);
    items = listOf<QueueItem>(next, 'the queue');
    waiting = countOf(next) - items.length;
  }
  const queueMore = left || items.length > 0 || waiting > 0;

  while (!failure && !queueMore && job?.status === 'running' && budget.has(PASS_RESERVE_MS)) {
    // Settled items leave before the hand-off looks at the queue.
    if (outbox.size) await outbox.send();
    const pass = await fullSyncPass(env, job, [reread]);
    run.latest = recordOf<SyncState>(pass.answers[0], 'the sync state');
    sent += pass.sentOps;
    failure = pass.failure;
    job = pass.job;
    if (!pass.progressed) break;
  }
  return { sent, failure, queueMore, job };
}

/** The run's last round trip: the state, the next alarm and whatever still waits, in one batch. */
async function finish(run: Run, result: WorkResult): Promise<CourierOutcome> {
  const { ctx, state, outbox } = run;
  const { sent, failure, queueMore } = result;
  const patch: Record<string, unknown> = { running_since: null };
  if (run.quotaChanged) patch.quota = { $set: state.quota };
  // A catalog sync started or stopped during the run (connect, disconnect) wins over the run's job.
  const stored = run.latest === undefined ? state : run.latest;
  const ours = stored?.full_sync?.date_started === state.full_sync?.date_started;
  const job = ours ? result.job : stored?.full_sync;
  if (ours && result.job !== state.full_sync) patch.full_sync = { $set: result.job };
  const end = ctx.now();

  let at: number | null;
  let outcome: CourierOutcome;
  if (failure?.kind === 'auth') {
    Object.assign(patch, { not_before: null, last_error: failure.message });
    Object.assign(run.connectionPatch, brokenPatch(failure.message));
    at = null;
    outcome = { next: 'idle', sent };
  } else if (failure?.kind === 'daily_quota') {
    at = nextNoonUtc(end);
    Object.assign(patch, { not_before: iso(at), quota: { $set: { ...state.quota, exhausted_until: iso(at) } }, last_error: failure.message });
    outcome = { next: 'paused', sent };
  } else if (failure) {
    const backoff = (state.backoff ?? 0) + 1;
    at = end + Math.min(NEXT_RUN_MS * 2 ** backoff, MAX_BACKOFF_MS);
    Object.assign(patch, { backoff, not_before: iso(at), last_error: failure.message });
    outcome = { next: 'later', sent };
  } else if (queueMore || job?.status === 'running') {
    at = end + pacedDelay(sent, state.quota?.minute_limit);
    Object.assign(patch, { backoff: 0, not_before: iso(at), last_error: null });
    outcome = { next: 'soon', sent };
  } else {
    at = null;
    Object.assign(patch, { backoff: 0, not_before: null, last_error: null });
    outcome = { next: 'idle', sent };
  }

  if (Object.keys(run.connectionPatch).length) outbox.add(connectionWrite(run.connection.id, run.connectionPatch));
  const alarm = alarmWrite(run.alarm, at);
  if (alarm) outbox.add(alarm);
  // A refused state write fails the run; the dead-man alarm brings the next one.
  const [saved] = await outbox.send([stateWrite(state.id, patch)]);
  recordOf(saved, 'the run’s end');
  return outcome;
}

/**
 * One courier run: the queue, then the catalog sync, within a 7 s budget.
 * Reads everything in one round trip, marks the run in another, and ends by
 * setting the alarm for the next run, or clearing it when idle.
 */
export async function runCourier(ctx: AppContext): Promise<CourierOutcome> {
  const budget = new Budget(ctx.now, COURIER_BUDGET_MS);
  const start = await readStart(ctx);
  const outbox = new Outbox(ctx.swell);
  const { connection, state, alarm } = start;
  if (connection?.status !== 'connected' || !connection.merchant_id) {
    const clear = alarmWrite(alarm, null);
    if (clear) outbox.add(clear);
    await outbox.send();
    return { next: 'idle', sent: 0 };
  }

  const now = ctx.now();
  // Every wake_at ever written runs once (the platform cancels nothing), so runs
  // come early and in pairs. A run before the time the last run asked for, or
  // while another run works, leaves everything as it is: the run scheduled for
  // that time still comes, and the working run sets the next alarm.
  const notBefore = state?.not_before ? Date.parse(state.not_before) : 0;
  if (notBefore - now > EARLY_TOLERANCE_MS) return { next: 'early', sent: 0 };
  if (state?.running_since && now - Date.parse(state.running_since) < RUNNING_TTL_MS) return { next: 'busy', sent: 0 };

  if (!start.queue.length && state?.full_sync?.status !== 'running') {
    const reset = idleReset(state);
    if (reset) outbox.add(stateWrite(state!.id, reset));
    const clear = alarmWrite(alarm, null);
    if (clear) outbox.add(clear);
    await outbox.send();
    return { next: 'idle', sent: 0 };
  }

  // A run killed at 10 s leaves no future run; the dead-man alarm comes after
  // the mark expires and finds the next run already working (busy/early) or
  // picks the work up. The ending's alarm write supersedes it in wake_at.
  const deadManAt = now + RUNNING_TTL_MS + 5000;
  const deadMan = alarmWrite(alarm, deadManAt);
  const [marked, armed] = await swellBatch(ctx.swell, [stateWrite(state?.id, { running_since: iso(now) }), ...(deadMan ? [deadMan] : [])]);
  const current = recordOf<SyncState>(marked, 'the run mark');
  if (!current?.id) throw new Error('Swell did not keep the run mark');
  const run: Run = {
    ctx,
    budget,
    outbox,
    connection,
    connectionPatch: {},
    state: current,
    quotaChanged: false,
    alarm: deadMan && !entryError(armed) ? { id: (armed as Alarm | null)?.id ?? alarm!.id, wake_at: iso(deadManAt) } : alarm,
    markets: start.markets,
    queue: start.queue,
    waiting: start.waiting,
  };

  let result: WorkResult;
  try {
    result = await work(run);
  } catch (error) {
    if (!(error instanceof GoogleApiError)) {
      const retryAt = ctx.now() + NEXT_RUN_MS;
      outbox.add(stateWrite(current.id, { running_since: null, not_before: iso(retryAt) }));
      if (Object.keys(run.connectionPatch).length) outbox.add(connectionWrite(connection.id, run.connectionPatch));
      const rearm = alarmWrite(run.alarm, retryAt);
      if (rearm) outbox.add(rearm);
      await outbox.send().catch(() => undefined);
      throw error;
    }
    result = { sent: 0, failure: error, queueMore: true, job: current.full_sync };
  }
  return finish(run, result);
}
