import type { GoogleApiError } from '../google/http';
import type { SwellProduct } from '../mapping/types';
import { listOf, type BatchOp } from '../swell-batch';
import { iso } from '../time';
import { deliver, type DeliveryEnv } from './deliver';
import { enqueueWrite, productItemsRead, type QueueItem, type WorkUnit } from './queue';
import type { FullSyncJob } from './state';

export const JOB_PAGE = 25;

export interface PassResult {
  job: FullSyncJob;
  sentOps: number;
  failure?: GoogleApiError;
  progressed: boolean;
  /** The answers to the caller's `reads` */
  answers: unknown[];
}

/**
 * One page of the catalog sync, a cursor over product ids that the courier
 * advances (`newFullSyncJob` starts one). The cursor moves past the whole page unless the run
 * failed (then only over the leading done products); products that were kept
 * or never reached go to the queue, which continues them across runs. One
 * round trip after Google's answer sends the waiting writes and reads what the
 * hand-off needs along with the caller's `reads`; the hand-off waits in
 * `env.outbox`.
 */
export async function fullSyncPass(env: DeliveryEnv, job: FullSyncJob, reads: BatchOp[] = []): Promise<PassResult> {
  const page = await env.ctx.swell.get('/products', {
    ...(job.cursor ? { where: { id: { $gt: job.cursor } } } : {}),
    sort: 'id asc',
    limit: JOB_PAGE,
    expand: ['variants:1000'],
  });
  const products: SwellProduct[] = page?.results ?? [];
  const total = job.cursor === null && !job.total ? (page?.count ?? 0) : job.total;
  if (!products.length) {
    const answers = await env.outbox.send(reads);
    return { job: { ...job, total, status: 'done', date_finished: iso(env.ctx.now()) }, sentOps: 0, progressed: true, answers };
  }

  const ids = products.map((product) => product.id);
  const report = await deliver(
    env,
    ids.map((productId) => ({ productId, kind: 'full' as const, inputIds: [], queueItemIds: [], attempts: 0 })),
    new Map(products.map((product): [string, SwellProduct] => [product.id, product])),
  );
  const finished = new Set(report.done.map((unit) => unit.productId));
  let cursor = job.cursor;
  let done = job.done;
  let leftovers: WorkUnit[] = [];
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
    leftovers = [...report.kept, ...report.untouched];
    cursor = ids[ids.length - 1];
    done += ids.length;
  }

  const lookup = leftovers.length ? [productItemsRead(leftovers.map((unit) => unit.productId))] : [];
  const answers = await env.outbox.send([...lookup, ...reads]);
  if (leftovers.length) {
    const items = listOf<QueueItem>(answers[0], 'the queue');
    env.outbox.add(
      ...leftovers.map((unit) =>
        enqueueWrite(
          items.find((item) => item.product_id === unit.productId),
          { productId: unit.productId, kind: 'full', inputIds: unit.progress ?? [] },
        ),
      ),
    );
  }

  const next: FullSyncJob = { ...job, total, cursor, done };
  if (ids.length < JOB_PAGE && cursor === ids[ids.length - 1]) {
    next.status = 'done';
    next.date_finished = iso(env.ctx.now());
  }
  return { job: next, sentOps: report.sentOps, failure: report.failure, progressed: cursor !== job.cursor, answers: answers.slice(lookup.length) };
}
