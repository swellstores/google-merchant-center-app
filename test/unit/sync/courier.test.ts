import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConnection } from '../../../functions/lib/connection/store';
import { loadMarkets } from '../../../functions/lib/connection/markets';
import { COURIER_BUDGET_MS, NEXT_RUN_MS, pacedDelay, PASS_PRODUCTS, runCourier } from '../../../functions/lib/sync/courier';
import { MAX_ATTEMPTS, queueChange } from '../../../functions/lib/sync/queue';
import type { ServiceAccountKey } from '../../../functions/lib/google/jwt';
import { newOrphanScanJob } from '../../../functions/lib/status/orphans';
import { pendingStatus, type GoogleProductStatus } from '../../../functions/lib/status/product-status';
import { newStatusRefreshJob, STATUS_PAGE, summaryOf } from '../../../functions/lib/status/refresh';
import { APP_ID, fixedClock, NOW, slowServices, testContext } from '../../helpers/context';
import { createFakeGoogle, type FakeGoogleOptions } from '../../helpers/fake-google';
import { batchesOf, createFakeSwell, roundTrips } from '../../helpers/fake-swell';
import { makeServiceAccountKey } from '../../helpers/keys';
import { enqueue, loadAlarm, loadState, queueCount, saveState, setAlarm } from '../../helpers/store';

let key: ServiceAccountKey;
beforeAll(async () => {
  ({ key } = await makeServiceAccountKey());
});

const at = (ms: number) => new Date(ms).toISOString();
const DS = 'accounts/123/dataSources/1';
const MUG = { id: 'p1', name: 'Mug', slug: 'mug', active: true, price: 12, images: [{ file: { url: 'https://cdn.example.com/mug.jpg' } }] };

function setup(googleOptions: FakeGoogleOptions = {}, connection: Record<string, any> = {}) {
  return setupMany([MUG], googleOptions, connection);
}

function setupMany(
  products: Record<string, any>[],
  googleOptions: FakeGoogleOptions = {},
  connection: Record<string, any> = {},
  market: Record<string, any> = {},
) {
  const google = createFakeGoogle(googleOptions);
  const fake = createFakeSwell({
    products,
    connection: {
      status: 'connected',
      merchant_id: '123',
      client_email: key.client_email,
      private_key: key.private_key,
      access_token: 'cached',
      access_token_expires: at(NOW + 3600_000),
      ...connection,
    },
    markets: [{ country: 'US', language: 'en', currency: 'USD', link_template: 'https://shop.example.com/products/{slug}', ...market }],
  });
  return { google, ...fake, ctx: testContext(fake.swell, google.fetch) };
}

/** A store that ran before: its market has a data source and the quota is known. */
async function steady(products: Record<string, any>[] = [MUG], googleOptions: FakeGoogleOptions = {}, connection: Record<string, any> = {}) {
  const store = setupMany(products, googleOptions, connection, { data_source: DS });
  const state = await loadState(store.swell);
  await saveState(store.swell, state.id, { quota: { $set: { minute_limit: 300, daily_limit: 5000, date_checked: at(NOW) } } });
  await loadAlarm(store.swell);
  return store;
}

/** A Swell client of one run, which keeps the batches that run sent. */
function ownClient(swell: ReturnType<typeof createFakeSwell>['swell']) {
  const batches: { method: string; url: string; data?: any }[][] = [];
  const client = {
    get: (url: string, query?: object) => swell.get(url, query),
    post: (url: string, data: any) => {
      if (url === '/:batch') batches.push(data);
      return swell.post(url, data);
    },
    put: (url: string, data: object) => swell.put(url, data),
    delete: (url: string) => swell.delete(url),
  };
  return { client, batches };
}

/** Holds every run mark until `count` runs have made theirs: their start reads all came first. */
function startTogether(swell: ReturnType<typeof createFakeSwell>['swell'], count: number) {
  const post = swell.post.getMockImplementation()!;
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((resolve) => (release = resolve));
  swell.post.mockImplementation(async (url: string, data: any) => {
    if (url === '/:batch' && data.some((op: any) => op.data?.$inc)) {
      if (++arrived === count) release();
      await all;
    }
    return post(url, data);
  });
}

const opsOf = (batch: { method: string; url: string }[]) => batch.map((op) => `${op.method} ${op.url.replace(/\/[0-9a-f]{24}$/, '/:id')}`);

const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...MUG, id: `p${String(i).padStart(2, '0')}`, slug: `p${i}` }));

function forget(swell: ReturnType<typeof createFakeSwell>['swell']) {
  swell.get.mockClear();
  swell.post.mockClear();
  swell.put.mockClear();
  swell.delete.mockClear();
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const hourly = { trigger: 'hourly' } as const;

/** A refresh and an orphan scan that finished a minute ago: neither is due for a while. */
const RECENT_JOBS = {
  status_refresh: { $set: { ...newStatusRefreshJob(NOW - 2 * MINUTE), status: 'done', date_finished: at(NOW - MINUTE), duration_ms: MINUTE } },
  orphan_scan: { $set: { ...newOrphanScanJob(NOW - 2 * MINUTE), status: 'done', date_finished: at(NOW - MINUTE) } },
};

/** A steady store with no status job due. */
async function quiet(products: Record<string, any>[] = [MUG], googleOptions: FakeGoogleOptions = {}, connection: Record<string, any> = {}) {
  const store = await steady(products, googleOptions, connection);
  await saveState(store.swell, (await loadState(store.swell)).id, RECENT_JOBS);
  return store;
}

const pending = pendingStatus();

/** A quiet store whose products the courier sent an hour ago and marked pending: Google holds their offers. */
async function listed(products: Record<string, any>[], googleOptions: FakeGoogleOptions = {}, connection: Record<string, any> = {}) {
  const sent = products.map((p): Record<string, any> => ({
    ...p,
    $app: {
      [APP_ID]: {
        sync_state: 'sent',
        input_ids: [`en~US~${p.id}`],
        date_synced: at(NOW - HOUR),
        status: pending.status,
        status_label: pending.label,
        status_hash: pending.hash,
        status_issues: pending.issues,
      },
    },
  }));
  const store = await quiet(sent, googleOptions, connection);
  for (const p of sent) store.google.inputs.set(`${DS}|en~US~${p.id}`, { offerId: p.id, contentLanguage: 'en', feedLabel: 'US' });
  return store;
}

const approved: GoogleProductStatus = {
  destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', approvedCountries: ['US'] }],
  googleExpirationDate: at(NOW + 30 * DAY),
};
const disapproved = (code: string): GoogleProductStatus => ({
  destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', disapprovedCountries: ['US'] }],
  itemLevelIssues: [{ code, severity: 'DISAPPROVED', description: `${code} text`, applicableCountries: ['US'] }],
  googleExpirationDate: at(NOW + 30 * DAY),
});

const alarmWrites = (swell: ReturnType<typeof createFakeSwell>['swell']) =>
  batchesOf(swell)
    .flat()
    .filter((op) => op.url.startsWith('/alarms') && op.method !== 'get')
    .map((op) => op.data!.wake_at);

/** Google's product reads and lists, in the order the run made them, by kind. */
const googleCalls = (google: ReturnType<typeof createFakeGoogle>) =>
  google.requests.flatMap((r) => {
    const [path] = r.path.split('?');
    if (path.endsWith('/productInputs:insert')) return ['insert'];
    if (r.method === 'GET' && /\/accounts\/\d+\/products\/[^/]+$/.test(path)) return ['status'];
    if (r.method === 'GET' && /\/accounts\/\d+\/products$/.test(path)) return ['list'];
    return [];
  });

describe('runCourier', () => {
  it('clears the alarm when Google is not connected', async () => {
    const { ctx, swell } = setup({}, { status: 'disconnected' });
    expect(await runCourier(ctx)).toEqual({ next: 'idle', sent: 0 });
    expect((await loadAlarm(swell)).wake_at).toBeNull();
  });

  it('creates the market’s data source, sends the queue and goes idle', async () => {
    const { ctx, swell, google } = setup();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    expect(await runCourier(ctx)).toEqual({ next: 'idle', sent: 1 });
    expect((await loadMarkets(swell))[0].data_source).toBe('accounts/123/dataSources/1');
    expect(google.inputs.size).toBe(1);
    expect(await queueCount(swell)).toBe(0);
    expect((await loadAlarm(swell)).wake_at).toBeNull();
    expect((await loadState(swell)).running_since).toBeNull();
    expect((await loadState(swell)).not_before).toBeNull();
  });

  it('leaves everything alone while another run works', async () => {
    const { ctx, swell, google } = setup();
    const state = await loadState(swell);
    await saveState(swell, state.id, { running_since: at(NOW - 5_000) });
    await setAlarm(ctx, NOW + 5_000);
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    expect(await runCourier(ctx)).toEqual({ next: 'busy', sent: 0 });
    expect(google.requests).toHaveLength(0);
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW + 5_000));
    expect(await queueCount(swell)).toBe(1);
  });

  it('leaves everything alone before the time the last run asked for', async () => {
    const { ctx, swell, google } = setup();
    const state = await loadState(swell);
    await saveState(swell, state.id, { not_before: at(NOW + 60_000) });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    expect(await runCourier(ctx)).toEqual({ next: 'early', sent: 0 });
    expect(google.requests).toHaveLength(0);
    expect(await queueCount(swell)).toBe(1);
  });

  it('leaves a dead-man alarm while it works', async () => {
    const { ctx, swell } = setup();
    await loadAlarm(swell);
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await runCourier(ctx);
    const alarmWrites = batchesOf(swell)
      .flat()
      .filter((op) => op.url.startsWith('/alarms') && op.method !== 'get')
      .map((op) => op.data!.wake_at);
    expect(alarmWrites).toEqual([at(NOW + 35_000), null]);
  });

  it('leaves no dead-man alarm when there is nothing to do', async () => {
    const { ctx, swell } = setup();
    expect(await runCourier(ctx)).toEqual({ next: 'idle', sent: 0 });
    expect(batchesOf(swell).flat().filter((op) => op.url.startsWith('/alarms') && op.method !== 'get')).toEqual([]);
    expect(swell.put).not.toHaveBeenCalled();
  });

  it('releases the run mark and re-arms after an unexpected error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ctx, swell, refuse } = setup();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    refuse((method, url) => (url === '/products' ? 'boom' : null));
    await expect(runCourier(ctx)).rejects.toThrow('boom');
    refuse(() => null);
    log.mockRestore();
    const state = await loadState(swell);
    expect(state.running_since).toBeNull();
    expect(state.not_before).toBe(at(NOW + NEXT_RUN_MS));
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW + NEXT_RUN_MS));
  });

  it('does not retry kept units in the same run', async () => {
    const products: Record<string, any>[] = many(PASS_PRODUCTS + 3);
    // Google lost the offer of a light update: the unit is kept as full, and the run has no failure.
    products[0] = { ...products[0], $app: { [APP_ID]: { input_ids: ['en~US~p00'] } } };
    const { ctx, swell, collections, google } = setupMany(products);
    await enqueue(swell, { productId: 'p00', kind: 'light' });
    for (const p of products.slice(1)) await enqueue(swell, { productId: p.id, kind: 'full' });
    expect((await runCourier(ctx)).next).toBe('soon');
    expect(google.batches()).toBe(1);
    expect(collections['/queue-items'].map((q) => [q.product_id, q.kind])).toEqual([['p00', 'full'], ['p07', 'full'], ['p08', 'full'], ['p09', 'full']]);
  });

  it('proceeds when running_since is stale', async () => {
    const { ctx, swell } = setup();
    const state = await loadState(swell);
    await saveState(swell, state.id, { running_since: at(NOW - 120_000) });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    expect((await runCourier(ctx)).sent).toBe(1);
  });

  it('runs the catalog sync after the queue and comes back while it is running', async () => {
    const { ctx, swell, google } = setup();
    const state = await loadState(swell);
    await saveState(swell, state.id, { full_sync: { $set: { status: 'running', cursor: null, total: 1, done: 0, date_started: at(NOW) } } });
    const outcome = await runCourier(ctx);
    expect(outcome.sent).toBe(1);
    expect(google.inputs.size).toBe(1);
    expect((await loadState(swell)).full_sync).toMatchObject({ status: 'done', done: 1 });
    expect((await loadAlarm(swell)).wake_at).toBeNull();
  });

  it('keeps a catalog sync started while it was running', async () => {
    const { swell, google } = setup();
    const state = await loadState(swell);
    await saveState(swell, state.id, { full_sync: { $set: { status: 'running', cursor: null, total: 1, done: 0, date_started: at(NOW - 60_000) } } });
    const restarted = { status: 'running', cursor: null, total: 1, done: 0, date_started: at(NOW) };
    let batches = 0;
    const restarting = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/batch/products/v1') && ++batches === 1) await saveState(swell, state.id, { full_sync: { $set: restarted } });
      return google.fetch(input, init);
    }) as typeof fetch;
    expect((await runCourier(testContext(swell, restarting))).next).toBe('soon');
    expect((await loadState(swell)).full_sync).toEqual(restarted);
  });

  it('reads the page again when the catalog sync restarts as the run marks itself', async () => {
    const products = many(PASS_PRODUCTS + 3);
    const { ctx, swell, google } = await steady(products);
    const ids = products.map((p) => p.id).sort();
    const state = await loadState(swell);
    const old = { status: 'running', cursor: ids[PASS_PRODUCTS - 1], total: 10, done: PASS_PRODUCTS, date_started: at(NOW - 60_000) };
    await saveState(swell, state.id, { full_sync: { $set: old } });
    const restarted = { status: 'running', cursor: null, total: 0, done: 0, date_started: at(NOW) };
    const post = swell.post.getMockImplementation()!;
    let injected = false;
    swell.post.mockImplementation(async (url: string, data: any) => {
      if (url === '/:batch' && !injected && data.some((op: any) => op.data?.running_since)) {
        injected = true;
        await saveState(swell, state.id, { full_sync: { $set: restarted } });
      }
      return post(url, data);
    });
    await runCourier(ctx);
    // The restarted sync sends the whole catalog from the start, p00–p06 included.
    expect([...google.inputs.keys()].map((key) => key.split('~')[2]).sort()).toEqual(ids);
    expect((await loadState(swell)).full_sync).toMatchObject({ status: 'done', date_started: at(NOW), cursor: ids.at(-1), done: ids.length });
  });

  it('re-sends a product whose queue item a run removed between enqueue’s read and its write', async () => {
    const sent = { ...MUG, $app: { [APP_ID]: { input_ids: ['en~US~p1'] } } };
    const { ctx, swell, collections, google } = await steady([sent]);
    google.inputs.set(`${DS}|en~US~p1`, { offerId: 'p1', productAttributes: { title: 'Old' } });
    await enqueue(swell, { productId: 'p1', kind: 'light', inputIds: ['en~US~p1'] });
    // A courier run settles the item just after enqueue read it.
    const post = swell.post.getMockImplementation()!;
    swell.post.mockImplementation(async (url: string, data: any) => {
      if (url === '/:batch' && data.some((op: any) => op.method === 'put' && op.url.startsWith('/queue-items/'))) collections['/queue-items'].length = 0;
      return post(url, data);
    });
    await queueChange(ctx, { productId: 'p1', kind: 'full' });
    swell.post.mockImplementation(post);
    expect(collections['/queue-items']).toEqual([expect.objectContaining({ product_id: 'p1', kind: 'full' })]);
    await runCourier(ctx);
    expect(google.inputs.get(`${DS}|en~US~p1`)?.productAttributes.title).toBe('Mug');
  });

  it('deletes what an update sent when its product is gone and its delete is not in the run', async () => {
    const { ctx, collections, google } = await steady([]);
    collections['/queue-items'].push({ id: 'a', product_id: 'p1', kind: 'full', input_ids: [], done_input_ids: ['en~US~v3'], revision: 0, attempts: 0 });
    google.inputs.set(`${DS}|en~US~v3`, {});
    await runCourier(ctx);
    expect(google.inputs.has(`${DS}|en~US~v3`)).toBe(false);
    expect(collections['/queue-items']).toEqual([]);
  });

  it('finishes deleting a gone product’s update with more offers than a run can send', async () => {
    const { swell, collections, google } = await steady([]);
    const ids = Array.from({ length: 150 }, (_, i) => `en~US~v${i}`);
    // 100 offers sent in this revision, 50 listed from before; then the product was deleted.
    collections['/queue-items'].push({ id: 'a', product_id: 'p1', kind: 'full', input_ids: ids.slice(100), done_input_ids: ids.slice(0, 100), revision: 0, attempts: 0 });
    ids.forEach((id) => google.inputs.set(`${DS}|${id}`, {}));
    let runs = 0;
    // At 1.3 s a Swell round trip and 1.5 s a Google call one batch of 100 fits in a run.
    while (collections['/queue-items'].length && runs < 6) {
      const slow = slowServices(swell, google.fetch, { swellMs: 1300, googleMs: 1500 }, NOW + runs * 600_000);
      await runCourier(testContext(slow.swell, slow.fetch, slow.now));
      runs++;
    }
    expect(google.batches()).toBe(runs);
    expect(google.inputs.size).toBe(0);
    expect(collections['/queue-items']).toEqual([]);
    expect(runs).toBe(2);
  });

  it('deletes every offer of a product deleted with its variants in one burst', async () => {
    const tee = {
      ...MUG,
      variants: { results: [{ id: 'v1', name: 'S', active: true }, { id: 'v2', name: 'M', active: true }] },
      $app: { [APP_ID]: { input_ids: ['en~US~v1', 'en~US~v2'] } },
    };
    const { ctx, swell, collections, google } = await steady([tee]);
    google.inputs.set(`${DS}|en~US~v1`, {});
    google.inputs.set(`${DS}|en~US~v2`, {});
    await enqueue(swell, { productId: 'p1', kind: 'light' });
    collections['/products'].length = 0;
    // product.deleted and both product.variant.deleted arrive within ~150 ms: every
    // read is made before any write, and the delete is written first.
    await Promise.all([
      queueChange(ctx, { productId: 'p1', kind: 'delete', inputIds: ['en~US~v1', 'en~US~v2'] }),
      queueChange(ctx, { productId: 'p1', kind: 'full' }),
      queueChange(ctx, { productId: 'p1', kind: 'full' }),
    ]);
    await runCourier(ctx);
    expect([...google.inputs.keys()]).toEqual([]);
    expect(collections['/queue-items']).toEqual([]);
  });

  it('deletes a product the merchant deleted while Google rate-limited it', async () => {
    const sent = { ...MUG, $app: { [APP_ID]: { input_ids: ['en~US~p1'] } } };
    const options: FakeGoogleOptions = { offerErrors: { p1: { status: 429, body: { error: { message: 'quota/request_rate_too_high' } } } } };
    const { ctx, swell, collections, google } = await steady([sent], options);
    google.inputs.set(`${DS}|en~US~p1`, {});
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    // The merchant deletes the product after the run re-read its items and before it settles them.
    const post = swell.post.getMockImplementation()!;
    let deleted = false;
    swell.post.mockImplementation(async (url: string, data: any) => {
      const answer = await post(url, data);
      if (url === '/:batch' && !deleted && data.some((op: any) => op.method === 'get' && op.url === '/queue-items' && op.data?.where?.id)) {
        deleted = true;
        collections['/products'].length = 0;
        await queueChange(ctx, { productId: 'p1', kind: 'delete', inputIds: ['en~US~p1'] });
      }
      return answer;
    });
    expect((await runCourier(ctx)).next).toBe('later');
    swell.post.mockImplementation(post);
    delete options.offerErrors!.p1;
    await runCourier(testContext(swell, google.fetch, fixedClock(NOW + 60_000)));
    expect(google.inputs.has(`${DS}|en~US~p1`)).toBe(false);
    expect(collections['/queue-items']).toEqual([]);
  });

  it('backs off after a rate limit and keeps the queue', async () => {
    const { ctx, swell } = setup({ batch: { status: 429, body: { error: { message: 'quota/request_rate_too_high' } } } });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    expect((await runCourier(ctx)).next).toBe('later');
    expect(await queueCount(swell)).toBe(1);
    expect((await loadState(swell)).backoff).toBe(1);
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW + 30_000));
    expect((await loadState(swell)).not_before).toBe(at(NOW + 30_000));
  });

  it('backs off after a part-level 429 without charging an attempt', async () => {
    const rate = { status: 429, body: { error: { message: 'quota/request_rate_too_high' } } };
    const { ctx, swell, collections } = setup({ offerErrors: { p1: rate } });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    expect((await runCourier(ctx)).next).toBe('later');
    expect(collections['/queue-items']).toEqual([expect.objectContaining({ product_id: 'p1', attempts: 0 })]);
    expect((await loadState(swell)).not_before).toBe(at(NOW + 30_000));
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW + 30_000));
  });

  it('reads the quota on its first run', async () => {
    const { ctx, swell } = setup();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await runCourier(ctx);
    expect((await loadState(swell)).quota).toMatchObject({ minute_limit: 300, daily_limit: 5000, date_checked: at(NOW) });
  });

  it('pauses until noon UTC when the daily quota is gone', async () => {
    const { ctx, swell } = setup({ batch: { status: 429, body: { error: { message: 'quota/daily_limit_exceeded' } } } });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    expect((await runCourier(ctx)).next).toBe('paused');
    const noon = Date.UTC(2026, 9, 15, 12);
    expect((await loadState(swell)).quota).toMatchObject({ exhausted_until: at(noon) });
    expect((await loadAlarm(swell)).wake_at).toBe(at(noon));
    expect((await loadState(swell)).not_before).toBe(at(noon));
  });

  it('marks the connection broken when Google refuses the key', async () => {
    const { ctx, swell } = setup(
      { token: { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } },
      { access_token: null, access_token_expires: null },
    );
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    expect((await runCourier(ctx)).next).toBe('idle');
    expect(await loadConnection(swell)).toMatchObject({ status: 'broken', last_error: 'Invalid JWT Signature.' });
    expect((await loadAlarm(swell)).wake_at).toBeNull();
  });
});

describe('runCourier lock', () => {
  it('lets only one of two runs that start together work', async () => {
    const { swell, google, collections } = await steady();
    await saveState(swell, (await loadState(swell)).id, { run_seq: 4 });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    const runs = [ownClient(swell), ownClient(swell)];
    startTogether(swell, 2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outcomes = await Promise.all(runs.map((run) => runCourier(testContext(run.client, google.fetch))));
    expect(outcomes.map((o) => o.next).sort()).toEqual(['busy', 'idle']);
    expect(google.batches()).toBe(1);
    const loser = runs[outcomes.findIndex((o) => o.next === 'busy')];
    // Its start read and its mark (with the prefetched products), nothing after: no alarm, no state.
    expect(loser.batches.map(opsOf)).toEqual([
      ['get /connections', 'get /sync-states', 'get /alarms', 'get /markets', 'get /queue-items'],
      ['put /sync-states/:id', 'get /products'],
    ]);
    expect(collections['/sync-states'][0]).toMatchObject({ run_seq: 6, running_since: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('another run'));
    warn.mockRestore();
  });

  it('leaves one chain after a burst of runs', async () => {
    const products = many(PASS_PRODUCTS + 3);
    const { swell, google } = await steady(products);
    for (const p of products) await enqueue(swell, { productId: p.id, kind: 'full' });
    const runs = [ownClient(swell), ownClient(swell), ownClient(swell)];
    startTogether(swell, 3);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outcomes = await Promise.all(runs.map((run) => runCourier(testContext(run.client, google.fetch))));
    expect(outcomes.filter((o) => o.next === 'busy')).toHaveLength(2);
    const alarmWrites = runs.map((run) => run.batches.flat().filter((op) => op.url.startsWith('/alarms') && op.method !== 'get').length);
    // The winner's dead-man and its ending; the others none.
    expect(alarmWrites.sort()).toEqual([0, 0, 2]);
    warn.mockRestore();
  });

  it('creates the state of a fresh store with the run counter at 1 and works', async () => {
    const { ctx, swell, collections } = await steady();
    collections['/sync-states'].length = 0;
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    expect((await runCourier(ctx)).sent).toBe(1);
    expect(collections['/sync-states'][0]).toMatchObject({ run_seq: 1 });
  });
});

describe('runCourier round trips', () => {
  it('sends a queue in four round trips, the first pass’s read riding with the mark', async () => {
    const { ctx, swell, google } = await steady();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    forget(swell);
    expect(await runCourier(ctx)).toEqual({ next: 'idle', sent: 1 });
    expect(google.inputs.size).toBe(1);
    const [start, mark, sent, end] = batchesOf(swell);
    expect(opsOf(start)).toEqual(['get /connections', 'get /sync-states', 'get /alarms', 'get /markets', 'get /queue-items']);
    expect(opsOf(mark)).toEqual(['put /sync-states/:id', 'get /products']);
    expect(mark[0].data).toMatchObject({ $inc: { run_seq: 1 }, running_since: at(NOW) });
    expect(mark[1].data).toMatchObject({ where: { id: { $in: ['p1'] } }, expand: ['variants:1000'] });
    // The dead-man alarm goes with the run's first round trip after the lock.
    expect(opsOf(sent)).toEqual(['put /alarms/:id', 'put /products/p1', 'get /queue-items', 'get /sync-states/:id']);
    expect(opsOf(end)).toEqual(['delete /queue-items/:id', 'put /alarms/:id', 'put /sync-states/:id']);
    expect(swell.get).not.toHaveBeenCalled();
    expect(swell.put).not.toHaveBeenCalled();
    expect(swell.delete).not.toHaveBeenCalled();
    expect(roundTrips(swell)).toBe(4);
  });

  it('sends a catalog page in four round trips, the page riding with the mark', async () => {
    const { ctx, swell } = await steady();
    const state = await loadState(swell);
    await saveState(swell, state.id, { full_sync: { $set: { status: 'running', cursor: null, total: 0, done: 0, date_started: at(NOW) } } });
    forget(swell);
    expect(await runCourier(ctx)).toEqual({ next: 'idle', sent: 1 });
    const [, mark, sent] = batchesOf(swell);
    expect(opsOf(mark)).toEqual(['put /sync-states/:id', 'get /products']);
    expect(mark[1].data).toMatchObject({ sort: 'id asc', limit: PASS_PRODUCTS, expand: ['variants:1000'] });
    expect(opsOf(sent)).toEqual(['put /alarms/:id', 'put /products/p1', 'get /sync-states/:id']);
    expect(roundTrips(swell)).toBe(4);
    expect((await loadState(swell)).full_sync).toMatchObject({ status: 'done', total: 1, done: 1 });
  });

  it('sends the writes that wait with the page read of a catalog pass after the queue', async () => {
    const { ctx, swell } = await steady([MUG, { ...MUG, id: 'p2', slug: 'p2' }]);
    const state = await loadState(swell);
    await saveState(swell, state.id, { full_sync: { $set: { status: 'running', cursor: null, total: 0, done: 0, date_started: at(NOW) } } });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    forget(swell);
    expect((await runCourier(ctx)).sent).toBe(3);
    const batches = batchesOf(swell).map(opsOf);
    expect(batches[3]).toEqual(['delete /queue-items/:id', 'get /products']);
    expect(roundTrips(swell)).toBe(6);
  });

  it('creates a missing state in its first write', async () => {
    const { ctx, swell, collections } = await steady();
    collections['/sync-states'].length = 0;
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    forget(swell);
    await runCourier(ctx);
    expect(opsOf(batchesOf(swell)[1])).toEqual(['post /sync-states', 'get /products']);
    expect(batchesOf(swell)[1][0].data).toMatchObject({ run_seq: 1 });
    expect(collections['/sync-states']).toHaveLength(1);
  });

  it('exits early after one read', async () => {
    const { ctx, swell } = await steady();
    const state = await loadState(swell);
    await saveState(swell, state.id, { not_before: at(NOW + 60_000) });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    forget(swell);
    expect((await runCourier(ctx)).next).toBe('early');
    expect(roundTrips(swell)).toBe(1);
  });

  it('clears the alarm in one write when not connected, and writes nothing when it is clear', async () => {
    const { ctx, swell } = setup({}, { status: 'disconnected' });
    await setAlarm(ctx, NOW + 5_000);
    forget(swell);
    await runCourier(ctx);
    expect(roundTrips(swell)).toBe(2);
    expect((await loadAlarm(swell)).wake_at).toBeNull();
    forget(swell);
    await runCourier(ctx);
    expect(roundTrips(swell)).toBe(1);
  });

  it('settles an idle store in at most one write', async () => {
    const { ctx, swell } = await steady();
    const state = await loadState(swell);
    await saveState(swell, state.id, { running_since: at(NOW - 120_000), last_error: 'old' });
    forget(swell);
    expect(await runCourier(ctx)).toEqual({ next: 'idle', sent: 0 });
    expect(roundTrips(swell)).toBe(2);
    expect(await loadState(swell)).toMatchObject({ running_since: null, last_error: null });
  });

  it('stops loudly when Swell refuses its start read', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ctx, refuse } = await steady();
    refuse((method, url) => (url === '/connections' ? 'Permission denied' : null));
    await expect(runCourier(ctx)).rejects.toThrow('Swell refused to read the connection: Permission denied');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('GET /connections: Permission denied'));
    log.mockRestore();
  });

  it('fails the run when Swell refuses its last state write', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ctx, swell, refuse } = await steady();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    let writes = 0;
    refuse((method, url) => (method === 'put' && url.startsWith('/sync-states/') && ++writes === 2 ? 'Permission denied' : null));
    await expect(runCourier(ctx)).rejects.toThrow('Permission denied');
    log.mockRestore();
  });

  it('saves a refreshed token with its next round trip', async () => {
    const { ctx, swell } = await steady([MUG], {}, { access_token: null, access_token_expires: null });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    forget(swell);
    await runCourier(ctx);
    expect(swell.put).not.toHaveBeenCalled();
    expect(opsOf(batchesOf(swell)[2])).toContain('put /connections/:id');
    expect(await loadConnection(swell)).toMatchObject({ access_token: 'token-1' });
  });

  it('takes the next queue items in one server wave: with a pass’s writes, or else with the settling writes', async () => {
    const products = many(2 * PASS_PRODUCTS + 3);
    const { ctx, swell, collections } = await steady(products);
    for (const p of products) await enqueue(swell, { productId: p.id, kind: 'full' });
    forget(swell);
    expect(await runCourier(ctx)).toEqual({ next: 'idle', sent: 2 * PASS_PRODUCTS + 3 });
    expect(collections['/queue-items']).toHaveLength(0);
    const [, , firstSent, take, secondRead, secondSent, thirdRead] = batchesOf(swell).map(opsOf);
    // The first pass's writes carry the dead-man alarm: no room left for the next items.
    expect(firstSent).toHaveLength(10);
    expect(firstSent.at(-1)).toBe('get /sync-states/:id');
    expect(take).toEqual([...Array(PASS_PRODUCTS).fill('delete /queue-items/:id'), 'get /queue-items']);
    expect(secondRead).toEqual(['get /products']);
    expect(secondSent).toHaveLength(10);
    expect(secondSent.at(-1)).toBe('get /queue-items');
    expect(thirdRead).toEqual([...Array(PASS_PRODUCTS).fill('delete /queue-items/:id'), 'get /products']);
  });

  it('works a queue of 50 off seven products a pass in batches of at most ten', async () => {
    const products = many(50);
    const { ctx, swell, collections, google } = await steady(products);
    for (const p of products) await enqueue(swell, { productId: p.id, kind: 'full' });
    forget(swell);
    expect(await runCourier(ctx)).toEqual({ next: 'idle', sent: 50 });
    expect(collections['/queue-items']).toHaveLength(0);
    expect(google.batches()).toBe(Math.ceil(50 / PASS_PRODUCTS));
    const batches = batchesOf(swell);
    expect(Math.max(...batches.map((batch) => batch.length))).toBeLessThanOrEqual(10);
    const productReads = batches.flat().filter((op) => op.method === 'get' && op.url === '/products');
    expect(productReads.map((op) => (op.data as any).where.id.$in.length)).toEqual([7, 7, 7, 7, 7, 7, 7, 1]);
  });
});

describe('runCourier timing', () => {
  async function timed(latency: { swellMs: number; googleMs: number }, size = 50) {
    const products = many(size);
    const store = await steady(products);
    for (const p of products) await enqueue(store.swell, { productId: p.id, kind: 'full' });
    const slow = slowServices(store.swell, store.google.fetch, latency);
    const outcome = await runCourier(testContext(slow.swell, slow.fetch, slow.now));
    return { ...store, outcome, took: slow.now() - NOW };
  }

  it('does one pass at 1.2 s a Swell round trip and 1 s a Google call, within 7.5 s', async () => {
    const { outcome, took, google, collections } = await timed({ swellMs: 1200, googleMs: 1000 });
    expect(outcome).toEqual({ next: 'soon', sent: PASS_PRODUCTS });
    expect(google.batches()).toBe(1);
    expect(collections['/queue-items']).toHaveLength(50 - PASS_PRODUCTS);
    // Start read, mark with the products, writes, end: 4 × 1.2 s + 1 s.
    expect(took).toBe(5800);
  });

  it('does several passes on a fast store', async () => {
    const { outcome, took, google } = await timed({ swellMs: 200, googleMs: 800 });
    // A Google call counts as at least 1 s in the gate: 6 passes, not 7.
    expect(google.batches()).toBe(6);
    expect(outcome).toEqual({ next: 'soon', sent: 6 * PASS_PRODUCTS });
    expect(took).toBeLessThan(COURIER_BUDGET_MS);
  });

  it('does one pass at 1.3 s / 1.5 s and ends within 9 s, a give-up ending included', async () => {
    const products = many(PASS_PRODUCTS);
    const outage = { status: 503, body: { error: { message: 'The service is currently unavailable.' } } };
    const store = await steady(products, { offerErrors: Object.fromEntries(products.map((p) => [p.id, outage])) });
    for (const p of products) await enqueue(store.swell, { productId: p.id, kind: 'full' });
    for (const item of store.collections['/queue-items']) item.attempts = MAX_ATTEMPTS - 1;
    const slow = slowServices(store.swell, store.google.fetch, { swellMs: 1300, googleMs: 1500 });
    expect((await runCourier(testContext(slow.swell, slow.fetch, slow.now))).next).toBe('later');
    const end = batchesOf(store.swell).at(-1)!;
    expect(end.length).toBeGreaterThan(10);
    expect(store.collections['/queue-items']).toHaveLength(0);
    // Start, mark with the products, Google, the writes, and an ending of two server waves.
    expect(slow.now() - NOW).toBe(1300 + 1300 + 1500 + 1300 + 2 * 1300);
  });

  it('refreshes the token in a run too short for a pass, so the next run can send', async () => {
    const products = many(10);
    const store = await steady(products, {}, { access_token: null, access_token_expires: null });
    for (const p of products) await enqueue(store.swell, { productId: p.id, kind: 'full' });
    const first = slowServices(store.swell, store.google.fetch, { swellMs: 1300, googleMs: 1500 });
    expect(await runCourier(testContext(first.swell, first.fetch, first.now))).toEqual({ next: 'soon', sent: 0 });
    // Start, the token, the end: the mark, a Google batch, the writes and the end would not fit after the token.
    expect(first.now() - NOW).toBe(1300 + 1500 + 1300);
    expect(await loadConnection(store.swell)).toMatchObject({ access_token: 'token-1' });
    const later = NOW + 60_000;
    await saveState(store.swell, (await loadState(store.swell)).id, { not_before: null });
    const second = slowServices(store.swell, store.google.fetch, { swellMs: 1300, googleMs: 1500 }, later);
    expect(await runCourier(testContext(second.swell, second.fetch, second.now))).toEqual({ next: 'soon', sent: PASS_PRODUCTS });
    expect(second.now() - later).toBe(4 * 1300 + 1500);
  });

  it('does not ask for the quota on every run after Google failed to give it', async () => {
    const store = await steady([MUG], { quotaError: { status: 503, body: { error: { message: 'unavailable' } } } });
    await saveState(store.swell, (await loadState(store.swell)).id, { quota: null });
    await enqueue(store.swell, { productId: 'p1', kind: 'full' });
    await runCourier(store.ctx);
    expect((await loadState(store.swell)).quota).toMatchObject({ date_checked: at(NOW) });
    await enqueue(store.swell, { productId: 'p1', kind: 'full' });
    await runCourier(store.ctx);
    expect(store.google.requests.filter((r) => r.path.startsWith('/quota'))).toHaveLength(1);
  });

  it('says in the log when a store is too slow for even one pass', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { outcome, google, took, swell } = await timed({ swellMs: 2000, googleMs: 1000 }, 3);
    expect(outcome.next).toBe('soon');
    expect(google.batches()).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/2000 ms.*1500 ms/));
    // Not even the mark: the start read and a write that asks to come back.
    expect(took).toBe(4000);
    expect((await loadState(swell)).not_before).toBe(at(NOW + 2000 + NEXT_RUN_MS));
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW + 2000 + NEXT_RUN_MS));
    warn.mockRestore();
  });
});

describe('runCourier hourly', () => {
  it('an hourly run of an idle store makes one round trip and no writes', async () => {
    const { ctx, swell, google } = await quiet();
    forget(swell);
    expect(await runCourier(ctx, hourly)).toEqual({ next: 'idle', sent: 0 });
    expect(roundTrips(swell)).toBe(1);
    expect(google.requests).toHaveLength(0);
  });

  it('an hourly run starts a due refresh and works it in the same run', async () => {
    const { ctx, swell, collections } = await listed([MUG], { statuses: { 'en~US~p1': approved } });
    const state = await loadState(swell);
    await saveState(swell, state.id, { status_refresh: null });
    forget(swell);
    expect(await runCourier(ctx, hourly)).toEqual({ next: 'idle', sent: 0 });
    expect(roundTrips(swell)).toBe(4);
    // The mark reads the new refresh's first page; the job is written with the pass's writes.
    const [, mark, pass, end] = batchesOf(swell).map(opsOf);
    expect(mark).toEqual(['put /sync-states/:id', 'get /products']);
    expect(pass).toEqual(['put /sync-states/:id', 'put /products/p1', 'get /sync-states/:id']);
    expect(end).toEqual(['put /sync-states/:id']);
    expect((await loadState(swell)).status_refresh).toMatchObject({ status: 'done', date_started: at(NOW), checked: 1, counters: { approved: 1 } });
    expect(collections['/products'][0].$app[APP_ID]).toMatchObject({ status: 'approved' });
  });

  it('an hourly run sets no dead-man alarm', async () => {
    const { ctx, swell } = await quiet([MUG], { batch: { status: 429, body: { error: { message: 'quota/request_rate_too_high' } } } });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    expect((await runCourier(ctx, hourly)).next).toBe('later');
    // Only the ending's: work remains.
    expect(alarmWrites(swell)).toEqual([at(NOW + 30_000)]);
  });

  it('an alarm run never starts a job', async () => {
    const { ctx, swell } = await steady();
    forget(swell);
    expect(await runCourier(ctx)).toEqual({ next: 'idle', sent: 0 });
    expect(roundTrips(swell)).toBe(1);
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    expect(await runCourier(ctx)).toEqual({ next: 'idle', sent: 1 });
    const state = await loadState(swell);
    expect(state.status_refresh ?? null).toBeNull();
    expect(state.orphan_scan ?? null).toBeNull();
  });

  it('an hourly run reads a quota older than a day', async () => {
    const { ctx, swell, google } = await quiet();
    await saveState(swell, (await loadState(swell)).id, { quota: { $set: { minute_limit: 60, daily_limit: 100, date_checked: at(NOW - 25 * HOUR) } } });
    expect(await runCourier(ctx, hourly)).toEqual({ next: 'idle', sent: 0 });
    expect((await loadState(swell)).quota).toEqual({ minute_limit: 300, daily_limit: 5000, date_checked: at(NOW) });
    forget(swell);
    await runCourier(testContext(swell, google.fetch, fixedClock(NOW + 30 * MINUTE)), hourly);
    expect(roundTrips(swell)).toBe(1);
    expect(google.requests.filter((r) => r.path.startsWith('/quota'))).toHaveLength(1);
  });

  it('a run with work reads a quota older than a day too', async () => {
    const { ctx, swell, google } = await quiet();
    await saveState(swell, (await loadState(swell)).id, { quota: { $set: { minute_limit: 60, date_checked: at(NOW - DAY) } } });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    expect((await runCourier(ctx)).sent).toBe(1);
    expect(google.requests.filter((r) => r.path.startsWith('/quota'))).toHaveLength(1);
    expect((await loadState(swell)).quota).toMatchObject({ minute_limit: 300, date_checked: at(NOW) });
  });

  it('an hourly run works a stalled queue itself', async () => {
    const { ctx, swell, google } = await quiet();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await setAlarm(testContext(swell, undefined, fixedClock(NOW - HOUR)), NOW - 10 * MINUTE);
    expect(await runCourier(ctx, hourly)).toEqual({ next: 'idle', sent: 1 });
    expect(google.inputs.size).toBe(1);
    expect(await queueCount(swell)).toBe(0);
    expect((await loadAlarm(swell)).wake_at).toBeNull();
  });

  it('an hourly run works a catalog sync that has no alarm', async () => {
    const { ctx, swell, collections } = await quiet();
    collections['/alarms'].length = 0;
    await saveState(swell, (await loadState(swell)).id, { full_sync: { $set: { status: 'running', cursor: null, total: 1, done: 0, date_started: at(NOW) } } });
    expect(await runCourier(ctx, hourly)).toEqual({ next: 'idle', sent: 1 });
    expect((await loadState(swell)).full_sync).toMatchObject({ status: 'done', done: 1 });
  });

  it('an hourly run waits for the time the last run asked for, and for a run at work', async () => {
    const { ctx, swell, google } = await steady();
    const state = await loadState(swell);
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await saveState(swell, state.id, { not_before: at(NOW + 10 * MINUTE) });
    forget(swell);
    expect(await runCourier(ctx, hourly)).toEqual({ next: 'early', sent: 0 });
    await saveState(swell, state.id, { not_before: null, running_since: at(NOW - 5_000) });
    forget(swell);
    expect(await runCourier(ctx, hourly)).toEqual({ next: 'busy', sent: 0 });
    expect(roundTrips(swell)).toBe(1);
    expect(google.requests).toHaveLength(0);
    expect(await queueCount(swell)).toBe(1);
    expect((await loadState(swell)).status_refresh ?? null).toBeNull();
  });

  it('an hourly run without time for a pass still starts the due refresh, and the next run works it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = await listed(many(STATUS_PAGE), {}, { access_token: null, access_token_expires: null });
    await saveState(store.swell, (await loadState(store.swell)).id, { status_refresh: null });
    const first = slowServices(store.swell, store.google.fetch, { swellMs: 1300, googleMs: 1500 });
    expect(await runCourier(testContext(first.swell, first.fetch, first.now), hourly)).toEqual({ next: 'soon', sent: 0 });
    // Start, the mark, the token, the end with the new job: a pass would not fit after the token.
    expect(first.now() - NOW).toBe(3 * 1300 + 1500);
    // The job starts when the start read came back.
    expect((await loadState(store.swell)).status_refresh).toMatchObject({ status: 'running', cursor: null, date_started: at(NOW + 1300) });
    const later = NOW + MINUTE;
    const second = slowServices(store.swell, store.google.fetch, { swellMs: 1300, googleMs: 1500 }, later);
    expect((await runCourier(testContext(second.swell, second.fetch, second.now))).next).toBe('soon');
    expect((await loadState(store.swell)).status_refresh).toMatchObject({ status: 'running', checked: STATUS_PAGE, date_started: at(NOW + 1300) });
    warn.mockRestore();
  });

  it('an hourly run that starts jobs sends the queue with the products the mark read', async () => {
    const store = await quiet([MUG], {}, { access_token: null, access_token_expires: null });
    await saveState(store.swell, (await loadState(store.swell)).id, { status_refresh: null });
    await enqueue(store.swell, { productId: 'p1', kind: 'full' });
    // No time for a pass before the token; a quick token leaves time for one after it.
    const slow = slowServices(store.swell, store.google.fetch, { swellMs: 1300, googleMs: 1500, tokenMs: 300 });
    expect(await runCourier(testContext(slow.swell, slow.fetch, slow.now), hourly)).toEqual({ next: 'soon', sent: 1 });
    expect(opsOf(batchesOf(store.swell)[1])).toEqual(['put /sync-states/:id', 'get /products']);
    expect([...store.google.inputs.keys()]).toEqual([`${DS}|en~US~p1`]);
    expect(store.collections['/queue-items']).toEqual([]);
  });
});

describe('runCourier status jobs', () => {
  it('the status refresh waits for the queue and the catalog sync', async () => {
    const products = many(PASS_PRODUCTS + 1);
    const { ctx, swell, google } = await listed(products);
    const state = await loadState(swell);
    await saveState(swell, state.id, {
      full_sync: { $set: { status: 'running', cursor: null, total: 0, done: 0, date_started: at(NOW) } },
      status_refresh: { $set: newStatusRefreshJob(NOW - MINUTE) },
    });
    await enqueue(swell, { productId: 'p00', kind: 'full' });
    expect(await runCourier(ctx)).toEqual({ next: 'idle', sent: 1 + products.length });
    const calls = googleCalls(google);
    expect(calls.lastIndexOf('insert')).toBeLessThan(calls.indexOf('status'));
    expect(calls.filter((call) => call === 'status')).toHaveLength(products.length);
    expect((await loadState(swell)).status_refresh).toMatchObject({ status: 'done', checked: products.length });
  });

  it('the status refresh waits for a queue the run left', async () => {
    // Google lost the offer of a light update: the unit is kept for the next run.
    const products = [{ ...MUG, $app: { [APP_ID]: { input_ids: ['en~US~p1'] } } }];
    const { ctx, swell, google } = await quiet(products);
    await saveState(swell, (await loadState(swell)).id, { status_refresh: { $set: newStatusRefreshJob(NOW - MINUTE) } });
    await enqueue(swell, { productId: 'p1', kind: 'light' });
    expect((await runCourier(ctx)).next).toBe('soon');
    expect(googleCalls(google)).not.toContain('status');
    expect((await loadState(swell)).status_refresh).toMatchObject({ status: 'running', cursor: null, checked: 0 });
  });

  it('the status refresh reads its own page after the queue, with the writes that wait', async () => {
    const { ctx, swell } = await listed([MUG]);
    await saveState(swell, (await loadState(swell)).id, { status_refresh: { $set: newStatusRefreshJob(NOW - MINUTE) } });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    forget(swell);
    await runCourier(ctx);
    const batches = batchesOf(swell);
    const read = batches.findIndex((batch) => batch.some((op) => op.method === 'get' && op.url === '/products' && !(op.data as any).expand));
    expect(opsOf(batches[read])).toEqual(['delete /queue-items/:id', 'get /products']);
    expect((await loadState(swell)).status_refresh).toMatchObject({ status: 'done', checked: 1 });
  });

  it('a refresh restarted during the run wins', async () => {
    const { swell, google } = await listed([MUG], { statuses: { 'en~US~p1': approved } });
    await saveState(swell, (await loadState(swell)).id, { status_refresh: { $set: newStatusRefreshJob(NOW - MINUTE) } });
    const restarted = newStatusRefreshJob(NOW);
    const restarting = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/batch/products/v1')) await saveState(swell, (await loadState(swell)).id, { status_refresh: { $set: restarted } });
      return google.fetch(input, init);
    }) as typeof fetch;
    expect(await runCourier(testContext(swell, restarting))).toEqual({ next: 'soon', sent: 0 });
    const state = await loadState(swell);
    expect(state.status_refresh).toEqual(restarted);
    expect(state.summary ?? null).toBeNull();
  });

  it('a refresh the run started survives a read that came back before the start was written', async () => {
    const { ctx, swell, collections } = await listed([MUG]);
    await saveState(swell, (await loadState(swell)).id, { status_refresh: null });
    // The platform runs a batch's entries side by side: the state read may miss the job written beside it.
    const post = swell.post.getMockImplementation()!;
    swell.post.mockImplementation(async (url: string, data: any) => {
      const starts = url === '/:batch' && data.some((op: any) => op.method === 'put' && op.url.startsWith('/sync-states/') && op.data?.status_refresh);
      const before = structuredClone(collections['/sync-states'][0]);
      const answers = await post(url, data);
      if (!starts) return answers;
      return answers.map((answer: unknown, i: number) => (data[i].method === 'get' && data[i].url.startsWith('/sync-states/') ? before : answer));
    });
    expect(await runCourier(ctx, hourly)).toEqual({ next: 'idle', sent: 0 });
    const state = await loadState(swell);
    expect(state.status_refresh).toMatchObject({ status: 'done', checked: 1, date_started: at(NOW) });
    expect(state.summary).toMatchObject({ date_refreshed: at(NOW) });
  });

  it('the summary lands when the refresh finishes', async () => {
    const products = [MUG, { ...MUG, id: 'p2', slug: 'p2' }];
    const { ctx, swell } = await listed(products, { statuses: { 'en~US~p1': approved, 'en~US~p2': disapproved('image_too_small') } });
    await saveState(swell, (await loadState(swell)).id, { status_refresh: { $set: newStatusRefreshJob(NOW - MINUTE) } });
    expect(await runCourier(ctx)).toEqual({ next: 'idle', sent: 0 });
    const state = await loadState(swell);
    expect(state.status_refresh).toMatchObject({ status: 'done', checked: 2, date_finished: at(NOW) });
    expect(state.summary).toEqual(summaryOf(state.status_refresh!));
    expect(state.summary).toMatchObject({
      counters: { approved: 1, disapproved: 1 },
      top_issues: [expect.objectContaining({ code: 'image_too_small', products: 1 })],
      date_refreshed: at(NOW),
    });
  });

  it('the orphan scan comes after the status refresh', async () => {
    const stray = { dataSource: DS, offerId: 'gone', contentLanguage: 'en', feedLabel: 'US' };
    const { ctx, swell, google, collections } = await listed([MUG], { strays: [stray] });
    await saveState(swell, (await loadState(swell)).id, { status_refresh: null, orphan_scan: null });
    expect(await runCourier(ctx, hourly)).toEqual({ next: 'idle', sent: 0 });
    expect(googleCalls(google)).toEqual(['status', 'list']);
    const state = await loadState(swell);
    expect(state.status_refresh).toMatchObject({ status: 'done' });
    expect(state.orphan_scan).toMatchObject({ status: 'done', found: 1, date_started: at(NOW) });
    expect(collections['/queue-items']).toEqual([expect.objectContaining({ product_id: 'gone', kind: 'delete', input_ids: ['en~US~gone'] })]);
  });

  it('status checks do not pace the next run', async () => {
    const store = await listed(many(STATUS_PAGE + 1));
    const state = await loadState(store.swell);
    await saveState(store.swell, state.id, { status_refresh: { $set: newStatusRefreshJob(NOW - MINUTE) }, quota: { $set: { minute_limit: 60, date_checked: at(NOW) } } });
    const slow = slowServices(store.swell, store.google.fetch, { swellMs: 1300, googleMs: 1500 });
    expect(await runCourier(testContext(slow.swell, slow.fetch, slow.now))).toEqual({ next: 'soon', sent: 0 });
    // 50 status reads at 60 inserts a minute would wait 50 s.
    const end = NOW + 3 * 1300 + 1500;
    expect((await loadAlarm(store.swell)).wake_at).toBe(at(end + NEXT_RUN_MS));
  });

  it('an hourly refresh pass ends within 8 s at 1.3 s per Swell round trip and 1.5 s per Google call', async () => {
    const store = await listed(many(STATUS_PAGE + 1));
    await saveState(store.swell, (await loadState(store.swell)).id, { status_refresh: null });
    const slow = slowServices(store.swell, store.google.fetch, { swellMs: 1300, googleMs: 1500 });
    expect(await runCourier(testContext(slow.swell, slow.fetch, slow.now), hourly)).toEqual({ next: 'soon', sent: 0 });
    // Start, the mark with the first page, Google, the writes with the new job, the end.
    expect(slow.now() - NOW).toBe(4 * 1300 + 1500);
    expect(slow.now() - NOW).toBeLessThanOrEqual(COURIER_BUDGET_MS);
    expect(store.google.batches()).toBe(1);
    expect((await loadState(store.swell)).status_refresh).toMatchObject({ status: 'running', checked: STATUS_PAGE, date_started: at(NOW + 1300) });
    expect(Math.max(...batchesOf(store.swell).map((batch) => batch.length))).toBeLessThanOrEqual(10);
  });
});

describe('pacedDelay', () => {
  it('waits the normal pause without a known limit', () => {
    expect(pacedDelay(100, null)).toBe(NEXT_RUN_MS);
  });

  it('spreads sends under the per-minute limit', () => {
    expect(pacedDelay(100, 600)).toBe(NEXT_RUN_MS);
    expect(pacedDelay(100, 120)).toBe(50_000);
  });
});
