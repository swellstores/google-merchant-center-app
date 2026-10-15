export const iso = (ms: number) => new Date(ms).toISOString();

/** A run's time allowance; functions are killed at 10 s. */
export class Budget {
  private readonly deadline: number;

  constructor(
    private readonly now: () => number,
    allowanceMs: number,
  ) {
    this.deadline = now() + allowanceMs;
  }

  remaining(): number {
    return this.deadline - this.now();
  }

  has(ms: number): boolean {
    return this.remaining() >= ms;
  }
}

/** Google's daily Merchant API quota resets at 12:00 UTC. */
export function nextNoonUtc(nowMs: number): number {
  const d = new Date(nowMs);
  const noon = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
  return noon > nowMs ? noon : noon + 86_400_000;
}
