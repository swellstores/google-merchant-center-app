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
    expect(google.requests[0].body).toMatchObject({ primaryProductDataSource: { feedLabel: 'US', contentLanguage: 'en', countries: ['US'] } });
  });

  it('leaves markets that have one alone', async () => {
    const google = createFakeGoogle();
    const { swell } = createFakeSwell({ markets: [{ ...US, data_source: 'accounts/123/dataSources/5' }] });
    await ensureDataSources(testContext(swell, google.fetch), 'tok', '123', await loadMarkets(swell));
    expect(google.requests).toHaveLength(0);
  });
});
