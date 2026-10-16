import { afterEach, describe, expect, it, vi } from 'vitest';
import { entryError, listOf, Outbox, recordOf, swellBatch } from '../../functions/lib/swell-batch';
import { createFakeSwell } from '../helpers/fake-swell';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('swellBatch', () => {
  it('sends every operation in one request and answers in order', async () => {
    const { swell, collections } = createFakeSwell({ markets: [{ country: 'US' }] });
    const answers = await swellBatch(swell, [
      { method: 'post', url: '/alarms', data: { wake_at: null } },
      { method: 'get', url: '/markets', data: { limit: 10 } },
      { method: 'get', url: '/alarms/missing' },
    ]);
    expect(swell.post).toHaveBeenCalledTimes(1);
    expect(swell.post).toHaveBeenCalledWith('/:batch', expect.any(Array));
    expect(answers[0]).toMatchObject({ id: expect.any(String), wake_at: null });
    expect(answers[1]).toMatchObject({ count: 1, results: [expect.objectContaining({ country: 'US' })] });
    expect(answers[2]).toBeNull();
    expect(collections['/alarms']).toHaveLength(1);
  });

  it('sends nothing for no operations', async () => {
    const { swell } = createFakeSwell();
    expect(await swellBatch(swell, [])).toEqual([]);
    expect(swell.post).not.toHaveBeenCalled();
  });

  it('reports a refused entry loudly and keeps the others', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { swell } = createFakeSwell();
    const answers = await swellBatch(swell, [
      { method: 'get', url: '/nowhere' },
      { method: 'post', url: '/alarms', data: { wake_at: null } },
    ]);
    expect(entryError(answers[0])).toEqual(expect.any(String));
    expect(answers[1]).toMatchObject({ wake_at: null });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('GET /nowhere'));
  });

  it('refuses an answer that is not a list', async () => {
    const { swell } = createFakeSwell();
    swell.post.mockResolvedValueOnce({ error: 'Permission denied' });
    await expect(swellBatch(swell, [{ method: 'get', url: '/alarms' }])).rejects.toThrow('Permission denied');
  });
});

describe('the fake store', () => {
  it('refuses a create with an update operator, like the platform', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { swell } = createFakeSwell();
    const [answer] = await swellBatch(swell, [{ method: 'post', url: '/sync-states', data: { full_sync: { $set: {} } } }]);
    expect(entryError(answer)).toBe('operators are for updates');
    await expect(swell.post('/sync-states', { quota: { $set: {} } })).rejects.toThrow('operators are for updates');
  });

  it('merges a plain update like the platform: objects at every depth, arrays by position', async () => {
    const { swell, collections } = createFakeSwell({ products: [{ id: 'p1', tags: ['new', 'summer', 'x'], dims: { w: 1, h: 2 }, $app: { gmc: { input_ids: ['a', 'b'], sync_state: 'sent' } } }] });
    await swell.put('/products/p1', { tags: ['sale'], dims: { w: 3 } });
    await swell.put('/products/p1', { tags: [] });
    expect(collections['/products'][0]).toMatchObject({ tags: ['sale', 'summer', 'x'], dims: { w: 3, h: 2 } });
    await swell.put('/products/p1', { tags: { $set: ['only'] } });
    expect(collections['/products'][0].tags).toEqual(['only']);
  });

  it('replaces app fields only with $set inside the app’s object', async () => {
    const { swell, collections } = createFakeSwell({ products: [{ id: 'p1', $app: { gmc: { input_ids: ['a', 'b'], sync_state: 'sent' } } }] });
    await swell.put('/products/p1', { $app: { gmc: { input_ids: { $set: [] } } } });
    expect(collections['/products'][0].$app.gmc.input_ids).toEqual(['a', 'b']);
    await swell.put('/products/p1', { $app: { gmc: { input_ids: ['c'] } } });
    expect(collections['/products'][0].$app.gmc.input_ids).toEqual(['c', 'b']);
    await swell.put('/products/p1', { $app: { gmc: { sync_state: 'skipped', $set: { input_ids: [] } } } });
    expect(collections['/products'][0].$app.gmc).toEqual({ input_ids: [], sync_state: 'skipped' });
  });

  it('creates a record on a PUT to an id that does not exist', async () => {
    const { swell, collections } = createFakeSwell();
    await swellBatch(swell, [{ method: 'put', url: '/alarms/a1', data: { wake_at: null } }]);
    await swell.put('/alarms/a2', { wake_at: null });
    expect(collections['/alarms'].map((alarm) => alarm.id)).toEqual(['a1', 'a2']);
  });
});

describe('entryError', () => {
  it('reads both shapes of a refused entry', () => {
    expect(entryError({ $error: 'Not permitted' })).toBe('Not permitted');
    expect(entryError({ errors: { wake_at: { code: 'INVALID', message: 'Invalid date' } } })).toBe('wake_at: Invalid date');
  });

  it('finds nothing wrong with a record, a list or a missing record', () => {
    expect(entryError({ id: 'a' })).toBeNull();
    expect(entryError({ count: 0, results: [] })).toBeNull();
    expect(entryError(null)).toBeNull();
  });
});

describe('listOf and recordOf', () => {
  it('unwrap an answer', () => {
    expect(listOf({ count: 1, results: [{ id: 'a' }] }, 'alarms')).toEqual([{ id: 'a' }]);
    expect(listOf(null, 'alarms')).toEqual([]);
    expect(recordOf({ id: 'a' }, 'the alarm')).toEqual({ id: 'a' });
    expect(recordOf(null, 'the alarm')).toBeNull();
  });

  it('throw on a refused read, since nothing can be decided without it', () => {
    expect(() => listOf({ $error: 'Not permitted' }, 'the queue')).toThrow('the queue: Not permitted');
    expect(() => recordOf({ $error: 'Not permitted' }, 'the state')).toThrow('the state: Not permitted');
  });
});

describe('Outbox', () => {
  it('sends the waiting writes with the reads in one request and answers the reads', async () => {
    const { swell, collections } = createFakeSwell();
    const outbox = new Outbox(swell);
    outbox.add({ method: 'post', url: '/alarms', data: { wake_at: null } });
    expect(outbox.size).toBe(1);
    const [alarms] = await outbox.send([{ method: 'get', url: '/alarms' }]);
    expect(swell.post).toHaveBeenCalledTimes(1);
    expect(collections['/alarms']).toHaveLength(1);
    expect(alarms).toMatchObject({ count: 1 });
    expect(outbox.size).toBe(0);
  });

  it('sends nothing when nothing waits', async () => {
    const { swell } = createFakeSwell();
    expect(await new Outbox(swell).send()).toEqual([]);
    expect(swell.post).not.toHaveBeenCalled();
  });

  it('joins a waiting put into a put it sends to the same record, which answers for both', async () => {
    const { swell } = createFakeSwell();
    const outbox = new Outbox(swell);
    outbox.add({ method: 'put', url: '/sync-states/s1', data: { a: 1, b: 1 } }, { method: 'post', url: '/alarms', data: { wake_at: null } });
    const [state] = await outbox.send([{ method: 'put', url: '/sync-states/s1', data: { b: 2 } }]);
    expect(swell.post.mock.calls[0][1]).toEqual([
      { method: 'post', url: '/alarms', data: { wake_at: null } },
      { method: 'put', url: '/sync-states/s1', data: { a: 1, b: 2 } },
    ]);
    expect(state).toMatchObject({ id: 's1', a: 1, b: 2 });
    expect(outbox.size).toBe(0);
  });
});
