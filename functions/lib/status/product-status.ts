import { googleAttribute, needsAttributes, providesAttribute, type AttributeOptions } from '../mapping/attributes';
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
  /** `review`: Google is still processing it */
  severity: 'disapproved' | 'demoted' | 'review' | 'info';
  description: string;
  detail?: string;
  documentation?: string;
  /** Google's attribute for the issue, normalised by `googleAttribute` */
  attribute?: string;
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
export const REFUSED_ISSUE = 'refused_by_google';

const MAX_ISSUES = 10;
const MAX_OFFERS_PER_ISSUE = 20;

const LABELS: Record<OfferStatus, string> = {
  approved: 'Approved',
  partial: 'Partly approved',
  pending: 'Pending',
  disapproved: 'Disapproved',
};
const BADNESS: Record<OfferStatus, number> = { approved: 0, pending: 1, partial: 2, disapproved: 3 };
/** The worst first */
export const SEVERITY_ORDER: Record<StatusIssue['severity'], number> = { disapproved: 0, demoted: 1, review: 2, info: 3 };

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

function severityOf(google: string | undefined, resolution: string | undefined): StatusIssue['severity'] {
  if (resolution?.toLowerCase() === 'pending_processing') return 'review';
  if (google === 'DISAPPROVED') return 'disapproved';
  if (google === 'DEMOTED') return 'demoted';
  return 'info';
}

/** One issue per code and attribute. */
export const issueKey = (issue: Pick<StatusIssue, 'code' | 'attribute'>) => `${issue.code}|${issue.attribute ?? ''}`;
const byCode = (a: StatusIssue, b: StatusIssue) => (issueKey(a) < issueKey(b) ? -1 : issueKey(a) > issueKey(b) ? 1 : 0);

/** At most `MAX_ISSUES`, in their order. An issue the tab can provide is cut last: the marker and the tab read it. */
function capped(issues: StatusIssue[]): StatusIssue[] {
  const provided = (issue: StatusIssue) => providesAttribute(issue.attribute);
  const kept = new Set([...issues.filter(provided), ...issues.filter((issue) => !provided(issue))].slice(0, MAX_ISSUES));
  return issues.filter((issue) => kept.has(issue));
}

/** `missing: false` leaves out the issue of offers Google does not hold, for a product just sent. */
export function groupIssues(answers: OfferAnswer[], missing = true): StatusIssue[] {
  const groups = new Map<string, StatusIssue>();
  const add = (code: string, severity: StatusIssue['severity'], inputId: string, countries: string[], from: Partial<StatusIssue>) => {
    const key = issueKey({ code, attribute: from.attribute });
    let issue = groups.get(key);
    if (!issue) {
      issue = { code, severity, description: from.description ?? code, offers: [], countries: [] };
      if (from.attribute) issue.attribute = from.attribute;
      if (from.detail) issue.detail = from.detail;
      if (from.documentation) issue.documentation = from.documentation;
      groups.set(key, issue);
    }
    if (SEVERITY_ORDER[severity] < SEVERITY_ORDER[issue.severity]) issue.severity = severity;
    if (!issue.offers.includes(inputId)) issue.offers.push(inputId);
    for (const country of countries) if (!issue.countries.includes(country)) issue.countries.push(country);
  };

  for (const answer of answers) {
    if (!answer.found) {
      if (missing) {
        add(MISSING_ISSUE, 'info', answer.inputId, [], {
          description: 'Google has not processed this offer yet, or it was removed in Merchant Center',
        });
      }
      continue;
    }
    for (const item of answer.status?.itemLevelIssues ?? []) {
      add(item.code ?? 'unknown', severityOf(item.severity, item.resolution), answer.inputId, item.applicableCountries ?? [], {
        description: item.description,
        detail: item.detail,
        documentation: item.documentation,
        attribute: googleAttribute(item.attribute) ?? undefined,
      });
    }
  }

  // Sorted whole, so the order Google lists issues and offers in never changes the status hash.
  return capped(
    [...groups.values()]
      .map((issue) => ({ ...issue, offers: [...issue.offers].sort().slice(0, MAX_OFFERS_PER_ISSUE), countries: [...issue.countries].sort() }))
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.offers.length - a.offers.length || byCode(a, b)),
  );
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
  const digest = JSON.stringify([status, label, issues.map((i) => {
    const row = [i.code, i.severity, [...i.offers].sort(), i.countries];
    return i.attribute ? [...row, i.attribute] : row;
  })]);
  return { status, label, issues, hash: fnv1a(digest) };
}

export function productStatus(answers: OfferAnswer[], { missing = true }: { missing?: boolean } = {}): ProductStatus {
  const statuses = answers.map(offerStatus);
  const worst = statuses.reduce<OfferStatus>((a, b) => (BADNESS[b] > BADNESS[a] ? b : a), 'approved');
  const count = statuses.filter((s) => s === worst).length;
  const overall: OfferStatus = statuses.length ? worst : 'pending';
  const label = statuses.length && count < statuses.length ? `${LABELS[overall]} (${count} of ${statuses.length})` : LABELS[overall];
  return build(overall, label, groupIssues(answers, missing));
}

export function skippedStatus(reason: SkipReason): ProductStatus {
  if (reason === 'excluded') return build('excluded', 'Hidden from Google', []);
  return build('not_sent', SKIP_LABELS[reason], []);
}

export function pendingStatus(): ProductStatus {
  return build('pending', LABELS.pending, []);
}

const refusal = (message: string, inputIds: string[]): StatusIssue => ({
  code: REFUSED_ISSUE,
  severity: 'disapproved',
  description: message,
  offers: inputIds.slice(0, MAX_OFFERS_PER_ISSUE),
  countries: [],
});

export function refusedStatus(message: string, inputIds: string[]): ProductStatus {
  return build('not_sent', 'Not sent: Google refused it', [refusal(message, inputIds)]);
}

/** A product Google took only in part: its message comes first among the issues, and an approved product is partly approved. */
export function partlyRefused(status: ProductStatus, message: string): ProductStatus {
  const approved = status.status === 'approved';
  return build(approved ? 'partial' : status.status, approved ? LABELS.partial : status.label, capped([refusal(message, []), ...status.issues]));
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
export function statusFields(status: ProductStatus, now: number, chosen?: AttributeOptions | null): Record<string, unknown> {
  return {
    status: status.status,
    status_label: status.label,
    status_hash: status.hash,
    date_status: iso(now),
    needs_attributes: needsAttributes(status.issues, chosen),
    $set: { status_issues: status.issues },
  };
}
