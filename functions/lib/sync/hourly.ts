import { loadConnection } from '../connection/store';
import { accessTokenFor, markBroken } from '../connection/token';
import type { AppContext } from '../context';
import { GoogleApiError, googleCall } from '../google/http';
import { listQuotas } from '../google/merchant';
import { iso } from '../time';
import { loadAlarm, setAlarm } from './alarm';
import { queueCount } from './queue';
import { loadState, saveState } from './state';

/** An alarm this far in the past means its run never happened. */
export const STALL_MS = 5 * 60_000;
export const QUOTA_TTL_MS = 24 * 3600_000;

interface QuotaGroup {
  quotaLimit?: string | number;
  quotaMinuteLimit?: string | number;
  methodDetails?: { method?: string; path?: string }[];
}

const toNumber = (value: unknown) => (value === undefined || value === null || value === '' ? null : Number(value));

export function quotaFromGroups(body: { quotaGroups?: QuotaGroup[] }): { minute_limit: number | null; daily_limit: number | null } {
  const group = body.quotaGroups?.find((g) => g.methodDetails?.some((m) => /productinputs\.insert/i.test(`${m.method ?? ''} ${m.path ?? ''}`)));
  return { minute_limit: toNumber(group?.quotaMinuteLimit), daily_limit: toNumber(group?.quotaLimit) };
}

/** Safety net: refreshes the quota daily and wakes a courier whose alarm was lost. */
export async function runHourly(ctx: AppContext): Promise<void> {
  const connection = await loadConnection(ctx.swell);
  if (connection?.status !== 'connected' || !connection.merchant_id) return;
  const state = await loadState(ctx.swell);
  const now = ctx.now();

  const checked = state.quota?.date_checked ? Date.parse(state.quota.date_checked) : 0;
  if (now - checked >= QUOTA_TTL_MS) {
    try {
      const token = await accessTokenFor(ctx, connection);
      const limits = quotaFromGroups(await googleCall(ctx.fetch, token, listQuotas(connection.merchant_id)));
      await saveState(ctx.swell, state.id, { quota: { $set: { ...state.quota, ...limits, date_checked: iso(now) } } });
    } catch (error) {
      if (!(error instanceof GoogleApiError)) throw error;
      if (error.kind === 'auth') {
        await markBroken(ctx, connection, error.message);
        return;
      }
    }
  }

  const pending = state.full_sync?.status === 'running' || (await queueCount(ctx.swell)) > 0;
  if (!pending) return;
  const alarm = await loadAlarm(ctx.swell);
  const wakeAt = alarm.wake_at ? Date.parse(alarm.wake_at) : null;
  if (wakeAt === null || wakeAt < now - STALL_MS) await setAlarm(ctx, now);
}
