import type { AppContext, SwellClient } from '../context';
import { iso } from '../time';

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
    await swell.post(COLLECTION, { product_id: plan.productId, kind: plan.kind, input_ids: plan.inputIds ?? [], attempts: 0, revision: 0 });
    return;
  }
  await swell.put(`${COLLECTION}/${current.id}`, {
    kind: mergeKind(current.kind, plan.kind),
    revision: (current.revision ?? 0) + 1,
    done_input_ids: [],
    ...(plan.inputIds?.length ? { input_ids: [...new Set([...(current.input_ids ?? []), ...plan.inputIds])] } : {}),
  });
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
    unit.doneInputIds = [...new Set([...(unit.doneInputIds ?? []), ...(item.done_input_ids ?? [])])];
  }
  return [...byProduct.values()];
}

async function inChunks<T>(values: T[], run: (value: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < values.length; i += DELETE_CONCURRENCY) {
    await Promise.all(values.slice(i, i + DELETE_CONCURRENCY).map(run));
  }
}

async function currentItems(swell: SwellClient, ids: string[]): Promise<Map<string, QueueItem>> {
  if (!ids.length) return new Map();
  const list = await swell.get(COLLECTION, { where: { id: { $in: ids } }, limit: ids.length });
  return new Map((list?.results ?? []).map((item: QueueItem): [string, QueueItem] => [item.id, item]));
}

/**
 * Removes the items of finished units, except items edited since they were
 * taken: those carry a newer change and stay for the next run. A kept unit
 * stays as one item with one more attempt, merged with any edit made
 * meanwhile; after the last attempt it is dropped and the product says why.
 */
export async function settleQueue(ctx: AppContext, done: WorkUnit[], kept: WorkUnit[]): Promise<void> {
  const current = await currentItems(ctx.swell, [...done, ...kept].flatMap((unit) => unit.queueItemIds));
  const unchanged = (unit: WorkUnit, id: string) => {
    const item = current.get(id);
    return Boolean(item) && (item!.revision ?? 0) === (unit.revisions?.[id] ?? 0);
  };
  const remove: string[] = done.flatMap((unit) => unit.queueItemIds.filter((id) => unchanged(unit, id)));
  for (const unit of kept) {
    const ids = unit.queueItemIds.filter((id) => current.has(id));
    if (!ids.length) continue;
    const progressed = Boolean(unit.progress?.length);
    const attempts = progressed ? 0 : unit.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      remove.push(...ids.filter((id) => unchanged(unit, id)));
      await ctx.swell
        .put(`/products/${unit.productId}`, {
          $app: { [ctx.appId]: { sync_state: 'error', sync_error: unit.error ?? 'Google did not accept the product', date_synced: iso(ctx.now()) } },
        })
        .catch(() => undefined);
      continue;
    }
    const [keep, ...duplicates] = ids;
    remove.push(...duplicates.filter((id) => unchanged(unit, id)));
    const item = current.get(keep)!;
    await ctx.swell
      .put(`${COLLECTION}/${keep}`, {
        kind: mergeKind(item.kind, unit.kind),
        input_ids: [...new Set([...(item.input_ids ?? []), ...unit.inputIds])],
        done_input_ids: unchanged(unit, keep)
          ? [...new Set([...(item.done_input_ids ?? []), ...(unit.doneInputIds ?? []), ...(unit.progress ?? [])])]
          : (item.done_input_ids ?? []),
        attempts,
        last_error: unit.error ?? item.last_error ?? null,
      })
      .catch(() => undefined);
  }
  await inChunks(remove, (id) => ctx.swell.delete(`${COLLECTION}/${id}`).catch(() => undefined));
}

export async function clearQueue(swell: SwellClient): Promise<void> {
  let previous = '';
  for (;;) {
    const items = await takeQueue(swell, 100);
    const ids = items.map((item) => item.id).join(',');
    // Deletes that keep failing would otherwise loop forever.
    if (!items.length || ids === previous) return;
    previous = ids;
    await inChunks(items, (item) => swell.delete(`${COLLECTION}/${item.id}`).catch(() => undefined));
  }
}
