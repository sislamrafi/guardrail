'use client';

import { type CSSProperties, type ReactNode, useEffect, useId } from 'react';
import { Ico, type IconName } from './icons';

// ---------------------------------------------------------------- formatting

export const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '–' : n.toLocaleString('en'));
export const fmtTokens = (n: number | null | undefined) => (n == null ? '–' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
export const ms = (v: number | null | undefined) => (v == null ? '–' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);
export const clock = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
export function ago(t: number | null | undefined) {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
export function price(inp: number | null | undefined, out: number | null | undefined): string | null {
  if (inp == null && out == null) return null;
  if (inp === 0 && out === 0) return 'Free';
  const f = (n: number | null | undefined) => (n == null ? '?' : n === 0 ? 'free' : `$${n < 0.01 ? n.toPrecision(2) : n.toFixed(2)}`);
  return `${f(inp)} in · ${f(out)} out /1M`;
}

/** Props for a secret field that browsers and password managers leave alone (masked text, not a password input). */
export const secretProps = {
  type: 'text',
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
  style: { WebkitTextSecurity: 'disc' } as CSSProperties,
} as const;

// ---------------------------------------------------------------- layout pieces

/** One editor page: header with title and actions, then scrolling content. */
export function Page({ icon, title, sub, actions, children, wide }: { icon?: IconName; title: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="cx-page">
      <div className={`cx-page-in ${wide ? 'wide' : ''}`}>
        <header className="cx-page-head">
          <div className="cx-page-title">
            <h1>
              {icon && <Ico n={icon} size={20} />}
              {title}
            </h1>
            {sub && <p>{sub}</p>}
          </div>
          {actions && <div className="cx-page-acts">{actions}</div>}
        </header>
        {children}
      </div>
    </div>
  );
}

export function Section({ title, hint, actions, children }: { title: string; hint?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="cx-sec">
      <div className="cx-sec-head">
        <h2>{title}</h2>
        {actions && <div className="cx-sec-acts">{actions}</div>}
      </div>
      {hint && <p className="cx-hint">{hint}</p>}
      {children}
    </section>
  );
}

export function Field({ label, hint, children, grow }: { label: ReactNode; hint?: ReactNode; children: ReactNode; grow?: boolean }) {
  return (
    <label className={`cx-field ${grow ? 'grow' : ''}`}>
      <span className="cx-field-label">{label}</span>
      {children}
      {hint && <span className="cx-field-hint">{hint}</span>}
    </label>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled} className={`cx-switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="cx-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Pill({ tone, children, title }: { tone?: 'ok' | 'warn' | 'bad' | 'info' | ''; children: ReactNode; title?: string }) {
  return (
    <span className={`cx-pill ${tone ?? ''}`} title={title}>
      {children}
    </span>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={`cx-stat ${tone ?? ''}`} title={hint}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="cx-empty-block">
      {icon && <Ico n={icon} size={28} stroke={1.2} />}
      <b>{title}</b>
      {children && <div>{children}</div>}
    </div>
  );
}

export function Loading({ error, label = 'Loading…' }: { error?: string | null; label?: string }) {
  return error ? (
    <div className="cx-error" role="alert">
      <Ico n="blocked" size={14} /> {error}
    </div>
  ) : (
    <div className="cx-loading" aria-busy="true">
      <span className="cx-spin" /> {label}
    </div>
  );
}

export function Note({ tone, children }: { tone?: 'warn' | 'bad'; children: ReactNode }) {
  return <div className={`cx-note ${tone ?? ''}`}>{children}</div>;
}

/** A modal form dialog. Escape and the backdrop close it. */
export function Dialog({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const id = useId();
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="cx-overlay" onMouseDown={onClose}>
      <div className={`cx-dialog form ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} onMouseDown={(e) => e.stopPropagation()}>
        <div className="cx-dialog-head">
          <h3 id={id}>{title}</h3>
          <button type="button" className="cx-icon-btn" aria-label="Close" onClick={onClose}>
            <Ico n="close" />
          </button>
        </div>
        <div className="cx-dialog-body">{children}</div>
        {footer && <div className="cx-dialog-acts">{footer}</div>}
      </div>
    </div>
  );
}

export function IconBtn({ icon, label, onClick, disabled, active }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <button type="button" className={`cx-icon-btn ${active ? 'on' : ''}`} aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      <Ico n={icon} />
    </button>
  );
}

/** Group chooser with tree indentation. */
export function GroupSelect({ groups, value, onChange, id, exclude, allLabel }: { groups: { id: number; name: string; depth: number }[]; value: number | null; onChange: (id: number | null) => void; id?: string; exclude?: Set<number>; allLabel?: string }) {
  return (
    <select id={id} className="cx-input" value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      {allLabel && <option value="">{allLabel}</option>}
      {groups
        .filter((g) => !exclude?.has(g.id))
        .map((g) => (
          <option key={g.id} value={g.id}>
            {'  '.repeat(g.depth)}
            {g.name}
          </option>
        ))}
    </select>
  );
}
