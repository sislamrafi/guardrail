import { describe, expect, it } from 'vitest';
import { detectKind, parseModel } from '../src/lib/servers';

describe('parseModel', () => {
  it('reads vLLM max_model_len and has no price', () => {
    expect(parseModel({ id: 'qwen', max_model_len: 32768 })).toEqual({ name: 'qwen', kind: 'text', contextLen: 32768, priceIn: null, priceOut: null });
  });

  it('reads OpenRouter context_length and per-token pricing as USD per 1M', () => {
    const m = parseModel({ id: 'openai/gpt', context_length: 400000, pricing: { prompt: '0.0000003', completion: '0.0000012' } });
    expect(m).toEqual({ name: 'openai/gpt', kind: 'text', contextLen: 400000, priceIn: 0.3, priceOut: 1.2 });
  });

  it('falls back to top_provider.context_length and treats free and variable prices', () => {
    expect(parseModel({ id: 'a:free', top_provider: { context_length: 8192 }, pricing: { prompt: '0', completion: '0' } })).toMatchObject({ contextLen: 8192, priceIn: 0, priceOut: 0 });
    expect(parseModel({ id: 'router', pricing: { prompt: '-1', completion: 'x' } })).toMatchObject({ contextLen: null, priceIn: null, priceOut: null });
  });
});

describe('detectKind', () => {
  it('reads OpenRouter modalities', () => {
    expect(detectKind({ id: 'openai/gpt', architecture: { modality: 'text+image->text' } })).toBe('text');
    expect(detectKind({ id: 'google/gemini-image', architecture: { input_modalities: ['text'], output_modalities: ['image'] } })).toBe('image');
    expect(detectKind({ id: 'x/tts', architecture: { modality: 'text->audio' } })).toBe('audio');
    expect(detectKind({ id: 'x/embedder', architecture: { modality: 'text->embeddings' } })).toBe('embedding');
  });

  it('uses the vLLM task when present', () => {
    expect(detectKind({ id: 'some-model', task: 'embed' })).toBe('embedding');
    expect(detectKind({ id: 'some-model', task: 'classify' })).toBe('classifier');
    expect(detectKind({ id: 'some-model', task: 'score' })).toBe('rerank');
  });

  it('falls back to the name', () => {
    expect(detectKind({ id: 'leolee99/PIGuard' })).toBe('classifier');
    expect(detectKind({ id: 'openai/gpt-oss-safeguard-20b' })).toBe('classifier');
    expect(detectKind({ id: 'meta-llama/Llama-Guard-3-8B' })).toBe('classifier');
    expect(detectKind({ id: 'BAAI/bge-m3' })).toBe('embedding');
    expect(detectKind({ id: 'BAAI/bge-reranker-v2-m3' })).toBe('rerank');
    expect(detectKind({ id: 'Qwen/Qwen2.5-VL-7B-Instruct' })).toBe('image');
    expect(detectKind({ id: 'openai/whisper-large-v3' })).toBe('audio');
    expect(detectKind({ id: 'qwen3-coder-30b' })).toBe('text');
  });

  it('is returned by parseModel', () => {
    expect(parseModel({ id: 'nomic-ai/nomic-embed-text-v1.5' }).kind).toBe('embedding');
  });
});
