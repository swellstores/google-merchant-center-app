import { errorResponse, requireAdmin } from './lib/admin';
import { storeBrands } from './lib/admin/brands';
import { contextFrom } from './lib/context';

export const config: SwellConfig = {
  description: 'The brands already used in the store, for the brand field of the product components',
  route: { methods: ['get'], cache: { timeout: 0 } },
};

export async function get(req: SwellRequest) {
  requireAdmin(req);
  const ctx = contextFrom(req);
  try {
    return await storeBrands(ctx);
  } catch (error) {
    return errorResponse(error);
  }
}
