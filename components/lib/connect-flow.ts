import type { CheckResult } from './steps';

export const UNFINISHED = 'The connection check did not finish. Press Check again.';

export interface ConnectionView {
  status: 'connected' | 'broken' | 'disconnected';
  merchant_id: string | null;
  client_email: string | null;
  has_key: boolean;
  last_error: string | null;
  date_connected: string | null;
}

export interface MarketView {
  country: string;
  language: string;
  currency: string;
  link_template: string;
}

export interface StatusView {
  connection: ConnectionView;
  market: MarketView | null;
  defaults: { link_template: string };
}

export interface CheckAnswer {
  connection: ConnectionView;
  report: { ok: boolean; checks: CheckResult[] };
}

export type Phase = 'checking' | 'activating';

export interface ConnectInput {
  key?: string;
  merchant_id: string;
  country: string;
  link_template: string;
}

/**
 * Checks the connection and, when every check passed, starts syncing: two
 * route calls, each well within the platform's 10 s. An answer that lacks what
 * it must carry was cut off; it says so instead of breaking the page.
 */
export async function checkThenActivate(
  call: (body: Record<string, unknown>) => Promise<unknown>,
  input: ConnectInput,
  on: { phase(phase: Phase): void; checked(answer: CheckAnswer): void },
): Promise<StatusView | null> {
  on.phase('checking');
  const checked = (await call({ op: 'check', key: input.key, merchant_id: input.merchant_id })) as Partial<CheckAnswer> | null;
  if (!checked?.connection || !Array.isArray(checked.report?.checks)) throw new Error(UNFINISHED);
  on.checked(checked as CheckAnswer);
  if (!checked.report.ok) return null;

  on.phase('activating');
  const view = (await call({ op: 'activate', country: input.country, link_template: input.link_template })) as Partial<StatusView> | null;
  if (!view?.connection) throw new Error(UNFINISHED);
  return view as StatusView;
}
