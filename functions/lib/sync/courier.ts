import { ensureDataSources, marketsRead, type Market } from '../connection/markets';
import { connectionRead, connectionWrite, type Connection } from '../connection/store';
import { accessTokenFor, brokenPatch, tokenFresh } from '../connection/token';
import { measured, type AppContext } from '../context';
import { googleCall, GoogleApiError } from '../google/http';
import { listAccountIssues, listPrograms } from '../google/merchant';
import type { OfferDefaults } from '../mapping/offers';
import type { SwellProduct } from '../mapping/types';
import { accountReasons } from '../status/account';
import { newOrphanScanJob, orphanScanPass } from '../status/orphans';
import { newStatusRefreshJob, statusPageRead, statusRefreshPass, summaryOf, type StatusRefreshJob } from '../status/refresh';
import { orphanScanDue, refreshDue } from '../status/schedule';
import { countOf, listOf, Outbox, recordOf, SWELL_WAVE, swellBatch, type BatchOp } from '../swell-batch';
import { Budget, iso, nextNoonUtc } from '../time';
import { alarmRead, alarmWrite, type Alarm } from './alarm';
import { deliver, PASS_PRODUCTS, productIdsOf, productsOf, productsRead, type DeliveryEnv } from './deliver';
import { fullSyncPass, pageRead, type PassResult } from './full-sync';
import { quotaDue, readQuota } from './quota';
import { itemsRead, settleWrites, takeRead, unitsFromQueue, type QueueItem, type WorkUnit } from './queue';
import { stateById, stateRead, stateWrite, type AccountCheck, type FullSyncJob, type SyncState } from './state';

export { PASS_PRODUCTS };

/** The whole run, its end included: the gates leave room for it. */
export const COURIER_BUDGET_MS = 8000;
/** A mark older than this belongs to a run the platform killed. */
export const RUNNING_TTL_MS = 30_000;
export const NEXT_RUN_MS = 15_000;
export const MAX_BACKOFF_MS = 15 * 60_000;
/** Clock skew allowed between a run and the time it was asked to come at. */
export const EARLY_TOLERANCE_MS = 2000;

// Phase 1 has no settings for defaults yet (plan 3 adds them).
const DEFAULTS: OfferDefaults = { condition: 'new' };

/** What started the run: the alarm, or the hourly cron, which also starts the status jobs that are due. */
export type CourierTrigger = 'alarm' | 'hourly';

export interface CourierOutcome {
  next: 'idle' | 'soon' | 'later' | 'paused' | 'early' | 'busy';
  sent: number;
}

/** Keeps sends under Google's per-minute limit. */
export function pacedDelay(sentOps: number, minuteLimit?: number | null): number {
  if (!minuteLimit) return NEXT_RUN_MS;
  return Math.max(NEXT_RUN_MS, Math.ceil((sentOps / minuteLimit) * 60_000));
}

type JobKey = 'full_sync' | 'status_refresh' | 'orphan_scan';
/** The cursor jobs, worked in this order once the queue is drained. */
type Jobs = Pick<SyncState, JobKey>;

const jobsOf = (state: SyncState | null): Jobs => ({
  full_sync: state?.full_sync,
  status_refresh: state?.status_refresh,
  orphan_scan: state?.orphan_scan,
});

const running = <J extends { status: 'running' | 'done' }>(job: J | null | undefined): job is J => job?.status === 'running';

/** The read the first pass needs, which rides with the run mark. */
interface FirstRead {
  kind: 'queue' | 'catalog' | 'refresh';
  op: BatchOp;
  /** The job whose page it reads */
  job?: FullSyncJob | StatusRefreshJob;
}

/** What a working run knows. */
interface Run {
  ctx: AppContext;
  budget: Budget;
  outbox: Outbox;
  connection: Connection;
  /** When the run started */
  now: number;
  /** The state the mark answered, with the jobs the run started */
  state: SyncState;
  /** The jobs as the mark found them */
  marked: Jobs;
  quotaChanged: boolean;
  alarm: Alarm | null;
  markets: Market[];
  /** The queue head the start read took */
  queue: QueueItem[];
  /** Items behind the head */
  waiting: number;
  /** The first pass's read and its answer */
  first?: FirstRead & { answer: unknown };
  /** The state as the last round trip of the run read it */
  latest?: SyncState | null;
}

type Ending = Pick<Run, 'ctx' | 'state' | 'marked' | 'outbox' | 'connection' | 'alarm' | 'quotaChanged' | 'latest'>;

interface WorkResult {
  sent: number;
  failure?: GoogleApiError;
  queueMore: boolean;
  jobs: Jobs;
  /** Read when the run finished the status refresh */
  account?: AccountCheck;
}

/** Everything a run decides on, in one round trip. */
async function readStart(ctx: AppContext) {
  const answers = await swellBatch(ctx.swell, [connectionRead, stateRead, alarmRead, marketsRead, takeRead(PASS_PRODUCTS)]);
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

/** The status jobs an hourly run starts: those that are due. */
function dueJobs(state: SyncState | null, now: number): Partial<Jobs> {
  return {
    ...(refreshDue(state, now) ? { status_refresh: newStatusRefreshJob(now) } : {}),
    ...(orphanScanDue(state?.orphan_scan, now) ? { orphan_scan: newOrphanScanJob(now) } : {}),
  };
}

/** The read the first pass needs: the queue head's products, or the next page of the catalog sync or of the status refresh. */
function firstRead(queue: QueueItem[], catalog: FullSyncJob | null | undefined, refresh: StatusRefreshJob | null | undefined): FirstRead | null {
  if (queue.length) {
    const ids = productIdsOf(unitsFromQueue(queue));
    return ids.length ? { kind: 'queue', op: productsRead(ids) } : null;
  }
  if (running(catalog)) return { kind: 'catalog', op: pageRead(catalog), job: catalog };
  if (running(refresh)) return { kind: 'refresh', op: statusPageRead(refresh), job: refresh };
  return null;
}

/**
 * The page the mark read for `job`, when the job still stands where it was
 * read and no pass came before. A page read for another job (a route
 * restarted it as the run marked itself) is read again; after another pass,
 * reading the page sends the writes that wait first, so no write to a product
 * waits beside another to the same product.
 */
function prefetched(run: Run, kind: 'catalog' | 'refresh', job: { date_started: string; cursor: string | null } | null | undefined, passes: number): unknown {
  const first = run.first;
  if (passes || first?.kind !== kind || !first.job || !job) return undefined;
  return first.job.date_started === job.date_started && first.job.cursor === job.cursor ? first.answer : undefined;
}

/** A store too slow for a pass is worth a line in the function log. */
const reportSlow = (budget: Budget) =>
  console.warn(`Courier: no time for a pass (Swell ${budget.swellMs} ms per round trip, Google ${budget.googleMs} ms per call)`);

/** The Google calls and Swell round trips the preamble still has to make, as the start read shows. */
function preambleCost(connection: Connection, state: SyncState | null, markets: Market[], now: number) {
  const missing = markets.filter((market) => !market.data_source).length;
  return {
    google: (tokenFresh(connection, now) ? 0 : 1) + (quotaDue(state?.quota, now) ? 1 : 0) + (missing ? 1 + missing : 0),
    // A created data source is read back and stored (Ruling 8).
    swell: 2 * missing,
  };
}

/** A token, the quota for pacing, and a data source for every market. `activate` normally leaves nothing to do. */
async function prepare(run: Run): Promise<{ token: string; markets: Market[] }> {
  const { ctx, connection, state, outbox } = run;
  const token = await accessTokenFor(ctx, connection, (patch) => outbox.add(connectionWrite(connection.id, patch)));
  if (quotaDue(state.quota, run.now)) {
    state.quota = await readQuota(ctx, token, connection.merchant_id!, state.quota);
    run.quotaChanged = true;
  }
  return { token, markets: await ensureDataSources(ctx, token, connection.merchant_id!, run.markets) };
}

/** The account's requirements and issues in the store's markets. Any failure, a refused key included, leaves the stored ones. */
async function readAccount(env: DeliveryEnv): Promise<AccountCheck | undefined> {
  // Both calls settle, and are timed, before the run goes on.
  const [programs, issues] = await Promise.allSettled([
    googleCall(env.ctx.fetch, env.token, listPrograms(env.accountId)),
    googleCall(env.ctx.fetch, env.token, listAccountIssues(env.accountId)),
  ]);
  if (programs.status === 'rejected' || issues.status === 'rejected') return undefined;
  return { reasons: accountReasons(programs.value, issues.value, env.markets.map((m) => m.country)), date_checked: iso(env.ctx.now()) };
}

async function work(run: Run): Promise<WorkResult> {
  const { ctx, connection, state, budget, outbox } = run;
  let sent = 0;
  let failure: GoogleApiError | undefined;
  let passes = 0;

  const { token, markets } = await prepare(run);
  const env: DeliveryEnv = { ctx, accountId: connection.merchant_id!, token, markets, defaults: DEFAULTS, budget, outbox };
  const reread = stateById(state.id);
  /** A pass needs its remaining Swell round trips, the run's end included, and a Google call. */
  const gate = (trips: number) => {
    if (budget.allows(trips)) return true;
    if (!passes) reportSlow(budget);
    return false;
  };

  // Fresh changes go first. A pass reads its products (with the writes that
  // wait), sends them, then writes the results with the reads that settle the
  // pass and, when they fit in the same server wave, the next items.
  let items = run.queue;
  let waiting = run.waiting;
  let products: Map<string, SwellProduct> | undefined;
  if (run.first?.kind === 'queue') products = productsOf(run.first.answer);
  // Deleted products need none.
  else if (items.length && !productIdsOf(unitsFromQueue(items)).length) products = new Map();
  let left = false;
  const taken: string[] = [];
  while (items.length && gate(products ? 2 : 3)) {
    const units: WorkUnit[] = unitsFromQueue(items);
    const ids = items.map((item) => item.id);
    if (!products) {
      const wanted = productIdsOf(units);
      products = wanted.length ? productsOf((await outbox.send([productsRead(wanted)]))[0]) : new Map();
    }
    taken.push(...ids);
    items = [];
    passes++;
    const report = await deliver(env, units, products);
    products = undefined;
    sent += report.sentOps;
    failure = report.failure;
    // Nothing went out: no round trip, and the items stay for the next run.
    if (report.untouched.length === units.length) {
      left = true;
      break;
    }
    const next = waiting > 0 && outbox.size + 3 <= SWELL_WAVE;
    const answers = await outbox.send([itemsRead(ids), reread, ...(next ? [takeRead(PASS_PRODUCTS, taken)] : [])]);
    run.latest = recordOf<SyncState>(answers[1], 'the sync state');
    const settled = settleWrites(ctx, report.done, report.kept, listOf<QueueItem>(answers[0], 'the taken queue items'));
    outbox.add(...settled.writes);
    left ||= settled.removed.length < ids.length;
    // Kept units wait for the next run: no retries in the same run.
    if (failure || report.kept.length || report.untouched.length || !waiting) break;
    // The next items did not fit in that wave: they come with the settling
    // writes, when a pass with its own product read still fits.
    if (!next && !gate(4)) break;
    const take = next ? answers[2] : (await outbox.send([takeRead(PASS_PRODUCTS, taken)]))[0];
    items = listOf<QueueItem>(take, 'the queue');
    waiting = countOf(take) - items.length;
  }
  const queueMore = left || items.length > 0 || waiting > 0;

  /** A job's passes while it runs and the gate allows; each reads the state back with its writes. */
  const passesOf = async <J extends { status: 'running' | 'done' }>(
    start: J | null | undefined,
    page: unknown,
    pass: (job: J, page: unknown) => Promise<PassResult<J>>,
  ) => {
    let job = start;
    while (!failure && running(job) && gate(page === undefined ? 3 : 2)) {
      passes++;
      const result = await pass(job, page);
      page = undefined;
      if (result.answers.length) run.latest = recordOf<SyncState>(result.answers[0], 'the sync state');
      failure = result.failure;
      job = result.job;
      if (!result.progressed) break;
    }
    return job;
  };

  let catalog = state.full_sync;
  if (!queueMore) {
    catalog = await passesOf(catalog, prefetched(run, 'catalog', catalog, passes), async (job, page) => {
      const pass = await fullSyncPass(env, job, [reread], page);
      sent += pass.sentOps;
      return pass;
    });
  }
  // The status jobs wait until the queue and the catalog sync are idle in this
  // run, the scan for the refresh. Their Google reads have their own quota and
  // do not pace the next run.
  const idle = !queueMore && !running(catalog);
  let refresh = state.status_refresh;
  if (idle) refresh = await passesOf(refresh, prefetched(run, 'refresh', refresh, passes), (job, page) => statusRefreshPass(env, job, [reread], page));
  // Once per refresh, by the run that finished it, with time for both calls at
  // once and the end, whose round trip writes it.
  const finished = running(state.status_refresh) && refresh?.status === 'done';
  const account = finished && budget.allows(1, 1) ? await readAccount(env) : undefined;
  let scan = state.orphan_scan;
  if (idle && !running(refresh)) scan = await passesOf(scan, undefined, (job) => orphanScanPass(env, job, [reread]));
  return { sent, failure, queueMore, jobs: { full_sync: catalog, status_refresh: refresh, orphan_scan: scan }, account };
}

/** The run's last round trip: the state, the next alarm and whatever still waits, in one batch. */
async function finish(run: Ending, result: WorkResult): Promise<CourierOutcome> {
  const { ctx, state, outbox } = run;
  const { sent, failure, queueMore } = result;
  const patch: Record<string, unknown> = { running_since: null };
  if (run.quotaChanged) patch.quota = { $set: state.quota };
  const stored = run.latest === undefined ? state : run.latest;
  // A job started or stopped during the run elsewhere (connect, disconnect,
  // the sync route) wins over the run's. A job the run started itself may
  // still read as the one it replaced: the read can run before the write that
  // shares its round trip.
  const settle = <K extends JobKey>(key: K): Jobs[K] => {
    const theirs = stored?.[key];
    const mine = state[key];
    const replaced = run.marked[key];
    const ours = theirs?.date_started === mine?.date_started || (mine !== replaced && theirs?.date_started === replaced?.date_started);
    if (!ours) return theirs;
    if (result.jobs[key] !== mine) patch[key] = { $set: result.jobs[key] };
    return result.jobs[key];
  };
  const catalog = settle('full_sync');
  const refresh = settle('status_refresh');
  const scan = settle('orphan_scan');
  if (patch.status_refresh && refresh?.status === 'done') {
    patch.summary = { $set: summaryOf(refresh) };
    if (result.account) patch.account_check = { $set: result.account };
  }
  const end = ctx.now();

  let at: number | null;
  let outcome: CourierOutcome;
  if (failure?.kind === 'auth') {
    Object.assign(patch, { not_before: null, last_error: failure.message });
    outbox.add(connectionWrite(run.connection.id, brokenPatch(failure.message)));
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
  } else if (queueMore || running(catalog) || running(refresh) || running(scan)) {
    at = end + pacedDelay(sent, state.quota?.minute_limit);
    Object.assign(patch, { backoff: 0, not_before: iso(at), last_error: null });
    outcome = { next: 'soon', sent };
  } else {
    at = null;
    Object.assign(patch, { backoff: 0, not_before: null, last_error: null });
    outcome = { next: 'idle', sent };
  }

  const alarm = alarmWrite(run.alarm, at);
  if (alarm) outbox.add(alarm);
  // A refused state write fails the run; the dead-man alarm brings the next
  // one, or for an hourly run, which sets none, the next hour. It takes in the
  // start of a job that no round trip has carried yet.
  const [saved] = await outbox.send([stateWrite(state.id, patch)]);
  recordOf(saved, 'the run’s end');
  return outcome;
}

/**
 * One courier run: the queue, then the catalog sync, the status refresh and
 * the orphan scan, within an 8 s budget. Reads everything in one round trip,
 * marks the run with the first pass's read in another, starts a pass only
 * with time for its round trips at the slowest measured, and ends by setting
 * the alarm for the next run, or clearing it when idle. An hourly run also
 * starts the status jobs that are due, and sets no dead-man alarm: the next
 * hour is its safety net.
 */
export async function runCourier(appCtx: AppContext, opts: { trigger?: CourierTrigger } = {}): Promise<CourierOutcome> {
  const hourly = opts.trigger === 'hourly';
  const budget = new Budget(appCtx.now, COURIER_BUDGET_MS);
  const ctx = measured(appCtx, budget);
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

  const jobs = jobsOf(state);
  const due = hourly ? dueJobs(state, now) : {};
  const starting = Object.keys(due).length > 0;
  const hasWork = start.queue.length > 0 || Object.values(jobs).some(running) || starting || (hourly && quotaDue(state?.quota, now));
  if (!hasWork) {
    const reset = idleReset(state);
    if (reset) outbox.add(stateWrite(state!.id, reset));
    const clear = alarmWrite(alarm, null);
    if (clear) outbox.add(clear);
    await outbox.send();
    return { next: 'idle', sent: 0 };
  }

  // The preamble, the mark with the first read, a Google batch, the pass's
  // writes and the end. A run without time for them only asks to come back,
  // after the preamble when that fits, so the next run has time to send. An
  // hourly run with jobs to start takes the lock for them all the same, when
  // the mark, the preamble and the end fit: the next run works them.
  const preamble = preambleCost(connection, state, start.markets, now);
  const passFits = budget.allows(3 + preamble.swell, 1 + preamble.google);
  if (!passFits && !(starting && budget.allows(2 + preamble.swell, preamble.google))) {
    const setUp = (preamble.google > 0 || preamble.swell > 0) && budget.allows(1 + preamble.swell, preamble.google);
    if (!setUp) reportSlow(budget);
    const run: Run = {
      ctx,
      budget,
      outbox,
      connection,
      now,
      state: state ?? ({} as SyncState),
      marked: jobs,
      quotaChanged: false,
      alarm,
      markets: start.markets,
      queue: [],
      waiting: 0,
    };
    let result: WorkResult = { sent: 0, queueMore: start.queue.length > 0, jobs };
    if (setUp) {
      try {
        await prepare(run);
      } catch (error) {
        if (!(error instanceof GoogleApiError)) return rearmAndThrow(run, error);
        result = { ...result, failure: error };
      }
    }
    return finish(run, result);
  }

  // Runs that start together all pass the busy check: the mark bumps a
  // counter atomically, and only the run that gets the next number works.
  // The mark's running_since keeps later runs busy; a loser's lands in the
  // same moment as the winner's, which the winner's end clears. A refresh an
  // hourly run is about to start reads its first page with the mark too.
  const read = firstRead(start.queue, state?.full_sync, running(state?.status_refresh) ? state.status_refresh : due.status_refresh);
  const marking: BatchOp[] = [stateWrite(state?.id, { running_since: iso(now), $inc: { run_seq: 1 } }), ...(read ? [read.op] : [])];
  const answers = await swellBatch(ctx.swell, marking);
  const current = recordOf<SyncState>(answers[0], 'the run mark');
  if (!current?.id) throw new Error('Swell did not keep the run mark');
  if ((current.run_seq ?? 0) !== (state?.run_seq ?? 0) + 1) {
    console.warn(`Courier: another run started at the same time and works (run ${current.run_seq})`);
    return { next: 'busy', sent: 0 };
  }

  // A run killed at 10 s leaves no future run; the dead-man alarm comes after
  // the mark expires and finds the next run already working (busy/early) or
  // picks the work up. Only the winner of an alarm run sets it, with its next
  // round trip; the ending's alarm write supersedes it. A store without an
  // alarm record (none ever armed) gets none.
  const deadManAt = now + RUNNING_TTL_MS + 5000;
  const deadMan = alarm && !hourly ? alarmWrite(alarm, deadManAt) : null;
  if (deadMan) outbox.add(deadMan);
  // The jobs due by the state the mark answered start in this run's memory and
  // are written with its next round trip.
  const started = hourly ? dueJobs(current, now) : {};
  if (Object.keys(started).length) {
    outbox.add(stateWrite(current.id, Object.fromEntries(Object.entries(started).map(([key, job]) => [key, { $set: job }]))));
  }
  const run: Run = {
    ctx,
    budget,
    outbox,
    connection,
    now,
    state: { ...current, ...started },
    marked: jobsOf(current),
    quotaChanged: false,
    alarm: deadMan ? { id: alarm!.id, wake_at: iso(deadManAt) } : alarm,
    markets: start.markets,
    queue: start.queue,
    waiting: start.waiting,
    first: read ? { ...read, answer: answers[1] } : undefined,
  };

  let result: WorkResult;
  try {
    result = await work(run);
  } catch (error) {
    if (!(error instanceof GoogleApiError)) return rearmAndThrow(run, error);
    result = { sent: 0, failure: error, queueMore: true, jobs: jobsOf(run.state) };
  }
  return finish(run, result);
}

/** An unexpected error: the mark goes and the courier comes back soon, then the error goes on to the log. */
async function rearmAndThrow(run: Run, error: unknown): Promise<never> {
  const retryAt = run.ctx.now() + NEXT_RUN_MS;
  const rearm = alarmWrite(run.alarm, retryAt);
  if (rearm) run.outbox.add(rearm);
  await run.outbox.send([stateWrite(run.state.id, { running_since: null, not_before: iso(retryAt) })]).catch(() => undefined);
  throw error;
}
