import { vi } from 'vitest';

type Doc = Record<string, any>;

function valueAt(doc: Doc, path: string) {
  return path.split('.').reduce<any>((value, key) => (value == null ? undefined : value[key]), doc);
}

function matches(doc: Doc, where: Doc = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === '$or') return (cond as Doc[]).some((sub) => matches(doc, sub));
    if (key === '$and') return (cond as Doc[]).every((sub) => matches(doc, sub));
    const value = valueAt(doc, key);
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$in' in cond) return (cond.$in as unknown[]).includes(value);
      if ('$ne' in cond) return (value ?? null) !== (cond.$ne ?? null);
      if ('$gt' in cond) return value != null && String(value) > String(cond.$gt);
      if ('$lte' in cond) return value != null && String(value) <= String(cond.$lte);
      if ('$exists' in cond) return (value !== undefined && value !== null) === Boolean(cond.$exists);
    }
    return (value ?? null) === (cond ?? null);
  });
}

function applyPatch(doc: Doc, patch: Doc): Doc {
  for (const [key, value] of Object.entries(patch)) {
    if (key === '$app') {
      // Like the platform: $app writes merge per app.
      doc.$app ??= {};
      for (const [appId, fields] of Object.entries<Doc>(value)) doc.$app[appId] = { ...doc.$app[appId], ...fields };
      continue;
    }
    doc[key] = value && typeof value === 'object' && !Array.isArray(value) && '$set' in value ? value.$set : value;
  }
  return doc;
}

export interface FakeSwellInit {
  products?: Doc[];
  connection?: Doc;
  markets?: Doc[];
  details?: Doc;
}

/** In-memory Swell store with the app's collections, products and `/:details`. */
export function createFakeSwell(init: FakeSwellInit = {}) {
  let seq = 0;
  const record = (data: Doc): Doc => {
    seq++;
    return { id: seq.toString(16).padStart(24, '0'), date_created: new Date(Date.UTC(2026, 9, 15) + seq * 1000).toISOString(), ...data };
  };
  const collections: Record<string, Doc[]> = {
    '/connections': init.connection ? [record(init.connection)] : [],
    '/markets': (init.markets ?? []).map(record),
    '/queue-items': [],
    '/sync-states': [],
    '/alarms': [],
    '/products': (init.products ?? []).map((p) => structuredClone(p)),
  };
  const details = init.details ?? { id: 'test-store', name: 'Test store', locale: 'en-US', currency: 'USD' };
  const split = (url: string) => {
    const m = url.match(/^(\/[^/]+)(?:\/([^/]+))?$/);
    return m ? { name: m[1], id: m[2] } : null;
  };

  const swell = {
    get: vi.fn(async (url: string, query: Doc = {}) => {
      if (url === '/:details') return structuredClone(details);
      const parts = split(url);
      const list = parts && collections[parts.name];
      if (!list) throw new Error(`unexpected GET ${url}`);
      if (parts.id) {
        const doc = list.find((d) => d.id === parts.id);
        return doc ? structuredClone(doc) : null;
      }
      let docs = list.filter((d) => matches(d, query.where));
      // Code-unit order, the same order `$gt` compares in.
      const byField = (field: string) => (a: Doc, b: Doc) => (String(a[field]) < String(b[field]) ? -1 : String(a[field]) > String(b[field]) ? 1 : 0);
      if (query.sort === 'id asc') docs = [...docs].sort(byField('id'));
      if (query.sort === 'date_created asc') docs = [...docs].sort(byField('date_created'));
      return { count: docs.length, results: docs.slice(0, query.limit ?? 15).map((d) => structuredClone(d)) };
    }),
    post: vi.fn(async (url: string, data: Doc) => {
      const list = collections[url];
      if (!list) throw new Error(`unexpected POST ${url}`);
      const doc = applyPatch(record({}), data);
      list.push(doc);
      return structuredClone(doc);
    }),
    put: vi.fn(async (url: string, patch: Doc) => {
      const parts = split(url);
      const doc = parts?.id ? collections[parts.name]?.find((d) => d.id === parts.id) : undefined;
      if (!doc) throw new Error(`unexpected PUT ${url}`);
      return structuredClone(applyPatch(doc, patch));
    }),
    delete: vi.fn(async (url: string) => {
      const parts = split(url);
      const list = parts?.id ? collections[parts.name] : undefined;
      const index = list ? list.findIndex((d) => d.id === parts!.id) : -1;
      if (!list || index < 0) throw new Error(`unexpected DELETE ${url}`);
      return list.splice(index, 1)[0];
    }),
  };

  return { swell, collections, details };
}
