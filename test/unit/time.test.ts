import { describe, expect, it } from 'vitest';
import { Budget, GOOGLE_GUESS_MS, iso, nextNoonUtc } from '../../functions/lib/time';

describe('time', () => {
  it('formats epoch ms as ISO', () => {
    expect(iso(Date.UTC(2026, 9, 15, 10))).toBe('2026-10-15T10:00:00.000Z');
  });

  it('measures what is left of a budget', () => {
    let now = 1000;
    const budget = new Budget(() => now, 7000);
    expect(budget.has(7000)).toBe(true);
    now = 6000;
    expect(budget.left()).toBe(2000);
    expect(budget.has(2500)).toBe(false);
  });

  it('keeps the slowest round trip and Google call it saw', () => {
    const budget = new Budget(() => 0, 7000);
    expect([budget.swellMs, budget.googleMs]).toEqual([0, GOOGLE_GUESS_MS]);
    budget.noteSwell(1200);
    budget.noteSwell(800);
    budget.noteGoogle(600);
    expect([budget.swellMs, budget.googleMs]).toEqual([1200, 600]);
    budget.noteGoogle(900);
    expect(budget.googleMs).toBe(900);
  });

  it('allows a pass only with time for its Swell round trips and a Google call', () => {
    let now = 0;
    const budget = new Budget(() => now, 7000);
    budget.noteSwell(1200);
    budget.noteGoogle(1000);
    now = 2400;
    expect(budget.allows(3)).toBe(true); // 3 × 1200 + 1000 = 4600 = left
    now = 2401;
    expect(budget.allows(3)).toBe(false);
    expect(budget.allows(2)).toBe(true);
  });

  it('finds the next 12:00 UTC', () => {
    expect(nextNoonUtc(Date.UTC(2026, 9, 15, 10))).toBe(Date.UTC(2026, 9, 15, 12));
    expect(nextNoonUtc(Date.UTC(2026, 9, 15, 12))).toBe(Date.UTC(2026, 9, 16, 12));
    expect(nextNoonUtc(Date.UTC(2026, 9, 15, 13))).toBe(Date.UTC(2026, 9, 16, 12));
  });
});
