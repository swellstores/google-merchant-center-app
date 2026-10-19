import { describe, expect, it } from 'vitest';
import { googleAttribute, neededAttributes, showsAttributes, variantAttributes, variantOptions } from '../../../functions/lib/mapping/attributes';
import type { SwellOption, SwellProduct, SwellVariant } from '../../../functions/lib/mapping/types';
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

describe('showsAttributes', () => {
  const withOptions: SwellProduct = { id: 'p', options: [{ id: 'o1', name: 'Size', variant: true, values: [] }] };
  const withoutOptions: SwellProduct = { id: 'p', options: [{ id: 'o2', name: 'Gift note', variant: false, values: [] }] };

  it('is true for a product with variant options, with no issue and no choice', () => {
    expect(showsAttributes(withOptions, [], null)).toBe(true);
  });

  it('is false without variant options, an issue the tab provides or a choice', () => {
    expect(showsAttributes(withoutOptions, [], null)).toBe(false);
    expect(showsAttributes({ id: 'p', options: null }, [issue('brand')], { color: null })).toBe(false);
    expect(showsAttributes(undefined, [], undefined)).toBe(false);
  });

  it('is true without variant options while Google asks for an attribute the tab provides', () => {
    expect(showsAttributes(withoutOptions, [issue('size')], null)).toBe(true);
    expect(showsAttributes(undefined, [issue('age_group')], null)).toBe(true);
  });

  it('is true without variant options for a stored choice', () => {
    expect(showsAttributes(withoutOptions, [], { color: 'o1' })).toBe(true);
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

describe('variantOptions', () => {
  const variant = (...ids: string[]): SwellVariant => ({ id: 'v', option_value_ids: ids });
  const option = (id: string, name: string, value: string, extra: Partial<SwellOption> = {}): SwellOption => ({
    id,
    name,
    variant: true,
    values: [{ id: `${id}-v`, name: value }],
    ...extra,
  });
  const productOf = (...options: SwellOption[]): SwellProduct => ({ id: 'p', options });
  const valuesOf = (product: SwellProduct) => variant(...product.options!.map((o) => `${o.id}-v`));

  it('copies each variant option name and the variant’s value, trimmed, in product order', () => {
    const product = productOf(option('o1', ' Size ', '  M '), option('o2', 'Shade', 'Teal'));
    expect(variantOptions(product, valuesOf(product))).toEqual([
      { name: 'Size', value: 'M' },
      { name: 'Shade', value: 'Teal' },
    ]);
  });

  it('skips an option that makes no variants', () => {
    const product = productOf(option('o1', 'Size', 'M'), option('o2', 'Gift note', 'Yes', { variant: false }));
    expect(variantOptions(product, valuesOf(product))).toEqual([{ name: 'Size', value: 'M' }]);
  });

  it('skips a blank name or value, and an option the variant has no value for', () => {
    const product = productOf(option('o1', 'Size', '   '), option('o2', '  ', 'Teal'), option('o3', 'Fit', 'Slim'), option('o4', 'Shade', 'Rust'));
    expect(variantOptions(product, variant('o1-v', 'o2-v', 'o3-v'))).toEqual([{ name: 'Fit', value: 'Slim' }]);
  });

  it('sends at most 30 options', () => {
    const product = productOf(...Array.from({ length: 31 }, (_, i) => option(`o${i}`, `Name ${i}`, `Value ${i}`)));
    const sent = variantOptions(product, valuesOf(product))!;
    expect(sent).toHaveLength(30);
    expect(sent.at(-1)).toEqual({ name: 'Name 29', value: 'Value 29' });
  });

  it('cuts a name or value to 250 characters', () => {
    const product = productOf(option('o1', 'n'.repeat(300), 'v'.repeat(300)));
    const [sent] = variantOptions(product, valuesOf(product))!;
    expect(sent.name).toHaveLength(250);
    expect(sent.value).toHaveLength(250);
  });

  it('stops before the names and values pass 5000 characters in all', () => {
    const product = productOf(...Array.from({ length: 25 }, (_, i) => option(`o${i}`, `${i}`.padEnd(100, 'n'), 'v'.repeat(150))));
    const sent = variantOptions(product, valuesOf(product))!;
    expect(sent).toHaveLength(20);
    expect(sent.reduce((total, o) => total + o.name.length + o.value.length, 0)).toBe(5000);
  });

  it('is undefined without a variant or an option to send', () => {
    const product = productOf(option('o1', 'Size', 'M'));
    expect(variantOptions(product, undefined)).toBeUndefined();
    expect(variantOptions(product, variant())).toBeUndefined();
    expect(variantOptions({ id: 'p' }, variant('o1-v'))).toBeUndefined();
  });
});
