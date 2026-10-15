import { describe, expect, it } from 'vitest';
import { ensureDataSources, languageOf, loadMarkets, replaceMarket } from '../../../functions/lib/connection/markets';
import { testContext } from '../../helpers/context';
import { createFakeGoogle } from '../../helpers/fake-google';
import { createFakeSwell } from '../../helpers/fake-swell';

const US = { country: 'US', language: 'en', currency: 'USD', link_template: 'https://shop.example.com/products/{slug}' };

describe('languageOf', () => {
  it.each([
    ['en-US', 'en'],
    ['fr', 'fr'],
    ['pt_BR', 'pt'],
    [null, 'en'],
  ])('%s → %s', (locale, language) => {
    expect(languageOf(locale)).toBe(language);
  });
});

describe('replaceMarket', () => {
  it('creates the first market', async () => {
    const { swell } = createFakeSwell();
    const market = await replaceMarket(testContext(swell), 'tok', US);
    expect(market).toMatchObject({ ...US, data_source: null });
    expect(await loadMarkets(swell)).toHaveLength(1);
  });

  it('updates currency and link of the same country and language, keeping its data source', async () => {
    const { swell } = createFakeSwell({ markets: [{ ...US, data_source: 'accounts/123/dataSources/1' }] });
    const market = await replaceMarket(testContext(swell), 'tok', { ...US, link_template: 'https://new.example.com/p/{slug}' });
    expect(market).toMatchObject({ link_template: 'https://new.example.com/p/{slug}', data_source: 'accounts/123/dataSources/1' });
    expect(await loadMarkets(swell)).toHaveLength(1);
  });

  it('replaces a market of another country and deletes its data source in Google', async () => {
    const google = createFakeGoogle();
    const { swell } = createFakeSwell();
    const ctx = testContext(swell, google.fetch);
    const [first] = await ensureDataSources(ctx, 'tok', '123', [await replaceMarket(ctx, 'tok', US)]);
    const next = await replaceMarket(ctx, 'tok', { ...US, country: 'GB', currency: 'GBP' });
    expect(next).toMatchObject({ country: 'GB', data_source: null });
    expect(google.dataSources.has(first.data_source!)).toBe(false);
    expect((await loadMarkets(swell)).map((m) => m.country)).toEqual(['GB']);
  });
});

describe('ensureDataSources', () => {
  it('creates a data source for a market without one and stores its name', async () => {
    const google = createFakeGoogle();
    const { swell } = createFakeSwell({ markets: [US] });
    const ctx = testContext(swell, google.fetch);
    const [market] = await ensureDataSources(ctx, 'tok', '123', await loadMarkets(swell));
    expect(market.data_source).toBe('accounts/123/dataSources/1');
    expect((await loadMarkets(swell))[0].data_source).toBe('accounts/123/dataSources/1');
    expect(google.requests.find((r) => r.method === 'POST')!.body).toMatchObject({ primaryProductDataSource: { feedLabel: 'US', contentLanguage: 'en', countries: ['US'] } });
  });

  it('adopts the app\'s data source left in Google by an earlier connection', async () => {
    const google = createFakeGoogle();
    google.addDataSource({ name: 'accounts/123/dataSources/9', displayName: 'Swell — US en', primaryProductDataSource: { feedLabel: 'US', contentLanguage: 'en' } });
    const { swell } = createFakeSwell({ markets: [US] });
    const [market] = await ensureDataSources(testContext(swell, google.fetch), 'tok', '123', await loadMarkets(swell));
    expect(market.data_source).toBe('accounts/123/dataSources/9');
    expect((await loadMarkets(swell))[0].data_source).toBe('accounts/123/dataSources/9');
    expect(google.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('ignores a data source with another name', async () => {
    const google = createFakeGoogle();
    google.addDataSource({ name: 'accounts/123/dataSources/9', displayName: 'Feed from elsewhere', primaryProductDataSource: { feedLabel: 'US', contentLanguage: 'en' } });
    const { swell } = createFakeSwell({ markets: [US] });
    const [market] = await ensureDataSources(testContext(swell, google.fetch), 'tok', '123', await loadMarkets(swell));
    expect(market.data_source).toBe('accounts/123/dataSources/1');
  });

  it('keeps the data source another run stored meanwhile and drops its own', async () => {
    const google = createFakeGoogle();
    const { swell, collections } = createFakeSwell({ markets: [US] });
    const fetchWithRace = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await google.fetch(input, init);
      if (init?.method === 'POST' && String(input).includes('/datasources/v1/accounts/123/dataSources')) {
        collections['/markets'][0].data_source = 'accounts/123/dataSources/77';
      }
      return res;
    }) as typeof fetch;
    const [market] = await ensureDataSources(testContext(swell, fetchWithRace), 'tok', '123', await loadMarkets(swell));
    expect(market.data_source).toBe('accounts/123/dataSources/77');
    expect(google.dataSources.has('accounts/123/dataSources/1')).toBe(false);
  });

  it('leaves markets that have one alone', async () => {
    const google = createFakeGoogle();
    const { swell } = createFakeSwell({ markets: [{ ...US, data_source: 'accounts/123/dataSources/5' }] });
    await ensureDataSources(testContext(swell, google.fetch), 'tok', '123', await loadMarkets(swell));
    expect(google.requests).toHaveLength(0);
  });
});
