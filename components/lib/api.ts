export const APP_ID = 'google_merchant_center';

export class RouteError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'RouteError';
  }
}

/** Calls one of the app's route functions; `props.fetch` adds the component token. */
export async function callRoute<T>(fetchFn: typeof fetch, name: string, body?: unknown): Promise<T> {
  const res = await fetchFn(
    `/functions/${APP_ID}/${name}`,
    body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  const data = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
  if (!res.ok) throw new RouteError(data?.error?.message || `Request failed (${res.status})`, data?.error?.code);
  return data as T;
}
