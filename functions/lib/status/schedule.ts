import type { SyncState } from '../sync/state';
import type { OrphanScanJob } from './orphans';

export const REFRESH_MIN_INTERVAL_MS = 3_600_000;
export const REFRESH_INTERVAL_FACTOR = 3;
export const ORPHAN_INTERVAL_MS = 86_400_000;
/** The hourly cron comes at :00 and the jobs it starts finish a little later: without this, each interval would slip by an hour. */
export const SCHEDULE_SLACK_MS = 10 * 60_000;

/** None yet, or the last one is done and `intervalMs`, less the slack, passed since it finished. */
function due(job: { status: 'running' | 'done'; date_finished?: string | null } | null | undefined, now: number, intervalMs: number): boolean {
  if (!job) return true;
  if (job.status !== 'done') return false;
  const finished = Date.parse(job.date_finished ?? '');
  return Number.isNaN(finished) || now >= finished + intervalMs - SCHEDULE_SLACK_MS;
}

/**
 * A new refresh starts an hour after the last one finished, or three times
 * its length when that is longer, and never while a catalog sync runs: it
 * would wait behind it and check products about to change.
 */
export function refreshDue(state: Pick<SyncState, 'status_refresh' | 'full_sync'> | null | undefined, now: number): boolean {
  if (state?.full_sync?.status === 'running') return false;
  const job = state?.status_refresh;
  return due(job, now, Math.max(REFRESH_MIN_INTERVAL_MS, REFRESH_INTERVAL_FACTOR * (job?.duration_ms ?? 0)));
}

export function orphanScanDue(job: OrphanScanJob | null | undefined, now: number): boolean {
  return due(job, now, ORPHAN_INTERVAL_MS);
}
