import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef } from 'preact/hooks';

import type { Tone } from './tone';

export type { Tone };

const CSS = `
.gmc {
  --text: #1f2937; --muted: #5f6672; --border: #d1d5db;
  --surface: #ffffff; --field: #ffffff; --subtle: #f3f4f6;
  --accent: #2563eb; --accent-text: #ffffff;
  --ok: #047857; --ok-bg: #ecfdf5;
  --bad: #b91c1c; --bad-bg: #fef2f2;
  --info: #1d4ed8; --info-bg: #eff6ff;
  color-scheme: light dark;
  color: var(--text);
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  .gmc {
    --text: #e5e7eb; --muted: #9ca3af; --border: #3f3f46;
    --surface: #1c1c1f; --field: #141416; --subtle: #26262b;
    --accent: #60a5fa; --accent-text: #0b1220;
    --ok: #34d399; --ok-bg: rgba(52, 211, 153, .12);
    --bad: #f87171; --bad-bg: rgba(248, 113, 113, .12);
    --info: #93c5fd; --info-bg: rgba(147, 197, 253, .12);
  }
}
.gmc *, .gmc *::before, .gmc *::after { box-sizing: border-box; }
.gmc-root { container-type: inline-size; display: flex; flex-direction: column; gap: 16px; }
.gmc a { color: var(--accent); }
.gmc button:focus-visible, .gmc input:focus-visible, .gmc select:focus-visible, .gmc textarea:focus-visible,
.gmc summary:focus-visible, .gmc .gmc-drop:focus-within, .gmc a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.gmc-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.gmc-row { display: flex; gap: 12px; align-items: flex-start; }
.gmc-row > .gmc-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.gmc-title { font-size: 16px; font-weight: 600; margin: 0; }
.gmc-muted { color: var(--muted); font-size: 13px; }
.gmc-links { display: flex; flex-wrap: wrap; gap: 4px 16px; }
.gmc-badge { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 28px; height: 28px; border-radius: 999px; font-weight: 700; font-size: 13px; border: 1px solid var(--border); color: var(--muted); background: var(--subtle); }
.gmc-badge.ok { color: var(--ok); background: var(--ok-bg); border-color: var(--ok); }
.gmc-badge.bad { color: var(--bad); background: var(--bad-bg); border-color: var(--bad); }
.gmc-pill { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; border-radius: 999px; padding: 2px 10px; font-weight: 600; font-size: 13px; color: var(--muted); background: var(--subtle); border: 1px solid var(--border); }
.gmc-pill.ok { color: var(--ok); background: var(--ok-bg); border-color: var(--ok); }
.gmc-pill.bad { color: var(--bad); background: var(--bad-bg); border-color: var(--bad); }
.gmc-pill.info { color: var(--info); background: var(--info-bg); border-color: var(--info); }
.gmc-notice { border-radius: 6px; padding: 10px 12px; }
.gmc-notice.ok { color: var(--ok); background: var(--ok-bg); }
.gmc-notice.bad { color: var(--bad); background: var(--bad-bg); }
.gmc-notice.info { color: var(--info); background: var(--info-bg); }
.gmc-notice.neutral { color: var(--muted); background: var(--subtle); }
.gmc-btn { font: inherit; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; }
.gmc-btn:hover:not(:disabled) { background: var(--subtle); }
.gmc-btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.gmc-btn.primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.1); }
.gmc-btn.danger { color: var(--bad); border-color: var(--bad); }
.gmc-btn.text { border-color: transparent; background: transparent; padding: 7px 8px; color: var(--accent); }
.gmc-btn.text.danger { border-color: transparent; color: var(--bad); }
.gmc-btn.text:hover:not(:disabled) { background: var(--subtle); }
.gmc-btn:disabled { cursor: default; opacity: .6; }
.gmc-label { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.gmc-label > .gmc-name { font-weight: 600; }
.gmc-input { font: inherit; width: 100%; padding: 7px 10px; border: 1px solid var(--border); border-radius: 6px; color: var(--text); background: var(--field); }
.gmc-input::placeholder { color: var(--muted); }
.gmc-input[readonly] { background: var(--subtle); }
.gmc-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
.gmc-grid .full { grid-column: 1 / -1; }
@container (min-width: 560px) { .gmc-grid { grid-template-columns: 1fr 1fr; } }
.gmc-drop { position: relative; display: flex; align-items: center; justify-content: center; text-align: center; padding: 20px 16px; border: 2px dashed var(--border); border-radius: 8px; background: var(--field); color: var(--muted); cursor: pointer; }
.gmc-drop:hover, .gmc-drop.over { border-color: var(--accent); }
.gmc-drop input { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; clip-path: inset(50%); }
.gmc details > summary { cursor: pointer; color: var(--accent); }
.gmc-guide { display: block; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
.gmc-guide > summary { font-weight: 600; font-size: 16px; color: var(--text); }
.gmc-guide[open] > summary { margin-bottom: 12px; }
.gmc-steps { display: flex; flex-direction: column; gap: 12px; }
.gmc-result { display: flex; gap: 8px; align-items: baseline; }
.gmc-result.ok { color: var(--ok); }
.gmc-result.bad { color: var(--bad); }
.gmc-ellip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gmc-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 16px; margin: 0; }
.gmc-facts dt { color: var(--muted); }
.gmc-facts dd { margin: 0; min-width: 0; }
.gmc-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
@container (min-width: 560px) { .gmc-stats { grid-template-columns: repeat(3, 1fr); } }
.gmc-stat { background: var(--subtle); border: 1px solid var(--border); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 2px; }
.gmc-stat-value { font-size: 24px; font-weight: 700; line-height: 1.2; }
.gmc-stat.ok .gmc-stat-value { color: var(--ok); }
.gmc-stat.bad .gmc-stat-value { color: var(--bad); }
.gmc-stat.info .gmc-stat-value { color: var(--info); }
.gmc-progress { display: flex; flex-direction: column; gap: 4px; }
.gmc-progress-head { display: flex; justify-content: space-between; gap: 8px; }
.gmc-bar { height: 8px; border-radius: 999px; background: var(--subtle); border: 1px solid var(--border); overflow: hidden; }
.gmc-bar > span { display: block; height: 100%; background: var(--accent); }
.gmc-bar.unknown > span { width: 30%; animation: gmc-slide 1.4s ease-in-out infinite alternate; }
@keyframes gmc-slide { from { margin-left: 0; } to { margin-left: 70%; } }
@media (prefers-reduced-motion: reduce) { .gmc-bar.unknown > span { animation: none; } }
.gmc-stack { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.gmc-stack.divided > * + * { border-top: 1px solid var(--border); padding-top: 16px; }
.gmc-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 12px; }
.gmc-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, .5); display: flex; align-items: center; justify-content: center; }
.gmc-modal { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 20px; width: min(480px, 90vw); box-shadow: 0 10px 30px rgba(0, 0, 0, .35); display: flex; flex-direction: column; gap: 12px; }
.gmc-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.gmc-actions > .gmc-pill { align-self: center; }
.gmc-actions.end { justify-content: flex-end; }
`;

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

export function Root({ children }: { children: ComponentChildren }) {
  return (
    <div class="gmc gmc-root">
      <style>{CSS}</style>
      {children}
    </div>
  );
}

export function Card({ children }: { children: ComponentChildren }) {
  return <div class="gmc-card">{children}</div>;
}

export function Button(props: { kind?: 'primary' | 'secondary' | 'danger' | 'text' | 'danger-text'; disabled?: boolean; onClick: () => void; children: ComponentChildren }) {
  const kind = props.kind ?? 'primary';
  const classes = { primary: 'primary', secondary: '', danger: 'danger', text: 'text', 'danger-text': 'text danger' }[kind];
  return (
    <button type="button" class={cx('gmc-btn', classes)} disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  );
}

export type Gap = 4 | 8 | 12 | 16 | 24;

/** A column with an even gap; `divided` puts a 1px rule, with the gap as padding, between the items. */
export function Stack({ gap, divided, as = 'div', children }: { gap: Gap; divided?: boolean; as?: 'div' | 'ul'; children: ComponentChildren }) {
  const Tag = as;
  return (
    <Tag class={cx('gmc-stack', divided && 'divided')} style={{ gap }}>
      {children}
    </Tag>
  );
}

export function Notice({ tone, children }: { tone: Tone; children: ComponentChildren }) {
  return (
    <div class={cx('gmc-notice', tone)} role={tone === 'bad' ? 'alert' : undefined}>
      {children}
    </div>
  );
}

export function Pill({ tone, children }: { tone: Tone; children: ComponentChildren }) {
  return <span class={cx('gmc-pill', tone)}>{children}</span>;
}

export function Label({ text, hint, full, children }: { text: string; hint?: ComponentChildren; full?: boolean; children: ComponentChildren }) {
  return (
    <label class={cx('gmc-label', full && 'full')}>
      <span class="gmc-name">{text}</span>
      {children}
      {hint && <span class="gmc-muted">{hint}</span>}
    </label>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ComponentChildren }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children} ↗
    </a>
  );
}

export function Stat({ label, value, tone }: { label: string; value: number | null; tone: Tone }) {
  return (
    <div class={cx('gmc-stat', tone)}>
      <span class="gmc-muted">{label}</span>
      <span class="gmc-stat-value">{value === null ? '—' : value.toLocaleString('en-US')}</span>
    </div>
  );
}

/** A bar with a known total, or a moving one while the total is not known. */
export function Progress({ label, done, total }: { label: string; done: number; total: number | null }) {
  const known = total !== null && total > 0;
  const percent = known ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div class="gmc-progress">
      <div class="gmc-progress-head">
        <span>{label}</span>
        <span class="gmc-muted">{total === null ? done.toLocaleString('en-US') : `${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`}</span>
      </div>
      <div class={cx('gmc-bar', !known && 'unknown')} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={known ? total : undefined} aria-valuenow={known ? done : undefined}>
        <span style={known ? { width: `${percent}%` } : undefined} />
      </div>
    </div>
  );
}

/** One setup step: a number (or ✓ / ✕ after a check), a title, a description and the controls. */
export function Step(props: {
  number?: number;
  title: string;
  status: 'idle' | 'ok' | 'failed';
  problems: { id: string; message: string; help?: string }[];
  children: ComponentChildren;
}) {
  const badge = props.number === undefined ? null : props.status === 'ok' ? '✓' : props.status === 'failed' ? '✕' : String(props.number);
  return (
    <div class="gmc-card">
      <div class="gmc-row">
        {badge && (
          <span class={cx('gmc-badge', props.status === 'ok' && 'ok', props.status === 'failed' && 'bad')} aria-hidden="true">
            {badge}
          </span>
        )}
        <div class="gmc-body">
          <h3 class="gmc-title">{props.title}</h3>
          {props.children}
          {props.problems.map((problem) => (
            <div key={problem.id} class="gmc-result bad" role="alert">
              <span aria-hidden="true">✕</span>
              <span>
                {problem.message}
                {problem.help && <div class="gmc-muted">{problem.help}</div>}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Covers the admin while open: a fixed element rendered straight into document.body. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ComponentChildren }) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('button, input, select, textarea')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);
  return createPortal(
    <div class="gmc gmc-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div ref={dialog} class="gmc-modal">
        <strong class="gmc-title">{title}</strong>
        {children}
      </div>
    </div>,
    document.body,
  );
}
