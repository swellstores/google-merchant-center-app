/** Listed unless the excluded field is true. */
export function listed(value: unknown): boolean {
  return value !== true;
}

/** Turning the switch on clears the field; turning it off stores true. */
export function nextValue(listedNow: boolean): boolean | null {
  return listedNow ? null : true;
}
