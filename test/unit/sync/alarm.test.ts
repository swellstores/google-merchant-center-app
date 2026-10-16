import { describe, expect, it } from 'vitest';
import { alarmWrite, armAlarm, loadAlarm, setAlarm } from '../../../functions/lib/sync/alarm';
import { fixedClock, NOW, testContext } from '../../helpers/context';
import { createFakeSwell } from '../../helpers/fake-swell';

const at = (ms: number) => new Date(ms).toISOString();

describe('alarm', () => {
  it('creates the record on first use with no wake time', async () => {
    const { swell, collections } = createFakeSwell();
    expect((await loadAlarm(swell)).wake_at ?? null).toBeNull();
    expect(collections['/alarms']).toHaveLength(1);
  });

  it('arms an empty alarm', async () => {
    const { swell } = createFakeSwell();
    await armAlarm(testContext(swell), 15_000);
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW + 15_000));
  });

  it('keeps an alarm that already rings sooner', async () => {
    const { swell } = createFakeSwell();
    await setAlarm(testContext(swell), NOW + 5_000);
    await armAlarm(testContext(swell), 15_000);
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW + 5_000));
  });

  it('replaces an alarm in the past, which may never ring again', async () => {
    const { swell } = createFakeSwell();
    await setAlarm(testContext(swell, undefined, fixedClock(NOW - 120_000)), NOW - 60_000);
    await armAlarm(testContext(swell), 15_000);
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW + 15_000));
  });

  it('brings a later alarm forward', async () => {
    const { swell } = createFakeSwell();
    await setAlarm(testContext(swell), NOW + 600_000);
    await armAlarm(testContext(swell), 15_000);
    expect((await loadAlarm(swell)).wake_at).toBe(at(NOW + 15_000));
  });

  it('clears and skips a write that changes nothing', async () => {
    const { swell } = createFakeSwell();
    await setAlarm(testContext(swell), NOW);
    await setAlarm(testContext(swell), null);
    expect((await loadAlarm(swell)).wake_at).toBeNull();
    const puts = swell.put.mock.calls.length;
    await setAlarm(testContext(swell), null);
    expect(swell.put.mock.calls.length).toBe(puts);
  });

  it('writes the alarm by id, creates a missing one, and skips a write that changes nothing', () => {
    expect(alarmWrite(null, NOW)).toEqual({ method: 'post', url: '/alarms', data: { wake_at: at(NOW) } });
    expect(alarmWrite(null, null)).toBeNull();
    expect(alarmWrite({ id: 'a1', wake_at: at(NOW) }, NOW + 1000)).toEqual({ method: 'put', url: '/alarms/a1', data: { wake_at: at(NOW + 1000) } });
    expect(alarmWrite({ id: 'a1', wake_at: at(NOW) }, NOW)).toBeNull();
    expect(alarmWrite({ id: 'a1', wake_at: null }, null)).toBeNull();
  });
});
