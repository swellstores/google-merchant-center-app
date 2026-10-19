import { describe, expect, it } from 'vitest';
import { latestWins } from '../../../components/lib/latest-wins';

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
