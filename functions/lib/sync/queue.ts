import type { AppContext, SwellClient } from '../context';
import { iso } from '../time';

export type QueueKind = 'full' | 'light' | 'delete';

export interface QueueItem {
  id: string;
  product_id: string;
  kind: QueueKind;
  input_ids?: string[];
  attempts?: number;
  last_error?: string | null;
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
}

export const MAX_ATTEMPTS = 8;

const COLLECTION = '/queue-items';
const DELETE_CONCURRENCY = 10;

/** A deleted product stays deleted; a full update covers a light one. */
export function mergeKind(a: QueueKind, b: QueueKind): QueueKind {
  if (a === 'delete' || b === 'delete') return 'delete';
  if (a === 'full' || b === 'full') return 'full';
  return 'light';
}

export async function enqueue(swell: SwellClient, plan: { productId: string; kind: QueueKind; inputIds?: string[] }): Promise<void> {
  const existing = await swell.get(COLLECTION, { where: { product_id: plan.productId }, limit: 1 });
  const current: QueueItem | undefined = existing?.results?.[0];
  if (!current) {
    await swell.post(COLLECTION, { product_id: plan.productId, kind: plan.kind, input_ids: plan.inputIds ?? [], attempts: 0 });
    return;
  }
  const kind = mergeKind(current.kind, plan.kind);
  if (kind !== current.kind || plan.inputIds?.length) {
    await swell.put(`${COLLECTION}/${current.id}`, { kind, ...(plan.inputIds?.length ? { input_ids: plan.inputIds } : {}) });
  }
}

export async function takeQueue(swell: SwellClient, limit: number): Promise<QueueItem[]> {
  const list = await swell.get(COLLECTION, { sort: 'date_created asc', limit });
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
      });
      continue;
    }
    unit.kind = mergeKind(unit.kind, item.kind);
    unit.inputIds = [...new Set([...unit.inputIds, ...(item.input_ids ?? [])])];
    unit.queueItemIds.push(item.id);
    unit.attempts = Math.max(unit.attempts, item.attempts ?? 0);
  }
  return [...byProduct.values()];
}

async function inChunks<T>(values: T[], run: (value: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < values.length; i += DELETE_CONCURRENCY) {
    await Promise.all(values.slice(i, i + DELETE_CONCURRENCY).map(run));
  }
}

/**
 * Removes the items of finished units. A kept unit stays as one item with one
 * more attempt; after the last attempt it is dropped and the product says why.
 */
export async function settleQueue(ctx: AppContext, done: WorkUnit[], kept: WorkUnit[]): Promise<void> {
  const remove: string[] = done.flatMap((unit) => unit.queueItemIds);
  for (const unit of kept) {
    if (!unit.queueItemIds.length) continue;
    const attempts = unit.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      remove.push(...unit.queueItemIds);
      await ctx.swell
        .put(`/products/${unit.productId}`, {
          $app: { [ctx.appId]: { sync_state: 'error', sync_error: unit.error ?? 'Google did not accept the product', date_synced: iso(ctx.now()) } },
        })
        .catch(() => undefined);
      continue;
    }
    const [keep, ...duplicates] = unit.queueItemIds;
    remove.push(...duplicates);
    await ctx.swell.put(`${COLLECTION}/${keep}`, { kind: unit.kind, attempts, last_error: unit.error ?? null });
  }
  await inChunks(remove, (id) => ctx.swell.delete(`${COLLECTION}/${id}`).catch(() => undefined));
}

export async function clearQueue(swell: SwellClient): Promise<void> {
  for (;;) {
    const items = await takeQueue(swell, 100);
    if (!items.length) return;
    await inChunks(items, (item) => swell.delete(`${COLLECTION}/${item.id}`).catch(() => undefined));
  }
}
