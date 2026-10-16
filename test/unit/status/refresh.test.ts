import { describe, expect, it } from 'vitest';
import type { Market } from '../../../functions/lib/connection/markets';
import {
  pendingStatus,
  productStatus,
  statusFields,
  type GoogleProductStatus,
  type ProductStatus,
} from '../../../functions/lib/status/product-status';
import {
  newStatusRefreshJob,
  STATUS_PAGE,
  statusPageRead,
  statusRefreshPass,
  summaryOf,
  type IssueTally,
  type StatusRefreshJob,
} from '../../../functions/lib/status/refresh';
import { Outbox, swellBatch } from '../../../functions/lib/swell-batch';
import type { DeliveryEnv } from '../../../functions/lib/sync/deliver';
import { stateById } from '../../../functions/lib/sync/state';
import { Budget, iso } from '../../../functions/lib/time';
import { APP_ID, fixedClock, NOW, slowServices, testContext } from '../../helpers/context';
import { createFakeGoogle, type FakeGoogleOptions } from '../../helpers/fake-google';
import { batchesOf, createFakeSwell, roundTrips } from '../../helpers/fake-swell';
import { takeQueue } from '../../helpers/store';

const DS = 'accounts/1/dataSources/1';
const MARKET: Market = { id: 'm1', country: 'US', language: 'en', currency: 'USD', link_template: 'https://s.example.com/p/{slug}', data_source: DS };
const HOUR = 3_600_000;
const DAY = 86_400_000;

const idOf = (n: number) => n.toString().padStart(24, '0');
const offerOf = (n: number, i = 0) => `en~US~${idOf(n)}-${i}`;

const approved = (expiresInDays = 30): GoogleProductStatus => ({
  destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', approvedCountries: ['US'] }],
  googleExpirationDate: iso(NOW + expiresInDays * DAY),
});
const disapproved = (code: string, documentation?: string): GoogleProductStatus => ({
  destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', disapprovedCountries: ['US'] }],
  itemLevelIssues: [{ code, severity: 'DISAPPROVED', description: `${code} text`, documentation, applicableCountries: ['US'] }],
  googleExpirationDate: iso(NOW + 30 * DAY),
});

const storedStatus = (status: ProductStatus) => ({
  status: status.status, status_label: status.label, status_hash: status.hash, status_issues: status.issues,
});
const statusOf = (n: number, status: GoogleProductStatus) => productStatus([{ inputId: offerOf(n), found: true, status }]);

/** A product the courier sent an hour ago and marked pending. */
function product(n: number, offers = 1, fields: Record<string, unknown> = {}) {
  return {
    id: idOf(n),
    name: `P${n}`,
    $app: {
      [APP_ID]: {
        sync_state: 'sent',
        input_ids: Array.from({ length: offers }, (_, i) => offerOf(n, i)),
        date_synced: iso(NOW - HOUR),
        ...storedStatus(pendingStatus()),
        ...fields,
      },
    },
  };
}

/** Google holds every offer the products list. */
function setup(products: Record<string, any>[], options: FakeGoogleOptions = {}, clock = fixedClock()) {
  const google = createFakeGoogle(options);
  for (const p of products) {
    for (const inputId of p.$app?.[APP_ID]?.input_ids ?? []) {
      const [contentLanguage, feedLabel, offerId] = inputId.split('~');
      google.inputs.set(`${DS}|${inputId}`, { offerId, contentLanguage, feedLabel });
    }
  }
  const fake = createFakeSwell({ products });
  const ctx = testContext(fake.swell, google.fetch, clock);
  const env: DeliveryEnv = {
    ctx, accountId: '1', token: 't', markets: [MARKET], defaults: { condition: 'new' }, budget: new Budget(clock, 7000), outbox: new Outbox(fake.swell),
  };
  return { google, env, ...fake };
}

type Fake = ReturnType<typeof setup>;
const productPuts = (swell: Fake['swell']) => batchesOf(swell).flat().filter((op) => op.method === 'put' && op.url.startsWith('/products/'));
const googleReads = (google: Fake['google']) => google.requests.filter((r) => r.method === 'GET' && r.path.includes('/products/')).length;
const fieldsOf = (collections: Fake['collections'], n: number) =>
  collections['/products'].find((p) => p.id === idOf(n))!.$app?.[APP_ID];

describe('status refresh pass', () => {
  it('reads a page of whole products after the cursor, without a field mask or variants', () => {
    expect(statusPageRead(newStatusRefreshJob(NOW))).toEqual({ method: 'get', url: '/products', data: { sort: 'id asc', limit: STATUS_PAGE } });
    expect(statusPageRead({ ...newStatusRefreshJob(NOW), cursor: 'c1' }).data).toEqual({
      where: { id: { $gt: 'c1' } }, sort: 'id asc', limit: STATUS_PAGE,
    });
  });

  it('writes a changed status and leaves an unchanged one', async () => {
    const same = statusOf(2, approved());
    const products = [product(1), product(2, 1, storedStatus(same))];
    const { env, swell, collections } = setup(products, { statuses: { [offerOf(1)]: approved(), [offerOf(2)]: approved() } });
    const pass = await statusRefreshPass(env, newStatusRefreshJob(NOW));
    const puts = productPuts(swell);
    expect(puts).toEqual([{ method: 'put', url: `/products/${idOf(1)}`, data: { $app: { [APP_ID]: statusFields(statusOf(1, approved()), NOW) } } }]);
    expect(fieldsOf(collections, 1)).toMatchObject({ status: 'approved', status_label: 'Approved', status_issues: [], date_status: iso(NOW) });
    expect(pass.job).toMatchObject({ checked: 2, requeued: 0, counters: { approved: 2, pending: 0 } });
  });

  it('one Google batch of at most 100 offers, the page cut at a product', async () => {
    const products = [product(1, 40), product(2, 40), product(3, 40)];
    const { env, google } = setup(products);
    const first = await statusRefreshPass(env, newStatusRefreshJob(NOW));
    expect(google.batches()).toBe(1);
    expect(googleReads(google)).toBe(80);
    expect(first.job).toMatchObject({ status: 'running', cursor: idOf(2), checked: 2 });
    const second = await statusRefreshPass(env, first.job);
    expect(googleReads(google)).toBe(120);
    expect(second.job).toMatchObject({ status: 'done', cursor: idOf(3), checked: 3 });
  });

  it('checks a product with more than 100 offers on its first 100', async () => {
    const { env, google } = setup([product(1, 120), product(2)]);
    const first = await statusRefreshPass(env, newStatusRefreshJob(NOW));
    expect(googleReads(google)).toBe(100);
    expect(first.job).toMatchObject({ status: 'running', cursor: idOf(1), checked: 1 });
    expect((await statusRefreshPass(env, first.job)).job).toMatchObject({ status: 'done', cursor: idOf(2), checked: 2 });
  });

  it('writes every changed product over several passes', async () => {
    const products = Array.from({ length: 20 }, (_, i) => product(i + 1));
    const statuses = Object.fromEntries(products.map((_, i) => [offerOf(i + 1), approved()]));
    const { env, swell, collections } = setup(products, { statuses });
    let job = newStatusRefreshJob(NOW);
    const written: number[] = [];
    const cursors: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      swell.post.mockClear();
      job = (await statusRefreshPass(env, job)).job;
      written.push(productPuts(swell).length);
      cursors.push(job.cursor);
      expect(Math.max(...batchesOf(swell).map((batch) => batch.length))).toBeLessThanOrEqual(10);
    }
    expect(written).toEqual([8, 8, 4]);
    expect(cursors).toEqual([idOf(8), idOf(16), idOf(20)]);
    expect(job).toMatchObject({ status: 'done', checked: 20, counters: { approved: 20 } });
    expect(collections['/products'].filter((p) => p.$app[APP_ID].status !== 'approved')).toEqual([]);
  });

  it('a product with a missing offer is pending with the missing issue', async () => {
    const offers = ['en~US~x', 'en~GB~x'];
    const { env, google, collections } = setup([product(1, 0, { input_ids: offers, date_synced: iso(NOW - 2 * DAY) })], { statuses: { 'en~US~x': approved() } });
    google.inputs.delete(`${DS}|en~GB~x`);
    const pass = await statusRefreshPass(env, newStatusRefreshJob(NOW));
    expect(pass.failure).toBeUndefined();
    expect(fieldsOf(collections, 1)).toMatchObject({
      status: 'pending',
      status_label: 'Pending (1 of 2)',
      status_issues: [expect.objectContaining({ code: 'missing_in_google', severity: 'info', offers: ['en~GB~x'] })],
    });
    expect(pass.job).toMatchObject({ requeued: 0, counters: { pending: 1, approved: 0 } });
  });

  it('a just-sent offer Google has not processed is pending without an issue', async () => {
    const { env, google, swell } = setup([product(1), product(2, 2)]);
    google.inputs.delete(`${DS}|${offerOf(1)}`);
    google.inputs.delete(`${DS}|${offerOf(2, 1)}`);
    const pass = await statusRefreshPass(env, newStatusRefreshJob(NOW));
    expect(productPuts(swell)).toEqual([]);
    expect(pass.job).toMatchObject({ checked: 2, requeued: 0, counters: { pending: 2 }, issues: [] });
  });

  it('a product without offers counts its stored status without Google', async () => {
    const products = [
      { id: idOf(1), name: 'P1', $app: { [APP_ID]: { sync_state: 'skipped', input_ids: [], status: 'not_sent' } } },
      { id: idOf(2), name: 'P2', $app: { [APP_ID]: { sync_state: 'skipped', status: 'excluded' } } },
      { id: idOf(3), name: 'P3' },
    ];
    const { env, google, swell } = setup(products);
    const pass = await statusRefreshPass(env, newStatusRefreshJob(NOW));
    expect(google.batches()).toBe(0);
    expect(roundTrips(swell)).toBe(1);
    expect(pass.job).toMatchObject({
      status: 'done', cursor: idOf(3), checked: 3, counters: { approved: 0, partial: 0, pending: 0, disapproved: 0, not_sent: 1, excluded: 1 },
    });
  });

  it('requeues a product whose offer expires within 7 days', async () => {
    const products = [product(1), product(2)];
    const { env, swell } = setup(products, { statuses: { [offerOf(1)]: approved(6), [offerOf(2)]: approved(8) } });
    const pass = await statusRefreshPass(env, newStatusRefreshJob(NOW));
    const posts = batchesOf(swell).flat().filter((op) => op.method === 'post');
    expect(posts).toEqual([{ method: 'post', url: '/queue-items', data: expect.objectContaining({ product_id: idOf(1), kind: 'full' }) }]);
    expect((await takeQueue(swell, 10)).map((item) => [item.product_id, item.kind])).toEqual([[idOf(1), 'full']]);
    expect(pass.job.requeued).toBe(1);
  });

  it('requeues a product Google lacks a day after it was sent, not an hour after', async () => {
    const products = [product(1, 1, { date_synced: iso(NOW - HOUR) }), product(2, 1, { date_synced: iso(NOW - 25 * HOUR) })];
    const { env, google, swell } = setup(products);
    google.inputs.clear();
    const pass = await statusRefreshPass(env, newStatusRefreshJob(NOW));
    expect((await takeQueue(swell, 10)).map((item) => item.product_id)).toEqual([idOf(2)]);
    expect(pass.job).toMatchObject({ requeued: 1, counters: { pending: 2 } });
  });

  it('finishes on a short page with counters and duration', async () => {
    const products = [product(1), product(2), product(3)];
    const { env } = setup(products, { statuses: { [offerOf(1)]: approved(), [offerOf(2)]: disapproved('image_too_small') } });
    const pass = await statusRefreshPass(env, { ...newStatusRefreshJob(NOW - HOUR), date_first_pass: iso(NOW - 300_000) });
    expect(pass.progressed).toBe(true);
    expect(pass.job).toMatchObject({
      status: 'done',
      cursor: idOf(3),
      checked: 3,
      counters: { approved: 1, disapproved: 1, pending: 1 },
      date_first_pass: iso(NOW - 300_000),
      date_finished: iso(NOW),
      duration_ms: 300_000,
    });
  });

  it('measures a refresh from its first pass, not from the wait behind other work', async () => {
    const products = Array.from({ length: STATUS_PAGE + 1 }, (_, i) => product(i + 1));
    const first = await statusRefreshPass(setup(products).env, newStatusRefreshJob(NOW - 8 * HOUR));
    expect(first.job).toMatchObject({ status: 'running', date_first_pass: iso(NOW), duration_ms: null });
    const later = setup(products, {}, fixedClock(NOW + 60_000));
    const last = await statusRefreshPass(later.env, first.job);
    expect(last.job).toMatchObject({ status: 'done', date_first_pass: iso(NOW), date_finished: iso(NOW + 60_000), duration_ms: 60_000 });
  });

  it('a full page leaves the job running and the empty page after it finishes', async () => {
    const products = Array.from({ length: STATUS_PAGE }, (_, i) => ({ id: idOf(i + 1), name: `P${i + 1}` }));
    const { env } = setup(products);
    const full = await statusRefreshPass(env, newStatusRefreshJob(NOW));
    expect(full.job).toMatchObject({ status: 'running', cursor: idOf(STATUS_PAGE), checked: STATUS_PAGE });
    const empty = await statusRefreshPass(env, full.job);
    expect(empty.progressed).toBe(true);
    expect(empty.job).toMatchObject({ status: 'done', cursor: idOf(STATUS_PAGE), checked: STATUS_PAGE, date_finished: iso(NOW) });
  });

  it('a whole-batch failure keeps the cursor', async () => {
    const outage = { status: 503, body: { error: { message: 'Service unavailable' } } };
    const { env, swell, google } = setup([product(1), product(2), product(3)], { batch: outage });
    const started = newStatusRefreshJob(NOW);
    const job: StatusRefreshJob = { ...started, cursor: idOf(1), checked: 1, counters: { ...started.counters, pending: 1 } };
    const pass = await statusRefreshPass(env, job, [stateById('s1')]);
    expect(google.batches()).toBe(1);
    expect(pass.job).toBe(job);
    expect(pass.job).toMatchObject({ cursor: idOf(1), checked: 1 });
    expect(pass).toMatchObject({ sentOps: 0, progressed: false, answers: [] });
    expect(pass.failure).toMatchObject({ kind: 'server', status: 503 });
    expect(roundTrips(swell)).toBe(1);
  });

  it('a product that needs a status PUT and a requeue POST does not fit as the 8th write', async () => {
    const products = Array.from({ length: 8 }, (_, i) => product(i + 1));
    const statuses = { ...Object.fromEntries(products.map((_, i) => [offerOf(i + 1), approved()])), [offerOf(8)]: approved(6) };
    const { env, swell } = setup(products, { statuses });
    const first = await statusRefreshPass(env, newStatusRefreshJob(NOW));
    expect(productPuts(swell)).toHaveLength(7);
    expect(await takeQueue(swell, 10)).toEqual([]);
    expect(first.job).toMatchObject({ status: 'running', cursor: idOf(7), checked: 7, requeued: 0 });
    swell.post.mockClear();
    const second = await statusRefreshPass(env, first.job);
    expect(batchesOf(swell)[1].map((op) => [op.method, op.url])).toEqual([['put', `/products/${idOf(8)}`], ['post', '/queue-items']]);
    expect(second.job).toMatchObject({ status: 'done', cursor: idOf(8), checked: 8, requeued: 1 });
  });

  it('the write cap leaves room for waiting writes and the caller’s reads', async () => {
    const products = Array.from({ length: 10 }, (_, i) => product(i + 1));
    const { env, swell, collections } = setup(products, { statuses: Object.fromEntries(products.map((_, i) => [offerOf(i + 1), approved()])) });
    collections['/sync-states'].push({ id: 's1', backoff: 0 });
    const job = newStatusRefreshJob(NOW);
    const [page] = await swellBatch(swell, [statusPageRead(job)]);
    swell.post.mockClear();
    env.outbox.add(...['q1', 'q2', 'q3'].map((id) => ({ method: 'put' as const, url: `/queue-items/${id}`, data: { attempts: 1 } })));
    const pass = await statusRefreshPass(env, job, [stateById('s1')], page);
    const [trip] = batchesOf(swell);
    expect(trip).toHaveLength(10);
    expect(productPuts(swell)).toHaveLength(6);
    expect(pass.job).toMatchObject({ cursor: idOf(6), checked: 6 });
    expect(pass.answers).toEqual([expect.objectContaining({ id: 's1' })]);
  });

  it('a rate-limited part stops before its product', async () => {
    const products = [product(1), product(2), product(3)];
    const statuses = { [offerOf(1)]: approved(), [offerOf(3)]: approved() };
    const limited = { status: 429, body: { error: { message: 'Quota exceeded for quota metric' } } };
    const { env, swell, collections } = setup(products, { statuses, productsGetErrors: { [offerOf(2)]: limited } });
    const pass = await statusRefreshPass(env, newStatusRefreshJob(NOW));
    expect(pass.failure).toMatchObject({ kind: 'rate', status: 429 });
    expect(pass).toMatchObject({ progressed: true, job: { status: 'running', cursor: idOf(1), checked: 1, counters: { approved: 1 } } });
    expect(productPuts(swell).map((op) => op.url)).toEqual([`/products/${idOf(1)}`]);
    expect(fieldsOf(collections, 3).status).toBe('pending');
  });

  it('a refused key on any part is the run’s failure', async () => {
    const products = [product(1), product(2), product(3)];
    const errors = {
      [offerOf(2)]: { status: 500, body: { error: { message: 'Internal error encountered.' } } },
      [offerOf(3)]: { status: 401, body: { error: { message: 'Request had invalid authentication credentials.' } } },
    };
    const { env } = setup(products, { productsGetErrors: errors });
    const pass = await statusRefreshPass(env, newStatusRefreshJob(NOW));
    expect(pass.failure).toMatchObject({ kind: 'auth', status: 401 });
    expect(pass.job).toMatchObject({ cursor: idOf(1), checked: 1 });
  });

  it('tallies issues by code with three samples', async () => {
    const products = [1, 2, 3, 4, 5].map((n) => product(n));
    const statuses = {
      ...Object.fromEntries([1, 2, 3, 4].map((n) => [offerOf(n), disapproved('image_too_small', 'https://support.google.com/i')])),
      [offerOf(5)]: { ...approved(), itemLevelIssues: [{ code: 'missing_gtin', severity: 'DEMOTED', description: 'missing_gtin text' }] },
    };
    const { env } = setup(products, { statuses });
    const earlier: IssueTally = {
      code: 'image_too_small',
      severity: 'disapproved',
      description: 'image_too_small text',
      documentation: 'https://support.google.com/i',
      products: 2,
      samples: [{ id: 'x', name: 'X' }],
    };
    const pass = await statusRefreshPass(env, { ...newStatusRefreshJob(NOW), issues: [earlier] });
    expect(pass.job.issues).toEqual([
      {
        ...earlier,
        products: 6,
        samples: [{ id: 'x', name: 'X' }, { id: idOf(1), name: 'P1' }, { id: idOf(2), name: 'P2' }],
      },
      { code: 'missing_gtin', severity: 'demoted', description: 'missing_gtin text', products: 1, samples: [{ id: idOf(5), name: 'P5' }] },
    ]);
  });

  it('a pass is two Swell round trips and one Google call', async () => {
    const products = [product(1), product(2), product(3)];
    const google = createFakeGoogle({ statuses: Object.fromEntries(products.map((_, i) => [offerOf(i + 1), approved()])) });
    for (const p of products) google.inputs.set(`${DS}|${p.$app[APP_ID].input_ids[0]}`, {});
    const fake = createFakeSwell({ products });
    fake.collections['/sync-states'].push({ id: 's1', backoff: 0 });
    const slow = slowServices(fake.swell, google.fetch, { swellMs: 1300, googleMs: 1500 });
    const env: DeliveryEnv = {
      ctx: testContext(slow.swell, slow.fetch, slow.now), accountId: '1', token: 't', markets: [MARKET], defaults: { condition: 'new' },
      budget: new Budget(slow.now, 7000), outbox: new Outbox(slow.swell),
    };
    const pass = await statusRefreshPass(env, newStatusRefreshJob(NOW), [stateById('s1')]);
    expect(roundTrips(fake.swell)).toBe(2);
    expect(google.batches()).toBe(1);
    expect(slow.now() - NOW).toBe(2 * 1300 + 1500);
    expect(pass.answers).toEqual([expect.objectContaining({ id: 's1' })]);
    expect(batchesOf(fake.swell).map((batch) => batch.map((op) => op.method))).toEqual([['get'], ['put', 'put', 'put', 'get']]);
  });

  it('a pass with ten reads is refused', async () => {
    const { env } = setup([product(1)]);
    await expect(statusRefreshPass(env, newStatusRefreshJob(NOW), Array.from({ length: 10 }, () => stateById('s1')))).rejects.toThrow(
      'A pass needs room for its writes in one round trip',
    );
  });

  it('a pass with no room for writes does not call Google', async () => {
    const { env, swell, google } = setup([product(1)], { statuses: { [offerOf(1)]: approved() } });
    const job = newStatusRefreshJob(NOW);
    const [page] = await swellBatch(swell, [statusPageRead(job)]);
    swell.post.mockClear();
    env.outbox.add(...Array.from({ length: 9 }, (_, i) => ({ method: 'put' as const, url: `/queue-items/q${i}`, data: { attempts: 1 } })));
    const pass = await statusRefreshPass(env, job, [stateById('s1')], page);
    expect(pass).toEqual({ job, sentOps: 0, progressed: false, answers: [] });
    expect(google.requests).toHaveLength(0);
    expect(swell.post).not.toHaveBeenCalled();
    expect(env.outbox.size).toBe(9);
  });

  it('leaves a page it has no time to check, without a round trip', async () => {
    const { env, swell, google } = setup([product(1)]);
    env.budget = new Budget(fixedClock(), 1000);
    const job = newStatusRefreshJob(NOW);
    const [page] = await swellBatch(swell, [statusPageRead(job)]);
    swell.post.mockClear();
    const pass = await statusRefreshPass(env, job, [stateById('s1')], page);
    expect(pass).toEqual({ job, sentOps: 0, progressed: false, answers: [] });
    expect(google.batches()).toBe(0);
    expect(swell.post).not.toHaveBeenCalled();
  });
});

describe('summaryOf', () => {
  it('keeps the counters and the five worst issues', () => {
    const tally = (code: string, severity: IssueTally['severity'], products: number): IssueTally => ({
      code, severity, description: code, products, samples: [],
    });
    const job: StatusRefreshJob = {
      ...newStatusRefreshJob(NOW - HOUR),
      status: 'done',
      counters: { approved: 5, partial: 1, pending: 2, disapproved: 3, not_sent: 1, excluded: 0 },
      issues: [
        tally('missing_in_google', 'info', 40),
        tally('low_image', 'demoted', 9),
        tally('price_mismatch', 'disapproved', 2),
        tally('image_too_small', 'disapproved', 7),
        tally('missing_gtin', 'demoted', 12),
        tally('shipping', 'info', 1),
        tally('pending_initial_review', 'review', 3),
      ],
      date_finished: iso(NOW),
      duration_ms: HOUR,
    };
    expect(summaryOf(job)).toEqual({
      counters: job.counters,
      top_issues: [job.issues[3], job.issues[2], job.issues[4], job.issues[1], job.issues[6]],
      date_refreshed: iso(NOW),
    });
  });
});
