import { describe, expect, it } from 'vitest';
import { editRow, gtinTableModel, setCell, tableValidity, variantList, variantPage, variantsNote } from '../../../components/lib/gtin-table';
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

  it('the legacy MPN shows as the shared value until the shared row is written', () => {
    const record = { variants: VARIANTS, $app: { [APP]: { mpn: 'LEGACY' } } };
    for (const value of [null, {}, { v1: { gtin: '4006381333931' } }]) {
      const model = gtinTableModel(record, value, APP);
      expect(model.rows[0]).toMatchObject({ key: 'product', mpn: 'LEGACY', mpnPlaceholder: '' });
      expect(model.rows[1].mpnPlaceholder).toBe('LEGACY');
    }
    const written = gtinTableModel(record, { product: { mpn: 'NEW' } }, APP);
    expect(written.rows[0].mpn).toBe('NEW');
    expect(written.rows[1].mpnPlaceholder).toBe('NEW');
    const cleared = gtinTableModel(record, setCell(null, 'product', 'mpn', ''), APP);
    expect(cleared.rows[0].mpn).toBe('');
    expect(cleared.rows[1].mpnPlaceholder).toBe('');

    const single = { $app: { [APP]: { mpn: 'LEGACY' } } };
    expect(gtinTableModel(single, null, APP).rows[0]).toMatchObject({ label: 'This product', mpn: 'LEGACY', mpnPlaceholder: '' });
    expect(gtinTableModel(single, { product: null }, APP).rows[0].mpn).toBe('');
  });

  it('the first edit of This product keeps the legacy MPN it shows', () => {
    const record = { $app: { [APP]: { mpn: 'LEGACY' } } };
    const [row] = gtinTableModel(record, null, APP).rows;
    const next = editRow(null, row, 'gtin', '4006381333931');
    expect(next).toEqual({ product: { mpn: 'LEGACY', gtin: '4006381333931' } });
    expect(gtinTableModel(record, next, APP).rows[0]).toMatchObject({ gtin: '4006381333931', mpn: 'LEGACY' });
    expect(editRow(null, row, 'mpn', 'LEGACY-2')).toEqual({ product: { mpn: 'LEGACY-2' } });
    expect(editRow(null, row, 'mpn', '')).toEqual({ product: null });
    const [variantRow] = gtinTableModel({ variants: VARIANTS, $app: record.$app }, null, APP).rows.slice(1);
    expect(editRow(null, variantRow, 'gtin', '4006381333931')).toEqual({ v1: { gtin: '4006381333931' } });
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

  it('builds the variant rows from the full list once it is loaded', () => {
    const record = { variants: { count: 30, results: [VARIANTS[0], VARIANTS[1]] } };
    const all = [...VARIANTS, ...Array.from({ length: 26 }, (_, i) => ({ id: `w${i}`, name: `W${i}`, active: true }))];
    const model = gtinTableModel(record, { w7: { gtin: '4006381333931' } }, APP, all);
    expect(model.rows).toHaveLength(1 + 28);
    expect(model.rows.map((r) => r.key).slice(0, 4)).toEqual(['product', 'v1', 'v2', 'w0']);
    expect(model.rows.find((r) => r.key === 'w7')?.gtin).toBe('4006381333931');
    expect(gtinTableModel(record, null, APP, null).rows.map((r) => r.key)).toEqual(['product', 'v1', 'v2']);
    expect(gtinTableModel(record, null, APP, []).rows.map((r) => r.key)).toEqual(['product', 'v1', 'v2']);
  });
});

describe('variantPage', () => {
  it('reads the page of variants the admin hands over', () => {
    const page = (count: number, shown: number) => ({ variants: { count, results: VARIANTS.slice(0, shown) } });
    expect(variantPage(page(40, 2))).toEqual({ shown: 2, total: 40 });
    expect(variantPage(page(2, 2))).toBeNull();
    expect(variantPage(page(1, 2))).toBeNull();
  });

  it('is null when the record holds every variant or none', () => {
    expect(variantPage({ variants: VARIANTS })).toBeNull();
    expect(variantPage({ variants: { results: VARIANTS } })).toBeNull();
    expect(variantPage({})).toBeNull();
    expect(variantPage({ variants: null })).toBeNull();
  });
});

describe('variantList', () => {
  it('reads the route’s answer', () => {
    const variants = [{ id: 'v1', name: 'S', active: true }];
    expect(variantList({ variants, total: 40 })).toEqual({ variants, total: 40 });
    expect(variantList({ variants })).toEqual({ variants, total: 1 });
  });

  it('is null for an answer without a list', () => {
    expect(variantList(null)).toBeNull();
    expect(variantList({ total: 3 })).toBeNull();
    expect(variantList({ variants: 'v1' })).toBeNull();
  });
});

describe('variantsNote', () => {
  const page = { shown: 25, total: 40 };

  it('says how many variants the table shows until the rest arrive', () => {
    expect(variantsNote(page, null, false)).toBe('Showing 25 of 40 variants.');
    expect(variantsNote(page, null, true)).toBe('Showing 25 of 40 variants. Could not load the rest.');
  });

  it('says nothing once every variant is loaded, or when the page holds them all', () => {
    const variants = Array.from({ length: 40 }, (_, i) => ({ id: `v${i}` }));
    expect(variantsNote(page, { variants, total: 40 }, false)).toBeNull();
    expect(variantsNote(null, null, false)).toBeNull();
  });

  it('names the cap when the product has more variants than the list holds', () => {
    const variants = Array.from({ length: 500 }, (_, i) => ({ id: `v${i}` }));
    expect(variantsNote(page, { variants, total: 612 }, false)).toBe('Showing 500 of 612 variants.');
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
