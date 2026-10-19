import { describe, expect, it } from 'vitest';
import { MAX_ANSWER_BYTES } from '../../../functions/lib/admin/product-status';
import { MAX_VARIANTS, productVariants } from '../../../functions/lib/admin/product-variants';
import { testContext } from '../../helpers/context';
import { createFakeSwell, roundTrips } from '../../helpers/fake-swell';

const PID = 'a'.repeat(24);
const QUERY = { where: { archived: { $ne: true } }, fields: 'id, name, active, archived', sort: 'name asc', limit: MAX_VARIANTS };

function setup(variants: Record<string, unknown>[]) {
  const fake = createFakeSwell({ products: [{ id: PID, name: 'Shirt', variants: { results: variants } }] });
  return { swell: fake.swell, ctx: testContext(fake.swell as any) };
}

describe('productVariants', () => {
  it('reads the product’s variants in one request, sorted by name, archived left out', async () => {
    const { swell, ctx } = setup([
      { id: 'v2', name: 'M', active: true },
      { id: 'v3', name: 'Old', active: true, archived: true },
      { id: 'v1', name: 'L', active: false },
    ]);
    expect(await productVariants(ctx, PID)).toEqual({
      variants: [
        { id: 'v1', name: 'L', active: false },
        { id: 'v2', name: 'M', active: true },
      ],
      total: 2,
    });
    expect(roundTrips(swell)).toBe(1);
    expect(swell.get).toHaveBeenCalledWith(`/products/${PID}/variants`, QUERY);
  });

  it('answers only the id, name, active and archived of each variant', async () => {
    const { ctx } = setup([{ id: 'v1', name: 'S', active: true, archived: false, price: 9, sku: 'S-1', images: [{ file: { url: 'x' } }] }]);
    const answer = await productVariants(ctx, PID);
    expect(answer.variants).toEqual([{ id: 'v1', name: 'S', active: true, archived: false }]);
  });

  it('caps the list at 500 and counts them all', async () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ id: `v${i}`, name: `Size ${String(i).padStart(3, '0')}`, active: true }));
    const answer = await productVariants(setup(many).ctx, PID);
    expect(answer.variants).toHaveLength(500);
    expect(answer.total).toBe(600);
    expect(answer.variants[0].name).toBe('Size 000');
  });

  it('cuts the list to keep the answer under the route limit', async () => {
    const long = Array.from({ length: 500 }, (_, i) => ({ id: `${String(i).padStart(24, '0')}`, name: `${String(i).padStart(3, '0')} ${'x'.repeat(200)}`, active: true }));
    const answer = await productVariants(setup(long).ctx, PID);
    expect(new TextEncoder().encode(JSON.stringify(answer)).length).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    expect(answer.variants.length).toBeGreaterThan(100);
    expect(answer.variants.length).toBeLessThan(500);
    expect(answer.total).toBe(500);
  });

  it('answers an empty list for a product without variants', async () => {
    expect(await productVariants(setup([]).ctx, PID)).toEqual({ variants: [], total: 0 });
  });
});
