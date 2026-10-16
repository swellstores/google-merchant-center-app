import { describe, expect, it } from 'vitest';
import { AppError } from '../../../functions/lib/context';
import {
  keyOf,
  loadConnection,
  parseServiceAccountKey,
  publicConnection,
  saveConnection,
} from '../../../functions/lib/connection/store';
import { createFakeSwell } from '../../helpers/fake-swell';

const KEY_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'demo-project',
  private_key_id: 'kid-1',
  private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
  client_email: 'sync@demo-project.iam.gserviceaccount.com',
});

describe('parseServiceAccountKey', () => {
  it('reads the fields the app needs', () => {
    expect(parseServiceAccountKey(KEY_JSON)).toEqual({
      client_email: 'sync@demo-project.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
      private_key_id: 'kid-1',
      project_id: 'demo-project',
    });
  });

  it.each([
    ['not json', 'invalid_key'],
    [JSON.stringify({ type: 'authorized_user', client_email: 'a@b.c' }), 'invalid_key'],
    [JSON.stringify({ type: 'service_account', client_email: 'a@b.c' }), 'invalid_key'],
  ])('refuses %s', (text, code) => {
    const error = (() => {
      try {
        parseServiceAccountKey(text);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  });
});

describe('connection record', () => {
  it('creates the record on first save and updates it later', async () => {
    const { swell, collections } = createFakeSwell();
    expect(await loadConnection(swell)).toBeNull();
    const created = await saveConnection(swell, null, { status: 'disconnected', merchant_id: '123' });
    const updated = await saveConnection(swell, created.id, { status: 'connected' });
    expect(updated).toMatchObject({ id: created.id, status: 'connected', merchant_id: '123' });
    expect(collections['/connections']).toHaveLength(1);
    expect(await loadConnection(swell)).toMatchObject({ status: 'connected' });
  });

  it('rebuilds the key only when both email and private key are stored', () => {
    expect(keyOf(null)).toBeNull();
    expect(keyOf({ id: 'c', status: 'connected', client_email: 'a@b.c' })).toBeNull();
    expect(keyOf({ id: 'c', status: 'connected', client_email: 'a@b.c', private_key: 'pk', private_key_id: 'k' })).toEqual({
      client_email: 'a@b.c',
      private_key: 'pk',
      private_key_id: 'k',
      project_id: undefined,
    });
  });

  it('shows no secrets to the admin', () => {
    const view = publicConnection({
      id: 'c',
      status: 'connected',
      merchant_id: '123',
      client_email: 'a@b.c',
      private_key: 'secret',
      access_token: 'secret',
      last_error: null,
      date_connected: '2026-10-15T10:00:00.000Z',
    });
    expect(view).toEqual({
      status: 'connected',
      merchant_id: '123',
      client_email: 'a@b.c',
      has_key: true,
      last_error: null,
      date_connected: '2026-10-15T10:00:00.000Z',
    });
    expect(JSON.stringify(view)).not.toContain('secret');
    expect(publicConnection(null)).toMatchObject({ status: 'disconnected', has_key: false });
  });
});
