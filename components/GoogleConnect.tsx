import type { ComponentProps } from '@swell/apps-sdk/components';
import { useEffect, useRef, useState } from 'preact/hooks';
import { callRoute } from './lib/api';
import { COUNTRIES } from './lib/countries';
import { summarizeKey } from './lib/key-file';
import { Button, Checklist, inputStyle, Label, Modal, Notice, Stack, theme } from './lib/ui';

export const config = { description: 'Connect the store to Google Merchant Center with a service account key' };

type Status = 'connected' | 'broken' | 'disconnected';

interface ConnectionView {
  status: Status;
  merchant_id: string | null;
  client_email: string | null;
  last_error: string | null;
  date_connected: string | null;
}

interface MarketView {
  country: string;
  language: string;
  currency: string;
  link_template: string;
}

interface StatusView {
  connection: ConnectionView;
  market: MarketView | null;
  defaults: { link_template: string };
}

interface Check {
  id: string;
  ok: boolean;
  message: string;
  help?: string;
}

interface ConnectResult {
  connection: ConnectionView;
  market: MarketView | null;
  report: { ok: boolean; checks: Check[] };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const STEPS = [
  { text: 'Create a Google Cloud project.', href: 'https://console.cloud.google.com/projectcreate' },
  { text: 'Enable the Merchant API in that project.', href: 'https://console.cloud.google.com/apis/library/merchantapi.googleapis.com' },
  { text: 'Create a service account, open it, and add a JSON key under Keys.', href: 'https://console.cloud.google.com/iam-admin/serviceaccounts' },
  { text: 'Drop the key file below and enter your Merchant Center account ID.' },
  { text: 'In Merchant Center, open Settings → People and access and add the service account email as an Admin.', href: 'https://merchants.google.com/' },
];

export default function GoogleConnect(props: ComponentProps) {
  const [view, setView] = useState<StatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyText, setKeyText] = useState('');
  const [merchantId, setMerchantId] = useState('');
  const [country, setCountry] = useState('US');
  const [linkTemplate, setLinkTemplate] = useState('');
  const [checks, setChecks] = useState<Check[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [removeProducts, setRemoveProducts] = useState(true);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    callRoute<StatusView>(props.fetch, 'connection')
      .then((next) => {
        setView(next);
        setMerchantId(next.connection.merchant_id ?? '');
        setCountry(next.market?.country ?? 'US');
        setLinkTemplate(next.market?.link_template ?? next.defaults.link_template);
      })
      .catch((e) => setError(messageOf(e)));
  }, [props.fetch]);

  const summary = keyText ? summarizeKey(keyText) : null;
  const email = summary && 'clientEmail' in summary ? summary.clientEmail : view?.connection.client_email;

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const result = await callRoute<ConnectResult>(props.fetch, 'connection', {
        op: 'connect',
        key: keyText || undefined,
        merchant_id: merchantId.trim(),
        country,
        link_template: linkTemplate.trim(),
      });
      setChecks(result.report.checks);
      setView((current) => current && { ...current, connection: result.connection, market: result.market });
      if (result.report.ok) setKeyText('');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const next = await callRoute<StatusView>(props.fetch, 'connection', { op: 'disconnect', remove_products: removeProducts });
      setView(next);
      setChecks([]);
      setConfirming(false);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(email ?? '');
    } catch {
      // The admin's iframe may not allow the clipboard: select the text instead.
      emailRef.current?.select();
    }
  }

  async function readFile(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (file) setKeyText(await file.text());
  }

  if (!view && !error) return <Stack>Loading…</Stack>;
  const status = view?.connection.status ?? 'disconnected';

  return (
    <Stack gap={16}>
      {status === 'connected' && (
        <Notice tone="ok">
          Connected to Merchant Center {view?.connection.merchant_id} as {view?.connection.client_email}. Products are sent to{' '}
          {view?.market ? `${view.market.country} (${view.market.language}, ${view.market.currency})` : 'Google'}.
        </Notice>
      )}
      {status === 'broken' && (
        <Notice tone="bad">
          Google stopped accepting the connection: {view?.connection.last_error}. Fix it and press Check again, or paste a new key.
        </Notice>
      )}
      {error && <Notice tone="bad">{error}</Notice>}

      {status !== 'connected' && (
        <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {STEPS.map((step) => (
            <li key={step.text}>
              {step.text}{' '}
              {step.href && (
                <a href={step.href} target="_blank" rel="noopener noreferrer" style={{ color: theme.info }}>
                  Open
                </a>
              )}
            </li>
          ))}
        </ol>
      )}

      <Label text="Service account key (JSON)" hint={summary && 'error' in summary ? summary.error : view?.connection.client_email ? 'Leave empty to keep the stored key.' : undefined}>
        <input type="file" accept="application/json,.json" onChange={readFile} />
        <textarea
          rows={3}
          value={keyText}
          placeholder='{"type": "service_account", …}'
          onInput={(event) => setKeyText((event.currentTarget as HTMLTextAreaElement).value)}
          style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 12 }}
        />
      </Label>

      {email && (
        <Label text="Service account email" hint="Add this address in Merchant Center → People and access, with Admin access.">
          <div style={{ display: 'flex', gap: 8 }}>
            <input ref={emailRef} readOnly value={email} onFocus={(event) => (event.currentTarget as HTMLInputElement).select()} style={{ ...inputStyle, flex: 1 }} />
            <Button kind="secondary" onClick={copyEmail}>
              Copy
            </Button>
          </div>
        </Label>
      )}

      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <Label text="Merchant Center account ID">
            <input value={merchantId} inputMode="numeric" onInput={(event) => setMerchantId((event.currentTarget as HTMLInputElement).value)} style={inputStyle} />
          </Label>
        </div>
        <div style={{ flex: 1 }}>
          <Label text="Country you sell to">
            <select value={country} onChange={(event) => setCountry((event.currentTarget as HTMLSelectElement).value)} style={inputStyle}>
              {COUNTRIES.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </Label>
        </div>
      </div>

      <Label text="Product link" hint="Where shoppers land from Google. Use {slug} or {product_id}; {variant_id} opens the variant.">
        <input value={linkTemplate} onInput={(event) => setLinkTemplate((event.currentTarget as HTMLInputElement).value)} style={inputStyle} />
      </Label>

      {checks.length > 0 && <Checklist items={checks} />}

      <div style={{ display: 'flex', gap: 8 }}>
        <Button disabled={busy} onClick={connect}>
          {busy ? 'Checking…' : status === 'disconnected' ? 'Connect' : 'Check again'}
        </Button>
        {status !== 'disconnected' && (
          <Button kind="danger" disabled={busy} onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        )}
      </div>

      {confirming && (
        <Modal title="Disconnect Google Merchant Center?" onClose={() => setConfirming(false)}>
          <span>The app stops sending products and forgets the key.</span>
          <label style={{ display: 'flex', gap: 8 }}>
            <input type="checkbox" checked={removeProducts} onChange={(event) => setRemoveProducts((event.currentTarget as HTMLInputElement).checked)} />
            Also remove the products this store sent to Google
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button kind="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button kind="danger" disabled={busy} onClick={disconnect}>
              Disconnect
            </Button>
          </div>
        </Modal>
      )}
    </Stack>
  );
}
