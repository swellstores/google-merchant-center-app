import type { Market } from '../connection/markets';
import type { AppContext } from '../context';
import { MAX_BATCH_PARTS, sendBatch, type BatchPart, type BatchResult } from '../google/batch';
import { classifyGoogleError, errorMessage, GoogleApiError } from '../google/http';
import { deleteProductInput, insertProductInput, patchProductInput, type ProductAttributes } from '../google/merchant';
import { buildOffers, marketOfInput, parseInputId, type OfferDefaults, type SkipReason } from '../mapping/offers';
import type { GoogleFields, SwellProduct } from '../mapping/types';
import type { Outbox } from '../swell-batch';
import { iso, type Budget } from '../time';
import type { WorkUnit } from './queue';

export interface DeliveryEnv {
  ctx: AppContext;
  accountId: string;
  token: string;
  /** Markets with a data source */
  markets: Market[];
  defaults: OfferDefaults;
  budget: Budget;
  /** Takes the products' sync fields for the caller's next round trip */
  outbox: Outbox;
}

export interface DeliveryReport {
  done: WorkUnit[];
  kept: WorkUnit[];
  /** Units none of whose calls went out in a batch */
  untouched: WorkUnit[];
  sentOps: number;
  /**
   * Stops the run: auth, daily quota, a whole batch that failed, or a part
   * answered with a rate limit or a server error
   */
  failure?: GoogleApiError;
}

/** Time a batch needs, so the run never starts one it cannot finish. */
export const SEND_RESERVE_MS = 2500;
export const LIGHT_MASK: (keyof ProductAttributes)[] = ['price', 'salePrice', 'availability'];

interface Op {
  kind: 'insert' | 'patch' | 'delete';
  inputId: string;
  part: BatchPart;
}

interface Plan {
  unit: WorkUnit;
  product: SwellProduct | null;
  skipped: SkipReason | null;
  ops: Op[];
  /** Inputs Google holds: sent before, or earlier in this revision */
  known: Set<string>;
  /** Current offers already sent earlier in this revision */
  carried: string[];
}

async function readProducts(env: DeliveryEnv, ids: string[]): Promise<Map<string, SwellProduct>> {
  if (!ids.length) return new Map();
  const list = await env.ctx.swell.get('/products', { where: { id: { $in: ids } }, expand: ['variants:1000'], limit: ids.length });
  return new Map((list?.results ?? []).map((p: SwellProduct): [string, SwellProduct] => [p.id, p]));
}

function planUnit(env: DeliveryEnv, unit: WorkUnit, product: SwellProduct | null): Plan {
  const ops: Op[] = [];
  const partId = () => `${unit.productId}-${ops.length}`;
  const done = new Set(unit.doneInputIds ?? []);
  const addDelete = (inputId: string) => {
    if (done.has(inputId)) return; // deleted earlier in this revision
    const dataSource = marketOfInput(env.markets, inputId)?.data_source;
    if (!dataSource) return;
    ops.push({ kind: 'delete', inputId, part: { id: partId(), call: deleteProductInput(env.accountId, dataSource, parseInputId(inputId)) } });
  };

  if (unit.kind === 'delete' || !product) {
    unit.inputIds.forEach(addDelete);
    return { unit, product: null, skipped: null, ops, known: new Set(unit.inputIds), carried: [] };
  }

  const fields: GoogleFields = product.$app?.[env.ctx.appId] ?? {};
  const previous = fields.input_ids ?? [];
  // Offers Google may hold: recorded on the product, carried over from an
  // earlier revision of the queue item, or sent earlier in this one.
  const known = new Set([...previous, ...unit.inputIds, ...done]);
  const build = buildOffers(product, env.markets, { appId: env.ctx.appId, defaults: env.defaults, version: String(env.ctx.now()) });
  for (const offer of build.offers) {
    if (done.has(offer.inputId)) continue;
    const dataSource = offer.market.data_source!;
    const light = unit.kind === 'light' && known.has(offer.inputId);
    ops.push({
      kind: light ? 'patch' : 'insert',
      inputId: offer.inputId,
      part: {
        id: partId(),
        call: light
          ? patchProductInput(env.accountId, dataSource, offer.input, LIGHT_MASK)
          : insertProductInput(env.accountId, dataSource, offer.input),
      },
    });
  }
  const current = new Set(build.offers.map((offer) => offer.inputId));
  [...known].filter((id) => !current.has(id)).forEach(addDelete);
  const carried = build.offers.map((offer) => offer.inputId).filter((id) => done.has(id));
  return { unit, product, skipped: build.skipped, ops, known, carried };
}

interface Settled {
  keep: boolean;
  upgrade?: boolean;
  error?: string;
  untouched?: boolean;
  progress?: string[];
  fatal?: GoogleApiError;
  /** The first part answered with a rate limit or a server error */
  short?: GoogleApiError;
  charge?: boolean;
  fields?: GoogleFields;
}

function settlePlan(env: DeliveryEnv, plan: Plan, results: Map<string, BatchResult>, attempted: Set<string>): Settled {
  const sent: string[] = [];
  const completed: string[] = [];
  const stillThere: string[] = [];
  const errors: string[] = [];
  let keep = false;
  let upgrade = false;
  let charge = false;
  let fatal: GoogleApiError | undefined;
  let short: GoogleApiError | undefined;

  if (plan.ops.length > 0 && !plan.ops.some((op) => attempted.has(op.part.id))) return { keep: true, untouched: true };

  for (const op of plan.ops) {
    const result = results.get(op.part.id);
    if (!result) {
      keep = true;
      continue;
    }
    if (result.status >= 200 && result.status < 300) {
      if (op.kind !== 'delete') sent.push(op.inputId);
      completed.push(op.inputId);
      continue;
    }
    const kind = classifyGoogleError(result.status, result.body);
    const message = errorMessage(result.body, result.status);
    if (op.kind === 'delete' && kind === 'not_found') {
      completed.push(op.inputId);
      continue;
    }
    if (op.kind === 'patch' && kind === 'not_found') {
      keep = true;
      upgrade = true;
      continue;
    }
    if (kind === 'auth' || kind === 'daily_quota') {
      fatal ??= new GoogleApiError(kind, result.status, message, result.body);
      keep = true;
      continue;
    }
    if (kind === 'rate' || kind === 'server') {
      short ??= new GoogleApiError(kind, result.status, message, result.body);
      keep = true;
      charge ||= kind === 'server';
      errors.push(message);
      continue;
    }
    errors.push(message);
    if (op.kind === 'delete' || plan.known.has(op.inputId)) stillThere.push(op.inputId);
  }

  if (keep) return { keep, upgrade, error: errors[0] ?? null, fatal, short, charge, progress: completed };
  if (!plan.product) return { keep: false };
  const date_synced = iso(env.ctx.now());
  if (plan.skipped) {
    return { keep: false, fields: { sync_state: 'skipped', sync_reason: plan.skipped, sync_error: errors[0] ?? null, input_ids: stillThere, date_synced } };
  }
  return {
    keep: false,
    fields: {
      sync_state: errors.length ? 'error' : 'sent',
      sync_reason: null,
      sync_error: errors[0] ?? null,
      input_ids: [...new Set([...plan.carried, ...sent, ...stillThere])],
      date_synced,
    },
  };
}

/**
 * Sends the units' offers in batches of at most 100 while the budget lasts and
 * sorts each unit into done, kept or untouched. A unit is done only when Google
 * answered every one of its calls with something final; kept units report the
 * calls that completed; untouched units never went out. The done products'
 * sync fields wait in `env.outbox`. `read` are the products when the caller
 * has them already.
 */
export async function deliver(env: DeliveryEnv, units: WorkUnit[], read?: Map<string, SwellProduct>): Promise<DeliveryReport> {
  const products = read ?? (await readProducts(env, units.filter((u) => u.kind !== 'delete').map((u) => u.productId)));
  const plans = units.map((unit) => planUnit(env, unit, products.get(unit.productId) ?? null));
  const ops = plans.flatMap((plan) => plan.ops);

  const results = new Map<string, BatchResult>();
  const attempted = new Set<string>();
  let failure: GoogleApiError | undefined;
  for (let i = 0; i < ops.length && !failure; i += MAX_BATCH_PARTS) {
    if (!env.budget.has(SEND_RESERVE_MS)) break;
    const parts = ops.slice(i, i + MAX_BATCH_PARTS).map((op) => op.part);
    parts.forEach((part) => attempted.add(part.id));
    try {
      const answers = await sendBatch(env.ctx.fetch, env.token, parts);
      for (const answer of answers) results.set(answer.id, answer);
    } catch (error) {
      if (!(error instanceof GoogleApiError)) throw error;
      failure = error;
    }
  }

  const report: DeliveryReport = { done: [], kept: [], untouched: [], sentOps: results.size, failure };
  let short: GoogleApiError | undefined;
  for (const plan of plans) {
    const settled = settlePlan(env, plan, results, attempted);
    if (settled.fatal && !report.failure) report.failure = settled.fatal;
    short ??= settled.short;
    if (settled.untouched) {
      report.untouched.push(plan.unit);
      continue;
    }
    if (settled.keep) {
      report.kept.push({
        ...plan.unit,
        kind: settled.upgrade ? 'full' : plan.unit.kind,
        error: settled.error ?? null,
        progress: settled.progress,
        charge: settled.charge,
      });
      continue;
    }
    report.done.push(plan.unit);
    if (plan.product && settled.fields) {
      env.outbox.add({ method: 'put', url: `/products/${plan.product.id}`, data: { $app: { [env.ctx.appId]: settled.fields } } });
    }
  }
  // A part was rate limited or failed on Google's side: the courier settles what it has and backs off.
  report.failure ??= short;
  return report;
}
