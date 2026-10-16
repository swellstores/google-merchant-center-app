import { errorResponse, requireAdmin } from './lib/admin';
import { activate, check, connectionStatus, disconnect } from './lib/connection/connect';
import { AppError, contextFrom } from './lib/context';

export const config: SwellConfig = {
  description: 'Google Merchant Center connection, for the GoogleConnect component',
  route: { methods: ['get', 'post'], cache: { timeout: 0 } },
};

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export async function get(req: SwellRequest) {
  requireAdmin(req);
  return connectionStatus(contextFrom(req));
}

/** `check` stores the key and asks Google; `activate` then sets up the market and starts syncing. */
export async function post(req: SwellRequest) {
  requireAdmin(req);
  const ctx = contextFrom(req);
  const body: Record<string, any> = typeof req.body === 'object' && req.body ? req.body : {};
  try {
    if (body.op === 'check') {
      return await check(ctx, { key: text(body.key), merchant_id: text(body.merchant_id) ?? '' });
    }
    if (body.op === 'activate') {
      return await activate(ctx, { country: text(body.country) ?? '', link_template: text(body.link_template) ?? '' });
    }
    if (body.op === 'disconnect') {
      await disconnect(ctx, body.remove_products === true);
      return await connectionStatus(ctx);
    }
    throw new AppError('unknown_op', 'Unknown operation');
  } catch (error) {
    return errorResponse(error);
  }
}
