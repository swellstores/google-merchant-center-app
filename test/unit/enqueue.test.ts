import { describe, expect, it } from 'vitest';
import enqueueFunction from '../../functions/enqueue';
import { createFakeSwell } from '../helpers/fake-swell';
import { createMockRequest } from '../helpers/mock-request';

const request = (swell: any, data: Record<string, any>) =>
  createMockRequest({ swell, data, appId: 'google_merchant_center', store: { id: 'test-store', url: 'https://test-store.swell.store' } });

describe('enqueue function', () => {
  it('does nothing while Google is not connected', async () => {
    const { swell, collections } = createFakeSwell();
    await enqueueFunction(request(swell, { id: 'p1', $event: { type: 'product.created', data: { id: 'p1' } } }));
    expect(collections['/queue-items']).toHaveLength(0);
    expect(collections['/alarms']).toHaveLength(0);
  });

  it('queues the product and arms the alarm', async () => {
    const { swell, collections } = createFakeSwell({ connection: { status: 'connected', merchant_id: '123' } });
    await enqueueFunction(request(swell, { id: 'p1', $event: { type: 'product.updated', data: { price: 5 } } }));
    expect(collections['/queue-items']).toEqual([expect.objectContaining({ product_id: 'p1', kind: 'light' })]);
    expect(collections['/alarms'][0].wake_at).toEqual(expect.any(String));
  });

  it('ignores its own writes', async () => {
    const { swell, collections } = createFakeSwell({ connection: { status: 'connected', merchant_id: '123' } });
    const data = { $app: { google_merchant_center: { sync_state: 'sent' } } };
    await enqueueFunction(request(swell, { id: 'p1', $event: { type: 'product.updated', data } }));
    expect(collections['/queue-items']).toHaveLength(0);
  });
});
