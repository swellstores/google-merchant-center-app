import type { AppContext } from '../context';
import { GoogleApiError, googleCall } from '../google/http';
import type { ServiceAccountKey } from '../google/jwt';
import { getAccount, getHomepage, registerGcp } from '../google/merchant';
import { fetchAccessToken, type AccessToken } from '../google/token';

export type CheckId = 'key' | 'token' | 'registration' | 'account' | 'homepage';

export interface Check {
  id: CheckId;
  ok: boolean;
  message: string;
  help?: string;
}

export interface CheckReport {
  ok: boolean;
  checks: Check[];
  account?: { id: string; name?: string };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Every step a merchant can get wrong, in the order Google needs them. Stops at the first failure. */
export async function runChecks(
  ctx: AppContext,
  key: ServiceAccountKey,
  merchantId: string,
): Promise<{ report: CheckReport; token?: AccessToken }> {
  const checks: Check[] = [{ id: 'key', ok: true, message: `Key of ${key.client_email}` }];
  const fail = (id: CheckId, message: string, help?: string) => {
    checks.push({ id, ok: false, message, help });
    return { report: { ok: false, checks } };
  };
  const adminHelp = `In Merchant Center, open Settings → People and access, add ${key.client_email} and give it Admin access.`;

  let token: AccessToken;
  try {
    token = await fetchAccessToken(ctx.fetch, key, ctx.now());
  } catch (error) {
    return fail('token', `Google refused the key: ${messageOf(error)}`, 'Create a new JSON key for the service account and paste it again.');
  }
  checks.push({ id: 'token', ok: true, message: 'Google accepted the key' });

  let registeredBefore = false;
  try {
    await googleCall(ctx.fetch, token.token, registerGcp(merchantId));
  } catch (error) {
    if (!(error instanceof GoogleApiError)) throw error;
    if (error.kind === 'conflict' || /already/i.test(error.message)) registeredBefore = true;
    else if (error.kind === 'auth') return fail('registration', `Google refused to register the project: ${error.message}`, adminHelp);
    else return fail('registration', `Google could not register the project: ${error.message}`);
  }
  checks.push({ id: 'registration', ok: true, message: 'The Google Cloud project is registered with this account' });

  let account: { accountName?: string };
  try {
    account = await googleCall(ctx.fetch, token.token, getAccount(merchantId));
  } catch (error) {
    if (!(error instanceof GoogleApiError)) throw error;
    if (registeredBefore && error.kind === 'auth') {
      return fail(
        'account',
        'The Google Cloud project is registered with another Merchant Center account.',
        'One project can serve one Merchant Center account. Create a new project, service account and key for this account.',
      );
    }
    return fail('account', `Merchant Center account ${merchantId} is not readable: ${error.message}`, adminHelp);
  }
  checks.push({ id: 'account', ok: true, message: `Connected to ${account.accountName ?? merchantId}` });

  let homepage: { uri?: string; claimed?: boolean };
  try {
    homepage = await googleCall(ctx.fetch, token.token, getHomepage(merchantId));
  } catch (error) {
    if (!(error instanceof GoogleApiError)) throw error;
    return fail('homepage', `The account's website could not be read: ${error.message}`);
  }
  if (!homepage.claimed) {
    return fail(
      'homepage',
      `Your website ${homepage.uri ?? ''} is not verified and claimed in Merchant Center.`.replace('  ', ' '),
      'In Merchant Center, open Settings → Business info → Website, then verify and claim it.',
    );
  }
  checks.push({ id: 'homepage', ok: true, message: `Website ${homepage.uri} is verified` });

  return { report: { ok: true, checks, account: { id: merchantId, name: account.accountName } }, token };
}
