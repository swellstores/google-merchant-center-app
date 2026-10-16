import { buildOffers } from '../../functions/lib/mapping/offers';
import type { SwellProduct, SwellVariant } from '../../functions/lib/mapping/types';
import { marketHeading } from './status-view';
import { skippedStatus } from '../../functions/lib/status/product-status';

/** Mirrors `PreviewContext` in functions/lib/admin/product-status.ts. */
export interface PreviewContext {
  app_id: string;
  markets: { country: string; language: string; currency: string; link_template: string }[];
  defaults: { condition: 'new' };
}

export interface PreviewCard {
  market: string;
  heading: string;
  offerId: string;
  variant: string | null;
  title: string;
  price: string;
  salePrice: string | null;
  availability: 'In stock' | 'Out of stock';
  image: string | null;
  host: string;
  link: string;
}

export type PreviewModel = { cards: PreviewCard[] } | { skipped: string };

function variantNames(record: SwellProduct): Map<string, string> {
  const list: SwellVariant[] = Array.isArray(record.variants) ? record.variants : (record.variants?.results ?? []);
  return new Map(list.filter((v) => v.name).map((v) => [v.id, v.name!]));
}

function hostOf(link: string): string {
  try {
    return new URL(link).hostname;
  } catch {
    return '';
  }
}

function formatted(price: { amountMicros: string; currencyCode: string }): string {
  const value = Number(price.amountMicros) / 1_000_000;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: price.currencyCode }).format(value);
  } catch {
    return `${value.toFixed(2)} ${price.currencyCode}`;
  }
}

export function previewModel(record: SwellProduct, context: PreviewContext): PreviewModel {
  if (!context.markets.length) return { cards: [] };
  const markets = context.markets.map((m) => ({ ...m, id: '', data_source: 'preview' }));
  const { offers, skipped } = buildOffers(record, markets, { appId: context.app_id, defaults: context.defaults, version: '0' });
  if (skipped) {
    const { status, label } = skippedStatus(skipped);
    return { skipped: status === 'excluded' ? label : `${label}. This product will not appear in Google Shopping.` };
  }
  const names = variantNames(record);
  return {
    cards: offers.map(({ market, input }) => {
      const a = input.productAttributes;
      return {
        market: `${market.country} ${market.language}`,
        heading: marketHeading(`${market.country} ${market.language}`),
        offerId: input.offerId,
        variant: names.get(input.offerId) ?? null,
        title: a.title ?? '',
        price: formatted(a.price!),
        salePrice: a.salePrice ? formatted(a.salePrice) : null,
        availability: a.availability === 'OUT_OF_STOCK' ? 'Out of stock' : 'In stock',
        image: a.imageLink ?? null,
        host: hostOf(a.link ?? ''),
        link: a.link ?? '',
      };
    }),
  };
}

/** The merchant's pick by offer id; the first offer when it is gone. */
export function pickedCard(cards: PreviewCard[], offerId: string | undefined): PreviewCard {
  return cards.find((c) => c.offerId === offerId) ?? cards[0];
}

export type ImageState = 'image' | 'failed' | 'missing';

export function imageState(url: string | null, failed: ReadonlySet<string>): ImageState {
  if (!url) return 'missing';
  return failed.has(url) ? 'failed' : 'image';
}
