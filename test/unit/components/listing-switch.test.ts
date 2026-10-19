import { describe, expect, it } from 'vitest';
import { listed, nextValue } from '../../../components/lib/listing-switch';

describe('listed', () => {
  it('lists a product whose value is unset or false', () => {
    expect(listed(undefined)).toBe(true);
    expect(listed(null)).toBe(true);
    expect(listed(false)).toBe(true);
  });

  it('does not list an excluded product', () => {
    expect(listed(true)).toBe(false);
  });
});

describe('nextValue', () => {
  it('stores true when turned off', () => {
    expect(nextValue(false)).toBe(true);
  });

  it('clears the field when turned on', () => {
    expect(nextValue(true)).toBeNull();
  });
});
