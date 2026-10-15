import type { Price } from '../google/merchant';
import type { SwellProduct, SwellVariant } from './types';

const amount = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The regular price: the variant's standard purchase option, the variant's
 * legacy price, then the product's standard option and legacy price. The sale
 * price counts only while the sale is on and it is below the regular price.
 */
export function unitPrices(product: SwellProduct, variant?: SwellVariant): { price: number; sale: number | null } {
  const standard = product.purchase_options?.standard;
  const variantStandard = variant?.purchase_options?.standard;
  const price =
    amount(variantStandard?.price) ?? amount(variant?.price) ?? amount(standard?.price) ?? amount(product.price) ?? 0;
  const onSale = (variantStandard?.sale ?? standard?.sale ?? product.sale) === true;
  const salePrice =
    amount(variantStandard?.sale_price) ??
    amount(variant?.sale_price) ??
    amount(standard?.sale_price) ??
    amount(product.sale_price);
  return { price, sale: onSale && salePrice !== null && salePrice < price ? salePrice : null };
}

export const money = (value: number, currency: string): Price => ({
  amountMicros: String(Math.round(value * 1_000_000)),
  currencyCode: currency,
});
