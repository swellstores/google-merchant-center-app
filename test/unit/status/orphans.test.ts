import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Market } from '../../../functions/lib/connection/markets';
import { newOrphanScanJob, ORPHAN_PAGE, ORPHAN_WRITES, orphanScanPass, type OrphanScanJob } from '../../../functions/lib/status/orphans';
import { Outbox } from '../../../functions/lib/swell-batch';
import type { DeliveryEnv } from '../../../functions/lib/sync/deliver';
import { stateById } from '../../../functions/lib/sync/state';
import { Budget, iso } from '../../../functions/lib/time';
import { APP_ID, fixedClock, NOW, testContext } from '../../helpers/context';
import { createFakeGoogle, type FakeGoogleOptions } from '../../helpers/fake-google';
import { batchesOf, createFakeSwell, roundTrips } from '../../helpers/fake-swell';
import { takeQueue } from '../../helpers/store';

const DS = 'accounts/1/dataSources/1';
const OTHER_DS = 'accounts/1/dataSources/2';
const MARKET: Market = { id: 'm1', country: 'US', language: 'en', currency: 'USD', link_template: 'https://s.example.com/p/{slug}', data_source: DS };

const idOf = (n: number) => n.toString().padStart(24, '0');
const offerOf = (n: number, variant?: number) => `en~US~${idOf(n)}${variant === undefined ? '' : `-${variant}`}`;
const stray = (n: number, variant?: number, dataSource = DS) => ({
  dataSource,
  offerId: `${idOf(n)}${variant === undefined ? '' : `-${variant}`}`,
  contentLanguage: 'en',
  feedLabel: 'US',
  ...(variant === undefined ? {} : { itemGroupId: idOf(n) }),
});
const product = (n: number, inputIds: string[]) => ({ id: idOf(n), name: `P${n}`, $app: { [APP_ID]: { sync_state: 'sent', input_ids: inputIds } } });

function setup(products: Record<string, any>[], options: FakeGoogleOptions = {}) {
  const clock = fixedClock();
  const google = createFakeGoogle(options);
  const fake = createFakeSwell({ products });
  const env: DeliveryEnv = {
    ctx: testContext(fake.swell, google.fetch, clock),
    accountId: '1', token: 't', markets: [MARKET], defaults: { condition: 'new' }, budget: new Budget(clock, 7000), outbox: new Outbox(fake.swell),
  };
  return { google, env, ...fake };
}

type Fake = ReturnType<typeof setup>;
const posts = (swell: Fake['swell']) => batchesOf(swell).flat().filter((op) => op.method === 'post');

/** Google answers the products list with `status`. */
const refusing = (status: number) =>
  (async () => new Response(JSON.stringify({ error: { code: status, message: 'Invalid page token' } }), { status })) as unknown as typeof fetch;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('orphan scan pass', () => {
  it('queues a delete for offers whose product is gone', async () => {
    const { env, swell } = setup([], { strays: [stray(1), stray(2, 0), stray(2, 1)] });
    const pass = await orphanScanPass(env, newOrphanScanJob(NOW));
    const items = await takeQueue(swell, 10);
    expect(items.map((item) => [item.product_id, item.kind, item.input_ids])).toEqual([
      [idOf(1), 'delete', [offerOf(1)]],
      [idOf(2), 'delete', [offerOf(2, 0), offerOf(2, 1)]],
    ]);
    expect(pass.job).toMatchObject({ status: 'done', found: 3, skip: 0, date_finished: iso(NOW) });
    expect(pass.progressed).toBe(true);
  });

  it('queues a full update naming an offer the product no longer lists', async () => {
    const { env, swell } = setup([product(1, [offerOf(1, 0)]), product(2, [offerOf(2)])], {
      strays: [stray(1, 0), stray(1, 1), stray(2)],
    });
    const pass = await orphanScanPass(env, newOrphanScanJob(NOW));
    expect(posts(swell)).toEqual([
      { method: 'post', url: '/queue-items', data: expect.objectContaining({ product_id: idOf(1), kind: 'full', input_ids: [offerOf(1, 1)] }) },
    ]);
    expect(pass.job).toMatchObject({ status: 'done', found: 1 });
  });

  it('ignores offers of other data sources', async () => {
    const { env, swell } = setup([], { strays: [stray(1, undefined, OTHER_DS), stray(2)] });
    const pass = await orphanScanPass(env, newOrphanScanJob(NOW));
    expect((await takeQueue(swell, 10)).map((item) => item.product_id)).toEqual([idOf(2)]);
    expect(pass.job.found).toBe(1);
  });

  it('at most 8 writes per pass, the same page continues where it stopped', async () => {
    const strays = Array.from({ length: 12 }, (_, i) => stray(i + 1));
    const { env, swell } = setup([], { strays });
    const first = await orphanScanPass(env, newOrphanScanJob(NOW));
    expect(first.job).toMatchObject({ status: 'running', page_token: null, skip: ORPHAN_WRITES, found: ORPHAN_WRITES });
    expect(first.progressed).toBe(true);
    expect(await takeQueue(swell, 20)).toHaveLength(ORPHAN_WRITES);
    const second = await orphanScanPass(env, first.job);
    expect(second.job).toMatchObject({ status: 'done', skip: 0, found: 12 });
    expect((await takeQueue(swell, 20)).map((item) => item.product_id)).toEqual(strays.map((s) => s.offerId));
  });

  it('the write cap leaves room for the caller’s reads in the same round trip', async () => {
    const { env, swell, collections } = setup([], { strays: Array.from({ length: 12 }, (_, i) => stray(i + 1)) });
    collections['/sync-states'].push({ id: 's1', backoff: 0 });
    const pass = await orphanScanPass(env, newOrphanScanJob(NOW), ['s1', 's1', 's1'].map(stateById));
    expect(pass.job).toMatchObject({ skip: 7, found: 7 });
    expect(roundTrips(swell)).toBe(2);
    expect(batchesOf(swell)[1]).toHaveLength(10);
    expect(pass.answers).toHaveLength(3);
  });

  it('finishes after the last page', async () => {
    const { env } = setup([], { strays: Array.from({ length: ORPHAN_PAGE + 1 }, (_, i) => stray(i + 1, undefined, OTHER_DS)) });
    const first = await orphanScanPass(env, newOrphanScanJob(NOW));
    expect(first.job).toMatchObject({ status: 'running', page_token: String(ORPHAN_PAGE), skip: 0, found: 0 });
    expect(first.progressed).toBe(true);
    const second = await orphanScanPass(env, first.job);
    expect(second.job).toMatchObject({ status: 'done', page_token: String(ORPHAN_PAGE), date_finished: iso(NOW) });
  });

  it('a refused list keeps the job', async () => {
    const { env, swell } = setup([]);
    env.ctx = { ...env.ctx, fetch: (async () => new Response(JSON.stringify({ error: { message: 'The caller does not have permission' } }), { status: 403 })) as typeof fetch };
    const job: OrphanScanJob = { ...newOrphanScanJob(NOW), page_token: '5', skip: 2, found: 3 };
    const pass = await orphanScanPass(env, job, [stateById('s1')]);
    expect(pass.job).toBe(job);
    expect(pass).toMatchObject({ sentOps: 0, progressed: false, answers: [] });
    expect(pass.failure).toBeDefined();
    expect(roundTrips(swell)).toBe(0);
  });

  it('a refused page token restarts the scan without a failure', async () => {
    for (const status of [400, 404, 409]) {
      const { env, swell } = setup([]);
      env.ctx = { ...env.ctx, fetch: refusing(status) };
      const job: OrphanScanJob = { ...newOrphanScanJob(NOW), page_token: '500', skip: 4, found: 3 };
      const pass = await orphanScanPass(env, job, [stateById('s1')]);
      expect(pass.failure).toBeUndefined();
      expect(pass).toMatchObject({ sentOps: 0, progressed: true });
      expect(pass.job).toEqual({ ...job, page_token: null, skip: 0 });
      expect(roundTrips(swell)).toBe(0);
    }
  });

  it('a refused first page ends the scan', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { env, swell } = setup([]);
    env.ctx = { ...env.ctx, fetch: refusing(400) };
    const job: OrphanScanJob = { ...newOrphanScanJob(NOW - 60_000), skip: 2, found: 1 };
    const pass = await orphanScanPass(env, job, [stateById('s1')]);
    expect(pass.failure).toBeUndefined();
    expect(pass).toMatchObject({ sentOps: 0, progressed: true });
    expect(pass.job).toEqual({ ...job, status: 'done', date_finished: iso(NOW) });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(roundTrips(swell)).toBe(0);
  });

  it('a pass with ten reads is refused', async () => {
    const { env, google } = setup([], { strays: [stray(1)] });
    await expect(orphanScanPass(env, newOrphanScanJob(NOW), Array.from({ length: 10 }, () => stateById('s1')))).rejects.toThrow(
      'A pass needs room for its writes in one round trip',
    );
    expect(google.requests).toHaveLength(0);
  });

  it('the product read flushes waiting writes and carries no fields mask', async () => {
    const { env, swell } = setup([product(1, [offerOf(1, 0)])], { strays: [stray(1, 0), stray(1, 1)] });
    env.outbox.add({ method: 'put', url: '/queue-items/q1', data: { attempts: 1 } });
    swell.post.mockClear();
    await orphanScanPass(env, newOrphanScanJob(NOW));
    const [first, second] = batchesOf(swell);
    expect(first.map((op) => [op.method, op.url])).toEqual([['put', '/queue-items/q1'], ['get', '/products']]);
    expect(first[1].data).toEqual({ where: { id: { $in: [idOf(1)] } }, limit: 1 });
    expect(first[1].data).not.toHaveProperty('fields');
    expect(second.map((op) => [op.method, op.url])).toEqual([['post', '/queue-items']]);
  });

  it('leaves the job without a round trip when there is no time for the page', async () => {
    const { env, swell, google } = setup([], { strays: [stray(1)] });
    env.budget = new Budget(fixedClock(), 1000);
    const job = newOrphanScanJob(NOW);
    expect(await orphanScanPass(env, job)).toEqual({ job, sentOps: 0, progressed: false, answers: [] });
    expect(google.requests).toHaveLength(0);
    expect(swell.post).not.toHaveBeenCalled();
  });
});
