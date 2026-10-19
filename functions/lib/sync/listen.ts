import type { QueueKind } from './queue';

// What Google sees of a product and a variant.
const PRODUCT_FIELDS = new Set([
  'name', 'description', 'slug', 'active', 'price', 'sale', 'sale_price', 'purchase_options',
  'images', 'stock_tracking', 'stock_level', 'stock_status', 'options', 'type', 'delivery',
]);
const VARIANT_FIELDS = new Set(['name', 'active', 'archived', 'price', 'sale', 'sale_price', 'purchase_options', 'images', 'stock_level', 'stock_status']);
const LIGHT_FIELDS = new Set(['price', 'sale', 'sale_price', 'purchase_options', 'stock_level', 'stock_status']);

/** Fields the courier writes, and the never-stored fields that host components; changing them must not queue the product again. */
export const SYSTEM_FIELDS = new Set([
  'sync_state', 'sync_reason', 'sync_error', 'date_synced', 'input_ids',
  'status', 'status_label', 'status_issues', 'status_hash', 'date_status',
  'status_panel', 'preview', 'needs_attributes',
]);

export interface EventPlan {
  productId: string;
  kind: QueueKind;
  inputIds?: string[];
}

/** What a product or variant event means for Google, or null when nothing. */
export function planFromEvent(
  appId: string,
  event: { type?: string; data?: Record<string, any> } | undefined,
  data: Record<string, any>,
): EventPlan | null {
  const type = event?.type ?? '';
  // Deleted events carry the record only in the event's own data.
  const record = event?.data ?? {};
  const isVariant = type.startsWith('product.variant.');
  const productId: string | undefined = isVariant ? (data.parent_id ?? record.parent_id) : (data.id ?? record.id);
  if (!type || !productId) return null;

  if (type === 'product.deleted') {
    return { productId, kind: 'delete', inputIds: record.$app?.[appId]?.input_ids ?? data.$app?.[appId]?.input_ids ?? [] };
  }
  if (type === 'product.stock_adjusted') return { productId, kind: 'light' };
  if (!type.endsWith('.updated')) return { productId, kind: 'full' };

  const relevant = isVariant ? VARIANT_FIELDS : PRODUCT_FIELDS;
  const fields = Object.keys(record).filter((key) => relevant.has(key));
  // An operator (`$set`) is part of a write, not a field the merchant changed.
  const ownFields = Object.keys(record.$app?.[appId] ?? {}).filter((key) => !SYSTEM_FIELDS.has(key) && !key.startsWith('$'));
  if (!fields.length && !ownFields.length) return null;
  const light = !ownFields.length && fields.every((key) => LIGHT_FIELDS.has(key));
  return { productId, kind: light ? 'light' : 'full' };
}
