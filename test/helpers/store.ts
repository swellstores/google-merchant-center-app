import type { AppContext, SwellClient } from '../../functions/lib/context';
import { alarmRead, alarmWrite, type Alarm } from '../../functions/lib/sync/alarm';
import { enqueueWrite, productItemsRead, takeRead, type QueueItem, type QueuePlan } from '../../functions/lib/sync/queue';
import { stateRead, type SyncState } from '../../functions/lib/sync/state';

/** The store's records the way tests set them up and look at them, outside any batch. */

export async function loadAlarm(swell: SwellClient): Promise<Alarm> {
  const list = await swell.get(alarmRead.url, alarmRead.data);
  return list?.results?.[0] ?? (await swell.post(alarmRead.url, { wake_at: null }));
}

export async function setAlarm(ctx: AppContext, at: number | null): Promise<void> {
  const list = await ctx.swell.get(alarmRead.url, alarmRead.data);
  const op = alarmWrite(list?.results?.[0] ?? null, at);
  if (op?.method === 'post') await ctx.swell.post(op.url, op.data!);
  else if (op) await ctx.swell.put(op.url, op.data!);
}

export async function loadState(swell: SwellClient): Promise<SyncState> {
  const list = await swell.get(stateRead.url, stateRead.data);
  return list?.results?.[0] ?? (await swell.post(stateRead.url, { backoff: 0 }));
}

export async function saveState(swell: SwellClient, id: string, patch: Record<string, unknown>): Promise<SyncState> {
  return swell.put(`${stateRead.url}/${id}`, patch);
}

export async function takeQueue(swell: SwellClient, limit: number): Promise<QueueItem[]> {
  const list = await swell.get('/queue-items', takeRead(limit).data);
  return list?.results ?? [];
}

export async function queueCount(swell: SwellClient): Promise<number> {
  const list = await swell.get('/queue-items', { limit: 1 });
  return list?.count ?? 0;
}

/** Queues a change the way the enqueue function does, without the connection check and the alarm. */
export async function enqueue(swell: SwellClient, plan: QueuePlan): Promise<void> {
  const read = productItemsRead([plan.productId]);
  const existing = await swell.get(read.url, read.data);
  const op = enqueueWrite(existing?.results?.[0], plan);
  if (op.method === 'post') await swell.post(op.url, op.data!);
  else await swell.put(op.url, op.data!);
}
