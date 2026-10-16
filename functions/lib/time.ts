export const iso = (ms: number) => new Date(ms).toISOString();

/** What a Google call is taken to cost until the run has measured one. */
export const GOOGLE_GUESS_MS = 1500;

/**
 * A run's time allowance (functions are killed at 10 s), with the slowest
 * Swell round trip and Google call measured so far in the run.
 */
export class Budget {
  private readonly deadline: number;
  swellMs = 0;
  googleMs = GOOGLE_GUESS_MS;
  private googleSeen = false;

  constructor(
    private readonly now: () => number,
    allowanceMs: number,
  ) {
    this.deadline = now() + allowanceMs;
  }

  left(): number {
    return this.deadline - this.now();
  }

  has(ms: number): boolean {
    return this.left() >= ms;
  }

  noteSwell(ms: number): void {
    this.swellMs = Math.max(this.swellMs, ms);
  }

  noteGoogle(ms: number): void {
    this.googleMs = this.googleSeen ? Math.max(this.googleMs, ms) : ms;
    this.googleSeen = true;
  }

  /** Time for `swellTrips` more round trips to Swell and one Google call, at the slowest seen. */
  allows(swellTrips: number): boolean {
    return this.has(swellTrips * this.swellMs + this.googleMs);
  }
}

/** Google's daily Merchant API quota resets at 12:00 UTC. */
export function nextNoonUtc(nowMs: number): number {
  const d = new Date(nowMs);
  const noon = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
  return noon > nowMs ? noon : noon + 86_400_000;
}
