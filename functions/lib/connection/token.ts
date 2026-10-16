import { AppError, type AppContext } from '../context';
import { fetchAccessToken } from '../google/token';
import { iso } from '../time';
import { keyOf, saveConnection, type Connection } from './store';

const REFRESH_BEFORE_MS = 5 * 60_000;

/**
 * The cached access token, or a new one stored on the connection. `save` takes
 * the new token's patch instead of writing it at once, for a caller that
 * writes the connection in its next batch.
 */
export async function accessTokenFor(ctx: AppContext, connection: Connection, save?: (patch: Partial<Connection>) => void): Promise<string> {
  const expires = connection.access_token_expires ? Date.parse(connection.access_token_expires) : 0;
  if (connection.access_token && expires - ctx.now() > REFRESH_BEFORE_MS) return connection.access_token;
  const key = keyOf(connection);
  if (!key) throw new AppError('not_connected', 'Google Merchant Center is not connected', 409);
  const fresh = await fetchAccessToken(ctx.fetch, key, ctx.now());
  const patch = { access_token: fresh.token, access_token_expires: iso(fresh.expiresAt) };
  if (save) save(patch);
  else await saveConnection(ctx.swell, connection.id, patch);
  Object.assign(connection, patch);
  return fresh.token;
}

/** Google refused the key or the account: syncing stops until the merchant fixes it. */
export const brokenPatch = (message: string): Partial<Connection> => ({ status: 'broken', last_error: message, access_token: null, access_token_expires: null });

export async function markBroken(ctx: AppContext, connection: Connection, message: string): Promise<void> {
  await saveConnection(ctx.swell, connection.id, brokenPatch(message));
}
