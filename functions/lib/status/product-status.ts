import type { SkipReason } from '../mapping/offers';
import { iso } from '../time';

export type StatusValue = 'approved' | 'partial' | 'pending' | 'disapproved' | 'not_sent' | 'excluded';

export interface GoogleProductStatus {
  destinationStatuses?: { reportingContext?: string; approvedCountries?: string[]; pendingCountries?: string[]; disapprovedCountries?: string[] }[];
  itemLevelIssues?: {
    code?: string;
    severity?: string;
    resolution?: string;
    attribute?: string;
    reportingContext?: string;
    description?: string;
    detail?: string;
    documentation?: string;
    applicableCountries?: string[];
  }[];
  googleExpirationDate?: string;
}

/** One offer's answer from products.get; `found: false` for a 404. */
export interface OfferAnswer {
  inputId: string;
  found: boolean;
  status?: GoogleProductStatus;
}

export interface StatusIssue {
  code: string;
  severity: 'disapproved' | 'demoted' | 'info';
  description: string;
  detail?: string;
  documentation?: string;
  offers: string[];
  countries: string[];
}

export interface ProductStatus {
  status: StatusValue;
  label: string;
  issues: StatusIssue[];
  hash: string;
}

type OfferStatus = 'approved' | 'partial' | 'pending' | 'disapproved';

export const MISSING_ISSUE = 'missing_in_google';

const MAX_ISSUES = 10;
const MAX_OFFERS_PER_ISSUE = 20;

const LABELS: Record<OfferStatus, string> = {
  approved: 'Approved',
  partial: 'Partly approved',
  pending: 'Pending',
  disapproved: 'Disapproved',
};
const BADNESS: Record<OfferStatus, number> = { approved: 0, pending: 1, partial: 2, disapproved: 3 };
const SEVERITY_ORDER: Record<StatusIssue['severity'], number> = { disapproved: 0, demoted: 1, info: 2 };

const SKIP_LABELS: Record<Exclude<SkipReason, 'excluded'>, string> = {
  inactive: 'Not sent: inactive',
  subscription_only: 'Not sent: subscription only',
  not_physical: 'Not sent: gift card',
  no_price: 'Not sent: no price',
  no_image: 'Not sent: no image',
};

export function offerStatus(answer: OfferAnswer): OfferStatus {
  const destinations = answer.found ? answer.status?.destinationStatuses : undefined;
  if (!destinations?.length) return 'pending';
  const approved = destinations.some((d) => d.approvedCountries?.length);
  const bad = destinations.some((d) => d.disapprovedCountries?.length);
  if (approved && bad) return 'partial';
  if (bad) return 'disapproved';
  if (approved) return 'approved';
  return 'pending';
}

function severityOf(google: string | undefined): StatusIssue['severity'] {
  if (google === 'DISAPPROVED') return 'disapproved';
  if (google === 'DEMOTED') return 'demoted';
  return 'info';
}

export function groupIssues(answers: OfferAnswer[]): StatusIssue[] {
  const groups = new Map<string, StatusIssue>();
  const add = (code: string, severity: StatusIssue['severity'], inputId: string, countries: string[], from: Partial<StatusIssue>) => {
    let issue = groups.get(code);
    if (!issue) {
      issue = { code, severity, description: from.description ?? code, offers: [], countries: [] };
      if (from.detail) issue.detail = from.detail;
      if (from.documentation) issue.documentation = from.documentation;
      groups.set(code, issue);
    }
    if (SEVERITY_ORDER[severity] < SEVERITY_ORDER[issue.severity]) issue.severity = severity;
    if (!issue.offers.includes(inputId)) issue.offers.push(inputId);
    for (const country of countries) if (!issue.countries.includes(country)) issue.countries.push(country);
  };

  for (const answer of answers) {
    if (!answer.found) {
      add(MISSING_ISSUE, 'info', answer.inputId, [], {
        description: 'Google has not processed this offer yet, or it was removed in Merchant Center',
      });
      continue;
    }
    for (const item of answer.status?.itemLevelIssues ?? []) {
      add(item.code ?? 'unknown', severityOf(item.severity), answer.inputId, item.applicableCountries ?? [], {
        description: item.description,
        detail: item.detail,
        documentation: item.documentation,
      });
    }
  }

  return [...groups.values()]
    .map((issue) => ({ ...issue, offers: issue.offers.slice(0, MAX_OFFERS_PER_ISSUE), countries: [...issue.countries].sort() }))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.offers.length - a.offers.length)
    .slice(0, MAX_ISSUES);
}

/** FNV-1a, 32 bit. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function build(status: StatusValue, label: string, issues: StatusIssue[]): ProductStatus {
  const digest = JSON.stringify([status, label, issues.map((i) => [i.code, i.severity, [...i.offers].sort(), i.countries])]);
  return { status, label, issues, hash: fnv1a(digest) };
}

export function productStatus(answers: OfferAnswer[]): ProductStatus {
  const statuses = answers.map(offerStatus);
  const worst = statuses.reduce<OfferStatus>((a, b) => (BADNESS[b] > BADNESS[a] ? b : a), 'approved');
  const count = statuses.filter((s) => s === worst).length;
  const overall: OfferStatus = statuses.length ? worst : 'pending';
  const label = statuses.length && count < statuses.length ? `${LABELS[overall]} (${count} of ${statuses.length})` : LABELS[overall];
  return build(overall, label, groupIssues(answers));
}

export function skippedStatus(reason: SkipReason): ProductStatus {
  if (reason === 'excluded') return build('excluded', 'Hidden from Google', []);
  return build('not_sent', SKIP_LABELS[reason], []);
}

export function pendingStatus(): ProductStatus {
  return build('pending', LABELS.pending, []);
}

export function refusedStatus(message: string, inputIds: string[]): ProductStatus {
  const issue: StatusIssue = {
    code: 'refused_by_google',
    severity: 'disapproved',
    description: message,
    offers: inputIds.slice(0, MAX_OFFERS_PER_ISSUE),
    countries: [],
  };
  return build('not_sent', 'Not sent: Google refused it', [issue]);
}

export function earliestExpiry(answers: OfferAnswer[]): number | null {
  let earliest: number | null = null;
  for (const answer of answers) {
    const at = Date.parse(answer.status?.googleExpirationDate ?? '');
    if (!Number.isNaN(at) && (earliest === null || at < earliest)) earliest = at;
  }
  return earliest;
}

/** The product PUT body part: plain fields plus `$set: { status_issues }`. */
export function statusFields(status: ProductStatus, now: number): Record<string, unknown> {
  return {
    status: status.status,
    status_label: status.label,
    status_hash: status.hash,
    date_status: iso(now),
    $set: { status_issues: status.issues },
  };
}
