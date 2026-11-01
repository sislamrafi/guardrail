'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SaveState, useAutoSave, useAutoSavePrefs, useQuietSave } from '../autosave';
import { Ico } from '../icons';
import { useChatMarkdown } from '../md-text';
import { Field, Loading, Page, Section, Seg, Switch, ago, clock } from '../kit';
import { useNav } from '../nav';
import { api, useStore, useUi } from '../store';
import { resetUiPrefs, usePref } from '../prefs';
import { previewSplash } from '../splash';
import { THEMES, useTheme } from '../theme';
import { SPLASH_GAP_HOURS } from '../theme-boot';

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
          <SplashSettings />
          <AutoSaveSettings />
          <ChatMarkdownSetting />
          <ReopenTabsSetting />
          <Field label="Layout and views" hint="Panel sizes, open tabs, expanded groups, tree or list views, filters and the tab each group was on are remembered in this browser.">
            <div className="cx-form-row">
              <button
                type="button"
                className="cx-btn"
                onClick={async () => {
                  if (!(await ui.confirm({ title: 'Reset the UI layout?', body: 'Panel sizes, open tabs, expanded groups, view choices and filters go back to their defaults in this browser. Theme and splash settings stay.', ok: 'Reset layout' }))) return;
                  resetUiPrefs();
                  window.location.assign('/settings');
                }}
              >
                <Ico n="refresh" size={13} /> Reset UI layout
              </button>
            </div>
          </Field>
        </Section>
      </section>
      <section id="sec-general">
        <Section title="General">
          <div className="cx-form-row">
            <Field label="Default rate limit (requests per minute, per key)" hint="Used when no group sets its own.">
              <input className="cx-input" type="number" min={1} value={rate ?? String(s.defaultRateLimit)} onChange={(e) => setRate(e.target.value)} />
            </Field>
            <RateAutoSave rate={rate} current={s.defaultRateLimit} onSaved={() => setRate(null)} />
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
        {data.summary.authEnabled && <Sessions />}
      </section>
    </Page>
  );
}

const local = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  },
};

/** The splash screen shown on the first load, or after a gap: on/off and the gap, per browser. */
function SplashSettings() {
  const [on, setOn] = useState(true);
  const [gap, setGap] = useState(SPLASH_GAP_HOURS);
  useEffect(() => {
    setOn(local.get('cx-splash-off') !== '1');
    setGap(Number(local.get('cx-splash-gap-h')) || SPLASH_GAP_HOURS);
  }, []);
  return (
    <Field label="Splash screen" hint={on ? `A 5–10 second GuardRail loading screen when the console opens after ${gap} hours or more away.` : 'Off in this browser.'}>
      <div className="cx-form-row center">
        <Switch
          on={on}
          label="Show the splash screen"
          onChange={(v) => {
            setOn(v);
            local.set('cx-splash-off', v ? '0' : '1');
          }}
        />
        <select
          className="cx-input"
          aria-label="Show it after"
          disabled={!on}
          value={gap}
          onChange={(e) => {
            setGap(Number(e.target.value));
            local.set('cx-splash-gap-h', e.target.value);
          }}
        >
          {[1, 3, 6, 12, 24, 72].map((h) => (
            <option key={h} value={h}>
              after {h < 24 ? `${h} hour${h > 1 ? 's' : ''}` : `${h / 24} day${h > 24 ? 's' : ''}`} away
            </option>
          ))}
        </select>
        <button type="button" className="cx-btn" onClick={previewSplash}>
          <Ico n="studio" size={13} /> Preview
        </button>
      </div>
    </Field>
  );
}

/** The default rate limit field saves itself like every other edit. */
function RateAutoSave({ rate, current, onSaved }: { rate: string | null; current: number; onSaved: () => void }) {
  const quiet = useQuietSave();
  const auto = useAutoSave({
    value: rate,
    dirty: rate !== null && Number(rate) !== current,
    invalid: rate !== null && !(Number(rate) >= 1) ? 'Use a whole number of 1 or more.' : null,
    save: async () => {
      await quiet(() => api('settings', { method: 'PATCH', body: { defaultRateLimit: Number(rate) } }));
      onSaved();
    },
  });
  return (
    <div className="cx-form-row center">
      <SaveState s={auto} />
      <button type="button" className="cx-btn tall" disabled={rate === null || Number(rate) === current || !Number(rate)} onClick={() => void auto.flush()}>
        Save
      </button>
    </div>
  );
}

/** Autosave on/off and its delay, remembered in this browser. */
function AutoSaveSettings() {
  const [p, setP] = useAutoSavePrefs();
  return (
    <Field label="Auto save" hint={p.on ? `Edits save themselves ${p.ms / 1000} seconds after you stop typing, and when you leave the page. ⌘S saves at once. Deleting, revoking and server connections always ask first.` : 'Off: use Save or ⌘S.'}>
      <div className="cx-form-row center">
        <Switch on={p.on} label="Auto save" onChange={(on) => setP({ ...p, on })} />
        <select className="cx-input" aria-label="Auto save delay" disabled={!p.on} value={p.ms} onChange={(e) => setP({ ...p, ms: Number(e.target.value) })}>
          {[1000, 2000, 5000, 10000, 30000].map((ms) => (
            <option key={ms} value={ms}>
              after {ms / 1000} s
            </option>
          ))}
        </select>
      </div>
    </Field>
  );
}

/** Chats render Markdown by default; each message also has its own Raw / Rendered switch. */
function ChatMarkdownSetting() {
  const [on, setOn] = useChatMarkdown();
  return (
    <Field label="Markdown in chats" hint={on ? 'Studio and Activity chats show **bold**, lists, tables and code blocks rendered. Hover a message for Raw.' : 'Chats show the raw text. Hover a message for Rendered.'}>
      <Switch on={on} label="Render Markdown in chats" onChange={setOn} />
    </Field>
  );
}

/** Whether a reload brings back the open editor tabs (off: start with just the page in the address bar). */
function ReopenTabsSetting() {
  const [on, setOn] = usePref('reopenTabs', false);
  return (
    <Field label="Reopen tabs after a reload" hint={on ? 'A reload brings back the editor tabs you had open.' : 'A reload starts with only the page in the address bar open.'}>
      <Switch on={on} label="Reopen tabs after a reload" onChange={setOn} />
    </Field>
  );
}

/** Signed-in browsers and recent sign-in events, with sign out per browser or everywhere. */
function Sessions() {
  const ui = useUi();
  const [d, setD] = useState<{ sessions: { family: string; started: number; last_used: number; expires: number; ip: string | null; ua: string | null; revoked: number }[]; audit: { ts: number; event: string; ip: string | null }[] } | null>(null);
  const load = () => api<NonNullable<typeof d>>('auth/sessions').then(setD, () => setD(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const browser = (ua: string | null) => (ua ? (/(Firefox|Edg|Chrome|Safari)\/[\d.]+/.exec(ua)?.[0] ?? ua.slice(0, 40)) : 'unknown');
  return (
    <Section
      title="Signed-in browsers"
      hint="Each sign-in gets a 15-minute access token, renewed from a refresh cookie that changes on every use. A reused old cookie ends that sign-in everywhere."
      actions={
        <button
          type="button"
          className="cx-btn sm"
          onClick={async () => {
            if (!(await ui.confirm({ title: 'Sign out everywhere?', body: 'Every browser, this one included, has to sign in again.', ok: 'Sign out everywhere', danger: true }))) return;
            await ui.run(() => api('auth/logout-all', { body: {} }), 'Signed out everywhere');
            window.location.href = '/login';
          }}
        >
          Sign out everywhere
        </button>
      }
    >
      {!d ? (
        <Loading />
      ) : (
        <div className="cx-table-wrap">
          <table className="cx-table">
            <thead>
              <tr>
                <th>Browser</th>
                <th>IP</th>
                <th>Signed in</th>
                <th>Last used</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.sessions.map((x) => (
                <tr key={x.family} className={x.revoked ? 'cx-dim' : ''}>
                  <td>{browser(x.ua)}</td>
                  <td className="mono">{x.ip ?? '–'}</td>
                  <td className="cx-muted">{ago(x.started)}</td>
                  <td className="cx-muted">{ago(x.last_used)}</td>
                  <td>{x.revoked ? 'Signed out' : x.expires < Date.now() ? 'Expired' : 'Active'}</td>
                  <td>
                    {!x.revoked && x.expires > Date.now() && (
                      <button type="button" className="cx-btn sm" onClick={() => void ui.run(() => api(`auth/sessions/${x.family}/revoke`, { body: {} }), 'Signed out').then(load)}>
                        Sign out
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d && d.audit.length > 0 && (
        <details className="cx-more">
          <summary>Recent sign-in events</summary>
          <ul className="cx-plainlist small">
            {d.audit.map((a, i) => (
              <li key={i}>
                {clock(a.ts)} · {a.event.replace(/_/g, ' ')} · {a.ip ?? '–'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Section>
  );
}
