import { vi } from 'vitest';
import { parseBatchRequest } from './batch-request';

type Json = any;
type Reply = { status: number; body: Json };

export interface FakeGoogleOptions {
  token?: Reply;
  register?: Reply;
  account?: Reply;
  homepage?: { uri?: string; claimed: boolean };
  /** Replaces the whole batch answer, e.g. a 429 */
  batch?: Reply;
  /** Per-offer answer for insert, patch and delete */
  offerErrors?: Record<string, Reply>;
  quota?: Json;
}

export const DEFAULT_QUOTA = {
  quotaGroups: [
    {
      name: 'accounts/123/quotas/products-insert',
      quotaUsage: '10',
      quotaLimit: '5000',
      quotaMinuteLimit: '300',
      methodDetails: [{ method: 'productinputs.insert', version: 'v1', subapi: 'products', path: 'products/v1/productInputs.insert' }],
    },
  ],
};

const notFound = (): Reply => ({ status: 404, body: { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } } });

const json = ({ status, body }: Reply) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function multipart(parts: (Reply & { id: string })[]): Response {
  const boundary = 'batch_fake';
  const text =
    parts
      .map((part) =>
        [
          `--${boundary}`,
          'Content-Type: application/http',
          `Content-ID: <response-${part.id}>`,
          '',
          `HTTP/1.1 ${part.status} ${part.status < 300 ? 'OK' : 'Error'}`,
          'Content-Type: application/json; charset=UTF-8',
          '',
          JSON.stringify(part.body),
        ].join('\r\n'),
      )
      .join('\r\n') + `\r\n--${boundary}--\r\n`;
  return new Response(text, { status: 200, headers: { 'Content-Type': `multipart/mixed; boundary=${boundary}` } });
}

/** An in-memory Merchant API: token, accounts, data sources, quotas, product inputs and batches. */
export function createFakeGoogle(options: FakeGoogleOptions = {}) {
  const requests: { method: string; path: string; body?: Json }[] = [];
  /** `${dataSource}|${language~label~offer}` → stored input */
  const inputs = new Map<string, Json>();
  const dataSources = new Set<string>();
  let dataSourceSeq = 0;
  let batches = 0;
  let tokens = 0;

  function handle(method: string, pathAndQuery: string, body: Json): Reply {
    requests.push({ method, path: pathAndQuery, body });
    const [path, search = ''] = pathAndQuery.split('?');
    const query = new URLSearchParams(search);
    let m: RegExpMatchArray | null;

    if ((m = path.match(/^\/accounts\/v1\/accounts\/(\d+)\/developerRegistration:registerGcp$/))) {
      return options.register ?? { status: 200, body: { name: `accounts/${m[1]}/developerRegistration` } };
    }
    if ((m = path.match(/^\/accounts\/v1\/accounts\/(\d+)\/homepage$/))) {
      return {
        status: 200,
        body: { name: `accounts/${m[1]}/homepage`, uri: options.homepage?.uri ?? 'https://shop.example.com', claimed: options.homepage?.claimed ?? true },
      };
    }
    if ((m = path.match(/^\/accounts\/v1\/accounts\/(\d+)$/))) {
      return options.account ?? { status: 200, body: { name: `accounts/${m[1]}`, accountName: 'Demo Shop' } };
    }
    if ((m = path.match(/^\/datasources\/v1\/accounts\/(\d+)\/dataSources$/)) && method === 'POST') {
      const name = `accounts/${m[1]}/dataSources/${++dataSourceSeq}`;
      dataSources.add(name);
      return { status: 200, body: { ...body, name } };
    }
    if ((m = path.match(/^\/datasources\/v1\/(accounts\/\d+\/dataSources\/\d+)$/)) && method === 'DELETE') {
      if (!dataSources.delete(m[1])) return notFound();
      for (const key of [...inputs.keys()]) if (key.startsWith(`${m[1]}|`)) inputs.delete(key);
      return { status: 200, body: {} };
    }
    if (path.match(/^\/quota\/v1\/accounts\/\d+\/quotas$/)) return { status: 200, body: options.quota ?? DEFAULT_QUOTA };
    if (path.match(/^\/products\/v1\/accounts\/\d+\/productInputs:insert$/) && method === 'POST') {
      const failure = options.offerErrors?.[body.offerId];
      if (failure) return failure;
      inputs.set(`${query.get('dataSource')}|${body.contentLanguage}~${body.feedLabel}~${body.offerId}`, body);
      return { status: 200, body };
    }
    if ((m = path.match(/^\/products\/v1\/accounts\/\d+\/productInputs\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]);
      const failure = options.offerErrors?.[id.split('~')[2]];
      if (failure) return failure;
      const key = `${query.get('dataSource')}|${id}`;
      if (method === 'DELETE') return inputs.delete(key) ? { status: 200, body: {} } : notFound();
      if (method === 'PATCH') {
        const current = inputs.get(key);
        if (!current) return notFound();
        const next = { ...current, productAttributes: { ...current.productAttributes } };
        for (const field of (query.get('updateMask') ?? '').split(',').map((f) => f.replace('productAttributes.', ''))) {
          if (body.productAttributes[field] === undefined) delete next.productAttributes[field];
          else next.productAttributes[field] = body.productAttributes[field];
        }
        inputs.set(key, next);
        return { status: 200, body: next };
      }
    }
    return notFound();
  }

  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const text = typeof init.body === 'string' ? init.body : '';
    if (url.href === 'https://oauth2.googleapis.com/token') {
      tokens++;
      const form: Record<string, string> = {};
      new URLSearchParams(text).forEach((value, key) => (form[key] = value));
      requests.push({ method, path: 'token', body: form });
      return json(options.token ?? { status: 200, body: { access_token: `token-${tokens}`, expires_in: 3600, token_type: 'Bearer' } });
    }
    if (url.pathname === '/batch/products/v1') {
      batches++;
      if (options.batch) return json(options.batch);
      const contentType = new Headers(init.headers).get('Content-Type') ?? '';
      return multipart(parseBatchRequest(contentType, text).map((part) => ({ id: part.id, ...handle(part.method, part.path, part.body) })));
    }
    return json(handle(method, url.pathname + url.search, text ? JSON.parse(text) : undefined));
  });

  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    requests,
    inputs,
    dataSources,
    batches: () => batches,
  };
}
