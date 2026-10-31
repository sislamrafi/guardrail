'use client';

import { useEffect, useRef, useState } from 'react';
import { messageText } from '@/components/prompt-view';
import type { ModelResponse, PromptMessage } from '@/lib/logs';
import { Ico } from './icons';
import { Pill, fmt } from './kit';
import { MdText } from './md-text';

// Cline sends tool output back inside user messages, starting like "[read_file for 'x'] Result:".
const CLINE_TOOL = /^\s*\[([\w-]+)(?: for [^\]]*)?\] Result:/;

export type Part = { kind: 'text'; role: string; text: string; mark?: string | null } | { kind: 'tool-call'; name: string; args: string } | { kind: 'tool-result'; name: string; text: string } | { kind: 'system'; text: string };

/** Turn chat messages into bubbles and collapsible tool blocks. */
export function toParts(messages: PromptMessage[], marks?: (string | null)[]): Part[] {
  const out: Part[] = [];
  messages.forEach((m, i) => {
    const role = String(m.role ?? 'user');
    const text = messageText(m);
    if (role === 'system' || role === 'developer') return void out.push({ kind: 'system', text });
    if (role === 'tool' || role === 'function') return void out.push({ kind: 'tool-result', name: String(m.name ?? m.tool_call_id ?? 'tool'), text });
    // Anthropic-style content blocks.
    if (Array.isArray(m.content)) {
      for (const b of m.content as Record<string, unknown>[]) {
        if (b?.type === 'tool_use') out.push({ kind: 'tool-call', name: String(b.name ?? 'tool'), args: JSON.stringify(b.input ?? {}, null, 2) });
        else if (b?.type === 'tool_result') out.push({ kind: 'tool-result', name: String(b.tool_use_id ?? 'tool'), text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content, null, 2) });
      }
    }
    const cline = role === 'user' ? CLINE_TOOL.exec(text) : null;
    if (cline) return void out.push({ kind: 'tool-result', name: cline[1], text });
    if (text.trim()) out.push({ kind: 'text', role, text, mark: marks?.[i] ?? null });
    const calls = (m as { tool_calls?: { function?: { name?: string; arguments?: string } }[] }).tool_calls;
    if (Array.isArray(calls)) for (const c of calls) out.push({ kind: 'tool-call', name: c.function?.name ?? 'tool', args: prettyArgs(c.function?.arguments) });
  });
  return out;
}

const prettyArgs = (a: unknown) => {
  if (typeof a !== 'string') return JSON.stringify(a ?? {}, null, 2);
  try {
    return JSON.stringify(JSON.parse(a), null, 2);
  } catch {
    return a;
  }
};

/** Message types the chat filter can show or hide. */
export type MsgKind = 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'system';
export const MSG_KINDS: [MsgKind, string][] = [
  ['user', 'User'],
  ['assistant', 'Assistant'],
  ['tool-call', 'Tool calls'],
  ['tool-result', 'Tool results'],
  ['system', 'System'],
];
export const kindOf = (p: Part): MsgKind => (p.kind === 'text' ? (p.role === 'user' ? 'user' : 'assistant') : p.kind);

/** How many messages of each type a chat (plus this turn's reply) has, for the filter's counts. */
export function countKinds(messages: PromptMessage[] | null | undefined, reply?: ModelResponse | null): Record<MsgKind, number> {
  const n: Record<MsgKind, number> = { user: 0, assistant: 0, 'tool-call': 0, 'tool-result': 0, system: 0 };
  for (const p of toParts([...(messages ?? []), ...(reply ? [reply.message] : [])])) n[kindOf(p)]++;
  return n;
}

/** A conversation like a chat app: bubbles, collapsed tools and system prompt, scrolled to the end. */
export function ChatView({ messages, marks, empty, tail, show }: { messages: PromptMessage[] | null | undefined; marks?: (string | null)[]; empty: string; tail?: React.ReactNode; show?: MsgKind[] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages, tail]);
  if (!messages?.length && !tail) return <div className="cx-note">{empty}</div>;
  const parts = toParts(messages ?? [], marks).filter((p) => !show?.length || show.includes(kindOf(p)));
  return (
    <div className="cx-thread">
      {parts.map((p, i) => {
        if (p.kind === 'system') return <Fold key={i} icon="settings" title="System prompt" sub={`${fmt(p.text.length)} chars`} text={p.text} />;
        if (p.kind === 'tool-call') return <Fold key={i} icon="code" title={`Tool call · ${p.name}`} text={p.args} tone="call" />;
        if (p.kind === 'tool-result') return <Fold key={i} icon="file" title={`Tool result · ${p.name}`} sub={`${fmt(p.text.length)} chars`} text={p.text} tone="result" />;
        return (
          <div key={i} className={`cx-turn ${p.role === 'user' ? 'me' : ''}`}>
            <div className="cx-turn-head">
              <span>{p.role}</span>
              {p.mark && <Pill tone="info">{p.mark === 'added' ? 'Added by GuardRail' : 'Changed by GuardRail'}</Pill>}
            </div>
            <MdText text={p.text} />
          </div>
        );
      })}
      {tail}
      <div ref={end} />
    </div>
  );
}

export function Fold({ icon, title, sub, text, tone }: { icon: 'settings' | 'code' | 'file'; title: string; sub?: string; text: string; tone?: 'call' | 'result' }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`cx-fold ${tone ?? ''}`}>
      <button type="button" className="cx-fold-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Ico n="chevron" size={12} />
        <Ico n={icon} size={13} />
        <span>{title}</span>
        {sub && <span className="cx-muted small">{sub}</span>}
      </button>
      {open && <pre className="cx-fold-body">{text}</pre>}
    </div>
  );
}

/** This turn's answer, after the last message: the model's reply and tool calls, the blocked message, or the error. */
export function ResponseTail({ r, show, ms: latency, outcome }: { r: ModelResponse | null | undefined; show?: MsgKind[]; ms?: string; outcome: string }) {
  const want = (k: MsgKind) => !show?.length || show.includes(k);
  if (!r) {
    if (outcome === 'rejected' || !want('assistant')) return null;
    return <div className="cx-note">Response not recorded (an older request, from before replies were kept).</div>;
  }
  const calls = r.message.tool_calls ?? [];
  const text = typeof r.message.content === 'string' ? r.message.content : JSON.stringify(r.message.content ?? '', null, 2);
  const facts = [r.finish_reason && `finish: ${r.finish_reason}`, r.usage?.completion_tokens != null && `${r.usage.completion_tokens} tokens`, latency, r.streamed && 'streamed', r.interrupted && 'client stopped reading', r.truncated && 'cut at 1 MB'].filter(Boolean);
  return (
    <div className="cx-response">
      <div className="cx-response-head">
        <span>This turn&apos;s response</span>
        {facts.length > 0 && <span className="cx-muted small">{facts.join(' · ')}</span>}
      </div>
      {r.error && want('assistant') && (
        <div className="cx-turn blocked">
          <div className="cx-turn-head">
            <span>model error</span>
          </div>
          <pre className="cx-turn-body">{r.error}</pre>
        </div>
      )}
      {r.message.reasoning && want('assistant') && <Fold icon="settings" title="Reasoning" sub={`${fmt(r.message.reasoning.length)} chars`} text={r.message.reasoning} />}
      {(text.trim() || (!calls.length && !r.error)) && want('assistant') && (
        <div className={`cx-turn ${r.blocked ? 'blocked' : ''}`}>
          <div className="cx-turn-head">
            <span>{r.blocked ? 'blocked reply' : 'assistant'}</span>
          </div>
          <MdText text={text || '(empty reply)'} />
        </div>
      )}
      {want('tool-call') && calls.map((c, i) => <Fold key={c.id ?? i} icon="code" title={`Tool call · ${c.function?.name ?? 'tool'}`} sub={c.id} text={prettyArgs(c.function?.arguments)} tone="call" />)}
    </div>
  );
}
