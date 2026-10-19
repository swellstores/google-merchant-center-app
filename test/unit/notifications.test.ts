/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import broken from '../../notifications/connection-broken.json';
import template from '../../notifications/connection-broken.tpl?raw';

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

  it('links to the apps in the admin, not the storefront', () => {
    // `store.admin_url` is the store's admin host; the admin itself lives under /admin.
    expect(template).toContain('href="{{ store.admin_url }}/admin/apps"');
    expect(template).not.toContain('store.url');
    expect(template).toContain('Open <strong>Apps &rarr; Google Merchant Center &rarr; Settings</strong> in your Swell dashboard.');
  });
});
