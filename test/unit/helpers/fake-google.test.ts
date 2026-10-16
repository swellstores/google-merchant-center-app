import { describe, expect, it } from 'vitest';
import { sendBatch } from '../../../functions/lib/google/batch';
import { getProduct, insertProductInput, listProducts, type ProductInput } from '../../../functions/lib/google/merchant';
import { createFakeGoogle, type FakeGoogleOptions } from '../../helpers/fake-google';
import { NOW } from '../../helpers/context';

const DS = 'accounts/123/dataSources/1';
const FOREIGN = 'accounts/123/dataSources/9';

const input = (offerId: string, itemGroupId?: string): ProductInput => ({
  offerId,
  contentLanguage: 'en',
  feedLabel: 'US',
  productAttributes: {
    title: offerId,
    link: 'https://shop.example.com/p',
    imageLink: 'https://cdn.example.com/p.jpg',
    availability: 'IN_STOCK',
    price: { amountMicros: '1000000', currencyCode: 'USD' },
    ...(itemGroupId ? { itemGroupId } : {}),
  },
});

async function setup(options: FakeGoogleOptions = {}, offers: ProductInput[] = [input('a'), input('b'), input('c')]) {
  const google = createFakeGoogle(options);
  for (const offer of offers) {
    const call = insertProductInput('123', DS, offer);
    await google.fetch(`https://merchantapi.googleapis.com${call.path}?dataSource=${DS}`, { method: 'POST', body: JSON.stringify(offer) });
  }
  const read = async (call: { path: string; query?: Record<string, string> }) => {
    const res = await google.fetch(`https://merchantapi.googleapis.com${call.path}?${new URLSearchParams(call.query)}`);
    return { status: res.status, body: (await res.json()) as any };
  };
  return { google, read };
}

describe('fake Google products.get', () => {
  it('answers a stored input with a pending status expiring in 30 days', async () => {
    const { read } = await setup();
    const { status, body } = await read(getProduct('123', 'en~US~a'));
    expect(status).toBe(200);
    expect(body).toEqual({
      name: 'accounts/123/products/en~US~a',
      offerId: 'a',
      contentLanguage: 'en',
      feedLabel: 'US',
      productStatus: {
        destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', pendingCountries: ['US'] }],
        googleExpirationDate: new Date(NOW + 30 * 86_400_000).toISOString(),
      },
    });
  });

  it('answers a custom status, an injected error and 404 for an unknown offer', async () => {
    const status = { destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', approvedCountries: ['US'] }] };
    const { read } = await setup({ statuses: { 'en~US~a': status }, productsGetErrors: { 'en~US~b': { status: 500, body: { error: { message: 'boom' } } } } });
    expect((await read(getProduct('123', 'en~US~a'))).body.productStatus).toEqual(status);
    expect((await read(getProduct('123', 'en~US~b'))).status).toBe(500);
    expect((await read(getProduct('123', 'en~US~nope'))).status).toBe(404);
  });
});

describe('fake Google products.list', () => {
  it('pages with pageSize and pageToken, and the last page has no token', async () => {
    const { read } = await setup();
    const first = await read(listProducts('123', 2));
    expect(first.body.products.map((p: any) => p.offerId)).toEqual(['a', 'b']);
    expect(first.body.nextPageToken).toBeTruthy();
    const second = await read(listProducts('123', 2, first.body.nextPageToken));
    expect(second.body.products.map((p: any) => p.offerId)).toEqual(['c']);
    expect(second.body.nextPageToken).toBeUndefined();
  });

  it('lists exact-fit pages without a trailing token', async () => {
    const { read } = await setup();
    expect((await read(listProducts('123', 3))).body.nextPageToken).toBeUndefined();
  });

  it('includes strays from our data source and a foreign one, with names and data sources', async () => {
    const stray = { contentLanguage: 'en', feedLabel: 'US' };
    const { read } = await setup({ strays: [{ ...stray, dataSource: DS, offerId: 'x' }, { ...stray, dataSource: FOREIGN, offerId: 'y' }] }, [input('a')]);
    const { products } = (await read(listProducts('123', 10))).body;
    expect(products.map((p: any) => [p.name, p.dataSource])).toEqual([
      ['accounts/123/products/en~US~a', DS],
      ['accounts/123/products/en~US~x', DS],
      ['accounts/123/products/en~US~y', FOREIGN],
    ]);
  });

  it('returns itemGroupId only for variants', async () => {
    const { read } = await setup({}, [input('a'), input('b', 'g1')]);
    const { products } = (await read(listProducts('123', 10))).body;
    expect(products[0].productAttributes).toEqual({});
    expect(products[1].productAttributes).toEqual({ itemGroupId: 'g1' });
  });
});

describe('fake Google inside /batch/products/v1', () => {
  it('routes GET parts with query strings to the handlers', async () => {
    const { google } = await setup({}, [input('a'), input('b'), input('c')]);
    const results = await sendBatch(google.fetch, 'tok', [
      { id: 'one', call: getProduct('123', 'en~US~a') },
      { id: 'two', call: getProduct('123', 'en~US~nope') },
      { id: 'three', call: listProducts('123', 2) },
    ]);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId.one.status).toBe(200);
    expect((byId.one.body as any).productStatus.destinationStatuses).toHaveLength(1);
    expect(byId.two.status).toBe(404);
    expect(byId.three.status).toBe(200);
    expect((byId.three.body as any).products).toHaveLength(2);
    expect((byId.three.body as any).nextPageToken).toBeTruthy();
    expect(google.batches()).toBe(1);
  });
});
