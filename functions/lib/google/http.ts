export type GoogleErrorKind = 'auth' | 'rate' | 'daily_quota' | 'server' | 'not_found' | 'conflict' | 'data';

export class GoogleApiError extends Error {
  constructor(
    public readonly kind: GoogleErrorKind,
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

export const MERCHANT_API = 'https://merchantapi.googleapis.com';

export interface GoogleCall {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Starts with '/', e.g. '/accounts/v1/accounts/123' */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export function pathWithQuery(call: GoogleCall): string {
  const qs = call.query ? new URLSearchParams(call.query).toString() : '';
  return qs ? `${call.path}?${qs}` : call.path;
}

/** Sorts a failed Google response into what the caller should do about it. */
export function classifyGoogleError(status: number, body: unknown): GoogleErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return JSON.stringify(body ?? '').includes('daily_limit') ? 'daily_quota' : 'rate';
  if (status >= 500) return 'server';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  return 'data';
}

export function errorMessage(body: unknown, status: number): string {
  const message = (body as { error?: { message?: string } } | null)?.error?.message;
  return message || `Google responded ${status}`;
}

/** The reasons Google gives in an error's details, e.g. `GCP_NOT_REGISTERED`. */
export function errorReasons(body: unknown): string[] {
  const details = (body as { error?: { details?: { reason?: string; metadata?: { REASON?: string } }[] } } | null)?.error?.details;
  if (!Array.isArray(details)) return [];
  return details.flatMap((detail) => [detail?.reason, detail?.metadata?.REASON]).filter((reason): reason is string => typeof reason === 'string');
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** One Merchant API call. Resolves with the parsed body; throws GoogleApiError otherwise. */
export async function googleCall<T = any>(fetchFn: typeof fetch, token: string, call: GoogleCall): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(`${MERCHANT_API}${pathWithQuery(call)}`, {
      method: call.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(call.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
    });
  } catch (error) {
    throw new GoogleApiError('server', 0, `Google could not be reached: ${String(error)}`);
  }
  const text = await res.text();
  const body = text ? safeJson(text) : {};
  if (!res.ok) throw new GoogleApiError(classifyGoogleError(res.status, body), res.status, errorMessage(body, res.status), body);
  return body as T;
}
