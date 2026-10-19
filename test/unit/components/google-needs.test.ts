import { describe, expect, it } from 'vitest';
import { MISSING_OPTION, choose, needHint, needNote, needRows, type NeedRow } from '../../../components/lib/google-needs';

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
const NO_VARIANT_OPTIONS = [OPTIONS[1]];
const VARIANT_OPTIONS = [
  { id: 'o1', name: 'Shade' },
  { id: 'o3', name: 'Length' },
];
const rowOf = (rows: NeedRow[], attribute: string) => rows.find((row) => row.attribute === attribute);

describe('needRows', () => {
  it('gives a product with variant options all four option rows, with no notes', () => {
    const rows = needRows(record([], OPTIONS), null, APP);
    expect(rows.map((r) => [r.attribute, r.label, r.kind, r.asked])).toEqual([
      ['color', 'Color', 'option', false],
      ['size', 'Size', 'option', false],
      ['material', 'Material', 'option', false],
      ['pattern', 'Pattern', 'option', false],
    ]);
    expect(rows.map(needNote)).toEqual([null, null, null, null]);
  });

  it('keeps the row when its choice is "Not sent"', () => {
    const rows = needRows(record([], OPTIONS), { size: null }, APP);
    expect(rowOf(rows, 'size')).toMatchObject({ kind: 'option', chosen: null, missing: false });
    expect(rows).toHaveLength(4);
  });

  it('makes an option row offering the variant options only', () => {
    expect(rowOf(needRows(record(['color'], OPTIONS), null, APP), 'color')).toEqual({
      attribute: 'color',
      label: 'Color',
      kind: 'option',
      options: VARIANT_OPTIONS,
      chosen: null,
      missing: false,
      asked: true,
    });
  });

  it('is empty without variant options, an asked attribute or a choice', () => {
    expect(needRows(record([], NO_VARIANT_OPTIONS), null, APP)).toEqual([]);
    expect(needRows(record([]), { color: null }, APP)).toEqual([]);
    expect(needRows({}, null, APP)).toEqual([]);
  });

  it('makes a field row for an asked age group or gender only', () => {
    const rows = needRows(record(['gender', 'age_group'], NO_VARIANT_OPTIONS), null, APP);
    expect(rows.map((r) => [r.attribute, r.label, r.kind, r.asked])).toEqual([
      ['age_group', 'Age group', 'field', true],
      ['gender', 'Gender', 'field', true],
    ]);
    expect(needRows(record(['age_group'], OPTIONS), null, APP).filter((r) => r.kind === 'field').map((r) => r.attribute)).toEqual(['age_group']);
    expect(needRows(record([], OPTIONS), { gender: 'o1' } as any, APP).some((r) => r.kind === 'field')).toBe(false);
  });

  it('never marks a field row missing', () => {
    const rows = needRows(record(['gender'], OPTIONS), { gender: 'o9' } as any, APP);
    expect(rowOf(rows, 'gender')).toMatchObject({ kind: 'field', missing: false });
  });

  it('asks to create an option when Google asks and the product has no variant option', () => {
    expect(needRows(record(['size'], NO_VARIANT_OPTIONS), null, APP)).toEqual([
      { attribute: 'size', label: 'Size', kind: 'create', options: [], chosen: null, missing: false, asked: true },
    ]);
    expect(needRows(record(['size']), null, APP)[0]).toMatchObject({ kind: 'create' });
  });

  it('keeps a choice without variant options as a missing option row to clear', () => {
    const rows = needRows(record([], NO_VARIANT_OPTIONS), { size: 'o1' }, APP);
    expect(rows).toEqual([{ attribute: 'size', label: 'Size', kind: 'option', options: [], chosen: 'o1', missing: true, asked: false }]);
    expect(needRows(record(['size']), { size: 'o1' }, APP)[0]).toMatchObject({ kind: 'option', missing: true, asked: true });
  });

  it('keeps a chosen attribute that Google no longer asks for', () => {
    expect(rowOf(needRows(record([], OPTIONS), { pattern: 'o3' }, APP), 'pattern')).toMatchObject({
      kind: 'option',
      chosen: 'o3',
      missing: false,
      asked: false,
    });
  });

  it('flags a chosen option that is gone or not a variant option', () => {
    expect(rowOf(needRows(record(['color'], OPTIONS), { color: 'gone' }, APP), 'color')).toMatchObject({ chosen: 'gone', missing: true });
    expect(rowOf(needRows(record(['color'], OPTIONS), { color: 'o2' }, APP), 'color')).toMatchObject({ missing: true });
  });
});

describe('needNote', () => {
  const sizeRow = (attributes: string[], value: Record<string, string | null> | null, options: unknown[] = OPTIONS) =>
    rowOf(needRows(record(attributes, options), value, APP), 'size')!;

  it('warns while Google asks for an attribute that is not chosen', () => {
    expect(needNote(sizeRow(['size'], null))).toEqual({ text: 'Google asks for this.', tone: 'warn' });
    expect(needNote(sizeRow(['size'], { size: null }))).toEqual({ text: 'Google asks for this.', tone: 'warn' });
  });

  it('says Google rechecks an asked attribute once it is chosen', () => {
    expect(needNote(sizeRow(['size'], { size: 'o3' }))).toEqual({ text: 'Google rechecks this after the next sync.', tone: 'muted' });
  });

  it('flags a missing option first', () => {
    expect(needNote(sizeRow([], { size: 'o1' }, NO_VARIANT_OPTIONS))).toEqual({ text: MISSING_OPTION, tone: 'bad' });
    expect(needNote(sizeRow(['size'], { size: 'gone' }))).toEqual({ text: MISSING_OPTION, tone: 'bad' });
  });

  it('gives an unasked option row, a create row and a field row no note', () => {
    expect(needNote(sizeRow([], { size: 'o3' }))).toBeNull();
    expect(needNote(sizeRow(['size'], null, NO_VARIANT_OPTIONS))).toBeNull();
    expect(needNote(needRows(record(['age_group']), null, APP)[0])).toBeNull();
  });
});

describe('needHint', () => {
  it('points a field row to its field below the block', () => {
    const [ageGroup, gender] = needRows(record(['gender', 'age_group']), null, APP);
    expect(needHint(ageGroup)).toBe('Set “Age group” below.');
    expect(needHint(gender)).toBe('Set “Gender” below.');
  });

  it('asks to create an option, and gives an option row no hint', () => {
    expect(needHint(needRows(record(['size']), null, APP)[0])).toBe('Create a variant option for the size on the Options tab, then pick it here.');
    expect(needHint(rowOf(needRows(record(['size'], OPTIONS), null, APP), 'size')!)).toBeNull();
  });

  it('a chosen option that is gone or makes no variants reads as either', () => {
    expect(MISSING_OPTION).toBe('The chosen option no longer exists or no longer makes variants.');
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
