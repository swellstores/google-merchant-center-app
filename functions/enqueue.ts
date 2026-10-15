import { loadConnection } from './lib/connection/store';
import { contextFrom } from './lib/context';
import { armAlarm, ENQUEUE_DELAY_MS } from './lib/sync/alarm';
import { planFromEvent } from './lib/sync/listen';
import { enqueue } from './lib/sync/queue';

export const config: SwellConfig = {
  description: 'Queue a product for Google when it or one of its variants changes',
  model: {
    events: [
      'product.created',
      'product.updated',
      'product.deleted',
      'product.variant.created',
      'product.variant.updated',
      'product.variant.deleted',
      'product.stock_adjusted',
    ],
  },
};

export default async function (req: SwellRequest) {
  const plan = planFromEvent(req.appId, req.data.$event, req.data);
  if (!plan) return;
  const ctx = contextFrom(req);
  const connection = await loadConnection(ctx.swell);
  // After reconnecting, the catalog sync covers whatever changed meanwhile.
  if (connection?.status !== 'connected') return;
  await enqueue(ctx.swell, plan);
  await armAlarm(ctx, ENQUEUE_DELAY_MS);
}
