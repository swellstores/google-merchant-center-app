import { describe, expect, it } from 'vitest';
import { dashboardModel, type DashboardView, type IssueTally } from '../../../components/lib/dashboard';

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
    account: { reasons: [], merchant_url: 'https://merchants.google.com/mc/overview?a=123' },
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

  it('the queue is a text line with its count', () => {
    expect(dashboardModel(view({ queue: 7 }), NOW).queueText).toBe('7 products waiting to send');
    expect(dashboardModel(view({ queue: 1 }), NOW).queueText).toBe('1 product waiting to send');
    expect(dashboardModel(view({ queue: 0 }), NOW).queueText).toBeNull();
    expect(dashboardModel(view({ queue: 7 }), NOW).progress).toEqual([]);
  });

  const issue = (severity: 'disapproved' | 'demoted' | 'review' | 'info', products = 3, names: string[] = ['A']) => ({
    code: severity,
    severity,
    description: 'Bad',
    products,
    samples: names.map((name, i) => ({ id: String(i), name })),
  });
  const issuesOf = (...issues: ReturnType<typeof issue>[]) =>
    dashboardModel(view({ summary: { ...summary('2026-10-16T11:59:30Z'), top_issues: issues } }), NOW).issues;

  it('issues carry their severity label and tone', () => {
    expect(issuesOf(issue('disapproved'), issue('demoted'), issue('review'), issue('info')).map((i) => i.severity)).toEqual([
      { tone: 'bad', label: 'Disapproved' },
      { tone: 'info', label: 'Limited' },
      { tone: 'neutral', label: 'In review' },
      { tone: 'neutral', label: 'Info' },
    ]);
  });

  it('sample text names up to three products', () => {
    expect(issuesOf(issue('info', 9, ['A', 'B', 'C', 'D']))[0].sampleText).toBe('9 products: A, B, C');
    expect(issuesOf(issue('info', 1, ['A']))[0].sampleText).toBe('1 product: A');
    expect(issuesOf(issue('info', 2, []))[0].sampleText).toBe('2 products');
  });

  it('passes the top issues through', () => {
    const model = dashboardModel(view({ summary: { ...summary('2026-10-16T11:59:30Z'), top_issues: [{ ...issue('disapproved'), documentation: 'https://g.co/x' }] } }), NOW);
    expect(model.issues[0]).toMatchObject({ code: 'disapproved', description: 'Bad', documentation: 'https://g.co/x' });
    expect(model.refreshedText).toBe('Statuses checked just now');
  });

  it('one code over two attributes makes two rows with their own keys and titles', () => {
    const missing = (attribute: string): IssueTally => ({ ...issue('disapproved'), code: 'missing', attribute, description: `Missing value [${attribute}]` });
    const top_issues = [missing('color'), missing('size'), issue('info')];
    const rows = dashboardModel(view({ summary: { ...summary('2026-10-16T11:59:30Z'), top_issues } }), NOW).issues;
    expect(rows.map((row) => [row.key, row.description])).toEqual([
      ['missing|color', 'Missing value [color]'],
      ['missing|size', 'Missing value [size]'],
      ['info|', 'Bad'],
    ]);
  });

  it('no stored reasons, no card', () => {
    expect(dashboardModel(view(), NOW).account).toBeNull();
  });

  it('the card row reads program and countries', () => {
    const reasons = [
      { source: 'requirement' as const, program: 'free-listings' as const, code: 'HAS_WEBSITE', title: 'No website URL', action: 'Add it.', documentation: 'https://support.google.com/x', countries: ['US'] },
      { source: 'requirement' as const, program: 'shopping-ads' as const, code: 'B', title: 'B', action: null, documentation: null, countries: ['US', 'DE'] },
      { source: 'issue' as const, program: null, code: 'C', title: 'C', action: null, documentation: null, countries: ['DE'] },
    ];
    const { account } = dashboardModel(view({ account: { reasons, merchant_url: 'https://merchants.google.com/mc/overview?a=123' } }), NOW);
    expect(account).toEqual({
      title: 'Google is not showing your products yet',
      lead: 'Merchant Center needs a few things from you. Products wait in “Pending” until then.',
      rows: [
        { title: 'No website URL', meta: 'Free listings · United States', action: 'Add it.', documentation: 'https://support.google.com/x' },
        { title: 'B', meta: 'Shopping ads · United States, Germany', action: null, documentation: null },
        { title: 'C', meta: 'Germany', action: null, documentation: null },
      ],
      merchantUrl: 'https://merchants.google.com/mc/overview?a=123',
    });
  });

  it('no card while broken or disconnected', () => {
    const reasons = [{ source: 'requirement' as const, program: 'free-listings' as const, code: 'A', title: 'A', action: null, documentation: null, countries: ['US'] }];
    const card = (status: DashboardView['connection']['status']) =>
      dashboardModel(view({ connection: { status, merchant_id: '123', last_error: null }, account: { reasons, merchant_url: null } }), NOW).account;
    expect(card('connected')).not.toBeNull();
    expect(card('broken')).toBeNull();
    expect(card('disconnected')).toBeNull();
  });

  it('card edge cases: unknown country, no countries, no Merchant Center link', () => {
    const reason = { source: 'requirement' as const, program: 'free-listings' as const, code: 'A', title: 'A', action: null, documentation: null };
    const card = (countries: string[]) => dashboardModel(view({ account: { reasons: [{ ...reason, countries }], merchant_url: null } }), NOW).account;
    expect(card(['ZZ'])?.rows[0].meta).toBe('Free listings · ZZ');
    expect(card([])?.rows[0].meta).toBe('Free listings');
    expect(card(['US'])?.merchantUrl).toBeNull();
  });
});
