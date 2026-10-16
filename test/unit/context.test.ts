import { describe, expect, it } from 'vitest';
import { measured } from '../../functions/lib/context';
import { Budget } from '../../functions/lib/time';
import { NOW, slowServices, testContext } from '../helpers/context';
import { createFakeGoogle } from '../helpers/fake-google';
import { createFakeSwell } from '../helpers/fake-swell';

describe('measured', () => {
  it('times every Swell round trip and Google call into the budget', async () => {
    const google = createFakeGoogle();
    const slow = slowServices(createFakeSwell().swell, google.fetch, { swellMs: 1200, googleMs: 900 });
    const budget = new Budget(slow.now, 7000);
    const ctx = measured(testContext(slow.swell, slow.fetch, slow.now), budget);
    await ctx.swell.get('/alarms', {});
    await ctx.swell.post('/:batch', []);
    await ctx.fetch('https://merchantapi.googleapis.com/accounts/v1/accounts/1');
    expect([budget.swellMs, budget.googleMs]).toEqual([1200, 900]);
    expect(slow.now() - NOW).toBe(3300);
    expect(budget.left()).toBe(7000 - 3300);
  });
});
