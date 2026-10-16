import { describe, expect, it } from 'vitest';
import { newOrphanScanJob } from '../../../functions/lib/status/orphans';
import { newStatusRefreshJob, type StatusRefreshJob } from '../../../functions/lib/status/refresh';
import {
  ORPHAN_INTERVAL_MS,
  orphanScanDue,
  REFRESH_INTERVAL_FACTOR,
  REFRESH_MIN_INTERVAL_MS,
  refreshDue,
  SCHEDULE_SLACK_MS,
} from '../../../functions/lib/status/schedule';
import { newFullSyncJob } from '../../../functions/lib/sync/state';
import { iso } from '../../../functions/lib/time';
import { NOW } from '../../helpers/context';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const SECOND = 1000;

/** A refresh whose passes took `durationMs` and finished at `finishedAt`. */
const finished = (finishedAt: number, durationMs: number): StatusRefreshJob => ({
  ...newStatusRefreshJob(finishedAt - durationMs - HOUR),
  status: 'done',
  date_first_pass: iso(finishedAt - durationMs),
  date_finished: iso(finishedAt),
  duration_ms: durationMs,
});

describe('refreshDue', () => {
  it('a first refresh is due', () => {
    expect(refreshDue(undefined, NOW)).toBe(true);
    expect(refreshDue({ status_refresh: null }, NOW)).toBe(true);
  });

  it('no refresh while one runs', () => {
    expect(refreshDue({ status_refresh: newStatusRefreshJob(NOW - 5 * HOUR) }, NOW)).toBe(false);
  });

  it('no refresh while a catalog sync runs', () => {
    const catalog = newFullSyncJob(NOW - 8 * HOUR);
    expect(refreshDue({ full_sync: catalog }, NOW)).toBe(false);
    expect(refreshDue({ full_sync: catalog, status_refresh: finished(NOW - 5 * HOUR, MINUTE) }, NOW)).toBe(false);
    expect(refreshDue({ full_sync: { ...catalog, status: 'done' } }, NOW)).toBe(true);
  });

  it('an hour after a short refresh, less the slack for the hourly cron', () => {
    expect(REFRESH_MIN_INTERVAL_MS).toBe(HOUR);
    expect(SCHEDULE_SLACK_MS).toBe(10 * MINUTE);
    const short = finished(NOW - HOUR + SCHEDULE_SLACK_MS, 10 * MINUTE);
    expect(refreshDue({ status_refresh: short }, NOW)).toBe(true);
    expect(refreshDue({ status_refresh: short }, NOW - 1)).toBe(false);
  });

  it('three times its length after a long one, less the slack', () => {
    expect(REFRESH_INTERVAL_FACTOR).toBe(3);
    const long = finished(NOW - 2 * HOUR + SCHEDULE_SLACK_MS, 40 * MINUTE);
    expect(refreshDue({ status_refresh: long }, NOW)).toBe(true);
    expect(refreshDue({ status_refresh: long }, NOW - 1)).toBe(false);
    expect(refreshDue({ status_refresh: finished(NOW - 2 * HOUR + SCHEDULE_SLACK_MS, 41 * MINUTE) }, NOW)).toBe(false);
  });

  it('a refresh that finished at :00:10 is due at the next :00', () => {
    const hour = Date.UTC(2026, 9, 15, 10);
    const short = finished(hour + 10 * SECOND, 5 * SECOND);
    expect(refreshDue({ status_refresh: short }, hour + HOUR)).toBe(true);
    expect(refreshDue({ status_refresh: short }, hour + 30 * MINUTE)).toBe(false);
  });

  it('a refresh that finished without a pass reads as zero length', () => {
    const job: StatusRefreshJob = { ...newStatusRefreshJob(NOW - 5 * HOUR), status: 'done', date_finished: iso(NOW - HOUR), duration_ms: null };
    expect(refreshDue({ status_refresh: job }, NOW - SCHEDULE_SLACK_MS)).toBe(true);
    expect(refreshDue({ status_refresh: job }, NOW - SCHEDULE_SLACK_MS - 1)).toBe(false);
  });
});

describe('orphanScanDue', () => {
  it('the orphan scan is daily, less the slack', () => {
    expect(ORPHAN_INTERVAL_MS).toBe(24 * HOUR);
    expect(orphanScanDue(undefined, NOW)).toBe(true);
    expect(orphanScanDue(newOrphanScanJob(NOW - 48 * HOUR), NOW)).toBe(false);
    const done = { ...newOrphanScanJob(NOW - 25 * HOUR), status: 'done' as const, date_finished: iso(NOW - 24 * HOUR + SCHEDULE_SLACK_MS) };
    expect(orphanScanDue(done, NOW)).toBe(true);
    expect(orphanScanDue(done, NOW - 1)).toBe(false);
  });

  it('a scan that finished at :00:10 is due at the same :00 a day later', () => {
    const hour = Date.UTC(2026, 9, 15, 10);
    const done = { ...newOrphanScanJob(hour), status: 'done' as const, date_finished: iso(hour + 10 * SECOND) };
    expect(orphanScanDue(done, hour + 24 * HOUR)).toBe(true);
    expect(orphanScanDue(done, hour + 23 * HOUR)).toBe(false);
  });
});
