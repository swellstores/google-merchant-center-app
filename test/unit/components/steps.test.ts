import { describe, expect, it } from 'vitest';
import { stepStates } from '../../../components/lib/steps';

const pass = (id: string) => ({ id, ok: true, message: `${id} ok` });
const fail = (id: string) => ({ id, ok: false, message: `${id} refused`, help: `fix ${id}` });
const statuses = (checks: Parameters<typeof stepStates>[0], allOk = false) =>
  Object.fromEntries(Object.entries(stepStates(checks, allOk)).map(([id, state]) => [id, state.status]));

describe('stepStates', () => {
  it('leaves every step idle before any check ran', () => {
    expect(statuses([])).toEqual({ project: 'idle', key: 'idle', access: 'idle', connect: 'idle' });
  });

  it('fails the key step when Google refuses the token', () => {
    const checks = [pass('key'), fail('token')];
    const states = stepStates(checks, false);
    expect(states.key).toEqual({ status: 'failed', problems: [checks[1]] });
    expect(states.project.status).toBe('idle');
    expect(states.access.status).toBe('idle');
    expect(states.connect.status).toBe('idle');
  });

  it('accepts the project and key once a token came back, and fails the access step', () => {
    const checks = [pass('key'), pass('token'), fail('registration')];
    const states = stepStates(checks, false);
    expect(states.project.status).toBe('ok');
    expect(states.key).toEqual({ status: 'ok', problems: [] });
    expect(states.access).toEqual({ status: 'failed', problems: [checks[2]] });
  });

  it('fails the access step when the homepage is not claimed', () => {
    const checks = [pass('key'), pass('token'), pass('registration'), pass('account'), fail('homepage')];
    const states = stepStates(checks, false);
    expect(states.access).toEqual({ status: 'failed', problems: [checks[4]] });
    expect(states.key.status).toBe('ok');
  });

  it('marks every step ok on a full pass', () => {
    const checks = ['key', 'token', 'registration', 'account', 'homepage'].map(pass);
    expect(statuses(checks, true)).toEqual({ project: 'ok', key: 'ok', access: 'ok', connect: 'ok' });
  });
});
