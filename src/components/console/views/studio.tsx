'use client';

import { useEffect, useMemo, useState } from 'react';
import { CLINE_SYSTEM, type Form, SCENARIOS, SCHEMA_OPTIONS, build, fromScenario } from '@/components/studio-requests';
import { Ico } from '../icons';
import { Empty, Field, Loading, Note, Page, Pill, Section, Switch, fmt, ms, secretProps } from '../kit';
import { pathFor, useNav } from '../nav';
import { api, useUi } from '../store';
import type { LogEntry } from '../types';
import { OUTCOME, Timeline } from './activity';

interface StudioKey {
  id: number;
  name: string;
  owner: string;
  group: string;
  revoked: boolean;
  models: string[];
}
interface Result {
  status: number;
  ms: number;
  streamed: boolean;
  text: string;
  error: string | null;
  raw: string;
  trace: { group?: string; context?: { name: string; tokens: number }[]; contextTokens?: number; placement?: 'top' | 'end'; forwarded?: unknown; requestId?: string };
  log: LogEntry | null;
}

export function StudioPage() {
  const ui = useUi();
  const nav = useNav();
  const [keys, setKeys] = useState<StudioKey[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [scenario, setScenario] = useState('Injection hidden in a file');
  const [form, setForm] = useState<Form>(() => fromScenario('Injection hidden in a file', { schema: 'openai_chat', model: '', stream: true, system: CLINE_SYSTEM, task: '', toolName: '', toolPath: '', toolResult: '' }));
  const [raw, setRaw] = useState<string | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [tab, setTab] = useState<'steps' | 'context' | 'sent' | 'raw'>('steps');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ keys: StudioKey[] }>('studio').then((r) => setKeys(r.keys), (e) => setErr((e as Error).message));
  }, []);
  // The sidebar's scenario list loads a scenario here.
  useEffect(() => {
    const on = (e: Event) => {
      const name = (e as CustomEvent<string>).detail;
      if (!SCENARIOS[name]) return;
      setScenario(name);
      setForm((f) => fromScenario(name, f));
      setRaw(null);
    };
    window.addEventListener('cx-studio-scenario', on);
    return () => window.removeEventListener('cx-studio-scenario', on);
  }, []);

  const usable = useMemo(() => keys?.filter((k) => !k.revoked) ?? [], [keys]);
  const key = usable.find((k) => String(k.id) === keyId);
  const pasted = keyId === 'paste';
  useEffect(() => {
    if (!keyId && usable.length) setKeyId(String(usable[0].id));
  }, [usable, keyId]);
  useEffect(() => {
    if (key && !key.models.includes(form.model)) setForm((f) => ({ ...f, model: key.models[0] ?? '' }));
  }, [key, form.model]);

  const req = build(form);
  const set = (p: Partial<Form>) => {
    setForm((f) => ({ ...f, ...p }));
    setRaw(null);
  };
  const send = async () => {
    setBusy(true);
    await ui.run(
      async () => {
        let body: unknown = req.body;
        if (raw !== null) {
          try {
            body = JSON.parse(raw);
          } catch {
            throw new Error('The request body is not valid JSON.');
          }
        }
        if (!pasted && !key) throw new Error('Pick a key to send as.');
        if (pasted && !secret.trim()) throw new Error('Paste an API key, or pick one from the list.');
        setRes(await api<Result>('studio/send', { body: { keyId: pasted ? undefined : key!.id, secret: pasted ? secret : undefined, path: req.path, headers: req.headers, body } }));
        setTab('steps');
      },
      undefined,
      { reload: false },
    );
    setBusy(false);
  };

  if (!keys) return <Loading error={err} />;
  return (
    <Page icon="studio" title="Studio" sub="Send a request the way an agent would, then see every step GuardRail took, the context it added and what came back." wide>
      {usable.length === 0 && <Note tone="warn">No active keys yet. Create one in API keys, or paste a key below.</Note>}
      <div className="cx-cols">
        <Section title="Request">
          <div className="cx-form-row">
            <Field label="Send as key" grow>
              <select className="cx-input" value={keyId} onChange={(e) => setKeyId(e.target.value)}>
                {usable.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.owner} · {k.name} ({k.group})
                  </option>
                ))}
                <option value="paste">Paste a key…</option>
              </select>
            </Field>
            <Field label="Model" grow>
              {key ? (
                <select className="cx-input mono" value={form.model} onChange={(e) => set({ model: e.target.value })}>
                  {key.models.length === 0 && <option value="">No models for this key</option>}
                  {key.models.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              ) : (
                <input className="cx-input mono" value={form.model} placeholder="qwen3-coder-30b" onChange={(e) => set({ model: e.target.value })} />
              )}
            </Field>
          </div>
          {pasted && (
            <Field label="API key">
              <input className="cx-input mono" {...secretProps} name="gr-studio-secret" value={secret} placeholder="grk_live_…" onChange={(e) => setSecret(e.target.value)} />
            </Field>
          )}
          {key && <p className="cx-hint">Acts as this key without its secret: same group rules, limits and logging, logged with the address &quot;Studio&quot;.</p>}
          <div className="cx-form-row">
            <Field label="Schema" grow>
              <select className="cx-input" value={form.schema} onChange={(e) => set({ schema: e.target.value })}>
                {SCHEMA_OPTIONS.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Scenario" grow>
              <select
                className="cx-input"
                value={scenario}
                onChange={(e) => {
                  setScenario(e.target.value);
                  setForm((f) => fromScenario(e.target.value, f));
                  setRaw(null);
                }}
              >
                {Object.keys(SCENARIOS).map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="cx-form-row center">
            <span className="mono cx-muted small grow">
              POST {req.path}
              {Object.keys(req.headers).length ? ` · ${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''}
            </span>
            {form.schema !== 'gemini' && (
              <>
                <Switch on={form.stream} onChange={(v) => set({ stream: v })} label="Stream the reply" />
                <span className="small">Stream</span>
              </>
            )}
          </div>
          <Field label="Task (the user's message)">
            <textarea className="cx-input" rows={3} value={form.task} onChange={(e) => set({ task: e.target.value })} />
          </Field>
          <div className="cx-form-row">
            <Field label="Tool">
              <input className="cx-input mono" value={form.toolName} placeholder="read_file" onChange={(e) => set({ toolName: e.target.value })} />
            </Field>
            <Field label="File it read" grow>
              <input className="cx-input mono" value={form.toolPath} placeholder="README.md" onChange={(e) => set({ toolPath: e.target.value })} />
            </Field>
          </div>
          <Field label="Tool result (empty for no tool call)">
            <textarea className="cx-input mono" rows={4} value={form.toolResult} onChange={(e) => set({ toolResult: e.target.value })} />
          </Field>
          <details className="cx-details-box">
            <summary>Agent system prompt</summary>
            <textarea className="cx-input mono" rows={6} value={form.system} onChange={(e) => set({ system: e.target.value })} aria-label="Agent system prompt" />
          </details>
          <details className="cx-details-box">
            <summary>Request body {raw !== null && <Pill tone="warn">edited by hand</Pill>}</summary>
            <textarea className="cx-input mono" rows={12} value={raw ?? JSON.stringify(req.body, null, 2)} onChange={(e) => setRaw(e.target.value)} spellCheck={false} aria-label="Request body" />
            {raw !== null && (
              <button type="button" className="cx-btn sm" onClick={() => setRaw(null)}>
                Rebuild from the form
              </button>
            )}
          </details>
          <div className="cx-form-row end">
            <button type="button" className="cx-btn pri" disabled={busy} onClick={() => void send()}>
              <Ico n="send" size={14} /> {busy ? 'Sending…' : 'Send request'}
            </button>
          </div>
        </Section>
        <Section title="Result">
          {!res ? (
            <Empty icon="send" title="Nothing sent yet">
              The request goes through the real gateway: key check, schema, access, rules, both guard checks, context and the model.
            </Empty>
          ) : (
            <ResultView res={res} tab={tab} setTab={setTab} task={form.task} model={form.model} onOpen={(id) => nav.go(pathFor('activity', id))} />
          )}
        </Section>
      </div>
    </Page>
  );
}

function ResultView({ res, tab, setTab, task, model, onOpen }: { res: Result; tab: string; setTab: (t: 'steps' | 'context' | 'sent' | 'raw') => void; task: string; model: string; onOpen: (id: string) => void }) {
  const outcome = res.log?.outcome;
  const [label, tone] = outcome ? (OUTCOME[outcome] ?? [outcome, 'warn']) : [`HTTP ${res.status}`, res.status < 400 ? 'ok' : 'bad'];
  const ctx = res.trace.context ?? [];
  return (
    <div className="cx-form">
      <div className="cx-form-row center">
        <Pill tone={tone as 'ok'}>{label}</Pill>
        <span className="cx-muted small grow">
          HTTP {res.status} · {ms(res.ms)} · {res.streamed ? 'streamed' : 'single reply'}
        </span>
        {res.trace.requestId && (
          <button type="button" className="cx-link mono" onClick={() => onOpen(res.trace.requestId!)}>
            {res.trace.requestId}
          </button>
        )}
      </div>
      <div className="cx-chat">
        <div className="cx-bubble me">{task.length > 160 ? task.slice(0, 160) + '…' : task}</div>
        <div className={`cx-bubble ${res.error ? 'bad' : ''}`}>
          <span className="cx-muted small">{res.error ? `Error ${res.status}` : model}</span>
          {res.error ?? (res.text || '(empty reply)')}
        </div>
      </div>
      <div className="cx-subtabs" role="tablist">
        {(
          [
            ['steps', 'What happened'],
            ['context', `Context added${res.trace.forwarded === undefined ? '' : ` (${ctx.length})`}`],
            ['sent', 'Sent to the model'],
            ['raw', 'Raw response'],
          ] as const
        ).map(([id, name]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {name}
          </button>
        ))}
      </div>
      {tab === 'steps' && (res.log ? <Timeline steps={res.log.steps} /> : <Note>No log entry for this request.</Note>)}
      {tab === 'context' &&
        (res.trace.forwarded === undefined ? (
          <Note>The request stopped before context was added.</Note>
        ) : (
          <>
            <p className="cx-hint">
              Group <b>{res.trace.group}</b> · {fmt(res.trace.contextTokens ?? 0)} tokens added {res.trace.placement === 'end' ? 'before the last user message' : 'at the top of the system prompt (cacheable)'}
            </p>
            {ctx.length === 0 ? (
              <Note>This group has no context files.</Note>
            ) : (
              <div className="cx-list">
                {ctx.map((c, i) => (
                  <div key={c.name} className="cx-list-row">
                    <span className="cx-muted mono">{i + 1}.</span>
                    <b className="grow">{c.name}</b>
                    <span className="mono cx-muted">{fmt(c.tokens)} tokens</span>
                  </div>
                ))}
              </div>
            )}
          </>
        ))}
      {tab === 'sent' && (res.trace.forwarded === undefined ? <Note>Nothing was sent to the model.</Note> : <pre className="cx-pre tall">{JSON.stringify(res.trace.forwarded, null, 2)}</pre>)}
      {tab === 'raw' && <pre className="cx-pre tall">{res.raw}</pre>}
    </div>
  );
}
