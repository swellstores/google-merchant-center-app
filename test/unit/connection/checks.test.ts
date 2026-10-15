import { beforeAll, describe, expect, it } from 'vitest';
import { runChecks } from '../../../functions/lib/connection/checks';
import type { ServiceAccountKey } from '../../../functions/lib/google/jwt';
import { testContext } from '../../helpers/context';
import { createFakeGoogle } from '../../helpers/fake-google';
import { createFakeSwell } from '../../helpers/fake-swell';
import { makeServiceAccountKey } from '../../helpers/keys';

let key: ServiceAccountKey;
beforeAll(async () => {
  ({ key } = await makeServiceAccountKey());
});

async function check(options: Parameters<typeof createFakeGoogle>[0] = {}) {
  const google = createFakeGoogle(options);
  const ctx = testContext(createFakeSwell().swell, google.fetch);
  return { ...(await runChecks(ctx, key, '123')), google };
}

describe('runChecks', () => {
  it('passes every check and returns the token', async () => {
    const { report, token } = await check();
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => [c.id, c.ok])).toEqual([
      ['key', true],
      ['token', true],
      ['registration', true],
      ['account', true],
      ['homepage', true],
    ]);
    expect(report.account).toEqual({ id: '123', name: 'Demo Shop' });
    expect(token?.token).toBe('token-1');
  });

  it('stops at a refused key', async () => {
    const { report } = await check({ token: { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } });
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)).toMatchObject({ id: 'token', ok: false });
    expect(report.checks.at(-1)?.message).toContain('Invalid JWT Signature.');
  });

  it('asks for Admin access when registration is refused', async () => {
    const { report } = await check({ register: { status: 403, body: { error: { message: 'The caller does not have permission' } } } });
    const last = report.checks.at(-1)!;
    expect(last).toMatchObject({ id: 'registration', ok: false });
    expect(last.help).toContain(key.client_email);
    expect(last.help).toContain('Admin');
  });

  it('accepts a project registered before when the account is readable', async () => {
    const { report } = await check({ register: { status: 409, body: { error: { message: 'ALREADY_EXISTS' } } } });
    expect(report.ok).toBe(true);
  });

  it('explains a project registered with another account', async () => {
    const { report } = await check({
      register: { status: 409, body: { error: { message: 'ALREADY_EXISTS' } } },
      account: { status: 403, body: { error: { message: 'GCP project is not registered with this account' } } },
    });
    const last = report.checks.at(-1)!;
    expect(last).toMatchObject({ id: 'account', ok: false });
    expect(last.message).toContain('another Merchant Center account');
  });

  it('requires a verified and claimed website', async () => {
    const { report } = await check({ homepage: { uri: 'https://shop.example.com', claimed: false } });
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)).toMatchObject({ id: 'homepage', ok: false });
  });
});
