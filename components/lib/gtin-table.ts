import { validateGtin } from '../../functions/lib/mapping/gtin';
import type { SwellVariant } from '../../functions/lib/mapping/types';

export type Identifiers = Record<string, { gtin?: string | null; mpn?: string | null } | null | undefined>;

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
  // The legacy top-level MPN stands in for the shared one until the shared row is first written (or cleared to null).
  const legacyApplies = !(value && SHARED in value);
  const legacyMpn: string = typeof fields.mpn === 'string' ? fields.mpn : '';
  const sharedMpn = legacyApplies ? legacyMpn : (shared?.mpn ?? '');

  const rows: GtinRow[] = variants.length
    ? [
        { key: SHARED, label: 'All variants', gtin: null, mpn: sharedMpn, mpnPlaceholder: '' },
        ...variants.map((v) => ({
          key: v.id,
          label: v.name || v.id,
          gtin: value?.[v.id]?.gtin ?? '',
          mpn: value?.[v.id]?.mpn ?? '',
          mpnPlaceholder: sharedMpn,
        })),
      ]
    : [{ key: SHARED, label: 'This product', gtin: shared?.gtin ?? '', mpn: sharedMpn, mpnPlaceholder: '' }];

  return { rows, disabled, note: disabled ? 'Not sent while the switch above is off' : null };
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

/** Typing into a row's cell. The shared row's first edit also writes the MPN it shows, which may be the legacy one. */
export function editRow(value: Identifiers | null, row: GtinRow, cell: 'gtin' | 'mpn', text: string): Identifiers {
  const base = row.key === SHARED && cell === 'gtin' ? setCell(value, SHARED, 'mpn', row.mpn) : value;
  return setCell(base, row.key, cell, text);
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

/** Not-sent values are not checked. A summary: the admin shows it under the table, which names each cell itself. */
export function tableValidity(model: GtinTableModel): string | null {
  if (model.disabled) return null;
  const bad = model.rows.filter((row) => gtinProblem(row)).length;
  if (bad === 0) return null;
  return bad === 1 ? 'A barcode above is not a valid GTIN.' : `${bad} barcodes above are not valid GTINs.`;
}
