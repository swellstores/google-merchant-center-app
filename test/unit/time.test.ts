import { describe, expect, it } from 'vitest';
import { Budget, iso, nextNoonUtc } from '../../functions/lib/time';

describe('time', () => {
  it('formats epoch ms as ISO', () => {
    expect(iso(Date.UTC(2026, 9, 15, 10))).toBe('2026-10-15T10:00:00.000Z');
  });

  it('measures what is left of a budget', () => {
    let now = 1000;
    const budget = new Budget(() => now, 7000);
    expect(budget.has(7000)).toBe(true);
    now = 6000;
    expect(budget.remaining()).toBe(2000);
    expect(budget.has(2500)).toBe(false);
  });

  it('finds the next 12:00 UTC', () => {
    expect(nextNoonUtc(Date.UTC(2026, 9, 15, 10))).toBe(Date.UTC(2026, 9, 15, 12));
    expect(nextNoonUtc(Date.UTC(2026, 9, 15, 12))).toBe(Date.UTC(2026, 9, 16, 12));
    expect(nextNoonUtc(Date.UTC(2026, 9, 15, 13))).toBe(Date.UTC(2026, 9, 16, 12));
  });
});
