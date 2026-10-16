import { AppError, measured, type AppContext } from '../context';
import { GoogleApiError, googleCall } from '../google/http';
import { deleteDataSource } from '../google/merchant';
import { countOf, listOf, recordOf, SWELL_WAVE, swellBatch, type BatchOp } from '../swell-batch';
import { alarmRead, alarmWrite, type Alarm } from '../sync/alarm';
import { itemRemoval, takeRead, type QueueItem } from '../sync/queue';
import { newFullSyncJob, stateRead, stateWrite, type SyncState } from '../sync/state';
import { Budget, iso } from '../time';
import { runChecks, type CheckReport } from './checks';
import { readQuota } from '../sync/hourly';
import { dataSourceFor, languageOf, loadMarkets, marketsRead, ownDataSource, replaceMarket, sameMarket, type Market, type MarketInput } from './markets';
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

export interface ActivateInput {
  country: string;
  link_template: string;
}

/** The market comes along only to be validated: `activate` sets it up. */
export interface CheckInput extends ActivateInput {
  key?: string;
  merchant_id: string;
}

export interface StatusView {
  connection: PublicConnection;
  market: Market | null;
  defaults: { link_template: string };
}

/** A disconnect deletes queue items until this long after it started, well within the route's 10 s. */
export const DISCONNECT_BUDGET_MS = 7000;
const QUEUE_READ = 50;

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

/** Data source names carry their account: another account's are stale. */
const staleDataSources = (markets: Market[], merchantId: string): BatchOp[] =>
  markets
    .filter((market) => market.data_source && !market.data_source.startsWith(`accounts/${merchantId}/`))
    .map((market) => ({ method: 'put', url: `/markets/${market.id}`, data: { data_source: null } }));

/**
 * Stores the key (pasted now or kept from before) and runs every check. The
 * input is validated, the market's too, before anything is written. A
 * connected store stays connected while the checks run; when they pass it is
 * connected with the token cached, otherwise it waits disconnected with the
 * reason. A store that was not connected, or now connects another account,
 * gets a new `date_connected`, which makes `activate` send the catalog again;
 * another account's data sources are forgotten with the result.
 */
export async function check(ctx: AppContext, input: CheckInput): Promise<{ connection: PublicConnection; report: CheckReport }> {
  const pasted = input.key ? parseServiceAccountKey(input.key) : null;
  validateMerchant(input.merchant_id);
  validateMarket(input);
  const answers = await swellBatch(ctx.swell, [connectionRead, marketsRead]);
  const existing = firstOf<Connection>(answers[0], 'the connection');
  const markets = listOf<Market>(answers[1], 'the markets');
  const key = pasted ?? keyOf(existing);
  if (!key) throw new AppError('key_required', 'Paste the service account key (JSON).');

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
  const writes: BatchOp[] = [
    connectionWrite(id!, {
      status: 'connected',
      merchant_id: input.merchant_id,
      registered: true,
      last_error: null,
      access_token: token.token,
      access_token_expires: iso(token.expiresAt),
      date_connected: reconnected ? now : (existing.date_connected ?? now),
      date_checked: now,
    }),
    ...(existing?.merchant_id !== input.merchant_id ? staleDataSources(markets, input.merchant_id) : []),
  ];
  const results = await swellBatch(ctx.swell, writes);
  results.forEach((result, i) => recordOf(result, `the write to ${writes[i].url}`));
  return { connection: publicConnection(recordOf<Connection>(results[0], 'the connection')), report };
}

/** A Google refusal while setting up fails the route with what it was about. */
async function inGoogle<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof GoogleApiError)) throw error;
    throw new AppError(`google_${error.kind}`, `Google could not ${what}: ${error.message}`, 502);
  }
}

/**
 * Creates or replaces the market of a connected store and starts sending the
 * catalog unless nothing it depends on changed: a new market, a catalog sync
 * that never ran or is older than the connection. Otherwise it only wakes the
 * courier for work that waits. Google comes first (the market's data source,
 * the quota, the old country's data source), then one batch writes it all:
 * a refusal leaves the store as it was.
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
  const accountId = connection.merchant_id;
  const previous = sameMarket(markets, next);
  const marketChanged = !previous || previous.currency !== next.currency || previous.link_template !== next.link_template;
  const job = state?.full_sync;
  const restart = marketChanged || !job || Date.parse(job.date_started) < Date.parse(connection.date_connected ?? '');

  const writes: BatchOp[] = [];
  const token = await inGoogle('accept the key', () => accessTokenFor(ctx, connection, (patch) => writes.push(connectionWrite(connection.id, patch))));
  const kept = ownDataSource(previous, accountId);
  const [dataSource, quota] = await Promise.all([
    kept ?? inGoogle('create the data source for your products', () => dataSourceFor(ctx, token, accountId, next)),
    restart || !state?.quota?.date_checked ? inGoogle('read the quota of the account', () => readQuota(ctx, token, accountId, state?.quota)) : null,
  ]);
  writes.push(...(await inGoogle('remove the products of the old country', () => replaceMarket(ctx, token, accountId, markets, next, dataSource))));
  const marketAt = writes.length - 1;
  const now = ctx.now();
  const statePatch = { ...(restart ? { full_sync: { $set: newFullSyncJob(now) } } : {}), ...(quota ? { quota: { $set: quota } } : {}) };
  if (Object.keys(statePatch).length) writes.push(stateWrite(state?.id, statePatch));
  const wake = restart || queued || job?.status === 'running' ? alarmWrite(alarm, now) : null;
  if (wake) writes.push(wake);
  const results = await swellBatch(ctx.swell, writes);
  // A refused write must fail the route: "connected" with nothing syncing would hide it.
  results.forEach((result, i) => recordOf(result, `the write to ${writes[i].url}`));
  const market = recordOf<Market>(results[marketAt], 'the market');
  return { connection: publicConnection(connection), market, defaults: defaultsOf(ctx) };
}

/**
 * Stops syncing and forgets the key; optionally removes the products from
 * Google first. The writes that matter go in one batch and must all be
 * taken; then queue items go, one server wave per round trip, while the
 * route has time. Items left over are harmless: nothing runs or queues while
 * disconnected, and connecting again sends the catalog anew.
 */
export async function disconnect(appCtx: AppContext, removeProducts: boolean): Promise<StatusView> {
  const budget = new Budget(appCtx.now, DISCONNECT_BUDGET_MS);
  const ctx = measured(appCtx, budget);
  const answers = await swellBatch(ctx.swell, [connectionRead, marketsRead, stateRead, alarmRead, takeRead(QUEUE_READ)]);
  const connection = firstOf<Connection>(answers[0], 'the connection');
  const markets = listOf<Market>(answers[1], 'the markets');
  if (!connection) return { connection: publicConnection(null), market: markets[0] ?? null, defaults: defaultsOf(ctx) };
  const state = firstOf<SyncState>(answers[2], 'the sync state');
  const alarm = firstOf<Alarm>(answers[3], 'the alarm');
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

  const clear = alarmWrite(alarm, null);
  const writes: BatchOp[] = [
    connectionWrite(connection.id, {
      status: 'disconnected',
      private_key: null,
      private_key_id: null,
      access_token: null,
      access_token_expires: null,
      last_error: lastError,
    }),
    ...(state ? [stateWrite(state.id, { full_sync: null, running_since: null, backoff: 0, last_error: null, not_before: null })] : []),
    ...(clear ? [clear] : []),
    ...markets.filter((market) => market.data_source).map((market): BatchOp => ({ method: 'put', url: `/markets/${market.id}`, data: { data_source: null } })),
  ];
  const results = await swellBatch(ctx.swell, writes);
  results.forEach((result, i) => recordOf(result, `the write to ${writes[i].url}`));

  let queue = listOf<QueueItem>(answers[4], 'the queue');
  let more = countOf(answers[4]) > queue.length;
  const tried: string[] = [];
  while (budget.has(budget.swellMs)) {
    if (!queue.length) {
      if (!more || !budget.has(2 * budget.swellMs)) break;
      const [next] = await swellBatch(ctx.swell, [takeRead(QUEUE_READ, tried)]);
      queue = listOf<QueueItem>(next, 'the queue');
      more = countOf(next) > queue.length;
      if (!queue.length) break;
      continue;
    }
    const chunk = queue.splice(0, SWELL_WAVE);
    tried.push(...chunk.map((item) => item.id));
    await swellBatch(ctx.swell, chunk.map((item) => itemRemoval(item.id)));
  }

  const market = markets[0] ? { ...markets[0], data_source: null } : null;
  return { connection: publicConnection(recordOf<Connection>(results[0], 'the connection')), market, defaults: defaultsOf(ctx) };
}
