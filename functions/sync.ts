import { dashboardView, startFullSync, startStatusRefresh } from './lib/admin/dashboard';
import { errorResponse, requireAdmin } from './lib/admin';
import { AppError, contextFrom } from './lib/context';

export const config: SwellConfig = {
  description: 'Sync dashboard data and actions, for the SyncDashboard component',
  route: { methods: ['get', 'post'], cache: { timeout: 0 } },
};

export async function get(req: SwellRequest) {
  requireAdmin(req);
  return dashboardView(contextFrom(req));
}

export async function post(req: SwellRequest) {
  requireAdmin(req);
  const ctx = contextFrom(req);
  const body: Record<string, any> = typeof req.body === 'object' && req.body ? req.body : {};
  try {
    if (body.op === 'sync_all') return await startFullSync(ctx);
    if (body.op === 'refresh_statuses') return await startStatusRefresh(ctx);
    throw new AppError('unknown_op', 'Unknown operation');
  } catch (error) {
    return errorResponse(error);
  }
}
