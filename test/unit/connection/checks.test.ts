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

  it('reports the account before the website when both fail', async () => {
    const { report } = await check({
      account: { status: 403, body: { error: { message: 'The caller does not have permission' } } },
      homepage: { uri: 'https://shop.example.com', claimed: false },
    });
    expect(report.checks.map((c) => [c.id, c.ok])).toEqual([
      ['key', true],
      ['token', true],
      ['registration', true],
      ['account', false],
    ]);
  });

  it('asks for the account and the website at the same time', async () => {
    const { google } = await check();
    const calls = google.requests.map((r) => r.path);
    expect(calls.slice(-2).sort()).toEqual(['/accounts/v1/accounts/123', '/accounts/v1/accounts/123/homepage']);
  });

  it('requires a verified and claimed website', async () => {
    const { report } = await check({ homepage: { uri: 'https://shop.example.com', claimed: false } });
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)).toMatchObject({ id: 'homepage', ok: false });
  });

  it('accepts a project registered before, which Google answers with 200 again', async () => {
    const google = createFakeGoogle();
    const ctx = testContext(createFakeSwell().swell, google.fetch);
    await runChecks(ctx, key, '123');
    expect((await runChecks(ctx, key, '123')).report.ok).toBe(true);
  });

  it.each([
    ['reason', { reason: 'HOMEPAGE_NOT_VERIFIED', metadata: { REASON: 'HOMEPAGE_NOT_VERIFIED' } }],
    ['metadata.REASON', { metadata: { REASON: 'HOMEPAGE_NOT_VERIFIED' } }],
  ])('explains a website Google has not verified when registering (%s)', async (_shape, detail) => {
    const { report } = await check({
      register: {
        status: 400,
        body: { error: { code: 400, message: 'The Merchant Account used for developer registration must have a verified homepage', status: 'FAILED_PRECONDITION', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', ...detail }] } },
      },
    });
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)).toEqual({
      id: 'homepage',
      ok: false,
      message: 'Your website is not verified in Merchant Center.',
      help: 'In Merchant Center, open Settings → Business info → Website, verify and claim it, then press Check again.',
    });
  });

  const notRegistered = {
    status: 401,
    body: {
      error: {
        code: 401,
        message: 'GCP project is not registered with the merchant account. Try again in 5 minutes.',
        status: 'UNAUTHENTICATED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'GCP_NOT_REGISTERED', metadata: { REASON: 'GCP_NOT_REGISTERED' } }],
      },
    },
  };
  const activating = {
    ok: false,
    message: 'Google is activating the registration of your Google Cloud project.',
    help: 'This takes up to 5 minutes. Press Check again in a few minutes.',
  };

  it('says Google is still activating a fresh registration when the account answers so', async () => {
    const { report } = await check({ account: notRegistered });
    expect(report.checks.at(-1)).toEqual({ id: 'account', ...activating });
  });

  it('says Google is still activating a fresh registration when the website answers so', async () => {
    const { report } = await check({ homepageError: notRegistered });
    expect(report.checks.at(-1)).toEqual({ id: 'homepage', ...activating });
  });
});
