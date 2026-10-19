import type { AppContext } from '../context';

export const MAX_BRANDS = 500;

/** The brand of one product, under the app id or (as the admin credentials key it) the app record id. */
function brandOf(result: any, appId: string): unknown {
  const app = result?.$app;
  if (!app || typeof app !== 'object') return undefined;
  const own = app[appId];
  if (own && typeof own === 'object') return own.brand;
  const [only] = Object.values<any>(app);
  return only && typeof only === 'object' ? only.brand : undefined;
}

const byName = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);

/**
 * The brands already set in the store, for the brand field to suggest. Swell's
 * `group` does not translate app field paths, so this reads the field itself,
 * most recently updated first, and dedupes here.
 */
export async function storeBrands(ctx: AppContext): Promise<{ brands: string[] }> {
  const path = `$app.${ctx.appId}.brand`;
  const answer = await ctx.swell.get('/products', { where: { [path]: { $exists: true } }, fields: path, sort: 'date_updated desc', limit: 1000 });
  const results: unknown[] = Array.isArray(answer?.results) ? answer.results : [];
  const seen = new Map<string, string>();
  for (const result of results) {
    const brand = brandOf(result, ctx.appId);
    if (typeof brand !== 'string') continue;
    const name = brand.trim();
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return { brands: [...seen.values()].sort(byName).slice(0, MAX_BRANDS) };
}
