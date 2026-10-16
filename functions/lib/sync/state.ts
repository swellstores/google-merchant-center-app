import type { SwellClient } from '../context';
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

export interface SyncState {
  id: string;
  running_since?: string | null;
  not_before?: string | null;
  backoff?: number;
  last_error?: string | null;
  full_sync?: FullSyncJob | null;
  quota?: QuotaInfo | null;
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
 * (`full_sync`, `quota`) are replaced whole with `{ $set: … }` so cleared fields really clear.
 */
export function stateWrite(id: string | null | undefined, patch: Record<string, unknown>): BatchOp {
  return id ? { method: 'put', url: `${COLLECTION}/${id}`, data: patch } : { method: 'post', url: COLLECTION, data: { backoff: 0, ...plain(patch) } };
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

export async function loadState(swell: SwellClient): Promise<SyncState> {
  const list = await swell.get(COLLECTION, FIRST);
  return list?.results?.[0] ?? (await swell.post(COLLECTION, { backoff: 0 }));
}

export async function saveState(swell: SwellClient, id: string, patch: Record<string, unknown>): Promise<SyncState> {
  return swell.put(`${COLLECTION}/${id}`, patch);
}
