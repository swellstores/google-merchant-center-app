import { describe, expect, it } from 'vitest';
import { stripHtml, truncate } from '../../../functions/lib/mapping/text';

describe('stripHtml', () => {
  it('drops tags, decodes common entities and collapses whitespace', () => {
    expect(stripHtml('<p>Big &amp; <b>blue</b></p>\n<p>Holds&nbsp;350&#39;ml &quot;coffee&quot;</p>')).toBe(
      'Big & blue Holds 350\'ml "coffee"',
    );
  });

  it('keeps line breaks as spaces between block elements', () => {
    expect(stripHtml('<ul><li>One</li><li>Two</li></ul>')).toBe('One Two');
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('Mug', 150)).toBe('Mug');
  });

  it('cuts to the limit with an ellipsis', () => {
    const cut = truncate('a'.repeat(200), 150);
    expect(cut).toHaveLength(150);
    expect(cut.endsWith('…')).toBe(true);
  });
});
