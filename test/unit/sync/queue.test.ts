import { describe, expect, it } from 'vitest';
import {
  clearQueue,
  enqueue,
  MAX_ATTEMPTS,
  mergeKind,
  queueCount,
  settleQueue,
  takeQueue,
  unitsFromQueue,
} from '../../../functions/lib/sync/queue';
import { APP_ID, testContext } from '../../helpers/context';
import { createFakeSwell } from '../../helpers/fake-swell';

describe('mergeKind', () => {
  it.each([
    ['light', 'light', 'light'],
    ['light', 'full', 'full'],
    ['full', 'light', 'full'],
    ['full', 'delete', 'delete'],
    ['delete', 'full', 'delete'],
  ] as const)('%s + %s → %s', (a, b, merged) => {
    expect(mergeKind(a, b)).toBe(merged);
  });
});

describe('enqueue', () => {
  it('adds one item per product and merges later changes into it', async () => {
    const { swell, collections } = createFakeSwell();
    await enqueue(swell, { productId: 'p1', kind: 'light' });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await enqueue(swell, { productId: 'p2', kind: 'light' });
    expect(collections['/queue-items'].map((i) => [i.product_id, i.kind])).toEqual([
      ['p1', 'full'],
      ['p2', 'light'],
    ]);
    expect(await queueCount(swell)).toBe(2);
  });

  it('keeps the input ids of a delete', async () => {
    const { swell, collections } = createFakeSwell();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await enqueue(swell, { productId: 'p1', kind: 'delete', inputIds: ['en~US~p1'] });
    expect(collections['/queue-items'][0]).toMatchObject({ kind: 'delete', input_ids: ['en~US~p1'] });
  });
});

describe('takeQueue and unitsFromQueue', () => {
  it('takes the oldest items and groups duplicates of one product', async () => {
    const { swell, collections } = createFakeSwell();
    await enqueue(swell, { productId: 'p1', kind: 'light' });
    await enqueue(swell, { productId: 'p2', kind: 'full' });
    // A duplicate, as concurrent events can create (unique is not atomic).
    collections['/queue-items'].push({ id: 'dup', product_id: 'p1', kind: 'full', input_ids: [], attempts: 2, date_created: '2099-01-01T00:00:00.000Z' });
    const items = await takeQueue(swell, 10);
    expect(items.map((i) => i.product_id)).toEqual(['p1', 'p2', 'p1']);
    const units = unitsFromQueue(items);
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({ productId: 'p1', kind: 'full', attempts: 2, queueItemIds: [items[0].id, 'dup'] });
  });
});

describe('settleQueue', () => {
  it('removes finished items and counts an attempt on kept ones', async () => {
    const { swell, collections } = createFakeSwell({ products: [{ id: 'p2', name: 'Kept' }] });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await enqueue(swell, { productId: 'p2', kind: 'light' });
    const [done, kept] = unitsFromQueue(await takeQueue(swell, 10));
    await settleQueue(testContext(swell), [done], [{ ...kept, kind: 'full', error: 'rate limited' }]);
    expect(collections['/queue-items']).toHaveLength(1);
    expect(collections['/queue-items'][0]).toMatchObject({ product_id: 'p2', kind: 'full', attempts: 1, last_error: 'rate limited' });
  });

  it('gives up after the last attempt and says so on the product', async () => {
    const { swell, collections } = createFakeSwell({ products: [{ id: 'p1', name: 'Stuck' }] });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    const [unit] = unitsFromQueue(await takeQueue(swell, 10));
    await settleQueue(testContext(swell), [], [{ ...unit, attempts: MAX_ATTEMPTS - 1, error: 'Google kept failing' }]);
    expect(collections['/queue-items']).toHaveLength(0);
    expect(collections['/products'][0].$app[APP_ID]).toMatchObject({ sync_state: 'error', sync_error: 'Google kept failing' });
  });

  it('clears everything', async () => {
    const { swell } = createFakeSwell();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await enqueue(swell, { productId: 'p2', kind: 'full' });
    await clearQueue(swell);
    expect(await queueCount(swell)).toBe(0);
  });
});
