import { MAX_BATCH_PARTS, sendBatch, type BatchResult } from '../google/batch';
import { classifyGoogleError, errorMessage, GoogleApiError } from '../google/http';
import { getProduct } from '../google/merchant';
import type { GoogleFields, SwellProduct } from '../mapping/types';
import { listOf, SWELL_WAVE, type BatchOp } from '../swell-batch';
import type { DeliveryEnv } from '../sync/deliver';
import type { PassResult } from '../sync/full-sync';
import { enqueueWrite } from '../sync/queue';
import { iso } from '../time';
import {
  earliestExpiry,
  partlyRefused,
  productStatus,
  SEVERITY_ORDER,
  statusFields,
  type GoogleProductStatus,
  type OfferAnswer,
  type StatusIssue,
} from './product-status';

export interface StatusCounters {
  approved: number;
  partial: number;
  pending: number;
  disapproved: number;
  not_sent: number;
  excluded: number;
}

export interface IssueTally {
  code: string;
  severity: StatusIssue['severity'];
  description: string;
  documentation?: string;
  products: number;
  /** The first products found with the issue */
  samples: { id: string; name: string }[];
}

export interface StatusRefreshJob {
  status: 'running' | 'done';
  cursor: string | null;
  checked: number;
  /** Products queued to be sent again */
  requeued: number;
  counters: StatusCounters;
  issues: IssueTally[];
  date_started: string;
  /** When the first pass came: the refresh's length counts from here, not from its wait behind other work */
  date_first_pass?: string | null;
  date_finished?: string | null;
  duration_ms?: number | null;
}

export interface StatusSummary {
  counters: StatusCounters;
  top_issues: IssueTally[];
  date_refreshed: string;
}

export const STATUS_PAGE = 50;
/** Writes per pass at most: with the caller's reads they fit one server wave of `/:batch`. */
export const STATUS_WRITES = 8;
/** An offer Google drops sooner than this is sent again. */
export const EXPIRY_MARGIN_MS = 7 * 86_400_000;
/** A product Google holds none of is sent again this long after it was sent: Google may not have processed it yet. */
export const MISSING_RESEND_MS = 86_400_000;
export const MAX_TALLIES = 30;
export const TOP_ISSUES = 5;
export const MAX_SAMPLES = 3;

export function newStatusRefreshJob(now: number): StatusRefreshJob {
  return {
    status: 'running',
    cursor: null,
    checked: 0,
    requeued: 0,
    counters: { approved: 0, partial: 0, pending: 0, disapproved: 0, not_sent: 0, excluded: 0 },
    issues: [],
    date_started: iso(now),
    date_first_pass: null,
    date_finished: null,
    duration_ms: null,
  };
}

/**
 * The next page of products, whole: a `fields` mask can drop `$app`, whose
 * keys depend on the credentials, and every product would look unsent.
 */
export const statusPageRead = (job: StatusRefreshJob): BatchOp => ({
  method: 'get',
  url: '/products',
  data: { ...(job.cursor ? { where: { id: { $gt: job.cursor } } } : {}), sort: 'id asc', limit: STATUS_PAGE },
});

/** The worst issues first, then the most common. */
export function summaryOf(job: StatusRefreshJob): StatusSummary {
  const top_issues = [...job.issues]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.products - a.products)
    .slice(0, TOP_ISSUES);
  return { counters: job.counters, top_issues, date_refreshed: job.date_finished ?? job.date_started };
}

interface Entry {
  product: SwellProduct;
  fields: GoogleFields;
  /** The offers checked: a product never takes more than a batch */
  inputIds: string[];
}

const partId = (entry: Entry, i: number) => `${entry.product.id}-${i}`;

/** An offer's answer, or the error that stops the walk before its product. */
function offerAnswer(inputId: string, result: BatchResult | undefined): OfferAnswer | GoogleApiError {
  if (!result) return new GoogleApiError('server', 0, 'Google left a status unanswered');
  if (result.status >= 200 && result.status < 300) {
    return { inputId, found: true, status: (result.body as { productStatus?: GoogleProductStatus } | null)?.productStatus };
  }
  const kind = classifyGoogleError(result.status, result.body);
  if (kind === 'auth' || kind === 'daily_quota' || kind === 'rate' || kind === 'server') {
    return new GoogleApiError(kind, result.status, errorMessage(result.body, result.status), result.body);
  }
  // A 404, or any other refusal of a single offer: Google does not hold it.
  return { inputId, found: false };
}

/** Sent less than `MISSING_RESEND_MS` ago: Google may not have processed it yet. */
const justSent = (fields: GoogleFields, now: number) => Date.parse(fields.date_synced ?? '') > now - MISSING_RESEND_MS;

function resendDue(offers: OfferAnswer[], fields: GoogleFields, now: number): boolean {
  const expiry = earliestExpiry(offers);
  if (expiry !== null && expiry < now + EXPIRY_MARGIN_MS) return true;
  return offers.every((offer) => !offer.found) && !justSent(fields, now);
}

function tally(tallies: IssueTally[], product: SwellProduct, issues: StatusIssue[]): void {
  for (const issue of issues) {
    let entry = tallies.find((t) => t.code === issue.code);
    if (!entry) {
      if (tallies.length >= MAX_TALLIES) continue;
      entry = { code: issue.code, severity: issue.severity, description: issue.description, products: 0, samples: [] };
      if (issue.documentation) entry.documentation = issue.documentation;
      tallies.push(entry);
    }
    if (SEVERITY_ORDER[issue.severity] < SEVERITY_ORDER[entry.severity]) entry.severity = issue.severity;
    entry.products++;
    if (entry.samples.length < MAX_SAMPLES) entry.samples.push({ id: product.id, name: product.name ?? product.id });
  }
}

/**
 * One page of the status refresh, a cursor over product ids that the courier
 * advances (`newStatusRefreshJob` starts one). Every offer of a product goes
 * into one Google batch, so its status is whole; a product is written only
 * when its status changed. The cursor stops before the first product that did
 * not fit the batch or the round trip's writes, or whose answer was a rate
 * limit or a server error: it comes first in the next pass.
 *
 * `page` is the answer to `statusPageRead(job)` when the caller has it;
 * otherwise the page is read with the writes that wait. One round trip after
 * Google's answer sends the writes with the caller's `reads`.
 */
export async function statusRefreshPass(
  env: DeliveryEnv,
  job: StatusRefreshJob,
  reads: BatchOp[] = [],
  page?: unknown,
): Promise<PassResult<StatusRefreshJob>> {
  if (reads.length >= SWELL_WAVE) throw new Error('A pass needs room for its writes in one round trip');
  const started = env.ctx.now();
  // Reading the page sends the waiting writes; a page in hand leaves them to share the round trip.
  if (SWELL_WAVE - reads.length - (page === undefined ? 0 : env.outbox.size) <= 0) return { job, sentOps: 0, progressed: false, answers: [] };
  const answer = page === undefined ? (await env.outbox.send([statusPageRead(job)]))[0] : page;
  const products = listOf<SwellProduct>(answer, 'the products to check');
  const appId = env.ctx.appId;

  const entries: Entry[] = [];
  let parts = 0;
  for (const product of products) {
    const fields: GoogleFields = product.$app?.[appId] ?? {};
    const inputIds = (fields.input_ids ?? []).slice(0, MAX_BATCH_PARTS);
    if (parts + inputIds.length > MAX_BATCH_PARTS) break;
    parts += inputIds.length;
    entries.push({ product, fields, inputIds });
  }

  const results = new Map<string, BatchResult>();
  if (parts) {
    // A batch is worth sending with time for its answer to be written and the run to end.
    if (!env.budget.allows(2)) return { job, sentOps: 0, progressed: false, answers: [] };
    const batch = entries.flatMap((entry) =>
      entry.inputIds.map((inputId, i) => ({ id: partId(entry, i), call: getProduct(env.accountId, inputId) })),
    );
    try {
      for (const result of await sendBatch(env.ctx.fetch, env.token, batch)) results.set(result.id, result);
    } catch (error) {
      if (!(error instanceof GoogleApiError)) throw error;
      return { job, sentOps: 0, failure: error, progressed: false, answers: [] };
    }
  }

  const checks = entries.map((entry) => entry.inputIds.map((inputId, i) => offerAnswer(inputId, results.get(partId(entry, i)))));
  const errors = checks.flat().filter((check): check is GoogleApiError => check instanceof GoogleApiError);
  const failure = errors.find((error) => error.kind === 'auth' || error.kind === 'daily_quota') ?? errors[0];

  const now = env.ctx.now();
  const next = structuredClone(job);
  next.date_first_pass ??= iso(started);
  const writes: BatchOp[] = [];
  // The round trip stays in one server wave with the writes that wait and the caller's reads.
  const cap = Math.min(STATUS_WRITES, SWELL_WAVE - reads.length - env.outbox.size);
  let counted = 0;
  for (const [i, { product, fields, inputIds }] of entries.entries()) {
    if (!inputIds.length) {
      if (fields.status) {
        next.counters[fields.status]++;
        tally(next.issues, product, fields.status_issues ?? []);
      }
    } else {
      if (checks[i].some((check) => check instanceof GoogleApiError)) break;
      const offers = checks[i] as OfferAnswer[];
      // An offer just sent that Google does not hold yet is plain pending: no issue, no write.
      const inGoogle = productStatus(offers, { missing: !justSent(fields, now) });
      const status = fields.sync_state === 'error' && fields.sync_error ? partlyRefused(inGoogle, fields.sync_error) : inGoogle;
      const resend = resendDue(offers, fields, now);
      const ops: BatchOp[] = [];
      if (status.hash !== fields.status_hash) {
        ops.push({ method: 'put', url: `/products/${product.id}`, data: { $app: { [appId]: statusFields(status, now) } } });
      }
      if (resend) ops.push(enqueueWrite(undefined, { productId: product.id, kind: 'full' }));
      if (writes.length + ops.length > cap) break;
      writes.push(...ops);
      next.counters[status.status]++;
      if (resend) next.requeued++;
      tally(next.issues, product, status.issues);
    }
    next.checked++;
    next.cursor = product.id;
    counted++;
  }

  if (products.length < STATUS_PAGE && counted === products.length) {
    next.status = 'done';
    next.date_finished = iso(now);
    next.duration_ms = now - Date.parse(next.date_first_pass);
  }
  env.outbox.add(...writes);
  const answers = await env.outbox.send(reads);
  return { job: next, sentOps: results.size, failure, progressed: next.cursor !== job.cursor || next.status === 'done', answers };
}
