import { validateGtin } from '../../functions/lib/mapping/gtin';
import type { SwellVariant } from '../../functions/lib/mapping/types';

export type Identifiers = Record<string, { gtin?: string | null; mpn?: string | null } | null | undefined>;

export interface GtinRow {
  /** A variant id, or 'product' for a product without variants. */
  key: string;
  label: string;
  gtin: string;
  /** null: no MPN cell. A product without variants takes its MPN from the field above the table. */
  mpn: string | null;
  /** The product's MPN, which a variant without its own is sent with. */
  mpnPlaceholder?: string;
}

export interface GtinTableModel {
  /** true: a row per live variant (maybe none); false: the product's single GTIN. */
  perVariant: boolean;
  rows: GtinRow[];
}

/** Every variant of the product, as the product route's `view=variants` answers it. */
export interface VariantList {
  variants: SwellVariant[];
  total: number;
}

const SINGLE = 'product';

function variantsOf(variants: unknown): SwellVariant[] {
  return Array.isArray(variants) ? variants : ((variants as { results?: SwellVariant[] } | null | undefined)?.results ?? []);
}

/**
 * The admin hands the edit page's current page of variants, `{ count, results }`
 * (25 by name, archived left out). Null when that page holds them all.
 */
export function variantPage(record: { variants?: unknown }): { shown: number; total: number } | null {
  const variants = record.variants as { count?: unknown; results?: unknown } | null | undefined;
  if (!variants || typeof variants !== 'object' || Array.isArray(variants)) return null;
  const shown = Array.isArray(variants.results) ? variants.results.length : 0;
  const total = typeof variants.count === 'number' ? variants.count : shown;
  return total > shown ? { shown, total } : null;
}

export function variantList(answer: unknown): VariantList | null {
  const { variants, total } = (answer ?? {}) as { variants?: unknown; total?: unknown };
  if (!Array.isArray(variants)) return null;
  const list = variants.filter((v): v is SwellVariant => typeof v?.id === 'string');
  return { variants: list, total: typeof total === 'number' ? total : list.length };
}

/** The muted line under the table while it shows only some of the variants. */
export function variantsNote(page: { shown: number; total: number } | null, loaded: VariantList | null, failed: boolean): string | null {
  if (loaded) return loaded.total > loaded.variants.length ? `Showing ${loaded.variants.length} of ${loaded.total} variants.` : null;
  if (!page) return null;
  return `Showing ${page.shown} of ${page.total} variants.${failed ? ' Could not load the rest.' : ''}`;
}

/** `allVariants`: the full list once loaded, which replaces the record's page of variants. */
export function gtinTableModel(
  record: { variants?: unknown; $app?: Record<string, any> },
  value: Identifiers | null,
  appId: string,
  allVariants?: SwellVariant[] | null,
): GtinTableModel {
  // As the mapping decides: any variant, live or not, means the product sells its live variants only.
  const all = variantsOf(allVariants?.length ? allVariants : record.variants);
  if (!all.length) {
    return { perVariant: false, rows: [{ key: SINGLE, label: 'This product', gtin: value?.[SINGLE]?.gtin ?? '', mpn: null }] };
  }
  const productMpn = record.$app?.[appId]?.mpn;
  const mpnPlaceholder: string = typeof productMpn === 'string' ? productMpn : '';
  const rows = all
    .filter((v) => v.active !== false && !v.archived)
    .map((v) => ({
      key: v.id,
      label: v.name || v.id,
      gtin: value?.[v.id]?.gtin ?? '',
      mpn: value?.[v.id]?.mpn ?? '',
      mpnPlaceholder,
    }));
  return { perVariant: true, rows };
}

const blank = (cell: string | null | undefined) => !cell?.trim();

/**
 * A save merges the value into the stored object, where a left-out key keeps
 * its stored value. So a cleared cell is sent as null, and so is an entry left
 * with no value.
 */
export function setCell(value: Identifiers | null, key: string, cell: 'gtin' | 'mpn', text: string): Identifiers {
  const entry = { ...value?.[key], [cell]: blank(text) ? null : text };
  return { ...value, [key]: blank(entry.gtin) && blank(entry.mpn) ? null : entry };
}

const REASONS = {
  length: 'Needs 8, 12, 13 or 14 digits',
  digits: 'Digits only',
  check_digit: 'Wrong check digit',
};

/** The short reason shown under a bad GTIN cell; null for a valid or empty one. */
export function gtinProblem(row: GtinRow): string | null {
  if (!row.gtin.trim()) return null;
  const check = validateGtin(row.gtin);
  return check.ok === true ? null : REASONS[check.reason];
}

/** A summary: the admin shows it under the table, which marks each bad cell itself. */
export function tableValidity(model: GtinTableModel): string | null {
  const bad = model.rows.filter((row) => gtinProblem(row)).length;
  if (bad === 0) return null;
  return bad === 1 ? 'A barcode above is not a valid GTIN.' : `${bad} barcodes above are not valid GTINs.`;
}
