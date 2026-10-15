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
    expect(collections['/queue-items'][0].revision).toBe(1);
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
  it('records progress and counts no attempt when a kept unit progressed', async () => {
    const { swell, collections } = createFakeSwell();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    collections['/queue-items'][0].attempts = 3;
    const [unit] = unitsFromQueue(await takeQueue(swell, 10));
    await settleQueue(testContext(swell), [], [{ ...unit, progress: ['en~US~v1'] }]);
    expect(collections['/queue-items'][0]).toMatchObject({ done_input_ids: ['en~US~v1'], attempts: 0 });
  });

  it('folds done ids into input_ids when the product changes', async () => {
    const { swell, collections } = createFakeSwell();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    collections['/queue-items'][0].done_input_ids = ['en~US~a'];
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    expect(collections['/queue-items'][0]).toMatchObject({ input_ids: ['en~US~a'], done_input_ids: [] });
  });

  it('stores no progress when the item changed during the run', async () => {
    const { swell, collections } = createFakeSwell();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    const [unit] = unitsFromQueue(await takeQueue(swell, 10));
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await settleQueue(testContext(swell), [], [{ ...unit, progress: ['en~US~v1'] }]);
    expect(collections['/queue-items'][0].done_input_ids).toEqual([]);
  });

  it('forgets progress when the product changes', async () => {
    const { swell, collections } = createFakeSwell();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    collections['/queue-items'][0].done_input_ids = ['x'];
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    expect(collections['/queue-items'][0].done_input_ids).toEqual([]);
  });

  it('takes only the done ids every duplicate shares', () => {
    const items = [
      { id: 'a', product_id: 'p1', kind: 'full' as const, done_input_ids: ['x', 'y'] },
      { id: 'b', product_id: 'p1', kind: 'full' as const, done_input_ids: ['y'] },
    ];
    expect(unitsFromQueue(items)[0].doneInputIds).toEqual(['y']);
  });

  it('removes finished items and counts an attempt on kept ones', async () => {
    const { swell, collections } = createFakeSwell({ products: [{ id: 'p2', name: 'Kept' }] });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await enqueue(swell, { productId: 'p2', kind: 'light' });
    const [done, kept] = unitsFromQueue(await takeQueue(swell, 10));
    await settleQueue(testContext(swell), [done], [{ ...kept, kind: 'full', error: 'backend error', charge: true }]);
    expect(collections['/queue-items']).toHaveLength(1);
    expect(collections['/queue-items'][0]).toMatchObject({ product_id: 'p2', kind: 'full', attempts: 1, last_error: 'backend error' });
  });

  it('counts no attempt for a kept unit that was not charged', async () => {
    const { swell, collections } = createFakeSwell();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    collections['/queue-items'][0].attempts = 3;
    const [unit] = unitsFromQueue(await takeQueue(swell, 10));
    await settleQueue(testContext(swell), [], [{ ...unit, error: 'rate limited' }]);
    expect(collections['/queue-items'][0]).toMatchObject({ attempts: 3, last_error: 'rate limited' });
  });

  it('counts an attempt for a charged unit', async () => {
    const { swell, collections } = createFakeSwell();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    collections['/queue-items'][0].attempts = 3;
    const [unit] = unitsFromQueue(await takeQueue(swell, 10));
    await settleQueue(testContext(swell), [], [{ ...unit, error: 'backend error', charge: true }]);
    expect(collections['/queue-items'][0]).toMatchObject({ attempts: 4, last_error: 'backend error' });
  });

  it('gives up after the last attempt and says so on the product', async () => {
    const { swell, collections } = createFakeSwell({ products: [{ id: 'p1', name: 'Stuck' }] });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    const [unit] = unitsFromQueue(await takeQueue(swell, 10));
    await settleQueue(testContext(swell), [], [{ ...unit, attempts: MAX_ATTEMPTS - 1, error: 'Google kept failing', charge: true }]);
    expect(collections['/queue-items']).toHaveLength(0);
    expect(collections['/products'][0].$app[APP_ID]).toMatchObject({ sync_state: 'error', sync_error: 'Google kept failing' });
  });

  it('keeps an item edited while the courier sent it', async () => {
    const { swell, collections } = createFakeSwell();
    await enqueue(swell, { productId: 'p1', kind: 'light' });
    const units = unitsFromQueue(await takeQueue(swell, 10));
    await enqueue(swell, { productId: 'p1', kind: 'light' });
    await settleQueue(testContext(swell), units, []);
    expect(collections['/queue-items']).toHaveLength(1);
    expect(collections['/queue-items'][0]).toMatchObject({ product_id: 'p1', revision: 1 });
  });

  it('merges a kept unit with an edit made meanwhile', async () => {
    const { swell, collections } = createFakeSwell();
    await enqueue(swell, { productId: 'p1', kind: 'light' });
    const units = unitsFromQueue(await takeQueue(swell, 10));
    await enqueue(swell, { productId: 'p1', kind: 'delete', inputIds: ['en~US~p1'] });
    await settleQueue(testContext(swell), [], [{ ...units[0], error: 'backend error', charge: true }]);
    expect(collections['/queue-items']).toHaveLength(1);
    expect(collections['/queue-items'][0]).toMatchObject({ kind: 'delete', input_ids: ['en~US~p1'], attempts: 1 });
  });

  it('keeps the input ids of a kept unit\'s duplicates', async () => {
    const { swell, collections } = createFakeSwell();
    collections['/queue-items'].push(
      { id: 'a', product_id: 'p1', kind: 'delete', input_ids: [], attempts: 0, revision: 0, date_created: '2026-01-01T00:00:00.000Z' },
      { id: 'b', product_id: 'p1', kind: 'delete', input_ids: ['en~US~p1'], attempts: 0, revision: 0, date_created: '2026-01-02T00:00:00.000Z' },
    );
    const [unit] = unitsFromQueue(await takeQueue(swell, 10));
    await settleQueue(testContext(swell), [], [unit]);
    expect(collections['/queue-items']).toHaveLength(1);
    expect(collections['/queue-items'][0].input_ids).toEqual(['en~US~p1']);
  });

  it('clears everything', async () => {
    const { swell } = createFakeSwell();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await enqueue(swell, { productId: 'p2', kind: 'full' });
    await clearQueue(swell);
    expect(await queueCount(swell)).toBe(0);
  });

  it('stops clearing when deletes keep failing', async () => {
    const { swell, collections } = createFakeSwell();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    swell.delete.mockImplementation(async () => {
      throw new Error('denied');
    });
    // Guard: a looping clearQueue fails here instead of spinning forever.
    const realGet = swell.get.getMockImplementation()!;
    let reads = 0;
    swell.get.mockImplementation(async (...args: any[]) => {
      if (++reads > 50) throw new Error('clearQueue never stopped');
      return realGet(...(args as [string, object]));
    });
    await clearQueue(swell);
    expect(collections['/queue-items']).toHaveLength(1);
  });
});
