import { describe, expect, it } from 'vitest';
import { listAccountIssues, listPrograms } from '../../../functions/lib/google/merchant';
import { MAX_REASONS, accountReasons } from '../../../functions/lib/status/account';

const DOC = 'https://support.google.com/merchants/answer/14286818';

const programs = {
  programs: [
    {
      name: 'accounts/401005146/programs/free-listings',
      state: 'ENABLED',
      unmetRequirements: [
        { title: 'BUSINESS_INFORMATION', documentationUri: DOC, affectedRegionCodes: ['AE', 'DE', 'US'] },
        { title: 'HAS_KOREAN_BUSINESS_REGISTRATION_NUMBER', documentationUri: DOC, affectedRegionCodes: ['KR'] },
      ],
    },
    { name: 'accounts/401005146/programs/shopping-ads', state: 'ELIGIBLE' },
    {
      name: 'accounts/401005146/programs/youtube-shopping-checkout',
      state: 'NOT_ELIGIBLE',
      unmetRequirements: [{ title: 'HAS_SUPPORT_CONTACT', affectedRegionCodes: ['KR', 'US'] }],
    },
  ],
};

const issue = (over: Record<string, unknown> = {}) => ({
  name: 'accounts/1/issues/website_not_claimed',
  title: 'Website not claimed',
  severity: 'CRITICAL',
  detail: 'Claim your website.',
  documentationUri: DOC,
  impactedDestinations: [{ reportingContext: 'SHOPPING_ADS', impacts: [{ regionCode: 'US', severity: 'CRITICAL' }] }],
  ...over,
});

describe('call builders', () => {
  it('lists programs', () => {
    expect(listPrograms('1')).toEqual({ method: 'GET', path: '/accounts/v1/accounts/1/programs' });
  });

  it('lists account issues', () => {
    expect(listAccountIssues('1')).toEqual({
      method: 'GET',
      path: '/accounts/v1/accounts/1/issues',
      query: { pageSize: '50' },
    });
  });
});

describe('accountReasons', () => {
  it('keeps free-listings requirements for the market country', () => {
    const reasons = accountReasons(programs, {}, ['US']);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatchObject({
      source: 'requirement',
      program: 'free-listings',
      code: 'BUSINESS_INFORMATION',
      documentation: DOC,
      countries: ['US'],
    });
  });

  it('drops programs outside free-listings and shopping-ads', () => {
    const reasons = accountReasons(programs, {}, ['KR', 'US']);
    expect(reasons.map((r) => r.code)).not.toContain('HAS_SUPPORT_CONTACT');
  });

  it('drops requirements that do not touch the market countries', () => {
    const reasons = accountReasons(programs, {}, ['US']);
    expect(reasons.map((r) => r.code)).not.toContain('HAS_KOREAN_BUSINESS_REGISTRATION_NUMBER');
  });

  it('turns BUSINESS_INFORMATION into plain English', () => {
    const [reason] = accountReasons(programs, {}, ['US']);
    expect(reason.title).toBe('Business information is incomplete');
    expect(reason.action).toBe('Add your business address and a customer service contact in Merchant Center.');
  });

  it('turns HAS_SUPPORT_CONTACT into plain English', () => {
    const answer = {
      programs: [
        {
          name: 'accounts/1/programs/shopping-ads',
          unmetRequirements: [{ title: 'HAS_SUPPORT_CONTACT', affectedRegionCodes: ['US'] }],
        },
      ],
    };
    const [reason] = accountReasons(answer, {}, ['US']);
    expect(reason).toMatchObject({
      program: 'shopping-ads',
      title: 'No customer service contact',
      action: 'Add a customer service email, phone or contact page in Merchant Center.',
      documentation: null,
    });
  });

  it('makes unknown codes readable', () => {
    const answer = {
      programs: [
        { name: 'accounts/1/programs/free-listings', unmetRequirements: [{ title: 'HAS_SOMETHING_NEW', affectedRegionCodes: ['US'] }] },
      ],
    };
    const [reason] = accountReasons(answer, {}, ['US']);
    expect(reason.title).toBe('Has something new');
    expect(reason.action).toBeNull();
  });

  it('keeps critical account issues for the market country', () => {
    const reasons = accountReasons({}, { accountIssues: [issue()] }, ['US']);
    expect(reasons).toEqual([
      {
        source: 'issue',
        program: null,
        code: 'accounts/1/issues/website_not_claimed',
        title: 'Website not claimed',
        action: 'Claim your website.',
        documentation: DOC,
        countries: ['US'],
      },
    ]);
  });

  it('drops suggestions and issues for other countries, keeps issues with no region', () => {
    const issues = {
      accountIssues: [
        issue({ name: 'a', severity: 'SUGGESTION' }),
        issue({ name: 'b', impactedDestinations: [{ impacts: [{ regionCode: 'DE' }] }] }),
        issue({ name: 'c', impactedDestinations: [] }),
      ],
    };
    const reasons = accountReasons({}, issues, ['US']);
    expect(reasons.map((r) => r.code)).toEqual(['c']);
    expect(reasons[0].countries).toEqual([]);
  });

  it('puts requirements before issues and sorts each group by code', () => {
    const answer = {
      programs: [
        {
          name: 'accounts/1/programs/free-listings',
          unmetRequirements: [
            { title: 'Z_CODE', affectedRegionCodes: ['US'] },
            { title: 'A_CODE', affectedRegionCodes: ['US'] },
          ],
        },
      ],
    };
    const reasons = accountReasons(answer, { accountIssues: [issue({ name: 'b' }), issue({ name: 'a' })] }, ['US']);
    expect(reasons.map((r) => r.code)).toEqual(['A_CODE', 'Z_CODE', 'a', 'b']);
  });

  it('caps at MAX_REASONS', () => {
    const unmetRequirements = Array.from({ length: 25 }, (_, i) => ({ title: `CODE_${String(i).padStart(2, '0')}`, affectedRegionCodes: ['US'] }));
    const reasons = accountReasons({ programs: [{ name: 'accounts/1/programs/free-listings', unmetRequirements }] }, {}, ['US']);
    expect(reasons).toHaveLength(MAX_REASONS);
  });

  it('an odd or empty answer gives no reasons', () => {
    for (const odd of [undefined, null, 'x', 5, [], {}, { programs: 'x' }, { programs: [null, 3, { name: 1 }] }, { accountIssues: [null, 'x'] }]) {
      expect(accountReasons(odd, odd, ['US'])).toEqual([]);
    }
  });
});
