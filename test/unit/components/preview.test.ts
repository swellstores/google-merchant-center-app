import { describe, expect, it } from 'vitest';
import { previewModel, type PreviewContext } from '../../../components/lib/preview';
import type { SwellProduct } from '../../../functions/lib/mapping/types';

const CONTEXT: PreviewContext = {
  app_id: 'google_merchant_center',
  markets: [
    { country: 'US', language: 'en', currency: 'USD', link_template: 'https://shop.example.com/{slug}' },
    { country: 'DE', language: 'de', currency: 'EUR', link_template: 'https://shop.example.de/{locale}/{slug}?v={variant_id}' },
  ],
  defaults: { condition: 'new' },
};

const IMAGE = { file: { url: 'https://cdn.example.com/a.jpg' } };

function product(patch: Partial<SwellProduct> = {}): SwellProduct {
  return { id: 'p1', name: 'Mug', slug: 'mug', active: true, price: 12.5, images: [IMAGE], ...patch };
}

describe('previewModel', () => {
  it('a product without variants gives one card per market', () => {
    const model = previewModel(product(), CONTEXT);
    expect(model).toEqual({
      cards: [
        { market: 'US en', variant: null, title: 'Mug', price: '$12.50', salePrice: null, availability: 'In stock', image: 'https://cdn.example.com/a.jpg', host: 'shop.example.com', link: 'https://shop.example.com/mug' },
        { market: 'DE de', variant: null, title: 'Mug', price: '€12.50', salePrice: null, availability: 'In stock', image: 'https://cdn.example.com/a.jpg', host: 'shop.example.de', link: 'https://shop.example.de/de/mug?v=' },
      ],
    });
  });

  it('no markets gives no cards', () => {
    expect(previewModel(product(), { ...CONTEXT, markets: [] })).toEqual({ cards: [] });
  });

  it('variants without images use the product image', () => {
    const model = previewModel(product({ variants: { results: [{ id: 'v1', name: 'Red' }, { id: 'v2', name: 'Blue', images: [{ file: { url: 'https://cdn.example.com/b.jpg' } }] }] } }), {
      ...CONTEXT,
      markets: [CONTEXT.markets[0]],
    });
    if (!('cards' in model)) throw new Error('expected cards');
    expect(model.cards.map((c) => [c.variant, c.title, c.image])).toEqual([
      ['Red', 'Mug — Red', 'https://cdn.example.com/a.jpg'],
      ['Blue', 'Mug — Blue', 'https://cdn.example.com/b.jpg'],
    ]);
  });

  it('variants given as a plain array work too', () => {
    const model = previewModel(product({ variants: [{ id: 'v1', name: 'Red' }] }), { ...CONTEXT, markets: [CONTEXT.markets[0]] });
    expect(model).toMatchObject({ cards: [{ variant: 'Red' }] });
  });

  it('no price shows the skip reason', () => {
    expect(previewModel(product({ price: null }), CONTEXT)).toEqual({ skipped: 'Not sent: no price' });
  });

  it('an unsaved image without a url shows the skip reason', () => {
    expect(previewModel(product({ images: [{ file: {} }] }), CONTEXT)).toEqual({ skipped: 'Not sent: no image' });
  });

  it('a hidden product shows the hidden wording', () => {
    expect(previewModel(product({ $app: { google_merchant_center: { excluded: true } } }), CONTEXT)).toEqual({ skipped: 'Hidden from Google' });
  });

  it('a sale shows both prices', () => {
    const model = previewModel(product({ sale: true, sale_price: 9 }), { ...CONTEXT, markets: [CONTEXT.markets[0]] });
    expect(model).toMatchObject({ cards: [{ price: '$12.50', salePrice: '$9.00' }] });
  });

  it('an out-of-stock product says so', () => {
    const model = previewModel(product({ stock_tracking: true, stock_level: 0 }), { ...CONTEXT, markets: [CONTEXT.markets[0]] });
    expect(model).toMatchObject({ cards: [{ availability: 'Out of stock' }] });
  });

  it('the card follows the record it is given', () => {
    const one = { ...CONTEXT, markets: [CONTEXT.markets[0]] };
    expect(previewModel(product({ name: 'Mug' }), one)).toMatchObject({ cards: [{ title: 'Mug' }] });
    expect(previewModel(product({ name: 'Cup', price: 20 }), one)).toMatchObject({ cards: [{ title: 'Cup', price: '$20.00' }] });
  });
});
