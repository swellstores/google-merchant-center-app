import type { AppContext } from '../context';
import { MAX_ANSWER_BYTES } from './product-status';

export const MAX_VARIANTS = 500;

export interface VariantRow {
  id: string;
  name?: string;
  active?: boolean;
  archived?: boolean;
}

export interface ProductVariants {
  variants: VariantRow[];
  /** Every unarchived variant of the product, also those beyond the list. */
  total: number;
}

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Long names could push 500 rows past the route limit; the rows that do not fit are left out. */
function fitted(answer: ProductVariants): ProductVariants {
  if (bytesOf(answer) <= MAX_ANSWER_BYTES) return answer;
  let room = MAX_ANSWER_BYTES - bytesOf({ ...answer, variants: [] });
  const kept: VariantRow[] = [];
  for (const variant of answer.variants) {
    room -= bytesOf(variant) + 1;
    if (room < 0) break;
    kept.push(variant);
  }
  return { ...answer, variants: kept };
}

/**
 * Every variant of a product for the barcodes table: the admin hands a
 * component only the edit page's page of 25. One read; archived variants are
 * left out, as on the edit page.
 */
export async function productVariants(ctx: AppContext, productId: string): Promise<ProductVariants> {
  const answer = await ctx.swell.get(`/products/${productId}/variants`, {
    where: { archived: { $ne: true } },
    fields: 'id, name, active, archived',
    sort: 'name asc',
    limit: MAX_VARIANTS,
  });
  const results: any[] = Array.isArray(answer?.results) ? answer.results : [];
  const variants: VariantRow[] = results
    .filter((v) => typeof v?.id === 'string')
    .map(({ id, name, active, archived }) => ({ id, name, active, archived }));
  const total = typeof answer?.count === 'number' ? Math.max(answer.count, variants.length) : variants.length;
  return fitted({ variants, total });
}
