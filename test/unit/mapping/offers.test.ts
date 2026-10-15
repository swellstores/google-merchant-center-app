import { describe, expect, it } from 'vitest';
import type { Market } from '../../../functions/lib/connection/markets';
import { buildOffers, marketOfInput, parseInputId } from '../../../functions/lib/mapping/offers';
import type { SwellProduct } from '../../../functions/lib/mapping/types';

const APP = 'google_merchant_center';
const MARKET: Market = {
  id: 'm1',
  country: 'US',
  language: 'en',
  currency: 'USD',
  link_template: 'https://shop.example.com/products/{slug}',
  data_source: 'accounts/1/dataSources/7',
};
const OPTS = { appId: APP, defaults: { condition: 'new' as const }, version: '1760000000000' };
const img = (url: string) => ({ file: { url } });

const MUG: SwellProduct = {
  id: 'p1',
  name: 'Mug',
  slug: 'mug',
  description: '<p>Big &amp; blue</p>',
  active: true,
  price: 12.5,
  images: [img('https://cdn.example.com/mug.jpg'), img('https://cdn.example.com/mug-2.jpg')],
  stock_tracking: true,
  stock_level: 3,
};

const SHIRT: SwellProduct = {
  id: 'p2',
  name: 'T-Shirt',
  slug: 't-shirt',
  active: true,
  price: 20,
  images: [img('https://cdn.example.com/shirt.jpg')],
  stock_tracking: true,
  variants: {
    results: [
      { id: 'v1', name: 'Red / M', price: 22, stock_level: 5, active: true, images: [img('https://cdn.example.com/red.jpg')] },
      { id: 'v2', name: 'Blue / M', stock_level: 0, active: true },
      { id: 'v3', name: 'Old', archived: true },
      { id: 'v4', name: 'Off', active: false },
    ],
  },
};

describe('buildOffers', () => {
  it('turns a product without variants into one offer', () => {
    const { offers, skipped } = buildOffers(MUG, [MARKET], OPTS);
    expect(skipped).toBeNull();
    expect(offers).toHaveLength(1);
    expect(offers[0].inputId).toBe('en~US~p1');
    expect(offers[0].market).toBe(MARKET);
    expect(offers[0].input).toEqual({
      offerId: 'p1',
      contentLanguage: 'en',
      feedLabel: 'US',
      versionNumber: '1760000000000',
      productAttributes: {
        title: 'Mug',
        description: 'Big & blue',
        link: 'https://shop.example.com/products/mug',
        imageLink: 'https://cdn.example.com/mug.jpg',
        additionalImageLinks: ['https://cdn.example.com/mug-2.jpg'],
        availability: 'IN_STOCK',
        price: { amountMicros: '12500000', currencyCode: 'USD' },
        condition: 'NEW',
      },
    });
  });

  it('turns each live variant into an offer of one item group', () => {
    const { offers } = buildOffers(SHIRT, [MARKET], OPTS);
    expect(offers.map((o) => o.inputId)).toEqual(['en~US~v1', 'en~US~v2']);
    expect(offers[0].input.productAttributes).toMatchObject({
      title: 'T-Shirt — Red / M',
      itemGroupId: 'p2',
      imageLink: 'https://cdn.example.com/red.jpg',
      price: { amountMicros: '22000000', currencyCode: 'USD' },
      availability: 'IN_STOCK',
    });
    expect(offers[1].input.productAttributes).toMatchObject({
      imageLink: 'https://cdn.example.com/shirt.jpg',
      price: { amountMicros: '20000000', currencyCode: 'USD' },
      availability: 'OUT_OF_STOCK',
    });
  });

  it('is in stock when the product does not track stock', () => {
    const { offers } = buildOffers({ ...MUG, stock_tracking: false, stock_level: 0 }, [MARKET], OPTS);
    expect(offers[0].input.productAttributes.availability).toBe('IN_STOCK');
  });

  it('maps the Google fields and per-variant identifiers', () => {
    const product: SwellProduct = {
      ...SHIRT,
      $app: {
        [APP]: {
          brand: ' Acme ',
          mpn: 'TS-1',
          condition: 'refurbished',
          google_category: '1604',
          age_group: 'adult',
          gender: 'unisex',
          identifiers: { v1: { gtin: '4006381333931', mpn: 'TS-RED-M' }, product: { gtin: '0012345678905' } },
        },
      },
    };
    const [red, blue] = buildOffers(product, [MARKET], OPTS).offers;
    expect(red.input.productAttributes).toMatchObject({
      brand: 'Acme',
      mpn: 'TS-RED-M',
      gtins: ['4006381333931'],
      condition: 'REFURBISHED',
      googleProductCategory: '1604',
      ageGroup: 'ADULT',
      gender: 'UNISEX',
    });
    expect(blue.input.productAttributes).toMatchObject({ mpn: 'TS-1', gtins: ['0012345678905'] });
  });

  it('declares missing identifiers only when the merchant says so', () => {
    const [offer] = buildOffers({ ...MUG, $app: { [APP]: { identifier_exists: false } } }, [MARKET], OPTS).offers;
    expect(offer.input.productAttributes.identifierExists).toBe(false);
    expect(buildOffers(MUG, [MARKET], OPTS).offers[0].input.productAttributes.identifierExists).toBeUndefined();
  });

  it('uses the default brand and condition', () => {
    const [offer] = buildOffers(MUG, [MARKET], { ...OPTS, defaults: { brand: 'Test store', condition: 'used' } }).offers;
    expect(offer.input.productAttributes).toMatchObject({ brand: 'Test store', condition: 'USED' });
  });

  it('fills every placeholder of the link template', () => {
    const market = { ...MARKET, link_template: 'https://shop.example.com/{locale}/p/{product_id}?v={variant_id}&c={currency}&s={slug}' };
    const [offer] = buildOffers(SHIRT, [market], OPTS).offers;
    expect(offer.input.productAttributes.link).toBe('https://shop.example.com/en/p/p2?v=v1&c=USD&s=t-shirt');
  });

  it('adds a sale price while the product is on sale', () => {
    const [offer] = buildOffers({ ...MUG, sale: true, sale_price: 10 }, [MARKET], OPTS).offers;
    expect(offer.input.productAttributes.salePrice).toEqual({ amountMicros: '10000000', currencyCode: 'USD' });
  });

  it.each([
    [{ ...MUG, active: false }, 'inactive'],
    [{ ...MUG, $app: { [APP]: { excluded: true } } }, 'excluded'],
    [{ ...MUG, purchase_options: { standard: { active: false, price: 10 } } }, 'subscription_only'],
    [{ ...MUG, type: 'giftcard' }, 'not_physical'],
    [{ ...MUG, price: 0 }, 'no_price'],
    [{ ...MUG, images: [] }, 'no_image'],
    [{ ...SHIRT, variants: { results: [{ id: 'v9', active: false }] } }, 'inactive'],
  ] as [SwellProduct, string][])('skips %# with reason %s', (product, reason) => {
    expect(buildOffers(product, [MARKET], OPTS)).toEqual({ offers: [], skipped: reason });
  });

  it('cuts long titles and descriptions to Google’s limits', () => {
    const [offer] = buildOffers({ ...MUG, name: 'x'.repeat(300), description: 'y'.repeat(6000) }, [MARKET], OPTS).offers;
    expect(offer.input.productAttributes.title).toHaveLength(150);
    expect(offer.input.productAttributes.description).toHaveLength(5000);
  });
});

describe('input ids', () => {
  it('splits an input id and finds its market', () => {
    expect(parseInputId('en~US~v1')).toEqual({ contentLanguage: 'en', feedLabel: 'US', offerId: 'v1' });
    expect(marketOfInput([MARKET], 'en~US~v1')).toBe(MARKET);
    expect(marketOfInput([MARKET], 'de~DE~v1')).toBeUndefined();
  });
});
