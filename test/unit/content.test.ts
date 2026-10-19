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
    'Turn on to keep this product out of Google Shopping and free listings. Products already in Google are removed within minutes.',
  brand:
    'The brand of the product. Google requires it for most products; without it the product may be shown less or disapproved.',
  condition: 'Whether the product is new, used or refurbished. Empty means new.',
  google_category:
    'Optional. Google picks a category itself from the title and description; set it only to correct Google. Paste a category number or full path from the Google product taxonomy (search the web for "Google product taxonomy").',
  no_identifiers:
    'Turn on for handmade, custom or vintage products that have no barcode and no manufacturer part number. Otherwise Google expects a GTIN or an MPN with the brand.',
  mpn: 'The manufacturer part number. Variants without their own MPN use this one.',
  identifiers:
    'GTIN is the barcode number (UPC, EAN, ISBN). Give each variant its own; an MPN here overrides the one above for that variant.',
  age_group:
    'Only for clothing and accessories: the age group the product is for. Google requires it for them.',
  gender:
    'Only for clothing and accessories: who the product is for. Google requires it for them.',
  status_panel: 'What Google says about this product right now.',
  preview: 'How the product can look in Google Shopping, from the unsaved form.',
};

describe('products content, Google tab', () => {
  it('lists the fields in order', () => {
    // No field_group: the admin moves top-level groups to a tab strip after all other fields, and a group
    // nested in a row loses its fields' defaults and conditions
    expect(tab.fields.map((f: any) => f.id ?? f.fields.map((c: any) => c.id))).toEqual([
      'excluded',
      ['brand', 'condition'],
      'google_category',
      'no_identifiers',
      'mpn',
      'identifiers',
      ['age_group', 'gender'],
      ['status_panel', 'preview'],
    ]);
    for (const i of [1, 6, 7]) expect(tab.fields[i].type).toBe('field_row');
    expect(flatten(tab.fields).some((f) => f.type === 'field_group')).toBe(false);
  });

  it('gives every field the exact hint and no description', () => {
    for (const [id, hint] of Object.entries(hints)) {
      const field = byId(id);
      expect(field.hint, id).toBe(hint);
      expect(field.description, id).toBeUndefined();
    }
  });

  // Components only where a plain field cannot do the job
  it('binds the components', () => {
    const components = tabFields.filter((f) => resolve(f).type === 'component').map((f) => f.id);
    expect(components).toEqual(['identifiers', 'status_panel', 'preview']);
    expect(byId('identifiers')).toMatchObject({
      type: 'component',
      component: 'GtinTable',
      label: 'Barcodes',
    });
    expect(byId('status_panel')).toMatchObject({ type: 'component', component: 'GoogleStatus' });
    expect(byId('preview')).toMatchObject({ type: 'component', component: 'ShoppingPreview' });
  });

  it('sets the labels, placeholder and native types', () => {
    expect(byId('excluded')).toMatchObject({ type: 'toggle', label: 'Hide from Google' });
    expect(byId('no_identifiers')).toMatchObject({ type: 'toggle', label: 'No barcode (GTIN) or part number (MPN)' });
    expect(byId('condition')).toMatchObject({ type: 'select', placeholder: 'New' });
    // Google allows a brand of at most 70 characters
    expect(byId('brand')).toMatchObject({ type: 'text', max: 70 });
    expect(byId('google_category')).toMatchObject({
      type: 'text',
      placeholder: 'e.g. 1604 or Apparel & Accessories > Clothing > Shirts & Tops',
    });
  });

  // The admin fills a default into an existing product that lacks the value and marks the form changed
  it('gives no tab field a default, so opening the tab changes nothing', () => {
    for (const field of tabFields) expect(resolve(field).default, field.id).toBeUndefined();
  });

  it('no longer shows identifier_exists, which needed a default of true', () => {
    expect(topFields.find((f) => f.id === 'identifier_exists')).toBeUndefined();
    expect(tabFields.find((f) => f.id === 'identifier_exists')).toBeUndefined();
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

  it('shows the product’s MPN as a native text field', () => {
    expect(byId('mpn')).toMatchObject({ type: 'text', label: 'MPN' });
    expect(byId('mpn').component).toBeUndefined();
  });

  // The admin hides them natively while the switch is on; the stored values stay
  it('hides the MPN and the barcodes while "No barcode" is on', () => {
    for (const id of ['mpn', 'identifiers']) {
      expect(byId(id).conditions, id).toEqual({ no_identifiers: { $ne: true } });
    }
    const conditioned = tabFields.filter((f) => resolve(f).conditions).map((f) => f.id);
    expect(conditioned).toEqual(['mpn', 'identifiers']);
  });
});
