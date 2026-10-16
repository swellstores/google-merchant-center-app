import { beforeAll, describe, expect, it } from 'vitest';
import { accessTokenFor, brokenPatch } from '../../../functions/lib/connection/token';
import { loadConnection } from '../../../functions/lib/connection/store';
import type { ServiceAccountKey } from '../../../functions/lib/google/jwt';
import { NOW, testContext } from '../../helpers/context';
import { createFakeGoogle } from '../../helpers/fake-google';
import { createFakeSwell } from '../../helpers/fake-swell';
import { makeServiceAccountKey } from '../../helpers/keys';

let key: ServiceAccountKey;
beforeAll(async () => {
  ({ key } = await makeServiceAccountKey());
});

const connected = (extra = {}) => ({
  status: 'connected',
  merchant_id: '123',
  client_email: key.client_email,
  private_key: key.private_key,
  private_key_id: key.private_key_id,
  ...extra,
});

describe('accessTokenFor', () => {
  it('reuses a token with more than five minutes left', async () => {
    const google = createFakeGoogle();
    const { swell } = createFakeSwell({
      connection: connected({ access_token: 'cached', access_token_expires: new Date(NOW + 10 * 60_000).toISOString() }),
    });
    const ctx = testContext(swell, google.fetch);
    expect(await accessTokenFor(ctx, (await loadConnection(swell))!)).toBe('cached');
    expect(google.requests).toHaveLength(0);
  });

  it('fetches and stores a new token when the cached one is about to expire', async () => {
    const google = createFakeGoogle();
    const { swell } = createFakeSwell({
      connection: connected({ access_token: 'old', access_token_expires: new Date(NOW + 60_000).toISOString() }),
    });
    const ctx = testContext(swell, google.fetch);
    const connection = (await loadConnection(swell))!;
    expect(await accessTokenFor(ctx, connection)).toBe('token-1');
    expect(await loadConnection(swell)).toMatchObject({
      access_token: 'token-1',
      access_token_expires: new Date(NOW + 3600_000).toISOString(),
    });
    expect(connection.access_token).toBe('token-1');
  });

  it('hands a new token to the caller to save with its next write', async () => {
    const google = createFakeGoogle();
    const { swell } = createFakeSwell({ connection: connected({ access_token: null }) });
    const connection = (await loadConnection(swell))!;
    const saved: Record<string, unknown> = {};
    expect(await accessTokenFor(testContext(swell, google.fetch), connection, (patch) => Object.assign(saved, patch))).toBe('token-1');
    expect(saved).toEqual({ access_token: 'token-1', access_token_expires: new Date(NOW + 3600_000).toISOString() });
    expect(swell.put).not.toHaveBeenCalled();
  });

  it('marks a connection broken without wiping the key', () => {
    expect(brokenPatch('Invalid JWT Signature.')).toEqual({ status: 'broken', last_error: 'Invalid JWT Signature.', access_token: null, access_token_expires: null });
  });
});
