// The guard pipeline: an ordered list of layers between "key accepted" and "call the model".
// The old fixed pair (PIGuard, then the OSS judge) becomes two layers with ids "piguard" and "judge".
import { type AdapterId, ADAPTERS, detectAdapter } from './adapters';

export const LAYER_TYPES = {
  classifier: 'Classifier model (PIGuard, Llama Guard, moderation…)',
  judge: 'LLM judge with a system prompt',
  patterns: 'Built-in injection patterns (no model)',
  redactor: 'Built-in secrets and PII redactor (no model)',
} as const;
export type LayerType = keyof typeof LAYER_TYPES;

export interface GuardLayer {
  id: string;
  name: string;
  /** The default for every group; groups can switch a layer on or off for themselves. */
  enabled: boolean;
  type: LayerType;
  adapter: AdapterId | 'auto';
  serverId: number | null;
  model: string;
  /** System prompt for judges. Groups can add lines. */
  prompt: string;
  /** Extra guidance appended to the judge prompt. */
  passHint: string;
  failHint: string;
  /** Score at or above which a scoring model counts as a hit. */
  threshold: number;
  /** For classifiers whose output is a probability list: which index means "attack". */
  labelIndex: number;
  /** "all": every request. "flagged": only when an earlier layer flagged it, or when no earlier layer screened it. */
  scope: 'all' | 'flagged';
  /** What a hit does: stop the request, pass it on to later layers as flagged, or redact the match. */
  onFail: 'block' | 'flag' | 'redact';
  /** When the model fails, times out or answers nonsense. "patterns" falls back to the built-in patterns. */
  onError: 'allow' | 'block' | 'patterns';
  timeoutMs: number;
  reasoningEffort: 'low' | 'medium' | 'high';
}

export const LAYER_DEFAULTS: Omit<GuardLayer, 'id' | 'name' | 'type'> = {
  enabled: true,
  adapter: 'auto',
  serverId: null,
  model: '',
  prompt: '',
  passHint: '',
  failHint: '',
  threshold: 0.7,
  labelIndex: 1,
  scope: 'all',
  onFail: 'block',
  onError: 'block',
  timeoutMs: 5000,
  reasoningEffort: 'low',
};

const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => ((allowed as readonly string[]).includes(String(v)) ? (v as T) : d);
const clamp = (n: unknown, lo: number, hi: number, d: number) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
};

/** Clean one layer from untrusted input. */
export function normalizeLayer(raw: Partial<GuardLayer>, i = 0): GuardLayer {
  const type = pick(raw.type, Object.keys(LAYER_TYPES) as LayerType[], 'judge');
  const id = String(raw.id ?? '').trim().replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || `layer-${Date.now().toString(36)}-${i}`;
  return {
    id,
    name: String(raw.name ?? '').trim().slice(0, 80) || LAYER_TYPES[type],
    enabled: raw.enabled !== false,
    type,
    adapter: raw.adapter === 'auto' ? 'auto' : pick(raw.adapter, Object.keys(ADAPTERS) as AdapterId[], 'auto' as AdapterId),
    serverId: raw.serverId ? Number(raw.serverId) || null : null,
    model: String(raw.model ?? '').trim(),
    prompt: String(raw.prompt ?? ''),
    passHint: String(raw.passHint ?? ''),
    failHint: String(raw.failHint ?? ''),
    threshold: clamp(raw.threshold, 0.05, 0.99, LAYER_DEFAULTS.threshold),
    labelIndex: Math.round(clamp(raw.labelIndex, 0, 99, 1)),
    scope: pick(raw.scope, ['all', 'flagged'] as const, 'all'),
    onFail: pick(raw.onFail, ['block', 'flag', 'redact'] as const, type === 'redactor' ? 'redact' : 'block'),
    onError: pick(raw.onError, ['allow', 'block', 'patterns'] as const, 'block'),
    timeoutMs: Math.round(clamp(raw.timeoutMs, 200, 60000, LAYER_DEFAULTS.timeoutMs)),
    reasoningEffort: pick(raw.reasoningEffort, ['low', 'medium', 'high'] as const, 'low'),
  };
}

/** The adapter a layer actually uses. */
export function adapterFor(l: GuardLayer): AdapterId {
  if (l.adapter !== 'auto') return l.adapter;
  if (l.type === 'judge') return /llama[-_]?guard|shieldgemma|granite[-_]?guardian/i.test(l.model) ? detectAdapter(l.model) : 'json_judge';
  return detectAdapter(l.model) === 'json_judge' ? 'classifier' : detectAdapter(l.model);
}

interface Legacy {
  threshold: number;
  piguard: { enabled: boolean; mode: 'builtin' | 'vllm'; serverId: number | null; model: string; labelIndex: number };
  oss: { enabled: boolean; serverId: number | null; model: string; prompt: string; reasoningEffort: 'low' | 'medium' | 'high'; timeoutMs: number; onTimeout: 'block' | 'allow' };
}

/** The two layers that reproduce the old PIGuard + OSS pair exactly. */
export function layersFromLegacy(g: Legacy): GuardLayer[] {
  return [
    normalizeLayer({
      id: 'piguard',
      name: 'PIGuard',
      enabled: g.piguard.enabled,
      type: g.piguard.mode === 'vllm' && g.piguard.serverId ? 'classifier' : 'patterns',
      adapter: 'classifier',
      serverId: g.piguard.serverId,
      model: g.piguard.model,
      threshold: g.threshold,
      labelIndex: g.piguard.labelIndex,
      scope: 'all',
      onFail: 'flag',
      onError: 'patterns',
    }),
    normalizeLayer({
      id: 'judge',
      name: 'OSS judge',
      enabled: g.oss.enabled,
      type: 'judge',
      adapter: 'json_judge',
      serverId: g.oss.serverId,
      model: g.oss.model,
      prompt: g.oss.prompt,
      scope: 'flagged',
      onFail: 'block',
      onError: g.oss.onTimeout,
      timeoutMs: g.oss.timeoutMs,
      reasoningEffort: g.oss.reasoningEffort,
    }),
  ];
}

/** Keep the "piguard" and "judge" layers in step when the old settings fields are written (old UI, tests). */
export function syncLegacy(layers: GuardLayer[], g: Legacy, patch: { piguard?: object; oss?: object; threshold?: unknown }): GuardLayer[] {
  return layers.map((l) => {
    if (l.id === 'piguard' && (patch.piguard || patch.threshold !== undefined)) {
      const [fresh] = layersFromLegacy(g);
      return { ...l, enabled: fresh.enabled, type: fresh.type, serverId: fresh.serverId, model: fresh.model, threshold: fresh.threshold, labelIndex: fresh.labelIndex };
    }
    if (l.id === 'judge' && patch.oss) {
      const fresh = layersFromLegacy(g)[1];
      return { ...l, enabled: fresh.enabled, serverId: fresh.serverId, model: fresh.model, prompt: fresh.prompt, onError: fresh.onError, timeoutMs: fresh.timeoutMs, reasoningEffort: fresh.reasoningEffort };
    }
    return l;
  });
}
