import { describe, expect, it } from 'vitest';
import { money, unitPrices } from '../../../functions/lib/mapping/price';

describe('unitPrices', () => {
  it('takes the standard purchase option before the legacy price', () => {
    expect(unitPrices({ id: 'p', price: 99, purchase_options: { standard: { price: 30 } } })).toEqual({ price: 30, sale: null });
    expect(unitPrices({ id: 'p', price: 12 })).toEqual({ price: 12, sale: null });
  });

  it('prefers the variant’s own price', () => {
    const product = { id: 'p', price: 20 };
    expect(unitPrices(product, { id: 'v', price: 22 })).toEqual({ price: 22, sale: null });
    expect(unitPrices(product, { id: 'v', purchase_options: { standard: { price: 25 } } })).toEqual({ price: 25, sale: null });
    expect(unitPrices(product, { id: 'v' })).toEqual({ price: 20, sale: null });
  });

  it('gives a sale price only while on sale and below the regular price', () => {
    expect(unitPrices({ id: 'p', price: 20, sale: true, sale_price: 15 })).toEqual({ price: 20, sale: 15 });
    expect(unitPrices({ id: 'p', price: 20, sale: false, sale_price: 15 })).toEqual({ price: 20, sale: null });
    expect(unitPrices({ id: 'p', price: 20, sale: true, sale_price: 25 })).toEqual({ price: 20, sale: null });
    expect(
      unitPrices({ id: 'p', purchase_options: { standard: { price: 20, sale: true, sale_price: 16 } } }, { id: 'v', sale_price: 14 }),
    ).toEqual({ price: 20, sale: 14 });
  });
});

describe('money', () => {
  it('writes micros as an integer string', () => {
    expect(money(12.5, 'USD')).toEqual({ amountMicros: '12500000', currencyCode: 'USD' });
    expect(money(0.1 + 0.2, 'EUR')).toEqual({ amountMicros: '300000', currencyCode: 'EUR' });
  });
});
