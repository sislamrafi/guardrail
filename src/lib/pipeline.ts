// Runs the guard layers in order for one request. Fixed anchors: it starts after the key, schema,
// access and custom rules are checked, and ends right before context is added and the model is called.
import { type Decision, callAdapter } from './adapters';
import type { Effective, Resolution } from './groups';
import { type Scan, type Segment, builtinScore, judgeInput, windows } from './guard';
import { type GuardLayer, type ModelMeta, adapterFor, decisionFor, mappingFor } from './layers';
import type { Server } from './servers';

export type LayerAction = 'off' | 'skipped' | 'nothing' | 'pass' | 'flag' | 'block' | 'redact' | 'cleared' | 'route';

export interface LayerResult {
  id: string;
  name: string;
  type: GuardLayer['type'];
  /** 1-based position among the layers. */
  n: number;
  action: LayerAction;
  decision: Decision | null;
  /** True when the model failed and the layer's fallback decided. */
  fellBack: boolean;
  /** Off because a group turned it off (not the layer's own default). */
  bypassed: boolean;
  /** What the layer read (sources), when it ran. */
  read?: string[];
  /** Router layers: the answer and the model it picked (null: keep the client's model). */
  route?: { label: string | null; model: string | null };
}

export interface PipelineResult {
  results: LayerResult[];
  /** Set when a layer (or an unresolved flag) stopped the request. */
  block: { reason: string; layer: string } | null;
  /** A flag that a later layer cleared: a false alarm. */
  cleared: boolean;
  /** Patterns to replace with [REDACTED] before the request goes on. */
  redact: RegExp[];
  /** A flag nothing resolved, decided by the unresolved-flag setting. */
  unresolved: boolean;
  /** The model a router layer picked (the first router that picked one wins). */
  route?: { model: string; label: string | null; layer: string } | null;
}

/** Is this layer on for a group? Group choices win; the old PIGuard/OSS switches still count for those two. */
export function layerOn(layer: GuardLayer, eff: Effective): boolean {
  return layer.id in eff.layers ? eff.layers[layer.id] : layer.enabled;
}

/** Was the layer switched off by a group rather than by its own default? */
function bypassedByGroup(layer: GuardLayer, eff: Effective): boolean {
  return layer.id in eff.layers && eff.layers[layer.id] === false && layer.enabled;
}

// Secrets and personal data the built-in redactor removes.
export const REDACT_PATTERNS: [string, RegExp][] = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ['OpenAI-style key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g],
  ['password assignment', /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{8,}/gi],
  ['email address', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['card number', /\b(?:\d[ -]?){13,16}\b/g],
];

function redactorDecision(segments: Segment[]): Decision {
  const hits: string[] = [];
  let quote: string | null = null;
  for (const seg of segments)
    for (const [name, re] of REDACT_PATTERNS) {
      const m = seg.text.match(new RegExp(re.source, re.flags));
      if (m?.length) {
        hits.push(name);
        quote ??= m[0].slice(0, 120);
      }
    }
  const cats = [...new Set(hits)];
  return { verdict: cats.length ? 'block' : 'allow', score: cats.length ? 1 : 0, categories: cats, reason: cats.length ? `Found ${cats.join(', ')}` : 'No secrets or personal data found', raw: '', latency_ms: 0, quote };
}

function patternsDecision(segments: Segment[], threshold: number): Decision {
  const b = builtinScore(segments);
  return { verdict: b.score >= threshold ? 'block' : 'allow', score: b.score, categories: b.score >= threshold ? ['prompt injection'] : [], reason: `Built-in patterns scored ${b.score.toFixed(2)}`, raw: '', latency_ms: 0, quote: b.quote };
}

export interface PipelineInput {
  segments: Segment[];
  layers: GuardLayer[];
  resolution: Resolution;
  /** A custom rule asked for the judge: start flagged. */
  escalate: { quote: string } | null;
  unresolvedFlag: 'block' | 'allow';
  serverOf: (id: number) => Server | undefined;
  /** The request's text for a layer with its own "reads" setting; without it every layer gets `segments`. */
  segmentsFor?: (scan: Scan) => Segment[];
  /** What the server said about a model (Decisions API, structured output), for Auto. */
  metaOf?: (serverId: number | null, model: string) => ModelMeta | null;
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const { segments, layers, resolution, serverOf } = input;
  const eff = resolution.effective;
  const results: LayerResult[] = [];
  const redact: RegExp[] = [];
  let flagged = !!input.escalate;
  // Only a layer's flag makes a later "allow" a false alarm; a rule's escalation does not.
  let flaggedByLayer = false;
  let flagQuote: string | null = input.escalate?.quote ?? null;
  let screened = false;
  let cleared = false;
  let route: PipelineResult['route'] = null;

  for (const [i, layer] of layers.entries()) {
    const base = { id: layer.id, name: layer.name, type: layer.type, n: i + 1, decision: null, fellBack: false, bypassed: false };
    if (!layerOn(layer, eff)) {
      results.push({ ...base, action: 'off', bypassed: bypassedByGroup(layer, eff) });
      continue;
    }
    // "Only flagged" layers judge what an earlier layer flagged, or everything when nothing earlier screened it.
    if (layer.scope === 'flagged' && !flagged && screened) {
      results.push({ ...base, action: 'skipped' });
      continue;
    }
    // A layer with its own "reads" setting gets only those parts of the request.
    const segs = layer.reads && input.segmentsFor ? input.segmentsFor(layer.reads) : segments;
    const read = [...new Set(segs.map((x) => x.source))];
    if (!segs.length && !flagged) {
      results.push({ ...base, action: 'nothing', read });
      if (layer.scope === 'all') screened = true;
      continue;
    }
    // A group can change a layer's threshold and add lines to its prompt (see the group's Guard tab).
    const opts = eff.layer_opts[layer.id];
    const threshold = opts?.threshold ?? layer.threshold;
    let d: Decision;
    if (layer.type === 'patterns') d = patternsDecision(segs, threshold);
    else if (layer.type === 'redactor') d = redactorDecision(segs);
    else {
      const server = layer.serverId ? serverOf(layer.serverId) : undefined;
      const prompt = [
        layer.prompt.trim(),
        layer.failHint.trim() && `Block when: ${layer.failHint.trim()}`,
        layer.passHint.trim() && `Allow when: ${layer.passHint.trim()}`,
        ...(opts?.prompt_parts ?? []).map((p) => `# Added by ${p.from}\n${p.text}`),
      ]
        .filter(Boolean)
        .join('\n\n');
      const meta = input.metaOf?.(layer.serverId, layer.model) ?? null;
      d = server
        ? await callAdapter({
            adapter: adapterFor(layer, meta),
            structured: !!meta?.structured,
            mapping: mappingFor(layer),
            decision: decisionFor(layer),
            url: server.url,
            apiKey: server.api_key,
            model: layer.model,
            prompt,
            content: judgeInput(segs, flagged ? flagQuote : null),
            windows: windows(segs).map((w) => w.text),
            labelIndex: layer.labelIndex,
            threshold,
            timeoutMs: layer.timeoutMs,
            reasoningEffort: layer.reasoningEffort,
          })
        : { verdict: 'allow', score: null, categories: [], reason: 'No server is set for this layer', raw: '', latency_ms: 0, error: 'No server is set for this layer' };
    }
    if (layer.type === 'router') {
      // A router never blocks: its answer picks the model; a failed decision uses the fallback.
      const label = d.error ? null : (d.label ?? d.categories[0] ?? null);
      const target = (label && layer.routes?.[label]) || layer.fallbackModel || null;
      results.push({ ...base, read, action: 'route', decision: d, fellBack: !!d.error, route: { label, model: target } });
      if (target && !route) route = { model: target, label, layer: layer.name };
      continue;
    }
    let fellBack = false;
    if (d.error) {
      fellBack = true;
      if (layer.onError === 'patterns') d = { ...patternsDecision(segs, threshold), error: d.error, raw: d.raw, latency_ms: d.latency_ms };
      else d = { ...d, verdict: layer.onError === 'block' ? 'block' : 'allow' };
    }
    if (layer.scope === 'all') screened = true;
    const hit = d.verdict === 'block' || d.verdict === 'flag';
    if (!hit) {
      // A resolving layer that passes a flagged request clears the flag: a false alarm.
      if (flagged && layer.scope === 'flagged') {
        flagged = false;
        cleared = cleared || flaggedByLayer;
        results.push({ ...base, read, action: 'cleared', decision: d, fellBack });
      } else results.push({ ...base, read, action: 'pass', decision: d, fellBack });
      continue;
    }
    const act = d.verdict === 'flag' && layer.onFail === 'block' ? 'flag' : layer.onFail;
    if (act === 'block') {
      results.push({ ...base, read, action: 'block', decision: d, fellBack });
      return { results, block: { reason: d.reason, layer: layer.name }, cleared: false, redact, unresolved: false, route };
    }
    if (act === 'redact') {
      for (const [name, re] of REDACT_PATTERNS) if (d.categories.includes(name)) redact.push(re);
      results.push({ ...base, read, action: 'redact', decision: d, fellBack });
      continue;
    }
    flagged = true;
    flaggedByLayer = true;
    flagQuote = d.quote ?? flagQuote;
    results.push({ ...base, read, action: 'flag', decision: d, fellBack });
  }
  if (flagged) {
    if (input.unresolvedFlag === 'block') return { results, block: { reason: 'It was flagged and no later check cleared it.', layer: 'unresolved flag' }, cleared: false, redact, unresolved: true, route };
    return { results, block: null, cleared: flaggedByLayer, redact, unresolved: true, route };
  }
  return { results, block: null, cleared, redact, unresolved: false, route };
}

/** Replace matches in every text part of a chat request. */
export function applyRedactions<T extends { content?: unknown }>(messages: T[], patterns: RegExp[]): T[] {
  if (!patterns.length) return messages;
  const scrub = (t: string) => patterns.reduce((s, re) => s.replace(new RegExp(re.source, re.flags), '[REDACTED]'), t);
  return messages.map((m) => {
    if (typeof m.content === 'string') return { ...m, content: scrub(m.content) };
    if (Array.isArray(m.content)) return { ...m, content: m.content.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? { ...p, text: scrub((p as { text: string }).text) } : p)) };
    return m;
  });
}
