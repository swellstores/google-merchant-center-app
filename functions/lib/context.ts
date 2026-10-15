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
