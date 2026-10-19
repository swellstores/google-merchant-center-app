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
  /** Google asks for the attribute. */
  asked: boolean;
}

export interface NeedNote {
  text: string;
  tone: 'warn' | 'bad' | 'muted';
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
  const chosenOf = (attribute: string) => (value as Record<string, string | null | undefined> | null)?.[attribute] ?? null;

  const rows: NeedRow[] = [];
  // With variant options every option row stays, whatever its choice: "Not sent" never removes one.
  for (const attribute of OPTION_ATTRIBUTES) {
    const chosen = chosenOf(attribute);
    const base = { attribute, label: LABELS[attribute], chosen, asked: needed.has(attribute) };
    if (variantOptions.length) {
      rows.push({ ...base, kind: 'option', options: variantOptions, missing: chosen !== null && !variantOptions.some((o) => o.id === chosen) });
    } else if (chosen !== null) {
      rows.push({ ...base, kind: 'option', options: [], missing: true });
    } else if (base.asked) {
      rows.push({ ...base, kind: 'create', options: [], missing: false });
    }
  }
  for (const attribute of Object.keys(FIELD_ATTRIBUTES)) {
    if (!needed.has(attribute)) continue;
    rows.push({ attribute, label: LABELS[attribute], kind: 'field', options: [], chosen: chosenOf(attribute), missing: false, asked: true });
  }
  return rows;
}

export const MISSING_OPTION = 'The chosen option no longer exists or no longer makes variants.';

/** The line under an option row's select. */
export function needNote(row: Pick<NeedRow, 'kind' | 'asked' | 'chosen' | 'missing'>): NeedNote | null {
  if (row.missing) return { text: MISSING_OPTION, tone: 'bad' };
  if (row.kind !== 'option' || !row.asked) return null;
  if (row.chosen === null) return { text: 'Google asks for this.', tone: 'warn' };
  return { text: 'Google rechecks this after the next sync.', tone: 'muted' };
}

/** The line a row without a select shows instead. The age group and gender fields sit in a row above this block. */
export function needHint(row: Pick<NeedRow, 'kind' | 'label'>): string | null {
  if (row.kind === 'field') return `Set “${row.label}” above.`;
  if (row.kind === 'create') return `Create a variant option for the ${row.label.toLowerCase()} on the Options tab, then pick it here.`;
  return null;
}

/** "Not sent" is a null, not a deleted key: a save keeps a stored key the value leaves out. */
export function choose(value: AttributeOptions | null, attribute: OptionAttribute, optionId: string | null): AttributeOptions {
  return { ...value, [attribute]: optionId };
}
