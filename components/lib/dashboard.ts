import { COUNTRIES } from './countries';
import type { Tone } from './tone';

export const POLL_MS = 10_000;

export interface StatusCounters {
  approved: number;
  partial: number;
  pending: number;
  disapproved: number;
  not_sent: number;
  excluded: number;
}

export interface IssueTally {
  code: string;
  attribute?: string;
  severity: 'disapproved' | 'demoted' | 'review' | 'info';
  description: string;
  documentation?: string;
  products: number;
  samples: { id: string; name: string }[];
}

/** Mirrors `DashboardView` in functions/lib/admin/dashboard.ts. */
export interface DashboardView {
  connection: { status: 'disconnected' | 'connected' | 'broken'; merchant_id: string | null; last_error: string | null };
  summary: { counters: StatusCounters; top_issues: IssueTally[]; date_refreshed: string } | null;
  refresh: { status: 'running' | 'done'; checked: number; date_started: string; date_finished: string | null } | null;
  full_sync: { status: 'running' | 'done'; done: number; total: number; date_started: string; date_finished: string | null } | null;
  queue: number;
  paused_until: string | null;
  last_error: string | null;
  markets: { country: string; language: string; currency: string }[];
  account: { reasons: AccountReason[]; merchant_url: string | null };
}

/** Mirrors `AccountReason` in functions/lib/status/account.ts. */
export interface AccountReason {
  source: 'requirement' | 'issue';
  program: 'free-listings' | 'shopping-ads' | null;
  code: string;
  title: string;
  action: string | null;
  documentation: string | null;
  countries: string[];
}

export interface DashboardModel {
  banner: { tone: Tone; text: string } | null;
  stats: { key: keyof StatusCounters; label: string; value: number | null; tone: Tone }[];
  progress: { label: string; done: number; total: number | null }[];
  /** The courier's backlog is a count, not progress */
  queueText: string | null;
  issues: { key: string; code: string; description: string; documentation?: string; severity: { tone: Tone; label: string }; sampleText: string }[];
  refreshedText: string | null;
  /** The warning card: why Google holds the products */
  account: {
    title: string;
    lead: string;
    rows: { title: string; meta: string; action: string | null; documentation: string | null }[];
    merchantUrl: string | null;
  } | null;
  canSyncAll: boolean;
  canRefresh: boolean;
}

const STATS: { key: keyof StatusCounters; label: string; tone: Tone }[] = [
  { key: 'approved', label: 'Approved', tone: 'ok' },
  { key: 'partial', label: 'Partly approved', tone: 'info' },
  { key: 'pending', label: 'Pending', tone: 'neutral' },
  { key: 'disapproved', label: 'Disapproved', tone: 'bad' },
  { key: 'not_sent', label: 'Not sent', tone: 'neutral' },
  { key: 'excluded', label: 'Hidden', tone: 'neutral' },
];

export const SEVERITIES: Record<IssueTally['severity'], { tone: Tone; label: string }> = {
  disapproved: { tone: 'bad', label: 'Disapproved' },
  demoted: { tone: 'info', label: 'Limited' },
  review: { tone: 'neutral', label: 'In review' },
  info: { tone: 'neutral', label: 'Info' },
};

/** Mirrors `issueKey` in functions/lib/status/product-status.ts: one code can make a row per attribute. */
export const issueKey = (issue: { code: string; attribute?: string }) => `${issue.code}|${issue.attribute ?? ''}`;

const COUNTRY_NAMES = new Map(COUNTRIES);
const PROGRAMS: Record<NonNullable<AccountReason['program']>, string> = { 'free-listings': 'Free listings', 'shopping-ads': 'Shopping ads' };

function accountOf({ account }: DashboardView): DashboardModel['account'] {
  if (account.reasons.length === 0) return null;
  return {
    title: 'Google is not showing your products yet',
    lead: 'Merchant Center needs a few things from you. Products wait in “Pending” until then.',
    rows: account.reasons.map(({ title, program, countries, action, documentation }) => ({
      title,
      meta: [...(program ? [PROGRAMS[program]] : []), countries.map((c) => COUNTRY_NAMES.get(c) ?? c).join(', ')].filter(Boolean).join(' · '),
      action,
      documentation,
    })),
    merchantUrl: account.merchant_url,
  };
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

function ago(since: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  if (minutes < 1) return 'just now';
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (minutes < 60) return plural(minutes, 'minute');
  if (minutes < 1440) return plural(Math.floor(minutes / 60), 'hour');
  return plural(Math.floor(minutes / 1440), 'day');
}

const utcTime = (iso: string) => new Date(iso).toISOString().slice(11, 16);

function bannerOf(view: DashboardView): DashboardModel['banner'] {
  const { status, last_error } = view.connection;
  if (status === 'disconnected') return { tone: 'neutral', text: 'Connect Google Merchant Center in the Connection section.' };
  if (status === 'broken') return { tone: 'bad', text: `Google refused the connection${last_error ? `: ${last_error}` : ''}` };
  if (view.paused_until) return { tone: 'info', text: `Google's daily limit is reached. Syncing resumes at ${utcTime(view.paused_until)} UTC.` };
  if (view.last_error) return { tone: 'bad', text: `Last sync error: ${view.last_error}` };
  return null;
}

export function dashboardModel(view: DashboardView, now: number): DashboardModel {
  const counters = view.summary?.counters;
  const connected = view.connection.status === 'connected';
  const progress: DashboardModel['progress'] = [];
  if (view.full_sync?.status === 'running') progress.push({ label: 'Sending the catalog', done: view.full_sync.done, total: view.full_sync.total });
  if (view.refresh?.status === 'running') progress.push({ label: 'Checking statuses', done: view.refresh.checked, total: null });
  return {
    banner: bannerOf(view),
    stats: STATS.map((stat) => ({ ...stat, value: counters ? counters[stat.key] : null })),
    progress,
    queueText: view.queue > 0 ? `${count(view.queue, 'product')} waiting to send` : null,
    issues: (view.summary?.top_issues ?? []).map(({ code, attribute, description, documentation, severity, products, samples }) => ({
      key: issueKey({ code, attribute }),
      code,
      description,
      ...(documentation ? { documentation } : {}),
      severity: SEVERITIES[severity],
      sampleText: `${count(products, 'product')}${samples.length > 0 ? `: ${samples.slice(0, 3).map((sample) => sample.name).join(', ')}` : ''}`,
    })),
    refreshedText: view.summary ? `Statuses checked ${ago(Date.parse(view.summary.date_refreshed), now)}` : 'Statuses are checked within the hour',
    account: accountOf(view),
    canSyncAll: connected && view.full_sync?.status !== 'running',
    canRefresh: connected && view.refresh?.status !== 'running',
  };
}
