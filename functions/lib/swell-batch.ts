import type { SwellClient } from './context';

/** One request inside `POST /:batch`; `data` on a get is the query. */
export interface BatchOp {
  method: 'get' | 'post' | 'put' | 'delete';
  url: string;
  data?: object;
}

/** The message of a refused entry: `{ $error }` for a path or permission, `{ errors }` for a write that failed validation. */
export function entryError(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const { $error, errors } = entry as { $error?: unknown; errors?: Record<string, { code?: string; message?: string } | undefined> };
  if ($error) return typeof $error === 'string' ? $error : JSON.stringify($error);
  if (errors && typeof errors === 'object') {
    const [field, detail] = Object.entries(errors)[0] ?? [];
    if (field) return `${field}: ${detail?.message ?? detail?.code ?? 'invalid'}`;
  }
  return null;
}

/**
 * Sends several requests in one round trip. Answers come back in order, a
 * missing record as `null`. They run independently, so two writes to one
 * record never go into the same batch. A refused entry is logged; each caller
 * decides whether it matters.
 */
export async function swellBatch(swell: SwellClient, ops: BatchOp[]): Promise<unknown[]> {
  if (!ops.length) return [];
  const answers = await swell.post('/:batch', ops);
  if (!Array.isArray(answers)) throw new Error(`Swell refused the batch: ${JSON.stringify(answers)}`);
  answers.forEach((answer, i) => {
    const error = entryError(answer);
    if (error) console.error(`Swell batch ${ops[i].method.toUpperCase()} ${ops[i].url}: ${error}`);
  });
  return answers;
}

/** The records of a list answer. A refused read throws: nothing can be decided without it. */
export function listOf<T>(answer: unknown, what: string): T[] {
  const error = entryError(answer);
  if (error) throw new Error(`Swell refused to read ${what}: ${error}`);
  return (answer as { results?: T[] } | null)?.results ?? [];
}

export function countOf(answer: unknown): number {
  return (answer as { count?: number } | null)?.count ?? 0;
}

/** A record answer, `null` when it is missing. A refused read or write throws. */
export function recordOf<T>(answer: unknown, what: string): T | null {
  const error = entryError(answer);
  if (error) throw new Error(`Swell refused ${what}: ${error}`);
  return (answer as T | null) ?? null;
}

/** Writes that wait for the next round trip to Swell. */
export class Outbox {
  private ops: BatchOp[] = [];

  constructor(private readonly swell: SwellClient) {}

  add(...ops: BatchOp[]): void {
    this.ops.push(...ops);
  }

  get size(): number {
    return this.ops.length;
  }

  /** Sends the waiting writes and `reads` in one round trip; resolves with the answers to `reads`. */
  async send(reads: BatchOp[] = []): Promise<unknown[]> {
    const writes = this.ops;
    this.ops = [];
    const answers = await swellBatch(this.swell, [...writes, ...reads]);
    return answers.slice(writes.length);
  }
}
