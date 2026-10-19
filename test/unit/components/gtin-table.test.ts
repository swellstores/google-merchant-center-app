import { describe, expect, it } from 'vitest';
import { gtinTableModel, setCell, tableValidity } from '../../../components/lib/gtin-table';
import type { Market } from '../../../functions/lib/connection/markets';
import { buildOffers } from '../../../functions/lib/mapping/offers';
import type { SwellProduct } from '../../../functions/lib/mapping/types';
import { createFakeSwell } from '../../helpers/fake-swell';

const APP = 'google_merchant_center';
const PID = 'a'.repeat(24);
const MARKET: Market = { id: 'm1', country: 'US', language: 'en', currency: 'USD', link_template: 'https://shop.example.com/{slug}', data_source: 'accounts/1/dataSources/7' };
const OPTS = { appId: APP, defaults: { condition: 'new' as const }, version: '1' };
const VARIANTS = [
  { id: 'v1', name: 'S', active: true },
  { id: 'v2', name: 'M', active: true },
  { id: 'v3', name: 'Old', archived: true },
  { id: 'v4', name: 'Off', active: false },
];

describe('gtinTableModel', () => {
  it('a product without variants has one This product row', () => {
    const model = gtinTableModel({}, { product: { gtin: '4006381333931' } }, APP);
    expect(model.rows).toEqual([{ key: 'product', label: 'This product', gtin: '4006381333931', mpn: '', mpnPlaceholder: '' }]);
  });

  it('variants get an All variants MPN row first', () => {
    const model = gtinTableModel({ variants: { results: VARIANTS } }, null, APP);
    expect(model.rows.map((r) => [r.key, r.label, r.gtin])).toEqual([
      ['product', 'All variants', null],
      ['v1', 'S', ''],
      ['v2', 'M', ''],
    ]);
    expect(gtinTableModel({ variants: VARIANTS }, null, APP).rows).toHaveLength(3);
  });

  it('variant MPN placeholders show the shared MPN', () => {
    const model = gtinTableModel({ variants: VARIANTS }, { product: { mpn: 'SHIRT' }, v2: { mpn: 'SHIRT-M' } }, APP);
    expect(model.rows[0].mpn).toBe('SHIRT');
    expect(model.rows[1]).toMatchObject({ mpn: '', mpnPlaceholder: 'SHIRT' });
    expect(model.rows[2]).toMatchObject({ mpn: 'SHIRT-M', mpnPlaceholder: 'SHIRT' });
  });

  it('the legacy top-level MPN fills the All variants row', () => {
    const record = { variants: VARIANTS, $app: { [APP]: { mpn: 'LEGACY' } } };
    const model = gtinTableModel(record, null, APP);
    expect(model.rows[0]).toMatchObject({ mpn: '', mpnPlaceholder: 'LEGACY' });
    expect(model.rows[1].mpnPlaceholder).toBe('LEGACY');
  });

  it('turning the switch off keeps the values and disables the table', () => {
    const value = { v1: { gtin: '4006381333931' } };
    const model = gtinTableModel({ variants: VARIANTS, $app: { [APP]: { identifier_exists: false } } }, value, APP);
    expect(model.disabled).toBe(true);
    expect(model.note).toBe('Not sent while the switch above is off');
    expect(model.rows[1].gtin).toBe('4006381333931');
    expect(gtinTableModel({ variants: VARIANTS }, value, APP)).toMatchObject({ disabled: false, note: null });
  });

  it('cleared (null) entries and cells show empty', () => {
    const model = gtinTableModel({ variants: VARIANTS }, { product: { mpn: null }, v1: null, v2: { gtin: null, mpn: 'M-1' } }, APP);
    expect(model.rows.map((r) => [r.key, r.gtin, r.mpn])).toEqual([
      ['product', null, ''],
      ['v1', '', ''],
      ['v2', '', 'M-1'],
    ]);
    expect(gtinTableModel({}, { product: null }, APP).rows[0]).toMatchObject({ gtin: '', mpn: '' });
  });

  it('a new product without an id renders the single row', () => {
    const model = gtinTableModel({ $app: undefined }, null, APP);
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].label).toBe('This product');
  });
});

describe('setCell', () => {
  it('keeps entries of variants it does not show', () => {
    const next = setCell({ gone: { gtin: '1', mpn: 'X' }, v1: { mpn: 'A' } }, 'v1', 'gtin', '4006381333931');
    expect(next).toEqual({ gone: { gtin: '1', mpn: 'X' }, v1: { mpn: 'A', gtin: '4006381333931' } });
  });

  it('setCell keeps typed spaces', () => {
    expect(setCell(null, 'v1', 'mpn', 'AB ')).toEqual({ v1: { mpn: 'AB ' } });
    expect(setCell({ v1: { mpn: 'AB ' } }, 'v1', 'mpn', 'AB 1')).toEqual({ v1: { mpn: 'AB 1' } });
  });

  it('a whitespace-only cell is removed', () => {
    expect(setCell({ v1: { mpn: 'A' } }, 'v1', 'mpn', '   ')).toEqual({ v1: null });
  });

  // The platform merges a save into the stored object: a left-out key keeps its value, a null clears it
  it('an emptied cell is sent as null, not left out or stored empty', () => {
    expect(setCell({ v1: { gtin: '4006381333931', mpn: 'A' } }, 'v1', 'gtin', '  ')).toEqual({ v1: { gtin: null, mpn: 'A' } });
    expect(setCell({ v1: { gtin: null, mpn: 'A' } }, 'v1', 'mpn', '')).toEqual({ v1: null });
    expect(setCell({ v1: { mpn: 'A' }, v2: { gtin: '1' } }, 'v1', 'mpn', '')).toEqual({ v1: null, v2: { gtin: '1' } });
    expect(setCell(null, 'v1', 'mpn', '')).toEqual({ v1: null });
  });

  it('a cell typed into a cleared entry starts it again', () => {
    expect(setCell({ v1: null }, 'v1', 'gtin', '4006381333931')).toEqual({ v1: { gtin: '4006381333931' } });
  });

  it('a cleared GTIN is gone after the save', async () => {
    const product: SwellProduct = {
      id: PID,
      active: true,
      price: 10,
      images: [{ file: { url: 'https://cdn.example.com/a.jpg' } }],
      variants: { results: [VARIANTS[0], VARIANTS[1]] },
      $app: { [APP]: { identifiers: { v1: { mpn: 'S-1' }, v2: { gtin: '4006381333931' } } } },
    };
    const { swell } = createFakeSwell({ products: [product] });
    const stored = ((await swell.get(`/products/${PID}`)) as SwellProduct).$app![APP]!.identifiers ?? null;

    await swell.put(`/products/${PID}`, { $app: { [APP]: { identifiers: setCell(stored, 'v2', 'gtin', '') } } });

    const saved = (await swell.get(`/products/${PID}`)) as SwellProduct;
    const model = gtinTableModel(saved, saved.$app![APP]!.identifiers ?? null, APP);
    expect(model.rows.find((row) => row.key === 'v2')?.gtin).toBe('');
    expect(model.rows.find((row) => row.key === 'v1')?.mpn).toBe('S-1');
    const sent = buildOffers(saved, [MARKET], OPTS).offers.find((offer) => offer.input.offerId === 'v2');
    expect(sent).toBeDefined();
    expect(sent!.input.productAttributes.gtins).toBeUndefined();
  });
});

describe('tableValidity', () => {
  // The admin shows this under the field after a save; the table itself names each bad cell
  it('summarises the bad GTINs without repeating the table', () => {
    const one = gtinTableModel({ variants: VARIANTS }, { v2: { gtin: '4006381333932' } }, APP);
    expect(tableValidity(one)).toBe('A barcode above is not a valid GTIN.');
    const two = gtinTableModel({ variants: VARIANTS }, { v1: { gtin: '123' }, v2: { gtin: '4006381333932' } }, APP);
    expect(tableValidity(two)).toBe('2 barcodes above are not valid GTINs.');
    expect(tableValidity(gtinTableModel({ variants: VARIANTS }, { v2: { gtin: '4006381333931' } }, APP))).toBeNull();
  });
});
