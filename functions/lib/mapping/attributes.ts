import type { ProductAttributes } from '../google/merchant';
import type { StatusIssue } from '../status/product-status';
import type { SwellProduct, SwellVariant } from './types';

/** Google attributes filled from a variant option. */
export const OPTION_ATTRIBUTES = ['color', 'size', 'material', 'pattern'] as const;
/** Google attributes that are already native fields on the tab. */
export const FIELD_ATTRIBUTES = { age_group: 'Age group', gender: 'Gender' } as const;

export type OptionAttribute = (typeof OPTION_ATTRIBUTES)[number];
/** Google attribute → variant option id */
export type AttributeOptions = Partial<Record<OptionAttribute, string | null>>;

/** Google's attribute name as one spelling: "age group", "ageGroup" and "age_group" are all `age_group`. */
export function googleAttribute(name: string | undefined): string | null {
  const spelled = (name ?? '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!spelled) return null;
  return spelled === 'colour' ? 'color' : spelled;
}

export function neededAttributes(issues: StatusIssue[]): string[] {
  const named = new Set(issues.map((issue) => issue.attribute));
  return [...OPTION_ATTRIBUTES, ...Object.keys(FIELD_ATTRIBUTES)].filter((attribute) => named.has(attribute));
}

export function needsAttributes(issues: StatusIssue[], chosen: AttributeOptions | null | undefined): boolean {
  return neededAttributes(issues).length > 0 || Object.values(chosen ?? {}).some((id) => id != null);
}

/**
 * The variant's value of each option the merchant chose. Options are found by id only:
 * nothing is read from option or value names, nor from the option's `attribute_id`.
 */
export function variantAttributes(
  product: SwellProduct,
  variant: SwellVariant | undefined,
  chosen: AttributeOptions | null | undefined,
): Partial<Pick<ProductAttributes, 'color' | 'size' | 'material' | 'pattern'>> {
  const out: Partial<Pick<ProductAttributes, 'color' | 'size' | 'material' | 'pattern'>> = {};
  const valueIds = variant?.option_value_ids;
  if (!chosen || !valueIds?.length) return out;
  for (const attribute of OPTION_ATTRIBUTES) {
    const optionId = chosen[attribute];
    if (!optionId) continue;
    const option = product.options?.find((o) => o.id === optionId && o.variant);
    const value = option?.values?.find((v) => valueIds.includes(v.id));
    if (!value?.name) continue;
    out[attribute] = value.name;
  }
  return out;
}
