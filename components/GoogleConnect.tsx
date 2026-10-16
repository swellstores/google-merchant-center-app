import type { ComponentProps } from '@swell/apps-sdk/components';
import { useEffect, useRef, useState } from 'preact/hooks';
import { callRoute } from './lib/api';
import { checkThenActivate, type Phase, type StatusView } from './lib/connect-flow';
import { COUNTRIES } from './lib/countries';
import { keyStepView, NO_KEY, offerKey, replaceKey, type KeyState } from './lib/key-step';
import { type CheckResult as Check, stepStates } from './lib/steps';
import { Button, Card, ExternalLink, Label, Modal, Notice, Pill, Root, Step } from './lib/ui';

export const config = { description: 'Connect the store to Google Merchant Center with a service account key' };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const countryName = (code: string) => COUNTRIES.find(([c]) => c === code)?.[1] ?? code;

const value = (event: Event) => (event.currentTarget as HTMLInputElement).value;

export default function GoogleConnect(props: ComponentProps) {
  const [view, setView] = useState<StatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Phase | 'disconnecting' | null>(null);
  const [key, setKey] = useState<KeyState>(NO_KEY);
  const [draft, setDraft] = useState('');
  const [merchantId, setMerchantId] = useState('');
  const [country, setCountry] = useState('US');
  const [linkTemplate, setLinkTemplate] = useState('');
  const [checks, setChecks] = useState<Check[]>([]);
  const [allOk, setAllOk] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [changingCountry, setChangingCountry] = useState(false);
  const [removeProducts, setRemoveProducts] = useState(true);
  const emailRef = useRef<HTMLInputElement>(null);

  function load() {
    setError(null);
    callRoute<StatusView>(props.fetch, 'connection')
      .then((next) => {
        setView(next);
        setMerchantId(next.connection.merchant_id ?? '');
        setCountry(next.market?.country ?? 'US');
        setLinkTemplate(next.market?.link_template ?? next.defaults.link_template);
      })
      .catch((e) => setError(messageOf(e)));
  }

  useEffect(load, [props.fetch]);

  const email = key.email ?? view?.connection.client_email;

  async function connect() {
    setError(null);
    try {
      const next = await checkThenActivate(
        (body) => callRoute(props.fetch, 'connection', body),
        { key: key.text || undefined, merchant_id: merchantId.trim(), country, link_template: linkTemplate.trim() },
        {
          phase: setBusy,
          checked: (answer) => {
            setChecks(answer.report.checks);
            setAllOk(answer.report.ok);
            setView((current) => current && { ...current, connection: answer.connection });
            if (answer.report.ok) setKey(NO_KEY);
          },
        },
      );
      if (next) setView(next);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  function requestConnect() {
    if (view?.connection.status === 'connected' && view.market && country !== view.market.country) setChangingCountry(true);
    else connect();
  }

  function changeCountry() {
    setChangingCountry(false);
    connect();
  }

  async function disconnect() {
    setBusy('disconnecting');
    setError(null);
    try {
      const next = await callRoute<StatusView>(props.fetch, 'connection', { op: 'disconnect', remove_products: removeProducts });
      setView(next);
      setChecks([]);
      setAllOk(false);
      setConfirming(false);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
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

  async function readKeyFile(file: File | undefined) {
    if (!file) return;
    try {
      const text = await file.text();
      setKey((current) => offerKey(current, text));
    } catch (e) {
      setError(messageOf(e));
    }
  }

  function pasteKey(text: string) {
    const next = offerKey(key, text);
    setKey(next);
    // A key that arrived leaves the box empty for the next one.
    setDraft(next.email && next.text === text ? '' : text);
  }

  async function chooseFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    await readKeyFile(input.files?.[0]);
    input.value = '';
  }

  function dropFile(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    readKeyFile(event.dataTransfer?.files?.[0]);
  }

  if (!view) {
    if (!error) return <Root>Loading…</Root>;
    return (
      <Root>
        <Notice tone="bad">{error}</Notice>
        <div>
          <Button onClick={load}>Retry</Button>
        </div>
      </Root>
    );
  }

  const status = view.connection.status;
  const connected = status === 'connected';
  const failedCheck = checks.some((check) => !check.ok);
  const states = stepStates(checks, allOk);
  const keyView = keyStepView(key, view.connection.has_key);
  const replaceButton = keyView.replace && (
    <Button kind="text" onClick={() => setKey(replaceKey)}>
      {keyView.replace}
    </Button>
  );

  const guide = (
    <div class="gmc-steps">
      <Step number={1} title="Google Cloud project" {...states.project}>
        <span class="gmc-muted">Create a project and enable the Merchant API in it.</span>
        <div class="gmc-links">
          <ExternalLink href="https://console.cloud.google.com/projectcreate">Create project</ExternalLink>
          <ExternalLink href="https://console.cloud.google.com/apis/library/merchantapi.googleapis.com">Enable Merchant API</ExternalLink>
        </div>
      </Step>

      <Step number={2} title="Service account key" {...states.key}>
        <span class="gmc-muted">Create a service account and add a JSON key under Keys.</span>
        <div class="gmc-links">
          <ExternalLink href="https://console.cloud.google.com/iam-admin/serviceaccounts">Service accounts</ExternalLink>
        </div>
        {keyView.chip && (
          <div class="gmc-actions">
            <Pill tone="ok">{keyView.chip}</Pill>
            {replaceButton}
            <Button kind="danger-text" onClick={() => setKey(NO_KEY)}>
              Remove
            </Button>
          </div>
        )}
        {keyView.stored && (
          <div class="gmc-actions">
            <span class="gmc-muted">A key is stored.</span>
            {replaceButton}
          </div>
        )}
        {keyView.inputs && (
          <>
            <label
              class={`gmc-drop${dragging ? ' over' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={dropFile}
            >
              <input type="file" accept="application/json,.json" onChange={chooseFile} />
              Drop the JSON key here, or click to choose a file
            </label>
            <details>
              <summary>Paste the key instead</summary>
              <textarea
                class="gmc-input"
                rows={3}
                aria-label="Service account key (JSON)"
                value={draft}
                placeholder='{"type": "service_account", …}'
                onInput={(event) => pasteKey(value(event))}
                style={{ marginTop: 8, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12 }}
              />
            </details>
          </>
        )}
        {key.error && <Notice tone="bad">{key.error}</Notice>}
      </Step>

      <Step number={3} title="Merchant Center access" {...states.access}>
        <span class="gmc-muted">
          Verify and claim your website (Settings → Business info → Website), then add the service account in Settings → People and access with Admin access.
        </span>
        <span class="gmc-muted">Set up shipping in Settings → Shipping and returns; without it Google disapproves every product.</span>
        <div class="gmc-links">
          <ExternalLink href="https://merchants.google.com/">Merchant Center</ExternalLink>
        </div>
        {email && (
          <Label text="Service account email">
            <div class="gmc-actions">
              <input ref={emailRef} class="gmc-input" style={{ flex: 1, width: 'auto' }} readOnly value={email} onFocus={(event) => (event.currentTarget as HTMLInputElement).select()} />
              <Button kind="secondary" onClick={copyEmail}>
                Copy
              </Button>
            </div>
          </Label>
        )}
      </Step>
    </div>
  );

  const connectStep = (
    <Step number={connected ? undefined : 4} title={connected ? 'Connection settings' : 'Connect'} {...states.connect}>
      <div class="gmc-grid">
        <Label text="Merchant Center account ID">
          <input class="gmc-input" value={merchantId} inputMode="numeric" onInput={(event) => setMerchantId(value(event))} />
        </Label>
        <Label text="Country you sell to">
          <select class="gmc-input" value={country} onChange={(event) => setCountry((event.currentTarget as unknown as HTMLSelectElement).value)}>
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </Label>
        <Label full text="Product link" hint="Where shoppers land from Google. Use {slug} or {product_id}; {variant_id} opens the variant.">
          <input class="gmc-input" value={linkTemplate} onInput={(event) => setLinkTemplate(value(event))} />
        </Label>
      </div>
      <div class="gmc-actions">
        <Button disabled={!!busy} onClick={requestConnect}>
          {busy === 'checking' ? 'Checking…' : busy === 'activating' ? 'Starting sync…' : status === 'disconnected' ? 'Connect' : 'Check again'}
        </Button>
        {status !== 'disconnected' && (
          <Button kind="danger-text" disabled={!!busy} onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        )}
      </div>
    </Step>
  );

  const attention = status === 'broken' || (failedCheck && !allOk);
  const market = view.market;

  return (
    <Root>
      <Card>
        <Pill tone={attention ? 'bad' : connected ? 'ok' : 'neutral'}>{attention ? 'Needs attention' : connected ? 'Connected' : 'Not connected'}</Pill>
        {status === 'broken' && (
          <Notice tone="bad">
            Google stopped accepting the connection{view.connection.last_error ? `: ${view.connection.last_error}` : ''}. Fix it and press Check again, or add a new key.
          </Notice>
        )}
        {status !== 'broken' && view.connection.last_error && <span style={{ color: 'var(--bad)' }}>{view.connection.last_error}</span>}
        {connected && (
          <dl class="gmc-facts">
            <dt>Account ID</dt>
            <dd>{view.connection.merchant_id}</dd>
            <dt>Service account</dt>
            <dd class="gmc-ellip" title={view.connection.client_email ?? undefined}>
              {view.connection.client_email}
            </dd>
            {market && (
              <>
                <dt>Country</dt>
                <dd>
                  {countryName(market.country)} ({market.language}, {market.currency})
                </dd>
                <dt>Product link</dt>
                <dd class="gmc-ellip" title={market.link_template}>
                  {market.link_template}
                </dd>
              </>
            )}
          </dl>
        )}
      </Card>

      {error && <Notice tone="bad">{error}</Notice>}

      {connected ? (
        <>
          <details class="gmc-guide" open={failedCheck}>
            <summary>Setup guide</summary>
            {guide}
          </details>
          {connectStep}
        </>
      ) : (
        <>
          {guide}
          {connectStep}
        </>
      )}

      {changingCountry && view.market && (
        <Modal title="Change the country?" onClose={() => setChangingCountry(false)}>
          <span>
            Your products listed for {countryName(view.market.country)} will be removed from Google and sent again for {countryName(country)}.
          </span>
          <div class="gmc-actions end">
            <Button kind="secondary" onClick={() => setChangingCountry(false)}>
              Cancel
            </Button>
            <Button kind="danger" disabled={!!busy} onClick={changeCountry}>
              Change country
            </Button>
          </div>
        </Modal>
      )}

      {confirming && (
        <Modal title="Disconnect Google Merchant Center?" onClose={() => setConfirming(false)}>
          <span>The app stops sending products and forgets the key.</span>
          <label style={{ display: 'flex', gap: 8 }}>
            <input type="checkbox" checked={removeProducts} onChange={(event) => setRemoveProducts((event.currentTarget as HTMLInputElement).checked)} />
            Also remove the products this store sent to Google
          </label>
          {error && <Notice tone="bad">{error}</Notice>}
          <div class="gmc-actions end">
            <Button kind="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button kind="danger" disabled={!!busy} onClick={disconnect}>
              Disconnect
            </Button>
          </div>
        </Modal>
      )}
    </Root>
  );
}
