'use client';

import { useEffect, useRef, useState } from 'react';
import { messageText } from '@/components/prompt-view';
import type { PromptMessage } from '@/lib/logs';
import { Ico } from './icons';
import { Pill, fmt } from './kit';

// Cline sends tool output back inside user messages, starting like "[read_file for 'x'] Result:".
const CLINE_TOOL = /^\s*\[([\w-]+)(?: for [^\]]*)?\] Result:/;

type Part = { kind: 'text'; role: string; text: string; mark?: string | null } | { kind: 'tool-call'; name: string; args: string } | { kind: 'tool-result'; name: string; text: string } | { kind: 'system'; text: string };

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

/** A conversation like a chat app: bubbles, collapsed tools and system prompt, scrolled to the end. */
export function ChatView({ messages, marks, empty, tail }: { messages: PromptMessage[] | null | undefined; marks?: (string | null)[]; empty: string; tail?: React.ReactNode }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages, tail]);
  if (!messages?.length && !tail) return <div className="cx-note">{empty}</div>;
  const parts = toParts(messages ?? [], marks);
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
            <div className="cx-turn-body">{p.text}</div>
          </div>
        );
      })}
      {tail}
      <div ref={end} />
    </div>
  );
}

function Fold({ icon, title, sub, text, tone }: { icon: 'settings' | 'code' | 'file'; title: string; sub?: string; text: string; tone?: 'call' | 'result' }) {
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
