import { describe, expect, it } from 'vitest';
import type { Market } from '../../../functions/lib/connection/markets';
import { Outbox, swellBatch } from '../../../functions/lib/swell-batch';
import type { DeliveryEnv } from '../../../functions/lib/sync/deliver';
import { fullSyncPass, JOB_PAGE, pageRead } from '../../../functions/lib/sync/full-sync';
import { newFullSyncJob, stateById } from '../../../functions/lib/sync/state';
import { Budget } from '../../../functions/lib/time';
import { fixedClock, NOW, steppingClock, testContext } from '../../helpers/context';
import { createFakeGoogle, type FakeGoogleOptions } from '../../helpers/fake-google';
import { batchesOf, createFakeSwell } from '../../helpers/fake-swell';
import { takeQueue } from '../../helpers/store';

const MARKET: Market = { id: 'm1', country: 'US', language: 'en', currency: 'USD', link_template: 'https://s.example.com/p/{slug}', data_source: 'accounts/1/dataSources/1' };
const product = (n: number) => ({
  id: n.toString(16).padStart(24, 'a'), name: `P${n}`, slug: `p${n}`, active: true, price: 5, images: [{ file: { url: `https://cdn.example.com/${n}.jpg` } }],
});

function setup(products: Record<string, any>[], googleOptions: FakeGoogleOptions = {}, clock = fixedClock()) {
  const google = createFakeGoogle(googleOptions);
  const fake = createFakeSwell({ products });
  const ctx = testContext(fake.swell, google.fetch, clock);
  const env: DeliveryEnv = {
    ctx, accountId: '1', token: 't', markets: [MARKET], defaults: { condition: 'new' }, budget: new Budget(clock, 7000), outbox: new Outbox(fake.swell),
  };
  return { google, ctx, env, ...fake };
}

describe('catalog sync', () => {
  it('sends one page and moves the cursor past it', async () => {
    const products = Array.from({ length: JOB_PAGE + 3 }, (_, i) => product(i + 1));
    const { google, env } = setup(products);
    const first = await fullSyncPass(env, newFullSyncJob(NOW));
    const sorted = products.map((p) => p.id).sort();
    expect(first).toMatchObject({ progressed: true, job: { status: 'running', done: JOB_PAGE, cursor: sorted[JOB_PAGE - 1] } });
    const second = await fullSyncPass(env, first.job);
    expect(second.job).toMatchObject({ status: 'done', done: JOB_PAGE + 3 });
    expect(google.inputs.size).toBe(JOB_PAGE + 3);
  });

  it('reads a page with its products once and counts the catalog on the first page', async () => {
    const products = [product(1), product(2)];
    const { env, swell, collections } = setup(products);
    const pass = await fullSyncPass(env, newFullSyncJob(NOW));
    expect(swell.get).not.toHaveBeenCalled();
    const [read] = batchesOf(swell);
    expect(read).toEqual([{ method: 'get', url: '/products', data: { sort: 'id asc', limit: JOB_PAGE, expand: ['variants:1000'] } }]);
    expect(pass.job).toMatchObject({ status: 'done', total: 2, done: 2 });
    expect(collections['/products'].every((p) => p.$app?.google_merchant_center?.sync_state === 'sent')).toBe(true);
  });

  it('sends its writes with the caller’s reads in one round trip after Google', async () => {
    const { env, swell, collections } = setup([product(1)]);
    collections['/sync-states'].push({ id: 's1', backoff: 0 });
    const pass = await fullSyncPass(env, newFullSyncJob(NOW), [stateById('s1')]);
    expect(pass.answers).toEqual([expect.objectContaining({ id: 's1' })]);
    expect(batchesOf(swell).map((batch) => batch.map((op) => op.method))).toEqual([['get'], ['put', 'get']]);
  });

  it('reads the page with the writes that wait, and takes a page the caller read', async () => {
    const { env, swell } = setup([product(1)]);
    env.outbox.add({ method: 'delete', url: '/queue-items/q1' });
    await fullSyncPass(env, newFullSyncJob(NOW));
    expect(batchesOf(swell)[0].map((op) => op.method)).toEqual(['delete', 'get']);

    const job = newFullSyncJob(NOW);
    const [page] = await swellBatch(swell, [pageRead(job)]);
    swell.post.mockClear();
    expect((await fullSyncPass(env, job, [], page)).progressed).toBe(true);
    expect(batchesOf(swell).map((batch) => batch.map((op) => op.method))).toEqual([['put']]);
  });

  it('leaves a page none of which went out, without a round trip', async () => {
    // Clock reads 4 s apart: the first batch already starts past its reserve.
    const { env, swell, google } = setup([product(1), product(2)], {}, steppingClock(undefined, 4000));
    const job = newFullSyncJob(NOW);
    const [page] = await swellBatch(swell, [pageRead(job)]);
    swell.post.mockClear();
    const pass = await fullSyncPass(env, job, [stateById('s1')], page);
    expect(google.batches()).toBe(0);
    expect(pass).toEqual({ job, sentOps: 0, progressed: false, answers: [] });
    expect(swell.post).not.toHaveBeenCalled();
  });

  it('does not move past a product that was kept', async () => {
    const { env } = setup([product(1)], { batch: { status: 503, body: {} } });
    const pass = await fullSyncPass(env, newFullSyncJob(NOW));
    expect(pass.progressed).toBe(false);
    expect(pass.job).toMatchObject({ status: 'running', cursor: null, done: 0 });
    expect(pass.failure?.kind).toBe('server');
  });

  it('moves past a product Google failed on and queues it (Ruling 26)', async () => {
    const products = [product(1), product(2), product(3)];
    const outage = { status: 500, body: { error: { message: 'Internal error encountered.' } } };
    const { env, swell } = setup(products, { offerErrors: { [products[1].id]: outage } });
    const pass = await fullSyncPass(env, newFullSyncJob(NOW));
    await env.outbox.send();
    expect(pass.failure).toMatchObject({ kind: 'server', status: 500 });
    expect(pass.progressed).toBe(true);
    expect(pass.job).toMatchObject({ cursor: products.map((p) => p.id).sort()[2], done: 3 });
    expect((await takeQueue(swell, 10)).map((q) => [q.product_id, q.kind])).toEqual([[products[1].id, 'full']]);
  });

  it('keeps its place when Google refuses the key mid-page', async () => {
    const products = [product(1), product(2), product(3)];
    const refused = { status: 401, body: { error: { message: 'Request had invalid authentication credentials.' } } };
    const { env, swell } = setup(products, { offerErrors: { [products[1].id]: refused } });
    const pass = await fullSyncPass(env, newFullSyncJob(NOW));
    await env.outbox.send();
    expect(pass.failure?.kind).toBe('auth');
    expect(pass.job).toMatchObject({ status: 'running', cursor: products[0].id, done: 1 });
    expect(await takeQueue(swell, 10)).toEqual([]);
  });

  it('hands products it could not finish to the queue and moves on', async () => {
    const variants = Array.from({ length: 120 }, (_, i) => ({ id: `v${i}`, name: `V${i}`, active: true }));
    const big = { ...product(1), variants: { results: variants } };
    const small = product(2);
    // Clock reads: Budget, one offer build per product, one check per batch.
    // Each read moves 1.4 s, so the second batch starts past the reserve.
    const { google, env, swell } = setup([small, big], {}, steppingClock(undefined, 1400));
    const job = { status: 'running' as const, cursor: null, total: 2, done: 0, date_started: new Date(NOW).toISOString() };
    const pass = await fullSyncPass(env, job);
    expect(google.batches()).toBe(1);
    expect(pass.failure).toBeUndefined();
    expect(pass.progressed).toBe(true);
    expect(pass.job).toMatchObject({ cursor: [big.id, small.id].sort()[1], done: 2 });
    // The hand-off waits for the caller's next round trip.
    expect(env.outbox.size).toBe(2);
    await env.outbox.send();
    const queued = await takeQueue(swell, 10);
    expect(queued.map((q) => q.product_id).sort()).toEqual([big.id, small.id].sort());
    expect(queued.every((q) => q.kind === 'full')).toBe(true);
    // The ids Google already holds for the big product stay known.
    expect(queued.find((q) => q.product_id === big.id)?.input_ids).toHaveLength(google.inputs.size);
  });

  it('merges a hand-off into the product’s queue item', async () => {
    const variants = Array.from({ length: 120 }, (_, i) => ({ id: `v${i}`, name: `V${i}`, active: true }));
    const big = { ...product(1), variants: { results: variants } };
    // Clock reads 2 s apart: the second batch starts past the reserve.
    const { env, swell, collections } = setup([big], {}, steppingClock(undefined, 2000));
    collections['/queue-items'].push({ id: 'q1', product_id: big.id, kind: 'light', input_ids: [], revision: 2, date_created: '2026-01-01T00:00:00.000Z' });
    await fullSyncPass(env, newFullSyncJob(NOW));
    await env.outbox.send();
    expect(await takeQueue(swell, 10)).toEqual([expect.objectContaining({ id: 'q1', kind: 'full', revision: 3 })]);
  });
});
