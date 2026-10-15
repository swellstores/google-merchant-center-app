import type { SwellClient } from '../context';

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

export async function loadState(swell: SwellClient): Promise<SyncState> {
  const list = await swell.get(COLLECTION, { limit: 1, sort: 'date_created asc' });
  return list?.results?.[0] ?? (await swell.post(COLLECTION, { backoff: 0 }));
}

/** Objects (`full_sync`, `quota`) are replaced whole with `{ $set: … }` so cleared fields really clear. */
export async function saveState(swell: SwellClient, id: string, patch: Record<string, unknown>): Promise<SyncState> {
  return swell.put(`${COLLECTION}/${id}`, patch);
}
