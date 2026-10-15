export interface BatchRequestPart {
  id: string;
  method: string;
  path: string;
  body?: any;
}

function cut(text: string, separator: string): [string, string] {
  const i = text.indexOf(separator);
  return i < 0 ? [text, ''] : [text.slice(0, i), text.slice(i + separator.length)];
}

/** Reads a batch request the app built, the way Google would. */
export function parseBatchRequest(contentType: string, text: string): BatchRequestPart[] {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) throw new Error(`no boundary in ${contentType}`);
  return text
    .split(`--${boundary}`)
    .map((part) => part.replace(/^\r\n/, ''))
    .filter((part) => part.trim() && !part.startsWith('--'))
    .map((part) => {
      const [outer, request] = cut(part, '\r\n\r\n');
      const id = /Content-ID: <([^>]+)>/i.exec(outer)?.[1] ?? '';
      const [head, body] = cut(request, '\r\n\r\n');
      const [method, path] = head.split('\r\n')[0].split(' ');
      const trimmed = body.trim();
      return { id, method, path, body: trimmed ? JSON.parse(trimmed) : undefined };
    });
}
