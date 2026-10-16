import { describe, expect, it } from 'vitest';
import { alarmWrite, armWrite } from '../../../functions/lib/sync/alarm';
import { NOW, testContext } from '../../helpers/context';
import { createFakeSwell } from '../../helpers/fake-swell';
import { loadAlarm, setAlarm } from '../../helpers/store';

const at = (ms: number) => new Date(ms).toISOString();

describe('alarm', () => {
  it('creates the record on first use with no wake time', async () => {
    const { swell, collections } = createFakeSwell();
    expect((await loadAlarm(swell)).wake_at ?? null).toBeNull();
    expect(collections['/alarms']).toHaveLength(1);
  });

  it('arms an empty or missing alarm', () => {
    expect(armWrite(null, NOW, 15_000)).toEqual({ method: 'post', url: '/alarms', data: { wake_at: at(NOW + 15_000) } });
    expect(armWrite({ id: 'a1', wake_at: null }, NOW, 15_000)).toEqual({ method: 'put', url: '/alarms/a1', data: { wake_at: at(NOW + 15_000) } });
  });

  it('keeps an alarm that already rings sooner, and never moves it later', () => {
    expect(armWrite({ id: 'a1', wake_at: at(NOW + 5_000) }, NOW, 15_000)).toBeNull();
    expect(armWrite({ id: 'a1', wake_at: at(NOW + 15_000) }, NOW, 15_000)).toBeNull();
  });

  it('replaces an alarm in the past, which may never ring again', () => {
    expect(armWrite({ id: 'a1', wake_at: at(NOW - 60_000) }, NOW, 15_000)).toMatchObject({ data: { wake_at: at(NOW + 15_000) } });
  });

  it('brings a later alarm forward', () => {
    expect(armWrite({ id: 'a1', wake_at: at(NOW + 600_000) }, NOW, 15_000)).toMatchObject({ data: { wake_at: at(NOW + 15_000) } });
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
