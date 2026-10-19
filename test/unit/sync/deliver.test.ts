import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Market } from '../../../functions/lib/connection/markets';
import type { SwellProduct } from '../../../functions/lib/mapping/types';
import { Outbox } from '../../../functions/lib/swell-batch';
import { deliver as deliverOnly, type DeliveryEnv } from '../../../functions/lib/sync/deliver';
import type { WorkUnit } from '../../../functions/lib/sync/queue';
import { Budget } from '../../../functions/lib/time';
import { APP_ID, fixedClock, steppingClock, testContext } from '../../helpers/context';
import { createFakeGoogle, type FakeGoogleOptions } from '../../helpers/fake-google';
import { batchesOf, createFakeSwell } from '../../helpers/fake-swell';

const DS = 'accounts/123/dataSources/1';
const MARKET: Market = { id: 'm1', country: 'US', language: 'en', currency: 'USD', link_template: 'https://shop.example.com/products/{slug}', data_source: DS };
const img = (url: string) => ({ file: { url } });
const mug = (extra: Record<string, any> = {}) => ({
  id: 'p1', name: 'Mug', slug: 'mug', active: true, price: 12, images: [img('https://cdn.example.com/mug.jpg')], ...extra,
});
const unit = (productId: string, kind: WorkUnit['kind'] = 'full', extra: Partial<WorkUnit> = {}): WorkUnit => ({
  productId, kind, inputIds: [], queueItemIds: [`q-${productId}`], attempts: 0, ...extra,
});

function setup(products: Record<string, any>[], googleOptions: FakeGoogleOptions = {}, clock = fixedClock()) {
  const google = createFakeGoogle(googleOptions);
  const fake = createFakeSwell({ products });
  const ctx = testContext(fake.swell, google.fetch, clock);
  const env: DeliveryEnv = {
    ctx, accountId: '123', token: 'tok', markets: [MARKET], defaults: { condition: 'new' }, budget: new Budget(clock, 7000), outbox: new Outbox(fake.swell),
  };
  const appFields = (id: string) => fake.collections['/products'].find((p) => p.id === id)?.$app?.[APP_ID];
  return { google, env, appFields, ...fake };
}

/** Delivers and sends the writes deliver left for the caller. */
async function deliver(env: DeliveryEnv, units: WorkUnit[]) {
  const report = await deliverOnly(env, units);
  await env.outbox.send();
  return report;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deliver', () => {
  it('inserts a new product and records what it sent', async () => {
    const { google, env, appFields } = setup([mug()]);
    const report = await deliver(env, [unit('p1')]);
    expect(report.done.map((u) => u.productId)).toEqual(['p1']);
    expect(report.sentOps).toBe(1);
    expect(google.inputs.get(`${DS}|en~US~p1`)?.productAttributes.title).toBe('Mug');
    expect(appFields('p1')).toMatchObject({ sync_state: 'sent', sync_error: null, input_ids: ['en~US~p1'] });
  });

  it('patches price and availability of an offer sent before', async () => {
    const { google, env } = setup([mug({ price: 9, $app: { [APP_ID]: { input_ids: ['en~US~p1'] } } })]);
    google.inputs.set(`${DS}|en~US~p1`, { offerId: 'p1', productAttributes: { title: 'Mug', price: { amountMicros: '12000000', currencyCode: 'USD' } } });
    await deliver(env, [unit('p1', 'light')]);
    const patch = google.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.path).toContain('updateMask=productAttributes.price%2CproductAttributes.salePrice%2CproductAttributes.availability');
    expect(patch.body).not.toHaveProperty('versionNumber');
    expect(google.inputs.get(`${DS}|en~US~p1`)?.productAttributes).toMatchObject({ title: 'Mug', price: { amountMicros: '9000000' } });
  });

  it('inserts instead of patching an offer Google never got', async () => {
    const { google, env } = setup([mug()]);
    await deliver(env, [unit('p1', 'light')]);
    expect(google.requests.map((r) => r.method)).toEqual(['POST']);
  });

  it('keeps a light unit as full when Google no longer has the offer', async () => {
    const { env } = setup([mug({ $app: { [APP_ID]: { input_ids: ['en~US~p1'] } } })]);
    const report = await deliver(env, [unit('p1', 'light')]);
    expect(report.kept).toEqual([expect.objectContaining({ productId: 'p1', kind: 'full' })]);
  });

  it('deletes the offer of a removed variant', async () => {
    const product = mug({
      variants: { results: [{ id: 'v1', name: 'Red', active: true }] },
      $app: { [APP_ID]: { input_ids: ['en~US~v1', 'en~US~v2'] } },
    });
    const { google, env, appFields } = setup([product]);
    google.inputs.set(`${DS}|en~US~v2`, {});
    await deliver(env, [unit('p1')]);
    expect(google.inputs.has(`${DS}|en~US~v2`)).toBe(false);
    expect(appFields('p1').input_ids).toEqual(['en~US~v1']);
  });

  it('deletes every offer of a product hidden from Google', async () => {
    const { google, env, appFields } = setup([mug({ $app: { [APP_ID]: { excluded: true, input_ids: ['en~US~p1'] } } })]);
    google.inputs.set(`${DS}|en~US~p1`, {});
    await deliver(env, [unit('p1')]);
    expect(google.inputs.size).toBe(0);
    expect(appFields('p1')).toMatchObject({ sync_state: 'skipped', sync_reason: 'excluded', input_ids: [] });
  });

  it('a first send marks the product pending', async () => {
    const { env, appFields } = setup([mug()]);
    await deliver(env, [unit('p1')]);
    expect(appFields('p1')).toMatchObject({ status: 'pending', status_label: 'Pending', status_issues: [], date_status: expect.any(String) });
    expect(appFields('p1').status_hash).toEqual(expect.any(String));
  });

  it('a resend keeps an approved status', async () => {
    const stored = { status: 'approved', status_label: 'Approved', status_hash: 'abc', input_ids: ['en~US~p1'] };
    const { env, appFields } = setup([mug({ $app: { [APP_ID]: stored } })]);
    await deliver(env, [unit('p1')]);
    expect(appFields('p1')).toMatchObject({ status: 'approved', status_label: 'Approved', status_hash: 'abc', sync_state: 'sent' });
  });

  it('a skipped product gets its reason as status', async () => {
    const { env, appFields } = setup([mug({ price: 0, images: [] })]);
    await deliver(env, [unit('p1')]);
    const fields = appFields('p1');
    expect(fields).toMatchObject({ sync_state: 'skipped', status: 'not_sent' });
    expect(fields.status_label).toMatch(/^Not sent: /);
  });

  it('a product hidden from Google gets the excluded status', async () => {
    const { env, appFields } = setup([mug({ $app: { [APP_ID]: { excluded: true } } })]);
    await deliver(env, [unit('p1')]);
    expect(appFields('p1')).toMatchObject({ status: 'excluded', status_label: 'Hidden from Google' });
  });

  it('a product that comes back from not sent is pending', async () => {
    const stored = { status: 'not_sent', status_label: 'Not sent: inactive', status_hash: 'x', status_issues: [], input_ids: [] };
    const { env, appFields } = setup([mug({ $app: { [APP_ID]: stored } })]);
    await deliver(env, [unit('p1')]);
    expect(appFields('p1')).toMatchObject({ status: 'pending', status_label: 'Pending' });
  });

  it('one PUT per product with input_ids and status_issues in one $set', async () => {
    const { env, swell } = setup([mug()]);
    await deliver(env, [unit('p1')]);
    const puts = batchesOf(swell).flat().filter((op) => op.method === 'put' && op.url === '/products/p1');
    expect(puts).toHaveLength(1);
    const app = (puts[0].data as any).$app[APP_ID];
    expect(app.$set).toEqual({ input_ids: ['en~US~p1'], status_issues: [] });
    expect(app).not.toHaveProperty('input_ids');
    expect(app).not.toHaveProperty('status_issues');
    expect(Object.keys((puts[0].data as any).$app)).toEqual([APP_ID]);
  });

  it('a stored choice makes the written marker true', async () => {
    const stored = { status: 'approved', status_label: 'Approved', status_hash: 'x', status_issues: [], attribute_options: { color: 'o1' } };
    const { env, appFields } = setup([mug({ $app: { [APP_ID]: stored } })]);
    await deliver(env, [unit('p1')]);
    expect(appFields('p1')).toMatchObject({ needs_attributes: true });
  });

  it('clearing a choice turns the marker off on the next send', async () => {
    const stored = { status: 'approved', status_label: 'Approved', status_hash: 'x', status_issues: [], attribute_options: { color: null }, needs_attributes: true };
    const { env, appFields } = setup([mug({ $app: { [APP_ID]: stored } })]);
    await deliver(env, [unit('p1')]);
    expect(appFields('p1')).toMatchObject({ needs_attributes: false });
  });

  it('deletes the inputs of a deleted product without writing to it', async () => {
    const { google, env } = setup([]);
    google.inputs.set(`${DS}|en~US~v1`, {});
    const report = await deliver(env, [unit('gone', 'delete', { inputIds: ['en~US~v1', 'en~US~missing'] })]);
    expect(google.inputs.size).toBe(0);
    expect(report.done).toHaveLength(1);
  });

  it('records a rejected offer as an error and finishes the unit', async () => {
    const reject = { status: 400, body: { error: { code: 400, message: 'Invalid GTIN' } } };
    const { env, appFields } = setup([mug()], { offerErrors: { p1: reject } });
    const report = await deliver(env, [unit('p1')]);
    expect(report.done).toHaveLength(1);
    expect(appFields('p1')).toMatchObject({ sync_state: 'error', sync_error: 'Invalid GTIN', input_ids: [] });
  });

  it('a product whose every offer Google refused is not sent, with Google’s message', async () => {
    const reject = { status: 400, body: { error: { code: 400, message: 'Invalid GTIN' } } };
    const stored = { status: 'approved', status_label: 'Approved', status_hash: 'abc' };
    const { env, appFields } = setup([mug({ $app: { [APP_ID]: stored } })], { offerErrors: { p1: reject } });
    await deliver(env, [unit('p1')]);
    expect(appFields('p1')).toMatchObject({
      status: 'not_sent',
      status_label: 'Not sent: Google refused it',
      status_issues: [{ code: 'refused_by_google', severity: 'disapproved', description: 'Invalid GTIN', offers: ['en~US~p1'], countries: [] }],
    });
  });

  it('a product with one refused and one sent offer is pending', async () => {
    const reject = { status: 400, body: { error: { code: 400, message: 'Invalid GTIN' } } };
    const variants = { results: [{ id: 'v1', name: 'Red', active: true }, { id: 'v2', name: 'Blue', active: true }] };
    const { env, appFields } = setup([mug({ variants })], { offerErrors: { v2: reject } });
    await deliver(env, [unit('p1')]);
    expect(appFields('p1')).toMatchObject({ sync_state: 'error', status: 'pending', input_ids: ['en~US~v1'] });
  });

  it('keeps a unit whose offer was rate limited and finishes the others', async () => {
    const rate = { status: 429, body: { error: { message: 'quota/request_rate_too_high' } } };
    const { env } = setup([mug(), mug({ id: 'p2', slug: 'p2' })], { offerErrors: { p2: rate } });
    const report = await deliver(env, [unit('p1'), unit('p2')]);
    expect(report.done.map((u) => u.productId)).toEqual(['p1']);
    expect(report.kept.map((u) => u.productId)).toEqual(['p2']);
  });

  it('reports a part answered 429 as a non-fatal run failure', async () => {
    const rate = { status: 429, body: { error: { message: 'quota/request_rate_too_high' } } };
    const { env, appFields } = setup([mug()], { offerErrors: { p1: rate } });
    const report = await deliver(env, [unit('p1')]);
    expect(report.failure).toMatchObject({ kind: 'rate', status: 429, message: 'quota/request_rate_too_high' });
    expect(report.kept.map((u) => u.productId)).toEqual(['p1']);
    expect(report.kept[0].charge).toBeFalsy();
    expect(appFields('p1')).toBeUndefined();
  });

  it('charges a unit whose part got a 5xx', async () => {
    const outage = { status: 503, body: { error: { message: 'The service is currently unavailable.' } } };
    const { env } = setup([mug(), mug({ id: 'p2', slug: 'p2' })], { offerErrors: { p2: outage } });
    const report = await deliver(env, [unit('p1'), unit('p2')]);
    expect(report.done.map((u) => u.productId)).toEqual(['p1']);
    expect(report.kept).toEqual([expect.objectContaining({ productId: 'p2', charge: true })]);
    expect(report.failure).toMatchObject({ kind: 'server', status: 503 });
  });

  it('keeps every unit when the whole batch is rate limited', async () => {
    const { env, appFields } = setup([mug()], { batch: { status: 429, body: { error: { message: 'quota/request_rate_too_high' } } } });
    const report = await deliver(env, [unit('p1')]);
    expect(report.done).toHaveLength(0);
    expect(report.kept).toHaveLength(1);
    expect(report.failure?.kind).toBe('rate');
    expect(appFields('p1')).toBeUndefined();
  });

  it('reports an auth failure of a part as the run’s failure', async () => {
    const { env } = setup([mug()], { offerErrors: { p1: { status: 401, body: { error: { message: 'Request had invalid credentials' } } } } });
    const report = await deliver(env, [unit('p1')]);
    expect(report.failure?.kind).toBe('auth');
    expect(report.kept).toHaveLength(1);
  });

  it('splits a product with more than 100 offers', async () => {
    const variants = Array.from({ length: 120 }, (_, i) => ({ id: `v${i}`, name: `V${i}`, active: true }));
    const { google, env, appFields } = setup([mug({ variants: { results: variants } })]);
    const report = await deliver(env, [unit('p1')]);
    expect(google.batches()).toBe(2);
    expect(report.done).toHaveLength(1);
    expect(appFields('p1').input_ids).toHaveLength(120);
  });

  it('keeps what it had no time to send', async () => {
    const variants = Array.from({ length: 120 }, (_, i) => ({ id: `v${i}`, name: `V${i}`, active: true }));
    // Each clock read moves 2 s: the second batch starts past the reserve.
    const { google, env } = setup([mug({ variants: { results: variants } })], {}, steppingClock(undefined, 2000));
    const report = await deliver(env, [unit('p1')]);
    expect(google.batches()).toBe(1);
    expect(report.kept).toHaveLength(1);
    expect(report.kept[0].progress).toHaveLength(100);
  });

  it('keeps the id of an offer Google still holds after a rejected update', async () => {
    const reject = { status: 400, body: { error: { code: 400, message: 'Invalid GTIN' } } };
    const { google, env, appFields } = setup([mug({ $app: { [APP_ID]: { input_ids: ['en~US~p1'] } } })], { offerErrors: { p1: reject } });
    google.inputs.set(`${DS}|en~US~p1`, {});
    const report = await deliver(env, [unit('p1')]);
    expect(report.done).toHaveLength(1);
    expect(appFields('p1')).toMatchObject({ sync_state: 'error', input_ids: ['en~US~p1'] });
  });

  it('survives a failed product write', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { env, refuse } = setup([mug()]);
    refuse((method, url) => (method === 'put' && url === '/products/p1' ? 'write failed' : null));
    const report = await deliver(env, [unit('p1')]);
    expect(report.done.map((u) => u.productId)).toEqual(['p1']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('write failed'));
  });

  it('leaves every product write for one batch', async () => {
    const products = [mug(), mug({ id: 'p2', slug: 'p2' }), mug({ id: 'p3', slug: 'p3' })];
    const { env, swell, appFields } = setup(products);
    await deliverOnly(env, products.map((p) => unit(p.id)));
    expect(swell.put).not.toHaveBeenCalled();
    expect(env.outbox.size).toBe(3);
    await env.outbox.send();
    expect(batchesOf(swell)).toHaveLength(1);
    expect(appFields('p3')).toMatchObject({ sync_state: 'sent' });
  });

  it('uses products the caller read', async () => {
    const { env, swell, google } = setup([]);
    await deliverOnly(env, [unit('p1')], new Map([['p1', mug() as SwellProduct]]));
    expect(swell.get).not.toHaveBeenCalled();
    expect(google.inputs.size).toBe(1);
  });

  it('reports units it never reached as untouched', async () => {
    const variants = Array.from({ length: 120 }, (_, i) => ({ id: `v${i}`, name: `V${i}`, active: true }));
    const { env } = setup([mug({ variants: { results: variants } }), mug({ id: 'p2', slug: 'p2' })], {}, steppingClock(undefined, 1400));
    const report = await deliver(env, [unit('p1'), unit('p2')]);
    expect(report.kept.map((u) => u.productId)).toEqual(['p1']);
    expect(report.kept[0].progress).toHaveLength(100);
    expect(report.untouched.map((u) => u.productId)).toEqual(['p2']);
  });

  it('continues deleting a product too big for one run', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `en~US~v${i}`);
    const first = setup([], {}, steppingClock(undefined, 3000));
    ids.forEach((id) => first.google.inputs.set(`${DS}|${id}`, {}));
    const report = await deliver(first.env, [unit('gone', 'delete', { inputIds: ids })]);
    expect(report.kept).toHaveLength(1);
    expect(report.kept[0].progress).toHaveLength(100);
    expect(first.google.inputs.size).toBe(50);

    const second = setup([]);
    ids.slice(100).forEach((id) => second.google.inputs.set(`${DS}|${id}`, {}));
    const again = await deliver(second.env, [unit('gone', 'delete', { inputIds: ids, doneInputIds: report.kept[0].progress })]);
    expect(second.google.batches()).toBe(1);
    expect(again.done).toHaveLength(1);
    expect(second.google.inputs.size).toBe(0);
  });

  it('deletes offers carried over from an earlier revision that vanished', async () => {
    const { google, env } = setup([mug()]);
    google.inputs.set(`${DS}|en~US~vOld`, {});
    await deliver(env, [unit('p1', 'full', { inputIds: ['en~US~vOld'] })]);
    expect(google.inputs.has(`${DS}|en~US~vOld`)).toBe(false);
  });

  it('deletes the offers a revision sent when its product is gone', async () => {
    const { google, env } = setup([]);
    google.inputs.set(`${DS}|en~US~v1`, {});
    google.inputs.set(`${DS}|en~US~v3`, {});
    // An update's unit: v3 was sent (upserted) in this revision, then the product was deleted.
    const report = await deliver(env, [unit('gone', 'full', { inputIds: ['en~US~v1', 'en~US~v3'], doneInputIds: ['en~US~v3'] })]);
    expect(report.done).toHaveLength(1);
    expect(google.inputs.size).toBe(0);
  });

  it('skips a delete done earlier in this revision', async () => {
    const { google, env } = setup([]);
    google.inputs.set(`${DS}|en~US~v2`, {});
    await deliver(env, [unit('gone', 'delete', { inputIds: ['en~US~v1', 'en~US~v2'], doneInputIds: ['en~US~v1'] })]);
    expect(google.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
    expect(google.inputs.size).toBe(0);
  });

  it('skips offers sent earlier in this revision', async () => {
    const variants = Array.from({ length: 120 }, (_, i) => ({ id: `v${i}`, name: `V${i}`, active: true }));
    const { google, env, appFields } = setup([mug({ variants: { results: variants } })]);
    const doneInputIds = variants.slice(0, 100).map((v) => `en~US~${v.id}`);
    const report = await deliver(env, [unit('p1', 'full', { doneInputIds })]);
    expect(google.batches()).toBe(1);
    expect(google.requests.filter((r) => r.method === 'POST')).toHaveLength(20);
    expect(report.done).toHaveLength(1);
    expect(appFields('p1').input_ids).toHaveLength(120);
  });
});
