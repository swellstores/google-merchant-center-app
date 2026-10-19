import { describe, expect, it } from 'vitest';
import { googleAttribute, neededAttributes, needsAttributes, variantAttributes } from '../../../functions/lib/mapping/attributes';
import type { SwellProduct, SwellVariant } from '../../../functions/lib/mapping/types';
import type { StatusIssue } from '../../../functions/lib/status/product-status';

const issue = (attribute?: string): StatusIssue => ({ code: 'c', severity: 'disapproved', description: 'd', offers: [], countries: [], attribute });

describe('googleAttribute', () => {
  it('normalises Google spellings', () => {
    expect(googleAttribute('age group')).toBe('age_group');
    expect(googleAttribute('ageGroup')).toBe('age_group');
    expect(googleAttribute('age_group')).toBe('age_group');
    expect(googleAttribute('age-group')).toBe('age_group');
    expect(googleAttribute('Size')).toBe('size');
    expect(googleAttribute('colour')).toBe('color');
  });

  it('drops a dotted prefix and reads sizes as size', () => {
    expect(googleAttribute('productAttributes.color')).toBe('color');
    expect(googleAttribute('product_attributes.ageGroup')).toBe('age_group');
    expect(googleAttribute('sizes')).toBe('size');
    expect(googleAttribute('productAttributes.sizes')).toBe('size');
  });

  it('empty input gives null', () => {
    expect(googleAttribute(undefined)).toBeNull();
    expect(googleAttribute('')).toBeNull();
    expect(googleAttribute('  ')).toBeNull();
  });
});

describe('neededAttributes', () => {
  it('lists option attributes then field attributes, in declared order', () => {
    expect(neededAttributes([issue('gender'), issue('size'), issue('color'), issue('brand'), issue()])).toEqual(['color', 'size', 'gender']);
  });
});

describe('needsAttributes', () => {
  it('is true for a needed attribute or a non-null choice', () => {
    expect(needsAttributes([issue('size')], null)).toBe(true);
    expect(needsAttributes([], { color: 'o1' })).toBe(true);
    expect(needsAttributes([], { color: null })).toBe(false);
    expect(needsAttributes([issue('brand')], undefined)).toBe(false);
  });
});

describe('variantAttributes', () => {
  const product: SwellProduct = {
    id: 'p',
    options: [
      { id: 'o1', name: 'Size', variant: true, values: [{ id: 'a', name: 'S' }, { id: 'b', name: 'M' }] },
      { id: 'o2', name: 'Shade', variant: true, active: false, values: [{ id: 'c', name: 'Teal' }, { id: 'd', name: 'Rust' }] },
      { id: 'o3', name: 'Color', variant: true, values: [{ id: 'e', name: 'Red' }] },
      { id: 'o4', name: 'Gift note', variant: false, values: [{ id: 'f', name: 'Yes' }] },
    ],
  };
  const variant = (...ids: string[]): SwellVariant => ({ id: 'v', option_value_ids: ids });

  it('a chosen size sends each variant its own value', () => {
    expect(variantAttributes(product, variant('a'), { size: 'o1' })).toEqual({ size: 'S' });
    expect(variantAttributes(product, variant('b'), { size: 'o1' })).toEqual({ size: 'M' });
  });

  it('sends color, material and pattern as strings, even from an inactive option', () => {
    expect(variantAttributes(product, variant('a', 'c'), { color: 'o2', material: 'o1', pattern: 'o2' })).toEqual({
      color: 'Teal',
      material: 'S',
      pattern: 'Teal',
    });
  });

  it('a renamed option still resolves by id', () => {
    const renamed = { ...product, options: product.options!.map((o) => (o.id === 'o2' ? { ...o, name: 'Tone' } : o)) };
    expect(variantAttributes(renamed, variant('d'), { color: 'o2' })).toEqual({ color: 'Rust' });
  });

  it('trims the value name, and a blank one sends nothing', () => {
    const spaced = { ...product, options: [{ id: 'o1', name: 'Size', variant: true, values: [{ id: 'a', name: '  S ' }, { id: 'b', name: '   ' }] }] };
    expect(variantAttributes(spaced, variant('a'), { size: 'o1' })).toEqual({ size: 'S' });
    expect(variantAttributes(spaced, variant('b'), { size: 'o1' })).toEqual({});
  });

  it('a deleted option sends nothing', () => {
    expect(variantAttributes(product, variant('a'), { size: 'gone' })).toEqual({});
  });

  it('a non-variant option sends nothing', () => {
    expect(variantAttributes(product, variant('f'), { size: 'o4' })).toEqual({});
  });

  it('a variant without a value for the option sends nothing', () => {
    expect(variantAttributes(product, variant('c'), { size: 'o1' })).toEqual({});
    expect(variantAttributes(product, { id: 'v' }, { size: 'o1' })).toEqual({});
  });

  it('a product without variants sends nothing', () => {
    expect(variantAttributes(product, undefined, { size: 'o1' })).toEqual({});
  });

  it('a null choice sends nothing', () => {
    expect(variantAttributes(product, variant('a'), { size: null })).toEqual({});
    expect(variantAttributes(product, variant('a'), null)).toEqual({});
    expect(variantAttributes(product, variant('a'), undefined)).toEqual({});
  });

  it('options named Color are ignored until chosen', () => {
    expect(variantAttributes(product, variant('e'), {})).toEqual({});
    expect(variantAttributes(product, variant('e'), { size: 'o3' })).toEqual({ size: 'Red' });
  });
});
