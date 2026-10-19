import { describe, expect, it } from 'vitest';
import { CATEGORY_LIST_URL, categoryText, categoryValue } from '../../../components/lib/category-field';

describe('categoryText', () => {
  it('shows a stored value as is', () => {
    expect(categoryText('Apparel & Accessories > Clothing ')).toBe('Apparel & Accessories > Clothing ');
    expect(categoryText('1604')).toBe('1604');
  });

  it('shows an empty field for anything that is not text', () => {
    expect(categoryText(null)).toBe('');
    expect(categoryText(undefined)).toBe('');
    expect(categoryText(1604)).toBe('');
  });
});

describe('categoryValue', () => {
  it('clears the value when the field is emptied', () => {
    expect(categoryValue('')).toBeNull();
    expect(categoryValue('   ')).toBeNull();
  });

  it('keeps typed spaces', () => {
    expect(categoryValue('Apparel ')).toBe('Apparel ');
    expect(categoryValue(' 1604')).toBe(' 1604');
  });
});

describe('CATEGORY_LIST_URL', () => {
  it('points to Google', () => {
    expect(CATEGORY_LIST_URL).toBe('https://support.google.com/merchants/answer/6324436');
  });
});
