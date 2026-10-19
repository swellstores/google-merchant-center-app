import type { AttributeOptions } from './attributes';
import type { StatusIssue, StatusValue } from '../status/product-status';

export interface SwellImage {
  file?: { url?: string | null } | null;
}

export interface StandardOption {
  active?: boolean | null;
  price?: number | null;
  sale?: boolean | null;
  sale_price?: number | null;
}

export interface SwellVariant {
  id: string;
  name?: string;
  price?: number | null;
  sale_price?: number | null;
  purchase_options?: { standard?: StandardOption | null } | null;
  stock_level?: number | null;
  active?: boolean;
  archived?: boolean;
  images?: SwellImage[];
}

/** The app's fields on a product, `$app.google_merchant_center` (models/products.json). */
export interface GoogleFields {
  excluded?: boolean;
  brand?: string;
  mpn?: string;
  condition?: 'new' | 'used' | 'refurbished';
  google_category?: string;
  age_group?: string;
  gender?: string;
  no_identifiers?: boolean;
  /**
   * The barcodes table: `{ <variant id>: { gtin, mpn } }`, or `{ product: { gtin } }` without variants.
   * A cleared cell or entry is stored as null: a save merges into the stored object.
   */
  identifiers?: Record<string, { gtin?: string | null; mpn?: string | null } | null | undefined>;
  sync_state?: 'sent' | 'error' | 'skipped';
  sync_reason?: string | null;
  sync_error?: string | null;
  date_synced?: string | null;
  input_ids?: string[];
  status?: StatusValue | null;
  status_label?: string | null;
  status_issues?: StatusIssue[];
  status_hash?: string | null;
  date_status?: string | null;
  /** Google attribute → variant option id. A cleared choice is stored as null. */
  attribute_options?: AttributeOptions | null;
  needs_attributes?: boolean;
}

export interface SwellProduct {
  id: string;
  name?: string;
  slug?: string;
  description?: string;
  active?: boolean;
  price?: number | null;
  sale?: boolean | null;
  sale_price?: number | null;
  purchase_options?: { standard?: StandardOption | null; subscription?: unknown } | null;
  stock_tracking?: boolean;
  stock_level?: number | null;
  images?: SwellImage[];
  type?: string;
  delivery?: string;
  variants?: { results?: SwellVariant[] } | SwellVariant[];
  $app?: Record<string, GoogleFields | undefined>;
}
