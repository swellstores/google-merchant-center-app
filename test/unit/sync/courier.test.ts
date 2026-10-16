import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConnection } from '../../../functions/lib/connection/store';
import { loadMarkets } from '../../../functions/lib/connection/markets';
import { loadAlarm, setAlarm } from '../../../functions/lib/sync/alarm';
import { NEXT_RUN_MS, pacedDelay, runCourier } from '../../../functions/lib/sync/courier';
import { enqueue, queueCount } from '../../../functions/lib/sync/queue';
import { loadState, saveState } from '../../../functions/lib/sync/state';
import type { ServiceAccountKey } from '../../../functions/lib/google/jwt';
import { APP_ID, NOW, testContext } from '../../helpers/context';
import { createFakeGoogle, type FakeGoogleOptions } from '../../helpers/fake-google';
import { batchesOf, createFakeSwell, roundTrips } from '../../helpers/fake-swell';
import { makeServiceAccountKey } from '../../helpers/keys';

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
  return store;
}

const opsOf = (batch: { method: string; url: string }[]) => batch.map((op) => `${op.method} ${op.url.replace(/\/[0-9a-f]{24}$/, '/:id')}`);

function forget(swell: ReturnType<typeof createFakeSwell>['swell']) {
  swell.get.mockClear();
  swell.post.mockClear();
  swell.put.mockClear();
  swell.delete.mockClear();
}

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
    const { ctx, swell } = setup();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    const get = swell.get;
    swell.get = (async (url: string, query?: any) => {
      if (url === '/products') throw new Error('boom');
      return get(url, query);
    }) as typeof get;
    await expect(runCourier(ctx)).rejects.toThrow('boom');
    const state = await loadState(swell);
    expect(state.running_since).toBeNull();
    expect(state.not_before).toBe(at(NOW + NEXT_RUN_MS));
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW + NEXT_RUN_MS));
  });

  it('does not retry kept units in the same run', async () => {
    const products: Record<string, any>[] = Array.from({ length: 50 }, (_, i) => ({ ...MUG, id: `p${String(i).padStart(2, '0')}`, slug: `p${i}` }));
    // Google lost the offer of a light update: the unit is kept as full, and the run has no failure.
    products[0] = { ...products[0], $app: { [APP_ID]: { input_ids: ['en~US~p00'] } } };
    const { ctx, swell, collections } = setupMany(products);
    await enqueue(swell, { productId: 'p00', kind: 'light' });
    for (const p of products.slice(1)) await enqueue(swell, { productId: p.id, kind: 'full' });
    await runCourier(ctx);
    expect(collections['/queue-items'].map((q) => [q.product_id, q.kind])).toEqual([['p00', 'full']]);
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
    const { ctx, swell } = setup();
    const state = await loadState(swell);
    await saveState(swell, state.id, { full_sync: { $set: { status: 'running', cursor: null, total: 1, done: 0, date_started: at(NOW - 60_000) } } });
    const restarted = { status: 'running', cursor: null, total: 1, done: 0, date_started: at(NOW) };
    const get = swell.get;
    let pages = 0;
    swell.get = (async (url: string, query?: any) => {
      if (url === '/products' && query?.sort === 'id asc' && ++pages === 1) await saveState(swell, state.id, { full_sync: { $set: restarted } });
      return get(url, query);
    }) as typeof get;
    expect((await runCourier(ctx)).next).toBe('soon');
    expect((await loadState(swell)).full_sync).toEqual(restarted);
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

describe('runCourier round trips', () => {
  it('sends a queue in five round trips and never reads the alarm on its own', async () => {
    const { ctx, swell, google } = await steady();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    forget(swell);
    expect(await runCourier(ctx)).toEqual({ next: 'idle', sent: 1 });
    expect(google.inputs.size).toBe(1);
    const [start, mark, sent, end] = batchesOf(swell);
    expect(opsOf(start)).toEqual(['get /connections', 'get /sync-states', 'get /alarms', 'get /markets', 'get /queue-items']);
    expect(opsOf(mark)).toEqual(['put /sync-states/:id', 'post /alarms']);
    expect(opsOf(sent)).toEqual(['put /products/p1', 'get /queue-items', 'get /sync-states/:id']);
    expect(opsOf(end)).toEqual(['delete /queue-items/:id', 'put /alarms/:id', 'put /sync-states/:id']);
    expect(swell.get.mock.calls.map(([url]) => url)).toEqual(['/products']);
    expect(swell.put).not.toHaveBeenCalled();
    expect(swell.delete).not.toHaveBeenCalled();
    expect(roundTrips(swell)).toBe(5);
  });

  it('sends a catalog page in five round trips', async () => {
    const { ctx, swell } = await steady();
    const state = await loadState(swell);
    await saveState(swell, state.id, { full_sync: { $set: { status: 'running', cursor: null, total: 0, done: 0, date_started: at(NOW) } } });
    forget(swell);
    expect(await runCourier(ctx)).toEqual({ next: 'idle', sent: 1 });
    expect(swell.get.mock.calls.map(([url]) => url)).toEqual(['/products']);
    expect(opsOf(batchesOf(swell)[2])).toEqual(['put /products/p1', 'get /sync-states/:id']);
    expect(roundTrips(swell)).toBe(5);
    expect((await loadState(swell)).full_sync).toMatchObject({ status: 'done', total: 1, done: 1 });
  });

  it('creates a missing state and alarm in its first write', async () => {
    const { ctx, swell, collections } = await steady();
    collections['/sync-states'].length = 0;
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    forget(swell);
    await runCourier(ctx);
    expect(opsOf(batchesOf(swell)[1])).toEqual(['post /sync-states', 'post /alarms']);
    expect(collections['/sync-states']).toHaveLength(1);
    expect(collections['/alarms']).toHaveLength(1);
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

  it('saves a refreshed token with its last write', async () => {
    const { ctx, swell } = await steady([MUG], {}, { access_token: null, access_token_expires: null });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    forget(swell);
    await runCourier(ctx);
    expect(swell.put).not.toHaveBeenCalled();
    expect(opsOf(batchesOf(swell).at(-1)!)).toContain('put /connections/:id');
    expect(await loadConnection(swell)).toMatchObject({ access_token: 'token-1' });
  });

  it('takes the next queue items in the round trip that settles the last ones', async () => {
    const products = Array.from({ length: 60 }, (_, i) => ({ ...MUG, id: `p${String(i).padStart(2, '0')}`, slug: `p${i}` }));
    const { ctx, swell, collections } = await steady(products);
    for (const p of products) await enqueue(swell, { productId: p.id, kind: 'full' });
    forget(swell);
    expect(await runCourier(ctx)).toEqual({ next: 'idle', sent: 60 });
    expect(collections['/queue-items']).toHaveLength(0);
    const take = batchesOf(swell)[3];
    expect(opsOf(take).filter((op) => op.startsWith('delete'))).toHaveLength(50);
    expect(opsOf(take).at(-1)).toBe('get /queue-items');
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
