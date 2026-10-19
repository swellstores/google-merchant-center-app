import { describe, expect, it } from 'vitest';
import broken from '../../notifications/connection-broken.json';

describe('connection-broken notification', () => {
  it('fires on the update that makes the connection broken', () => {
    // A bare field is the record after the write, `$record` the record before it.
    expect(broken.conditions).toEqual({ status: 'broken', $record: { status: { $ne: 'broken' } } });
    expect(broken.event).toBe('updated');
  });

  it('emails the store admins every time it breaks', () => {
    expect(broken.repeat).toBe(true);
    expect(broken.admin).toBe(true);
  });
});
