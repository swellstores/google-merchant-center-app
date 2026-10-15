import { AppError } from './context';
import { GoogleApiError } from './google/http';

/** Routes serve the app's admin components only (platform-verified context). */
export function requireAdmin(req: SwellRequest): void {
  const context = (req as { swellContext?: { surface?: string; storeUser?: unknown } | null }).swellContext;
  if (!(context?.surface === 'admin' && context.storeUser)) {
    throw new SwellError('Admin component calls only', { status: 403 });
  }
}

/** A merchant-facing failure as `{ error: { code, message } }`; anything else is rethrown. */
export function errorResponse(error: unknown): SwellResponse {
  if (error instanceof AppError) {
    return new SwellResponse({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  if (error instanceof GoogleApiError) {
    return new SwellResponse({ error: { code: `google_${error.kind}`, message: error.message } }, { status: 502 });
  }
  throw error;
}
