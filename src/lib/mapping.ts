// "Custom mapping": read any decision model's answer without code. A layer says how to call the
// model (endpoint style and an optional body template) and where the verdict, score, categories and
// reason are in its answer (a JSON path, or a /regex/ for text), plus how values map to a verdict.
// Pure functions, so the layer editor can test a mapping on a pasted answer as you type.
import type { Decision, Verdict } from './adapters';

export interface CustomMapping {
  /** How the model is called. "raw" POSTs the template to `path` on the server. */
  endpoint: 'chat' | 'completions' | 'classify' | 'moderations' | 'raw';
  path: string;
  /** Optional JSON body with {input}, {policy}, {model} (inserted as JSON string text) and {messages} (a JSON array). */
  template: string;
  /** Where things are: "a.b[0].c" in JSON, or "/regex/i" whose first group is the value. Empty = not given. */
  verdictPath: string;
  scorePath: string;
  categoriesPath: string;
  reasonPath: string;
  /** One rule per line: "unsafe, 1, true => block". Values compare case-insensitively. */
  verdictMap: string;
  /** Verdict for a value no rule names. */
  otherwise: Verdict;
  /** With a score and no verdict: at or above the layer threshold is unsafe. "lower" flips it. */
  scoreDirection: 'higher' | 'lower';
  /** One per line: "S1 = Violent crimes". */
  categoryMap: string;
}

export const MAPPING_DEFAULT: CustomMapping = {
  endpoint: 'chat',
  path: '',
  template: '',
  verdictPath: 'verdict',
  scorePath: '',
  categoriesPath: '',
  reasonPath: 'reason',
  verdictMap: 'block, unsafe, true, yes, 1 => block\nallow, safe, false, no, 0 => allow\nflag, controversial => flag',
  otherwise: 'flag',
  scoreDirection: 'higher',
  categoryMap: '',
};

/** Ready mappings for well-known guard models, so they work out of the box. */
export const PRESETS: Record<string, { label: string; match: RegExp; mapping: Partial<CustomMapping>; sample: string }> = {
  gpt_oss_safeguard: {
    label: 'gpt-oss-safeguard ({"violation": 0|1})',
    match: /gpt[-_]?oss[-_]?safeguard/i,
    mapping: { endpoint: 'chat', verdictPath: 'violation', reasonPath: 'rationale', categoriesPath: 'policy_category', verdictMap: '1, true, yes => block\n0, false, no => allow' },
    sample: '{"violation": 1, "policy_category": "prompt_injection", "rationale": "The file tells the agent to upload a private key."}',
  },
  qwen3guard: {
    label: 'Qwen3Guard (Safety: Safe / Unsafe / Controversial)',
    match: /qwen3?[-_]?guard/i,
    mapping: { endpoint: 'chat', verdictPath: '/Safety:\\s*(\\w+)/i', categoriesPath: '/Categories:\\s*(.+)/i', reasonPath: '', verdictMap: 'unsafe => block\ncontroversial => flag\nsafe => allow' },
    sample: 'Safety: Unsafe\nCategories: Jailbreak',
  },
  wildguard: {
    label: 'WildGuard (Harmful request: yes / no)',
    match: /wildguard/i,
    mapping: { endpoint: 'chat', verdictPath: '/Harmful request:\\s*(yes|no)/i', reasonPath: '', categoriesPath: '', verdictMap: 'yes => block\nno => allow' },
    sample: 'Harmful request: yes\nResponse refusal: N/A\nHarmful response: N/A',
  },
  nemoguard: {
    label: 'NemoGuard / Aegis ({"User Safety": "unsafe"})',
    match: /nemoguard|aegis|content[-_]?safety/i,
    mapping: { endpoint: 'chat', verdictPath: 'User Safety', categoriesPath: 'Safety Categories', reasonPath: '', verdictMap: 'unsafe => block\nsafe => allow' },
    sample: '{"User Safety": "unsafe", "Safety Categories": "Criminal Planning/Confessions, Guns and Illegal Weapons"}',
  },
};

export const presetFor = (model: string) => Object.entries(PRESETS).find(([, p]) => p.match.test(model))?.[0] ?? null;
export const withPreset = (id: string): CustomMapping => ({ ...MAPPING_DEFAULT, ...(PRESETS[id]?.mapping ?? {}) });

/** Clean a mapping from untrusted input. */
export function normalizeMapping(raw: unknown): CustomMapping {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof CustomMapping, unknown>>;
  const str = (k: keyof CustomMapping, max = 4000) => (typeof r[k] === 'string' ? (r[k] as string).slice(0, max) : String(MAPPING_DEFAULT[k]));
  const endpoint = ['chat', 'completions', 'classify', 'moderations', 'raw'].includes(String(r.endpoint)) ? (r.endpoint as CustomMapping['endpoint']) : 'chat';
  return {
    endpoint,
    path: str('path', 200),
    template: str('template', 20000),
    verdictPath: str('verdictPath', 300),
    scorePath: str('scorePath', 300),
    categoriesPath: str('categoriesPath', 300),
    reasonPath: str('reasonPath', 300),
    verdictMap: str('verdictMap'),
    otherwise: ['allow', 'block', 'flag'].includes(String(r.otherwise)) ? (r.otherwise as Verdict) : 'flag',
    scoreDirection: r.scoreDirection === 'lower' ? 'lower' : 'higher',
    categoryMap: str('categoryMap'),
  };
}

// ---------------------------------------------------------------- reading an answer

const isRegex = (p: string) => /^\/.+\/[a-z]*$/s.test(p.trim());

function regexOf(p: string): RegExp | null {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(p.trim());
  if (!m) return null;
  try {
    return new RegExp(m[1], m[2].replace(/g/g, ''));
  } catch {
    return null;
  }
}

/** "a.b[0].c", "$.a.b", "results[*].label" or "User Safety" (a key with spaces). */
export function pick(json: unknown, path: string): unknown {
  const p = path.trim().replace(/^\$\.?/, '');
  if (!p) return json;
  // A whole key that exists as-is (keys may contain spaces or dots).
  if (json && typeof json === 'object' && !Array.isArray(json) && p in (json as object)) return (json as Record<string, unknown>)[p];
  const parts = p.match(/[^.[\]]+|\[(\d+|\*)\]/g) ?? [];
  let cur: unknown[] = [json];
  for (const raw of parts) {
    const part = raw.replace(/^\[|\]$/g, '');
    const next: unknown[] = [];
    for (const c of cur) {
      if (c == null) continue;
      if (part === '*') {
        if (Array.isArray(c)) next.push(...c);
      } else if (/^\d+$/.test(part) && Array.isArray(c)) next.push(c[Number(part)]);
      else if (typeof c === 'object') next.push((c as Record<string, unknown>)[part]);
    }
    cur = next;
  }
  const found = cur.filter((x) => x !== undefined);
  return parts.some((x) => x === '[*]') ? found : found[0];
}

/** The first JSON object in a text (models often wrap JSON in prose or code fences). */
function jsonIn(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function lookup(path: string, text: string, json: unknown): unknown {
  if (!path.trim()) return undefined;
  if (isRegex(path)) {
    const re = regexOf(path);
    const m = re ? re.exec(text) : null;
    return m ? (m[1] ?? m[0]).trim() : undefined;
  }
  return json == null ? undefined : pick(json, path);
}

function rules(text: string): { values: string[]; verdict: Verdict }[] {
  return text
    .split('\n')
    .map((l) => /^(.*?)=>\s*(allow|block|flag)\s*$/i.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ values: m[1].split(',').map((v) => v.trim().toLowerCase()).filter(Boolean), verdict: m[2].toLowerCase() as Verdict }));
}

function categoryNames(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of text.split('\n')) {
    const m = /^(.+?)\s*=\s*(.+)$/.exec(l.trim());
    if (m) out.set(m[1].trim().toLowerCase(), m[2].trim());
  }
  return out;
}

type Parsed = Omit<Decision, 'raw' | 'latency_ms'>;

/**
 * Read one answer with a mapping. `text` is what the model said (a chat reply, or the whole body for
 * classify / moderations / raw). Never throws: an answer it can't read comes back with `error`.
 */
export function parseMapped(text: string, m: CustomMapping, threshold = 0.5): Parsed {
  const fail = (error: string): Parsed => ({ verdict: 'allow', score: null, categories: [], reason: error, error });
  try {
    const json = jsonIn(text);
    const vRaw = lookup(m.verdictPath, text, json);
    const sRaw = lookup(m.scorePath, text, json);
    let score: number | null = null;
    if (sRaw !== undefined && sRaw !== null && sRaw !== '') {
      const n = Number(Array.isArray(sRaw) ? Math.max(...sRaw.map(Number)) : sRaw);
      if (Number.isFinite(n)) score = Math.max(0, Math.min(1, m.scoreDirection === 'lower' ? 1 - n : n));
    }
    let verdict: Verdict | null = null;
    if (vRaw !== undefined && vRaw !== null && vRaw !== '') {
      const v = String(Array.isArray(vRaw) ? vRaw[0] : vRaw).trim().toLowerCase();
      verdict = rules(m.verdictMap).find((r) => r.values.includes(v))?.verdict ?? m.otherwise;
    } else if (score !== null) verdict = score >= threshold ? 'block' : 'allow';
    if (!verdict) return fail(m.verdictPath || m.scorePath ? 'The mapping found no verdict or score in the answer' : 'The mapping has no verdict or score path');
    const names = categoryNames(m.categoryMap);
    const cRaw = lookup(m.categoriesPath, text, json);
    const list = cRaw == null || cRaw === '' ? [] : Array.isArray(cRaw) ? cRaw.map(String) : String(cRaw).split(/\s*,\s*/);
    const categories = list
      .map((c) => c.trim())
      .filter((c) => c && !/^(none|n\/a|null)$/i.test(c))
      .map((c) => names.get(c.toLowerCase()) ?? c);
    const rRaw = lookup(m.reasonPath, text, json);
    const reason = rRaw != null && rRaw !== '' ? String(rRaw).slice(0, 500) : verdict === 'block' ? `Unsafe${categories.length ? `: ${categories.join(', ')}` : ''}` : verdict === 'flag' ? 'Flagged for review.' : 'Safe.';
    return { verdict, score, categories, reason };
  } catch (e) {
    return fail(`Could not read the answer: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- building the request

const esc = (s: string) => JSON.stringify(s).slice(1, -1);

/** The URL path and body for a mapped call. Throws only on a template that isn't valid JSON (the caller catches). */
export function buildMappedRequest(m: CustomMapping, x: { model: string; policy: string; input: string; windows: string[] }): { path: string; body: unknown } {
  const messages = [...(x.policy.trim() ? [{ role: 'system', content: x.policy }] : []), { role: 'user', content: x.input }];
  if (m.template.trim()) {
    const filled = m.template.replace(/\{messages\}/g, JSON.stringify(messages)).replace(/\{input\}/g, esc(x.input)).replace(/\{policy\}/g, esc(x.policy)).replace(/\{model\}/g, esc(x.model));
    let body: unknown;
    try {
      body = JSON.parse(filled);
    } catch {
      throw new Error('The request template is not valid JSON after filling it in');
    }
    return { path: pathFor(m), body };
  }
  if (m.endpoint === 'chat') return { path: pathFor(m), body: { model: x.model, messages, temperature: 0, max_tokens: 512, stream: false } };
  if (m.endpoint === 'completions') return { path: pathFor(m), body: { model: x.model, prompt: x.policy.trim() ? `${x.policy}\n\n${x.input}` : x.input, temperature: 0, max_tokens: 256 } };
  if (m.endpoint === 'classify') return { path: pathFor(m), body: { model: x.model, input: x.windows } };
  return { path: pathFor(m), body: { model: x.model, input: x.input } };
}

function pathFor(m: CustomMapping) {
  if (m.endpoint === 'raw') return m.path.trim() ? (m.path.trim().startsWith('/') ? m.path.trim() : `/${m.path.trim()}`) : '/v1/chat/completions';
  return { chat: '/v1/chat/completions', completions: '/v1/completions', classify: '/classify', moderations: '/v1/moderations' }[m.endpoint];
}

/** What to read from a raw HTTP answer: the reply text for chat / completions, the whole body otherwise. */
export function answerText(m: CustomMapping, body: string): string {
  if (m.endpoint !== 'chat' && m.endpoint !== 'completions') return body;
  const j = jsonIn(body) as { choices?: { message?: { content?: string }; text?: string }[] } | null;
  const c = j?.choices?.[0];
  return c?.message?.content ?? c?.text ?? body;
}
