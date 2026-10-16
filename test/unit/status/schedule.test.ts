import { describe, expect, it } from 'vitest';
import { newOrphanScanJob } from '../../../functions/lib/status/orphans';
import { newStatusRefreshJob, type StatusRefreshJob } from '../../../functions/lib/status/refresh';
import { ORPHAN_INTERVAL_MS, orphanScanDue, REFRESH_INTERVAL_FACTOR, REFRESH_MIN_INTERVAL_MS, refreshDue } from '../../../functions/lib/status/schedule';
import { iso } from '../../../functions/lib/time';
import { NOW } from '../../helpers/context';

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** A refresh that took `durationMs` and finished at `finishedAt`. */
const finished = (finishedAt: number, durationMs: number): StatusRefreshJob => ({
  ...newStatusRefreshJob(finishedAt - durationMs),
  status: 'done',
  date_finished: iso(finishedAt),
  duration_ms: durationMs,
});

describe('refreshDue', () => {
  it('a first refresh is due', () => {
    expect(refreshDue(undefined, NOW)).toBe(true);
    expect(refreshDue(null, NOW)).toBe(true);
  });

  it('no refresh while one runs', () => {
    expect(refreshDue(newStatusRefreshJob(NOW - 5 * HOUR), NOW)).toBe(false);
  });

  it('an hour after a short refresh', () => {
    expect(REFRESH_MIN_INTERVAL_MS).toBe(HOUR);
    const short = finished(NOW - HOUR, 10 * MINUTE);
    expect(refreshDue(short, NOW)).toBe(true);
    expect(refreshDue(short, NOW - 1)).toBe(false);
  });

  it('three times its length after a long one', () => {
    expect(REFRESH_INTERVAL_FACTOR).toBe(3);
    const long = finished(NOW - 2 * HOUR, 40 * MINUTE);
    expect(refreshDue(long, NOW)).toBe(true);
    expect(refreshDue(long, NOW - 1)).toBe(false);
    expect(refreshDue(finished(NOW - 2 * HOUR, 41 * MINUTE), NOW)).toBe(false);
  });
});

describe('orphanScanDue', () => {
  it('the orphan scan is daily', () => {
    expect(ORPHAN_INTERVAL_MS).toBe(24 * HOUR);
    expect(orphanScanDue(undefined, NOW)).toBe(true);
    expect(orphanScanDue(newOrphanScanJob(NOW - 48 * HOUR), NOW)).toBe(false);
    const done = { ...newOrphanScanJob(NOW - 25 * HOUR), status: 'done' as const, date_finished: iso(NOW - 24 * HOUR) };
    expect(orphanScanDue(done, NOW)).toBe(true);
    expect(orphanScanDue(done, NOW - 1)).toBe(false);
  });
});
