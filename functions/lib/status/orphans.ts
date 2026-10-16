import { GoogleApiError, googleCall, type GoogleErrorKind } from '../google/http';
import { listProducts, productInputId } from '../google/merchant';
import type { GoogleFields, SwellProduct } from '../mapping/types';
import { listOf, SWELL_WAVE, type BatchOp } from '../swell-batch';
import type { DeliveryEnv } from '../sync/deliver';
import type { PassResult } from '../sync/full-sync';
import { enqueueWrite, type QueuePlan } from '../sync/queue';
import { iso } from '../time';

export interface OrphanScanJob {
  status: 'running' | 'done';
  /** The Google page being read: null is the first */
  page_token: string | null;
  /** Offers of that page handled already */
  skip: number;
  /** Offers queued as orphans */
  found: number;
  date_started: string;
  date_finished?: string | null;
}

export const ORPHAN_PAGE = 250;
/** Products read per pass at most: they are read whole, and a page can name 250. */
export const ORPHAN_PRODUCTS = 50;
/** Writes per pass at most: with the caller's reads they fit one server wave of `/:batch`. */
export const ORPHAN_WRITES = 8;

interface ListedProduct {
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
  dataSource: string;
  productAttributes?: { itemGroupId?: string };
}

interface Group {
  productId: string;
  inputIds: string[];
  /** Where the product's first offer sits among the offers still to handle */
  first: number;
}

export function newOrphanScanJob(now: number): OrphanScanJob {
  return { status: 'running', page_token: null, skip: 0, found: 0, date_started: iso(now), date_finished: null };
}

/** How Google refuses a page token from another account, or one that expired while the scan waited. */
const REFUSALS: GoogleErrorKind[] = ['data', 'not_found', 'conflict'];

/** A refused page starts the scan over; a refused first page ends it, since starting over would meet the same answer. */
function afterRefusal(env: DeliveryEnv, job: OrphanScanJob, error: GoogleApiError): PassResult<OrphanScanJob> {
  if (job.page_token) return { job: { ...job, page_token: null, skip: 0 }, sentOps: 0, progressed: true, answers: [] };
  console.warn(`Orphan scan: Google refused the first page of products, the scan ends: ${error.message}`);
  return { job: { ...job, status: 'done', date_finished: iso(env.ctx.now()) }, sentOps: 0, progressed: true, answers: [] };
}

/** The products whole: a `fields` mask can drop `$app`, whose keys depend on the credentials. */
const productsRead = (ids: string[]): BatchOp => ({ method: 'get', url: '/products', data: { where: { id: { $in: ids } }, limit: ids.length } });

/**
 * One Google page of the orphan scan: offers of the markets' data sources
 * whose product is gone from Swell, or no longer lists them, are queued so the
 * courier deletes them. A pass reads at most `ORPHAN_PRODUCTS` products and
 * queues at most `ORPHAN_WRITES`; the job keeps its page token and counts the
 * offers done in `skip`, so the next pass lists the same page again.
 *
 * Google sorts offers by name, so the offers of one product can be apart; one
 * of them past the stop is handled again by the next pass.
 */
export async function orphanScanPass(env: DeliveryEnv, job: OrphanScanJob, reads: BatchOp[] = []): Promise<PassResult<OrphanScanJob>> {
  if (reads.length >= SWELL_WAVE) throw new Error('A pass needs room for its writes in one round trip');
  const unchanged = { job, sentOps: 0, progressed: false, answers: [] };
  // A page is worth reading with time for its answers to be written and the run to end.
  if (!env.budget.allows(2)) return unchanged;

  let page: { products?: ListedProduct[]; nextPageToken?: string };
  try {
    page = await googleCall(env.ctx.fetch, env.token, listProducts(env.accountId, ORPHAN_PAGE, job.page_token));
  } catch (error) {
    if (!(error instanceof GoogleApiError)) throw error;
    if (REFUSALS.includes(error.kind)) return afterRefusal(env, job, error);
    return { ...unchanged, failure: error };
  }

  const sources = new Set(env.markets.map((market) => market.data_source));
  const offers = (page.products ?? []).slice(job.skip).map((listed, index) => ({ listed, index }));
  const groups = new Map<string, Group>();
  /** Where the first product past `ORPHAN_PRODUCTS` begins: the pass stops there */
  let unread: number | null = null;
  for (const { listed, index } of offers) {
    if (!sources.has(listed.dataSource)) continue;
    const productId = listed.productAttributes?.itemGroupId ?? listed.offerId;
    let group = groups.get(productId);
    if (!group) {
      if (groups.size >= ORPHAN_PRODUCTS) {
        unread = index;
        break;
      }
      group = { productId, inputIds: [], first: index };
      groups.set(productId, group);
    }
    group.inputIds.push(productInputId(listed));
  }

  const appId = env.ctx.appId;
  const found = new Map<string, SwellProduct>();
  if (groups.size) {
    const answer = (await env.outbox.send([productsRead([...groups.keys()])]))[0];
    for (const product of listOf<SwellProduct>(answer, 'the products listed in Google')) found.set(product.id, product);
    // The writes and the run's end still need their round trips; Google is done.
    if (!env.budget.allows(2, 0)) return unchanged;
  }

  const next = structuredClone(job);
  const writes: BatchOp[] = [];
  const cap = Math.min(ORPHAN_WRITES, SWELL_WAVE - reads.length - env.outbox.size);
  let stoppedAt: number | null = null;
  for (const group of groups.values()) {
    const product = found.get(group.productId);
    const known = new Set(((product?.$app?.[appId] as GoogleFields | undefined)?.input_ids) ?? []);
    const orphans = product ? group.inputIds.filter((inputId) => !known.has(inputId)) : group.inputIds;
    if (!orphans.length) continue;
    if (writes.length >= cap) {
      stoppedAt = group.first;
      break;
    }
    const plan: QueuePlan = { productId: group.productId, kind: product ? 'full' : 'delete', inputIds: orphans };
    writes.push(enqueueWrite(undefined, plan));
    next.found += orphans.length;
  }

  const stop = stoppedAt ?? unread;
  if (stop !== null) {
    next.skip += stop;
  } else {
    next.skip = 0;
    if (page.nextPageToken) next.page_token = page.nextPageToken;
    else {
      next.status = 'done';
      next.date_finished = iso(env.ctx.now());
    }
  }

  env.outbox.add(...writes);
  const answers = await env.outbox.send(reads);
  return { job: next, sentOps: 0, progressed: next.skip !== job.skip || next.page_token !== job.page_token || next.status === 'done', answers };
}
