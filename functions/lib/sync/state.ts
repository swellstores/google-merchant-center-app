import type { AccountReason } from '../status/account';
import type { OrphanScanJob } from '../status/orphans';
import type { StatusRefreshJob, StatusSummary } from '../status/refresh';
import type { BatchOp } from '../swell-batch';
import { iso } from '../time';

export interface FullSyncJob {
  status: 'running' | 'done';
  cursor: string | null;
  total: number;
  done: number;
  date_started: string;
  date_finished?: string | null;
}

export interface QuotaInfo {
  minute_limit?: number | null;
  daily_limit?: number | null;
  date_checked?: string | null;
  exhausted_until?: string | null;
}

export interface AccountCheck {
  reasons: AccountReason[];
  date_checked: string;
}

export interface SyncState {
  id: string;
  running_since?: string | null;
  /** Bumped by each run's mark with `$inc`: the run lock */
  run_seq?: number;
  not_before?: string | null;
  backoff?: number;
  last_error?: string | null;
  full_sync?: FullSyncJob | null;
  quota?: QuotaInfo | null;
  status_refresh?: StatusRefreshJob | null;
  orphan_scan?: OrphanScanJob | null;
  /** The last finished status refresh */
  summary?: StatusSummary | null;
  /** The account's requirements and issues, read when a status refresh finished */
  account?: AccountCheck | null;
}

const COLLECTION = '/sync-states';
const FIRST = { limit: 1, sort: 'date_created asc' };

export const stateRead: BatchOp = { method: 'get', url: COLLECTION, data: FIRST };
export const stateById = (id: string): BatchOp => ({ method: 'get', url: `${COLLECTION}/${id}` });

/** `{ $set: value }` → `value`: operators are for updates, a create takes plain values. */
const plain = (patch: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [key, value && typeof value === 'object' && '$set' in value ? (value as { $set: unknown }).$set : value]),
  );

/**
 * A patch of the state, creating the record when there is none yet. Objects
 * (`full_sync`, `quota`) are replaced whole with `{ $set: … }` so cleared
 * fields really clear; counters go up with a top-level `$inc`, which counts
 * from 0 on a create.
 */
export function stateWrite(id: string | null | undefined, patch: Record<string, unknown>): BatchOp {
  if (id) return { method: 'put', url: `${COLLECTION}/${id}`, data: patch };
  const { $inc, ...rest } = patch as { $inc?: Record<string, number> };
  return { method: 'post', url: COLLECTION, data: { backoff: 0, ...plain(rest), ...$inc } };
}

/** A catalog sync from the first product; the first page fills in `total`. */
export const newFullSyncJob = (now: number): FullSyncJob => ({
  status: 'running',
  cursor: null,
  total: 0,
  done: 0,
  date_started: iso(now),
  date_finished: null,
});
