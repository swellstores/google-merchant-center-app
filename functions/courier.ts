import { contextFrom } from './lib/context';
import { runCourier } from './lib/sync/courier';

export const config: SwellConfig = {
  description: 'Send queued product changes and the catalog to Google in batches, at the alarm time',
  model: {
    events: ['alarm.created', 'alarm.updated'],
    conditions: { wake_at: { $ne: null } },
    schedule: { formula: 'wake_at' },
  },
};

export default async function (req: SwellRequest) {
  await runCourier(contextFrom(req));
}
