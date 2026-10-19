import { describe, expect, it, vi } from 'vitest';
import { callRoute } from '../../../components/lib/api';
import { issueSeverity, statusPanelModel, type OfferView, type ProductStatusView, type StatusIssue } from '../../../components/lib/status-view';

const NOW = Date.parse('2026-10-16T12:00:00Z');

const ISSUE: StatusIssue = { code: 'image_link_broken', severity: 'disapproved', description: 'Image cannot be loaded', offers: [], countries: ['US'] };

function offer(patch: Partial<OfferView> = {}): OfferView {
  return { input_id: 'online:en:US:p1', market: 'US en', variant: null, status: 'approved', issues: [], expires: null, ...patch };
}

function view(patch: Partial<ProductStatusView> = {}): ProductStatusView {
  return { connected: true, stored: { status: 'approved', status_label: 'Approved', date_status: '2026-10-14T08:00:00Z' }, live: null, live_error: null, ...patch };
}

describe('statusPanelModel', () => {
  it('a disconnected store shows the stored status with its date', () => {
    const model = statusPanelModel(view({ connected: false, stored: { status: 'disapproved', status_label: 'Disapproved', status_issues: [ISSUE], date_status: '2026-10-14T08:00:00Z' } }), NOW);
    expect(model.headline).toEqual({ tone: 'bad', text: 'Disapproved' });
    expect(model.note).toBe('Not connected. This is the status from 2026-10-14.');
    expect(model.issues).toEqual([ISSUE]);
    expect(model.markets).toEqual([]);
    expect(model.canResend).toBe(false);
  });

  it('live offers group by market with variant names', () => {
    const model = statusPanelModel(
      view({
        live: {
          checked_at: '2026-10-16T12:00:00Z',
          more: 2,
          offers: [
            offer({ variant: 'Red' }),
            offer({ input_id: 'b', variant: 'Blue', status: 'disapproved', issues: [ISSUE] }),
            offer({ input_id: 'c', market: 'DE de', variant: 'Red', status: 'pending' }),
          ],
        },
      }),
      NOW,
    );
    expect(model.headline).toEqual({ tone: 'bad', text: 'Disapproved (1 of 3)' });
    expect(model.markets.map((m) => [m.market, m.offers.map((o) => o.title)])).toEqual([
      ['US en', ['Variant: Red', 'Variant: Blue']],
      ['DE de', ['Variant: Red']],
    ]);
    expect(model.markets[0].offers[0]).toMatchObject({ tone: 'ok', text: 'Approved' });
    expect(model.markets[0].offers[1].issues).toEqual([{ ...ISSUE, tone: 'bad' }]);
    expect(model.note).toBe('And 2 more offers.');
    expect(model.issues).toEqual([]);
    expect(model.canResend).toBe(true);
  });

  it('a hidden product says so and offers no resend', () => {
    const model = statusPanelModel(view({ stored: { status: 'excluded', status_label: 'Hidden' } }), NOW);
    expect(model.headline).toEqual({ tone: 'neutral', text: 'Hidden from Google' });
    expect(model.canResend).toBe(false);
  });

  it('a live error falls back to the stored status with a note', () => {
    const model = statusPanelModel(view({ live_error: 'Quota exceeded', stored: { status: 'approved', status_label: 'Approved', status_issues: [ISSUE], date_status: '2026-10-14T08:00:00Z' } }), NOW);
    expect(model.note).toBe('Google did not answer: Quota exceeded. This is the status from 2026-10-14.');
    expect(model.headline).toEqual({ tone: 'ok', text: 'Approved' });
    expect(model.issues).toEqual([ISSUE]);
    expect(model.markets).toEqual([]);
    expect(model.canResend).toBe(true);
  });

  it('the live headline counts the worst offers', () => {
    const live = (statuses: OfferView['status'][]) =>
      statusPanelModel(view({ live: { checked_at: '2026-10-16T11:55:00Z', more: 0, offers: statuses.map((status, i) => offer({ input_id: String(i), status })) } }), NOW);
    expect(live(['approved', 'pending', 'pending']).headline).toEqual({ tone: 'neutral', text: 'Pending (2 of 3)' });
    expect(live(['pending', 'pending']).headline.text).toBe('Pending');
    expect(live(['approved', 'disapproved']).headline).toEqual({ tone: 'bad', text: 'Disapproved (1 of 2)' });
    expect(live(['approved']).checked).toBe('Checked 5 min ago');
    expect(statusPanelModel(view({ live: { checked_at: '2026-10-16T12:00:00Z', more: 0, offers: [offer()] } }), NOW).checked).toBe('Checked just now');
  });

  it('markets carry the country name', () => {
    const model = statusPanelModel(view({ live: { checked_at: '2026-10-16T12:00:00Z', more: 0, offers: [offer(), offer({ market: 'ZZ en' })] } }), NOW);
    expect(model.markets.map((m) => m.heading)).toEqual(['United States · en', 'ZZ · en']);
  });

  it('issues inside an offer carry their border tone, not a pill', () => {
    const issues: StatusIssue[] = [ISSUE, { ...ISSUE, code: 'b', severity: 'demoted' }, { ...ISSUE, code: 'c', severity: 'review' }, { ...ISSUE, code: 'd', severity: 'info' }];
    const model = statusPanelModel(view({ live: { checked_at: '2026-10-16T12:00:00Z', more: 0, offers: [offer({ status: 'pending', issues })] } }), NOW);
    expect(model.markets[0].offers[0]).toMatchObject({ tone: 'neutral', text: 'Pending' });
    expect(model.markets[0].offers[0].issues.map((i) => i.tone)).toEqual(['bad', 'info', 'neutral', 'neutral']);
  });

  it('an invalid date does not throw', () => {
    const model = statusPanelModel(view({ connected: false, stored: { status: 'approved', date_status: 'not a date' } }), NOW);
    expect(model.note).toBe('Not connected. This is the last known status.');
    const live = statusPanelModel(view({ live: { checked_at: 'bad', more: 0, offers: [offer()] } }), NOW);
    expect(live.checked).toBe('Checked just now');
  });

  it("the status panel shows Google's refusal", () => {
    const live = { checked_at: '2026-10-16T12:00:00Z', more: 0, offers: [offer()] };
    const stored = { status: 'partial' as const, status_label: 'Partly approved', sync_state: 'error' as const, sync_error: 'Invalid GTIN [gtin]' };
    expect(statusPanelModel(view({ stored, live }), NOW).refusal).toBe('Google refused part of this product: Invalid GTIN [gtin]');
    expect(statusPanelModel(view({ stored, connected: false }), NOW).refusal).toBe('Google refused part of this product: Invalid GTIN [gtin]');
    expect(statusPanelModel(view({ stored: { ...stored, sync_error: null } }), NOW).refusal).toBeNull();
    expect(statusPanelModel(view({ stored: { ...stored, sync_state: 'sent' } }), NOW).refusal).toBeNull();
    expect(statusPanelModel(view(), NOW).refusal).toBeNull();
  });

  it('a product never sent shows no refusal beside its stored issue', () => {
    const stored = { status: 'not_sent' as const, sync_state: 'error' as const, sync_error: 'Invalid GTIN [gtin]' };
    expect(statusPanelModel(view({ stored }), NOW).refusal).toBeNull();
  });

  it('the panel says when the product was last sent', () => {
    const stored = { status: 'approved' as const, date_synced: '2026-10-15T09:30:00Z' };
    expect(statusPanelModel(view({ stored }), NOW).lastSent).toBe('Last sent to Google 2026-10-15');
    expect(statusPanelModel(view({ stored: { ...stored, date_synced: null } }), NOW).lastSent).toBeNull();
    expect(statusPanelModel(view({ stored: { ...stored, date_synced: 'not a date' } }), NOW).lastSent).toBeNull();
    expect(statusPanelModel(view({ stored: {} }), NOW).lastSent).toBeNull();
  });

  it('a product never sent reads Not sent', () => {
    const model = statusPanelModel(view({ stored: {} }), NOW);
    expect(model.headline).toEqual({ tone: 'neutral', text: 'Not sent' });
    expect(model.note).toBeNull();
  });

  it('summaries count offers per market, worst first', () => {
    const model = statusPanelModel(
      view({
        live: {
          checked_at: '2026-10-16T12:00:00Z',
          more: 0,
          offers: [
            offer({ input_id: 'a', variant: 'Red', status: 'pending' }),
            offer({ input_id: 'b', variant: 'Blue', status: 'disapproved' }),
            offer({ input_id: 'c', market: 'DE de', variant: 'Red', status: 'pending' }),
            offer({ input_id: 'd', market: 'DE de', variant: 'Blue', status: 'pending' }),
            offer({ input_id: 'e', market: 'FR fr', variant: 'Red', status: 'approved' }),
          ],
        },
      }),
      NOW,
    );
    expect(model.summaries).toEqual([
      { heading: 'United States · en', text: '1 disapproved, 1 pending', tone: 'bad' },
      { heading: 'Germany · de', text: '2 variants pending', tone: 'neutral' },
      { heading: 'France · fr', text: '1 variant approved', tone: 'ok' },
    ]);
    expect(statusPanelModel(view({ connected: false }), NOW).summaries).toEqual([]);
  });

  it("a simple product's summary is its status", () => {
    const model = statusPanelModel(view({ live: { checked_at: '2026-10-16T12:00:00Z', more: 0, offers: [offer({ status: 'pending' })] } }), NOW);
    expect(model.summaries).toEqual([{ heading: 'United States · en', text: 'Pending', tone: 'neutral' }]);
  });

  it('a partly approved market reads partly approved', () => {
    const summaries = (statuses: OfferView['status'][]) =>
      statusPanelModel(view({ live: { checked_at: '2026-10-16T12:00:00Z', more: 0, offers: statuses.map((status, i) => offer({ input_id: String(i), variant: `V${i}`, status })) } }), NOW).summaries;
    expect(summaries(['partial', 'partial'])[0].text).toBe('2 variants partly approved');
    expect(summaries(['partial', 'approved'])[0].text).toBe('1 partly approved, 1 approved');
  });

  it('the hidden note points to the switch above', () => {
    expect(statusPanelModel(view({ stored: { status: 'excluded' } }), NOW).hidden).toBe('Turn off “Hide from Google” above to list it again.');
    expect(statusPanelModel(view(), NOW).hidden).toBeNull();
  });
});

describe('issueSeverity', () => {
  it('an issue in review and an info issue read differently', () => {
    expect(issueSeverity('review')).toEqual({ tone: 'neutral', label: 'In review' });
    expect(issueSeverity('info')).toEqual({ tone: 'neutral', label: 'Info' });
  });
});

describe('callRoute with a query', () => {
  it('keeps the query of a GET', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
    await callRoute(fetchFn as unknown as typeof fetch, 'product?id=abc');
    expect(fetchFn).toHaveBeenCalledWith('/functions/google_merchant_center/product?id=abc', { method: 'GET' });
  });
});
