import { describe, expect, it } from 'vitest';
import { buildRequest, parseTools } from '@/lib/studio-body';
import { DEFAULT_SCENARIO } from '@/lib/studio';

const s = { ...DEFAULT_SCENARIO, model: 'qwen', system: 'You are Cline.' };
const msgs = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
  { role: 'user', content: 'list files' },
];

describe('Studio request builder', () => {
  it('builds OpenAI chat with system, tools and options', () => {
    const r = buildRequest({ ...s, tools: '[{"name":"read_file","parameters":{"type":"object"}}]', temperature: 0.2, maxTokens: 100 }, msgs, [{ name: 'a.md', body: '# A' }]);
    expect(r.path).toBe('/v1/chat/completions');
    const b = r.body as { messages: { role: string; content: string }[]; tools: unknown[]; temperature: number; max_tokens: number };
    expect(b.messages[0].role).toBe('system');
    expect(b.messages[0].content).toContain('<attached_file name="a.md">');
    expect(b.messages).toHaveLength(4);
    expect(b.tools).toEqual([{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }]);
    expect([b.temperature, b.max_tokens]).toEqual([0.2, 100]);
  });

  it('builds legacy completions and Anthropic-style bodies', () => {
    expect(buildRequest({ ...s, schema: 'openai_completions' }, msgs).body.prompt).toMatch(/user: list files\n\nassistant:$/);
    const a = buildRequest({ ...s, schema: 'anthropic_messages' }, msgs);
    expect(a.headers['anthropic-version']).toBe('2023-06-01');
    expect(a.body.system).toBe('You are Cline.');
  });

  it('rejects broken tool JSON', () => {
    expect(() => parseTools('{nope')).toThrow();
    expect(parseTools('  ')).toBeNull();
  });
});
