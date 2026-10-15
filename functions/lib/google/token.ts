import { GoogleApiError } from './http';
import { signAssertion, TOKEN_URL, type ServiceAccountKey } from './jwt';

export interface AccessToken {
  token: string;
  expiresAt: number;
}

/** Exchanges a signed assertion for an access token. A refused key is an `auth` error. */
export async function fetchAccessToken(fetchFn: typeof fetch, key: ServiceAccountKey, nowMs: number): Promise<AccessToken> {
  const assertion = await signAssertion(key, nowMs);
  let res: Response;
  try {
    res = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
  } catch (error) {
    throw new GoogleApiError('server', 0, `Google could not be reached: ${String(error)}`);
  }
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    const kind = res.status >= 500 ? 'server' : 'auth';
    throw new GoogleApiError(kind, res.status, body.error_description || body.error || `Token request failed (${res.status})`, body);
  }
  return { token: body.access_token, expiresAt: nowMs + (body.expires_in ?? 3600) * 1000 };
}
