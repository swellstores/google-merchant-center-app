import type { ComponentProps } from '@swell/apps-sdk/components';
import { useEffect, useRef, useState } from 'preact/hooks';
import { callRoute } from './lib/api';
import { dashboardModel, POLL_MS, type DashboardView } from './lib/dashboard';
import { Button, Card, ExternalLink, Modal, Notice, Pill, Progress, Root, Stack, Stat } from './lib/ui';

export const config = { description: 'Sync progress and product statuses in Google Merchant Center' };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Op = 'sync_all' | 'refresh_statuses';

export default function SyncDashboard(props: ComponentProps) {
  const [view, setView] = useState<DashboardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Op | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const fetchRef = useRef(props.fetch);
  fetchRef.current = props.fetch;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;

    const poll = () => {
      callRoute<DashboardView>(fetchRef.current, 'sync')
        .then((next) => {
          if (!alive) return;
          setView(next);
          setNow(Date.now());
          setError(null);
        })
        .catch((e) => alive && setError(messageOf(e)));
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const sync = () => {
      stop();
      if (document.visibilityState !== 'visible') return;
      poll();
      timer = setInterval(poll, POLL_MS);
    };

    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      alive = false;
      mounted.current = false;
      stop();
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  function run(op: Op) {
    setBusy(op);
    setError(null);
    callRoute<DashboardView>(props.fetch, 'sync', { op })
      .then((next) => {
        if (!mounted.current) return;
        setView(next);
        setNow(Date.now());
      })
      .catch((e) => mounted.current && setError(messageOf(e)))
      .finally(() => mounted.current && setBusy(null));
  }

  function confirmSyncAll() {
    setConfirming(false);
    run('sync_all');
  }

  if (!view) {
    return (
      <Root>
        {error ? (
          <Notice tone="bad">{error}</Notice>
        ) : (
          <span class="gmc-muted" role="status">
            Loading…
          </span>
        )}
        {error && (
          <div class="gmc-actions">
            <Button kind="secondary" onClick={() => location.reload()}>
              Reload
            </Button>
          </div>
        )}
      </Root>
    );
  }

  const model = dashboardModel(view, now);

  return (
    <Root>
      {model.banner && <Notice tone={model.banner.tone}>{model.banner.text}</Notice>}
      {error && <Notice tone="bad">{error}</Notice>}

      {model.account && (
        <div style={{ background: 'var(--warn-bg)', borderLeft: '4px solid var(--warn)', borderRadius: 8, padding: 16 }}>
          <Stack gap={12}>
            <Stack gap={4}>
              <h3 class="gmc-title">{model.account.title}</h3>
              <span>{model.account.lead}</span>
            </Stack>
            <Stack as="ul" gap={12}>
              {model.account.rows.map((row, i) => (
                <li key={i}>
                  <Stack gap={4}>
                    <strong>{row.title}</strong>
                    {row.meta && <div class="gmc-muted">{row.meta}</div>}
                    {row.action && <div>{row.action}</div>}
                    {row.documentation && <ExternalLink href={row.documentation}>How to fix</ExternalLink>}
                  </Stack>
                </li>
              ))}
            </Stack>
            {model.account.merchantUrl && <ExternalLink href={model.account.merchantUrl}>Open Merchant Center</ExternalLink>}
          </Stack>
        </div>
      )}

      <Card>
        <div class="gmc-stats">
          {model.stats.map((stat) => (
            <Stat key={stat.key} label={stat.label} value={stat.value} tone={stat.tone} />
          ))}
        </div>
        {model.refreshedText && <span class="gmc-muted">{model.refreshedText}</span>}
        {model.queueText && <span class="gmc-muted">{model.queueText}</span>}
        {model.progress.map((line) => (
          <Progress key={line.label} {...line} />
        ))}
        <div class="gmc-actions">
          <Button disabled={!model.canSyncAll || busy !== null} onClick={() => setConfirming(true)}>
            {busy === 'sync_all' ? 'Starting…' : 'Sync all'}
          </Button>
          <Button kind="secondary" disabled={!model.canRefresh || busy !== null} onClick={() => run('refresh_statuses')}>
            {busy === 'refresh_statuses' ? 'Starting…' : 'Refresh statuses'}
          </Button>
        </div>
      </Card>

      {model.issues.length > 0 && (
        <Card>
          <Stack gap={12}>
            <h3 class="gmc-title">Top issues</h3>
            <Stack as="ul" gap={16} divided>
              {model.issues.map((issue) => (
                <li key={issue.key}>
                  <Stack gap={4}>
                    <div class="gmc-actions">
                      <Pill tone={issue.severity.tone}>{issue.severity.label}</Pill>
                      <strong>{issue.description}</strong>
                    </div>
                    <div class="gmc-muted">{issue.sampleText}</div>
                    {issue.documentation && <ExternalLink href={issue.documentation}>Google help</ExternalLink>}
                  </Stack>
                </li>
              ))}
            </Stack>
          </Stack>
        </Card>
      )}

      {confirming && (
        <Modal title="Sync all products?" onClose={() => setConfirming(false)}>
          <span>Every product is sent to Google again. Use it after changes made outside Swell or when Google lost products.</span>
          <div class="gmc-actions end">
            <Button kind="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button onClick={confirmSyncAll}>Sync all</Button>
          </div>
        </Modal>
      )}
    </Root>
  );
}
