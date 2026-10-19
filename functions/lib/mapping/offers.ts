import type { Market } from '../connection/markets';
import { productInputId, type InputKey, type ProductAttributes, type ProductInput } from '../google/merchant';
import { money, unitPrices } from './price';
import { stripHtml, truncate } from './text';
import type { GoogleFields, SwellImage, SwellProduct, SwellVariant } from './types';

export interface OfferDefaults {
  brand?: string;
  condition: 'new' | 'used' | 'refurbished';
}

export type SkipReason = 'inactive' | 'excluded' | 'subscription_only' | 'not_physical' | 'no_price' | 'no_image';

export interface Offer {
  inputId: string;
  market: Market;
  input: ProductInput;
}

interface BuildOptions {
  appId: string;
  defaults: OfferDefaults;
  version: string;
}

const MAX_TITLE = 150;
const MAX_DESCRIPTION = 5000;
const MAX_ADDITIONAL_IMAGES = 10;

function variantList(product: SwellProduct): SwellVariant[] {
  const variants = product.variants;
  if (!variants) return [];
  return Array.isArray(variants) ? variants : (variants.results ?? []);
}

function productSkip(product: SwellProduct, fields: GoogleFields): SkipReason | null {
  if (!product.active) return 'inactive';
  if (fields.excluded) return 'excluded';
  if (product.type === 'giftcard' || product.delivery === 'giftcard') return 'not_physical';
  if (product.purchase_options?.standard?.active === false) return 'subscription_only';
  return null;
}

/** A product with variants sells its live variants; one without sells itself (`undefined`). */
function sellableUnits(product: SwellProduct): (SwellVariant | undefined)[] {
  const all = variantList(product);
  if (!all.length) return [undefined];
  return all.filter((v) => v.active !== false && !v.archived);
}

function urlsOf(images: SwellImage[] | undefined): string[] {
  return (images ?? []).map((image) => image.file?.url).filter((url): url is string => Boolean(url));
}

function imageUrls(product: SwellProduct, variant?: SwellVariant): string[] {
  const own = urlsOf(variant?.images);
  return own.length ? own : urlsOf(product.images);
}

function buildLink(template: string, values: Record<string, string>): string {
  return template.replace(/\{(slug|product_id|variant_id|locale|currency)\}/g, (_, name: string) => encodeURIComponent(values[name] ?? ''));
}

/** A line pasted from Google's list with ids, `1604 - Apparel & Accessories > Clothing`, sends just the id. */
function categoryOf(text: string | undefined): string | undefined {
  const category = text?.trim();
  if (!category) return undefined;
  return category.match(/^\s*(\d+)\s+-\s/)?.[1] ?? category;
}

function buildInput(
  product: SwellProduct,
  variant: SwellVariant | undefined,
  market: Market,
  fields: GoogleFields,
  opts: BuildOptions,
): ProductInput | SkipReason {
  const { price, sale } = unitPrices(product, variant);
  if (!(price > 0)) return 'no_price';
  const images = imageUrls(product, variant);
  if (!images.length) return 'no_image';

  const name = product.name?.trim() || product.id;
  // The barcodes table: a GTIN per variant, or under `product` for a product without variants
  const cells = fields.identifiers?.[variant?.id ?? 'product'];
  const gtin = cells?.gtin?.trim();
  // A variant's own MPN overrides the product's MPN
  const mpn = (variant ? cells?.mpn?.trim() : undefined) || fields.mpn?.trim() || undefined;
  const noIdentifiers = fields.no_identifiers === true;
  const tracked = Boolean(product.stock_tracking);
  const level = (variant ? variant.stock_level : product.stock_level) ?? 0;

  const attributes: ProductAttributes = {
    title: truncate(variant?.name ? `${name} — ${variant.name}` : name, MAX_TITLE),
    description: truncate(stripHtml(product.description ?? ''), MAX_DESCRIPTION) || undefined,
    link: buildLink(market.link_template, {
      slug: product.slug ?? product.id,
      product_id: product.id,
      variant_id: variant?.id ?? '',
      locale: market.language,
      currency: market.currency,
    }),
    imageLink: images[0],
    additionalImageLinks: images.length > 1 ? images.slice(1, 1 + MAX_ADDITIONAL_IMAGES) : undefined,
    availability: !tracked || level > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK',
    price: money(price, market.currency),
    salePrice: sale !== null ? money(sale, market.currency) : undefined,
    condition: (fields.condition ?? opts.defaults.condition).toUpperCase() as ProductAttributes['condition'],
    brand: fields.brand?.trim() || opts.defaults.brand || undefined,
    mpn: noIdentifiers ? undefined : mpn,
    gtins: gtin && !noIdentifiers ? [gtin] : undefined,
    identifierExists: noIdentifiers ? false : undefined,
    googleProductCategory: categoryOf(fields.google_category),
    itemGroupId: variant ? product.id : undefined,
    ageGroup: fields.age_group ? fields.age_group.toUpperCase() : undefined,
    gender: fields.gender ? fields.gender.toUpperCase() : undefined,
  };

  return {
    offerId: variant?.id ?? product.id,
    contentLanguage: market.language,
    feedLabel: market.country,
    versionNumber: opts.version,
    productAttributes: attributes,
  };
}

/**
 * One offer per sellable unit per market. A product that yields none gets the
 * reason, so the courier deletes what it sent before and tells the merchant why.
 */
export function buildOffers(product: SwellProduct, markets: Market[], opts: BuildOptions): { offers: Offer[]; skipped: SkipReason | null } {
  const fields = product.$app?.[opts.appId] ?? {};
  const skip = productSkip(product, fields);
  if (skip) return { offers: [], skipped: skip };

  const units = sellableUnits(product);
  const offers: Offer[] = [];
  let unitSkip: SkipReason | null = null;
  for (const market of markets) {
    for (const variant of units) {
      const built = buildInput(product, variant, market, fields, opts);
      if (typeof built === 'string') {
        unitSkip ??= built;
        continue;
      }
      offers.push({ inputId: productInputId(built), market, input: built });
    }
  }
  return { offers, skipped: offers.length ? null : (unitSkip ?? 'inactive') };
}

export function parseInputId(id: string): InputKey {
  const [contentLanguage, feedLabel, offerId] = id.split('~');
  return { contentLanguage, feedLabel, offerId };
}

export function marketOfInput(markets: Market[], inputId: string): Market | undefined {
  const { contentLanguage, feedLabel } = parseInputId(inputId);
  return markets.find((m) => m.language === contentLanguage && m.country === feedLabel);
}
