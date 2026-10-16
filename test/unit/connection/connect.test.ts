import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { activate, check, connectionStatus, disconnect } from '../../../functions/lib/connection/connect';
import { loadMarkets } from '../../../functions/lib/connection/markets';
import { loadConnection, saveConnection } from '../../../functions/lib/connection/store';
import { AppError, type AppContext } from '../../../functions/lib/context';
import type { ServiceAccountKey } from '../../../functions/lib/google/jwt';
import { loadAlarm, setAlarm } from '../../../functions/lib/sync/alarm';
import { enqueue, queueCount } from '../../../functions/lib/sync/queue';
import { loadState, saveState } from '../../../functions/lib/sync/state';
import { fixedClock, NOW, slowServices, testContext } from '../../helpers/context';
import { createFakeGoogle, type FakeGoogleOptions } from '../../helpers/fake-google';
import { batchesOf, createFakeSwell, roundTrips } from '../../helpers/fake-swell';
import { makeServiceAccountKey } from '../../helpers/keys';

let key: ServiceAccountKey;
let keyJson: string;
beforeAll(async () => {
  ({ key } = await makeServiceAccountKey());
  keyJson = JSON.stringify({ type: 'service_account', ...key });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const at = (ms: number) => new Date(ms).toISOString();
const MARKET = { country: 'US', link_template: 'https://shop.example.com/products/{slug}' };
const CHECK = () => ({ key: keyJson, merchant_id: '123', ...MARKET });

function setup(options: FakeGoogleOptions = {}) {
  const google = createFakeGoogle(options);
  const fake = createFakeSwell({ products: [{ id: 'p1' }, { id: 'p2' }] });
  return { google, ...fake, ctx: testContext(fake.swell, google.fetch) };
}

/** The same store a minute later, as a later admin request sees it. */
const later = (ctx: AppContext, minutes = 1) => ({ ...ctx, now: fixedClock(NOW + minutes * 60_000) });

function forget(swell: ReturnType<typeof createFakeSwell>['swell']) {
  swell.get.mockClear();
  swell.post.mockClear();
  swell.put.mockClear();
  swell.delete.mockClear();
}

async function connect(ctx: AppContext, market = MARKET, input = CHECK()) {
  const checked = await check(ctx, { ...input, ...market });
  return checked.report.ok ? activate(ctx, market) : null;
}

describe('connectionStatus', () => {
  it('describes a store that never connected, with a default link', async () => {
    const { ctx } = setup();
    expect(await connectionStatus(ctx)).toEqual({
      connection: { status: 'disconnected', merchant_id: null, client_email: null, has_key: false, last_error: null, date_connected: null },
      market: null,
      defaults: { link_template: 'https://test-store.swell.store/products/{slug}' },
    });
  });
});

describe('check', () => {
  it('stores the key and connects the store with the token cached', async () => {
    const { ctx, swell } = setup();
    const result = await check(ctx, CHECK());
    expect(result.report.ok).toBe(true);
    expect(result.connection).toMatchObject({ status: 'connected', merchant_id: '123', client_email: key.client_email, has_key: true, date_connected: at(NOW) });
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
    expect(await loadConnection(swell)).toMatchObject({ status: 'connected', private_key: key.private_key, registered: true, access_token: 'token-1' });
    expect(await loadMarkets(swell)).toHaveLength(0);
  });

  it('needs at most four Google calls and four Swell round trips', async () => {
    const { ctx, swell, google } = setup();
    await check(ctx, CHECK());
    expect(google.requests).toHaveLength(4);
    expect(roundTrips(swell)).toBeLessThanOrEqual(4);
  });

  it('keeps the key but stays disconnected when a check fails', async () => {
    const { ctx, swell } = setup({ homepage: { claimed: false } });
    const result = await check(ctx, CHECK());
    expect(result.report.ok).toBe(false);
    expect(result.connection.status).toBe('disconnected');
    expect(result.connection.last_error).toContain('not verified');
    expect(await loadConnection(swell)).toMatchObject({ private_key: key.private_key, merchant_id: '123' });
  });

  it('checks again with the stored key when none is pasted', async () => {
    const { ctx, swell } = setup();
    await check(ctx, CHECK());
    forget(swell);
    expect((await check(later(ctx), { ...CHECK(), key: undefined })).report.ok).toBe(true);
    // The key did not change: one read and the result.
    expect(roundTrips(swell)).toBe(2);
  });

  it('leaves a connected store connected while the checks run', async () => {
    const { swell, google } = setup();
    await check(testContext(swell, google.fetch), CHECK());
    const seen: string[] = [];
    const watching = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/homepage')) seen.push((await loadConnection(swell))!.status);
      return google.fetch(input, init);
    }) as typeof fetch;
    await check(testContext(swell, watching, fixedClock(NOW + 60_000)), CHECK());
    expect(seen).toEqual(['connected']);
  });

  it('pauses a connected store whose check fails', async () => {
    const { ctx, swell } = setup();
    await check(ctx, CHECK());
    const failing = createFakeGoogle({ homepage: { claimed: false } });
    const result = await check(testContext(swell, failing.fetch), CHECK());
    expect(result.connection).toMatchObject({ status: 'disconnected', last_error: expect.stringContaining('not verified') });
  });

  it.each([
    [{ key: undefined }, 'key_required'],
    [{ merchant_id: 'abc' }, 'invalid_merchant_id'],
  ])('refuses %j', async (change, code) => {
    const { ctx } = setup();
    const error = await check(ctx, { ...CHECK(), ...change }).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(code);
  });

  it.each([
    [{ country: 'usa' }, 'invalid_country'],
    [{ link_template: 'https://shop.example.com/products' }, 'invalid_link'],
  ])('refuses %j before it writes anything', async (change, code) => {
    const { ctx, swell, collections, google } = setup();
    const error = await check(ctx, { ...CHECK(), ...change }).catch((e) => e);
    expect(error).toMatchObject({ code });
    expect(swell.post).not.toHaveBeenCalled();
    expect(swell.put).not.toHaveBeenCalled();
    expect(collections['/connections']).toHaveLength(0);
    expect(google.requests).toHaveLength(0);
  });

  it("forgets another account's data sources when it connects to a new one", async () => {
    const { ctx, swell } = setup();
    await connect(ctx);
    const [market] = await loadMarkets(swell);
    await swell.put(`/markets/${market.id}`, { data_source: 'accounts/123/dataSources/1' });
    forget(swell);
    expect((await check(later(ctx), { ...CHECK(), merchant_id: '456' })).report.ok).toBe(true);
    expect((await loadMarkets(swell))[0].data_source).toBeNull();
    const success = batchesOf(swell).at(-1)!;
    expect(success.map((op) => `${op.method} ${op.url.split('/')[1]}`)).toEqual(['put connections', 'put markets']);
  });

  it("keeps the account's own data sources on a repeated check", async () => {
    const { ctx, swell } = setup();
    await connect(ctx);
    const [market] = await loadMarkets(swell);
    await swell.put(`/markets/${market.id}`, { data_source: 'accounts/123/dataSources/1' });
    await check(later(ctx), CHECK());
    expect((await loadMarkets(swell))[0].data_source).toBe('accounts/123/dataSources/1');
  });

  it('fails when Swell refuses to store the result', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ctx, refuse } = setup();
    await check(ctx, CHECK());
    refuse((method, url) => (method === 'put' && url.startsWith('/connections/') ? 'Permission denied' : null));
    await expect(check(later(ctx), CHECK())).rejects.toThrow('Permission denied');
  });
});

describe('activate', () => {
  it('needs a connected store', async () => {
    const { ctx } = setup();
    const error = await activate(ctx, MARKET).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'not_connected', status: 409 });
  });

  it('creates the market from the store and starts the catalog sync in one write', async () => {
    const { ctx, swell } = setup();
    await check(ctx, CHECK());
    forget(swell);
    const view = await activate(later(ctx), MARKET);
    // One batch read alongside the store details, one batch write; no product count.
    expect(swell.get.mock.calls.map(([url]) => url)).toEqual(['/:details']);
    expect(batchesOf(swell)).toHaveLength(2);
    expect(roundTrips(swell)).toBe(3);
    expect(view.connection).toMatchObject({ status: 'connected', merchant_id: '123' });
    expect(view.market).toMatchObject({ country: 'US', language: 'en', currency: 'USD', link_template: MARKET.link_template, data_source: null });
    expect((await loadState(swell)).full_sync).toEqual({ status: 'running', cursor: null, total: 0, done: 0, date_started: at(NOW + 60_000), date_finished: null });
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW + 60_000));
  });

  it('creates the state of a fresh store with the job as a plain object', async () => {
    const { ctx, swell, collections } = setup();
    expect(collections['/sync-states']).toHaveLength(0);
    await connect(ctx);
    expect(collections['/sync-states']).toEqual([expect.objectContaining({ full_sync: expect.objectContaining({ status: 'running', cursor: null }) })]);
    expect(batchesOf(swell).flat().find((op) => op.method === 'post' && op.url === '/sync-states')?.data).toEqual({
      backoff: 0,
      full_sync: { status: 'running', cursor: null, total: 0, done: 0, date_started: at(NOW), date_finished: null },
    });
  });

  it.each(['/sync-states', '/alarms'])('fails when Swell refuses its write to %s', async (path) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ctx, refuse } = setup();
    await check(ctx, CHECK());
    refuse((method, url) => (method !== 'get' && url.startsWith(path) ? 'Permission denied' : null));
    await expect(activate(later(ctx), MARKET)).rejects.toThrow('Permission denied');
  });

  it('does not restart the catalog sync on a repeated check', async () => {
    const { ctx, swell } = setup();
    await connect(ctx);
    const state = await loadState(swell);
    await saveState(swell, state.id, { full_sync: { $set: { ...state.full_sync, cursor: 'p1' } } });
    expect(await connect(later(ctx))).not.toBeNull();
    expect((await loadState(swell)).full_sync).toMatchObject({ status: 'running', cursor: 'p1' });
  });

  it('wakes the courier for waiting work when it does not restart', async () => {
    const { ctx, swell } = setup();
    await connect(ctx);
    const state = await loadState(swell);
    await saveState(swell, state.id, { full_sync: { $set: { ...state.full_sync, status: 'done' } } });
    await setAlarm(ctx, null);
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await connect(later(ctx));
    expect((await loadState(swell)).full_sync).toMatchObject({ status: 'done' });
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW + 60_000));
  });

  it('leaves the alarm alone when nothing waits', async () => {
    const { ctx, swell } = setup();
    await connect(ctx);
    const state = await loadState(swell);
    await saveState(swell, state.id, { full_sync: { $set: { ...state.full_sync, status: 'done' } } });
    await setAlarm(ctx, null);
    await connect(later(ctx));
    expect((await loadAlarm(swell)).wake_at).toBeNull();
  });

  it('restarts it when the link changes', async () => {
    const { ctx, swell } = setup();
    await connect(ctx);
    const state = await loadState(swell);
    await saveState(swell, state.id, { full_sync: { $set: { ...state.full_sync, cursor: 'p1' } } });
    await connect(later(ctx), { ...MARKET, link_template: 'https://shop.example.com/p/{product_id}' });
    expect((await loadState(swell)).full_sync).toMatchObject({ status: 'running', cursor: null });
  });

  it('restarts it when the store connects again after a failed check', async () => {
    const { ctx, swell } = setup();
    await connect(ctx);
    const state = await loadState(swell);
    await saveState(swell, state.id, { full_sync: { $set: { ...state.full_sync, cursor: 'p1' } } });
    const failing = createFakeGoogle({ homepage: { claimed: false } });
    await check(testContext(swell, failing.fetch, fixedClock(NOW + 60_000)), CHECK());
    await connect(later(ctx, 2));
    expect((await loadState(swell)).full_sync).toMatchObject({ status: 'running', cursor: null, date_started: at(NOW + 120_000) });
  });

  it('restarts it for another Merchant Center account', async () => {
    const { ctx, swell } = setup();
    await connect(ctx);
    const state = await loadState(swell);
    await saveState(swell, state.id, { full_sync: { $set: { ...state.full_sync, cursor: 'p1' } } });
    await connect(later(ctx), MARKET, { ...CHECK(), merchant_id: '456' });
    expect((await loadState(swell)).full_sync).toMatchObject({ cursor: null, date_started: at(NOW + 60_000) });
  });

  it("drops another account's data source after a failed attempt", async () => {
    const fake = createFakeSwell({
      products: [{ id: 'p1' }],
      markets: [{ country: 'US', language: 'en', currency: 'USD', link_template: 'https://shop.example.com/products/{slug}', data_source: 'accounts/999/dataSources/1' }],
    });
    await saveConnection(fake.swell, null, {
      status: 'connected', merchant_id: '999', client_email: key.client_email, private_key: key.private_key,
      private_key_id: key.private_key_id ?? null, project_id: key.project_id ?? null,
    });
    const failing = createFakeGoogle({ homepage: { claimed: false } });
    expect((await check(testContext(fake.swell, failing.fetch), CHECK())).report.ok).toBe(false);
    const working = createFakeGoogle();
    expect(await connect(testContext(fake.swell, working.fetch))).not.toBeNull();
    expect((await loadMarkets(fake.swell))[0].data_source).toBeNull();
    expect(working.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
  });

  it('replaces the market of another country and removes its data source from Google', async () => {
    const { ctx, swell, google } = setup();
    await connect(ctx);
    const [us] = await loadMarkets(swell);
    await swell.put(`/markets/${us.id}`, { data_source: 'accounts/123/dataSources/1' });
    google.dataSources.add('accounts/123/dataSources/1');
    const view = await connect(later(ctx), { ...MARKET, country: 'GB' });
    expect(view?.market).toMatchObject({ country: 'GB', data_source: null });
    expect(google.dataSources.size).toBe(0);
    expect((await loadMarkets(swell)).map((m) => m.country)).toEqual(['GB']);
  });

  it.each([
    [{ country: 'usa' }, 'invalid_country'],
    [{ link_template: 'http://shop.example.com/products/{slug}' }, 'invalid_link'],
    [{ link_template: 'https://shop.example.com/products' }, 'invalid_link'],
  ])('refuses %j', async (change, code) => {
    const { ctx } = setup();
    await check(ctx, CHECK());
    const error = await activate(ctx, { ...MARKET, ...change }).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(code);
  });
});

describe('disconnect', () => {
  it('removes the products from Google, wipes the key and stops the courier', async () => {
    const { ctx, swell, google } = setup();
    await connect(ctx);
    const [market] = await loadMarkets(swell);
    await swell.put(`/markets/${market.id}`, { data_source: 'accounts/123/dataSources/1' });
    google.dataSources.add('accounts/123/dataSources/1');
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await saveState(swell, (await loadState(swell)).id, { not_before: new Date(NOW + 600_000).toISOString() });
    forget(swell);

    const view = await disconnect(ctx, true);

    const [, critical, deletes] = batchesOf(swell).map((batch) => batch.map((op) => `${op.method} ${op.url.split('/')[1]}`));
    expect(critical).toEqual(['put connections', 'put sync-states', 'put alarms', 'put markets']);
    expect(deletes).toEqual(['delete queue-items']);
    expect(roundTrips(swell)).toBe(3);
    expect(view).toEqual({
      connection: expect.objectContaining({ status: 'disconnected', has_key: false }),
      market: expect.objectContaining({ country: 'US', data_source: null }),
      defaults: { link_template: 'https://test-store.swell.store/products/{slug}' },
    });
    expect(google.dataSources.size).toBe(0);
    expect(await loadConnection(swell)).toMatchObject({ status: 'disconnected', private_key: null, access_token: null });
    expect((await loadMarkets(swell))[0].data_source).toBeNull();
    expect(await queueCount(swell)).toBe(0);
    expect((await loadState(swell)).full_sync).toBeNull();
    expect((await loadState(swell)).not_before).toBeNull();
    expect((await loadAlarm(swell)).wake_at).toBeNull();
    expect((await connectionStatus(ctx)).connection.has_key).toBe(false);
  });

  async function bigQueue(size: number) {
    const store = setup();
    await connect(store.ctx);
    for (let i = 0; i < size; i++) await enqueue(store.swell, { productId: `p${i}`, kind: 'full' });
    forget(store.swell);
    return store;
  }

  it('clears the whole queue when it has the time, one server wave per round trip', async () => {
    const { ctx, swell } = await bigQueue(120);
    await disconnect(ctx, false);
    expect(await queueCount(swell)).toBe(0);
    const deletes = batchesOf(swell).filter((batch) => batch[0].method === 'delete');
    expect(deletes.map((batch) => batch.length)).toEqual(Array(12).fill(10));
  });

  it('writes what matters first and stops deleting queue items at 7 s', async () => {
    const { swell, google } = await bigQueue(120);
    const slow = slowServices(swell, google.fetch, { swellMs: 1200, googleMs: 1000 });
    await disconnect(testContext(slow.swell, slow.fetch, slow.now), false);
    const batches = batchesOf(swell);
    expect(batches[1].map((op) => op.method)).toEqual(['put', 'put', 'put']);
    expect(Math.max(...batches.filter((batch) => batch[0].method === 'delete').map((batch) => batch.length))).toBeLessThanOrEqual(50);
    // Read 1.2 s, the critical writes 2.4 s, then deletes while one more fits before 7 s.
    expect(slow.now() - NOW).toBe(6000);
    expect(await queueCount(swell)).toBe(120 - 30);
    expect(await loadConnection(swell)).toMatchObject({ status: 'disconnected', private_key: null });
  });

  it('stops at queue items Swell refuses to delete', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ctx, swell, refuse } = await bigQueue(120);
    refuse((method, url) => (method === 'delete' && url.startsWith('/queue-items/') ? 'Permission denied' : null));
    await disconnect(ctx, false);
    expect(await queueCount(swell)).toBe(120);
    expect(batchesOf(swell).filter((batch) => batch[0].method === 'delete')).toHaveLength(12);
  });

  it('fails when Swell refuses to wipe the key', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ctx, refuse } = setup();
    await connect(ctx);
    refuse((method, url) => (method === 'put' && url.startsWith('/connections/') ? 'Permission denied' : null));
    await expect(disconnect(ctx, false)).rejects.toThrow('Permission denied');
  });

  it('leaves Google alone when asked to keep the products', async () => {
    const { ctx, swell, google } = setup();
    await connect(ctx);
    const [market] = await loadMarkets(swell);
    await swell.put(`/markets/${market.id}`, { data_source: 'accounts/123/dataSources/1' });
    google.dataSources.add('accounts/123/dataSources/1');
    await disconnect(ctx, false);
    expect(google.dataSources.size).toBe(1);
  });

  it('treats an already deleted data source as removed', async () => {
    const { ctx, swell } = setup();
    await connect(ctx);
    const [market] = await loadMarkets(swell);
    await swell.put(`/markets/${market.id}`, { data_source: 'accounts/123/dataSources/1' });
    await disconnect(ctx, true);
    expect(await loadConnection(swell)).toMatchObject({ status: 'disconnected', last_error: null });
  });

  it('records why the products could not be removed and still disconnects', async () => {
    const { ctx, swell } = setup();
    await connect(ctx);
    const [market] = await loadMarkets(swell);
    await swell.put(`/markets/${market.id}`, { data_source: 'accounts/123/dataSources/1' });
    const connection = await loadConnection(swell);
    await saveConnection(swell, connection!.id, { access_token: null, access_token_expires: null });
    const broken = createFakeGoogle({ token: { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } });
    await disconnect(testContext(swell, broken.fetch), true);
    const after = await loadConnection(swell);
    expect(after).toMatchObject({ status: 'disconnected', private_key: null });
    expect(after?.last_error).toContain('Products could not be removed from Google');
  });
});
