import { describe, expect, it } from 'vitest';
import * as route from '../../functions/product';
import { createFakeSwell } from '../helpers/fake-swell';
import { createMockRequest } from '../helpers/mock-request';

const ADMIN = { appId: 'google_merchant_center', installationId: 'i1', storeId: 'test-store', storeUser: { id: 'u1' }, surface: 'admin' };
const CONNECTED = { status: 'connected', merchant_id: '123', private_key: 'SECRET-KEY', access_token: 'SECRET-TOKEN', access_token_expires: '2999-01-01T00:00:00Z' };
const PID = 'a'.repeat(24);
const MARKET = { country: 'US', language: 'en', currency: 'USD', link_template: 'https://x.example.com/{slug}', data_source: 'accounts/123/dataSources/1' };
const VARIANTS = { results: [{ id: 'v2', name: 'Small', active: true }, { id: 'v1', name: 'Large', active: false }, { id: 'v3', name: 'Old', archived: true }] };

function request(method: string, { query = {}, data = {}, context = ADMIN as unknown } = {}) {
  const fake = createFakeSwell({ connection: CONNECTED, markets: [MARKET], products: [{ id: PID, name: 'Mug', variants: VARIANTS, $app: { google_merchant_center: { sync_state: 'skipped', sync_reason: 'no_price' } } }] });
  const req = createMockRequest({ method, query, data, swell: fake.swell as any, appId: 'google_merchant_center', store: { id: 'test-store', url: 'https://test-store.swell.store' } });
  (req as any).swellContext = context;
  return { req, fake };
}

describe('product route', () => {
  it('refuses a component call without admin context', async () => {
    await expect(route.get(request('GET', { query: { id: PID }, context: null }).req)).rejects.toMatchObject({ status: 403 });
    await expect(route.get(request('GET', { query: { id: PID }, context: { ...ADMIN, surface: 'storefront' } }).req)).rejects.toMatchObject({ status: 403 });
    await expect(route.post(request('POST', { data: { op: 'resend', id: PID }, context: { ...ADMIN, storeUser: null } }).req)).rejects.toMatchObject({ status: 403 });
  });

  it('refuses the variants list without admin context', async () => {
    const { req, fake } = request('GET', { query: { id: PID, view: 'variants' }, context: { ...ADMIN, storeUser: null } });
    await expect(route.get(req)).rejects.toMatchObject({ status: 403 });
    expect(fake.swell.get).not.toHaveBeenCalled();
  });

  it('answers the product’s variants', async () => {
    const { req, fake } = request('GET', { query: { id: PID, view: 'variants' } });
    expect(await route.get(req)).toEqual({
      variants: [
        { id: 'v1', name: 'Large', active: false },
        { id: 'v2', name: 'Small', active: true },
      ],
      total: 2,
    });
    expect(fake.swell.get).toHaveBeenCalledTimes(1);
  });

  it('answers the stored status of a product', async () => {
    const view = await route.get(request('GET', { query: { id: PID, live: '0' } }).req);
    expect(view).toMatchObject({ connected: true, stored: { sync_state: 'skipped', sync_reason: 'no_price' }, live: null });
    expect(JSON.stringify(view)).not.toMatch(/SECRET/);
  });

  it('answers the preview context', async () => {
    const view = await route.get(request('GET', { query: { view: 'preview' } }).req);
    expect(view).toMatchObject({ app_id: 'google_merchant_center', markets: [{ country: 'US' }], defaults: { condition: 'new' } });
  });

  it('queues a resend', async () => {
    const { req, fake } = request('POST', { data: { op: 'resend', id: PID } });
    expect(await route.post(req)).toEqual({ queued: true });
    expect(fake.collections['/queue-items']).toHaveLength(1);
  });

  it.each([undefined, '', 'short', 'g'.repeat(24), 'a'.repeat(25)])('answers the id %s with invalid_product', async (id) => {
    const query = id === undefined ? {} : { id };
    const res = (await route.get(request('GET', { query }).req)) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_product' } });
    const variants = (await route.get(request('GET', { query: { ...query, view: 'variants' } }).req)) as Response;
    expect(await variants.json()).toMatchObject({ error: { code: 'invalid_product' } });
    const post = (await route.post(request('POST', { data: { op: 'resend', id } }).req)) as Response;
    expect(await post.json()).toMatchObject({ error: { code: 'invalid_product' } });
  });

  it('answers an unknown operation with 400', async () => {
    const res = (await route.post(request('POST', { data: { op: 'explode', id: PID } }).req)) as Response;
    expect(await res.json()).toMatchObject({ error: { code: 'unknown_op' } });
  });
});
