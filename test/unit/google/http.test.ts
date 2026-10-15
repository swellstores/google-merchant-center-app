import { describe, expect, it, vi } from 'vitest';
import { classifyGoogleError, GoogleApiError, googleCall, pathWithQuery } from '../../../functions/lib/google/http';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('classifyGoogleError', () => {
  it.each([
    [401, {}, 'auth'],
    [403, { error: { message: 'GCP project is not registered' } }, 'auth'],
    [429, { error: { message: 'quota/request_rate_too_high' } }, 'rate'],
    [429, { error: { message: 'quota/daily_limit_exceeded' } }, 'daily_quota'],
    [500, {}, 'server'],
    [503, {}, 'server'],
    [404, {}, 'not_found'],
    [409, {}, 'conflict'],
    [400, { error: { message: 'Invalid value' } }, 'data'],
  ])('sorts %i %j as %s', (status, body, kind) => {
    expect(classifyGoogleError(status, body)).toBe(kind);
  });
});

describe('pathWithQuery', () => {
  it('appends an encoded query', () => {
    expect(pathWithQuery({ method: 'GET', path: '/a', query: { dataSource: 'accounts/1/dataSources/2' } })).toBe(
      '/a?dataSource=accounts%2F1%2FdataSources%2F2',
    );
    expect(pathWithQuery({ method: 'GET', path: '/a' })).toBe('/a');
  });
});

describe('googleCall', () => {
  it('sends the bearer token and JSON body and returns the parsed answer', async () => {
    const fetchFn = vi.fn(async () => json(200, { name: 'accounts/1' }));
    const result = await googleCall(fetchFn as unknown as typeof fetch, 'tok', { method: 'POST', path: '/x', body: { a: 1 } });
    expect(result).toEqual({ name: 'accounts/1' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://merchantapi.googleapis.com/x');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok');
    expect(init.body).toBe('{"a":1}');
  });

  it('throws a classified error with Google’s message', async () => {
    const fetchFn = vi.fn(async () => json(403, { error: { code: 403, message: 'The caller does not have permission' } }));
    const error = await googleCall(fetchFn as unknown as typeof fetch, 'tok', { method: 'GET', path: '/x' }).catch((e) => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error).toMatchObject({ kind: 'auth', status: 403, message: 'The caller does not have permission' });
  });

  it('treats a network failure as a server error', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('network down');
    });
    const error = await googleCall(fetchFn as unknown as typeof fetch, 'tok', { method: 'GET', path: '/x' }).catch((e) => e);
    expect(error).toMatchObject({ kind: 'server', status: 0 });
  });
});
