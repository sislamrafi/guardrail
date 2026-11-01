'use client';

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ico } from '../icons';
import { Dialog, Empty, Loading, Note, Pill, ago, clock } from '../kit';
import { MdText } from '../md-text';
import { pathFor, useNav } from '../nav';
import { readPref, usePref, writePref } from '../prefs';
import { adminFetch, api, useStore, useUi } from '../store';
import { applyTheme, type Theme } from '../theme';
import { useStickToBottom } from '../stick';
import { KIND_LABEL, kindOf, type Data } from '../types';

// The console agent: chat history on the left, the chat in the middle, its change log on the right.

type UiComponent =
  | { kind: 'confirm'; pending: string; title: string; body: string; danger?: boolean }
  | { kind: 'secret_input'; serverId: number; serverName: string }
  | { kind: 'secret_reveal'; keyId: number; keyName: string }
  | { kind: 'table'; title?: string; columns: string[]; rows: (string | number | null)[][] }
  | { kind: 'chart'; title?: string; unit?: string; bars: { label: string; value: number; hint?: string }[] }
  | { kind: 'choice'; question: string; options: { label: string; value: string }[] }
  | { kind: 'form'; title: string; fields: { name: string; label: string; type?: string; options?: string[]; value?: string }[]; submit?: string }
  | { kind: 'diff'; title: string; before: string; after: string }
  | { kind: 'link'; label: string; path: string }
  | { kind: 'ui_effect'; effect: { pref?: string; value?: unknown; navigate?: string; theme?: string } };

interface Chat {
  id: number;
  title: string;
  model: string | null;
  server_id: number | null;
  created_at: number;
  updated_at: number;
  preview?: string;
}
interface Msg {
  id: number;
  turn: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls: { id: string; function: { name: string; arguments: string } }[] | null;
  tool_call_id: string | null;
  name: string | null;
  ui: UiComponent[] | null;
  undone: number;
  created_at: number;
}
interface Change {
  id: number;
  turn: number;
  tool: string;
  tbl: string;
  row_id: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  fields: string[];
  summary: string;
  created_at: number;
  undone_at: number | null;
}
type Ev =
  | { type: 'turn'; turn: number; userMessageId: number }
  | { type: 'token'; text: string }
  | { type: 'assistant'; id: number; content: string }
  | { type: 'tool'; id: string; name: string; args: unknown; status: string; result?: unknown }
  | { type: 'ui'; components: UiComponent[]; toolCallId?: string }
  | { type: 'changes' }
  | { type: 'title'; title: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

const agentChanged = () => window.dispatchEvent(new Event('cx-agent'));

/** Apply a change the agent made to the console itself (theme, a preference), remembering the old value for undo. */
function applyEffect(e: { pref?: string; value?: unknown; theme?: string }) {
  if (e.theme) {
    writePref('agent.prev.theme', localStorage.getItem('cx-theme') ?? 'offwhite');
    applyTheme(e.theme as Theme);
  }
  if (e.pref) {
    writePref(`agent.prev.${e.pref}`, readPref(e.pref, null));
    writePref(e.pref, e.value);
  }
}

/** Undo a console change the agent made. */
function revertEffect(e: { pref?: string; theme?: string }) {
  if (e.theme) applyTheme(readPref<string>('agent.prev.theme', 'offwhite') as Theme);
  if (e.pref) writePref(e.pref, readPref(`agent.prev.${e.pref}`, null));
}

async function stream(url: string, body: unknown, onEvent: (e: Ev) => void, signal: AbortSignal) {
  const res = await adminFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Failed (${res.status})`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const p of parts) {
      const line = p.split('\n').find((l) => l.startsWith('data:'));
      if (line) onEvent(JSON.parse(line.slice(5)) as Ev);
    }
  }
}

// ---------------------------------------------------------------- left: chats

const dayLabel = (t: number) => {
  const d = new Date(t);
  const today = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};

export function AgentSide() {
  const nav = useNav();
  const ui = useUi();
  const [q, setQ] = useState('');
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const load = useCallback(() => api<{ chats: Chat[] }>(`agent/chats${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((r) => setChats(r.chats), () => setChats([])), [q]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    window.addEventListener('cx-agent', load);
    return () => {
      clearTimeout(t);
      window.removeEventListener('cx-agent', load);
    };
  }, [load]);
  const groups = useMemo(() => {
    const m = new Map<string, Chat[]>();
    for (const c of chats ?? []) {
      const k = dayLabel(c.updated_at);
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return [...m.entries()];
  }, [chats]);
  const remove = async (c: Chat) => {
    if (!(await ui.confirm({ title: `Delete the chat "${c.title}"?`, body: 'The chat goes; the change log of what it did to the gateway is kept.', ok: 'Delete chat', danger: true }))) return;
    await ui.run(() => api(`agent/chats/${c.id}`, { method: 'DELETE' }), 'Chat deleted');
    if (nav.id === String(c.id)) nav.go(pathFor('agent'));
    void load();
  };
  return (
    <>
      <div className="cx-side-head">
        <span>AGENT</span>
        <div className="cx-side-acts">
          <button type="button" title="New chat" aria-label="New chat" onClick={() => nav.go(pathFor('agent'))}>
            <Ico n="plus" />
          </button>
        </div>
      </div>
      <div className="cx-side-body">
        <div className="cx-attach">
          <input className="cx-input sm" type="search" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search chats" />
        </div>
        <button type="button" className={`cx-chat-new ${!nav.id ? 'on' : ''}`} onClick={() => nav.go(pathFor('agent'))}>
          <Ico n="plus" size={13} /> New chat
        </button>
        {!chats ? (
          <Loading />
        ) : chats.length === 0 ? (
          <p className="cx-details-empty">{q ? 'No chat matches.' : 'No chats yet.'}</p>
        ) : (
          groups.map(([day, list]) => (
            <div key={day}>
              <div className="cx-section">{day.toUpperCase()}</div>
              {list.map((c) => (
                <div key={c.id} className={`cx-chat-row ${nav.id === String(c.id) ? 'on' : ''}`} title={c.preview}>
                  {renaming === c.id ? (
                    <input
                      className="cx-input sm"
                      autoFocus
                      defaultValue={c.title}
                      onBlur={(e) => {
                        setRenaming(null);
                        if (e.target.value.trim() && e.target.value !== c.title) void api(`agent/chats/${c.id}`, { method: 'PATCH', body: { title: e.target.value } }).then(load);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  ) : (
                    <button type="button" className="cx-chat-title" onClick={() => nav.go(pathFor('agent', c.id))} onDoubleClick={() => setRenaming(c.id)}>
                      <span>{c.title}</span>
                      <small>{clock(c.updated_at)}</small>
                    </button>
                  )}
                  <button type="button" className="cx-row-act" title="Rename" aria-label="Rename chat" onClick={() => setRenaming(c.id)}>
                    <Ico n="edit" size={13} />
                  </button>
                  <button type="button" className="cx-row-act" title="Delete" aria-label="Delete chat" onClick={() => void remove(c)}>
                    <Ico n="trash" size={13} />
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- model picker

type Pick = { serverId: number; model: string };

function ModelDialog({ data, value, onPick, onClose }: { data: Data; value: Pick | null; onPick: (p: Pick) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return data.servers
      .flatMap((s) => s.models.filter((m) => m.api !== 'decisions' && ['text', 'other'].includes(kindOf(m))).map((m) => ({ s, m })))
      .filter(({ s, m }) => words.every((w) => `${m.name} ${s.name}`.toLowerCase().includes(w)))
      .sort((a, b) => a.m.name.localeCompare(b.m.name));
  }, [data.servers, q]);
  const money = (n: number | null | undefined) => (n == null ? '–' : n === 0 ? 'free' : `$${n < 0.01 ? n.toPrecision(2) : n.toFixed(2)}`);
  return (
    <Dialog title="Pick a model for the agent" onClose={onClose} wide>
      <p className="cx-muted small">Any chat model on your servers (on or hidden for clients). It needs tool calling. The choice is remembered.</p>
      <input className="cx-input" autoFocus type="search" placeholder="Search model or server" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="cx-table-wrap cx-model-dialog">
        <table className="cx-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Server</th>
              <th>Type</th>
              <th className="num">Context</th>
              <th className="num">In $/1M</th>
              <th className="num">Out $/1M</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ s, m }) => (
              <tr
                key={`${s.id}:${m.name}`}
                className={`click ${value?.serverId === s.id && value.model === m.name ? 'sel' : ''}`}
                onClick={() => {
                  onPick({ serverId: s.id, model: m.name });
                  onClose();
                }}
              >
                <td className="mono">{m.name}</td>
                <td className="cx-muted">{s.name}</td>
                <td className="cx-muted">{KIND_LABEL[kindOf(m)]}</td>
                <td className="num tnum">{m.context_len ? `${Math.round(m.context_len / 1000)}k` : '–'}</td>
                <td className="num tnum">{money(m.price_in)}</td>
                <td className="num tnum">{money(m.price_out)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="cx-details-empty">No chat model matches. Add a server first.</p>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- A2UI-style components

function SecretInput({ c, onSaved }: { c: Extract<UiComponent, { kind: 'secret_input' }>; onSaved: (text: string) => void }) {
  const ui = useUi();
  const [v, setV] = useState('');
  const [saved, setSaved] = useState(false);
  if (saved) return <Note>API key saved for {c.serverName}. It went straight to the server; the agent only knows it was saved.</Note>;
  return (
    <form
      className="cx-a2-card"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!v.trim()) return;
        if (await ui.run(() => api(`servers/${c.serverId}`, { method: 'PATCH', body: { apiKey: v.trim() } }), 'API key saved')) {
          setV('');
          setSaved(true);
          onSaved(`I saved the API key for the server "${c.serverName}" (id ${c.serverId}).`);
        }
      }}
    >
      <b>
        <Ico n="key" size={14} /> API key for {c.serverName}
      </b>
      <p className="cx-muted small">Typed here, it goes straight to the server, encrypted. The agent never sees it.</p>
      <div className="cx-form-row nowrap">
        <input className="cx-input grow" type="password" autoComplete="off" value={v} onChange={(e) => setV(e.target.value)} placeholder="Paste the server's API key" aria-label={`API key for ${c.serverName}`} />
        <button type="submit" className="cx-btn pri" disabled={!v.trim()}>
          Save key
        </button>
      </div>
    </form>
  );
}

function SecretReveal({ c }: { c: Extract<UiComponent, { kind: 'secret_reveal' }> }) {
  const ui = useUi();
  const [secret, setSecret] = useState<string | null>(null);
  return (
    <div className="cx-a2-card">
      <b>
        <Ico n="key" size={14} /> Secret of {c.keyName}
      </b>
      <p className="cx-muted small">Shown to you only. The agent never sees it.</p>
      <div className="cx-form-row nowrap">
        <input className="cx-input grow mono" readOnly value={secret ?? '••••••••••••••••••••••••'} aria-label="Key secret" />
        <button type="button" className="cx-btn" onClick={async () => setSecret(secret ? null : (await api<{ secret: string }>(`keys/${c.keyId}/secret`).catch((e) => (ui.toast((e as Error).message, true), { secret: null }))).secret)}>
          {secret ? 'Hide' : 'Reveal'}
        </button>
        <button type="button" className="cx-btn" disabled={!secret} onClick={() => void navigator.clipboard?.writeText(secret ?? '').then(() => ui.toast('Copied'))}>
          Copy
        </button>
      </div>
    </div>
  );
}

function A2({ c, send, confirm, answered }: { c: UiComponent; send: (text: string) => void; confirm: (pending: string, approve: boolean) => void; answered: boolean }) {
  const nav = useNav();
  const [form, setForm] = useState<Record<string, string>>({});
  switch (c.kind) {
    case 'confirm':
      return (
        <div className={`cx-a2-card ${c.danger ? 'danger' : ''}`}>
          <b>
            <Ico n="warning" size={14} /> {c.title}
          </b>
          <code className="small cx-muted">{c.body}</code>
          {answered ? (
            <span className="cx-muted small">Answered.</span>
          ) : (
            <div className="cx-form-row">
              <button type="button" className={`cx-btn ${c.danger ? 'danger' : 'pri'}`} onClick={() => confirm(c.pending, true)}>
                Confirm
              </button>
              <button type="button" className="cx-btn" onClick={() => confirm(c.pending, false)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      );
    case 'secret_input':
      return <SecretInput c={c} onSaved={send} />;
    case 'secret_reveal':
      return <SecretReveal c={c} />;
    case 'table':
      return (
        <div className="cx-a2-card">
          {c.title && <b>{c.title}</b>}
          <div className="cx-table-wrap">
            <table className="cx-table">
              <thead>
                <tr>
                  {c.columns.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {c.rows.slice(0, 200).map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j}>{v ?? '–'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    case 'chart': {
      const max = Math.max(1e-9, ...c.bars.map((b) => b.value));
      return (
        <div className="cx-a2-card">
          {c.title && <b>{c.title}</b>}
          {c.bars.map((b) => (
            <div key={b.label} className="cx-a2-bar" title={b.hint}>
              <span className="mono small">{b.label}</span>
              <span className="cx-bar">
                <i style={{ width: `${(b.value / max) * 100}%` }} />
              </span>
              <span className="tnum small">
                {c.unit === '$' ? '$' : ''}
                {b.value}
                {c.unit && c.unit !== '$' ? ` ${c.unit}` : ''}
              </span>
            </div>
          ))}
        </div>
      );
    }
    case 'choice':
      return (
        <div className="cx-a2-card">
          <b>{c.question}</b>
          <div className="cx-form-row">
            {c.options.map((o) => (
              <button key={o.value} type="button" className="cx-btn" disabled={answered} onClick={() => send(o.label)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      );
    case 'form':
      return (
        <form
          className="cx-a2-card"
          onSubmit={(e) => {
            e.preventDefault();
            send(`${c.title}: ${c.fields.map((f) => `${f.label} = ${form[f.name] ?? f.value ?? ''}`).join('; ')}`);
          }}
        >
          <b>{c.title}</b>
          {c.fields.map((f) => (
            <label key={f.name} className="cx-field">
              <span className="cx-field-label">{f.label}</span>
              {f.type === 'select' ? (
                <select className="cx-input" value={form[f.name] ?? f.value ?? ''} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}>
                  <option value="" />
                  {(f.options ?? []).map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : f.type === 'textarea' ? (
                <textarea className="cx-input" rows={3} value={form[f.name] ?? f.value ?? ''} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })} />
              ) : (
                <input className="cx-input" type={f.type === 'number' ? 'number' : 'text'} value={form[f.name] ?? f.value ?? ''} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })} />
              )}
            </label>
          ))}
          <div className="cx-form-row">
            <button type="submit" className="cx-btn pri" disabled={answered}>
              {c.submit ?? 'Send'}
            </button>
          </div>
        </form>
      );
    case 'diff':
      return <DiffCard title={c.title} before={c.before} after={c.after} />;
    case 'link':
      return (
        <button type="button" className="cx-btn sm cx-a2-link" onClick={() => nav.go(c.path)}>
          <Ico n="forward" size={13} /> {c.label}
        </button>
      );
    case 'ui_effect':
      return c.effect.navigate ? (
        <button type="button" className="cx-btn sm cx-a2-link" onClick={() => nav.go(c.effect.navigate!)}>
          <Ico n="forward" size={13} /> Open {c.effect.navigate}
        </button>
      ) : (
        <span className="cx-muted small">
          <Ico n="settings" size={12} /> Console updated{c.effect.theme ? `: theme ${c.effect.theme}` : c.effect.pref ? `: ${c.effect.pref}` : ''}
        </span>
      );
  }
}

/** Line-level diff of two texts. */
function DiffCard({ title, before, after }: { title: string; before: string; after: string }) {
  const lines = useMemo(() => {
    const a = before.split('\n');
    const b = after.split('\n');
    // Longest common subsequence on lines, small texts only.
    if (a.length * b.length > 250_000) return [...a.map((l) => ['-', l] as const), ...b.map((l) => ['+', l] as const)];
    const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out: (readonly ['-' | '+' | ' ', string])[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        out.push([' ', a[i]]);
        i++;
        j++;
      }
      else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', a[i++]]);
      else out.push(['+', b[j++]]);
    }
    while (i < a.length) out.push(['-', a[i++]]);
    while (j < b.length) out.push(['+', b[j++]]);
    return out;
  }, [before, after]);
  const changed = lines.filter(([k]) => k !== ' ').length;
  return (
    <details className="cx-a2-card cx-diff" open={changed < 30}>
      <summary>
        <b>{title}</b> <span className="cx-muted small">{changed} line{changed === 1 ? '' : 's'} changed</span>
      </summary>
      <pre>
        {lines.map(([k, l], i) => (
          <div key={i} className={k === '+' ? 'add' : k === '-' ? 'del' : ''}>
            {k} {l}
          </div>
        ))}
      </pre>
    </details>
  );
}

// ---------------------------------------------------------------- middle: the chat

type Live = { tokens: string; tools: { id: string; name: string; args: unknown; status: string; result?: unknown }[]; ui: UiComponent[]; error: string | null };

export function AgentChat({ id }: { id: number | null }) {
  const { data } = useStore();
  const nav = useNav();
  const ui = useUi();
  const [saved, setSaved] = usePref<Pick | null>('agent.model', null);
  const [state, setState] = useState<{ chat: Chat; messages: Msg[]; changes: Change[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  const [picking, setPicking] = useState(false);
  const [undo, setUndo] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const pick: Pick | null = state?.chat.model && state.chat.server_id ? { serverId: state.chat.server_id, model: state.chat.model } : saved;
  const { ref: scroller } = useStickToBottom<HTMLDivElement>();

  const load = useCallback(async () => {
    if (!id) return setState(null);
    try {
      setState(await api(`agent/chats/${id}`));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const choose = async (p: Pick) => {
    setSaved(p);
    if (id) {
      await api(`agent/chats/${id}`, { method: 'PATCH', body: { model: p.model, serverId: p.serverId } });
      void load();
    }
  };

  const run = async (path: string, body: unknown, chatId: number) => {
    setBusy(true);
    setLive({ tokens: '', tools: [], ui: [], error: null });
    const ac = new AbortController();
    abort.current = ac;
    try {
      await stream(`/api/admin/agent/chats/${chatId}/${path}`, body, (e) => {
        if (e.type === 'token') setLive((l) => l && { ...l, tokens: l.tokens + e.text });
        else if (e.type === 'assistant') setLive((l) => l && { ...l, tokens: '' });
        else if (e.type === 'tool') setLive((l) => l && { ...l, tools: [...l.tools.filter((t) => t.id !== e.id), { id: e.id, name: e.name, args: e.args, status: e.status, result: e.result }] });
        else if (e.type === 'ui') {
          for (const c of e.components) if (c.kind === 'ui_effect') applyEffect(c.effect);
          setLive((l) => l && { ...l, ui: [...l.ui, ...e.components] });
        } else if (e.type === 'changes' || e.type === 'title') agentChanged();
        else if (e.type === 'error') setLive((l) => l && { ...l, error: e.message });
        if (e.type === 'assistant' || e.type === 'turn') void load();
      }, ac.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') ui.toast((e as Error).message, true);
    } finally {
      setBusy(false);
      abort.current = null;
      await load();
      setLive(null);
      agentChanged();
    }
  };

  const send = async (msg: string) => {
    const t = msg.trim();
    if (!t || busy) return;
    if (!pick) return setPicking(true);
    let chatId = id;
    if (!chatId) {
      const c = await api<Chat>('agent/chats', { body: { model: pick.model, serverId: pick.serverId } });
      chatId = c.id;
      nav.go(pathFor('agent', c.id), { replace: true });
    }
    setText('');
    await run('send', { text: t }, chatId);
  };
  const confirm = (pending: string, approve: boolean) => id && void run('confirm', { pending, approve }, id);

  const answered = useMemo(() => {
    // A confirm/choice/form is answered once a later user message exists.
    const lastUser = Math.max(0, ...(state?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.id));
    return (msgId: number) => msgId < lastUser;
  }, [state?.messages]);

  const turns = useMemo(() => {
    const out: { turn: number; msgs: Msg[] }[] = [];
    for (const m of state?.messages ?? []) {
      const t = out.find((x) => x.turn === m.turn);
      if (t) t.msgs.push(m);
      else out.push({ turn: m.turn, msgs: [m] });
    }
    return out;
  }, [state?.messages]);
  const changesByTurn = useMemo(() => {
    const m = new Map<number, number>();
    for (const c of state?.changes ?? []) if (!c.undone_at) m.set(c.turn, (m.get(c.turn) ?? 0) + 1);
    return m;
  }, [state?.changes]);

  if (!data) return <Loading />;
  const modelLabel = pick ? `${pick.model} · ${data.servers.find((s) => s.id === pick.serverId)?.name ?? '?'}` : 'Pick a model';
  return (
    <div className="cx-agent">
      <div className="cx-agent-head">
        <Ico n="agent" />
        <b className="grow cx-ell">{state?.chat.title ?? 'New chat'}</b>
        <button type="button" className="cx-btn sm" onClick={() => setPicking(true)} title="Pick the model the agent uses">
          <Ico n="model" size={13} /> {modelLabel}
        </button>
      </div>
      <div className="cx-agent-body" ref={scroller}>
        {err && <Note tone="bad">{err}</Note>}
        {!id && !busy && (
          <Empty icon="agent" title="Ask the Opsara agent">
            It can manage everything in this console: groups and keys, context files and MCP docs, guard layers, rules, servers and models, settings. Every change is logged on the right and can be undone. Deleting or revoking always asks you first; secrets never pass through it.
            <div className="cx-agent-tips">
              {['Show me the groups and how many keys each has', 'Create a group "Mobile QA" under Engineering', 'Compare the prices of text models on my servers', 'Write an MCP doc "Release checklist" and share it with Backend'].map((t) => (
                <button key={t} type="button" className="cx-chip" onClick={() => setText(t)}>
                  {t}
                </button>
              ))}
            </div>
          </Empty>
        )}
        {turns.map(({ turn, msgs }) => (
          <div key={turn} className={`cx-aturn ${msgs[0]?.undone ? 'undone' : ''}`}>
            {msgs.map((m) => {
              if (m.role === 'user')
                return (
                  <div key={m.id} className="cx-amsg user">
                    <div className="cx-amsg-body">{m.content}</div>
                    {!m.undone && (
                      <button type="button" className="cx-amsg-undo" title={changesByTurn.get(turn) || [...changesByTurn.keys()].some((t) => t > turn) ? 'Undo to here: revert what the agent changed from this message on' : 'Undo to here'} aria-label="Undo to here" onClick={() => setUndo(turn)}>
                        <Ico n="history" size={13} />
                      </button>
                    )}
                    {m.undone ? <span className="cx-muted small">undone</span> : null}
                  </div>
                );
              if (m.role === 'assistant')
                return (
                  <div key={m.id} className="cx-amsg bot">
                    {m.content && <MdText text={m.content} />}
                    {m.tool_calls?.map((tc) => {
                      const res = msgs.find((x) => x.role === 'tool' && x.tool_call_id === tc.id);
                      return <ToolCard key={tc.id} name={tc.function.name} args={tc.function.arguments} result={res?.content} />;
                    })}
                  </div>
                );
              return m.ui?.length ? (
                <div key={m.id} className="cx-amsg bot">
                  {m.ui.map((c, i) => (
                    <A2 key={i} c={c} send={(t) => void send(t)} confirm={confirm} answered={answered(m.id)} />
                  ))}
                </div>
              ) : null;
            })}
            {changesByTurn.get(turn) ? (
              <div className="cx-amsg-changes">
                <Ico n="edit" size={12} /> {changesByTurn.get(turn)} change{changesByTurn.get(turn) === 1 ? '' : 's'} in this turn (see the log on the right)
              </div>
            ) : null}
          </div>
        ))}
        {live && (
          <div className="cx-aturn">
            <div className="cx-amsg bot">
              {live.tools.map((t) => (
                <ToolCard key={t.id} name={t.name} args={JSON.stringify(t.args)} result={t.result === undefined ? undefined : JSON.stringify(t.result)} status={t.status} />
              ))}
              {live.ui.map((c, i) => (
                <A2 key={i} c={c} send={(t) => void send(t)} confirm={confirm} answered={false} />
              ))}
              {live.tokens ? <MdText text={live.tokens} /> : busy && <span className="cx-typing" aria-label="Working" />}
              {live.error && <Note tone="bad">{live.error}</Note>}
            </div>
          </div>
        )}
      </div>
      <form
        className="cx-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <div className="cx-composer-box">
          <textarea
            value={text}
            rows={2}
            placeholder={pick ? 'Ask the agent to change or explain anything in Opsara (Enter to send, Shift+Enter for a new line)' : 'Pick a model first'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(text);
              }
            }}
            aria-label="Message the agent"
          />
          {busy ? (
            <button type="button" className="cx-icon-btn" title="Stop" aria-label="Stop" onClick={() => abort.current?.abort()}>
              <Ico n="close" />
            </button>
          ) : (
            <button type="submit" className="cx-icon-btn" title="Send" aria-label="Send" disabled={!text.trim()}>
              <Ico n="send" />
            </button>
          )}
        </div>
      </form>
      {picking && <ModelDialog data={data} value={pick} onPick={(p) => void choose(p)} onClose={() => setPicking(false)} />}
      {undo !== null && id && (
        <UndoDialog
          chatId={id}
          turn={undo}
          onClose={() => setUndo(null)}
          onDone={() => {
            setUndo(null);
            void load();
            agentChanged();
          }}
        />
      )}
    </div>
  );
}

function ToolCard({ name, args, result, status }: { name: string; args: string; result?: string; status?: string }) {
  let a: unknown = args;
  try {
    a = JSON.parse(args || '{}');
  } catch {
    /* keep text */
  }
  const short = typeof a === 'object' && a ? Object.entries(a as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === 'string' ? (v.length > 40 ? `${v.slice(0, 40)}…` : v) : JSON.stringify(v)}`).join(', ') : String(a);
  const failed = status === 'error' || (result ?? '').startsWith('{"error"');
  const state = status === 'running' ? 'running' : status === 'pending' ? 'waiting for you' : failed ? 'failed' : result !== undefined ? 'done' : '';
  return (
    <details className={`cx-toolcard ${failed ? 'bad' : ''}`}>
      <summary>
        <Ico n="braces" size={12} /> <b>{name}</b> <span className="cx-muted small cx-ell">{short}</span> {state && <Pill tone={failed ? 'bad' : state === 'done' ? 'ok' : 'info'}>{state}</Pill>}
      </summary>
      <pre className="cx-pre small">{JSON.stringify(a, null, 2)}</pre>
      {result !== undefined && <pre className="cx-pre small">{(() => {
        try {
          return JSON.stringify(JSON.parse(result), null, 2);
        } catch {
          return result;
        }
      })()}</pre>}
    </details>
  );
}

// ---------------------------------------------------------------- undo

interface PlanItem {
  change: Change;
  conflict: boolean;
  impossible: string | null;
}

function UndoDialog({ chatId, turn, only, onClose, onDone }: { chatId: number; turn: number; only?: number[]; onClose: () => void; onDone: () => void }) {
  const ui = useUi();
  const [plan, setPlan] = useState<PlanItem[] | null>(null);
  const [force, setForce] = useState<number[]>([]);
  useEffect(() => {
    api<{ plan: PlanItem[] }>(`agent/chats/${chatId}/undo?turn=${turn}${only ? `&only=${only.join(',')}` : ''}`).then((r) => setPlan(r.plan), (e) => ui.toast((e as Error).message, true));
  }, [chatId, turn, only, ui]);
  const go = async () => {
    const r = await api<{ done: Change[]; skipped: PlanItem[]; ui: { effect: { theme?: string; pref?: string }; before: unknown }[] }>(`agent/chats/${chatId}/undo`, { body: { turn, force, only } }).catch((e) => (ui.toast((e as Error).message, true), null));
    if (!r) return;
    for (const u of r.ui) revertEffect(u.effect);
    ui.toast(`Undone ${r.done.length} change${r.done.length === 1 ? '' : 's'}${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`);
    onDone();
  };
  return (
    <Dialog
      title={only ? 'Revert this change' : 'Undo to here'}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="cx-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="cx-btn danger" onClick={() => void go()} disabled={!plan}>
            {only ? 'Revert' : plan?.length ? `Undo ${plan.length} change${plan.length === 1 ? '' : 's'}` : 'Undo the messages'}
          </button>
        </>
      }
    >
      {!plan ? (
        <Loading />
      ) : (
        <>
          <p>{only ? 'This change is put back the way it was.' : plan.length ? 'Everything the agent changed from this message on is put back, newest first. The messages from here on are marked undone and the agent forgets them.' : 'The agent changed nothing from this message on. The messages are marked undone and the agent forgets them.'}</p>
          {plan.map((p) => (
            <div key={p.change.id} className={`cx-undo-row ${p.conflict || p.impossible ? 'warn' : ''}`}>
              <span className="grow">{p.change.summary}</span>
              {p.impossible ? (
                <Pill tone="bad" title={p.impossible}>
                  Can&apos;t undo
                </Pill>
              ) : p.conflict ? (
                <label className="cx-check small" title="Someone changed this since. Tick to overwrite their change with the old value.">
                  <input type="checkbox" checked={force.includes(p.change.id)} onChange={(e) => setForce(e.target.checked ? [...force, p.change.id] : force.filter((x) => x !== p.change.id))} /> Changed since: overwrite
                </label>
              ) : (
                <Pill>{p.change.action}</Pill>
              )}
            </div>
          ))}
        </>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- right: change log

export function AgentChangeLog() {
  const nav = useNav();
  const id = nav.view === 'agent' && nav.id ? Number(nav.id) : null;
  const [d, setD] = useState<{ messages: Msg[]; changes: Change[] } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [revert, setRevert] = useState<Change | null>(null);
  const load = useCallback(() => (id ? api<{ messages: Msg[]; changes: Change[] }>(`agent/chats/${id}`).then(setD, () => setD(null)) : setD(null)), [id]);
  useEffect(() => {
    void load();
    window.addEventListener('cx-agent', load);
    return () => window.removeEventListener('cx-agent', load);
  }, [load]);
  if (!id) return <p className="cx-details-empty">Changes the agent makes in a chat show here, one row per turn.</p>;
  if (!d) return <Loading />;
  const turns = [...new Set(d.changes.map((c) => c.turn))].sort((a, b) => b - a);
  return (
    <div className="cx-changelog">
      {turns.length === 0 && <p className="cx-details-empty">No changes in this chat yet.</p>}
      {turns.map((t) => {
        const cs = d.changes.filter((c) => c.turn === t);
        const ask = d.messages.find((m) => m.turn === t && m.role === 'user')?.content ?? '';
        const allUndone = cs.every((c) => c.undone_at);
        return (
          <div key={t} className={`cx-cl-turn ${allUndone ? 'undone' : ''}`}>
            <button type="button" className="cx-cl-head" aria-expanded={open === t} onClick={() => setOpen(open === t ? null : t)}>
              <Ico n="chevron" size={11} />
              <span className="grow cx-ell" title={ask}>
                <b>Turn {t}</b> · {ask || 'confirmation'}
              </span>
              <span className="cx-muted small">
                {cs.length} · {clock(cs[0].created_at)}
              </span>
            </button>
            {open === t && (
              <div className="cx-cl-body">
                {cs.map((c) => (
                  <ChangeDetail key={c.id} c={c} onRevert={() => setRevert(c)} />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {revert && (
        <UndoDialog
          chatId={id}
          turn={revert.turn}
          only={[revert.id]}
          onClose={() => setRevert(null)}
          onDone={() => {
            setRevert(null);
            void load();
            agentChanged();
          }}
        />
      )}
    </div>
  );
}

function ChangeDetail({ c, onRevert }: { c: Change; onRevert: () => void }) {
  const show = (v: unknown) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s && s.length > 300 ? `${s.slice(0, 300)}…` : s;
  };
  const rows: [string, unknown, unknown][] = c.action === 'updated' ? c.fields.map((f) => [f, c.before?.[f], c.after?.[f]]) : [];
  return (
    <div className={`cx-cl-change ${c.undone_at ? 'undone' : ''}`}>
      <div className="cx-form-row center nowrap">
        <span className="grow small">
          <b>{c.summary}</b>
        </span>
        {c.undone_at ? (
          <Pill>undone</Pill>
        ) : (
          <button type="button" className="cx-btn sm" onClick={onRevert}>
            Revert
          </button>
        )}
      </div>
      <div className="cx-muted small">
        {c.tool} · {c.tbl === 'ui' ? 'console (UI)' : `table ${c.tbl}`} · row {c.row_id} · {ago(c.created_at)}
      </div>
      {rows.length > 0 && (
        <table className="cx-cl-diff">
          <tbody>
            {rows.map(([f, b, a]) => (
              <tr key={f}>
                <th>{f}</th>
                <td className="del">{show(b)}</td>
                <td className="add">{show(a)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {c.action !== 'updated' && <pre className="cx-pre small">{show(c.action === 'created' ? c.after : c.before)}</pre>}
    </div>
  );
}

export function AgentPage(): ReactNode {
  const nav = useNav();
  return <AgentChat key={nav.id ?? 'new'} id={nav.id ? Number(nav.id) : null} />;
}

