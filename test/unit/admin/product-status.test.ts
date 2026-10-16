import { describe, expect, it } from 'vitest';
import { MAX_ANSWER_BYTES, previewContext, productStatusView, resendProduct } from '../../../functions/lib/admin/product-status';
import type { GoogleProductStatus } from '../../../functions/lib/status/product-status';
import { APP_ID, fixedClock, NOW, testContext } from '../../helpers/context';
import { batchesOf, createFakeSwell } from '../../helpers/fake-swell';
import { createFakeGoogle, type FakeGoogleOptions } from '../../helpers/fake-google';
import { makeServiceAccountKey } from '../../helpers/keys';
import { loadAlarm } from '../../helpers/store';

const DS = 'accounts/123/dataSources/1';
const FRESH = { access_token: 'SECRET-TOKEN', access_token_expires: new Date(NOW + 3_600_000).toISOString() };
const CONNECTED = { status: 'connected', merchant_id: '123', private_key: 'SECRET-KEY', client_email: 'sa@x.iam', ...FRESH };
const MARKET = { country: 'US', language: 'en', currency: 'USD', link_template: 'https://x.example.com/{slug}', data_source: DS };
const PID = 'a'.repeat(24);
const offerOf = (i: number | string) => `en~US~${i === 0 ? PID : `${PID}-${i}`}`;

const disapproved = (code: string, extra: Record<string, string> = {}): GoogleProductStatus => ({
  destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', disapprovedCountries: ['US'] }],
  itemLevelIssues: [{ code, severity: 'DISAPPROVED', description: `${code} text`, applicableCountries: ['US'], ...extra }],
  googleExpirationDate: '2026-11-01T00:00:00Z',
});

function product(fields: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { id: PID, name: 'Mug', $app: { [APP_ID]: fields }, ...extra };
}

function setup({ connection = CONNECTED as Record<string, unknown> | null, fields = {}, extra = {}, google: options = {} as FakeGoogleOptions, offers = 0 } = {}) {
  const google = createFakeGoogle(options);
  const ids = Array.from({ length: offers }, (_, i) => offerOf(i));
  for (const inputId of ids) {
    const [contentLanguage, feedLabel, offerId] = inputId.split('~');
    google.inputs.set(`${DS}|${inputId}`, { offerId, contentLanguage, feedLabel });
  }
  const fake = createFakeSwell({
    connection: connection ?? undefined,
    markets: [MARKET],
    products: [product({ sync_state: 'sent', ...(offers ? { input_ids: ids } : {}), ...fields }, extra)],
  });
  return { ...fake, google, ids, ctx: testContext(fake.swell, google.fetch, fixedClock(NOW)) };
}

describe('productStatusView', () => {
  it('a product never sent answers its stored reason without Google', async () => {
    const { ctx, swell, google } = setup({
      fields: { sync_state: 'skipped', sync_reason: 'no_price', status: 'not_sent', status_label: 'Not sent: no price', status_issues: [], date_status: '2026-10-15T00:00:00.000Z' },
    });
    const view = await productStatusView(ctx, PID, true);
    expect(view).toEqual({
      connected: true,
      stored: { status: 'not_sent', status_label: 'Not sent: no price', status_issues: [], date_status: '2026-10-15T00:00:00.000Z', sync_state: 'skipped', sync_reason: 'no_price' },
      live: null,
      live_error: null,
    });
    expect(google.requests).toEqual([]);
    expect(batchesOf(swell)).toHaveLength(1);
    expect(batchesOf(swell)[0].map((op) => op.url)).toEqual(['/connections', '/markets', `/products/${PID}`]);
    expect(batchesOf(swell)[0][2]).toEqual({ method: 'get', url: `/products/${PID}`, data: { expand: ['variants:1000'] } });
  });

  it('a disconnected store answers without Google', async () => {
    const { ctx, google } = setup({ connection: null, offers: 1 });
    const view = await productStatusView(ctx, PID, true);
    expect(view).toMatchObject({ connected: false, live: null, live_error: null });
    expect(google.requests).toEqual([]);
  });

  it('live=0 stays with the stored status', async () => {
    const { ctx, google } = setup({ offers: 1 });
    expect(await productStatusView(ctx, PID, false)).toMatchObject({ connected: true, live: null });
    expect(google.requests).toEqual([]);
  });

  it('a missing product is refused', async () => {
    const { ctx } = setup();
    await expect(productStatusView(ctx, 'b'.repeat(24), true)).rejects.toMatchObject({ code: 'product_not_found', status: 404 });
  });

  it('live offers carry market, variant name, status and issues', async () => {
    const variantId = `${PID}-1`;
    const { ctx, swell, google } = setup({
      offers: 0,
      fields: { input_ids: [`en~US~${PID}`, `en~US~${variantId}`, 'de~DE~gone'] },
      extra: { variants: { results: [{ id: variantId, name: 'Blue' }] } },
      google: { statuses: { [`en~US~${variantId}`]: disapproved('image_too_small', { detail: 'bigger please', documentation: 'https://doc' }) } },
    });
    google.inputs.set(`${DS}|en~US~${PID}`, {});
    google.inputs.set(`${DS}|en~US~${variantId}`, {});
    const view = await productStatusView(ctx, PID, true);
    expect(view.live?.checked_at).toBe(new Date(NOW).toISOString());
    expect(view.live?.more).toBe(0);
    const [plain, blue, unknown] = view.live!.offers;
    expect(plain).toMatchObject({ input_id: `en~US~${PID}`, market: 'US en', variant: null, status: 'pending', expires: expect.any(String) });
    expect(blue).toMatchObject({
      input_id: `en~US~${variantId}`,
      market: 'US en',
      variant: 'Blue',
      status: 'disapproved',
      expires: '2026-11-01T00:00:00Z',
      issues: [{ code: 'image_too_small', severity: 'disapproved', detail: 'bigger please', documentation: 'https://doc', countries: ['US'] }],
    });
    expect(unknown).toMatchObject({ input_id: 'de~DE~gone', market: 'DE de', variant: null, status: 'pending', expires: null, issues: [{ code: 'missing_in_google' }] });
    expect(google.batches()).toBe(1);
    expect(batchesOf(swell)).toHaveLength(1);
    expect(JSON.stringify(view)).not.toMatch(/SECRET/);
  });

  it('a Google failure answers the stored status with live_error', async () => {
    const { ctx } = setup({ offers: 1, fields: { status: 'pending', status_label: 'Pending' }, google: { batch: { status: 503, body: { error: { message: 'Backend down' } } } } });
    const view = await productStatusView(ctx, PID, true);
    expect(view.live).toBeNull();
    expect(view.live_error).toBe('Backend down');
    expect(view.stored).toMatchObject({ status: 'pending', status_label: 'Pending' });
  });

  it('a refused single offer is a live_error too', async () => {
    const { ctx } = setup({ offers: 1, google: { productsGetErrors: { [offerOf(0)]: { status: 403, body: { error: { message: 'No access' } } } } } });
    expect((await productStatusView(ctx, PID, true)).live_error).toBe('No access');
  });

  it('a refreshed token is stored in one more write', async () => {
    const { key } = await makeServiceAccountKey();
    const { ctx, swell, collections } = setup({ connection: { ...CONNECTED, ...key, access_token: null, access_token_expires: null }, offers: 1 });
    const view = await productStatusView(ctx, PID, true);
    expect(view.live?.offers).toHaveLength(1);
    expect(batchesOf(swell)).toHaveLength(2);
    expect(batchesOf(swell)[1]).toHaveLength(1);
    expect(collections['/connections'][0]).toMatchObject({ access_token: 'token-1' });
    expect(JSON.stringify(view)).not.toMatch(/token-1/);
  });

  it('checks the first 100 offers and counts the rest', async () => {
    const { ctx, google } = setup({ offers: 100, fields: { input_ids: Array.from({ length: 130 }, (_, i) => offerOf(i)) } });
    const view = await productStatusView(ctx, PID, true);
    expect(view.live?.offers).toHaveLength(100);
    expect(view.live?.more).toBe(30);
    expect(google.batches()).toBe(1);
  });

  it('a hundred offers with long issues stay under 75,000 bytes', async () => {
    const long = (code: string): GoogleProductStatus => ({
      destinationStatuses: [{ approvedCountries: [], disapprovedCountries: ['US'] }],
      itemLevelIssues: [0, 1, 2].map((n) => ({
        code: `${code}_${n}`,
        severity: 'DISAPPROVED',
        description: 'd'.repeat(400),
        detail: 'x'.repeat(2000),
        documentation: 'https://support.google.com/merchants/answer/1',
        applicableCountries: ['US'],
      })),
    });
    const statuses = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [offerOf(i), long(`c${i}`)]));
    const { ctx } = setup({ offers: 100, google: { statuses } });
    const view = await productStatusView(ctx, PID, true);
    const bytes = new TextEncoder().encode(JSON.stringify(view)).length;
    expect(bytes).toBeLessThan(75_000);
    expect(bytes).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    expect(view.live!.offers.length + view.live!.more).toBe(100);
    expect(view.live!.offers.length).toBeGreaterThan(0);
    expect(view.live!.offers[0].issues[0].detail).toBeUndefined();
  });

  it('keeps the details when the answer is small', async () => {
    const { ctx } = setup({ offers: 1, google: { statuses: { [offerOf(0)]: disapproved('a', { detail: 'keep me' }) } } });
    expect((await productStatusView(ctx, PID, true)).live!.offers[0].issues[0].detail).toBe('keep me');
  });
});

describe('resendProduct', () => {
  it('queues a full update and arms the alarm', async () => {
    const { ctx, collections, swell } = setup();
    expect(await resendProduct(ctx, PID)).toEqual({ queued: true });
    expect(collections['/queue-items']).toMatchObject([{ product_id: PID, kind: 'full' }]);
    expect((await loadAlarm(swell)).wake_at).not.toBeNull();
  });

  it('queues nothing while disconnected', async () => {
    const { ctx, collections } = setup({ connection: null });
    expect(await resendProduct(ctx, PID)).toEqual({ queued: true });
    expect(collections['/queue-items']).toEqual([]);
  });
});

describe('previewContext', () => {
  it('has the markets and no key', async () => {
    const { ctx } = setup();
    const context = await previewContext(ctx);
    expect(context).toEqual({
      app_id: APP_ID,
      markets: [{ country: 'US', language: 'en', currency: 'USD', link_template: 'https://x.example.com/{slug}' }],
      defaults: { condition: 'new' },
    });
    expect(JSON.stringify(context)).not.toMatch(/SECRET|data_source/);
  });
});
