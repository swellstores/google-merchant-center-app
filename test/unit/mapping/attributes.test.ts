import { describe, expect, it } from 'vitest';
import { googleAttribute, neededAttributes, needsAttributes } from '../../../functions/lib/mapping/attributes';
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
