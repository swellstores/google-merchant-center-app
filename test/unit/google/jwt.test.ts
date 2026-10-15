import { beforeAll, describe, expect, it } from 'vitest';
import { CONTENT_SCOPE, signAssertion, TOKEN_URL, type ServiceAccountKey } from '../../../functions/lib/google/jwt';
import { decodeSegment, makeServiceAccountKey } from '../../helpers/keys';

let key: ServiceAccountKey;
let publicKey: CryptoKey;

beforeAll(async () => {
  ({ key, publicKey } = await makeServiceAccountKey());
});

describe('signAssertion', () => {
  it('builds an RS256 JWT with the service account claims for one hour', async () => {
    const jwt = await signAssertion(key, Date.UTC(2026, 9, 15, 10));
    const [header, claims] = jwt.split('.');
    expect(decodeSegment(header)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
    const iat = Date.UTC(2026, 9, 15, 10) / 1000;
    expect(decodeSegment(claims)).toEqual({ iss: key.client_email, scope: CONTENT_SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 });
  });

  it('signs with the private key', async () => {
    const jwt = await signAssertion(key, Date.UTC(2026, 9, 15, 10));
    const [header, claims, signature] = jwt.split('.');
    const base64 = signature.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, bytes, new TextEncoder().encode(`${header}.${claims}`));
    expect(valid).toBe(true);
  });

  it('accepts a key whose newlines are escaped', async () => {
    const escaped = { ...key, private_key: key.private_key.replace(/\n/g, '\\n') };
    await expect(signAssertion(escaped, Date.UTC(2026, 9, 15, 10))).resolves.toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('leaves kid out when the key has no id', async () => {
    const jwt = await signAssertion({ ...key, private_key_id: undefined }, Date.UTC(2026, 9, 15, 10));
    expect(decodeSegment(jwt.split('.')[0])).toEqual({ alg: 'RS256', typ: 'JWT' });
  });
});
