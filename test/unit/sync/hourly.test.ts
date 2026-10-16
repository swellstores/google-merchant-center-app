import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServiceAccountKey } from '../../../functions/lib/google/jwt';
import { quotaFromGroups, runHourly } from '../../../functions/lib/sync/hourly';
import { loadConnection } from '../../../functions/lib/connection/store';
import { fixedClock, NOW, slowServices, testContext } from '../../helpers/context';
import { createFakeGoogle, DEFAULT_QUOTA, type FakeGoogleOptions } from '../../helpers/fake-google';
import { batchesOf, createFakeSwell, roundTrips } from '../../helpers/fake-swell';
import { makeServiceAccountKey } from '../../helpers/keys';
import { enqueue, loadAlarm, loadState, saveState, setAlarm } from '../../helpers/store';

let key: ServiceAccountKey;
beforeAll(async () => {
  ({ key } = await makeServiceAccountKey());
});

const at = (ms: number) => new Date(ms).toISOString();

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('reads in one round trip and writes in one', async () => {
    const { ctx, swell } = setup();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    await setAlarm(testContext(swell, undefined, fixedClock(NOW - 3600_000)), NOW - 600_000);
    swell.get.mockClear();
    swell.post.mockClear();
    swell.put.mockClear();
    await runHourly(ctx);
    const [read, write] = batchesOf(swell).map((batch) => batch.map((op) => `${op.method} ${op.url.split('/')[1]}`));
    expect(read).toEqual(['get connections', 'get sync-states', 'get queue-items', 'get alarms']);
    expect(write).toEqual(['post sync-states', 'put alarms']);
    expect(roundTrips(swell)).toBe(2);
    expect((await loadState(swell)).quota).toMatchObject({ minute_limit: 300 });
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW));
  });

  it('reads once and writes nothing when there is nothing to do', async () => {
    const { ctx, swell } = setup();
    const state = await loadState(swell);
    await saveState(swell, state.id, { quota: { $set: { minute_limit: 300, date_checked: at(NOW - 3600_000) } } });
    swell.post.mockClear();
    swell.put.mockClear();
    swell.get.mockClear();
    await runHourly(ctx);
    expect(roundTrips(swell)).toBe(1);
  });

  it('takes 4.4 s at worst at 1.2 s a Swell round trip and 1 s a Google call', async () => {
    const { swell, google } = setup('connected', {}, { access_token: null, access_token_expires: null });
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    const slow = slowServices(swell, google.fetch, { swellMs: 1200, googleMs: 1000 });
    await runHourly(testContext(slow.swell, slow.fetch, slow.now));
    // Read 1.2 s, token 1 s, quota 1 s, one write with the token, the quota and the alarm 1.2 s.
    expect(slow.now() - NOW).toBe(4400);
    expect(batchesOf(swell).at(-1)!.map((op) => op.url.split('/')[1]).sort()).toEqual(['alarms', 'connections', 'sync-states']);
    expect(await loadConnection(swell)).toMatchObject({ access_token: 'token-1' });
  });

  it('fails when Swell refuses one of its writes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ctx, swell, refuse } = setup();
    await enqueue(swell, { productId: 'p1', kind: 'full' });
    refuse((method, url) => (method !== 'get' && url.startsWith('/alarms') ? 'Permission denied' : null));
    await expect(runHourly(ctx)).rejects.toThrow('Permission denied');
  });
});
