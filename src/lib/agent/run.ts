// The agent loop: the chosen model (on one of your own servers) plans with the tools; each tool runs
// with change tracking; destructive ones wait for the person to confirm. Everything is streamed to the
// console as events and stored, so a chat can be reopened, continued and undone.
import crypto from 'crypto';
import { getDb, now } from '../db';
import { getServer } from '../servers';
import { diff, ensureAgentTables, recordChanges, recordUiEffect, snapshot, type ChangeRow } from './changes';
import { toolByName, toolSpecs, type UiComponent } from './tools';

export type AgentEvent =
  | { type: 'turn'; turn: number; userMessageId: number }
  | { type: 'token'; text: string }
  | { type: 'assistant'; id: number; content: string }
  | { type: 'tool'; id: string; name: string; args: unknown; status: 'running' | 'done' | 'error' | 'pending'; result?: unknown }
  | { type: 'ui'; components: UiComponent[]; toolCallId?: string }
  | { type: 'changes'; changes: ChangeRow[] }
  | { type: 'title'; title: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface ChatRow {
  id: number;
  title: string;
  model: string | null;
  server_id: number | null;
  created_at: number;
  updated_at: number;
}
export interface MessageRow {
  id: number;
  chat_id: number;
  turn: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] | null;
  tool_call_id: string | null;
  name: string | null;
  ui: UiComponent[] | null;
  undone: number;
  created_at: number;
}

const MAX_STEPS = 12;

const SYSTEM = `You are the Opsara agent, built into the Opsara console. Opsara is a security gateway and agentic workspace for coding agents (Cline, Claude Code, Cursor):
- Groups form a tree under a root; settings inherit down it (servers, models, context files, guard layers, MCP docs, rate limit, blocked reply). Sub-groups add to or override a parent's; context files and MCP docs can also be switched off ("excluded") lower down.
- API keys belong to one group and get everything it resolves to, plus their own exceptions.
- Context files are Markdown added to every request; MCP docs are Markdown that agents read on demand over MCP.
- Guard layers run in order before the model (input) or on its answer (output).
- Servers are OpenAI-compatible model backends; their models have a type (text, decision/classifier, embedding, image…) and prices.

How to work:
- Use the tools to read the current state before changing it; use real ids from list tools, never guess.
- Make the change the person asked for, then say in one or two short sentences what you changed. Every change is logged and can be undone from the chat.
- Destructive actions (delete, revoke, rotate, remove a server) wait for the person to confirm in the chat. Ask once; don't call the tool again while it waits.
- Secrets never pass through you. For a server API key, call add_server or request_server_key: the person types it into a secure field. For an API key secret, use reveal_key_secret. Never ask anyone to paste a key into the chat, and never write one out.
- Use show_ui for tables, charts, choices and short forms when they help; keep text answers brief and in plain language.
- If something fails, say what failed and what you'd try next.`;

export function listChats(q?: string): (ChatRow & { preview: string })[] {
  const db = ensureAgentTables();
  const like = `%${q ?? ''}%`;
  return db
    .prepare(
      `SELECT c.*, COALESCE((SELECT content FROM agent_messages m WHERE m.chat_id = c.id AND m.role = 'user' ORDER BY id DESC LIMIT 1), '') AS preview
       FROM agent_chats c
       WHERE ? = '%%' OR c.title LIKE ? OR EXISTS (SELECT 1 FROM agent_messages m WHERE m.chat_id = c.id AND m.content LIKE ?)
       ORDER BY c.updated_at DESC LIMIT 300`,
    )
    .all(like, like, like) as (ChatRow & { preview: string })[];
}

export function getChat(id: number): ChatRow | undefined {
  return ensureAgentTables().prepare('SELECT * FROM agent_chats WHERE id = ?').get(id) as ChatRow | undefined;
}

export function createChat(model: string | null, serverId: number | null): ChatRow {
  const r = ensureAgentTables().prepare('INSERT INTO agent_chats (title, model, server_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('New chat', model, serverId, now(), now());
  return getChat(Number(r.lastInsertRowid))!;
}

export function updateChat(id: number, patch: { title?: string; model?: string | null; serverId?: number | null }) {
  const c = getChat(id);
  if (!c) throw new Error('Chat not found.');
  ensureAgentTables()
    .prepare('UPDATE agent_chats SET title = ?, model = ?, server_id = ?, updated_at = ? WHERE id = ?')
    .run((patch.title ?? c.title).trim().slice(0, 120) || c.title, patch.model === undefined ? c.model : patch.model, patch.serverId === undefined ? c.server_id : patch.serverId, now(), id);
  return getChat(id)!;
}

export function deleteChat(id: number) {
  const db = ensureAgentTables();
  db.prepare('DELETE FROM agent_messages WHERE chat_id = ?').run(id);
  db.prepare('DELETE FROM agent_pending WHERE chat_id = ?').run(id);
  db.prepare('DELETE FROM agent_chats WHERE id = ?').run(id);
  // The change log stays: it is the record of what happened to the gateway.
}

const parseMsg = (r: Record<string, unknown>): MessageRow => ({
  ...(r as unknown as MessageRow),
  tool_calls: r.tool_calls ? JSON.parse(String(r.tool_calls)) : null,
  ui: r.ui ? JSON.parse(String(r.ui)) : null,
});

export function listMessages(chatId: number): MessageRow[] {
  return (ensureAgentTables().prepare('SELECT * FROM agent_messages WHERE chat_id = ? ORDER BY id').all(chatId) as Record<string, unknown>[]).map(parseMsg);
}

function addMessage(m: Omit<MessageRow, 'id' | 'created_at' | 'undone'>): number {
  const r = ensureAgentTables()
    .prepare('INSERT INTO agent_messages (chat_id, turn, role, content, tool_calls, tool_call_id, name, ui, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(m.chat_id, m.turn, m.role, m.content, m.tool_calls ? JSON.stringify(m.tool_calls) : null, m.tool_call_id, m.name, m.ui?.length ? JSON.stringify(m.ui) : null, now());
  getDb().prepare('UPDATE agent_chats SET updated_at = ? WHERE id = ?').run(now(), m.chat_id);
  return Number(r.lastInsertRowid);
}

/** The conversation as the model sees it (undone turns left out). */
function modelMessages(chatId: number) {
  const out: Record<string, unknown>[] = [{ role: 'system', content: `${SYSTEM}\n\nToday is ${new Date().toISOString().slice(0, 10)}.` }];
  for (const m of listMessages(chatId)) {
    if (m.undone) continue;
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') out.push({ role: 'assistant', content: m.content || null, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) });
    else out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
  }
  return out;
}

/**
 * Strip anything secret-bearing from a tool result before the model (or the chat log) sees it, whatever
 * the tool returned: key prefixes and hashes, encrypted secrets, server API keys, refresh hashes.
 */
const SECRET_FIELDS = /^(prefix|hash|secret|secret_enc|secretEnc|api_key|apiKey|refresh_hash|password|token|accessToken|refreshToken)$/i;
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !SECRET_FIELDS.test(k)).map(([k, x]) => [k, redact(x)]));
  // A secret pasted into some text field still never goes out whole.
  if (typeof v === 'string') return v.replace(/\b(ops|grk)_live_[A-Za-z0-9]{4,}/g, '$1_live_••••').replace(/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-••••');
  return v;
}

const clip = (s: string, n = 8000) => (s.length > n ? `${s.slice(0, n)}… (cut, ${s.length} characters)` : s);

/** One model call, streamed: content deltas are emitted as they come; tool calls are put back together. */
async function callModel(serverId: number, model: string, messages: unknown[], emit: (e: AgentEvent) => void, signal?: AbortSignal) {
  const s = getServer(serverId);
  if (!s) throw new Error('The chosen server no longer exists. Pick another model.');
  const res = await fetch(`${s.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(s.api_key ? { Authorization: `Bearer ${s.api_key}` } : {}) },
    body: JSON.stringify({ model, messages, tools: toolSpecs(), tool_choice: 'auto', stream: true, temperature: 0.2 }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`${s.name} answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  let content = '';
  const calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];
  let tail = '';
  const dec = new TextDecoder();
  const reader = res.body.getReader();
  const line = (l: string) => {
    const t = l.trim();
    if (!t.startsWith('data:')) return;
    const data = t.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let j: { choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; message?: { content?: string; tool_calls?: typeof calls } }[] };
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    const c = j.choices?.[0];
    // Streaming servers send deltas; a server that ignores stream sends one whole message.
    const d = (c?.delta ?? c?.message) as { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } | undefined;
    if (!d) return;
    if (typeof d.content === 'string' && d.content) {
      content += d.content;
      emit({ type: 'token', text: d.content });
    }
    for (const tc of d.tool_calls ?? []) {
      const i = tc.index ?? calls.length;
      const cur = (calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.function.name += tc.function.name;
      if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const lines = (tail + dec.decode(value, { stream: true })).split('\n');
    tail = lines.pop() ?? '';
    lines.forEach(line);
  }
  if (tail) line(tail);
  return { content, toolCalls: calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}_${crypto.randomBytes(4).toString('hex')}` })) };
}

/** Run one tool with change tracking. Destructive tools are parked until the person confirms. */
async function runTool(chatId: number, turn: number, call: { id: string; function: { name: string; arguments: string } }, emit: (e: AgentEvent) => void, confirmed = false) {
  const tool = toolByName.get(call.function.name);
  let args: Record<string, unknown> = {};
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return { content: JSON.stringify({ error: 'The arguments were not valid JSON.' }), ui: [] as UiComponent[] };
  }
  if (!tool) return { content: JSON.stringify({ error: `No tool ${call.function.name}.` }), ui: [] as UiComponent[] };
  const ask = !confirmed ? tool.confirm?.(args) : null;
  if (ask) {
    const pending = crypto.randomBytes(9).toString('base64url');
    ensureAgentTables().prepare('INSERT INTO agent_pending (id, chat_id, turn, tool, args, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(pending, chatId, turn, tool.name, JSON.stringify(args), now());
    const ui: UiComponent[] = [{ kind: 'confirm', pending, title: ask, body: `${tool.name}(${JSON.stringify(args)})`, danger: true }];
    emit({ type: 'tool', id: call.id, name: tool.name, args, status: 'pending' });
    emit({ type: 'ui', components: ui, toolCallId: call.id });
    return { content: JSON.stringify({ waiting: 'Shown a Confirm button to the person. Nothing changed yet. Do not call it again; tell them what you are asking.' }), ui };
  }
  emit({ type: 'tool', id: call.id, name: tool.name, args, status: 'running' });
  const before = tool.touches.length ? snapshot(tool.touches) : null;
  try {
    const out = await tool.run(args, { chatId, turn });
    const changes = before ? recordChanges(chatId, turn, tool.name, diff(before, snapshot(tool.touches))) : [];
    if (out.uiEffect) recordUiEffect(chatId, turn, tool.name, out.uiEffect.summary, out.uiEffect.effect, null);
    if (changes.length || out.uiEffect) emit({ type: 'changes', changes });
    const ui = out.ui ?? [];
    out.result = redact(out.result);
    emit({ type: 'tool', id: call.id, name: tool.name, args, status: 'done', result: out.result });
    if (ui.length) emit({ type: 'ui', components: ui, toolCallId: call.id });
    return { content: clip(JSON.stringify(out.result ?? { ok: true })), ui };
  } catch (e) {
    // A failed write can still have changed something part-way: log what did change.
    if (before) {
      const changes = recordChanges(chatId, turn, tool.name, diff(before, snapshot(tool.touches)));
      if (changes.length) emit({ type: 'changes', changes });
    }
    const message = e instanceof Error ? e.message : String(e);
    emit({ type: 'tool', id: call.id, name: tool.name, args, status: 'error', result: message });
    return { content: JSON.stringify({ error: message }), ui: [] as UiComponent[] };
  }
}

const nextTurn = (chatId: number) => (((ensureAgentTables().prepare('SELECT MAX(turn) t FROM agent_messages WHERE chat_id = ?').get(chatId) as { t: number | null }).t ?? 0) + 1);

/** The agent's side of one turn: model, tools, model… until it answers without tools. */
async function loop(chatId: number, turn: number, emit: (e: AgentEvent) => void, signal?: AbortSignal) {
  const chat = getChat(chatId)!;
  if (!chat.model || !chat.server_id) throw new Error('Pick a model first.');
  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await callModel(chat.server_id, chat.model, modelMessages(chatId), emit, signal);
    const id = addMessage({ chat_id: chatId, turn, role: 'assistant', content: r.content, tool_calls: r.toolCalls.length ? r.toolCalls : null, tool_call_id: null, name: null, ui: null });
    emit({ type: 'assistant', id, content: r.content });
    if (!r.toolCalls.length) return;
    for (const call of r.toolCalls) {
      const out = await runTool(chatId, turn, call, emit);
      addMessage({ chat_id: chatId, turn, role: 'tool', content: out.content, tool_calls: null, tool_call_id: call.id, name: call.function.name, ui: out.ui });
    }
  }
  emit({ type: 'error', message: `Stopped after ${MAX_STEPS} steps. Say "continue" to let it go on.` });
}

export async function sendMessage(chatId: number, text: string, emit: (e: AgentEvent) => void, signal?: AbortSignal) {
  const chat = getChat(chatId);
  if (!chat) throw new Error('Chat not found.');
  const turn = nextTurn(chatId);
  const userId = addMessage({ chat_id: chatId, turn, role: 'user', content: text, tool_calls: null, tool_call_id: null, name: null, ui: null });
  emit({ type: 'turn', turn, userMessageId: userId });
  if (chat.title === 'New chat') {
    const title = text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
    updateChat(chatId, { title });
    emit({ type: 'title', title });
  }
  await loop(chatId, turn, emit, signal);
}

/** The person answered a Confirm card: run (or skip) the parked tool, then let the agent carry on. */
export async function resolvePending(chatId: number, pendingId: string, approve: boolean, emit: (e: AgentEvent) => void, signal?: AbortSignal) {
  const db = ensureAgentTables();
  const p = db.prepare('SELECT * FROM agent_pending WHERE id = ? AND chat_id = ?').get(pendingId, chatId) as { id: string; turn: number; tool: string; args: string; done_at: number | null } | undefined;
  if (!p) throw new Error('That confirmation is gone.');
  if (p.done_at) throw new Error('Already answered.');
  db.prepare('UPDATE agent_pending SET done_at = ? WHERE id = ?').run(now(), pendingId);
  const turn = nextTurn(chatId);
  const tool = toolByName.get(p.tool)!;
  const text = approve ? `Confirmed: ${tool.confirm?.(JSON.parse(p.args)) ?? p.tool}` : `Cancelled: ${p.tool}`;
  const userId = addMessage({ chat_id: chatId, turn, role: 'user', content: text, tool_calls: null, tool_call_id: null, name: null, ui: null });
  emit({ type: 'turn', turn, userMessageId: userId });
  if (approve) {
    const call = { id: `confirm_${pendingId}`, function: { name: p.tool, arguments: p.args } };
    // Shown as the agent's own call, so the model sees the result in order.
    const aid = addMessage({ chat_id: chatId, turn, role: 'assistant', content: '', tool_calls: [{ ...call, type: 'function' }], tool_call_id: null, name: null, ui: null });
    emit({ type: 'assistant', id: aid, content: '' });
    const out = await runTool(chatId, turn, call, emit, true);
    addMessage({ chat_id: chatId, turn, role: 'tool', content: out.content, tool_calls: null, tool_call_id: call.id, name: p.tool, ui: out.ui });
  }
  await loop(chatId, turn, emit, signal);
}

/** Text models the agent can use: on any server, chat-capable (not decision-only). */
export function agentModels() {
  return getDb()
    .prepare("SELECT m.id, m.name, m.server_id, s.name AS server, m.price_in, m.price_out, m.context_len, COALESCE(m.kind_override, m.kind, 'text') AS kind FROM models m JOIN servers s ON s.id = m.server_id WHERE COALESCE(m.api, '') != 'decisions' ORDER BY m.name")
    .all();
}
