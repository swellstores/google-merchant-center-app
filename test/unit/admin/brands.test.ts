import { describe, expect, it, vi } from 'vitest';
import { storeBrands } from '../../../functions/lib/admin/brands';
import { APP_ID, testContext } from '../../helpers/context';

const QUERY = { where: { [`$app.${APP_ID}.brand`]: { $exists: true } }, fields: `$app.${APP_ID}.brand`, sort: 'date_updated desc', limit: 1000 };

function setup(answer: unknown) {
  const get = vi.fn(async () => answer);
  const swell = { get, post: vi.fn(), put: vi.fn(), delete: vi.fn() };
  return { get, ctx: testContext(swell as any) };
}

const brandOf = (brand: unknown) => ({ $app: { [APP_ID]: { brand } } });

describe('storeBrands', () => {
  it('reads brands in one request', async () => {
    const { ctx, get } = setup({ results: [brandOf('Acme')] });
    expect(await storeBrands(ctx)).toEqual({ brands: ['Acme'] });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/products', QUERY);
  });

  it('reads the brand under either $app key', async () => {
    const { ctx } = setup({ results: [brandOf('Acme'), { $app: { rec123: { brand: 'Zed' } } }] });
    expect(await storeBrands(ctx)).toEqual({ brands: ['Acme', 'Zed'] });
  });

  it('trims, dedupes case-insensitively and sorts', async () => {
    const { ctx } = setup({ results: [brandOf('  nike '), brandOf('adidas'), brandOf('Nike'), brandOf('Puma'), brandOf('NIKE')] });
    expect(await storeBrands(ctx)).toEqual({ brands: ['adidas', 'nike', 'Puma'] });
  });

  it('skips blanks and non-strings', async () => {
    const { ctx } = setup({ results: [brandOf('  '), brandOf(5), brandOf(null), {}, { $app: {} }, brandOf('Ok')] });
    expect(await storeBrands(ctx)).toEqual({ brands: ['Ok'] });
  });

  it('keeps at most 500 brands', async () => {
    const results = Array.from({ length: 700 }, (_, i) => brandOf(`b${String(i).padStart(3, '0')}`));
    expect((await storeBrands(setup({ results }).ctx)).brands).toHaveLength(500);
  });

  it('answers an empty list for an answer without results', async () => {
    expect(await storeBrands(setup(null).ctx)).toEqual({ brands: [] });
    expect(await storeBrands(setup({}).ctx)).toEqual({ brands: [] });
  });

  it('lets a failing read through', async () => {
    const { ctx, get } = setup(null);
    get.mockRejectedValue(new Error('boom'));
    await expect(storeBrands(ctx)).rejects.toThrow('boom');
  });
});
