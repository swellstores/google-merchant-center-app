import { describe, expect, it } from 'vitest';
import * as route from '../../functions/brands';
import { createFakeSwell } from '../helpers/fake-swell';
import { createMockRequest } from '../helpers/mock-request';

const ADMIN = { appId: 'google_merchant_center', installationId: 'i1', storeId: 'test-store', storeUser: { id: 'u1' }, surface: 'admin' };

function request(context: unknown = ADMIN) {
  const fake = createFakeSwell({ products: [{ id: 'a'.repeat(24), name: 'Mug', $app: { google_merchant_center: { brand: 'Acme' } } }] });
  const req = createMockRequest({ method: 'GET', swell: fake.swell as any, appId: 'google_merchant_center', store: { id: 'test-store', url: 'https://test-store.swell.store' } });
  (req as any).swellContext = context;
  return req;
}

describe('brands route', () => {
  it('refuses a call without admin context', async () => {
    await expect(route.get(request(null))).rejects.toMatchObject({ status: 403 });
    await expect(route.get(request({ ...ADMIN, surface: 'storefront' }))).rejects.toMatchObject({ status: 403 });
    await expect(route.get(request({ ...ADMIN, storeUser: null }))).rejects.toMatchObject({ status: 403 });
  });

  it('answers the brands', async () => {
    expect(await route.get(request())).toEqual({ brands: ['Acme'] });
  });
});
