import { connectionRead, connectionWrite, type Connection } from '../connection/store';
import { accessTokenFor, brokenPatch } from '../connection/token';
import type { AppContext } from '../context';
import { GoogleApiError, googleCall } from '../google/http';
import { listQuotas } from '../google/merchant';
import { listOf, recordOf, swellBatch, type BatchOp } from '../swell-batch';
import { iso } from '../time';
import { alarmRead, alarmWrite, type Alarm } from './alarm';
import { takeRead } from './queue';
import { stateRead, stateWrite, type QuotaInfo, type SyncState } from './state';

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

/** Writes them all in one round trip; a refused entry fails the run. */
async function writeAll(ctx: AppContext, writes: BatchOp[]): Promise<void> {
  const results = await swellBatch(ctx.swell, writes);
  results.forEach((result, i) => recordOf(result, `the write to ${writes[i].url}`));
}

/**
 * Safety net: refreshes the quota daily and wakes a courier whose alarm was
 * lost. One read, Google when the quota is due, one write.
 */
export async function runHourly(ctx: AppContext): Promise<void> {
  const answers = await swellBatch(ctx.swell, [connectionRead, stateRead, takeRead(1), alarmRead]);
  const connection = listOf<Connection>(answers[0], 'the connection')[0];
  if (connection?.status !== 'connected' || !connection.merchant_id) return;
  const state = listOf<SyncState>(answers[1], 'the sync state')[0];
  const queued = listOf(answers[2], 'the queue').length > 0;
  const alarm = listOf<Alarm>(answers[3], 'the alarm')[0] ?? null;
  const now = ctx.now();
  const writes: BatchOp[] = [];

  const checked = state?.quota?.date_checked ? Date.parse(state.quota.date_checked) : 0;
  if (now - checked >= QUOTA_TTL_MS) {
    try {
      const token = await accessTokenFor(ctx, connection, (patch) => writes.push(connectionWrite(connection.id, patch)));
      const quota = await readQuota(ctx, token, connection.merchant_id, state?.quota);
      writes.push(stateWrite(state?.id, { quota: { $set: quota } }));
    } catch (error) {
      if (!(error instanceof GoogleApiError)) throw error;
      // Google refused the key or the account: the courier stops, nothing to wake.
      if (error.kind === 'auth') return writeAll(ctx, [connectionWrite(connection.id, brokenPatch(error.message))]);
    }
  }

  const pending = state?.full_sync?.status === 'running' || queued;
  const wakeAt = alarm?.wake_at ? Date.parse(alarm.wake_at) : null;
  const notBefore = state?.not_before ? Date.parse(state.not_before) : 0;
  if (pending && (wakeAt === null || wakeAt < now - STALL_MS) && !(notBefore > now)) {
    const wake = alarmWrite(alarm, now);
    if (wake) writes.push(wake);
  }
  await writeAll(ctx, writes);
}
