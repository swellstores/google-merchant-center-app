import type { OrphanScanJob } from './orphans';
import type { StatusRefreshJob } from './refresh';

export const REFRESH_MIN_INTERVAL_MS = 3_600_000;
export const REFRESH_INTERVAL_FACTOR = 3;
export const ORPHAN_INTERVAL_MS = 86_400_000;

/** None yet, or the last one is done and `intervalMs` passed since it finished. */
function due(job: { status: 'running' | 'done'; date_finished?: string | null } | null | undefined, now: number, intervalMs: number): boolean {
  if (!job) return true;
  if (job.status !== 'done') return false;
  const finished = Date.parse(job.date_finished ?? '');
  return Number.isNaN(finished) || now >= finished + intervalMs;
}

/** A new refresh starts an hour after the last one finished, or three times its length when that is longer. */
export function refreshDue(job: StatusRefreshJob | null | undefined, now: number): boolean {
  return due(job, now, Math.max(REFRESH_MIN_INTERVAL_MS, REFRESH_INTERVAL_FACTOR * (job?.duration_ms ?? 0)));
}

export function orphanScanDue(job: OrphanScanJob | null | undefined, now: number): boolean {
  return due(job, now, ORPHAN_INTERVAL_MS);
}
