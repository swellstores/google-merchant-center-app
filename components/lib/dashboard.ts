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
  severity: 'disapproved' | 'demoted' | 'info';
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
}

export interface DashboardModel {
  banner: { tone: Tone; text: string } | null;
  stats: { key: keyof StatusCounters; label: string; value: number | null; tone: Tone }[];
  progress: { label: string; done: number; total: number | null }[];
  issues: { code: string; description: string; documentation?: string; products: number; samples: { id: string; name: string }[] }[];
  refreshedText: string | null;
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
  if (view.queue > 0) progress.push({ label: 'Waiting to send', done: view.queue, total: null });
  return {
    banner: bannerOf(view),
    stats: STATS.map((stat) => ({ ...stat, value: counters ? counters[stat.key] : null })),
    progress,
    issues: (view.summary?.top_issues ?? []).map(({ code, description, documentation, products, samples }) => ({
      code,
      description,
      ...(documentation ? { documentation } : {}),
      products,
      samples,
    })),
    refreshedText: view.summary ? `Statuses checked ${ago(Date.parse(view.summary.date_refreshed), now)}` : 'Statuses are checked within the hour',
    canSyncAll: connected && view.full_sync?.status !== 'running',
    canRefresh: connected && view.refresh?.status !== 'running',
  };
}
