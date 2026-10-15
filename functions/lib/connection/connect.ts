import { AppError, type AppContext } from '../context';
import { GoogleApiError, googleCall } from '../google/http';
import { deleteDataSource } from '../google/merchant';
import { iso } from '../time';
import { setAlarm } from '../sync/alarm';
import { startFullSync } from '../sync/full-sync';
import { clearQueue } from '../sync/queue';
import { loadState, saveState } from '../sync/state';
import { runChecks, type CheckReport } from './checks';
import { languageOf, loadMarkets, replaceMarket, type Market } from './markets';
import { keyOf, loadConnection, parseServiceAccountKey, publicConnection, saveConnection, type PublicConnection } from './store';
import { accessTokenFor } from './token';

export interface ConnectInput {
  key?: string;
  merchant_id: string;
  country: string;
  link_template: string;
}

export interface StatusView {
  connection: PublicConnection;
  market: Market | null;
  defaults: { link_template: string };
}

export async function connectionStatus(ctx: AppContext): Promise<StatusView> {
  const [connection, markets] = await Promise.all([loadConnection(ctx.swell), loadMarkets(ctx.swell)]);
  return {
    connection: publicConnection(connection),
    market: markets[0] ?? null,
    defaults: { link_template: `${ctx.storeUrl.replace(/\/$/, '')}/products/{slug}` },
  };
}

function validate(input: ConnectInput) {
  if (!/^\d{1,20}$/.test(input.merchant_id)) {
    throw new AppError('invalid_merchant_id', 'Enter the Merchant Center account ID: the number shown under the account name.');
  }
  if (!/^[A-Z]{2}$/.test(input.country)) throw new AppError('invalid_country', 'Choose the country you sell to.');
  if (!/^https:\/\/[^\s]+$/.test(input.link_template) || !/\{(slug|product_id)\}/.test(input.link_template)) {
    throw new AppError('invalid_link', 'The product link must start with https:// and contain {slug} or {product_id}.');
  }
}

/**
 * Stores the key (pasted now or kept from before), runs every check and, when
 * all pass, creates the market and starts sending the catalog.
 */
export async function connect(ctx: AppContext, input: ConnectInput) {
  const existing = await loadConnection(ctx.swell);
  const key = input.key ? parseServiceAccountKey(input.key) : keyOf(existing);
  if (!key) throw new AppError('key_required', 'Paste the service account key (JSON).');
  validate(input);

  let connection = await saveConnection(ctx.swell, existing?.id ?? null, {
    status: 'disconnected',
    merchant_id: input.merchant_id,
    client_email: key.client_email,
    private_key: key.private_key,
    private_key_id: key.private_key_id ?? null,
    project_id: key.project_id ?? null,
    access_token: null,
    access_token_expires: null,
  });

  const { report, token } = await runChecks(ctx, key, input.merchant_id);
  const now = iso(ctx.now());
  if (!report.ok || !token) {
    const failed = report.checks.find((check) => !check.ok);
    connection = await saveConnection(ctx.swell, connection.id, { status: 'disconnected', last_error: failed?.message ?? null, date_checked: now });
    return { connection: publicConnection(connection), market: (await loadMarkets(ctx.swell))[0] ?? null, report };
  }

  if (existing?.merchant_id && existing.merchant_id !== input.merchant_id) {
    // Data sources belong to the previous account.
    for (const market of await loadMarkets(ctx.swell)) await ctx.swell.put(`/markets/${market.id}`, { data_source: null });
  }
  const details = await ctx.swell.get('/:details');
  const market = await replaceMarket(ctx, token.token, {
    country: input.country,
    language: languageOf(details?.locale),
    currency: details?.currency ?? 'USD',
    link_template: input.link_template,
  });
  connection = await saveConnection(ctx.swell, connection.id, {
    status: 'connected',
    registered: true,
    last_error: null,
    access_token: token.token,
    access_token_expires: iso(token.expiresAt),
    date_connected: existing?.date_connected ?? now,
    date_checked: now,
  });
  await startFullSync(ctx);
  return { connection: publicConnection(connection), market, report };
}

/** Stops syncing and forgets the key; optionally removes the products from Google first. */
export async function disconnect(ctx: AppContext, removeProducts: boolean): Promise<void> {
  const connection = await loadConnection(ctx.swell);
  if (!connection) return;
  const markets = await loadMarkets(ctx.swell);
  let lastError: string | null = null;

  if (removeProducts && connection.merchant_id) {
    try {
      const token = await accessTokenFor(ctx, connection);
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

  for (const market of markets) await ctx.swell.put(`/markets/${market.id}`, { data_source: null });
  await clearQueue(ctx.swell);
  const state = await loadState(ctx.swell);
  await saveState(ctx.swell, state.id, { full_sync: null, running_since: null, backoff: 0, last_error: null, not_before: null });
  await setAlarm(ctx, null);
  await saveConnection(ctx.swell, connection.id, {
    status: 'disconnected',
    private_key: null,
    private_key_id: null,
    access_token: null,
    access_token_expires: null,
    last_error: lastError,
  });
}
