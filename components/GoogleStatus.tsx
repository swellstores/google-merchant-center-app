import type { ComponentProps } from '@swell/apps-sdk/components';
import { useEffect, useRef, useState } from 'preact/hooks';
import { callRoute } from './lib/api';
import { issueSeverity, statusPanelModel, type OfferIssue, type ProductStatusView, type StatusIssue } from './lib/status-view';
import { Button, Card, ExternalLink, Notice, Pill, Root, Stack } from './lib/ui';

export const config = { description: 'The live Google Merchant Center status of a product' };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const BORDERS = { bad: 'var(--bad)', info: 'var(--info)', ok: 'var(--ok)', neutral: 'var(--muted)' };

function OfferIssues({ issues }: { issues: OfferIssue[] }) {
  return (
    <Stack as="ul" gap={12}>
      {issues.map((issue) => (
        <li key={issue.code} style={{ borderLeft: `3px solid ${BORDERS[issue.tone]}`, paddingLeft: 12 }}>
          <Stack gap={4}>
            <strong>{issue.description}</strong>
            {issue.detail && <div class="gmc-muted">{issue.detail}</div>}
            {issue.documentation && <ExternalLink href={issue.documentation}>Google help</ExternalLink>}
          </Stack>
        </li>
      ))}
    </Stack>
  );
}

function Issues({ issues }: { issues: StatusIssue[] }) {
  return (
    <Stack as="ul" gap={16} divided>
      {issues.map((issue) => {
        const severity = issueSeverity(issue.severity);
        return (
          <li key={issue.code}>
            <Stack gap={4}>
              <div class="gmc-actions">
                <Pill tone={severity.tone}>{severity.label}</Pill>
                <strong>{issue.description}</strong>
              </div>
              {issue.detail && <div class="gmc-muted">{issue.detail}</div>}
              {issue.documentation && <ExternalLink href={issue.documentation}>Google help</ExternalLink>}
            </Stack>
          </li>
        );
      })}
    </Stack>
  );
}

export default function GoogleStatus(props: ComponentProps) {
  const id = (props.context?.record as { id?: string } | undefined)?.id;
  const [view, setView] = useState<ProductStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const fetchRef = useRef(props.fetch);
  fetchRef.current = props.fetch;
  const mounted = useRef(true);

  const [attempt, setAttempt] = useState(0);

  function fetchStatus(isCurrent: () => boolean) {
    callRoute<ProductStatusView>(fetchRef.current, `product?id=${encodeURIComponent(id!)}`)
      .then((next) => {
        if (!isCurrent()) return;
        setView(next);
        setError(null);
      })
      .catch((e) => isCurrent() && setError(messageOf(e)));
  }

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    mounted.current = true;
    setView(null);
    setError(null);
    fetchStatus(() => !cancelled);
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [id, attempt]);

  function resend() {
    setBusy(true);
    setQueued(false);
    setError(null);
    callRoute<{ queued: true }>(props.fetch, 'product', { op: 'resend', id })
      .then(() => {
        if (!mounted.current) return;
        setQueued(true);
        fetchStatus(() => mounted.current);
      })
      .catch((e) => mounted.current && setError(messageOf(e)))
      .finally(() => mounted.current && setBusy(false));
  }

  if (!id) {
    return (
      <Root>
        <span class="gmc-muted">Save the product to send it to Google.</span>
      </Root>
    );
  }

  if (!view) {
    return (
      <Root>
        {error ? (
          <>
            <Notice tone="bad">{error}</Notice>
            <div class="gmc-actions">
              <Button kind="text" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            </div>
          </>
        ) : (
          <span class="gmc-muted" role="status">
            Checking Google…
          </span>
        )}
      </Root>
    );
  }

  const model = statusPanelModel(view, Date.now());

  return (
    <Root>
      <Card>
        <Stack gap={16}>
          <Stack gap={4}>
            <div class="gmc-actions">
              <Pill tone={model.headline.tone}>{model.headline.text}</Pill>
              {model.checked && <span class="gmc-muted">{model.checked}</span>}
            </div>
            {view.stored.status === 'excluded' && <span class="gmc-muted">Turn off “Hide from Google” below to list it again.</span>}
            {model.note && <span class="gmc-muted">{model.note}</span>}
          </Stack>
          {model.refusal && <Notice tone="bad">{model.refusal}</Notice>}
          {model.markets.length > 0 && (
            <Stack gap={24}>
              {model.markets.map((group) => (
                <Stack key={group.market} gap={8}>
                  <strong>{group.heading}</strong>
                  <Stack as="ul" gap={16} divided>
                    {group.offers.map((offer, i) => (
                      <li key={i}>
                        <Stack gap={8}>
                          <div class="gmc-actions">
                            <Pill tone={offer.tone}>{offer.text}</Pill>
                            <span>{offer.title}</span>
                          </div>
                          {offer.issues.length > 0 && <OfferIssues issues={offer.issues} />}
                        </Stack>
                      </li>
                    ))}
                  </Stack>
                </Stack>
              ))}
            </Stack>
          )}
          {model.issues.length > 0 && <Issues issues={model.issues} />}
          {error && <Notice tone="bad">{error}</Notice>}
          {queued && <Notice tone="ok">Queued. Google gets it within a minute.</Notice>}
          {model.lastSent && <span class="gmc-muted">{model.lastSent}</span>}
          {model.canResend && (
            <div class="gmc-actions">
              <Button kind="secondary" disabled={busy} onClick={resend}>
                {busy ? 'Queuing…' : 'Resend now'}
              </Button>
            </div>
          )}
        </Stack>
      </Card>
    </Root>
  );
}
