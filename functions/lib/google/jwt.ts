import { base64url, pemToDer } from './base64url';

export const CONTENT_SCOPE = 'https://www.googleapis.com/auth/content';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The fields of a Google service-account JSON key the app uses. */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  project_id?: string;
}

/** An RS256 assertion for the OAuth JWT bearer flow, valid for one hour. */
export async function signAssertion(key: ServiceAccountKey, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: 'RS256', typ: 'JWT', ...(key.private_key_id ? { kid: key.private_key_id } : {}) };
  const claims = { iss: key.client_email, scope: CONTENT_SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(key.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}
