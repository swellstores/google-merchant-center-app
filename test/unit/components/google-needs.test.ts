import { describe, expect, it } from 'vitest';
import { choose, needRows } from '../../../components/lib/google-needs';

const APP = 'google_merchant_center';
const issue = (attribute: string) => ({ code: 'c', severity: 'demoted', description: 'd', attribute, offers: [], countries: [] });
const record = (attributes: string[], options?: unknown[]) => ({
  options,
  $app: { [APP]: { status_issues: attributes.map(issue) } },
});
const OPTIONS = [
  { id: 'o1', name: 'Shade', variant: true, values: [] },
  { id: 'o2', name: 'Engraving', variant: false, values: [] },
  { id: 'o3', name: 'Length', variant: true, values: [] },
];

describe('needRows', () => {
  it('is empty when nothing is needed and nothing is chosen', () => {
    expect(needRows(record([], OPTIONS), null, APP)).toEqual([]);
    expect(needRows(record([], OPTIONS), { color: null }, APP)).toEqual([]);
    expect(needRows({}, null, APP)).toEqual([]);
  });

  it('makes an option row offering the variant options only', () => {
    expect(needRows(record(['color'], OPTIONS), null, APP)).toEqual([
      {
        attribute: 'color',
        label: 'Color',
        kind: 'option',
        options: [
          { id: 'o1', name: 'Shade' },
          { id: 'o3', name: 'Length' },
        ],
        chosen: null,
        missing: false,
      },
    ]);
  });

  it('makes a field row for age group and gender', () => {
    const rows = needRows(record(['gender', 'age_group'], OPTIONS), null, APP);
    expect(rows.map((r) => [r.attribute, r.label, r.kind])).toEqual([
      ['age_group', 'Age group', 'field'],
      ['gender', 'Gender', 'field'],
    ]);
  });

  it('asks to create an option when the product has no variant option', () => {
    expect(needRows(record(['size'], [OPTIONS[1]]), null, APP)[0]).toMatchObject({ kind: 'create', options: [], chosen: null });
    expect(needRows(record(['size']), null, APP)[0]).toMatchObject({ kind: 'create' });
  });

  it('keeps a chosen attribute that Google no longer asks for', () => {
    const rows = needRows(record([], OPTIONS), { pattern: 'o3' }, APP);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attribute: 'pattern', kind: 'option', chosen: 'o3', missing: false });
  });

  it('flags a chosen option that is gone or not a variant option', () => {
    expect(needRows(record(['color'], OPTIONS), { color: 'gone' }, APP)[0]).toMatchObject({ chosen: 'gone', missing: true });
    expect(needRows(record(['color'], OPTIONS), { color: 'o2' }, APP)[0]).toMatchObject({ missing: true });
    expect(needRows(record(['color']), { color: 'o1' }, APP)[0]).toMatchObject({ kind: 'option', missing: true });
  });
});

describe('choose', () => {
  it('writes the option id, keeping the others', () => {
    expect(choose({ size: 'o3' }, 'color', 'o1')).toEqual({ size: 'o3', color: 'o1' });
  });

  it('writes null for "Not sent" and keeps the key', () => {
    const next = choose({ color: 'o1' }, 'color', null);
    expect(next).toEqual({ color: null });
    expect('color' in next).toBe(true);
  });

  it('starts from nothing', () => {
    expect(choose(null, 'material', 'o1')).toEqual({ material: 'o1' });
  });
});
