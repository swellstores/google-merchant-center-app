import { connectionRead, connectionWrite, type Connection } from '../connection/store';
import { accessTokenFor, brokenPatch } from '../connection/token';
import type { AppContext } from '../context';
import { GoogleApiError } from '../google/http';
import { listOf, recordOf, swellBatch, type BatchOp } from '../swell-batch';
import { iso } from '../time';
import { alarmRead, alarmWrite, type Alarm } from './alarm';
import { QUOTA_TTL_MS, readQuota } from './quota';
import { takeRead } from './queue';
import { stateRead, stateWrite, type SyncState } from './state';

/** An alarm this far in the past means its run never happened. */
export const STALL_MS = 5 * 60_000;

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
