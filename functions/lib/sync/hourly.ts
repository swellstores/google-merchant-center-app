import { loadConnection, type Connection } from '../connection/store';
import { accessTokenFor, markBroken } from '../connection/token';
import type { AppContext } from '../context';
import { GoogleApiError, googleCall } from '../google/http';
import { listQuotas } from '../google/merchant';
import { iso } from '../time';
import { loadAlarm, setAlarm } from './alarm';
import { queueCount } from './queue';
import { loadState, saveState, type QuotaInfo, type SyncState } from './state';

/** An alarm this far in the past means its run never happened. */
export const STALL_MS = 5 * 60_000;
export const QUOTA_TTL_MS = 24 * 3600_000;

interface QuotaGroup {
  name?: string;
  quotaLimit?: string | number;
  quotaMinuteLimit?: string | number;
  methodDetails?: { method?: string; path?: string }[];
}

const toNumber = (value: unknown) => (value === undefined || value === null || value === '' ? null : Number(value));

// `productinputsservice.insertproductinput` in Google's answer, `productinputs.insert` in its docs.
const INSERT_METHOD = /productinputs(?:service)?\.insert/i;

/** The limits of the group that counts product inserts, `accounts/{a}/quotas/merchant-productinputs-insert`. */
export function quotaFromGroups(body: { quotaGroups?: QuotaGroup[] }): { minute_limit: number | null; daily_limit: number | null } {
  const group = body.quotaGroups?.find(
    (g) => /\/merchant-productinputs-insert$/.test(g.name ?? '') || g.methodDetails?.some((m) => INSERT_METHOD.test(`${m.method ?? ''} ${m.path ?? ''}`)),
  );
  return { minute_limit: toNumber(group?.quotaMinuteLimit), daily_limit: toNumber(group?.quotaLimit) };
}

/**
 * Google's limits for product inserts, as a quota to store. A refusal of the
 * key or the account (`auth`) throws; other Google errors keep the old limits
 * (`null`), and the next run asks again.
 */
export async function readQuota(ctx: AppContext, token: string, accountId: string, previous?: QuotaInfo | null): Promise<QuotaInfo | null> {
  try {
    const limits = quotaFromGroups(await googleCall(ctx.fetch, token, listQuotas(accountId)));
    return { ...previous, ...limits, date_checked: iso(ctx.now()) };
  } catch (error) {
    if (!(error instanceof GoogleApiError) || error.kind === 'auth') throw error;
    return null;
  }
}

/**
 * Reads Google's limits for product inserts into the state, also the one in
 * hand. Resolves with Google's refusal of the key or account, after marking
 * the connection broken; other Google errors keep the old limits.
 */
export async function refreshQuota(ctx: AppContext, connection: Connection, state: SyncState): Promise<GoogleApiError | null> {
  try {
    const token = await accessTokenFor(ctx, connection);
    const quota = await readQuota(ctx, token, connection.merchant_id!, state.quota);
    if (quota) {
      await saveState(ctx.swell, state.id, { quota: { $set: quota } });
      state.quota = quota;
    }
  } catch (error) {
    if (!(error instanceof GoogleApiError)) throw error;
    if (error.kind === 'auth') {
      await markBroken(ctx, connection, error.message);
      return error;
    }
  }
  return null;
}

/** Safety net: refreshes the quota daily and wakes a courier whose alarm was lost. */
export async function runHourly(ctx: AppContext): Promise<void> {
  const connection = await loadConnection(ctx.swell);
  if (connection?.status !== 'connected' || !connection.merchant_id) return;
  const state = await loadState(ctx.swell);
  const now = ctx.now();

  const checked = state.quota?.date_checked ? Date.parse(state.quota.date_checked) : 0;
  if (now - checked >= QUOTA_TTL_MS && (await refreshQuota(ctx, connection, state))) return;

  const pending = state.full_sync?.status === 'running' || (await queueCount(ctx.swell)) > 0;
  if (!pending) return;
  const alarm = await loadAlarm(ctx.swell);
  const wakeAt = alarm.wake_at ? Date.parse(alarm.wake_at) : null;
  const notBefore = state.not_before ? Date.parse(state.not_before) : 0;
  if ((wakeAt === null || wakeAt < now - STALL_MS) && !(notBefore > now)) await setAlarm(ctx, now);
}
