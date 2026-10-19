import type { ProductAttributes, VariantOption } from '../google/merchant';
import type { StatusIssue } from '../status/product-status';
import { truncate } from './text';
import type { SwellProduct, SwellVariant } from './types';

/** Google attributes filled from a variant option. */
export const OPTION_ATTRIBUTES = ['color', 'size', 'material', 'pattern'] as const;
/** Google attributes that are already native fields on the tab. */
export const FIELD_ATTRIBUTES = { age_group: 'Age group', gender: 'Gender' } as const;

/** Every attribute the tab can provide, option attributes first. */
const PROVIDED: readonly string[] = [...OPTION_ATTRIBUTES, ...Object.keys(FIELD_ATTRIBUTES)];

export type OptionAttribute = (typeof OPTION_ATTRIBUTES)[number];
/** Google attribute → variant option id */
export type AttributeOptions = Partial<Record<OptionAttribute, string | null>>;

/** Google's own spellings of one attribute. */
const ALIASES = new Map([['colour', 'color'], ['sizes', 'size']]);

/**
 * Google's attribute name as one spelling: "age group", "ageGroup" and "age_group" are all `age_group`,
 * and "productAttributes.color" is `color`.
 */
export function googleAttribute(name: string | undefined): string | null {
  const spelled = (name ?? '')
    .split('.')
    .pop()!
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!spelled) return null;
  return ALIASES.get(spelled) ?? spelled;
}

export const providesAttribute = (attribute: string | undefined) => attribute !== undefined && PROVIDED.includes(attribute);

export function neededAttributes(issues: StatusIssue[]): string[] {
  const named = new Set(issues.map((issue) => issue.attribute));
  return PROVIDED.filter((attribute) => named.has(attribute));
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
    const name = option?.values?.find((v) => valueIds.includes(v.id))?.name?.trim();
    if (!name) continue;
    out[attribute] = name;
  }
  return out;
}

/** Google's limits for `variantOptions`. */
const MAX_VARIANT_OPTIONS = 30;
const MAX_VARIANT_OPTION_TEXT = 250;
const MAX_VARIANT_OPTIONS_TEXT = 5000;

/**
 * Every variant option of the product with the variant's value, as the merchant named both:
 * the names are copied, never read.
 */
export function variantOptions(product: SwellProduct, variant: SwellVariant | undefined): VariantOption[] | undefined {
  if (!variant) return undefined;
  const valueIds = variant.option_value_ids ?? [];
  const out: VariantOption[] = [];
  let total = 0;
  for (const option of product.options ?? []) {
    if (!option.variant) continue;
    const name = truncate(option.name?.trim() ?? '', MAX_VARIANT_OPTION_TEXT);
    const value = truncate(option.values?.find((v) => valueIds.includes(v.id))?.name?.trim() ?? '', MAX_VARIANT_OPTION_TEXT);
    if (!name || !value) continue;
    if (out.length === MAX_VARIANT_OPTIONS || total + name.length + value.length > MAX_VARIANT_OPTIONS_TEXT) break;
    total += name.length + value.length;
    out.push({ name, value });
  }
  return out.length ? out : undefined;
}
