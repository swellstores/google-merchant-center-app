import { describe, expect, it } from 'vitest';
import { gtinTableModel, setCell, tableValidity } from '../../../components/lib/gtin-table';

const APP = 'google_merchant_center';
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

  it('an emptied cell is removed, not stored empty', () => {
    expect(setCell({ v1: { gtin: '4006381333931', mpn: 'A' } }, 'v1', 'gtin', '  ')).toEqual({ v1: { mpn: 'A' } });
    expect(setCell({ v1: { mpn: 'A' } }, 'v1', 'mpn', '')).toEqual({});
    expect(setCell(null, 'v1', 'mpn', '')).toEqual({});
  });
});

describe('tableValidity', () => {
  it('names the variant with a bad GTIN', () => {
    const model = gtinTableModel({ variants: VARIANTS }, { v2: { gtin: '4006381333932' } }, APP);
    expect(tableValidity(model)).toBe('GTIN of variant M: the check digit is wrong.');
    expect(tableValidity(gtinTableModel({ variants: VARIANTS }, { v2: { gtin: '4006381333931' } }, APP))).toBeNull();
  });
});
