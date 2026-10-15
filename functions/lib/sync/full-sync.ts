import type { AppContext } from '../context';
import type { GoogleApiError } from '../google/http';
import { iso } from '../time';
import { setAlarm } from './alarm';
import { deliver, type DeliveryEnv } from './deliver';
import { enqueue } from './queue';
import { loadState, saveState, type FullSyncJob } from './state';

export const JOB_PAGE = 25;
const HANDOFF_CONCURRENCY = 10;

/** Sends the whole catalog: a cursor over product ids that the courier advances. */
export async function startFullSync(ctx: AppContext): Promise<FullSyncJob> {
  const state = await loadState(ctx.swell);
  const count = await ctx.swell.get('/products', { limit: 1, fields: 'id' });
  const job: FullSyncJob = { status: 'running', cursor: null, total: count?.count ?? 0, done: 0, date_started: iso(ctx.now()), date_finished: null };
  await saveState(ctx.swell, state.id, { full_sync: { $set: job } });
  await setAlarm(ctx, ctx.now());
  return job;
}

/**
 * One page of the catalog. The cursor moves past the whole page unless the run
 * failed (then only over the leading done products); products that were kept
 * or never reached go to the queue, which continues them across runs.
 */
export async function fullSyncPass(
  env: DeliveryEnv,
  job: FullSyncJob,
): Promise<{ job: FullSyncJob; sentOps: number; failure?: GoogleApiError; progressed: boolean }> {
  const page = await env.ctx.swell.get('/products', {
    ...(job.cursor ? { where: { id: { $gt: job.cursor } } } : {}),
    sort: 'id asc',
    limit: JOB_PAGE,
    fields: 'id',
  });
  const ids: string[] = (page?.results ?? []).map((p: { id: string }) => p.id);
  if (!ids.length) {
    return { job: { ...job, status: 'done', date_finished: iso(env.ctx.now()) }, sentOps: 0, progressed: true };
  }

  const report = await deliver(
    env,
    ids.map((productId) => ({ productId, kind: 'full' as const, inputIds: [], queueItemIds: [], attempts: 0 })),
  );
  const finished = new Set(report.done.map((unit) => unit.productId));
  let cursor = job.cursor;
  let done = job.done;
  if (report.failure) {
    // The cursor moves only over the leading products that are done.
    for (const id of ids) {
      if (!finished.has(id)) break;
      cursor = id;
      done++;
    }
  } else {
    // Products too big for this run go to the queue, which continues them
    // across runs; the catalog sync never stalls on one.
    const leftovers = [...report.kept, ...report.untouched];
    for (let i = 0; i < leftovers.length; i += HANDOFF_CONCURRENCY) {
      await Promise.all(
        leftovers
          .slice(i, i + HANDOFF_CONCURRENCY)
          .map((unit) => enqueue(env.ctx.swell, { productId: unit.productId, kind: 'full', inputIds: unit.progress ?? [] })),
      );
    }
    cursor = ids[ids.length - 1];
    done += ids.length;
  }
  const next: FullSyncJob = { ...job, cursor, done };
  if (ids.length < JOB_PAGE && cursor === ids[ids.length - 1]) {
    next.status = 'done';
    next.date_finished = iso(env.ctx.now());
  }
  return { job: next, sentOps: report.sentOps, failure: report.failure, progressed: cursor !== job.cursor };
}
