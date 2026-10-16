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

/** An alarm due this soon may bring a run that reads the queue before a change the caller is writing. */
export const ARM_MARGIN_MS = 2000;

/**
 * The write that makes sure the courier runs within `delayMs`, or null. An
 * alarm that rings sooner is kept; one in the past or about to ring is
 * replaced, because its run may be over or may miss the change. A new value
 * only adds a run: the platform cancels none.
 */
export function armWrite(alarm: Alarm | null, now: number, delayMs: number): BatchOp | null {
  const current = alarm?.wake_at ? Date.parse(alarm.wake_at) : null;
  if (current !== null && current > now + ARM_MARGIN_MS && current <= now + delayMs) return null;
  return alarmWrite(alarm, now + delayMs);
}
