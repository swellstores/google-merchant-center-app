import { describe, expect, it, vi } from 'vitest';
import { buildBatch, parseBatch, sendBatch } from '../../../functions/lib/google/batch';

const insert = {
  id: 'op1',
  call: {
    method: 'POST' as const,
    path: '/products/v1/accounts/1/productInputs:insert',
    query: { dataSource: 'accounts/1/dataSources/2' },
    body: { offerId: 'a' },
  },
};
const remove = {
  id: 'op2',
  call: {
    method: 'DELETE' as const,
    path: '/products/v1/accounts/1/productInputs/en~US~a',
    query: { dataSource: 'accounts/1/dataSources/2' },
  },
};

describe('buildBatch', () => {
  it('writes one application/http part per call', () => {
    expect(buildBatch([insert, remove], 'b')).toBe(
      [
        '--b',
        'Content-Type: application/http',
        'Content-ID: <op1>',
        '',
        'POST /products/v1/accounts/1/productInputs:insert?dataSource=accounts%2F1%2FdataSources%2F2 HTTP/1.1',
        'Content-Type: application/json; charset=UTF-8',
        '',
        '{"offerId":"a"}',
        '--b',
        'Content-Type: application/http',
        'Content-ID: <op2>',
        '',
        'DELETE /products/v1/accounts/1/productInputs/en~US~a?dataSource=accounts%2F1%2FdataSources%2F2 HTTP/1.1',
        '',
        '--b--',
        '',
      ].join('\r\n'),
    );
  });
});

const RESPONSE = [
  '--batch_abc',
  'Content-Type: application/http',
  'Content-ID: <response-op1>',
  '',
  'HTTP/1.1 200 OK',
  'Content-Type: application/json; charset=UTF-8',
  '',
  '{"offerId":"a"}',
  '--batch_abc',
  'Content-Type: application/http',
  'Content-ID: <response-op2>',
  '',
  'HTTP/1.1 400 Bad Request',
  'Content-Type: application/json; charset=UTF-8',
  '',
  '{"error":{"code":400,"message":"Invalid value at availability"}}',
  '--batch_abc--',
  '',
].join('\r\n');

describe('parseBatch', () => {
  it('returns each part’s id, status and body', () => {
    expect(parseBatch('multipart/mixed; boundary=batch_abc', RESPONSE)).toEqual([
      { id: 'op1', status: 200, body: { offerId: 'a' } },
      { id: 'op2', status: 400, body: { error: { code: 400, message: 'Invalid value at availability' } } },
    ]);
  });

  it('accepts a quoted boundary and bare newlines', () => {
    const text = RESPONSE.replace(/\r\n/g, '\n');
    expect(parseBatch('multipart/mixed; boundary="batch_abc"', text)).toHaveLength(2);
  });
});

describe('sendBatch', () => {
  it('posts the parts to the products batch endpoint and parses the answer', async () => {
    const fetchFn = vi.fn(
      async () => new Response(RESPONSE, { status: 200, headers: { 'Content-Type': 'multipart/mixed; boundary=batch_abc' } }),
    );
    const results = await sendBatch(fetchFn as unknown as typeof fetch, 'tok', [insert, remove]);
    expect(results.map((r) => r.status)).toEqual([200, 400]);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://merchantapi.googleapis.com/batch/products/v1');
    expect(new Headers(init.headers).get('Content-Type')).toMatch(/^multipart\/mixed; boundary=batch_/);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok');
  });

  it('throws a classified error when the whole batch fails', async () => {
    const fetchFn = vi.fn(async () => new Response('{"error":{"message":"quota/request_rate_too_high"}}', { status: 429 }));
    const error = await sendBatch(fetchFn as unknown as typeof fetch, 'tok', [insert]).catch((e) => e);
    expect(error).toMatchObject({ kind: 'rate', status: 429 });
  });

  it('refuses more than 100 parts', async () => {
    const parts = Array.from({ length: 101 }, (_, i) => ({ ...insert, id: `op${i}` }));
    await expect(sendBatch(vi.fn() as unknown as typeof fetch, 'tok', parts)).rejects.toThrow('at most 100');
  });
});
