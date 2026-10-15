import type { AppContext, SwellClient } from '../../functions/lib/context';

export const APP_ID = 'google_merchant_center';
export const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);

export const fixedClock = (at = NOW) => () => at;

/** A clock that moves forward on every read, to run budgets out. */
export function steppingClock(start = NOW, stepMs = 1000) {
  let t = start - stepMs;
  return () => (t += stepMs);
}

const unexpectedFetch = (async (input: RequestInfo | URL) => {
  throw new Error(`unexpected fetch ${String(input)}`);
}) as typeof fetch;

export function testContext(swell: SwellClient, fetchFn: typeof fetch = unexpectedFetch, now = fixedClock()): AppContext {
  return { swell, appId: APP_ID, storeUrl: 'https://test-store.swell.store', fetch: fetchFn, now };
}
