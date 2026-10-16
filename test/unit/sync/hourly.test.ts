import { beforeAll, describe, expect, it } from 'vitest';
import type { ServiceAccountKey } from '../../../functions/lib/google/jwt';
import { loadAlarm, setAlarm } from '../../../functions/lib/sync/alarm';
import { quotaFromGroups, runHourly } from '../../../functions/lib/sync/hourly';
import { enqueue } from '../../../functions/lib/sync/queue';
import { loadState, saveState } from '../../../functions/lib/sync/state';
import { loadConnection } from '../../../functions/lib/connection/store';
import { fixedClock, NOW, testContext } from '../../helpers/context';
import { createFakeGoogle, DEFAULT_QUOTA, type FakeGoogleOptions } from '../../helpers/fake-google';
import { createFakeSwell } from '../../helpers/fake-swell';
import { makeServiceAccountKey } from '../../helpers/keys';

let key: ServiceAccountKey;
beforeAll(async () => {
  ({ key } = await makeServiceAccountKey());
});

const at = (ms: number) => new Date(ms).toISOString();

function setup(status = 'connected', googleOptions: FakeGoogleOptions = {}, connection: Record<string, any> = {}) {
  const google = createFakeGoogle(googleOptions);
  const fake = createFakeSwell({
    connection: {
      status, merchant_id: '123', client_email: key.client_email, private_key: key.private_key, access_token: 'cached', access_token_expires: at(NOW + 3600_000),
      ...connection,
    },
  });
  return { google, ...fake, ctx: testContext(fake.swell, google.fetch) };
}

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

describe('runHourly', () => {
  it('does nothing while not connected', async () => {
    const { ctx, google, swell } = setup('disconnected');
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await runHourly(ctx);
    expect(google.requests).toHaveLength(0);
    expect((await loadAlarm(swell)).wake_at ?? null).toBeNull();
  });

  it('refreshes the quota once a day', async () => {
    const { ctx, google, swell } = setup();
    await runHourly(ctx);
    expect((await loadState(swell)).quota).toMatchObject({ minute_limit: 300, daily_limit: 5000, date_checked: at(NOW) });
    await runHourly(ctx);
    expect(google.requests.filter((r) => r.path.startsWith('/quota'))).toHaveLength(1);
  });

  it('marks the connection broken when Google refuses the key', async () => {
    const refused = { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } };
    const { ctx, swell } = setup('connected', { token: refused }, { access_token: null, access_token_expires: null });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await runHourly(ctx);
    expect(await loadConnection(swell)).toMatchObject({ status: 'broken', last_error: 'Invalid JWT Signature.' });
    expect((await loadAlarm(swell)).wake_at ?? null).toBeNull();
  });

  it('wakes a stalled queue', async () => {
    const { ctx, swell } = setup();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await setAlarm(testContext(swell, undefined, fixedClock(NOW - 3600_000)), NOW - 600_000);
    await runHourly(ctx);
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW));
  });

  it('wakes a catalog sync that has no alarm', async () => {
    const { ctx, swell } = setup();
    const state = await loadState(swell);
    await saveState(swell, state.id, { full_sync: { $set: { status: 'running', cursor: null, total: 5, done: 1, date_started: at(NOW) } } });
    await runHourly(ctx);
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW));
  });

  it('leaves a future alarm alone', async () => {
    const { ctx, swell } = setup();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await setAlarm(ctx, NOW + 10_000);
    await runHourly(ctx);
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW + 10_000));
  });

  it('does not wake the courier before the time the last run asked for', async () => {
    const { ctx, swell } = setup();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await setAlarm(testContext(swell, undefined, fixedClock(NOW - 3600_000)), NOW - 600_000);
    const state = await loadState(swell);
    await saveState(swell, state.id, { not_before: at(NOW + 600_000) });
    await runHourly(ctx);
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW - 600_000));
  });
});
