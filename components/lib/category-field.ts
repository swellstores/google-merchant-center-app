export const CATEGORY_LIST_URL = 'https://support.google.com/merchants/answer/6324436';

/** What the input shows: a stored string as it is, anything else as an empty field. */
export function categoryText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The text as typed, or null when it is blank. Not trimmed, so a typed space survives the next render. */
export function categoryValue(text: string): string | null {
  return text.trim() ? text : null;
}
