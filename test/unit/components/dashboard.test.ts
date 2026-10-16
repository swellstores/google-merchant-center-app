import { describe, expect, it } from 'vitest';
import { dashboardModel, type DashboardView } from '../../../components/lib/dashboard';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const COUNTERS = { approved: 10, partial: 2, pending: 3, disapproved: 4, not_sent: 5, excluded: 6 };

function view(patch: Partial<DashboardView> = {}): DashboardView {
  return {
    connection: { status: 'connected', merchant_id: '123', last_error: null },
    summary: null,
    refresh: null,
    full_sync: null,
    queue: 0,
    paused_until: null,
    last_error: null,
    markets: [],
    ...patch,
  };
}

const summary = (date_refreshed: string) => ({ counters: COUNTERS, top_issues: [], date_refreshed });

describe('dashboardModel', () => {
  it('before the first refresh the stats are empty and the hint says within the hour', () => {
    const model = dashboardModel(view(), NOW);
    expect(model.stats.map((s) => s.value)).toEqual([null, null, null, null, null, null]);
    expect(model.refreshedText).toBe('Statuses are checked within the hour');
    expect(model.issues).toEqual([]);
  });

  it('counts map to their tones', () => {
    const model = dashboardModel(view({ summary: summary('2026-10-16T11:55:00Z') }), NOW);
    expect(model.stats.map((s) => [s.label, s.value, s.tone])).toEqual([
      ['Approved', 10, 'ok'],
      ['Partly approved', 2, 'info'],
      ['Pending', 3, 'neutral'],
      ['Disapproved', 4, 'bad'],
      ['Not sent', 5, 'neutral'],
      ['Hidden', 6, 'neutral'],
    ]);
    expect(model.refreshedText).toBe('Statuses checked 5 minutes ago');
  });

  it('a running catalog sync shows its progress with the total', () => {
    const full_sync = { status: 'running' as const, done: 40, total: 120, date_started: '2026-10-16T11:00:00Z', date_finished: null };
    const model = dashboardModel(view({ full_sync, queue: 7, refresh: { status: 'running', checked: 9, date_started: '2026-10-16T11:00:00Z', date_finished: null } }), NOW);
    expect(model.progress).toEqual([
      { label: 'Sending the catalog', done: 40, total: 120 },
      { label: 'Checking statuses', done: 9, total: null },
      { label: 'Waiting to send', done: 7, total: null },
    ]);
  });

  it('a daily quota pause shows the resume time', () => {
    const model = dashboardModel(view({ paused_until: '2026-10-17T07:05:00Z' }), NOW);
    expect(model.banner).toEqual({ tone: 'info', text: "Google's daily limit is reached. Syncing resumes at 07:05 UTC." });
  });

  it('a disconnected store can neither sync nor refresh', () => {
    const model = dashboardModel(view({ connection: { status: 'disconnected', merchant_id: null, last_error: null } }), NOW);
    expect(model.banner).toEqual({ tone: 'neutral', text: 'Connect Google Merchant Center in the Connection section.' });
    expect(model.canSyncAll).toBe(false);
    expect(model.canRefresh).toBe(false);
  });

  it('a broken connection shows Google\'s refusal and blocks both actions', () => {
    const model = dashboardModel(view({ connection: { status: 'broken', merchant_id: '1', last_error: 'invalid_grant' } }), NOW);
    expect(model.banner).toEqual({ tone: 'bad', text: 'Google refused the connection: invalid_grant' });
    expect(model.canSyncAll).toBe(false);
    expect(model.canRefresh).toBe(false);
  });

  it('a courier error shows as a banner', () => {
    expect(dashboardModel(view({ last_error: 'timeout' }), NOW).banner).toEqual({ tone: 'bad', text: 'Last sync error: timeout' });
  });

  it('a running refresh cannot be refreshed again', () => {
    const refresh = { status: 'running' as const, checked: 1, date_started: '2026-10-16T11:59:00Z', date_finished: null };
    const model = dashboardModel(view({ refresh }), NOW);
    expect(model.canRefresh).toBe(false);
    expect(model.canSyncAll).toBe(true);
  });

  it('passes the top issues through', () => {
    const issue = { code: 'c', severity: 'disapproved' as const, description: 'Bad', products: 3, samples: [{ id: '1', name: 'A' }] };
    const model = dashboardModel(view({ summary: { ...summary('2026-10-16T11:59:30Z'), top_issues: [issue] } }), NOW);
    expect(model.issues).toEqual([{ code: 'c', description: 'Bad', products: 3, samples: [{ id: '1', name: 'A' }] }]);
    expect(model.refreshedText).toBe('Statuses checked just now');
  });
});
