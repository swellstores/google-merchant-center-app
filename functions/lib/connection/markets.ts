import type { AppContext, SwellClient } from '../context';
import { GoogleApiError, googleCall } from '../google/http';
import { createDataSource, deleteDataSource } from '../google/merchant';

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

/** ISO 639-1 from a Swell locale code. */
export const languageOf = (locale?: string | null) => (locale || 'en').split(/[-_]/)[0].toLowerCase();

export async function loadMarkets(swell: SwellClient): Promise<Market[]> {
  const list = await swell.get(COLLECTION, { limit: 100, sort: 'date_created asc' });
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

/** Every market gets its own API data source before the first product is sent there. */
export async function ensureDataSources(ctx: AppContext, token: string, accountId: string, markets: Market[]): Promise<Market[]> {
  const ready: Market[] = [];
  for (const market of markets) {
    if (market.data_source) {
      ready.push(market);
      continue;
    }
    const created = await googleCall<{ name: string }>(ctx.fetch, token, createDataSource(accountId, market));
    ready.push(await ctx.swell.put(`${COLLECTION}/${market.id}`, { data_source: created.name }));
  }
  return ready;
}
