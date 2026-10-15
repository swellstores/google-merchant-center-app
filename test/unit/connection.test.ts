import { afterEach, describe, expect, it, vi } from 'vitest';
import * as route from '../../functions/connection';
import { createFakeGoogle } from '../helpers/fake-google';
import { createFakeSwell } from '../helpers/fake-swell';
import { createMockRequest } from '../helpers/mock-request';

const ADMIN = { appId: 'google_merchant_center', installationId: 'i1', storeId: 'test-store', storeUser: { id: 'u1' }, surface: 'admin' };

function request(method: string, data: Record<string, any> = {}, swellContext: unknown = ADMIN) {
  const { swell } = createFakeSwell();
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
    const res = (await route.post(request('POST', { op: 'connect', merchant_id: '123', country: 'US', link_template: 'https://x.example.com/{slug}' }))) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'key_required', message: expect.any(String) } });
  });

  it('refuses a POST that is not from an admin component', async () => {
    await expect(route.post(request('POST', { op: 'disconnect' }, null))).rejects.toMatchObject({ status: 403 });
  });

  it('answers an unknown operation with 400', async () => {
    const res = (await route.post(request('POST', { op: 'explode' }))) as Response;
    expect(res.status).toBe(400);
  });
});
