import { connectionRead, type Connection } from '../connection/store';
import type { AppContext, SwellClient } from '../context';
import { listOf, recordOf, swellBatch, type BatchOp } from '../swell-batch';
import { iso } from '../time';
import { alarmRead, armWrite, ENQUEUE_DELAY_MS, type Alarm } from './alarm';

export type QueueKind = 'full' | 'light' | 'delete';

export interface QueueItem {
  id: string;
  product_id: string;
  kind: QueueKind;
  input_ids?: string[];
  done_input_ids?: string[];
  attempts?: number;
  last_error?: string | null;
  revision?: number;
  date_created?: string;
}

/** One product's pending work, from queue items or from the catalog sync. */
export interface WorkUnit {
  productId: string;
  kind: QueueKind;
  inputIds: string[];
  queueItemIds: string[];
  attempts: number;
  error?: string | null;
  /** Queue item id → the revision taken, to tell later edits apart. */
  revisions?: Record<string, number>;
  /** Inputs sent in earlier runs of this revision. */
  doneInputIds?: string[];
  /** Inputs sent OK in this run, on kept units. */
  progress?: string[];
  /** A part got a server error: the run counts as an attempt. Rate limits never do. */
  charge?: boolean;
}

export const MAX_ATTEMPTS = 8;

const COLLECTION = '/queue-items';

/** A deleted product stays deleted; a full update covers a light one. */
export function mergeKind(a: QueueKind, b: QueueKind): QueueKind {
  if (a === 'delete' || b === 'delete') return 'delete';
  if (a === 'full' || b === 'full') return 'full';
  return 'light';
}

export interface QueuePlan {
  productId: string;
  kind: QueueKind;
  inputIds?: string[];
}

/** The write that queues a change, merged into the product's item when it has one. */
export function enqueueWrite(current: QueueItem | undefined, plan: QueuePlan): BatchOp {
  if (!current) {
    return { method: 'post', url: COLLECTION, data: { product_id: plan.productId, kind: plan.kind, input_ids: plan.inputIds ?? [], attempts: 0, revision: 0 } };
  }
  return {
    method: 'put',
    url: `${COLLECTION}/${current.id}`,
    data: {
      kind: mergeKind(current.kind, plan.kind),
      revision: (current.revision ?? 0) + 1,
      // The product changed: every offer is sent again. Offers sent for the old
      // revision stay known, so the courier deletes them if they vanished.
      input_ids: [...new Set([...(current.input_ids ?? []), ...(current.done_input_ids ?? []), ...(plan.inputIds ?? [])])],
      done_input_ids: [],
    },
  };
}

export async function enqueue(swell: SwellClient, plan: QueuePlan): Promise<void> {
  const existing = await swell.get(COLLECTION, { where: { product_id: plan.productId }, limit: 1 });
  const op = enqueueWrite(existing?.results?.[0], plan);
  if (op.method === 'post') await swell.post(op.url, op.data!);
  else await swell.put(op.url, op.data!);
}

/**
 * Queues a product's change and makes sure the courier comes within
 * ENQUEUE_DELAY_MS: one read, one write. While the store is not connected
 * nothing is queued; the catalog sync after connecting again covers it.
 */
export async function queueChange(ctx: AppContext, plan: QueuePlan): Promise<void> {
  const answers = await swellBatch(ctx.swell, [connectionRead, productItemsRead([plan.productId]), alarmRead]);
  const connection = listOf<Connection>(answers[0], 'the connection')[0];
  if (connection?.status !== 'connected') return;
  const current = listOf<QueueItem>(answers[1], 'the queue')[0];
  const wake = armWrite(listOf<Alarm>(answers[2], 'the alarm')[0] ?? null, ctx.now(), ENQUEUE_DELAY_MS);
  const writes = [enqueueWrite(current, plan), ...(wake ? [wake] : [])];
  const results = await swellBatch(ctx.swell, writes);
  results.forEach((result, i) => recordOf(result, `the write to ${writes[i].url}`));
}

/** The oldest items, leaving out `exclude` (items this run took already). */
export function takeRead(limit: number, exclude: string[] = []): BatchOp {
  return { method: 'get', url: COLLECTION, data: { ...(exclude.length ? { where: { id: { $nin: exclude } } } : {}), sort: 'date_created asc', limit } };
}

/** The items again, to see which changed while the courier sent them. */
export const itemsRead = (ids: string[]): BatchOp => ({ method: 'get', url: COLLECTION, data: { where: { id: { $in: ids } }, limit: ids.length } });

/** The items of these products, oldest first. */
export const productItemsRead = (productIds: string[]): BatchOp => ({
  method: 'get',
  url: COLLECTION,
  data: { where: { product_id: { $in: productIds } }, sort: 'date_created asc', limit: 1000 },
});

export const itemRemoval = (id: string): BatchOp => ({ method: 'delete', url: `${COLLECTION}/${id}` });

export async function takeQueue(swell: SwellClient, limit: number): Promise<QueueItem[]> {
  const list = await swell.get(COLLECTION, takeRead(limit).data);
  return list?.results ?? [];
}

export async function queueCount(swell: SwellClient): Promise<number> {
  const list = await swell.get(COLLECTION, { limit: 1 });
  return list?.count ?? 0;
}

export function unitsFromQueue(items: QueueItem[]): WorkUnit[] {
  const byProduct = new Map<string, WorkUnit>();
  for (const item of items) {
    const unit = byProduct.get(item.product_id);
    if (!unit) {
      byProduct.set(item.product_id, {
        productId: item.product_id,
        kind: item.kind,
        inputIds: [...(item.input_ids ?? [])],
        queueItemIds: [item.id],
        attempts: item.attempts ?? 0,
        revisions: { [item.id]: item.revision ?? 0 },
        doneInputIds: [...(item.done_input_ids ?? [])],
      });
      continue;
    }
    unit.kind = mergeKind(unit.kind, item.kind);
    unit.inputIds = [...new Set([...unit.inputIds, ...(item.input_ids ?? [])])];
    unit.queueItemIds.push(item.id);
    unit.attempts = Math.max(unit.attempts, item.attempts ?? 0);
    unit.revisions![item.id] = item.revision ?? 0;
    // Only progress every item agrees on: an item edited meanwhile has none.
    unit.doneInputIds = (unit.doneInputIds ?? []).filter((id) => (item.done_input_ids ?? []).includes(id));
  }
  return [...byProduct.values()];
}

/**
 * The writes that settle a delivery, given the taken items as they are now:
 * finished units' items go, except items edited since they were taken (those
 * carry a newer change and stay for the next run). A kept unit stays as one
 * item, merged with any edit made meanwhile; a charged one counts an attempt,
 * and after the last attempt it is dropped and the product says why.
 */
export function settleWrites(ctx: AppContext, done: WorkUnit[], kept: WorkUnit[], items: QueueItem[]): { writes: BatchOp[]; removed: string[] } {
  const current = new Map(items.map((item): [string, QueueItem] => [item.id, item]));
  const unchanged = (unit: WorkUnit, id: string) => {
    const item = current.get(id);
    return Boolean(item) && (item!.revision ?? 0) === (unit.revisions?.[id] ?? 0);
  };
  const removed: string[] = done.flatMap((unit) => unit.queueItemIds.filter((id) => unchanged(unit, id)));
  const writes: BatchOp[] = [];
  for (const unit of kept) {
    const ids = unit.queueItemIds.filter((id) => current.has(id));
    if (!ids.length) continue;
    const progressed = Boolean(unit.progress?.length);
    const attempts = progressed ? 0 : unit.charge ? unit.attempts + 1 : unit.attempts;
    if (attempts >= MAX_ATTEMPTS) {
      removed.push(...ids.filter((id) => unchanged(unit, id)));
      writes.push({
        method: 'put',
        url: `/products/${unit.productId}`,
        data: { $app: { [ctx.appId]: { sync_state: 'error', sync_error: unit.error ?? 'Google did not accept the product', date_synced: iso(ctx.now()) } } },
      });
      continue;
    }
    const [keep, ...duplicates] = ids;
    removed.push(...duplicates.filter((id) => unchanged(unit, id)));
    const item = current.get(keep)!;
    writes.push({
      method: 'put',
      url: `${COLLECTION}/${keep}`,
      data: {
        kind: mergeKind(item.kind, unit.kind),
        input_ids: [...new Set([...(item.input_ids ?? []), ...unit.inputIds])],
        done_input_ids: unchanged(unit, keep)
          ? [...new Set([...(item.done_input_ids ?? []), ...(unit.doneInputIds ?? []), ...(unit.progress ?? [])])]
          : (item.done_input_ids ?? []),
        attempts,
        last_error: unit.error ?? item.last_error ?? null,
      },
    });
  }
  writes.push(...removed.map(itemRemoval));
  return { writes, removed };
}
