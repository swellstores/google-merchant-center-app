import { describe, expect, it, vi } from 'vitest';
import { checkThenActivate, UNFINISHED, type CheckAnswer, type Phase } from '../../../components/lib/connect-flow';

const INPUT = { key: '{"type":"service_account"}', merchant_id: '123', country: 'US', link_template: 'https://shop.example.com/products/{slug}' };
const CONNECTION = { status: 'connected', merchant_id: '123', client_email: 'a@b.c', has_key: true, last_error: null, date_connected: null };
const PASSED: CheckAnswer = { connection: CONNECTION as CheckAnswer['connection'], report: { ok: true, checks: [{ id: 'key', ok: true, message: 'Key of a@b.c' }] } };
const VIEW = { connection: CONNECTION, market: { country: 'US', language: 'en', currency: 'USD', link_template: INPUT.link_template }, defaults: { link_template: '' } };

function route(...answers: unknown[]) {
  return vi.fn(async (_body: Record<string, unknown>) => answers.shift());
}

function watch() {
  const phases: Phase[] = [];
  const checked: CheckAnswer[] = [];
  return { phases, checked, on: { phase: (p: Phase) => phases.push(p), checked: (a: CheckAnswer) => checked.push(a) } };
}

describe('checkThenActivate', () => {
  it('checks, then starts syncing when every check passed', async () => {
    const call = route(PASSED, VIEW);
    const { phases, checked, on } = watch();
    expect(await checkThenActivate(call, INPUT, on)).toEqual(VIEW);
    expect(call.mock.calls.map(([body]) => body)).toEqual([
      { op: 'check', key: INPUT.key, merchant_id: '123', country: 'US', link_template: INPUT.link_template },
      { op: 'activate', country: 'US', link_template: INPUT.link_template },
    ]);
    expect(phases).toEqual(['checking', 'activating']);
    expect(checked).toEqual([PASSED]);
  });

  it('stops after a failed check', async () => {
    const failed = { ...PASSED, report: { ok: false, checks: [{ id: 'homepage', ok: false, message: 'Not verified' }] } };
    const call = route(failed);
    const { phases, checked, on } = watch();
    expect(await checkThenActivate(call, INPUT, on)).toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['checking']);
    expect(checked).toEqual([failed]);
  });

  it.each([[{}], [null], [{ connection: CONNECTION }], [{ report: { ok: true } }]])('explains a check answer that was cut off: %j', async (answer) => {
    const { checked, on } = watch();
    await expect(checkThenActivate(route(answer), INPUT, on)).rejects.toThrow(UNFINISHED);
    expect(checked).toEqual([]);
  });

  it('explains a start answer that was cut off', async () => {
    await expect(checkThenActivate(route(PASSED, {}), INPUT, watch().on)).rejects.toThrow(UNFINISHED);
  });

  it('says what to do', () => {
    expect(UNFINISHED).toBe('The connection check did not finish. Press Check again.');
  });
});
