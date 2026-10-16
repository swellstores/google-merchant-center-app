import { describe, expect, it } from 'vitest';
import { quotaFromGroups, readQuota } from '../../../functions/lib/sync/quota';
import { NOW, testContext } from '../../helpers/context';
import { createFakeGoogle, DEFAULT_QUOTA } from '../../helpers/fake-google';
import { createFakeSwell } from '../../helpers/fake-swell';

const at = (ms: number) => new Date(ms).toISOString();

describe('quotaFromGroups', () => {
  it('reads the limits of the product insert group among the others', () => {
    expect(DEFAULT_QUOTA.quotaGroups.length).toBeGreaterThan(1);
    expect(quotaFromGroups(DEFAULT_QUOTA)).toEqual({ minute_limit: 300, daily_limit: 5000 });
    expect(quotaFromGroups({})).toEqual({ minute_limit: null, daily_limit: null });
  });

  it('knows the group by its name when the methods are missing', () => {
    const group = { name: 'accounts/1/quotas/merchant-productinputs-insert', quotaLimit: '10', quotaMinuteLimit: '2' };
    expect(quotaFromGroups({ quotaGroups: [group] })).toEqual({ minute_limit: 2, daily_limit: 10 });
  });
});

describe('readQuota', () => {
  it('still marks the quota checked when Google fails to give it, so no run asks again before the daily refresh', async () => {
    const google = createFakeGoogle({ quotaError: { status: 503, body: { error: { message: 'unavailable' } } } });
    const ctx = testContext(createFakeSwell().swell, google.fetch);
    expect(await readQuota(ctx, 'tok', '123', { minute_limit: 60 })).toEqual({ minute_limit: 60, date_checked: at(NOW) });
  });

  it('throws when Google refuses the key', async () => {
    const google = createFakeGoogle({ quotaError: { status: 401, body: { error: { message: 'invalid credentials' } } } });
    await expect(readQuota(testContext(createFakeSwell().swell, google.fetch), 'tok', '123')).rejects.toMatchObject({ kind: 'auth' });
  });
});
