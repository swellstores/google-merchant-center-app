import { AppError, type SwellClient } from '../context';
import type { ServiceAccountKey } from '../google/jwt';

export type ConnectionStatus = 'disconnected' | 'connected' | 'broken';

export interface Connection {
  id: string;
  status: ConnectionStatus;
  merchant_id?: string | null;
  client_email?: string | null;
  project_id?: string | null;
  private_key_id?: string | null;
  private_key?: string | null;
  access_token?: string | null;
  access_token_expires?: string | null;
  registered?: boolean;
  last_error?: string | null;
  date_connected?: string | null;
  date_checked?: string | null;
}

/** What the admin may see: no key, no token. */
export interface PublicConnection {
  status: ConnectionStatus;
  merchant_id: string | null;
  client_email: string | null;
  last_error: string | null;
  date_connected: string | null;
}

// The bare path is the app's own collection and needs no permission.
const COLLECTION = '/connections';

export async function loadConnection(swell: SwellClient): Promise<Connection | null> {
  const list = await swell.get(COLLECTION, { limit: 1, sort: 'date_created asc' });
  return list?.results?.[0] ?? null;
}

export async function saveConnection(swell: SwellClient, id: string | null, patch: Partial<Connection>): Promise<Connection> {
  return id ? swell.put(`${COLLECTION}/${id}`, patch) : swell.post(COLLECTION, patch);
}

export function parseServiceAccountKey(text: string): ServiceAccountKey {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError('invalid_key', 'The key is not valid JSON. Paste the whole key file.');
  }
  const { type, client_email, private_key, private_key_id, project_id } = parsed ?? {};
  if (type !== 'service_account' || typeof client_email !== 'string' || typeof private_key !== 'string') {
    throw new AppError('invalid_key', 'This is not a service account key. Download a JSON key from the service account page.');
  }
  return {
    client_email,
    private_key,
    private_key_id: typeof private_key_id === 'string' ? private_key_id : undefined,
    project_id: typeof project_id === 'string' ? project_id : undefined,
  };
}

export function keyOf(connection: Connection | null): ServiceAccountKey | null {
  if (!connection?.client_email || !connection.private_key) return null;
  return {
    client_email: connection.client_email,
    private_key: connection.private_key,
    private_key_id: connection.private_key_id ?? undefined,
    project_id: connection.project_id ?? undefined,
  };
}

export function publicConnection(connection: Connection | null): PublicConnection {
  return {
    status: connection?.status ?? 'disconnected',
    merchant_id: connection?.merchant_id ?? null,
    client_email: connection?.client_email ?? null,
    last_error: connection?.last_error ?? null,
    date_connected: connection?.date_connected ?? null,
  };
}
