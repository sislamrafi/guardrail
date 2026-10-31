// Send a request through the real gateway as a client would, from inside the admin panel.
// Studio and Activity's Replay both use this: same auth, rules, guard layers, context and model call.
import { type LiveEvent, handleCompletion, type Trace } from './gateway';
import { getGroup } from './groups';
import { type ApiKey, getKey } from './keys';
import type { GuardLayer } from './layers';
import { getLog, type LogEntry } from './logs';

export interface ClientRun {
  status: number;
  ms: number;
  streamed: boolean;
  blocked: boolean;
  text: string;
  /** Tool calls the model asked for, when it answered with them. */
  toolCalls: unknown[];
  error: string | null;
  raw: string;
  trace: Trace;
  log: LogEntry | null;
}

/** A key that stands for "any key in this group", for Studio's act-as-group mode. */
export function groupKey(groupId: number): ApiKey {
  const g = getGroup(groupId);
  if (!g) throw new Error('Group not found.');
  return { id: 0, name: `Studio · ${g.name}`, owner: 'Admin', groupId, prefix: '', exceptions: {}, expiresAt: null, revoked: false, lastUsedAt: null, createdAt: 0, ipAllow: [], canReveal: false };
}

export async function runAsClient(input: {
  /** Act as this key (no secret needed), as a whole group, or with a pasted secret through normal auth. */
  keyId?: number;
  groupId?: number;
  secret?: string;
  path?: string;
  body: unknown;
  headers?: Record<string, string>;
  source: 'Studio' | 'Replay';
  /** Live progress: gateway events, plus the answer's tokens as they stream in. */
  onEvent?: (e: LiveEvent | { type: 'token'; text: string }) => void;
  /** The admin's own address, logged as the client address. */
  ip?: string | null;
  layers?: GuardLayer[];
}): Promise<ClientRun> {
  const path = input.path === '/v1/completions' ? '/v1/completions' : '/v1/chat/completions';
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    try {
      headers.set(k, String(v));
    } catch {
      // ignore bad header names
    }
  }
  let key: ApiKey | undefined;
  if (input.keyId) {
    key = getKey(input.keyId);
    if (!key) throw new Error('Key not found.');
  } else if (input.groupId) key = groupKey(input.groupId);
  else if (input.secret?.trim()) headers.set('authorization', `Bearer ${input.secret.trim()}`);
  const payload = typeof input.body === 'string' ? input.body : JSON.stringify(input.body ?? {});
  const trace: Trace = {};
  const t0 = Date.now();
  const res = await handleCompletion(new Request(`http://studio${path}`, { method: 'POST', headers, body: payload }), path === '/v1/completions' ? 'completions' : 'chat', { key, trace, source: input.source, ip: input.ip, layers: input.layers, onEvent: input.onEvent });
  // With a live listener, read the stream as it comes and pass each piece of text on.
  let raw = '';
  if (input.onEvent && res.body && (res.headers.get('content-type') ?? '').includes('event-stream')) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let tail = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      raw += chunk;
      const lines = (tail + chunk).split('\n');
      tail = lines.pop() ?? '';
      for (const l of lines) {
        if (!l.startsWith('data:') || l.includes('[DONE]')) continue;
        try {
          const c = JSON.parse(l.slice(5)).choices?.[0];
          const t = c?.delta?.content ?? c?.text ?? '';
          if (t) input.onEvent({ type: 'token', text: t });
        } catch {
          // a keep-alive or partial line
        }
      }
    }
  } else raw = await res.text();
  const ms = Date.now() - t0;
  const sse = (res.headers.get('content-type') ?? '').includes('event-stream');
  let text = '';
  let error: string | null = null;
  const toolCalls: unknown[] = [];
  try {
    if (sse) {
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
        const c = JSON.parse(line.slice(5)).choices?.[0];
        text += c?.delta?.content ?? c?.text ?? '';
        if (Array.isArray(c?.delta?.tool_calls)) toolCalls.push(...c.delta.tool_calls);
      }
    } else {
      const j = JSON.parse(raw);
      if (j.error) error = j.error.message ?? String(j.error);
      else {
        const m = j.choices?.[0]?.message;
        text = m?.content ?? j.choices?.[0]?.text ?? '';
        if (Array.isArray(m?.tool_calls)) toolCalls.push(...m.tool_calls);
      }
    }
  } catch {
    text = raw;
  }
  return {
    status: res.status,
    ms,
    streamed: sse,
    blocked: res.headers.get('x-guardrail-blocked') === '1',
    text,
    toolCalls,
    error,
    raw: raw.length > 20000 ? raw.slice(0, 20000) + '\n…' : raw,
    trace,
    log: trace.requestId ? (getLog(trace.requestId) ?? null) : null,
  };
}

/** Send a logged request again through today's setup, as the same key (or its group if the key is gone). */
export async function replayLog(id: string, layers?: GuardLayer[], ip?: string | null) {
  const l = getLog(id);
  if (!l) throw new Error('Request not found.');
  if (!l.prompt?.length) throw new Error(l.prompt_expired ? 'The prompt of this request was deleted by the retention rule, so it cannot be replayed.' : 'No prompt was recorded for this request, so it cannot be replayed.');
  const completions = l.path === '/v1/completions';
  const body = completions ? { model: l.model, prompt: l.prompt.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'), stream: false } : { model: l.model, messages: l.prompt, stream: false };
  const keyId = l.key_id && getKey(l.key_id) ? l.key_id : undefined;
  const groupId = !keyId && l.group_id ? l.group_id : undefined;
  if (!keyId && !groupId) throw new Error('Neither the key nor the group of this request exists any more.');
  const run = await runAsClient({ keyId, groupId, path: completions ? '/v1/completions' : '/v1/chat/completions', body, source: 'Replay', ip, layers });
  return { original: { id: l.id, outcome: l.outcome, reason: l.reason, decisions: l.decisions ?? null, ts: l.ts, response: l.response ?? null }, replay: run };
}
