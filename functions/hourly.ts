import { contextFrom } from './lib/context';
import { runCourier } from './lib/sync/courier';

export const config: SwellConfig = {
  description: 'Start due status checks and keep the courier going',
  cron: { schedule: '0 * * * *' },
};

export default async function (req: SwellRequest) {
  await runCourier(contextFrom(req), { trigger: 'hourly' });
}
