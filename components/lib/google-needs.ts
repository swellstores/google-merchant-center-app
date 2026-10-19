import {
  FIELD_ATTRIBUTES,
  OPTION_ATTRIBUTES,
  neededAttributes,
  type AttributeOptions,
  type OptionAttribute,
} from '../../functions/lib/mapping/attributes';
import type { StatusIssue } from '../../functions/lib/status/product-status';
import type { SwellOption } from '../../functions/lib/mapping/types';

export interface NeedRow {
  attribute: string;
  label: string;
  kind: 'option' | 'field' | 'create';
  /** The variant options of the product; names are labels for the merchant only. */
  options: { id: string; name: string }[];
  chosen: string | null;
  /** The chosen id is not among the options. */
  missing: boolean;
}

const LABELS: Record<string, string> = {
  color: 'Color',
  size: 'Size',
  material: 'Material',
  pattern: 'Pattern',
  ...FIELD_ATTRIBUTES,
};

export function needRows(record: unknown, value: AttributeOptions | null, appId: string): NeedRow[] {
  const { options, $app } = (record ?? {}) as { options?: SwellOption[] | null; $app?: Record<string, { status_issues?: StatusIssue[] } | undefined> };
  const issues = $app?.[appId]?.status_issues ?? [];
  const needed = new Set(neededAttributes(Array.isArray(issues) ? issues : []));
  const variantOptions = (Array.isArray(options) ? options : [])
    .filter((option) => option?.variant === true && typeof option.id === 'string')
    .map((option) => ({ id: option.id, name: option.name || option.id }));

  const rows: NeedRow[] = [];
  for (const attribute of [...OPTION_ATTRIBUTES, ...Object.keys(FIELD_ATTRIBUTES)]) {
    const chosen = (value as Record<string, string | null | undefined> | null)?.[attribute] ?? null;
    if (!needed.has(attribute) && chosen === null) continue;
    const label = LABELS[attribute];
    const base = { attribute, label, chosen, missing: chosen !== null && !variantOptions.some((o) => o.id === chosen) };
    if (attribute in FIELD_ATTRIBUTES) rows.push({ ...base, kind: 'field', options: [], missing: false });
    else if (!variantOptions.length && chosen === null) rows.push({ ...base, kind: 'create', options: [] });
    else rows.push({ ...base, kind: 'option', options: variantOptions });
  }
  return rows;
}

export const MISSING_OPTION = 'The chosen option no longer exists or no longer makes variants.';

/** The line a row without a select shows instead. The age group and gender fields sit in the row after this block. */
export function needHint(row: Pick<NeedRow, 'kind' | 'label'>): string | null {
  if (row.kind === 'field') return `Set “${row.label}” below.`;
  if (row.kind === 'create') return `Create a variant option for the ${row.label.toLowerCase()} on the Options tab, then pick it here.`;
  return null;
}

/** "Not sent" is a null, not a deleted key: a save keeps a stored key the value leaves out. */
export function choose(value: AttributeOptions | null, attribute: OptionAttribute, optionId: string | null): AttributeOptions {
  return { ...value, [attribute]: optionId };
}
