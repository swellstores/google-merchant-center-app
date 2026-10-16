import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as route from '../../functions/connection';
import { createFakeGoogle } from '../helpers/fake-google';
import { createFakeSwell } from '../helpers/fake-swell';
import { makeServiceAccountKey } from '../helpers/keys';
import { createMockRequest } from '../helpers/mock-request';

let keyJson: string;
beforeAll(async () => {
  const { key } = await makeServiceAccountKey();
  keyJson = JSON.stringify({ type: 'service_account', ...key });
});

const ADMIN = { appId: 'google_merchant_center', installationId: 'i1', storeId: 'test-store', storeUser: { id: 'u1' }, surface: 'admin' };

function request(method: string, data: Record<string, any> = {}, swellContext: unknown = ADMIN, { swell } = createFakeSwell()) {
  const req = createMockRequest({ method, data, swell: swell as any, appId: 'google_merchant_center', store: { id: 'test-store', url: 'https://test-store.swell.store' } });
  (req as any).swellContext = swellContext;
  return req;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('connection route', () => {
  it('refuses calls that are not from an admin component', async () => {
    await expect(route.get(request('GET', {}, null))).rejects.toMatchObject({ status: 403 });
    await expect(route.get(request('GET', {}, { ...ADMIN, surface: undefined }))).rejects.toMatchObject({ status: 403 });
    await expect(route.get(request('GET', {}, { ...ADMIN, storeUser: null }))).rejects.toMatchObject({ status: 403 });
  });

  it('returns the status to an admin', async () => {
    const status = await route.get(request('GET'));
    expect(status).toMatchObject({ connection: { status: 'disconnected' }, market: null });
  });

  it('answers a bad request with the error code and message', async () => {
    vi.stubGlobal('fetch', createFakeGoogle().fetch);
    const res = (await route.post(request('POST', { op: 'check', merchant_id: '123' }))) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'key_required', message: expect.any(String) } });
  });

  it('checks the connection, then starts syncing', async () => {
    vi.stubGlobal('fetch', createFakeGoogle().fetch);
    const store = createFakeSwell();
    const checked = await route.post(request('POST', { op: 'check', key: keyJson, merchant_id: '123' }, ADMIN, store));
    expect(checked).toMatchObject({ connection: { status: 'connected' }, report: { ok: true } });
    const started = await route.post(request('POST', { op: 'activate', country: 'US', link_template: 'https://x.example.com/{slug}' }, ADMIN, store));
    expect(started).toMatchObject({ connection: { status: 'connected' }, market: { country: 'US' }, defaults: expect.any(Object) });
  });

  it('refuses to start syncing before the connection is checked', async () => {
    const res = (await route.post(request('POST', { op: 'activate', country: 'US', link_template: 'https://x.example.com/{slug}' }))) as Response;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'not_connected', message: expect.any(String) } });
  });

  it('refuses a POST that is not from an admin component', async () => {
    await expect(route.post(request('POST', { op: 'disconnect' }, null))).rejects.toMatchObject({ status: 403 });
  });

  it.each(['explode', 'connect'])('answers the unknown operation %s with 400', async (op) => {
    const res = (await route.post(request('POST', { op }))) as Response;
    expect(res.status).toBe(400);
  });
});
