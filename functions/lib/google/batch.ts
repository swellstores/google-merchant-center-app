import {
  classifyGoogleError,
  errorMessage,
  GoogleApiError,
  MERCHANT_API,
  pathWithQuery,
  safeJson,
  type GoogleCall,
} from './http';

export const MAX_BATCH_PARTS = 100;

export interface BatchPart {
  id: string;
  call: GoogleCall;
}

export interface BatchResult {
  id: string;
  status: number;
  body: unknown;
}

export function buildBatch(parts: BatchPart[], boundary: string): string {
  const chunks = parts.map(({ id, call }) => {
    const lines = [`--${boundary}`, 'Content-Type: application/http', `Content-ID: <${id}>`, '', `${call.method} ${pathWithQuery(call)} HTTP/1.1`];
    if (call.body !== undefined) lines.push('Content-Type: application/json; charset=UTF-8', '', JSON.stringify(call.body));
    else lines.push('');
    return lines.join('\r\n');
  });
  return `${chunks.join('\r\n')}\r\n--${boundary}--\r\n`;
}

function splitOnce(text: string, separator: RegExp): [string, string] {
  const match = separator.exec(text);
  if (!match) return [text, ''];
  return [text.slice(0, match.index), text.slice(match.index + match[0].length)];
}

export function parseBatch(contentType: string, text: string): BatchResult[] {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (!boundary) throw new GoogleApiError('server', 0, 'The batch response has no boundary');
  const results: BatchResult[] = [];
  for (const raw of text.split(`--${boundary}`)) {
    const part = raw.replace(/^\r?\n/, '');
    if (!part.trim() || part.startsWith('--')) continue;
    const [outer, inner] = splitOnce(part, /\r?\n\r?\n/);
    const id = /content-id:\s*<?(?:response-)?([^>\r\n]+)>?/i.exec(outer)?.[1]?.trim();
    if (!id) continue;
    const [head, body] = splitOnce(inner, /\r?\n\r?\n/);
    const status = Number(/HTTP\/[\d.]+\s+(\d{3})/.exec(head)?.[1] ?? 0);
    const bodyText = body.trim();
    results.push({ id, status, body: bodyText ? safeJson(bodyText) : {} });
  }
  return results;
}

/** Sends up to 100 Products sub-API calls in one HTTP batch. Each part keeps its own status. */
export async function sendBatch(fetchFn: typeof fetch, token: string, parts: BatchPart[]): Promise<BatchResult[]> {
  if (parts.length > MAX_BATCH_PARTS) throw new Error(`A batch takes at most ${MAX_BATCH_PARTS} parts`);
  const boundary = `batch_${crypto.randomUUID()}`;
  let res: Response;
  try {
    res = await fetchFn(`${MERCHANT_API}/batch/products/v1`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/mixed; boundary=${boundary}` },
      body: buildBatch(parts, boundary),
    });
  } catch (error) {
    throw new GoogleApiError('server', 0, `Google could not be reached: ${String(error)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const body = safeJson(text);
    throw new GoogleApiError(classifyGoogleError(res.status, body), res.status, errorMessage(body, res.status), body);
  }
  return parseBatch(res.headers.get('Content-Type') ?? '', text);
}
