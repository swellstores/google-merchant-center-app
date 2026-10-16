import { AppError, type AppContext } from '../context';
import { marketsRead, type Market } from '../connection/markets';
import { connectionRead, connectionWrite, type Connection } from '../connection/store';
import { accessTokenFor } from '../connection/token';
import { MAX_BATCH_PARTS, sendBatch, type BatchResult } from '../google/batch';
import { classifyGoogleError, errorMessage, GoogleApiError } from '../google/http';
import { getProduct } from '../google/merchant';
import { marketOfInput, parseInputId } from '../mapping/offers';
import type { GoogleFields, SwellProduct, SwellVariant } from '../mapping/types';
import { groupIssues, offerStatus, type GoogleProductStatus, type OfferAnswer, type StatusIssue } from '../status/product-status';
import { queueChange } from '../sync/queue';
import { listOf, recordOf, swellBatch, type BatchOp } from '../swell-batch';
import { iso } from '../time';

export interface OfferView {
  input_id: string;
  market: string;
  variant: string | null;
  status: 'approved' | 'partial' | 'pending' | 'disapproved';
  issues: StatusIssue[];
  expires: string | null;
}

export interface ProductStatusView {
  connected: boolean;
  stored: Pick<GoogleFields, 'status' | 'status_label' | 'status_issues' | 'date_status' | 'sync_state' | 'sync_reason' | 'sync_error' | 'date_synced'>;
  live: { offers: OfferView[]; more: number; checked_at: string } | null;
  live_error: string | null;
}

export interface PreviewContext {
  app_id: string;
  markets: { country: string; language: string; currency: string; link_template: string }[];
  defaults: { condition: 'new' };
}

export const MAX_ANSWER_BYTES = 70_000;

const PRODUCT_ID = /^[0-9a-f]{24}$/;

export function productIdOf(value: unknown): string {
  if (typeof value !== 'string' || !PRODUCT_ID.test(value)) throw new AppError('invalid_product', 'The product id is missing or invalid');
  return value;
}

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

function variantNames(product: SwellProduct): Map<string, string> {
  const list: SwellVariant[] = Array.isArray(product.variants) ? product.variants : (product.variants?.results ?? []);
  return new Map(list.filter((v) => v.name).map((v) => [v.id, v.name!]));
}

function storedOf(fields: GoogleFields): ProductStatusView['stored'] {
  const { status, status_label, status_issues, date_status, sync_state, sync_reason, sync_error, date_synced } = fields;
  return { status, status_label, status_issues, date_status, sync_state, sync_reason, sync_error, date_synced };
}

function answerOf(inputId: string, result: BatchResult | undefined): OfferAnswer {
  if (!result) throw new GoogleApiError('server', 0, 'Google left a status unanswered');
  if (result.status >= 200 && result.status < 300) {
    return { inputId, found: true, status: (result.body as { productStatus?: GoogleProductStatus } | null)?.productStatus };
  }
  const kind = classifyGoogleError(result.status, result.body);
  if (kind === 'not_found') return { inputId, found: false };
  throw new GoogleApiError(kind, result.status, errorMessage(result.body, result.status), result.body);
}

function offerView(answer: OfferAnswer, markets: Market[], names: Map<string, string>): OfferView {
  const { contentLanguage, feedLabel, offerId } = parseInputId(answer.inputId);
  const market = marketOfInput(markets, answer.inputId);
  return {
    input_id: answer.inputId,
    market: `${market?.country ?? feedLabel} ${market?.language ?? contentLanguage}`,
    variant: names.get(offerId) ?? null,
    status: offerStatus(answer),
    issues: groupIssues([answer]),
    expires: (answer.found && answer.status?.googleExpirationDate) || null,
  };
}

/** The issues' details go first, then the offers that do not fit; the cut ones are counted in `more`. */
function fitted(view: ProductStatusView): ProductStatusView {
  if (!view.live || bytesOf(view) <= MAX_ANSWER_BYTES) return view;
  const offers = view.live.offers.map((o) => ({ ...o, issues: o.issues.map(({ detail: _detail, ...issue }) => issue) }));
  const lean = { ...view, live: { ...view.live, offers } };
  if (bytesOf(lean) <= MAX_ANSWER_BYTES) return lean;
  let room = MAX_ANSWER_BYTES - bytesOf({ ...lean, live: { ...lean.live, offers: [] } });
  const kept: OfferView[] = [];
  for (const offer of offers) {
    room -= bytesOf(offer) + 1;
    if (room < 0) break;
    kept.push(offer);
  }
  return { ...lean, live: { ...lean.live, offers: kept, more: lean.live.more + offers.length - kept.length } };
}

async function liveOffers(ctx: AppContext, connection: Connection, markets: Market[], product: SwellProduct, inputIds: string[]) {
  let patch: Partial<Connection> | null = null;
  const token = await accessTokenFor(ctx, connection, (p) => (patch = p));
  const asked = inputIds.slice(0, MAX_BATCH_PARTS);
  const parts = asked.map((inputId, i) => ({ id: String(i), call: getProduct(connection.merchant_id!, inputId) }));
  const [results] = await Promise.all([
    sendBatch(ctx.fetch, token, parts),
    patch ? swellBatch(ctx.swell, [connectionWrite(connection.id, patch)]) : null,
  ]);
  const names = variantNames(product);
  const offers = asked.map((inputId, i) => offerView(answerOf(inputId, results.find((r) => r.id === String(i))), markets, names));
  return { offers, more: inputIds.length - asked.length, checked_at: iso(ctx.now()) };
}

/**
 * One batch read, at most one token write, one Google batch. A Google failure
 * is part of the answer: the stored status still shows.
 */
export async function productStatusView(ctx: AppContext, productId: string, live: boolean): Promise<ProductStatusView> {
  const reads: BatchOp[] = [connectionRead, marketsRead, { method: 'get', url: `/products/${productId}`, data: { expand: ['variants:1000'] } }];
  const answers = await swellBatch(ctx.swell, reads);
  const connection = listOf<Connection>(answers[0], 'the connection')[0] ?? null;
  const markets = listOf<Market>(answers[1], 'the markets');
  const product = recordOf<SwellProduct>(answers[2], 'the product');
  if (!product) throw new AppError('product_not_found', 'The product does not exist', 404);

  const fields = product.$app?.[ctx.appId] ?? {};
  const connected = connection?.status === 'connected';
  const view: ProductStatusView = { connected, stored: storedOf(fields), live: null, live_error: null };
  const inputIds = fields.input_ids ?? [];
  if (!live || !connected || !inputIds.length) return view;

  try {
    view.live = await liveOffers(ctx, connection!, markets, product, inputIds);
  } catch (error) {
    if (!(error instanceof GoogleApiError || error instanceof AppError)) throw error;
    view.live_error = error.message;
  }
  return fitted(view);
}

export async function previewContext(ctx: AppContext): Promise<PreviewContext> {
  const markets = listOf<Market>((await swellBatch(ctx.swell, [marketsRead]))[0], 'the markets');
  return {
    app_id: ctx.appId,
    markets: markets.map(({ country, language, currency, link_template }) => ({ country, language, currency, link_template })),
    defaults: { condition: 'new' },
  };
}

export async function resendProduct(ctx: AppContext, productId: string): Promise<{ queued: true }> {
  await queueChange(ctx, { productId, kind: 'full' });
  return { queued: true };
}
