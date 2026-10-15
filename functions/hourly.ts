import { contextFrom } from './lib/context';
import { runHourly } from './lib/sync/hourly';

export const config: SwellConfig = {
  description: 'Refresh the Merchant API quota and wake a stalled courier',
  cron: { schedule: '0 * * * *' },
};

export default async function (req: SwellRequest) {
  await runHourly(contextFrom(req));
}
