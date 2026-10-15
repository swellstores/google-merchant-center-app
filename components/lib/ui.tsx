import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';

export const theme = {
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  text: '#1f2937',
  muted: '#6b7280',
  border: '#d1d5db',
  ok: '#047857',
  okBg: '#ecfdf5',
  bad: '#b91c1c',
  badBg: '#fef2f2',
  info: '#1d4ed8',
  infoBg: '#eff6ff',
  accent: '#111827',
};

export function Stack({ gap = 12, children }: { gap?: number; children: ComponentChildren }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap, fontFamily: theme.font, color: theme.text, fontSize: 14 }}>{children}</div>;
}

export function Button(props: { kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; onClick: () => void; children: ComponentChildren }) {
  const kind = props.kind ?? 'primary';
  const colors = {
    primary: { background: theme.accent, color: '#fff', border: theme.accent },
    secondary: { background: '#fff', color: theme.text, border: theme.border },
    danger: { background: '#fff', color: theme.bad, border: theme.bad },
  }[kind];
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        ...colors,
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        padding: '7px 14px',
        font: 'inherit',
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.6 : 1,
      }}
    >
      {props.children}
    </button>
  );
}

export function Notice({ tone, children }: { tone: 'ok' | 'bad' | 'info'; children: ComponentChildren }) {
  const colors = { ok: [theme.ok, theme.okBg], bad: [theme.bad, theme.badBg], info: [theme.info, theme.infoBg] }[tone];
  return <div style={{ color: colors[0], background: colors[1], borderRadius: 6, padding: '10px 12px' }}>{children}</div>;
}

export function Label({ text, hint, children }: { text: string; hint?: ComponentChildren; children: ComponentChildren }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontWeight: 600 }}>{text}</span>
      {children}
      {hint && <span style={{ color: theme.muted, fontSize: 13 }}>{hint}</span>}
    </label>
  );
}

export const inputStyle = {
  font: 'inherit',
  padding: '7px 10px',
  border: `1px solid ${theme.border}`,
  borderRadius: 6,
  color: theme.text,
  background: '#fff',
} as const;

export function Checklist({ items }: { items: { ok: boolean; message: string; help?: string }[] }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((item) => (
        <li key={item.message} style={{ display: 'flex', gap: 8 }}>
          <span aria-hidden="true" style={{ color: item.ok ? theme.ok : theme.bad, fontWeight: 700 }}>
            {item.ok ? '✓' : '✕'}
          </span>
          <span>
            {item.message}
            {item.help && <div style={{ color: theme.muted, fontSize: 13 }}>{item.help}</div>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Covers the admin while open: a fixed element rendered straight into document.body. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ComponentChildren }) {
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(event) => event.key === 'Escape' && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(17, 24, 39, 0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: theme.font }}
    >
      <div style={{ background: '#fff', borderRadius: 8, padding: 20, width: 'min(480px, 90vw)' }}>
        <Stack>
          <strong style={{ fontSize: 16 }}>{title}</strong>
          {children}
        </Stack>
      </div>
    </div>,
    document.body,
  );
}
