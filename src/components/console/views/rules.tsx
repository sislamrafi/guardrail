'use client';

import { useState } from 'react';
import { useActions } from '../actions';
import { Ico } from '../icons';
import { Empty, Field, GroupSelect, Loading, Page, Pill, Section, Seg, Switch, fmt } from '../kit';
import { pathFor, useNav } from '../nav';
import { api, useStore, useUi } from '../store';
import type { Rule } from '../types';

const TARGET = { any: 'any new text', user: 'the user message', tool: 'a tool result' } as const;
const ACTION = { block: 'Block with a reply', redact: 'Redact the match', escalate: 'Flag for the guard layers' } as const;
const TONE = { block: 'bad', redact: 'warn', escalate: 'info' } as const;

export function RulesHome() {
  const { data, error } = useStore();
  const nav = useNav();
  const act = useActions();
  if (!data) return <Loading error={error} />;
  return (
    <Page
      icon="filter"
      title="Custom rules"
      sub="Simple WHEN / THEN rules that run before the guard checks, for things you always want caught, like secrets or banned commands."
      actions={
        <button type="button" className="cx-btn pri" onClick={() => nav.go('/rules/new')}>
          <Ico n="plus" size={14} /> New rule
        </button>
      }
    >
      {data.rules.length === 0 ? (
        <Empty icon="filter" title="No rules yet">
          The guard checks still run on every request. <button type="button" className="cx-link" onClick={() => nav.go('/rules/new')}>Create a rule</button>
        </Empty>
      ) : (
        <div className="cx-list">
          {data.rules.map((r) => (
            <div key={r.id} className={`cx-list-row tall ${r.enabled ? '' : 'dim'}`}>
              <Switch on={!!r.enabled} label={`Rule ${r.name} on`} onChange={(v) => void act.toggleRule(r, v)} />
              <button type="button" className="cx-rule grow" onClick={() => nav.go(pathFor('rules', r.id))}>
                <b>{r.name}</b>
                <span className="cx-when">
                  <span className="cx-kw">WHEN</span> {TARGET[r.target]} {r.match_type === 'regex' ? 'matches' : 'contains'} <code>{r.pattern}</code>
                  {r.group_id && (
                    <>
                      {' '}
                      in <Pill tone="info">{data.groups.find((g) => g.id === r.group_id)?.name ?? '?'}</Pill>
                    </>
                  )}{' '}
                  <span className="cx-kw">THEN</span> <Pill tone={TONE[r.action]}>{ACTION[r.action]}</Pill>
                </span>
              </button>
              <span className="cx-muted small">{fmt(r.hits)} hits</span>
            </div>
          ))}
        </div>
      )}
    </Page>
  );
}

export function RuleEditor({ id }: { id: number | 'new' }) {
  const { data, error } = useStore();
  if (!data) return <Loading error={error} />;
  const r = id === 'new' ? null : data.rules.find((x) => x.id === id);
  if (id !== 'new' && !r) return <Empty icon="filter" title="This rule was deleted" />;
  return <RuleForm key={String(id)} r={r ?? { target: 'any', match_type: 'contains', action: 'block' }} />;
}

function RuleForm({ r }: { r: Partial<Rule> }) {
  const { data } = useStore();
  const ui = useUi();
  const nav = useNav();
  const act = useActions();
  const [v, setV] = useState<Partial<Rule>>(r);
  const [sample, setSample] = useState('');
  const set = (p: Partial<Rule>) => setV({ ...v, ...p });
  let test: string | null = null;
  if (sample && v.pattern) {
    try {
      const re = v.match_type === 'regex' ? new RegExp(v.pattern, 'i') : null;
      const hit = re ? re.exec(sample)?.[0] : sample.toLowerCase().includes(v.pattern.toLowerCase()) ? v.pattern : null;
      test = hit ? `Matches: "${hit}"` : 'No match';
    } catch {
      test = 'The pattern is not a valid regular expression';
    }
  }
  const save = async () => {
    let made: Rule | null = null;
    const ok = await ui.run(async () => {
      if (r.id) await api(`rules/${r.id}`, { method: 'PATCH', body: v });
      else made = await api<Rule>('rules', { body: v });
    }, 'Rule saved');
    if (ok && made) nav.go(pathFor('rules', (made as Rule).id), { replace: true });
  };
  return (
    <Page
      icon="filter"
      title={r.id ? r.name : 'New rule'}
      actions={
        r.id ? (
          <button type="button" className="cx-btn danger" onClick={async () => (await act.deleteRule(r as Rule)) && nav.go('/rules')}>
            <Ico n="trash" size={14} /> Delete
          </button>
        ) : undefined
      }
    >
      <form
        className="cx-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name">
          <input className="cx-input" value={v.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder="Block private keys" autoFocus={!r.id} />
        </Field>
        <Section title="When">
          <div className="cx-form-row">
            <select className="cx-input" value={v.target} onChange={(e) => set({ target: e.target.value as Rule['target'] })} aria-label="Text to check">
              {Object.entries(TARGET).map(([k, l]) => (
                <option key={k} value={k}>
                  {l[0].toUpperCase() + l.slice(1)}
                </option>
              ))}
            </select>
            <select className="cx-input" value={v.match_type} onChange={(e) => set({ match_type: e.target.value as Rule['match_type'] })} aria-label="Match type">
              <option value="contains">contains the text</option>
              <option value="regex">matches the regex</option>
            </select>
            <input className="cx-input mono grow" value={v.pattern ?? ''} onChange={(e) => set({ pattern: e.target.value })} placeholder={v.match_type === 'regex' ? '-----BEGIN [A-Z ]*PRIVATE KEY-----' : 'rm -rf /'} aria-label="Pattern" />
          </div>
          <Field label="Applies to">
            <GroupSelect groups={data?.groups ?? []} value={v.group_id ?? null} onChange={(g) => set({ group_id: g })} allLabel="Every group" />
          </Field>
        </Section>
        <Section title="Then">
          <Seg value={(v.action ?? 'block') as Rule['action']} onChange={(a) => set({ action: a })} label="Action" options={Object.entries(ACTION) as [Rule['action'], string][]} />
          {v.action === 'block' && (
            <Field label="Reason shown to the user (fills {reason} in the blocked reply)">
              <input className="cx-input" value={v.message ?? ''} onChange={(e) => set({ message: e.target.value })} placeholder="Private keys may not be sent to the model." />
            </Field>
          )}
          {v.action === 'redact' && <p className="cx-hint">The matching text is replaced with [REDACTED] and the request goes on.</p>}
          {v.action === 'escalate' && <p className="cx-hint">The request is marked flagged, so guard layers set to judge only flagged requests look at it, even if no earlier layer flagged it.</p>}
        </Section>
        <Field label="Try it on sample text" hint={test ?? undefined}>
          <input className="cx-input mono" value={sample} onChange={(e) => setSample(e.target.value)} />
        </Field>
        <div className="cx-form-row end">
          <button type="submit" className="cx-btn pri" disabled={!v.name?.trim() || !v.pattern?.trim()}>
            Save rule
          </button>
        </div>
      </form>
    </Page>
  );
}
