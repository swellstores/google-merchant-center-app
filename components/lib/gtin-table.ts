import { validateGtin } from '../../functions/lib/mapping/gtin';
import type { SwellVariant } from '../../functions/lib/mapping/types';

export type Identifiers = Record<string, { gtin?: string; mpn?: string } | undefined>;

export interface GtinRow {
  /** A variant id, or 'product' for the shared row. */
  key: string;
  label: string;
  /** null: this row has no GTIN cell. */
  gtin: string | null;
  mpn: string;
  mpnPlaceholder: string;
}

export interface GtinTableModel {
  rows: GtinRow[];
  disabled: boolean;
  note: string | null;
}

const SHARED = 'product';

function liveVariants(variants: unknown): SwellVariant[] {
  const list: SwellVariant[] = Array.isArray(variants) ? variants : ((variants as { results?: SwellVariant[] } | null | undefined)?.results ?? []);
  return list.filter((v) => v.active !== false && !v.archived);
}

export function gtinTableModel(record: { variants?: unknown; $app?: Record<string, any> }, value: Identifiers | null, appId: string): GtinTableModel {
  const fields = record.$app?.[appId] ?? {};
  const disabled = fields.identifier_exists === false;
  const variants = liveVariants(record.variants);
  const shared = value?.[SHARED];
  const sharedMpn = shared?.mpn ?? '';
  const legacyMpn: string = typeof fields.mpn === 'string' ? fields.mpn : '';
  const common = sharedMpn || legacyMpn;

  const rows: GtinRow[] = variants.length
    ? [
        { key: SHARED, label: 'All variants', gtin: null, mpn: sharedMpn, mpnPlaceholder: legacyMpn },
        ...variants.map((v) => ({
          key: v.id,
          label: v.name || v.id,
          gtin: value?.[v.id]?.gtin ?? '',
          mpn: value?.[v.id]?.mpn ?? '',
          mpnPlaceholder: common,
        })),
      ]
    : [{ key: SHARED, label: 'This product', gtin: shared?.gtin ?? '', mpn: sharedMpn, mpnPlaceholder: legacyMpn }];

  return { rows, disabled, note: disabled ? 'Not sent while the switch above is off' : null };
}

export function setCell(value: Identifiers | null, key: string, cell: 'gtin' | 'mpn', text: string): Identifiers {
  const { [key]: entry, ...rest } = value ?? {};
  const { [cell]: _dropped, ...kept } = entry ?? {};
  const next = text.trim() ? { ...kept, [cell]: text } : kept;
  return Object.keys(next).length ? { ...rest, [key]: next } : rest;
}

const REASONS = {
  length: 'a GTIN has 8, 12, 13 or 14 digits.',
  digits: 'a GTIN has digits only.',
  check_digit: 'the check digit is wrong.',
};

export function gtinProblem(row: GtinRow): string | null {
  if (!row.gtin?.trim()) return null;
  const check = validateGtin(row.gtin);
  if (check.ok === true) return null;
  const who = row.key === SHARED ? 'this product' : `variant ${row.label}`;
  return `GTIN of ${who}: ${REASONS[check.reason]}`;
}

/** Not-sent values are not checked. */
export function tableValidity(model: GtinTableModel): string | null {
  if (model.disabled) return null;
  for (const row of model.rows) {
    const problem = gtinProblem(row);
    if (problem) return problem;
  }
  return null;
}
