import { describe, expect, it } from 'vitest';
import { parseModel } from '../src/lib/servers';

describe('parseModel', () => {
  it('reads vLLM max_model_len and has no price', () => {
    expect(parseModel({ id: 'qwen', max_model_len: 32768 })).toEqual({ name: 'qwen', contextLen: 32768, priceIn: null, priceOut: null });
  });

  it('reads OpenRouter context_length and per-token pricing as USD per 1M', () => {
    const m = parseModel({ id: 'openai/gpt', context_length: 400000, pricing: { prompt: '0.0000003', completion: '0.0000012' } });
    expect(m).toEqual({ name: 'openai/gpt', contextLen: 400000, priceIn: 0.3, priceOut: 1.2 });
  });

  it('falls back to top_provider.context_length and treats free and variable prices', () => {
    expect(parseModel({ id: 'a:free', top_provider: { context_length: 8192 }, pricing: { prompt: '0', completion: '0' } })).toMatchObject({ contextLen: 8192, priceIn: 0, priceOut: 0 });
    expect(parseModel({ id: 'router', pricing: { prompt: '-1', completion: 'x' } })).toMatchObject({ contextLen: null, priceIn: null, priceOut: null });
  });
});
