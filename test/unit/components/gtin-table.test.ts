import { describe, expect, it } from 'vitest';
import { gtinProblem, gtinTableModel, setCell, tableValidity, variantList, variantPage, variantsNote, type GtinRow } from '../../../components/lib/gtin-table';
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
  it('a product without variants has one GTIN cell and no MPN cell', () => {
    const model = gtinTableModel({}, { product: { gtin: '4006381333931', mpn: 'OLD-SHARED' } }, APP);
    expect(model.perVariant).toBe(false);
    expect(model.rows).toEqual([{ key: 'product', label: 'This product', gtin: '4006381333931', mpn: null }]);
  });

  it('lists the live variants only, one row each', () => {
    const model = gtinTableModel({ variants: { results: VARIANTS } }, null, APP);
    expect(model.perVariant).toBe(true);
    expect(model.rows.map((r) => [r.key, r.label, r.gtin, r.mpn])).toEqual([
      ['v1', 'S', '', ''],
      ['v2', 'M', '', ''],
    ]);
    expect(gtinTableModel({ variants: VARIANTS }, null, APP).rows.map((r) => r.key)).toEqual(['v1', 'v2']);
    expect(gtinTableModel({ variants: [{ id: 'v9', active: true }] }, null, APP).rows[0].label).toBe('v9');
  });

  it('shows the product’s MPN as the placeholder of each variant’s MPN cell', () => {
    const record = { variants: VARIANTS, $app: { [APP]: { mpn: 'SHIRT' } } };
    const model = gtinTableModel(record, { product: { mpn: 'OLD-SHARED' }, v2: { mpn: 'SHIRT-M' } }, APP);
    expect(model.rows[0]).toMatchObject({ key: 'v1', mpn: '', mpnPlaceholder: 'SHIRT' });
    expect(model.rows[1]).toMatchObject({ key: 'v2', mpn: 'SHIRT-M', mpnPlaceholder: 'SHIRT' });
    expect(gtinTableModel({ variants: VARIANTS }, null, APP).rows[0].mpnPlaceholder).toBe('');
    expect(gtinTableModel({ variants: VARIANTS, $app: { [APP]: { mpn: null } } }, null, APP).rows[0].mpnPlaceholder).toBe('');
  });

  it('cleared (null) entries and cells show empty', () => {
    const model = gtinTableModel({ variants: VARIANTS }, { v1: null, v2: { gtin: null, mpn: 'M-1' } }, APP);
    expect(model.rows.map((r) => [r.key, r.gtin, r.mpn])).toEqual([
      ['v1', '', ''],
      ['v2', '', 'M-1'],
    ]);
    expect(gtinTableModel({}, { product: null }, APP).rows[0]).toMatchObject({ gtin: '', mpn: null });
    expect(gtinTableModel({}, { product: { gtin: null } }, APP).rows[0].gtin).toBe('');
  });

  it('a new product without an id renders the single cell', () => {
    const model = gtinTableModel({ $app: undefined }, null, APP);
    expect(model.perVariant).toBe(false);
    expect(model.rows).toEqual([{ key: 'product', label: 'This product', gtin: '', mpn: null }]);
  });

  it.each([
    ['a mix of active, inactive and archived variants', VARIANTS, true],
    ['only inactive variants', [{ id: 'v4', name: 'Off', active: false }, { id: 'v5', name: 'Off too', active: false }], true],
    ['no variants', [], false],
  ])('the table’s rows match the units buildOffers sends: %s', (_, variants, perVariant) => {
    const product: SwellProduct = { id: PID, active: true, price: 10, images: [{ file: { url: 'https://cdn.example.com/a.jpg' } }], variants: { results: variants } };
    const model = gtinTableModel(product, null, APP);
    const sent = buildOffers(product, [MARKET], OPTS).offers.map((offer) =>
      offer.input.productAttributes.itemGroupId ? offer.input.offerId : 'product',
    );
    expect(model.perVariant).toBe(perVariant);
    expect(model.rows.map((row) => row.key)).toEqual(sent);
  });

  it('builds the variant rows from the full list once it is loaded', () => {
    const record = { variants: { count: 30, results: [VARIANTS[0], VARIANTS[1]] } };
    const all = [...VARIANTS, ...Array.from({ length: 26 }, (_, i) => ({ id: `w${i}`, name: `W${i}`, active: true }))];
    const model = gtinTableModel(record, { w7: { gtin: '4006381333931' } }, APP, all);
    expect(model.rows).toHaveLength(28);
    expect(model.rows.map((r) => r.key).slice(0, 3)).toEqual(['v1', 'v2', 'w0']);
    expect(model.rows.find((r) => r.key === 'w7')?.gtin).toBe('4006381333931');
    expect(gtinTableModel(record, null, APP, null).rows.map((r) => r.key)).toEqual(['v1', 'v2']);
    expect(gtinTableModel(record, null, APP, []).rows.map((r) => r.key)).toEqual(['v1', 'v2']);
  });
});

describe('gtinProblem', () => {
  const row = (gtin: string): GtinRow => ({ key: 'v1', label: 'S', gtin, mpn: '', mpnPlaceholder: '' });

  it('gives a short reason for the cell', () => {
    expect(gtinProblem(row('123'))).toBe('Needs 8, 12, 13 or 14 digits');
    expect(gtinProblem(row('4006-381333931'))).toBe('Digits only');
    expect(gtinProblem(row('4006381333932'))).toBe('Wrong check digit');
    expect(gtinProblem({ key: 'product', label: 'This product', gtin: '4006381333932', mpn: null })).toBe('Wrong check digit');
  });

  it('is null for a valid or empty cell', () => {
    expect(gtinProblem(row('4006381333931'))).toBeNull();
    expect(gtinProblem(row(' 4006381333931 '))).toBeNull();
    expect(gtinProblem(row(''))).toBeNull();
    expect(gtinProblem(row('   '))).toBeNull();
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
    expect(tableValidity(gtinTableModel({}, { product: { gtin: '123' } }, APP))).toBe('A barcode above is not a valid GTIN.');
  });

  it('checks only the cells the table shows', () => {
    const value = { v3: { gtin: '123' }, product: { gtin: '123' } };
    expect(tableValidity(gtinTableModel({ variants: VARIANTS }, value, APP))).toBeNull();
  });
});
