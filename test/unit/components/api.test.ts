import { describe, expect, it, vi } from 'vitest';
import { callRoute, RouteError } from '../../../components/lib/api';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('callRoute', () => {
  it('GETs the app’s route without a body', async () => {
    const fetchFn = vi.fn(async () => json(200, { ok: true }));
    expect(await callRoute(fetchFn as unknown as typeof fetch, 'connection')).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledWith('/functions/google_merchant_center/connection', { method: 'GET' });
  });

  it('POSTs JSON when given a body', async () => {
    const fetchFn = vi.fn(async () => json(200, {}));
    await callRoute(fetchFn as unknown as typeof fetch, 'connection', { op: 'connect' });
    expect(fetchFn).toHaveBeenCalledWith('/functions/google_merchant_center/connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"op":"connect"}',
    });
  });

  it('turns an error answer into a RouteError with the route’s message', async () => {
    const fetchFn = vi.fn(async () => json(400, { error: { code: 'key_required', message: 'Paste the key' } }));
    const error = await callRoute(fetchFn as unknown as typeof fetch, 'connection', {}).catch((e) => e);
    expect(error).toBeInstanceOf(RouteError);
    expect(error).toMatchObject({ message: 'Paste the key', code: 'key_required' });
  });
});
