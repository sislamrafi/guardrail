'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Ico } from '../icons';
import { Field, Loading, Page, Section, Seg, Switch } from '../kit';
import { useNav } from '../nav';
import { api, useStore, useUi } from '../store';
import { THEMES, useTheme } from '../theme';

export function SettingsPage() {
  const { data, error } = useStore();
  const ui = useUi();
  const nav = useNav();
  const [rate, setRate] = useState<string | null>(null);
  const [theme, setTheme] = useTheme();
  if (!data) return <Loading error={error} />;
  const s = data.settings;
  const patch = (body: Record<string, unknown>, ok: string) => ui.run(() => api('settings', { method: 'PATCH', body }), ok);
  return (
    <Page icon="settings" title="Settings" sub="Gateway-wide defaults. Groups can change most of them for their own keys.">
      <section id="sec-appearance">
        <Section title="Appearance" hint="Remembered in this browser.">
          <Field label="Theme">
            <Seg value={theme} label="Theme" onChange={setTheme} options={THEMES.map(([v, l]) => [v, l] as [typeof v, string])} />
          </Field>
        </Section>
      </section>
      <section id="sec-general">
        <Section title="General">
          <div className="cx-form-row">
            <Field label="Default rate limit (requests per minute, per key)" hint="Used when no group sets its own.">
              <input className="cx-input" type="number" min={1} value={rate ?? String(s.defaultRateLimit)} onChange={(e) => setRate(e.target.value)} />
            </Field>
            <button type="button" className="cx-btn pri tall" disabled={rate === null || Number(rate) === s.defaultRateLimit || !Number(rate)} onClick={async () => (await patch({ defaultRateLimit: Number(rate) }, 'Default rate limit saved')) && setRate(null)}>
              Save
            </button>
          </div>
          <Field label="Client address" hint={s.trustProxy ? 'The first X-Forwarded-For entry is used. Only safe when every request comes through your own reverse proxy.' : 'The address that actually connected is used; a client cannot fake it with headers. Turn on only behind your own reverse proxy.'}>
            <div className="cx-form-row center">
              <Switch on={s.trustProxy} label="Trust X-Forwarded-For from a reverse proxy" onChange={(v) => void patch({ trustProxy: v }, v ? 'Trusting the proxy header' : 'Using the connecting address')} />
              <span>Trust X-Forwarded-For from a reverse proxy (used for key IP limits and logs)</span>
            </div>
          </Field>
          <Field label="Schema policy">
            <Seg value={s.schemaPolicy} label="Schema policy" onChange={(p) => void patch({ schemaPolicy: p }, 'Schema policy saved')} options={[['strict', 'Strict (reject mismatches)'], ['accept_known', 'Log only']]} />
          </Field>
          <div className="cx-form-row">
            <button type="button" className="cx-btn" onClick={() => nav.go('/guard')}>
              <Ico n="guard" size={14} /> Guard check defaults
            </button>
            <button type="button" className="cx-btn" onClick={() => nav.go('/schemas')}>
              <Ico n="braces" size={14} /> Schemas
            </button>
          </div>
        </Section>
      </section>
      <section id="sec-context">
        <Section title="Context and policy prompt" hint="Where context goes and the policy prompt every request starts with.">
          <Field label="Context placement">
            <Seg
              value={s.contextPlacement}
              label="Context placement"
              onChange={(p) => void patch({ contextPlacement: p }, 'Placement saved')}
              options={[
                ['top', 'Top of the system prompt (cacheable)'],
                ['end', 'Before the last user message'],
              ]}
            />
          </Field>
          <button type="button" className="cx-btn" onClick={() => nav.go('/context')}>
            <Ico n="context" size={14} /> Edit the policy prompt and files
          </button>
        </Section>
      </section>
      <section id="sec-limits">
        <Section title="Server and model limits" hint="Rate limits and group restrictions for all servers, one server or one model.">
          <button type="button" className="cx-btn" onClick={() => nav.go('/servers')}>
            <Ico n="servers" size={14} /> Open limits in Servers
          </button>
        </Section>
      </section>
      <section id="sec-account">
        <Section title="Account">
          <p>
            Signed in as <b>{data.summary.name}</b>. {data.summary.authEnabled ? 'The admin panel is protected by GUARDRAIL_ADMIN_PASSWORD.' : 'No admin password is set, so anyone who can reach this address can manage the gateway. Set GUARDRAIL_ADMIN_PASSWORD in .env.'}
          </p>
          <div className="cx-form-row">
            {data.summary.authEnabled && (
              <button
                type="button"
                className="cx-btn"
                onClick={async () => {
                  await fetch('/api/auth/logout', { method: 'POST' });
                  window.location.href = '/login';
                }}
              >
                Sign out
              </button>
            )}
            <Link className="cx-btn" href="/old">
              Open the classic admin panel
            </Link>
          </div>
        </Section>
      </section>
    </Page>
  );
}
