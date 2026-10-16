import { contextFrom } from './lib/context';
import { planFromEvent } from './lib/sync/listen';
import { queueChange } from './lib/sync/queue';

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
  if (plan) await queueChange(contextFrom(req), plan);
}
