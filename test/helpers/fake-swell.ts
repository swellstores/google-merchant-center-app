import { vi } from 'vitest';

type Doc = Record<string, any>;
type Method = 'get' | 'post' | 'put' | 'delete';

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
      if ('$nin' in cond) return !(cond.$nin as unknown[]).includes(value);
      if ('$ne' in cond) return (value ?? null) !== (cond.$ne ?? null);
      if ('$gt' in cond) return value != null && String(value) > String(cond.$gt);
      if ('$lte' in cond) return value != null && String(value) <= String(cond.$lte);
      if ('$exists' in cond) return (value !== undefined && value !== null) === Boolean(cond.$exists);
    }
    return (value ?? null) === (cond ?? null);
  });
}

const isPlain = (value: unknown): value is Doc => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * One value of an update, merged the way the platform merges it: objects at
 * every depth, arrays by position (never shorter, so `[]` changes nothing).
 * `{ $set: v }` on a field replaces it, except inside `$app`, where that form
 * merges like a plain value. Arrays of records with ids (merged by id) are not
 * modelled: the app never writes them.
 */
function merge(stored: unknown, value: unknown, fieldSetReplaces: boolean): unknown {
  if (isPlain(value) && '$set' in value) {
    return fieldSetReplaces ? structuredClone(value.$set) : merge(stored, value.$set, fieldSetReplaces);
  }
  if (Array.isArray(value)) {
    const result = Array.isArray(stored) ? [...stored] : [];
    value.forEach((element, i) => (result[i] = merge(result[i], element, fieldSetReplaces)));
    return result;
  }
  if (isPlain(value)) {
    const result: Doc = isPlain(stored) ? { ...stored } : {};
    for (const [key, inner] of Object.entries(value)) result[key] = merge(result[key], inner, fieldSetReplaces);
    return result;
  }
  return value;
}

/** A PUT (or a create into an empty record). `$app.<id>.$set` replaces those app fields. */
function applyPatch(doc: Doc, patch: Doc): Doc {
  for (const [key, value] of Object.entries(patch)) {
    if (key === '$app') {
      doc.$app ??= {};
      for (const [appId, fields] of Object.entries<Doc>(value)) {
        const { $set: replace, ...rest } = fields;
        const merged = merge(doc.$app[appId], rest, false) as Doc;
        doc.$app[appId] = replace ? { ...merged, ...structuredClone(replace) } : merged;
      }
      continue;
    }
    if (key.startsWith('$')) throw new Error(`the fake store does not model ${key}`);
    doc[key] = merge(doc[key], value, true);
  }
  return doc;
}

/** An update operator such as `$set`, which the platform takes on updates only; `$app` is a namespace. */
function hasOperator(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasOperator);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, inner]) => (key.startsWith('$') && key !== '$app') || hasOperator(inner));
}

export interface FakeSwellInit {
  products?: Doc[];
  connection?: Doc;
  markets?: Doc[];
  details?: Doc;
}

/** Decides whether the store refuses a request: a message refuses it. */
export type Refusal = (method: Method, url: string) => string | null | undefined;

export interface FakeBatchOp {
  method: Method;
  url: string;
  data?: Doc;
}

/**
 * In-memory Swell store with the app's collections, products, `/:details` and
 * `POST /:batch`. A batch applies its operations in order without going through
 * the spied methods, so their calls are the round trips the code made.
 */
export function createFakeSwell(init: FakeSwellInit = {}) {
  let seq = 0;
  let refusal: Refusal | undefined;
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
  const refuse = (method: Method, url: string) => {
    const message = refusal?.(method, url);
    if (message) throw new Error(message);
  };

  const impl = {
    get: async (url: string, query: Doc = {}) => {
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
    },
    post: async (url: string, data: Doc) => {
      const list = collections[url];
      if (!list) throw new Error(`unexpected POST ${url}`);
      if (hasOperator(data)) throw new Error('operators are for updates');
      const doc = applyPatch(record({}), data);
      list.push(doc);
      return structuredClone(doc);
    },
    put: async (url: string, patch: Doc) => {
      const parts = split(url);
      const list = parts?.id ? collections[parts.name] : undefined;
      if (!list) throw new Error(`unexpected PUT ${url}`);
      let doc = list.find((d) => d.id === parts!.id);
      // Like the platform: a PUT to an id that does not exist creates the record.
      if (!doc) list.push((doc = { ...record({}), id: parts!.id }));
      return structuredClone(applyPatch(doc, patch));
    },
    delete: async (url: string) => {
      const parts = split(url);
      const list = parts?.id ? collections[parts.name] : undefined;
      const index = list ? list.findIndex((d) => d.id === parts!.id) : -1;
      if (!list || index < 0) throw new Error(`unexpected DELETE ${url}`);
      return list.splice(index, 1)[0];
    },
  };

  /** One batch entry, answered the way the platform answers it. */
  async function entry(op: FakeBatchOp): Promise<unknown> {
    const refused = refusal?.(op.method, op.url);
    if (refused) return { $error: refused };
    if (op.url === '/:details') return op.method === 'get' ? structuredClone(details) : { $error: `Cannot ${op.method} ${op.url}` };
    const parts = split(op.url);
    const list = parts && collections[parts.name];
    if (!list) return { $error: `Unknown path ${op.url}` };
    if (parts.id && op.method !== 'put' && !list.some((d) => d.id === parts.id)) return null;
    try {
      return await impl[op.method](op.url, op.data ?? {});
    } catch (error) {
      return { $error: (error as Error).message };
    }
  }

  const swell = {
    get: vi.fn(async (url: string, query: Doc = {}) => {
      refuse('get', url);
      return impl.get(url, query);
    }),
    post: vi.fn(async (url: string, data: any): Promise<any> => {
      if (url === '/:batch') {
        const answers: unknown[] = [];
        for (const op of data as FakeBatchOp[]) answers.push(await entry(op));
        return answers;
      }
      refuse('post', url);
      return impl.post(url, data);
    }),
    put: vi.fn(async (url: string, patch: Doc) => {
      refuse('put', url);
      return impl.put(url, patch);
    }),
    delete: vi.fn(async (url: string) => {
      refuse('delete', url);
      return impl.delete(url);
    }),
  };

  return {
    swell,
    collections,
    details,
    /** Makes the store refuse requests, directly (a throw) and inside a batch (`{ $error }`). */
    refuse: (rule: Refusal) => {
      refusal = rule;
    },
  };
}

type FakeSwell = ReturnType<typeof createFakeSwell>['swell'];

/** The operations of every batch the code sent, in order. */
export function batchesOf(swell: FakeSwell): FakeBatchOp[][] {
  return swell.post.mock.calls.filter(([url]) => url === '/:batch').map(([, ops]) => ops as FakeBatchOp[]);
}

/** The requests the code made itself, a batch counting as one. */
export function roundTrips(swell: FakeSwell): number {
  return swell.get.mock.calls.length + swell.post.mock.calls.length + swell.put.mock.calls.length + swell.delete.mock.calls.length;
}
