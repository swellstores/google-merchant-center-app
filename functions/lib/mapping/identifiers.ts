import type { GoogleFields } from './types';

/** "No barcode (GTIN) or part number (MPN)" once set; before that, the legacy `identifier_exists: false`. */
export function hasNoIdentifiers(fields: GoogleFields): boolean {
  return typeof fields.no_identifiers === 'boolean' ? fields.no_identifiers : fields.identifier_exists === false;
}
