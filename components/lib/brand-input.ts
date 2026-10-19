/** Brands that start with the typed text first, then those that contain it; the exact value itself is left out. */
export function suggestions(all: string[], typed: string, limit = 8): string[] {
  const needle = typed.trim().toLowerCase();
  const starts: string[] = [];
  const contains: string[] = [];
  for (const brand of all) {
    const name = brand.toLowerCase();
    if (name === needle) continue;
    if (name.startsWith(needle)) starts.push(brand);
    else if (name.includes(needle)) contains.push(brand);
  }
  return [...starts, ...contains].slice(0, limit);
}

/** Tickets for async answers: an answer applies only if no newer one has started since. */
export function latestWins() {
  let latest = 0;
  return {
    start: () => ++latest,
    accept(ticket: number, apply: () => void) {
      if (ticket === latest) apply();
    },
  };
}
