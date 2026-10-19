import { describe, expect, it } from 'vitest';
import { latestWins, nextActive, suggestions } from '../../../components/lib/brand-input';

const ALL = ['Adidas', 'Nike', 'Nikon', 'Puma', 'Unikorn', 'Banana Nike'];

describe('suggestions', () => {
  it('suggests prefix matches first, then contains', () => {
    expect(suggestions(ALL, 'nik')).toEqual(['Nike', 'Nikon', 'Unikorn', 'Banana Nike']);
  });

  it('ignores case and surrounding spaces', () => {
    expect(suggestions(ALL, '  PUM ')).toEqual(['Puma']);
  });

  it('leaves out the exact typed value', () => {
    expect(suggestions(ALL, 'nike')).toEqual(['Banana Nike']);
    expect(suggestions(['Puma'], 'puma')).toEqual([]);
  });

  it('shows the first brands for an empty value', () => {
    expect(suggestions(ALL, '', 2)).toEqual(['Adidas', 'Nike']);
    expect(suggestions(ALL, '   ')).toEqual(ALL);
  });

  it('limits to 8 by default', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Brand ${i}`);
    expect(suggestions(many, 'brand')).toHaveLength(8);
    expect(suggestions(many, 'brand', 3)).toHaveLength(3);
  });

  it('finds nothing for no match', () => {
    expect(suggestions(ALL, 'zzz')).toEqual([]);
  });
});

describe('latestWins', () => {
  it('an older answer never replaces a newer one', () => {
    const w = latestWins();
    const applied: string[] = [];
    const first = w.start();
    const second = w.start();
    w.accept(second, () => applied.push('second'));
    w.accept(first, () => applied.push('first'));
    expect(applied).toEqual(['second']);
  });

  it('applies the newest answer', () => {
    const w = latestWins();
    const applied: string[] = [];
    w.accept(w.start(), () => applied.push('a'));
    expect(applied).toEqual(['a']);
  });
});

describe('nextActive', () => {
  it('arrows start from the first or the last suggestion', () => {
    expect(nextActive(-1, 4, 'ArrowDown')).toBe(0);
    expect(nextActive(-1, 4, 'ArrowUp')).toBe(3);
  });

  it('wraps around the ends', () => {
    expect(nextActive(3, 4, 'ArrowDown')).toBe(0);
    expect(nextActive(0, 4, 'ArrowUp')).toBe(3);
    expect(nextActive(1, 4, 'ArrowDown')).toBe(2);
    expect(nextActive(2, 4, 'ArrowUp')).toBe(1);
  });
});
