import { describe, expect, it } from 'vitest';
import type { Market } from '../../../functions/lib/connection/markets';
import type { DeliveryEnv } from '../../../functions/lib/sync/deliver';
import { fullSyncPass, JOB_PAGE, startFullSync } from '../../../functions/lib/sync/full-sync';
import { loadAlarm } from '../../../functions/lib/sync/alarm';
import { takeQueue } from '../../../functions/lib/sync/queue';
import { loadState } from '../../../functions/lib/sync/state';
import { Budget } from '../../../functions/lib/time';
import { fixedClock, NOW, steppingClock, testContext } from '../../helpers/context';
import { createFakeGoogle } from '../../helpers/fake-google';
import { createFakeSwell } from '../../helpers/fake-swell';

const MARKET: Market = { id: 'm1', country: 'US', language: 'en', currency: 'USD', link_template: 'https://s.example.com/p/{slug}', data_source: 'accounts/1/dataSources/1' };
const product = (n: number) => ({
  id: n.toString(16).padStart(24, 'a'), name: `P${n}`, slug: `p${n}`, active: true, price: 5, images: [{ file: { url: `https://cdn.example.com/${n}.jpg` } }],
});

describe('catalog sync', () => {
  it('starts with the product count and wakes the courier now', async () => {
    const { swell } = createFakeSwell({ products: [product(1), product(2)] });
    const job = await startFullSync(testContext(swell));
    expect(job).toMatchObject({ status: 'running', cursor: null, total: 2, done: 0 });
    expect((await loadState(swell)).full_sync).toMatchObject({ status: 'running', total: 2 });
    expect((await loadAlarm(swell)).wake_at).toBe(new Date(NOW).toISOString());
  });

  it('sends one page and moves the cursor past it', async () => {
    const products = Array.from({ length: JOB_PAGE + 3 }, (_, i) => product(i + 1));
    const google = createFakeGoogle();
    const { swell } = createFakeSwell({ products });
    const ctx = testContext(swell, google.fetch);
    const env: DeliveryEnv = { ctx, accountId: '1', token: 't', markets: [MARKET], defaults: { condition: 'new' }, budget: new Budget(fixedClock(), 7000) };
    const job = await startFullSync(ctx);
    const first = await fullSyncPass(env, job);
    const sorted = products.map((p) => p.id).sort();
    expect(first).toMatchObject({ progressed: true, job: { status: 'running', done: JOB_PAGE, cursor: sorted[JOB_PAGE - 1] } });
    const second = await fullSyncPass(env, first.job);
    expect(second.job).toMatchObject({ status: 'done', done: JOB_PAGE + 3 });
    expect(google.inputs.size).toBe(JOB_PAGE + 3);
  });

  it('does not move past a product that was kept', async () => {
    const google = createFakeGoogle({ batch: { status: 503, body: {} } });
    const { swell } = createFakeSwell({ products: [product(1)] });
    const ctx = testContext(swell, google.fetch);
    const env: DeliveryEnv = { ctx, accountId: '1', token: 't', markets: [MARKET], defaults: { condition: 'new' }, budget: new Budget(fixedClock(), 7000) };
    const pass = await fullSyncPass(env, await startFullSync(ctx));
    expect(pass.progressed).toBe(false);
    expect(pass.job).toMatchObject({ status: 'running', cursor: null, done: 0 });
    expect(pass.failure?.kind).toBe('server');
  });

  it('hands products it could not finish to the queue and moves on', async () => {
    const variants = Array.from({ length: 120 }, (_, i) => ({ id: `v${i}`, name: `V${i}`, active: true }));
    const big = { ...product(1), variants: { results: variants } };
    const small = product(2);
    const google = createFakeGoogle();
    const { swell } = createFakeSwell({ products: [small, big] });
    // Clock reads: Budget, one offer build per product, one check per batch.
    // Each read moves 1.4 s, so the second batch starts past the reserve.
    const clock = steppingClock(undefined, 1400);
    const ctx = testContext(swell, google.fetch, clock);
    const env: DeliveryEnv = { ctx, accountId: '1', token: 't', markets: [MARKET], defaults: { condition: 'new' }, budget: new Budget(clock, 7000) };
    const job = { status: 'running' as const, cursor: null, total: 2, done: 0, date_started: new Date(NOW).toISOString() };
    const pass = await fullSyncPass(env, job);
    expect(google.batches()).toBe(1);
    expect(pass.failure).toBeUndefined();
    expect(pass.progressed).toBe(true);
    expect(pass.job).toMatchObject({ cursor: [big.id, small.id].sort()[1], done: 2 });
    const queued = await takeQueue(swell, 10);
    expect(queued.map((q) => q.product_id).sort()).toEqual([big.id, small.id].sort());
    expect(queued.every((q) => q.kind === 'full')).toBe(true);
    // The ids Google already holds for the big product stay known.
    expect(queued.find((q) => q.product_id === big.id)?.input_ids).toHaveLength(google.inputs.size);
  });
});
