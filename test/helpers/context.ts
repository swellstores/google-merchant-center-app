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

/**
 * Swell and Google that take the given time per round trip, on a clock that
 * moves only then: a run's fake duration is its round trips. A `/:batch`
 * costs a round trip per 10 operations (the server runs 10 at a time), and
 * calls made at the same time overlap, as concurrent requests do.
 */
export function slowServices(swell: SwellClient, fetchFn: typeof fetch, latency: { swellMs: number; googleMs: number }, start = NOW) {
  let t = start;
  const after =
    <A extends unknown[], R>(ms: number, call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const end = t + ms;
      const result = await call(...args);
      t = Math.max(t, end);
      return result;
    };
  return {
    now: () => t,
    swell: {
      get: after(latency.swellMs, (url: string, query?: object) => swell.get(url, query)),
      post: (url: string, data: object) => {
        const waves = url === '/:batch' && Array.isArray(data) ? Math.max(1, Math.ceil(data.length / 10)) : 1;
        return after(latency.swellMs * waves, (u: string, d: object) => swell.post(u, d))(url, data);
      },
      put: after(latency.swellMs, (url: string, data: object) => swell.put(url, data)),
      delete: after(latency.swellMs, (url: string, data?: object) => swell.delete(url, data)),
    } satisfies SwellClient,
    fetch: after(latency.googleMs, (input: RequestInfo | URL, init?: RequestInit) => fetchFn(input, init)) as typeof fetch,
  };
}
