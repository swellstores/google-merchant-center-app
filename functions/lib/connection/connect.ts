import { AppError, type AppContext } from '../context';
import { GoogleApiError, googleCall } from '../google/http';
import { deleteDataSource } from '../google/merchant';
import { countOf, listOf, recordOf, swellBatch, type BatchOp } from '../swell-batch';
import { alarmRead, alarmWrite, type Alarm } from '../sync/alarm';
import { clearQueue, itemRemoval, takeRead, type QueueItem } from '../sync/queue';
import { newFullSyncJob, stateRead, stateWrite, type SyncState } from '../sync/state';
import { iso } from '../time';
import { runChecks, type CheckReport } from './checks';
import { languageOf, loadMarkets, marketsRead, replaceMarket, type Market, type MarketInput } from './markets';
import {
  connectionRead,
  connectionWrite,
  keyOf,
  loadConnection,
  parseServiceAccountKey,
  publicConnection,
  saveConnection,
  type Connection,
  type PublicConnection,
} from './store';
import { accessTokenFor } from './token';

export interface CheckInput {
  key?: string;
  merchant_id: string;
}

export interface ActivateInput {
  country: string;
  link_template: string;
}

export interface StatusView {
  connection: PublicConnection;
  market: Market | null;
  defaults: { link_template: string };
}

/** Queue items a disconnect removes in its own batch; more take further rounds. */
const DISCONNECT_TAKE = 800;

const firstOf = <T>(answer: unknown, what: string): T | null => listOf<T>(answer, what)[0] ?? null;
const defaultsOf = (ctx: AppContext) => ({ link_template: `${ctx.storeUrl.replace(/\/$/, '')}/products/{slug}` });

export async function connectionStatus(ctx: AppContext): Promise<StatusView> {
  const [connection, markets] = await Promise.all([loadConnection(ctx.swell), loadMarkets(ctx.swell)]);
  return { connection: publicConnection(connection), market: markets[0] ?? null, defaults: defaultsOf(ctx) };
}

function validateMerchant(merchantId: string) {
  if (!/^\d{1,20}$/.test(merchantId)) {
    throw new AppError('invalid_merchant_id', 'Enter the Merchant Center account ID: the number shown under the account name.');
  }
}

function validateMarket(input: ActivateInput) {
  if (!/^[A-Z]{2}$/.test(input.country)) throw new AppError('invalid_country', 'Choose the country you sell to.');
  if (!/^https:\/\/[^\s]+$/.test(input.link_template) || !/\{(slug|product_id)\}/.test(input.link_template)) {
    throw new AppError('invalid_link', 'The product link must start with https:// and contain {slug} or {product_id}.');
  }
}

/**
 * Stores the key (pasted now or kept from before) and runs every check. A
 * connected store stays connected while they run; when they pass it is
 * connected with the token cached, otherwise it waits disconnected with the
 * reason. A store that was not connected, or now connects another account,
 * gets a new `date_connected`, which makes `activate` send the catalog again.
 */
export async function check(ctx: AppContext, input: CheckInput): Promise<{ connection: PublicConnection; report: CheckReport }> {
  const existing = await loadConnection(ctx.swell);
  const key = input.key ? parseServiceAccountKey(input.key) : keyOf(existing);
  if (!key) throw new AppError('key_required', 'Paste the service account key (JSON).');
  validateMerchant(input.merchant_id);

  let id = existing?.id ?? null;
  if (!existing || existing.private_key !== key.private_key || existing.client_email !== key.client_email) {
    const saved = await saveConnection(ctx.swell, id, {
      ...(existing ? {} : { status: 'disconnected' as const }),
      client_email: key.client_email,
      private_key: key.private_key,
      private_key_id: key.private_key_id ?? null,
      project_id: key.project_id ?? null,
      access_token: null,
      access_token_expires: null,
    });
    id = saved.id;
  }

  const { report, token } = await runChecks(ctx, key, input.merchant_id);
  const now = iso(ctx.now());
  if (!report.ok || !token) {
    const failed = report.checks.find((c) => !c.ok);
    const connection = await saveConnection(ctx.swell, id, { status: 'disconnected', merchant_id: input.merchant_id, last_error: failed?.message ?? null, date_checked: now });
    return { connection: publicConnection(connection), report };
  }
  const reconnected = existing?.status !== 'connected' || existing.merchant_id !== input.merchant_id;
  const connection = await saveConnection(ctx.swell, id, {
    status: 'connected',
    merchant_id: input.merchant_id,
    registered: true,
    last_error: null,
    access_token: token.token,
    access_token_expires: iso(token.expiresAt),
    date_connected: reconnected ? now : (existing.date_connected ?? now),
    date_checked: now,
  });
  return { connection: publicConnection(connection), report };
}

/**
 * Creates or replaces the market of a connected store and starts sending the
 * catalog unless nothing it depends on changed: a new market, a catalog sync
 * that never ran or is older than the connection. Otherwise it only wakes the
 * courier for work that waits.
 */
export async function activate(ctx: AppContext, input: ActivateInput): Promise<StatusView> {
  validateMarket(input);
  const [details, answers] = await Promise.all([
    ctx.swell.get('/:details'),
    swellBatch(ctx.swell, [connectionRead, marketsRead, stateRead, alarmRead, takeRead(1)]),
  ]);
  const connection = firstOf<Connection>(answers[0], 'the connection');
  if (connection?.status !== 'connected' || !connection.merchant_id) {
    throw new AppError('not_connected', 'Google Merchant Center is not connected. Press Check again.', 409);
  }
  const markets = listOf<Market>(answers[1], 'the markets');
  const state = firstOf<SyncState>(answers[2], 'the sync state');
  const alarm = firstOf<Alarm>(answers[3], 'the alarm');
  const queued = listOf<QueueItem>(answers[4], 'the queue').length > 0;

  const next: MarketInput = {
    country: input.country,
    language: languageOf(details?.locale),
    currency: details?.currency ?? 'USD',
    link_template: input.link_template,
  };
  const previous = markets.find((m) => m.country === next.country && m.language === next.language);
  const marketChanged = !previous || previous.currency !== next.currency || previous.link_template !== next.link_template;
  const job = state?.full_sync;
  const restart = marketChanged || !job || Date.parse(job.date_started) < Date.parse(connection.date_connected ?? '');

  const writes: BatchOp[] = [];
  const token = await accessTokenFor(ctx, connection, (patch) => writes.push(connectionWrite(connection.id, patch)));
  writes.push(...(await replaceMarket(ctx, token, connection.merchant_id, markets, next)));
  const marketAt = writes.length - 1;
  const now = ctx.now();
  if (restart) writes.push(stateWrite(state?.id, { full_sync: { $set: newFullSyncJob(now) } }));
  const wake = restart || queued || job?.status === 'running' ? alarmWrite(alarm, now) : null;
  if (wake) writes.push(wake);
  const results = await swellBatch(ctx.swell, writes);
  // A refused write must fail the route: "connected" with nothing syncing would hide it.
  results.forEach((result, i) => recordOf(result, `the write to ${writes[i].url}`));
  const market = recordOf<Market>(results[marketAt], 'the market');
  return { connection: publicConnection(connection), market, defaults: defaultsOf(ctx) };
}

/** Stops syncing and forgets the key; optionally removes the products from Google first. */
export async function disconnect(ctx: AppContext, removeProducts: boolean): Promise<void> {
  const answers = await swellBatch(ctx.swell, [connectionRead, marketsRead, stateRead, alarmRead, takeRead(DISCONNECT_TAKE)]);
  const connection = firstOf<Connection>(answers[0], 'the connection');
  if (!connection) return;
  const markets = listOf<Market>(answers[1], 'the markets');
  const state = firstOf<SyncState>(answers[2], 'the sync state');
  const alarm = firstOf<Alarm>(answers[3], 'the alarm');
  const queue = listOf<QueueItem>(answers[4], 'the queue');
  let lastError: string | null = null;

  if (removeProducts && connection.merchant_id) {
    try {
      // The key goes below, so a new token is not worth saving.
      const token = await accessTokenFor(ctx, connection, () => undefined);
      for (const market of markets) {
        if (!market.data_source) continue;
        await googleCall(ctx.fetch, token, deleteDataSource(market.data_source)).catch((error) => {
          if (!(error instanceof GoogleApiError) || error.kind !== 'not_found') throw error;
        });
      }
    } catch (error) {
      if (!(error instanceof GoogleApiError) && !(error instanceof AppError)) throw error;
      lastError = `Products could not be removed from Google: ${error.message}`;
    }
  }

  const writes: BatchOp[] = [
    ...markets.filter((market) => market.data_source).map((market): BatchOp => ({ method: 'put', url: `/markets/${market.id}`, data: { data_source: null } })),
    ...queue.map((item) => itemRemoval(item.id)),
    ...(state ? [stateWrite(state.id, { full_sync: null, running_since: null, backoff: 0, last_error: null, not_before: null })] : []),
    connectionWrite(connection.id, {
      status: 'disconnected',
      private_key: null,
      private_key_id: null,
      access_token: null,
      access_token_expires: null,
      last_error: lastError,
    }),
  ];
  const clear = alarmWrite(alarm, null);
  if (clear) writes.push(clear);
  await swellBatch(ctx.swell, writes);
  if (countOf(answers[4]) > queue.length) await clearQueue(ctx.swell);
}
