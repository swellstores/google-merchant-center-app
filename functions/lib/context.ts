import type { Budget } from './time';

/** The slice of the Swell client the app uses; `req.swell` satisfies it. */
export interface SwellClient {
  get(url: string, query?: object): Promise<any>;
  post(url: string, data: object): Promise<any>;
  put(url: string, data: object): Promise<any>;
  delete(url: string, data?: object): Promise<any>;
}

/** Everything shared code needs from a function invocation. */
export interface AppContext {
  swell: SwellClient;
  appId: string;
  storeUrl: string;
  fetch: typeof fetch;
  now: () => number;
}

export function contextFrom(req: SwellRequest): AppContext {
  return {
    swell: req.swell,
    appId: req.appId,
    storeUrl: req.store.url,
    // Workers reject a detached global fetch, so call it through a closure.
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
  };
}

/** The same context, with every Swell round trip and Google call timed into `budget`. */
export function measured(ctx: AppContext, budget: Budget): AppContext {
  const timed =
    <A extends unknown[], R>(note: (ms: number) => void, call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const start = ctx.now();
      try {
        return await call(...args);
      } finally {
        note(ctx.now() - start);
      }
    };
  const swell = (ms: number) => budget.noteSwell(ms);
  return {
    ...ctx,
    swell: {
      get: timed(swell, (url: string, query?: object) => ctx.swell.get(url, query)),
      post: timed(swell, (url: string, data: object) => ctx.swell.post(url, data)),
      put: timed(swell, (url: string, data: object) => ctx.swell.put(url, data)),
      delete: timed(swell, (url: string, data?: object) => ctx.swell.delete(url, data)),
    },
    fetch: timed((ms) => budget.noteGoogle(ms), (input: RequestInfo | URL, init?: RequestInit) => ctx.fetch(input, init)) as typeof fetch,
  };
}

/** A failure the merchant should see, with a stable code for the UI. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
