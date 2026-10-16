import { describe, expect, it } from 'vitest';
import { dashboardView, startFullSync, startStatusRefresh } from '../../../functions/lib/admin/dashboard';
import { newOrphanScanJob } from '../../../functions/lib/status/orphans';
import { newStatusRefreshJob, type IssueTally } from '../../../functions/lib/status/refresh';
import { fixedClock, NOW, testContext } from '../../helpers/context';
import { batchesOf, createFakeSwell } from '../../helpers/fake-swell';
import { loadAlarm, loadState, saveState } from '../../helpers/store';

const at = (ms: number) => new Date(ms).toISOString();
const CONNECTED = { status: 'connected', merchant_id: '123', private_key: 'SECRET-KEY', access_token: 'SECRET-TOKEN', client_email: 'sa@x.iam' };
const MARKET = { country: 'US', language: 'en', currency: 'USD', link_template: 'https://x.example.com/{slug}', data_source: 'accounts/123/dataSources/1' };

function setup(connection: Record<string, unknown> | null = CONNECTED) {
  const fake = createFakeSwell({ connection: connection ?? undefined, markets: [MARKET] });
  return { ...fake, ctx: testContext(fake.swell, undefined, fixedClock(NOW)) };
}

const tally = (i: number): IssueTally => ({
  code: `issue_${i}`.padEnd(60, 'x'),
  severity: 'disapproved',
  description: 'd'.repeat(300),
  documentation: `https://support.google.com/merchants/answer/${i}`,
  products: 100 + i,
  samples: [1, 2, 3].map((n) => ({ id: 'a'.repeat(24), name: `Product ${n} `.padEnd(120, 'n') })),
});

describe('dashboardView', () => {
  it('is one batch read and carries no key or token', async () => {
    const { ctx, swell } = setup();
    const view = await dashboardView(ctx);
    expect(batchesOf(swell)).toHaveLength(1);
    expect(swell.get).not.toHaveBeenCalled();
    expect(view).toMatchObject({
      connection: { status: 'connected', merchant_id: '123', last_error: null },
      summary: null,
      refresh: null,
      full_sync: null,
      queue: 0,
      paused_until: null,
      last_error: null,
      markets: [{ country: 'US', language: 'en', currency: 'USD' }],
    });
    expect(JSON.stringify(view)).not.toMatch(/SECRET|link_template|data_source/);
  });

  it('shows a quota pause only while it lasts', async () => {
    const { ctx, swell } = setup();
    const { id } = await loadState(swell);
    await saveState(swell, id, { quota: { $set: { exhausted_until: at(NOW + 60_000) } } });
    expect((await dashboardView(ctx)).paused_until).toBe(at(NOW + 60_000));
    await saveState(swell, id, { quota: { $set: { exhausted_until: at(NOW - 60_000) } } });
    expect((await dashboardView(ctx)).paused_until).toBeNull();
  });

  it('stays under 75,000 bytes with 30 tallies of 3 samples', async () => {
    const { ctx, swell } = setup();
    const { id } = await loadState(swell);
    const issues = Array.from({ length: 30 }, (_, i) => tally(i));
    const counters = { approved: 1, partial: 1, pending: 1, disapproved: 1, not_sent: 1, excluded: 1 };
    await saveState(swell, id, {
      summary: { $set: { counters, top_issues: issues, date_refreshed: at(NOW) } },
      status_refresh: { $set: { ...newStatusRefreshJob(NOW), issues } },
    });
    const view = await dashboardView(ctx);
    expect(new TextEncoder().encode(JSON.stringify(view)).length).toBeLessThan(75_000);
    expect(view.summary?.top_issues).toHaveLength(30);
  });
});

describe('startFullSync', () => {
  it('restarts the catalog sync and wakes the courier', async () => {
    const { ctx, swell } = setup();
    swell.get.mockClear();
    const view = await startFullSync(ctx);
    expect(view.full_sync).toEqual({ status: 'running', done: 0, total: 0, date_started: at(NOW), date_finished: null });
    expect((await loadState(swell)).full_sync).toMatchObject({ status: 'running', cursor: null, date_started: at(NOW) });
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW));
    expect(batchesOf(swell)).toHaveLength(2);
  });

  it('is refused on a store that is not connected', async () => {
    const { ctx, swell } = setup(null);
    await expect(startFullSync(ctx)).rejects.toMatchObject({ code: 'not_connected', status: 409 });
    expect(batchesOf(swell)).toHaveLength(1);
    const { ctx: broken } = setup({ ...CONNECTED, status: 'broken' });
    await expect(startFullSync(broken)).rejects.toMatchObject({ code: 'not_connected' });
  });
});

describe('startStatusRefresh', () => {
  it('starts a refresh and a due orphan scan, and wakes the courier', async () => {
    const { ctx, swell } = setup();
    const view = await startStatusRefresh(ctx);
    expect(view.refresh).toMatchObject({ status: 'running', checked: 0 });
    const state = await loadState(swell);
    expect(state.status_refresh).toMatchObject({ status: 'running', date_started: at(NOW) });
    expect(state.orphan_scan).toMatchObject({ status: 'running', date_started: at(NOW) });
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW));
  });

  it('leaves a running refresh alone', async () => {
    const { ctx, swell } = setup();
    const { id } = await loadState(swell);
    const running = { ...newStatusRefreshJob(NOW - 60_000), checked: 40 };
    await saveState(swell, id, { status_refresh: { $set: running } });
    swell.post.mockClear();
    swell.put.mockClear();
    const view = await startStatusRefresh(ctx);
    expect(view.refresh).toMatchObject({ status: 'running', checked: 40, date_started: at(NOW - 60_000) });
    expect(swell.post).toHaveBeenCalledTimes(1);
    expect(swell.put).not.toHaveBeenCalled();
    expect((await loadState(swell)).status_refresh?.checked).toBe(40);
    expect((await loadAlarm(swell)).wake_at ?? null).toBeNull();
  });

  it('does not start an orphan scan that is not due', async () => {
    const { ctx, swell } = setup();
    const { id } = await loadState(swell);
    const scan = { ...newOrphanScanJob(NOW - 3_600_000), status: 'done', date_finished: at(NOW - 3_000_000) };
    await saveState(swell, id, { orphan_scan: { $set: scan } });
    await startStatusRefresh(ctx);
    expect((await loadState(swell)).orphan_scan).toMatchObject({ status: 'done' });
  });

  it('is refused on a store that is not connected', async () => {
    const { ctx } = setup(null);
    await expect(startStatusRefresh(ctx)).rejects.toMatchObject({ code: 'not_connected', status: 409 });
  });
});
