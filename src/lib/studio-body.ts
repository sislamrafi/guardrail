// Builds the HTTP request a client of the chosen schema would send for a Studio conversation.
import type { PromptMessage } from './logs';
import type { ScenarioSettings } from './studio';

export interface BuiltRequest {
  path: '/v1/chat/completions' | '/v1/completions';
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const text = (m: PromptMessage) => (typeof m.content === 'string' ? m.content : m.content == null ? '' : JSON.stringify(m.content));

/** Parse the tools box; invalid JSON is an error the user sees before sending. */
export function parseTools(src: string): unknown[] | null {
  if (!src.trim()) return null;
  const v = JSON.parse(src) as unknown;
  const list = Array.isArray(v) ? v : [v];
  return list.map((t) => (t && typeof t === 'object' && 'function' in (t as object) ? t : { type: 'function', function: t }));
}

export function buildRequest(s: ScenarioSettings, messages: PromptMessage[], extraContext: { name: string; body: string }[] = []): BuiltRequest {
  const ctx = extraContext.map((f) => `<attached_file name="${f.name}">\n${f.body.trim()}\n</attached_file>`).join('\n\n');
  const system = [s.system.trim(), ctx].filter(Boolean).join('\n\n');
  const common: Record<string, unknown> = { model: s.model, stream: s.stream };
  if (s.temperature != null) common.temperature = s.temperature;
  const tools = parseTools(s.tools);
  if (s.schema === 'openai_completions') {
    const prompt = [system, ...messages.map((m) => `${m.role}: ${text(m)}`)].filter(Boolean).join('\n\n') + '\n\nassistant:';
    return { path: '/v1/completions', headers: {}, body: { ...common, prompt, ...(s.maxTokens ? { max_tokens: s.maxTokens } : {}) } };
  }
  if (s.schema === 'anthropic_messages') {
    const msgs = messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: [{ type: 'text', text: text(m) }] }));
    return { path: '/v1/chat/completions', headers: { 'anthropic-version': '2023-06-01' }, body: { ...common, system, messages: msgs, max_tokens: s.maxTokens ?? 1024 } };
  }
  return {
    path: '/v1/chat/completions',
    headers: {},
    body: { ...common, messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages], ...(tools ? { tools } : {}), ...(s.maxTokens ? { max_tokens: s.maxTokens } : {}) },
  };
}
