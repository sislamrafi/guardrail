'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PromptMessage } from '@/lib/logs';
import type { ScenarioSettings, Turn } from '@/lib/studio';
import { buildRequest } from '@/lib/studio-body';
import { toParts } from '../chat';
import { Ico } from '../icons';
import { readPref } from '../prefs';
import { applyLive, sendLive, setDebug, useDebug } from '../studio-debug';
import { Dialog, Empty, Field, GroupSelect, IconBtn, Loading, Note, Page, Pill, Seg, Switch, ms } from '../kit';
import { pathFor, useNav } from '../nav';
import { api, useStore, useUi } from '../store';
import type { Data, LogEntry, Scenario } from '../types';
import { OUTCOME } from './activity';
import { MdText } from '../md-text';
import { ModelPicker } from '../model-picker';

interface RunResult {
  status: number;
  ms: number;
  streamed: boolean;
  text: string;
  toolCalls: { id?: string; function?: { name?: string; arguments?: string } }[];
  error: string | null;
  raw: string;
  trace: { forwarded?: unknown; context?: { name: string; tokens: number }[]; contextTokens?: number };
  log: LogEntry | null;
}

// ---------------------------------------------------------------- /studio

export function StudioHome() {
  const { data, error } = useStore();
  const nav = useNav();
  const ui = useUi();
  const params = useSearchParams();
  const from = params.get('from');
  const started = useRef(false);
  // "Open in Studio" from Activity: make a scenario from that request and open it.
  useEffect(() => {
    if (!from || started.current) return;
    started.current = true;
    void ui.run(async () => {
      const sc = await api<{ id: number }>('studio/scenarios', { body: { fromLog: from } });
      nav.go(pathFor('studio', sc.id), { replace: true });
    }, 'Scenario created from the request');
  }, [from, nav, ui]);
  if (!data) return <Loading error={error} />;
  const create = async () => {
    let id = 0;
    if (await ui.run(async () => (id = (await api<{ id: number }>('studio/scenarios', { body: { name: 'New scenario' } })).id))) nav.go(pathFor('studio', id));
  };
  return (
    <Page
      icon="studio"
      title="Studio"
      sub="Chat through the real gateway as a client would: auth, group rules, guard layers, context and the model. Each saved scenario keeps its chat and settings. Studio traffic is logged as test traffic."
      actions={
        <button type="button" className="cx-btn pri" onClick={() => void create()}>
          <Ico n="plus" size={14} /> New scenario
        </button>
      }
    >
      {data.scenarios.length === 0 ? (
        <Empty icon="send" title="No scenarios yet">
          Create one, or open a request from Activity in Studio.
        </Empty>
      ) : (
        <div className="cx-table-wrap">
          <table className="cx-table">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Expected</th>
                <th>Tags</th>
                <th>Turns</th>
              </tr>
            </thead>
            <tbody>
              {data.scenarios.map((s) => (
                <tr key={s.id} className="click" onClick={() => nav.go(pathFor('studio', s.id))}>
                  <td>
                    <b>{s.name}</b>
                    <div className="cx-muted small">{s.description}</div>
                  </td>
                  <td className="cx-muted">{s.notes || '–'}</td>
                  <td>
                    {s.tags.map((t) => (
                      <Pill key={t}>{t}</Pill>
                    ))}
                  </td>
                  <td className="tnum">{s.messages.filter((m) => m.role === 'user').length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------- /studio/:id

export function ScenarioChat({ id }: { id: number }) {
  const { data, error } = useStore();
  if (!data) return <Loading error={error} />;
  const sc = data.scenarios.find((s) => s.id === id);
  if (!sc) return <Empty icon="send" title="This scenario was deleted" />;
  return <Chat key={sc.id} sc={sc} data={data} />;
}

function withDefaults(s: ScenarioSettings, data: Data): ScenarioSettings {
  const root = data.groups.find((g) => g.parentId === null);
  return { ...s, groupId: s.groupId ?? (s.mode === 'group' ? (root?.id ?? null) : null), model: s.model || data.models[0] || '' };
}

function Chat({ sc, data }: { sc: Scenario; data: Data }) {
  const ui = useUi();
  const [messages, setMessages] = useState<PromptMessage[]>(sc.messages);
  const [turns, setTurns] = useState<Turn[]>(sc.turns);
  const [settings, setSettings] = useState<ScenarioSettings>(() => withDefaults(sc.settings, data));
  const [input, setInput] = useState('');
  const [toolAnswers, setToolAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [gear, setGear] = useState(false);
  const [meta, setMeta] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages, busy]);
  // The right sidebar's debug panel follows this scenario: the plan on open, then each turn.
  useEffect(() => {
    // Reopen on what was shown last time: the plan, or the latest turn.
    const lastLog = [...sc.turns].reverse().find((t) => t.logId)?.logId ?? null;
    setDebug({ scenarioId: sc.id, logId: readPref<string>('studio.debug', 'plan') === 'turn' ? lastLog : null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sc.id]);
  useEffect(() => {
    setDebug({ settings, turns: turns.filter((t) => t.logId).map((t, i) => ({ logId: t.logId!, label: `Turn ${i + 1}` })) });
  }, [settings, turns]);
  // The message box grows with its text, up to about eight lines, then scrolls.
  const box = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const t = box.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 8 * 20 + 8)}px`;
  }, [input]);

  const persist = (patch: Partial<Scenario>) => api(`studio/scenarios/${sc.id}`, { method: 'PATCH', body: patch });

  // Tool calls the last assistant message is waiting on.
  const last = messages[messages.length - 1] as (PromptMessage & { tool_calls?: RunResult['toolCalls'] }) | undefined;
  const pending = last?.role === 'assistant' && Array.isArray(last.tool_calls) ? last.tool_calls : [];

  const send = async (extra: PromptMessage[]) => {
    const next = [...messages, ...extra];
    let req;
    try {
      const files = data.files.filter((f) => settings.extraContext.includes(f.id)).map((f) => ({ name: f.name, body: f.body }));
      req = buildRequest(settings, next, files);
    } catch (e) {
      return ui.toast(`Tools are not valid JSON: ${(e as Error).message}`, true);
    }
    if (!settings.model) return ui.toast('Pick a model in the settings first.', true);
    if (settings.mode === 'key' ? !settings.keyId : !settings.groupId) return ui.toast(`Pick a ${settings.mode} in the settings first.`, true);
    setMessages(next);
    setBusy(true);
    try {
      const layers = settings.layers ? data.settings.guard.layers.filter((l) => settings.layers!.includes(l.id)) : undefined;
      // Live: the debug panel and the bubble below follow each step, layer, token and draft as it happens.
      setDebug({ live: { items: [], tokens: '', draft: null, status: 'Through the gateway…', started: Date.now(), cost: 0 } });
      const r = await sendLive<RunResult>({ keyId: settings.mode === 'key' ? settings.keyId : undefined, groupId: settings.mode === 'group' ? settings.groupId : undefined, path: req.path, headers: req.headers, body: req.body, layers }, (e) =>
        setDebug((d) => (d.live ? { live: applyLive(d.live, e) } : {})),
      );
      const reply: PromptMessage = r.error ? { role: 'assistant', content: r.error, name: 'error' } : { role: 'assistant', content: r.text, ...(r.toolCalls.length ? { tool_calls: r.toolCalls } : {}) };
      const all = [...next, reply];
      const t: Turn = { at: all.length - 1, logId: r.log?.id ?? null, status: r.status, outcome: r.log?.outcome ?? null, ms: r.ms };
      setMessages(all);
      setTurns((ts) => [...ts, t]);
      const logId = r.log?.id ?? null;
      setDebug((d) => ({ logId, rev: d.rev + 1, raw: logId ? { ...d.raw, [logId]: r.raw } : d.raw }));
      setToolAnswers({});
      await persist({ messages: all, turns: [...turns, t] });
    } catch (e) {
      ui.toast((e as Error).message, true);
      setMessages(messages);
    } finally {
      setBusy(false);
      setDebug({ live: null });
    }
  };
  const submit = () => {
    if (busy) return;
    if (pending.length) {
      const answers = pending.map((c, i) => ({ role: 'tool', tool_call_id: c.id ?? `call_${i}`, name: c.function?.name, content: toolAnswers[c.id ?? `call_${i}`] ?? '' }));
      void send([...answers, ...(input.trim() ? [{ role: 'user', content: input.trim() }] : [])]);
    } else if (input.trim()) void send([{ role: 'user', content: input.trim() }]);
    setInput('');
  };
  const clear = async () => {
    if (!(await ui.confirm({ title: 'Clear this chat?', body: 'The messages are removed from the scenario; its settings stay. Logged requests stay in Activity.', ok: 'Clear chat', danger: true }))) return;
    setMessages([]);
    setTurns([]);
    setDebug({ logId: null });
    await ui.run(() => persist({ messages: [], turns: [] }), 'Chat cleared');
  };
  const exportJson = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ ...sc, settings, messages, turns }, null, 2)], { type: 'application/json' }));
    a.download = `${sc.name.replace(/[^\w.-]+/g, '-')}.json`;
    a.click();
  };
  const saveSettings = async (s: ScenarioSettings) => {
    setSettings(s);
    await ui.run(() => persist({ settings: s }), 'Settings saved');
  };

  const actor = settings.mode === 'key' ? data.keys.find((k) => k.id === settings.keyId)?.name : data.groups.find((g) => g.id === settings.groupId)?.path;
  return (
    <div className="cx-studio">
      <div className="cx-studio-bar">
        <div className="grow">
          <b>{sc.name}</b>
          <span className="cx-muted small">
            {' '}
            · {settings.mode === 'key' ? 'as key' : 'as group'} {actor ?? '(pick in settings)'} · <span className="mono">{settings.model || 'no model'}</span> · {settings.schema.replace('_', ' ')}
            {settings.layers ? ` · ${settings.layers.length} layers` : ''}
          </span>
        </div>
        <IconBtn icon="edit" label="Name, notes and tags" onClick={() => setMeta(true)} />
        <IconBtn icon="download" label="Export as JSON" onClick={exportJson} />
        <IconBtn icon="trash" label="Clear chat" disabled={!messages.length} onClick={() => void clear()} />
        <IconBtn icon="settings" label="Settings" active={gear} onClick={() => setGear(true)} />
      </div>
      <div className="cx-studio-chat">
        <div className="cx-thread">
          {sc.notes && <Note>Expected: {sc.notes}</Note>}
          {messages.length === 0 && <div className="cx-studio-empty">Send a message to start. Every turn goes through the gateway exactly like a client request.</div>}
          {messages.map((m, i) => (
            <Message key={i} m={m} turn={turns.find((t) => t.at === i)} />
          ))}
          {busy && <LiveBubble />}
          <div ref={end} />
        </div>
      </div>
      <div className="cx-composer">
        {pending.length > 0 && (
          <div className="cx-form">
            <span className="cx-muted small">The model asked for {pending.length} tool call(s). Answer them by hand, then send.</span>
            {pending.map((c, i) => {
              const cid = c.id ?? `call_${i}`;
              return (
                <Field key={cid} label={`${c.function?.name ?? 'tool'}(${c.function?.arguments ?? ''})`}>
                  <textarea className="cx-input mono" rows={2} value={toolAnswers[cid] ?? ''} onChange={(e) => setToolAnswers({ ...toolAnswers, [cid]: e.target.value })} placeholder="Tool result" />
                </Field>
              );
            })}
          </div>
        )}
        <div className="cx-composer-box">
          <textarea
            ref={box}
            rows={1}
            value={input}
            placeholder={pending.length ? 'Optional follow-up (Enter to send, Shift+Enter for a new line)' : 'Message the model (Enter to send, Shift+Enter for a new line)'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a new line; never while an input method is composing text.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            aria-label="Message"
          />
          <button type="button" className="cx-send" disabled={busy || (!input.trim() && !pending.length)} onClick={submit} aria-label="Send" title="Send (Enter)">
            <Ico n="send" size={15} />
          </button>
        </div>
      </div>
      {gear && (
        <SettingsDialog
          s={settings}
          data={data}
          onClose={() => setGear(false)}
          onSave={(s) => {
            void saveSettings(s);
            setGear(false);
          }}
        />
      )}
      {meta && <MetaDialog sc={sc} onClose={() => setMeta(false)} />}
    </div>
  );
}

function Message({ m, turn }: { m: PromptMessage; turn?: Turn }) {
  const dbg = useDebug();
  const parts = toParts([m]);
  const blocked = turn?.outcome === 'blocked';
  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === 'text')
          return (
            <div key={i} className={`cx-turn ${p.role === 'user' ? 'me' : ''} ${blocked ? 'blocked' : ''}`}>
              <div className="cx-turn-head">
                <span>{blocked ? 'blocked reply' : m.name === 'error' ? 'error' : p.role}</span>
                {turn?.outcome && <Pill tone={OUTCOME[turn.outcome]?.[1] ?? ''}>{OUTCOME[turn.outcome]?.[0] ?? turn.outcome}</Pill>}
                {turn && <span className="cx-muted small">{ms(turn.ms)}</span>}
              </div>
              <MdText text={p.text || '(empty reply)'} />
            </div>
          );
        if (p.kind === 'tool-call' || p.kind === 'tool-result')
          return (
            <div key={i} className={`cx-fold ${p.kind === 'tool-call' ? 'call' : 'result'}`}>
              <div className="cx-fold-head">
                <Ico n={p.kind === 'tool-call' ? 'code' : 'file'} size={13} /> {p.kind === 'tool-call' ? 'Tool call' : 'Tool result'} · {p.name}
              </div>
              <pre className="cx-fold-body">{p.kind === 'tool-call' ? p.args : p.text}</pre>
            </div>
          );
        return null;
      })}
      {turn && (
        <button type="button" className={`cx-trace-chip ${turn.logId && dbg.logId === turn.logId ? 'on' : ''}`} disabled={!turn.logId} title="Show this turn stage by stage in the right sidebar" onClick={() => setDebug({ logId: turn.logId })}>
          <Ico n="guard" size={12} /> Debug · HTTP {turn.status}
          {turn.logId && <span className="mono cx-muted small">{turn.logId}</span>}
        </button>
      )}
    </>
  );
}

// Studio sends as a client, so only models clients can use.
const clientModel = (r: { enabled: boolean }) => r.enabled;

function SettingsDialog({ s, data, onClose, onSave }: { s: ScenarioSettings; data: Data; onClose: () => void; onSave: (s: ScenarioSettings) => void }) {
  const [v, setV] = useState(s);
  const set = (p: Partial<ScenarioSettings>) => setV({ ...v, ...p });
  const layers = data.settings.guard.layers;
  return (
    <Dialog
      title="Scenario settings"
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cx-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="cx-btn pri" onClick={() => onSave(v)}>
            Save settings
          </button>
        </>
      }
    >
      <div className="cx-form-row">
        <Field label="Send as">
          <Seg value={v.mode} label="Send as" onChange={(mode) => set({ mode })} options={[['group', 'A group'], ['key', 'A key']]} />
        </Field>
        {v.mode === 'group' ? (
          <Field label="Group (its rules, context and layers)" grow>
            <GroupSelect groups={data.groups} value={v.groupId} onChange={(groupId) => set({ groupId })} />
          </Field>
        ) : (
          <Field label="Key (no secret needed; IP limits are skipped in Studio)" grow>
            <select className="cx-input" value={v.keyId ?? ''} onChange={(e) => set({ keyId: Number(e.target.value) || null })}>
              <option value="">Pick a key</option>
              {data.keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name} · {k.owner} · {k.groupName}
                  {k.revoked ? ' (revoked)' : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <div className="cx-form-row">
        <Field label="Model" grow>
          <ModelPicker servers={data.servers} value={{ serverId: null, model: v.model }} onPick={(_, model) => set({ model })} only={clientModel} />
        </Field>
        <Field label="Request schema">
          <select className="cx-input" value={v.schema} onChange={(e) => set({ schema: e.target.value as ScenarioSettings['schema'] })}>
            <option value="openai_chat">OpenAI chat</option>
            <option value="openai_completions">OpenAI completions (legacy)</option>
            <option value="anthropic_messages">Anthropic Messages</option>
          </select>
        </Field>
      </div>
      <Field label="System prompt (sent by the client)">
        <textarea className="cx-input mono" rows={4} value={v.system} onChange={(e) => set({ system: e.target.value })} placeholder="You are Cline, a highly skilled software engineer…" />
      </Field>
      <Field label="Tools (JSON list of function tools, sent as the request's tools)" hint='For example [{"name":"read_file","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}]'>
        <textarea className="cx-input mono" rows={4} value={v.tools} onChange={(e) => set({ tools: e.target.value })} />
      </Field>
      <Field label="Attach context files (sent by the client, on top of the group's own context)">
        <div className="cx-checklist inline">
          {data.files.map((f) => (
            <label key={f.id} className="cx-check">
              <input type="checkbox" checked={v.extraContext.includes(f.id)} onChange={(e) => set({ extraContext: e.target.checked ? [...v.extraContext, f.id] : v.extraContext.filter((x) => x !== f.id) })} />
              {f.name}
            </label>
          ))}
          {data.files.length === 0 && <span className="cx-muted small">No context files yet.</span>}
        </div>
      </Field>
      <div className="cx-form-row center">
        <Field label="Temperature">
          <input className="cx-input" type="number" step={0.1} min={0} max={2} value={v.temperature ?? ''} placeholder="model default" onChange={(e) => set({ temperature: e.target.value === '' ? null : Number(e.target.value) })} />
        </Field>
        <Field label="Max tokens">
          <input className="cx-input" type="number" min={1} value={v.maxTokens ?? ''} placeholder="model default" onChange={(e) => set({ maxTokens: e.target.value === '' ? null : Number(e.target.value) })} />
        </Field>
        <Switch on={v.stream} label="Stream the reply" onChange={(stream) => set({ stream })} />
        <span>Stream the reply</span>
      </div>
      <Field label="Guard layers to run">
        <Seg value={v.layers ? 'pick' : 'group'} label="Guard layers" onChange={(m) => set({ layers: m === 'group' ? null : layers.map((l) => l.id) })} options={[['group', "The group's own"], ['pick', 'Pick layers']]} />
        {v.layers && (
          <div className="cx-checklist inline">
            {layers.map((l) => (
              <label key={l.id} className="cx-check">
                <input type="checkbox" checked={v.layers!.includes(l.id)} onChange={(e) => set({ layers: e.target.checked ? [...v.layers!, l.id] : v.layers!.filter((x) => x !== l.id) })} />
                {l.name}
              </label>
            ))}
          </div>
        )}
      </Field>
    </Dialog>
  );
}

function MetaDialog({ sc, onClose }: { sc: Scenario; onClose: () => void }) {
  const ui = useUi();
  const [name, setName] = useState(sc.name);
  const [description, setDescription] = useState(sc.description);
  const [notes, setNotes] = useState(sc.notes);
  const [tags, setTags] = useState(sc.tags.join(', '));
  const save = async () => {
    if (await ui.run(() => api(`studio/scenarios/${sc.id}`, { method: 'PATCH', body: { name, description, notes, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) } }), 'Scenario saved')) onClose();
  };
  return (
    <Dialog
      title="Scenario"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cx-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="cx-btn pri" disabled={!name.trim()} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <Field label="Name">
        <input className="cx-input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description">
        <input className="cx-input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Expected outcome / notes">
        <textarea className="cx-input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Should be blocked by the judge layer." />
      </Field>
      <Field label="Tags (comma separated)">
        <input className="cx-input" value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>
    </Dialog>
  );
}

/** The answer while it is on its way: streamed text (or the held draft) and a one-line status. */
function LiveBubble() {
  const live = useDebug().live;
  const draft = live?.draft && !live.tokens ? live.draft : null;
  const text = live?.tokens || draft?.text || '';
  return (
    <div className="cx-turn">
      <div className="cx-turn-head">
        <span>assistant</span>
        {draft && <Pill tone="warn">draft #{draft.attempt}: not yet released to the client</Pill>}
      </div>
      {text ? <MdText text={text} className={draft ? 'cx-draft' : ''} /> : null}
      <div className="cx-live-line">
        <span className="cx-spin" /> {live?.status ?? 'Through the gateway…'}
        {live?.items
          .filter((x) => x.key.startsWith('layer-'))
          .slice(-3)
          .map((x) => (
            <span key={x.key} className={`cx-live-chip ${x.mark}`}>
              {x.title.replace(/^\d+\. /, '')} {x.mark === 'run' ? '…' : x.mark === 'pass' ? '✓' : x.mark === 'block' ? '✕' : x.mark === 'flag' ? '!' : '–'}
            </span>
          ))}
      </div>
    </div>
  );
}
