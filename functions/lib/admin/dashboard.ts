import { AppError, type AppContext } from '../context';
import { connectionRead, type Connection, type ConnectionStatus } from '../connection/store';
import { marketsRead, type Market } from '../connection/markets';
import type { AccountReason } from '../status/account';
import { newOrphanScanJob } from '../status/orphans';
import { newStatusRefreshJob, type StatusSummary } from '../status/refresh';
import { orphanScanDue } from '../status/schedule';
import { countOf, listOf, recordOf, swellBatch, type BatchOp } from '../swell-batch';
import { alarmRead, alarmWrite, type Alarm } from '../sync/alarm';
import { takeRead } from '../sync/queue';
import { newFullSyncJob, stateRead, stateWrite, type SyncState } from '../sync/state';

export interface DashboardView {
  connection: { status: ConnectionStatus; merchant_id: string | null; last_error: string | null };
  summary: StatusSummary | null;
  refresh: { status: 'running' | 'done'; checked: number; date_started: string; date_finished: string | null } | null;
  full_sync: { status: 'running' | 'done'; done: number; total: number; date_started: string; date_finished: string | null } | null;
  queue: number;
  /** The quota's pause, while it lasts */
  paused_until: string | null;
  /** The courier's */
  last_error: string | null;
  markets: { country: string; language: string; currency: string }[];
  /** What Google waits for; empty when nothing is held */
  account: { reasons: AccountReason[]; merchant_url: string | null };
}

interface Snapshot {
  connection: Connection | null;
  state: SyncState | null;
  alarm: Alarm | null;
  markets: Market[];
  queue: number;
}

const READS: BatchOp[] = [connectionRead, stateRead, marketsRead, takeRead(1), alarmRead];

async function snapshot(ctx: AppContext): Promise<Snapshot> {
  const answers = await swellBatch(ctx.swell, READS);
  return {
    connection: listOf<Connection>(answers[0], 'the connection')[0] ?? null,
    state: listOf<SyncState>(answers[1], 'the sync state')[0] ?? null,
    markets: listOf<Market>(answers[2], 'the markets'),
    queue: countOf(answers[3]),
    alarm: listOf<Alarm>(answers[4], 'the alarm')[0] ?? null,
  };
}

function viewOf({ connection, state, markets, queue }: Snapshot, now: number): DashboardView {
  const refresh = state?.status_refresh;
  const sync = state?.full_sync;
  const until = state?.quota?.exhausted_until;
  return {
    connection: {
      status: connection?.status ?? 'disconnected',
      merchant_id: connection?.merchant_id ?? null,
      last_error: connection?.last_error ?? null,
    },
    summary: state?.summary ?? null,
    refresh: refresh
      ? { status: refresh.status, checked: refresh.checked, date_started: refresh.date_started, date_finished: refresh.date_finished ?? null }
      : null,
    full_sync: sync
      ? { status: sync.status, done: sync.done, total: sync.total, date_started: sync.date_started, date_finished: sync.date_finished ?? null }
      : null,
    queue,
    paused_until: until && Date.parse(until) > now ? until : null,
    last_error: state?.last_error ?? null,
    markets: markets.map(({ country, language, currency }) => ({ country, language, currency })),
    account: {
      reasons: state?.account_check?.reasons ?? [],
      merchant_url: connection?.merchant_id ? `https://merchants.google.com/mc/overview?a=${encodeURIComponent(connection.merchant_id)}` : null,
    },
  };
}

export async function dashboardView(ctx: AppContext): Promise<DashboardView> {
  return viewOf(await snapshot(ctx), ctx.now());
}

/** Writes the state patch and wakes the courier, in one batch where every entry must be taken. */
async function start(ctx: AppContext, shot: Snapshot, patch: Record<string, unknown>, now: number): Promise<DashboardView> {
  const wake = alarmWrite(shot.alarm, now);
  const writes = [stateWrite(shot.state?.id, patch), ...(wake ? [wake] : [])];
  const results = await swellBatch(ctx.swell, writes);
  results.forEach((result, i) => recordOf(result, `the write to ${writes[i].url}`));
  const state = { ...shot.state, ...(recordOf<SyncState>(results[0], 'the sync state') ?? {}) } as SyncState;
  return viewOf({ ...shot, state }, now);
}

function connected(shot: Snapshot) {
  if (shot.connection?.status !== 'connected') {
    throw new AppError('not_connected', 'Google Merchant Center is not connected. Press Check again.', 409);
  }
}

/** The catalog goes to Google again from the first product. */
export async function startFullSync(ctx: AppContext): Promise<DashboardView> {
  const shot = await snapshot(ctx);
  connected(shot);
  const now = ctx.now();
  return start(ctx, shot, { full_sync: { $set: newFullSyncJob(now) } }, now);
}

/** A refresh already running is left alone; the orphan scan comes along when it is due. */
export async function startStatusRefresh(ctx: AppContext): Promise<DashboardView> {
  const shot = await snapshot(ctx);
  connected(shot);
  const now = ctx.now();
  if (shot.state?.status_refresh?.status === 'running') return viewOf(shot, now);
  const patch = {
    status_refresh: { $set: newStatusRefreshJob(now) },
    ...(orphanScanDue(shot.state?.orphan_scan, now) ? { orphan_scan: { $set: newOrphanScanJob(now) } } : {}),
  };
  return start(ctx, shot, patch, now);
}
