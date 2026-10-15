import { beforeAll, describe, expect, it } from 'vitest';
import { loadConnection } from '../../../functions/lib/connection/store';
import { loadMarkets } from '../../../functions/lib/connection/markets';
import { loadAlarm } from '../../../functions/lib/sync/alarm';
import { NEXT_RUN_MS, pacedDelay, runCourier } from '../../../functions/lib/sync/courier';
import { enqueue, queueCount } from '../../../functions/lib/sync/queue';
import { loadState, saveState } from '../../../functions/lib/sync/state';
import type { ServiceAccountKey } from '../../../functions/lib/google/jwt';
import { NOW, testContext } from '../../helpers/context';
import { createFakeGoogle, type FakeGoogleOptions } from '../../helpers/fake-google';
import { createFakeSwell } from '../../helpers/fake-swell';
import { makeServiceAccountKey } from '../../helpers/keys';

let key: ServiceAccountKey;
beforeAll(async () => {
  ({ key } = await makeServiceAccountKey());
});

const at = (ms: number) => new Date(ms).toISOString();
const MUG = { id: 'p1', name: 'Mug', slug: 'mug', active: true, price: 12, images: [{ file: { url: 'https://cdn.example.com/mug.jpg' } }] };

function setup(googleOptions: FakeGoogleOptions = {}, connection: Record<string, any> = {}) {
  const google = createFakeGoogle(googleOptions);
  const fake = createFakeSwell({
    products: [MUG],
    connection: {
      status: 'connected',
      merchant_id: '123',
      client_email: key.client_email,
      private_key: key.private_key,
      access_token: 'cached',
      access_token_expires: at(NOW + 3600_000),
      ...connection,
    },
    markets: [{ country: 'US', language: 'en', currency: 'USD', link_template: 'https://shop.example.com/products/{slug}' }],
  });
  return { google, ...fake, ctx: testContext(fake.swell, google.fetch) };
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
  });

  it('exits and re-arms while another run is fresh', async () => {
    const { ctx, swell, google } = setup();
    const state = await loadState(swell);
    await saveState(swell, state.id, { running_since: at(NOW - 5_000) });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    expect(await runCourier(ctx)).toEqual({ next: 'soon', sent: 0 });
    expect(google.requests).toHaveLength(0);
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW + NEXT_RUN_MS));
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

  it('backs off after a rate limit and keeps the queue', async () => {
    const { ctx, swell } = setup({ batch: { status: 429, body: { error: { message: 'quota/request_rate_too_high' } } } });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    expect((await runCourier(ctx)).next).toBe('later');
    expect(await queueCount(swell)).toBe(1);
    expect((await loadState(swell)).backoff).toBe(1);
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW + 30_000));
  });

  it('pauses until noon UTC when the daily quota is gone', async () => {
    const { ctx, swell } = setup({ batch: { status: 429, body: { error: { message: 'quota/daily_limit_exceeded' } } } });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    expect((await runCourier(ctx)).next).toBe('paused');
    const noon = Date.UTC(2026, 9, 15, 12);
    expect((await loadState(swell)).quota).toMatchObject({ exhausted_until: at(noon) });
    expect((await loadAlarm(swell)).wake_at).toBe(at(noon));
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

describe('pacedDelay', () => {
  it('waits the normal pause without a known limit', () => {
    expect(pacedDelay(100, null)).toBe(NEXT_RUN_MS);
  });

  it('spreads sends under the per-minute limit', () => {
    expect(pacedDelay(100, 600)).toBe(NEXT_RUN_MS);
    expect(pacedDelay(100, 120)).toBe(50_000);
  });
});
