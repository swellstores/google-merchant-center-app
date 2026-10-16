import type { AppContext } from '../context';
import { GoogleApiError, googleCall } from '../google/http';
import { listQuotas } from '../google/merchant';
import { iso } from '../time';
import type { QuotaInfo } from './state';

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
 * key or the account (`auth`) throws; other Google errors keep the old limits,
 * still marked checked so no run asks again before the daily refresh.
 */
export async function readQuota(ctx: AppContext, token: string, accountId: string, previous?: QuotaInfo | null): Promise<QuotaInfo> {
  let limits = {};
  try {
    limits = quotaFromGroups(await googleCall(ctx.fetch, token, listQuotas(accountId)));
  } catch (error) {
    if (!(error instanceof GoogleApiError) || error.kind === 'auth') throw error;
  }
  return { ...previous, ...limits, date_checked: iso(ctx.now()) };
}

/** Limits never read, or read a day ago or more. */
export const quotaDue = (quota: QuotaInfo | null | undefined, now: number): boolean =>
  !quota?.date_checked || now - Date.parse(quota.date_checked) >= QUOTA_TTL_MS;
