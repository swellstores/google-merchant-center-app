import type { AppContext, SwellClient } from '../context';
import type { BatchOp } from '../swell-batch';
import { iso } from '../time';

export interface Alarm {
  id: string;
  wake_at?: string | null;
}

/** A change waits this long, so a burst of edits goes out in one run. */
export const ENQUEUE_DELAY_MS = 15_000;

const COLLECTION = '/alarms';
const FIRST = { limit: 1, sort: 'date_created asc' };

export const alarmRead: BatchOp = { method: 'get', url: COLLECTION, data: FIRST };

export async function loadAlarm(swell: SwellClient): Promise<Alarm> {
  const list = await swell.get(COLLECTION, FIRST);
  return list?.results?.[0] ?? (await swell.post(COLLECTION, { wake_at: null }));
}

/**
 * The write that moves the alarm to `at` (`null`: nothing to do), creating the
 * record when there is none. Writing `wake_at` re-schedules the courier, and a
 * write that leaves it unchanged runs the courier at once, so none is made.
 */
export function alarmWrite(alarm: Alarm | null, at: number | null): BatchOp | null {
  const wakeAt = at === null ? null : iso(at);
  if ((alarm?.wake_at ?? null) === wakeAt) return null;
  return alarm ? { method: 'put', url: `${COLLECTION}/${alarm.id}`, data: { wake_at: wakeAt } } : { method: 'post', url: COLLECTION, data: { wake_at: wakeAt } };
}

/** Sets the courier's next run; `null` means nothing to do. */
export async function setAlarm(ctx: AppContext, at: number | null): Promise<void> {
  const list = await ctx.swell.get(COLLECTION, FIRST);
  const op = alarmWrite(list?.results?.[0] ?? null, at);
  if (op?.method === 'post') await ctx.swell.post(op.url, op.data!);
  else if (op) await ctx.swell.put(op.url, op.data!);
}

/**
 * Makes sure the courier runs within `delayMs`. An alarm that rings sooner is
 * kept; one in the past is replaced, because its run may already be over.
 */
export async function armAlarm(ctx: AppContext, delayMs: number): Promise<void> {
  const alarm = await loadAlarm(ctx.swell);
  const now = ctx.now();
  const current = alarm.wake_at ? Date.parse(alarm.wake_at) : null;
  if (current !== null && current > now && current <= now + delayMs) return;
  await ctx.swell.put(`${COLLECTION}/${alarm.id}`, { wake_at: iso(now + delayMs) });
}
