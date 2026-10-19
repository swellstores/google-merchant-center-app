import { errorResponse, requireAdmin } from './lib/admin';
import { previewContext, productIdOf, productStatusView, resendProduct } from './lib/admin/product-status';
import { productVariants } from './lib/admin/product-variants';
import { AppError, contextFrom } from './lib/context';

export const config: SwellConfig = {
  description: 'A product\'s Google status, its variants, the preview context and resending, for the product components',
  route: { methods: ['get', 'post'], cache: { timeout: 0 } },
};

export async function get(req: SwellRequest) {
  requireAdmin(req);
  const ctx = contextFrom(req);
  try {
    if (req.query.view === 'preview') return await previewContext(ctx);
    if (req.query.view === 'variants') return await productVariants(ctx, productIdOf(req.query.id));
    return await productStatusView(ctx, productIdOf(req.query.id), req.query.live !== '0');
  } catch (error) {
    return errorResponse(error);
  }
}

export async function post(req: SwellRequest) {
  requireAdmin(req);
  const ctx = contextFrom(req);
  const body: Record<string, any> = typeof req.body === 'object' && req.body ? req.body : {};
  try {
    if (body.op === 'resend') return await resendProduct(ctx, productIdOf(body.id));
    throw new AppError('unknown_op', 'Unknown operation');
  } catch (error) {
    return errorResponse(error);
  }
}
