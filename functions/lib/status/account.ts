export interface AccountReason {
  source: 'requirement' | 'issue';
  program: 'free-listings' | 'shopping-ads' | null;
  /** requirement title or issue name */
  code: string;
  title: string;
  action: string | null;
  documentation: string | null;
  /** only the store's market countries, sorted */
  countries: string[];
}

export const REASON_PROGRAMS = ['free-listings', 'shopping-ads'];
export const MAX_REASONS = 10;

const KNOWN: Record<string, { title: string; action: string }> = {
  BUSINESS_INFORMATION: {
    title: 'Business information is incomplete',
    action: 'Add your business address and a customer service contact in Merchant Center.',
  },
  HAS_SUPPORT_CONTACT: {
    title: 'No customer service contact',
    action: 'Add a customer service email, phone or contact page in Merchant Center.',
  },
  HAS_WEBSITE: {
    title: 'No website URL',
    action: 'Add your website URL in Merchant Center.',
  },
  HAS_VERIFIED_WEBSITE: {
    title: 'Website is not verified and claimed',
    action: 'Verify and claim your website in Merchant Center.',
  },
  HAS_RETURN_POLICY: {
    title: 'No return policy',
    action: 'Add a return policy in Merchant Center.',
  },
  HAS_SHIPPING_SETTINGS: {
    title: 'No shipping settings',
    action: 'Add shipping settings in Merchant Center.',
  },
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const strings = (value: unknown): string[] => list(value).filter((v): v is string => typeof v === 'string');

const readableCode = (code: string) => {
  const words = code.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const byCode = (a: AccountReason, b: AccountReason) =>
  a.code < b.code ? -1 : a.code > b.code ? 1 : (a.program ?? '').localeCompare(b.program ?? '');

function requirementReasons(programs: unknown, market: Set<string>): AccountReason[] {
  const reasons: AccountReason[] = [];
  for (const program of isObject(programs) ? list(programs.programs) : []) {
    if (!isObject(program)) continue;
    const id = text(program.name)?.split('/').pop();
    if (id !== 'free-listings' && id !== 'shopping-ads') continue;
    for (const requirement of list(program.unmetRequirements)) {
      if (!isObject(requirement)) continue;
      const code = text(requirement.title);
      if (!code) continue;
      const regions = strings(requirement.affectedRegionCodes);
      const countries = regions.filter((r) => market.has(r)).sort();
      if (regions.length && !countries.length) continue;
      const known = KNOWN[code];
      reasons.push({
        source: 'requirement',
        program: id,
        code,
        title: known?.title ?? readableCode(code),
        action: known?.action ?? null,
        documentation: text(requirement.documentationUri),
        countries,
      });
    }
  }
  return reasons.sort(byCode);
}

function issueReasons(issues: unknown, market: Set<string>): AccountReason[] {
  const reasons: AccountReason[] = [];
  for (const issue of isObject(issues) ? list(issues.accountIssues) : []) {
    if (!isObject(issue)) continue;
    if (issue.severity !== 'CRITICAL' && issue.severity !== 'ERROR') continue;
    const code = text(issue.name);
    if (!code) continue;
    const regions = list(issue.impactedDestinations).flatMap((destination) =>
      isObject(destination) ? list(destination.impacts).flatMap((i) => (isObject(i) ? strings([i.regionCode]) : [])) : [],
    );
    const countries = [...new Set(regions.filter((r) => market.has(r)))].sort();
    if (regions.length && !countries.length) continue;
    reasons.push({
      source: 'issue',
      program: null,
      code,
      title: text(issue.title) ?? readableCode(code.split('/').pop() ?? code),
      action: text(issue.detail),
      documentation: text(issue.documentationUri),
      countries,
    });
  }
  return reasons.sort(byCode);
}

/** Never throws: an unexpected shape gives no reasons. */
export function accountReasons(programs: unknown, issues: unknown, marketCountries: string[]): AccountReason[] {
  const market = new Set(marketCountries);
  return [...requirementReasons(programs, market), ...issueReasons(issues, market)].slice(0, MAX_REASONS);
}
