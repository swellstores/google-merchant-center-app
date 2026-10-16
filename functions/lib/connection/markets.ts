import type { AppContext, SwellClient } from '../context';
import { GoogleApiError, googleCall } from '../google/http';
import { createDataSource, dataSourceName, deleteDataSource, listDataSources } from '../google/merchant';
import type { BatchOp } from '../swell-batch';

export interface Market {
  id: string;
  country: string;
  language: string;
  currency: string;
  link_template: string;
  data_source?: string | null;
}

export type MarketInput = Omit<Market, 'id' | 'data_source'>;

const COLLECTION = '/markets';
const ALL = { limit: 100, sort: 'date_created asc' };

export const marketsRead: BatchOp = { method: 'get', url: COLLECTION, data: ALL };

/** ISO 639-1 from a Swell locale code. */
export const languageOf = (locale?: string | null) => (locale || 'en').split(/[-_]/)[0].toLowerCase();

export async function loadMarkets(swell: SwellClient): Promise<Market[]> {
  const list = await swell.get(COLLECTION, ALL);
  return list?.results ?? [];
}

async function dropDataSource(ctx: AppContext, token: string, name: string): Promise<void> {
  try {
    await googleCall(ctx.fetch, token, deleteDataSource(name));
  } catch (error) {
    if (!(error instanceof GoogleApiError) || error.kind !== 'not_found') throw error;
  }
}

/**
 * Phase 1 keeps one market. The same country and language keep their data
 * source; another country or language replaces the market and removes the
 * old data source, with its products, from Google.
 */
export async function replaceMarket(ctx: AppContext, token: string, next: MarketInput): Promise<Market> {
  const markets = await loadMarkets(ctx.swell);
  const same = markets.find((m) => m.country === next.country && m.language === next.language);
  for (const market of markets) {
    if (market === same) continue;
    if (market.data_source) await dropDataSource(ctx, token, market.data_source);
    await ctx.swell.delete(`${COLLECTION}/${market.id}`);
  }
  if (same) return ctx.swell.put(`${COLLECTION}/${same.id}`, { currency: next.currency, link_template: next.link_template });
  return ctx.swell.post(COLLECTION, { ...next, data_source: null });
}

interface GoogleDataSource {
  name: string;
  displayName?: string;
  primaryProductDataSource?: { feedLabel?: string; contentLanguage?: string };
}

/** The app's own data source for a market, left in Google by an earlier connection. */
function findOwn(list: GoogleDataSource[], market: Market): GoogleDataSource | undefined {
  return list.find(
    (ds) =>
      ds.displayName === dataSourceName(market) &&
      ds.primaryProductDataSource?.feedLabel === market.country &&
      ds.primaryProductDataSource?.contentLanguage === market.language,
  );
}

/**
 * Every market gets its own API data source before the first product is sent
 * there: the app's existing one when Google has it, otherwise a new one.
 */
export async function ensureDataSources(ctx: AppContext, token: string, accountId: string, markets: Market[]): Promise<Market[]> {
  const ready: Market[] = [];
  let existing: GoogleDataSource[] | null = null;
  for (const market of markets) {
    if (market.data_source) {
      ready.push(market);
      continue;
    }
    existing ??= (await googleCall<{ dataSources?: GoogleDataSource[] }>(ctx.fetch, token, listDataSources(accountId))).dataSources ?? [];
    let name = findOwn(existing, market)?.name;
    if (!name) {
      name = (await googleCall<{ name: string }>(ctx.fetch, token, createDataSource(accountId, market))).name;
      // Another run may have stored one meanwhile: keep that one and drop ours.
      const current: Market | null = await ctx.swell.get(`${COLLECTION}/${market.id}`);
      if (current?.data_source && current.data_source !== name) {
        await dropDataSource(ctx, token, name);
        ready.push(current);
        continue;
      }
    }
    ready.push(await ctx.swell.put(`${COLLECTION}/${market.id}`, { data_source: name }));
  }
  return ready;
}
