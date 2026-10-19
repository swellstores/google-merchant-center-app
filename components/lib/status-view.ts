import { SEVERITIES } from './dashboard';
import { COUNTRIES } from './countries';
import type { Tone } from './tone';

export type StatusValue = 'approved' | 'partial' | 'pending' | 'disapproved' | 'not_sent' | 'excluded';

/** Mirrors `StatusIssue` in functions/lib/status/product-status.ts. */
export interface StatusIssue {
  code: string;
  severity: 'disapproved' | 'demoted' | 'review' | 'info';
  description: string;
  detail?: string;
  documentation?: string;
  offers: string[];
  countries: string[];
}

/** Mirrors `OfferView` in functions/lib/admin/product-status.ts. */
export interface OfferView {
  input_id: string;
  market: string;
  variant: string | null;
  status: 'approved' | 'partial' | 'pending' | 'disapproved';
  issues: StatusIssue[];
  expires: string | null;
}

/** Mirrors `ProductStatusView` in functions/lib/admin/product-status.ts. */
export interface ProductStatusView {
  connected: boolean;
  stored: {
    status?: StatusValue | null;
    status_label?: string | null;
    status_issues?: StatusIssue[];
    date_status?: string | null;
    sync_state?: 'sent' | 'error' | 'skipped';
    sync_reason?: string | null;
    sync_error?: string | null;
    date_synced?: string | null;
  };
  live: { offers: OfferView[]; more: number; checked_at: string } | null;
  live_error: string | null;
}

export type OfferIssue = StatusIssue & { tone: Tone };

export interface StatusPanelModel {
  headline: { tone: Tone; text: string };
  /** "Checked just now", only for a live answer */
  checked: string | null;
  note: string | null;
  /** Google's refusal of part of the product at the last send */
  refusal: string | null;
  /** "Last sent to Google 2026-10-15" */
  lastSent: string | null;
  markets: { market: string; heading: string; offers: { title: string; tone: Tone; text: string; issues: OfferIssue[] }[] }[];
  /** One line per market: "2 variants pending" */
  summaries: { heading: string; text: string; tone: Tone }[];
  /** Shown when the product is hidden from Google */
  hidden: string | null;
  /** Stored issues when there is no live answer */
  issues: StatusIssue[];
  canResend: boolean;
}

const STATUSES: Record<StatusValue, { tone: Tone; text: string }> = {
  approved: { tone: 'ok', text: 'Approved' },
  partial: { tone: 'info', text: 'Partly approved' },
  pending: { tone: 'neutral', text: 'Pending' },
  disapproved: { tone: 'bad', text: 'Disapproved' },
  not_sent: { tone: 'neutral', text: 'Not sent' },
  excluded: { tone: 'neutral', text: 'Hidden from Google' },
};

/** Worst first: one bad offer decides the headline */
const WORST: StatusValue[] = ['disapproved', 'partial', 'pending', 'approved'];

const day = (iso: string | null | undefined) => {
  const time = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
};

const COUNTRY_NAMES = new Map(COUNTRIES);

const ISSUE_TONES: Record<StatusIssue['severity'], Tone> = { disapproved: 'bad', demoted: 'info', review: 'neutral', info: 'neutral' };

export function marketHeading(market: string): string {
  const [country, language] = market.split(' ');
  return `${COUNTRY_NAMES.get(country) ?? country}${language ? ` · ${language}` : ''}`;
}

function checkedText(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return 'Checked just now';
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  return minutes < 1 ? 'Checked just now' : `Checked ${minutes} min ago`;
}

function storedNote(view: ProductStatusView, lead: string): string {
  const date = day(view.stored.date_status ?? view.stored.date_synced);
  return `${lead} ${date ? `This is the status from ${date}.` : 'This is the last known status.'}`;
}

function noteOf(view: ProductStatusView): string | null {
  if (!view.connected) return storedNote(view, 'Not connected.');
  if (view.live_error) return storedNote(view, `Google did not answer: ${view.live_error}.`);
  if (view.live && view.live.more > 0) return `And ${view.live.more} more offer${view.live.more === 1 ? '' : 's'}.`;
  return null;
}

const label = (status: StatusValue) => STATUSES[status].text.toLowerCase();

function summaryOf(group: OfferView[]): { text: string; tone: Tone } {
  const counts = WORST.map((status) => ({ status, n: group.filter((offer) => offer.status === status).length })).filter((c) => c.n > 0);
  const tone = STATUSES[counts[0].status].tone;
  if (counts.length > 1) return { text: counts.map((c) => `${c.n} ${label(c.status)}`).join(', '), tone };
  const { status, n } = counts[0];
  if (n === 1 && !group[0].variant) return { text: STATUSES[status].text, tone };
  return { text: `${n} variant${n === 1 ? '' : 's'} ${label(status)}`, tone };
}

export function statusPanelModel(view: ProductStatusView, now: number): StatusPanelModel {
  const offers = view.live?.offers ?? [];
  const live = view.connected && !view.live_error && offers.length > 0;
  const excluded = view.stored.status === 'excluded';
  const sentDay = day(view.stored.date_synced);

  let headline = STATUSES[view.stored.status ?? 'not_sent'];
  if (view.stored.status_label && !excluded) headline = { ...headline, text: view.stored.status_label };
  if (live && !excluded) {
    const worst = WORST.find((status) => offers.some((offer) => offer.status === status)) ?? 'pending';
    const count = offers.filter((offer) => offer.status === worst).length;
    headline = { ...STATUSES[worst], text: count < offers.length ? `${STATUSES[worst].text} (${count} of ${offers.length})` : STATUSES[worst].text };
  }

  const markets = new Map<string, StatusPanelModel['markets'][number]>();
  if (live) {
    for (const offer of offers) {
      const group = markets.get(offer.market) ?? { market: offer.market, heading: marketHeading(offer.market), offers: [] };
      markets.set(offer.market, group);
      const status = STATUSES[offer.status];
      group.offers.push({
        title: offer.variant ? `Variant: ${offer.variant}` : 'Product',
        tone: status.tone,
        text: status.text,
        issues: offer.issues.map((issue) => ({ ...issue, tone: ISSUE_TONES[issue.severity] })),
      });
    }
  }

  const byMarket = new Map<string, OfferView[]>();
  if (live) for (const offer of offers) byMarket.set(offer.market, [...(byMarket.get(offer.market) ?? []), offer]);

  return {
    headline: { tone: headline.tone, text: headline.text },
    checked: live && view.live ? checkedText(view.live.checked_at, now) : null,
    note: noteOf(view),
    refusal: view.stored.sync_state === 'error' && view.stored.sync_error && view.stored.status !== 'not_sent' ? `Google refused part of this product: ${view.stored.sync_error}` : null,
    lastSent: sentDay ? `Last sent to Google ${sentDay}` : null,
    markets: [...markets.values()],
    summaries: [...byMarket].map(([market, group]) => ({ heading: marketHeading(market), ...summaryOf(group) })),
    hidden: excluded ? 'Turn off “Hide from Google” above to list it again.' : null,
    issues: live ? [] : (view.stored.status_issues ?? []),
    canResend: view.connected && !excluded,
  };
}

export const issueSeverity = (severity: StatusIssue['severity']) => SEVERITIES[severity];
