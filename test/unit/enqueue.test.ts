import { afterEach, describe, expect, it, vi } from 'vitest';
import enqueueFunction from '../../functions/enqueue';
import { batchesOf, createFakeSwell, roundTrips } from '../helpers/fake-swell';
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

  it('ignores its own writes when the event shows an operator in the app’s fields', async () => {
    const { swell, collections } = createFakeSwell({ connection: { status: 'connected', merchant_id: '123' } });
    const data = { $app: { google_merchant_center: { sync_state: 'sent', $set: { input_ids: ['en~US~p1'] } } } };
    await enqueueFunction(request(swell, { id: 'p1', $event: { type: 'product.updated', data } }));
    expect(collections['/queue-items']).toHaveLength(0);
    expect(roundTrips(swell)).toBe(0);
  });

  it('reads in one round trip and writes in one', async () => {
    const { swell, collections } = createFakeSwell({ connection: { status: 'connected', merchant_id: '123' } });
    await enqueueFunction(request(swell, { id: 'p1', $event: { type: 'product.created', data: { id: 'p1' } } }));
    const [read, write] = batchesOf(swell).map((batch) => batch.map((op) => `${op.method} ${op.url}`));
    expect(read).toEqual(['get /connections', 'get /queue-items', 'get /alarms']);
    expect(write).toEqual(['post /queue-items', 'post /alarms']);
    expect(roundTrips(swell)).toBe(2);
    expect(collections['/queue-items']).toEqual([expect.objectContaining({ product_id: 'p1', kind: 'full', revision: 0 })]);
  });

  it('merges into the product’s item with a new revision and keeps an alarm that rings sooner', async () => {
    const { swell, collections } = createFakeSwell({ connection: { status: 'connected', merchant_id: '123' } });
    collections['/queue-items'].push({ id: 'q1', product_id: 'p1', kind: 'light', input_ids: [], done_input_ids: ['en~US~p1'], revision: 2 });
    const soon = new Date(Date.now() + 5_000).toISOString();
    collections['/alarms'].push({ id: 'a1', wake_at: soon });
    await enqueueFunction(request(swell, { id: 'p1', $event: { type: 'product.updated', data: { name: 'New' } } }));
    expect(batchesOf(swell)[1].map((op) => `${op.method} ${op.url}`)).toEqual(['put /queue-items/q1']);
    expect(collections['/queue-items'][0]).toMatchObject({ kind: 'full', revision: 3, input_ids: ['en~US~p1'], done_input_ids: [] });
    expect(collections['/alarms'][0].wake_at).toBe(soon);
  });

  it('asks Swell nothing about its own writes', async () => {
    const { swell } = createFakeSwell({ connection: { status: 'connected', merchant_id: '123' } });
    await enqueueFunction(request(swell, { id: 'p1', $event: { type: 'product.updated', data: { $app: { google_merchant_center: { sync_state: 'sent' } } } } }));
    expect(roundTrips(swell)).toBe(0);
  });

  it('reads once and writes nothing while not connected', async () => {
    const { swell } = createFakeSwell();
    await enqueueFunction(request(swell, { id: 'p1', $event: { type: 'product.created', data: { id: 'p1' } } }));
    expect(roundTrips(swell)).toBe(1);
  });

  it('fails when Swell refuses the queue write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { swell, refuse } = createFakeSwell({ connection: { status: 'connected', merchant_id: '123' } });
    refuse((method, url) => (method === 'post' && url === '/queue-items' ? 'Permission denied' : null));
    await expect(enqueueFunction(request(swell, { id: 'p1', $event: { type: 'product.created', data: { id: 'p1' } } }))).rejects.toThrow('Permission denied');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
