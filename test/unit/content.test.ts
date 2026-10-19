/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import content from '../../content/products.json';

// The tests run in the Workers runtime, which has no real filesystem; the glob lists the files at build time
const componentFiles = Object.keys(import.meta.glob('../../components/*.tsx'));

const topFields: any[] = content.fields;
const tab = content.views
  .find((v: any) => v.id === 'edit')
  .tabs.find((t: any) => t.id === 'google');

function flatten(fields: any[]): any[] {
  return fields.flatMap((f) => (f.fields ? [f, ...flatten(f.fields)] : [f]));
}

function resolve(viewField: any) {
  const top = topFields.find((f) => f.id === viewField.id);
  return { ...top, ...viewField };
}

const tabFields = flatten(tab.fields).filter((f) => f.id);
const byId = (id: string) => resolve(tabFields.find((f) => f.id === id));

const hints: Record<string, string> = {
  excluded:
    'Turn off to keep this product out of Google Shopping and free listings. Products already in Google are removed within minutes.',
  brand:
    'The brand of the product. Google requires it for most products; without it the product may be shown less or disapproved.',
  condition: 'Whether the product is new, used or refurbished. Empty means new.',
  google_category:
    "Optional. Google picks a category itself from the title and description; set it only to correct Google. Paste the category number or its full path from Google's list.",
  identifier_exists:
    'Turn off for handmade, custom or vintage products that have no barcode and no manufacturer part number. Otherwise Google expects a GTIN or an MPN with the brand.',
  identifiers:
    "GTIN is the barcode number (UPC, EAN, ISBN). MPN is the manufacturer's part number. Give them per variant when the variants have their own.",
  age_group:
    'Only for clothing and accessories: the age group the product is for. Google requires it for them.',
  gender:
    'Only for clothing and accessories: who the product is for. Google requires it for them.',
  status_panel: 'What Google says about this product right now.',
  preview: 'How the product can look in Google Shopping, from the unsaved form.',
};

describe('products content, Google tab', () => {
  it('lists the fields in order', () => {
    expect(tab.fields[0]).toEqual({ id: 'excluded' });
    expect(tab.fields).toHaveLength(3);

    // The admin moves top-level groups to a tab strip after all other fields; a group inside a row stays in place
    const row: any = tab.fields[1];
    expect(row.type).toBe('field_row');
    expect(row.fields).toHaveLength(1);
    const group: any = row.fields[0];
    expect(group.type).toBe('field_group');
    expect(group.label).toBe('Product details for Google');
    expect(group.fields.map((f: any) => f.id ?? f.fields.map((c: any) => c.id))).toEqual([
      ['brand', 'condition'],
      'google_category',
      'identifier_exists',
      'identifiers',
      ['age_group', 'gender'],
    ]);
    expect(group.fields[0].type).toBe('field_row');
    expect(group.fields[4].type).toBe('field_row');

    const last = tab.fields[2];
    expect(last.type).toBe('field_row');
    expect(last.fields.map((f: any) => f.id)).toEqual(['status_panel', 'preview']);
  });

  it('gives every field the exact hint and no description', () => {
    for (const [id, hint] of Object.entries(hints)) {
      const field = byId(id);
      expect(field.hint, id).toBe(hint);
      expect(field.description, id).toBeUndefined();
    }
  });

  it('binds the components', () => {
    expect(byId('excluded')).toMatchObject({
      type: 'component',
      component: 'GoogleListingSwitch',
      label: 'Google listing',
    });
    expect(byId('brand')).toMatchObject({ type: 'component', component: 'BrandInput' });
    expect(byId('google_category')).toMatchObject({
      type: 'component',
      component: 'GoogleCategoryField',
    });
    expect(byId('identifiers')).toMatchObject({
      type: 'component',
      component: 'GtinTable',
      label: 'Barcodes and part numbers',
    });
    expect(byId('status_panel')).toMatchObject({ type: 'component', component: 'GoogleStatus' });
    expect(byId('preview')).toMatchObject({ type: 'component', component: 'ShoppingPreview' });
  });

  it('sets the labels, placeholder and native types', () => {
    expect(byId('identifier_exists')).toMatchObject({
      type: 'toggle',
      label: 'Has a barcode (GTIN) or part number (MPN)',
    });
    expect(byId('condition')).toMatchObject({ type: 'select', placeholder: 'New' });
  });

  it('always shows age group and gender', () => {
    expect(byId('age_group').conditions).toBeUndefined();
    expect(byId('gender').conditions).toBeUndefined();
  });

  it('spans brand, condition, status and preview over half the row', () => {
    for (const id of ['brand', 'condition', 'status_panel', 'preview']) {
      expect(byId(id).admin_span, id).toBe(2);
    }
  });

  it('uses only components that exist', () => {
    const names = flatten([...topFields, ...tab.fields])
      .map((f) => f.component)
      .filter(Boolean);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(componentFiles, name).toContain(`../../components/${name}.tsx`);
    }
  });

  it('no longer defines mpn', () => {
    expect(topFields.find((f) => f.id === 'mpn')).toBeUndefined();
    expect(tabFields.find((f) => f.id === 'mpn')).toBeUndefined();
  });
});
