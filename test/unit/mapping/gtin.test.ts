import { describe, expect, it } from 'vitest';
import { validateGtin } from '../../../functions/lib/mapping/gtin';

describe('validateGtin', () => {
  it('accepts a valid EAN-13, UPC-A, GTIN-8 and GTIN-14', () => {
    for (const code of ['4006381333931', '036000291452', '96385074', '10012345678902']) {
      expect(validateGtin(code)).toEqual({ ok: true, value: code });
    }
  });

  it('rejects a wrong check digit', () => {
    expect(validateGtin('4006381333932')).toEqual({ ok: false, reason: 'check_digit' });
  });

  it('rejects letters and wrong lengths', () => {
    expect(validateGtin('40063813339A1')).toEqual({ ok: false, reason: 'digits' });
    expect(validateGtin('123456789')).toEqual({ ok: false, reason: 'length' });
  });

  it('trims spaces and keeps leading zeros', () => {
    expect(validateGtin('  036000291452 ')).toEqual({ ok: true, value: '036000291452' });
    expect(validateGtin('00012345678905')).toEqual({ ok: true, value: '00012345678905' });
  });
});
