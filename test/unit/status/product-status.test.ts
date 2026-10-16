import { describe, expect, it } from 'vitest';
import {
  earliestExpiry,
  offerStatus,
  pendingStatus,
  productStatus,
  skippedStatus,
  statusFields,
  type GoogleProductStatus,
  type OfferAnswer,
} from '../../../functions/lib/status/product-status';

const found = (inputId: string, status: GoogleProductStatus = {}): OfferAnswer => ({ inputId, found: true, status });
const approved = (inputId: string): OfferAnswer =>
  found(inputId, { destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', approvedCountries: ['US'] }] });
const disapproved = (inputId: string, issues: GoogleProductStatus['itemLevelIssues'] = []): OfferAnswer =>
  found(inputId, { destinationStatuses: [{ disapprovedCountries: ['US'] }], itemLevelIssues: issues });

describe('offerStatus', () => {
  it('an offer approved in its country is approved', () => {
    expect(offerStatus(approved('a'))).toBe('approved');
  });

  it('approved somewhere and disapproved elsewhere is partial', () => {
    const answer = found('a', { destinationStatuses: [{ approvedCountries: ['US'] }, { disapprovedCountries: ['DE'] }] });
    expect(offerStatus(answer)).toBe('partial');
  });

  it('only pending countries is pending', () => {
    expect(offerStatus(found('a', { destinationStatuses: [{ pendingCountries: ['US'] }] }))).toBe('pending');
  });

  it('no destination statuses is pending', () => {
    expect(offerStatus(found('a', {}))).toBe('pending');
    expect(offerStatus({ inputId: 'a', found: false })).toBe('pending');
  });

  it('disapproved without approved is disapproved', () => {
    expect(offerStatus(disapproved('a'))).toBe('disapproved');
  });
});

describe('productStatus', () => {
  it('a product is its worst offer and says how many', () => {
    const result = productStatus([approved('a'), approved('b'), disapproved('c')]);
    expect(result).toMatchObject({ status: 'disapproved', label: 'Disapproved (1 of 3)' });
  });

  it('has a plain label when every offer shares the status', () => {
    expect(productStatus([approved('a'), approved('b')])).toMatchObject({ status: 'approved', label: 'Approved' });
  });

  it('mixes found and missing offers', () => {
    const result = productStatus([approved('a'), { inputId: 'b', found: false }]);
    expect(result.status).toBe('pending');
    expect(result.issues).toEqual([
      {
        code: 'missing_in_google',
        severity: 'info',
        description: 'Google has not processed this offer yet, or it was removed in Merchant Center',
        offers: ['b'],
        countries: [],
      },
    ]);
  });

  it('groups issues by code across offers with their countries', () => {
    const issue = (countries: string[], severity = 'DISAPPROVED') => [
      { code: 'missing_image', severity, description: 'Image missing', detail: 'd', documentation: 'https://x', applicableCountries: countries },
    ];
    const result = productStatus([disapproved('a', issue(['US', 'DE'], 'DEMOTED')), disapproved('b', issue(['FR', 'US']))]);
    expect(result.issues).toEqual([
      {
        code: 'missing_image',
        severity: 'disapproved',
        description: 'Image missing',
        detail: 'd',
        documentation: 'https://x',
        offers: ['a', 'b'],
        countries: ['DE', 'FR', 'US'],
      },
    ]);
  });

  it('treats unknown severities as info', () => {
    const result = productStatus([found('a', { itemLevelIssues: [{ code: 'x', severity: 'WARNING', description: 'X' }] })]);
    expect(result.issues[0].severity).toBe('info');
  });

  it('sorts issues by severity and keeps ten', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ code: `info_${i}`, severity: 'NOT_IMPACTED', description: 'i' }));
    const answers = [
      found('a', { itemLevelIssues: [...many, { code: 'demoted', severity: 'DEMOTED', description: 'd' }] }),
      found('b', { itemLevelIssues: [{ code: 'bad', severity: 'DISAPPROVED', description: 'b' }, { code: 'info_3', severity: 'X' }] }),
    ];
    const { issues } = productStatus(answers);
    expect(issues).toHaveLength(10);
    expect(issues.map((i) => i.code).slice(0, 3)).toEqual(['bad', 'demoted', 'info_3']);
  });

  it('caps the offers of an issue at twenty', () => {
    const answers = Array.from({ length: 25 }, (_, i) => disapproved(`o${i}`, [{ code: 'c', severity: 'DISAPPROVED', description: 'c' }]));
    expect(productStatus(answers).issues[0].offers).toHaveLength(20);
  });

  it('the hash ignores offer order and changes when an issue appears', () => {
    const issue = [{ code: 'c', severity: 'DISAPPROVED', description: 'c', applicableCountries: ['US'] }];
    const one = productStatus([disapproved('a', issue), disapproved('b', issue)]);
    const two = productStatus([disapproved('b', issue), disapproved('a', issue)]);
    const other = productStatus([disapproved('a'), disapproved('b')]);
    expect(one.hash).toBe(two.hash);
    expect(one.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(other.hash).not.toBe(one.hash);
  });
});

describe('skippedStatus and pendingStatus', () => {
  it('skip reasons map to not_sent and excluded labels', () => {
    expect(skippedStatus('excluded')).toMatchObject({ status: 'excluded', label: 'Hidden from Google', issues: [] });
    expect(skippedStatus('inactive')).toMatchObject({ status: 'not_sent', label: 'Not sent: inactive' });
    expect(skippedStatus('subscription_only').label).toBe('Not sent: subscription only');
    expect(skippedStatus('not_physical').label).toBe('Not sent: gift card');
    expect(skippedStatus('no_price').label).toBe('Not sent: no price');
    expect(skippedStatus('no_image').label).toBe('Not sent: no image');
  });

  it('a product just sent is pending', () => {
    expect(pendingStatus()).toMatchObject({ status: 'pending', label: 'Pending', issues: [] });
  });
});

describe('earliestExpiry', () => {
  it('picks the soonest googleExpirationDate', () => {
    const at = (date?: string) => found('x', { googleExpirationDate: date });
    expect(earliestExpiry([at('2026-11-20T00:00:00Z'), at('2026-11-01T00:00:00Z'), at(), { inputId: 'n', found: false }])).toBe(
      Date.parse('2026-11-01T00:00:00Z'),
    );
    expect(earliestExpiry([at()])).toBeNull();
  });
});

describe('statusFields', () => {
  it('replaces the issue list inside the app object', () => {
    const status = productStatus([disapproved('a', [{ code: 'c', severity: 'DISAPPROVED', description: 'c' }])]);
    expect(statusFields(status, Date.parse('2026-10-16T10:00:00Z'))).toEqual({
      status: 'disapproved',
      status_label: 'Disapproved',
      status_hash: status.hash,
      date_status: '2026-10-16T10:00:00.000Z',
      $set: { status_issues: status.issues },
    });
  });
});
