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
