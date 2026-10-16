import type { GoogleApiError } from '../google/http';
import type { SwellProduct } from '../mapping/types';
import { countOf, listOf, type BatchOp } from '../swell-batch';
import { iso } from '../time';
import { deliver, PASS_PRODUCTS, type DeliveryEnv } from './deliver';
import { enqueueWrite, productItemsRead, type QueueItem, type WorkUnit } from './queue';
import type { FullSyncJob } from './state';

export const JOB_PAGE = PASS_PRODUCTS;

/** The next page of the catalog, with the products' variants. */
export const pageRead = (job: FullSyncJob): BatchOp => ({
  method: 'get',
  url: '/products',
  data: { ...(job.cursor ? { where: { id: { $gt: job.cursor } } } : {}), sort: 'id asc', limit: JOB_PAGE, expand: ['variants:1000'] },
});

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
 * advances (`newFullSyncJob` starts one). The cursor moves past the whole page
 * and products that were kept or never reached go to the queue, which
 * continues them across runs, also when some products' parts failed: one
 * product Google keeps failing never stalls the sync. A whole batch that
 * failed, or a refused key or quota, moves it only over the leading done
 * products; a page none of which went out stays for the next run.
 *
 * `page` is the answer to `pageRead(job)` when the caller has it; otherwise
 * the page is read with the writes that wait. One round trip after Google's
 * answer sends the writes and reads what the hand-off needs along with the
 * caller's `reads`; the hand-off waits in `env.outbox`.
 */
export async function fullSyncPass(env: DeliveryEnv, job: FullSyncJob, reads: BatchOp[] = [], page?: unknown): Promise<PassResult> {
  const answer = page === undefined ? (await env.outbox.send([pageRead(job)]))[0] : page;
  const products = listOf<SwellProduct>(answer, 'the catalog page');
  const total = job.cursor === null && !job.total ? countOf(answer) : job.total;
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
  if (report.untouched.length === ids.length) return { job, sentOps: 0, progressed: false, answers: [] };
  const finished = new Set(report.done.map((unit) => unit.productId));
  let cursor = job.cursor;
  let done = job.done;
  let leftovers: WorkUnit[] = [];
  if (report.failure && !report.short) {
    for (const id of ids) {
      if (!finished.has(id)) break;
      cursor = id;
      done++;
    }
  } else {
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
