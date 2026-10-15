import type { ServiceAccountKey } from '../../functions/lib/google/jwt';

/** A real RSA key in the shape of a Google service-account JSON key. */
export async function makeServiceAccountKey(): Promise<{ key: ServiceAccountKey; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  const body = btoa(binary).replace(/(.{64})/g, '$1\n');
  return {
    key: {
      client_email: 'sync@demo-project.iam.gserviceaccount.com',
      private_key: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
      private_key_id: 'kid-1',
      project_id: 'demo-project',
    },
    publicKey: pair.publicKey,
  };
}

export function decodeSegment(segment: string): any {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)));
}
