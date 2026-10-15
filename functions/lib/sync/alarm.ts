import type { AppContext, SwellClient } from '../context';
import { iso } from '../time';

export interface Alarm {
  id: string;
  wake_at?: string | null;
}

/** A change waits this long, so a burst of edits goes out in one run. */
export const ENQUEUE_DELAY_MS = 15_000;

const COLLECTION = '/alarms';

export async function loadAlarm(swell: SwellClient): Promise<Alarm> {
  const list = await swell.get(COLLECTION, { limit: 1, sort: 'date_created asc' });
  return list?.results?.[0] ?? (await swell.post(COLLECTION, { wake_at: null }));
}

/** Sets the courier's next run; `null` means nothing to do. Writing `wake_at` re-schedules the courier. */
export async function setAlarm(ctx: AppContext, at: number | null): Promise<void> {
  const alarm = await loadAlarm(ctx.swell);
  const wakeAt = at === null ? null : iso(at);
  if ((alarm.wake_at ?? null) === wakeAt) return;
  await ctx.swell.put(`${COLLECTION}/${alarm.id}`, { wake_at: wakeAt });
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
