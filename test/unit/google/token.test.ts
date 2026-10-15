import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GoogleApiError } from '../../../functions/lib/google/http';
import type { ServiceAccountKey } from '../../../functions/lib/google/jwt';
import { fetchAccessToken } from '../../../functions/lib/google/token';
import { makeServiceAccountKey } from '../../helpers/keys';

let key: ServiceAccountKey;
beforeAll(async () => {
  ({ key } = await makeServiceAccountKey());
});

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('fetchAccessToken', () => {
  it('exchanges the signed assertion and returns the token with its expiry', async () => {
    const fetchFn = respond(200, { access_token: 'ya29.token', expires_in: 3599, token_type: 'Bearer' });
    const token = await fetchAccessToken(fetchFn as unknown as typeof fetch, key, 1_000_000);
    expect(token).toEqual({ token: 'ya29.token', expiresAt: 1_000_000 + 3599 * 1000 });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(String(init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(form.get('assertion')?.split('.')).toHaveLength(3);
  });

  it('turns a refusal into an auth error with Google’s description', async () => {
    const fetchFn = respond(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
    const error = await fetchAccessToken(fetchFn as unknown as typeof fetch, key, 0).catch((e) => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error.kind).toBe('auth');
    expect(error.message).toBe('Invalid JWT Signature.');
  });

  it('treats a server failure as retryable', async () => {
    const fetchFn = respond(503, {});
    const error = await fetchAccessToken(fetchFn as unknown as typeof fetch, key, 0).catch((e) => e);
    expect(error.kind).toBe('server');
  });
});
