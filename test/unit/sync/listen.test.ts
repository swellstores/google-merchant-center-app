import { describe, expect, it } from 'vitest';
import { planFromEvent } from '../../../functions/lib/sync/listen';

const APP = 'google_merchant_center';
const ev = (type: string, data: Record<string, any> = {}) => ({ type, data });

describe('planFromEvent', () => {
  it('sends a new product in full', () => {
    expect(planFromEvent(APP, ev('product.created', { id: 'p1' }), { id: 'p1' })).toEqual({ productId: 'p1', kind: 'full' });
  });

  it('sends a price or stock change as a light update', () => {
    expect(planFromEvent(APP, ev('product.updated', { price: 11, purchase_options: {} }), { id: 'p1' })).toEqual({ productId: 'p1', kind: 'light' });
    expect(planFromEvent(APP, ev('product.updated', { stock_level: 4 }), { id: 'p1' })).toEqual({ productId: 'p1', kind: 'light' });
  });

  it('sends other relevant changes in full', () => {
    expect(planFromEvent(APP, ev('product.updated', { name: 'New', price: 3 }), { id: 'p1' })).toEqual({ productId: 'p1', kind: 'full' });
  });

  it('sends a change of the merchant’s Google fields in full', () => {
    expect(planFromEvent(APP, ev('product.updated', { $app: { [APP]: { brand: 'Acme' } } }), { id: 'p1' })).toEqual({
      productId: 'p1',
      kind: 'full',
    });
  });

  it('ignores updates that only touch the app’s sync fields', () => {
    const data = { $app: { [APP]: { sync_state: 'sent', input_ids: ['en~US~p1'], date_synced: 'x', sync_error: null, sync_reason: null } } };
    expect(planFromEvent(APP, ev('product.updated', data), { id: 'p1' })).toBeNull();
  });

  it('a status write does not queue the product', () => {
    const data = {
      $app: { [APP]: { status: 'approved', status_label: 'Approved', status_hash: 'x', date_status: '2026-10-16T10:00:00.000Z', status_issues: [] } },
    };
    expect(planFromEvent(APP, ev('product.updated', data), { id: 'p1' })).toBeNull();
  });

  it('ignores changes Google never sees', () => {
    expect(planFromEvent(APP, ev('product.updated', { date_updated: 'x', meta_title: 'y' }), { id: 'p1' })).toBeNull();
    expect(planFromEvent(APP, ev('product.updated', { $app: { other_app: { x: 1 } } }), { id: 'p1' })).toBeNull();
  });

  it('plans variant changes on the parent product', () => {
    expect(planFromEvent(APP, ev('product.variant.updated', { stock_level: 0 }), { id: 'v1', parent_id: 'p1' })).toEqual({
      productId: 'p1',
      kind: 'light',
    });
    expect(planFromEvent(APP, ev('product.variant.deleted', { id: 'v1' }), { id: 'v1', parent_id: 'p1' })).toEqual({
      productId: 'p1',
      kind: 'full',
    });
  });

  it('deletes a deleted product with the inputs it had in Google', () => {
    const data = { id: 'p1', $app: { [APP]: { input_ids: ['en~US~v1', 'en~US~v2'] } } };
    expect(planFromEvent(APP, ev('product.deleted', data), data)).toEqual({ productId: 'p1', kind: 'delete', inputIds: ['en~US~v1', 'en~US~v2'] });
    expect(planFromEvent(APP, ev('product.deleted', { id: 'p2' }), { id: 'p2' })).toEqual({ productId: 'p2', kind: 'delete', inputIds: [] });
  });

  it('returns nothing without an event or product id', () => {
    expect(planFromEvent(APP, undefined, {})).toBeNull();
    expect(planFromEvent(APP, ev('product.variant.updated', { price: 1 }), { id: 'v1' })).toBeNull();
  });

  it('deletes a product whose id is only in the event', () => {
    expect(planFromEvent(APP, ev('product.deleted', { id: 'p3', $app: { [APP]: { input_ids: ['en~US~p3'] } } }), {})).toEqual({
      productId: 'p3',
      kind: 'delete',
      inputIds: ['en~US~p3'],
    });
  });

  it('plans a deleted variant on the parent from the event', () => {
    expect(planFromEvent(APP, ev('product.variant.deleted', { id: 'v1', parent_id: 'p1' }), {})).toEqual({ productId: 'p1', kind: 'full' });
  });

  it('sends a stock adjustment as a light update', () => {
    expect(planFromEvent(APP, ev('product.stock_adjusted', { variant_id: 'v1', quantity: 5 }), { id: 'p1' })).toEqual({ productId: 'p1', kind: 'light' });
  });
});
