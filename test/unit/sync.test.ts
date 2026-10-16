import { describe, expect, it } from 'vitest';
import * as route from '../../functions/sync';
import { createFakeSwell } from '../helpers/fake-swell';
import { createMockRequest } from '../helpers/mock-request';
import { loadState } from '../helpers/store';

const ADMIN = { appId: 'google_merchant_center', installationId: 'i1', storeId: 'test-store', storeUser: { id: 'u1' }, surface: 'admin' };
const CONNECTED = { status: 'connected', merchant_id: '123', private_key: 'SECRET-KEY', access_token: 'SECRET-TOKEN' };

function request(method: string, data: Record<string, any> = {}, swellContext: unknown = ADMIN, { swell } = createFakeSwell({ connection: CONNECTED })) {
  const req = createMockRequest({ method, data, swell: swell as any, appId: 'google_merchant_center', store: { id: 'test-store', url: 'https://test-store.swell.store' } });
  (req as any).swellContext = swellContext;
  return req;
}

describe('sync route', () => {
  it('names the component it serves', () => {
    expect(route.config.description).toBe('Sync dashboard data and actions, for the SyncDashboard component');
  });

  it('refuses a component call without admin context', async () => {
    await expect(route.get(request('GET', {}, null))).rejects.toMatchObject({ status: 403 });
    await expect(route.get(request('GET', {}, { ...ADMIN, surface: 'storefront' }))).rejects.toMatchObject({ status: 403 });
    await expect(route.post(request('POST', { op: 'sync_all' }, { ...ADMIN, storeUser: null }))).rejects.toMatchObject({ status: 403 });
  });

  it('returns the dashboard to an admin, without key or token', async () => {
    const view = await route.get(request('GET'));
    expect(view).toMatchObject({ connection: { status: 'connected', merchant_id: '123' }, queue: 0 });
    expect(JSON.stringify(view)).not.toMatch(/SECRET/);
  });

  it('starts the catalog sync on sync_all', async () => {
    const store = createFakeSwell({ connection: CONNECTED });
    const view = await route.post(request('POST', { op: 'sync_all' }, ADMIN, store));
    expect(view).toMatchObject({ full_sync: { status: 'running' } });
    expect((await loadState(store.swell)).full_sync?.status).toBe('running');
  });

  it('starts a refresh on refresh_statuses', async () => {
    const view = await route.post(request('POST', { op: 'refresh_statuses' }));
    expect(view).toMatchObject({ refresh: { status: 'running' } });
  });

  it('answers a disconnected store with 409', async () => {
    const res = (await route.post(request('POST', { op: 'sync_all' }, ADMIN, createFakeSwell()))) as Response;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'not_connected', message: expect.any(String) } });
  });

  it.each(['explode', undefined])('answers the unknown operation %s with 400', async (op) => {
    const res = (await route.post(request('POST', { op }))) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'unknown_op' } });
  });
});
