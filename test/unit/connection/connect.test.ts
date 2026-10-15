import { beforeAll, describe, expect, it } from 'vitest';
import { connect, connectionStatus, disconnect } from '../../../functions/lib/connection/connect';
import { loadMarkets } from '../../../functions/lib/connection/markets';
import { loadConnection } from '../../../functions/lib/connection/store';
import { AppError } from '../../../functions/lib/context';
import type { ServiceAccountKey } from '../../../functions/lib/google/jwt';
import { loadAlarm } from '../../../functions/lib/sync/alarm';
import { enqueue, queueCount } from '../../../functions/lib/sync/queue';
import { loadState, saveState } from '../../../functions/lib/sync/state';
import { NOW, testContext } from '../../helpers/context';
import { createFakeGoogle, type FakeGoogleOptions } from '../../helpers/fake-google';
import { createFakeSwell } from '../../helpers/fake-swell';
import { makeServiceAccountKey } from '../../helpers/keys';

let key: ServiceAccountKey;
let keyJson: string;
beforeAll(async () => {
  ({ key } = await makeServiceAccountKey());
  keyJson = JSON.stringify({ type: 'service_account', ...key });
});

const INPUT = () => ({ key: keyJson, merchant_id: '123', country: 'US', link_template: 'https://shop.example.com/products/{slug}' });

function setup(options: FakeGoogleOptions = {}) {
  const google = createFakeGoogle(options);
  const fake = createFakeSwell({ products: [{ id: 'p1' }, { id: 'p2' }] });
  return { google, ...fake, ctx: testContext(fake.swell, google.fetch) };
}

describe('connectionStatus', () => {
  it('describes a store that never connected, with a default link', async () => {
    const { ctx } = setup();
    expect(await connectionStatus(ctx)).toEqual({
      connection: { status: 'disconnected', merchant_id: null, client_email: null, last_error: null, date_connected: null },
      market: null,
      defaults: { link_template: 'https://test-store.swell.store/products/{slug}' },
    });
  });
});

describe('connect', () => {
  it('stores the key, creates the market from the store and starts the catalog sync', async () => {
    const { ctx, swell } = setup();
    const result = await connect(ctx, INPUT());
    expect(result.report.ok).toBe(true);
    expect(result.connection).toMatchObject({ status: 'connected', merchant_id: '123', client_email: key.client_email });
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
    expect(result.market).toMatchObject({ country: 'US', language: 'en', currency: 'USD' });
    expect(await loadConnection(swell)).toMatchObject({ status: 'connected', private_key: key.private_key, registered: true, access_token: 'token-1' });
    expect((await loadState(swell)).full_sync).toMatchObject({ status: 'running', total: 2 });
    expect((await loadAlarm(swell)).wake_at).toBe(new Date(NOW).toISOString());
  });

  it('keeps the key but stays disconnected when a check fails', async () => {
    const { ctx, swell } = setup({ homepage: { claimed: false } });
    const result = await connect(ctx, INPUT());
    expect(result.report.ok).toBe(false);
    expect(result.connection.status).toBe('disconnected');
    expect(result.connection.last_error).toContain('not verified');
    expect((await loadConnection(swell))?.private_key).toBe(key.private_key);
    expect(await loadMarkets(swell)).toHaveLength(0);
  });

  it('checks again with the stored key when none is pasted', async () => {
    const { ctx } = setup();
    await connect(ctx, INPUT());
    const again = await connect(ctx, { ...INPUT(), key: undefined });
    expect(again.report.ok).toBe(true);
  });

  it.each([
    [{ key: undefined }, 'key_required'],
    [{ merchant_id: 'abc' }, 'invalid_merchant_id'],
    [{ country: 'usa' }, 'invalid_country'],
    [{ link_template: 'http://shop.example.com/products/{slug}' }, 'invalid_link'],
    [{ link_template: 'https://shop.example.com/products' }, 'invalid_link'],
  ])('refuses %j', async (change, code) => {
    const { ctx } = setup();
    const error = await connect(ctx, { ...INPUT(), ...change }).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(code);
  });
});

describe('disconnect', () => {
  it('removes the products from Google, wipes the key and stops the courier', async () => {
    const { ctx, swell, google } = setup();
    await connect(ctx, INPUT());
    const [market] = await loadMarkets(swell);
    await swell.put(`/markets/${market.id}`, { data_source: 'accounts/123/dataSources/1' });
    google.dataSources.add('accounts/123/dataSources/1');
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await saveState(swell, (await loadState(swell)).id, { not_before: new Date(NOW + 600_000).toISOString() });

    await disconnect(ctx, true);

    expect(google.dataSources.size).toBe(0);
    expect(await loadConnection(swell)).toMatchObject({ status: 'disconnected', private_key: null, access_token: null });
    expect((await loadMarkets(swell))[0].data_source).toBeNull();
    expect(await queueCount(swell)).toBe(0);
    expect((await loadState(swell)).full_sync).toBeNull();
    expect((await loadState(swell)).not_before).toBeNull();
    expect((await loadAlarm(swell)).wake_at).toBeNull();
  });

  it('leaves Google alone when asked to keep the products', async () => {
    const { ctx, swell, google } = setup();
    await connect(ctx, INPUT());
    const [market] = await loadMarkets(swell);
    await swell.put(`/markets/${market.id}`, { data_source: 'accounts/123/dataSources/1' });
    google.dataSources.add('accounts/123/dataSources/1');
    await disconnect(ctx, false);
    expect(google.dataSources.size).toBe(1);
  });
});
