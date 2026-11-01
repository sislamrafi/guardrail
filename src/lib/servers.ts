import { getDb, now } from './db';

export interface Server {
  id: number;
  name: string;
  url: string;
  api_key: string | null;
  role: 'inference' | 'guard';
  status: 'online' | 'down' | 'unknown';
  latency_ms: number | null;
  last_error: string | null;
  last_checked: number | null;
  cache_hit_rate: number | null;
  created_at: number;
}

export interface Model {
  id: number;
  server_id: number;
  name: string;
  context_len: number | null;
  price_in: number | null;
  price_out: number | null;
  /** Detected type (see detectKind). */
  kind: ModelKind | null;
  /** The admin's choice, when the detection was wrong. */
  kind_override: ModelKind | null;
  /** Added by hand because discovery missed it. */
  manual: number;
  /** "decisions" when the server says the model only answers on its Decisions API. */
  api: string | null;
  /** 1 when the server says the model supports structured (JSON schema) output. */
  structured: number;
  enabled: number;
  present: number;
  discovered_at: number;
}

export const MODEL_KINDS = ['text', 'image', 'audio', 'video', 'embedding', 'rerank', 'classifier', 'other'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export interface DiscoveredModel {
  name: string;
  kind?: ModelKind;
  contextLen: number | null;
  /** USD per 1M input tokens, when the server reports it. */
  priceIn?: number | null;
  /** USD per 1M output tokens, when the server reports it. */
  priceOut?: number | null;
  /** "decisions": only reachable on the Decisions API (OpenRouter output modality / endpoints). */
  api?: string | null;
  /** The server lists structured_outputs or response_format among its parameters. */
  structured?: boolean;
}

interface RawModel {
  id: string;
  max_model_len?: number; // vLLM
  context_length?: number; // OpenRouter and others
  context_window?: number;
  max_context_length?: number;
  top_provider?: { context_length?: number | null };
  pricing?: { prompt?: string | number; completion?: string | number }; // OpenRouter: USD per token
  architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] }; // OpenRouter
  task?: string; // some vLLM builds
  type?: string;
  endpoints?: string[]; // OpenRouter: e.g. ["/api/alpha/decisions"] for decision models
  supported_parameters?: string[]; // OpenRouter
}

const NAME_RULES: [RegExp, ModelKind][] = [
  [/rerank/i, 'rerank'],
  [/embed|(^|[/_-])(bge|e5|gte)([-_]|$)|text-embedding/i, 'embedding'],
  [/guard|moderation|classif|safeguard|shieldgemma|prompt-?injection/i, 'classifier'],
  [/whisper|tts|speech|audio|voice/i, 'audio'],
  [/sora|veo|video/i, 'video'],
  [/dall-?e|flux|stable-?diffusion|sdxl|imagen|image-gen|gpt-image|[-_/](vl|vision)([-_.]|$)|llava|pixtral/i, 'image'],
];

/**
 * What a model does, from what the server reports (OpenRouter's architecture, vLLM's task)
 * and otherwise from its name. Vision-input and image-generation models count as image.
 */
export function detectKind(m: RawModel): ModelKind {
  const task = String(m.task ?? m.type ?? '').toLowerCase();
  if (task) {
    if (/embed/.test(task)) return 'embedding';
    if (/score|rerank/.test(task)) return 'rerank';
    if (/classif|reward/.test(task)) return 'classifier';
    if (/transcri|audio/.test(task)) return 'audio';
  }
  const named = NAME_RULES.find(([re]) => re.test(m.id));
  if (named && named[1] !== 'image') return named[1];
  const a = m.architecture;
  if (a) {
    const [inStr = '', outStr = ''] = (a.modality ?? '').split('->');
    const ins = a.input_modalities ?? inStr.split('+').filter(Boolean);
    const outs = a.output_modalities ?? outStr.split('+').filter(Boolean);
    if (outs.includes('decisions')) return 'classifier';
    if (outs.includes('embeddings') || outs.includes('embedding')) return 'embedding';
    if (outs.includes('image')) return 'image';
    if (outs.includes('audio') || (ins.includes('audio') && !outs.includes('text'))) return 'audio';
    if (outs.includes('video')) return 'video';
    if (outs.length && !outs.includes('text')) return 'other';
    if (named) return named[1];
    return 'text';
  }
  return named ? named[1] : 'text';
}

const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const posInt = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null);

/** Per-token price (string or number) to USD per 1M tokens. Negative means "varies" on OpenRouter. */
function perMillion(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

const isDecisionsRaw = (m: RawModel) => !!(m.architecture?.output_modalities?.includes('decisions') || /->\s*decisions/.test(m.architecture?.modality ?? '') || m.endpoints?.some((e) => /decisions/.test(e)));

/** What the server said about one model, for picking a guard adapter (see adapterFor). */
export function modelMeta(serverId: number | null, name: string): { api: string | null; structured: boolean; kind: ModelKind | null } | null {
  const r = getDb().prepare(`SELECT api, structured, COALESCE(kind_override, kind) kind FROM models WHERE name = ? ${serverId ? 'AND server_id = ?' : ''} LIMIT 1`).get(...(serverId ? [name, serverId] : [name])) as { api: string | null; structured: number; kind: ModelKind | null } | undefined;
  return r ? { api: r.api, structured: !!r.structured, kind: r.kind } : null;
}

export function parseModel(m: RawModel): DiscoveredModel {
  return {
    name: m.id,
    kind: detectKind(m),
    contextLen: posInt(m.max_model_len) ?? posInt(m.context_length) ?? posInt(m.top_provider?.context_length) ?? posInt(m.context_window) ?? posInt(m.max_context_length),
    priceIn: perMillion(m.pricing?.prompt),
    priceOut: perMillion(m.pricing?.completion),
    api: isDecisionsRaw(m) ? 'decisions' : null,
    structured: (m.supported_parameters ?? []).some((p) => p === 'structured_outputs' || p === 'response_format'),
  };
}

export function normalizeUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  u = u.replace(/\/v1$/, '');
  // Throws on garbage so callers can return a clear error.
  new URL(u);
  return u;
}

function authHeaders(apiKey: string | null | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Ask a vLLM server which models it serves. */
// Extra listings some providers keep apart from /v1/models (OpenRouter hides some non-text and
// moderation models from the default list). Each is optional: a 404 or error is noted, never fatal.
const EXTRA_LISTINGS = ['/v1/models?output_modalities=all', '/v1/embeddings/models', '/v1/moderations/models'];

async function fetchListing(base: string, path: string, apiKey: string | null | undefined, timeoutMs: number): Promise<RawModel[]> {
  const res = await fetch(`${base}${path}`, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  if (!res.ok) throw new Error(`Server answered ${res.status} ${res.statusText}`.trim());
  const body = (await res.json()) as { data?: unknown };
  return (Array.isArray(body.data) ? body.data : []).filter((m): m is RawModel => !!m && typeof (m as RawModel).id === 'string');
}

/**
 * Ask a server which models it serves: /v1/models plus a few optional listings, merged by id.
 * Fails only when no listing answers at all; `notes` says which optional ones were unavailable.
 */
export async function discover(url: string, apiKey?: string | null, timeoutMs = 5000) {
  const base = normalizeUrl(url);
  const t0 = performance.now();
  const main = await fetchListing(base, '/v1/models', apiKey, timeoutMs).then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  const latency = Math.round(performance.now() - t0);
  const extras = await Promise.all(
    EXTRA_LISTINGS.map((p) =>
      fetchListing(base, p, apiKey, Math.min(timeoutMs, 4000)).then(
        (v) => ({ p, v }),
        () => ({ p, v: null }),
      ),
    ),
  );
  if (!main.ok && extras.every((x) => !x.v?.length)) throw main.e instanceof Error ? main.e : new Error(String(main.e));
  const byId = new Map<string, RawModel>();
  for (const m of [...(main.ok ? main.v : []), ...extras.flatMap((x) => x.v ?? [])]) if (!byId.has(m.id)) byId.set(m.id, m);
  const models: DiscoveredModel[] = [...byId.values()].map(parseModel);
  const notes = main.ok ? [] : ['The main /v1/models listing was unavailable; models come from other listings.'];
  const missing = extras.filter((x) => !x.v).length;
  if (missing && extras.some((x) => x.v)) notes.push('Some optional model listings were unavailable.');
  return { base, latency, models, notes };
}

/** Add a model the listings missed, by its exact id. Starts off for clients. */
export function addModelByHand(serverId: number, name: string): Model {
  const id = name.trim();
  if (!id) throw new Error('Type the model id, exactly as the server knows it.');
  if (!getServer(serverId)) throw new Error('Server not found.');
  const db = getDb();
  try {
    db.prepare('INSERT INTO models (server_id, name, context_len, kind, enabled, present, manual, discovered_at) VALUES (?, ?, NULL, ?, 0, 1, 1, ?)').run(serverId, id, detectKind({ id }), now());
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new Error(`${id} is already on this server.`);
    throw e;
  }
  return db.prepare('SELECT * FROM models WHERE server_id = ? AND name = ?').get(serverId, id) as Model;
}

export function listServers(): Server[] {
  return getDb().prepare('SELECT * FROM servers ORDER BY role DESC, name').all() as Server[];
}

export function getServer(id: number): Server | undefined {
  return getDb().prepare('SELECT * FROM servers WHERE id = ?').get(id) as Server | undefined;
}

export function listModels(serverId?: number): Model[] {
  const db = getDb();
  // Models saved before types existed get one from their name; Rediscover refines it from the server.
  const untyped = db.prepare('SELECT id, name FROM models WHERE kind IS NULL').all() as { id: number; name: string }[];
  if (untyped.length) {
    const set = db.prepare('UPDATE models SET kind = ? WHERE id = ?');
    db.transaction(() => untyped.forEach((m) => set.run(detectKind({ id: m.name }), m.id)))();
  }
  return (serverId
    ? db.prepare('SELECT * FROM models WHERE server_id = ? ORDER BY name').all(serverId)
    : db.prepare('SELECT * FROM models ORDER BY name').all()) as Model[];
}

/** Every client-usable model with its server: enabled, still served, on an inference server. */
export function listModelsForRouting(): { name: string; server: Server }[] {
  const servers = new Map(listServers().map((s) => [s.id, s]));
  return listModels()
    .filter((m) => m.enabled && m.present && servers.has(m.server_id))
    .map((m) => ({ name: m.name, server: servers.get(m.server_id)! }));
}

export function createServer(input: {
  name: string;
  url: string;
  apiKey?: string | null;
  role?: 'inference' | 'guard';
  models: DiscoveredModel[];
  enabled?: string[];
  latency?: number | null;
}): Server {
  const db = getDb();
  const name = input.name.trim();
  if (!name) throw new Error('Give the server a name.');
  const url = normalizeUrl(input.url);
  const tx = db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO servers (name, url, api_key, role, status, latency_ms, last_checked, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(name, url, input.apiKey || null, 'inference', input.models.length ? 'online' : 'unknown', input.latency ?? null, now(), now());
    const id = Number(r.lastInsertRowid);
    const enabled = new Set(input.enabled ?? input.models.map((m) => m.name));
    const ins = db.prepare('INSERT INTO models (server_id, name, context_len, price_in, price_out, kind, api, structured, enabled, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const m of input.models) ins.run(id, m.name, posInt(m.contextLen), numOrNull(m.priceIn), numOrNull(m.priceOut), kindOf(m), m.api ?? null, m.structured ? 1 : 0, enabled.has(m.name) ? 1 : 0, now());
    return id;
  });
  try {
    return getServer(tx())!;
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new Error(`A server named "${name}" already exists.`);
    throw e;
  }
}

export function updateServer(id: number, patch: { name?: string; url?: string; apiKey?: string | null; role?: 'inference' | 'guard' }) {
  const s = getServer(id);
  if (!s) throw new Error('Server not found.');
  getDb()
    .prepare('UPDATE servers SET name = ?, url = ?, api_key = ?, role = ? WHERE id = ?')
    .run(
      patch.name?.trim() || s.name,
      patch.url ? normalizeUrl(patch.url) : s.url,
      patch.apiKey === undefined ? s.api_key : patch.apiKey || null,
      'inference',
      id,
    );
  return getServer(id)!;
}

export function deleteServer(id: number) {
  getDb().prepare('DELETE FROM servers WHERE id = ?').run(id);
}

/** A discovered model's kind: what the client sent if valid, else detected from its name. */
const kindOf = (m: DiscoveredModel): ModelKind => (m.kind && (MODEL_KINDS as readonly string[]).includes(m.kind) ? m.kind : detectKind({ id: m.name }));

export function setModelKind(modelId: number, kind: ModelKind | null) {
  if (kind !== null && !(MODEL_KINDS as readonly string[]).includes(kind)) throw new Error('Unknown model type.');
  getDb().prepare('UPDATE models SET kind_override = ? WHERE id = ?').run(kind, modelId);
}

export function setModelEnabled(modelId: number, enabled: boolean) {
  getDb().prepare('UPDATE models SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, modelId);
}

/** Re-run discovery: add new models (disabled until ticked), mark missing ones. */
export async function rediscover(id: number) {
  const s = getServer(id);
  if (!s) throw new Error('Server not found.');
  const db = getDb();
  try {
    const { latency, models, notes } = await discover(s.url, s.api_key);
    const names = new Set(models.map((m) => m.name));
    let added = 0;
    const tx = db.transaction(() => {
      const existing = listModels(id);
      const have = new Set(existing.map((m) => m.name));
      // Models added by hand stay: listings often leave them out.
      for (const m of existing) if (!m.manual) db.prepare('UPDATE models SET present = ? WHERE id = ?').run(names.has(m.name) ? 1 : 0, m.id);
      for (const m of models) {
        if (have.has(m.name)) {
          db.prepare('UPDATE models SET context_len = ?, price_in = ?, price_out = ?, kind = ?, api = ?, structured = ? WHERE server_id = ? AND name = ?').run(m.contextLen, m.priceIn ?? null, m.priceOut ?? null, kindOf(m), m.api ?? null, m.structured ? 1 : 0, id, m.name);
        } else {
          db.prepare('INSERT INTO models (server_id, name, context_len, price_in, price_out, kind, api, structured, enabled, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)').run(id, m.name, m.contextLen, m.priceIn ?? null, m.priceOut ?? null, kindOf(m), m.api ?? null, m.structured ? 1 : 0, now());
          added++;
        }
      }
      db.prepare("UPDATE servers SET status = 'online', latency_ms = ?, last_error = NULL, last_checked = ? WHERE id = ?").run(latency, now(), id);
    });
    tx();
    return { ok: true as const, latency, found: models.length, newModels: added, notes };
  } catch (e) {
    markDown(id, e);
    return { ok: false as const, error: errMsg(e) };
  }
}

export function markDown(id: number, e: unknown) {
  getDb().prepare("UPDATE servers SET status = 'down', last_error = ?, last_checked = ? WHERE id = ?").run(errMsg(e), now(), id);
}

export function markOnline(id: number, latency: number) {
  getDb().prepare("UPDATE servers SET status = 'online', latency_ms = ?, last_error = NULL, last_checked = ? WHERE id = ?").run(latency, now(), id);
}

/** Cheap health check plus prefix-cache stats from vLLM's Prometheus endpoint. */
export async function checkHealth(s: Server) {
  try {
    const t0 = performance.now();
    const res = await fetch(`${s.url}/v1/models`, { headers: authHeaders(s.api_key), signal: AbortSignal.timeout(3000), cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    markOnline(s.id, Math.round(performance.now() - t0));
  } catch (e) {
    markDown(s.id, e);
    return;
  }
  try {
    const m = await fetch(`${s.url}/metrics`, { signal: AbortSignal.timeout(2000), cache: 'no-store' });
    if (m.ok) {
      const rate = parsePrefixCacheRate(await m.text());
      if (rate !== null) getDb().prepare('UPDATE servers SET cache_hit_rate = ? WHERE id = ?').run(rate, s.id);
    }
  } catch {
    // Metrics are optional.
  }
}

/** Refresh any server not checked in the last `maxAgeMs`. Runs in the background. */
export function refreshStale(maxAgeMs = 30000) {
  const stale = listServers().filter((s) => !s.last_checked || now() - s.last_checked > maxAgeMs);
  return Promise.all(stale.map(checkHealth));
}

/** Handles both vLLM v1 counters and the older gauge. Returns 0..1 or null. */
export function parsePrefixCacheRate(text: string): number | null {
  const sum = (name: string) => {
    let total = 0;
    let seen = false;
    const re = new RegExp(`^${name.replace(/[:]/g, '\\:')}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)`, 'gm');
    for (const m of text.matchAll(re)) {
      total += parseFloat(m[1]);
      seen = true;
    }
    return seen ? total : null;
  };
  const hits = sum('vllm:prefix_cache_hits_total') ?? sum('vllm:gpu_prefix_cache_hits_total');
  const queries = sum('vllm:prefix_cache_queries_total') ?? sum('vllm:gpu_prefix_cache_queries_total');
  if (hits !== null && queries) return Math.max(0, Math.min(1, hits / queries));
  const gauge = sum('vllm:gpu_prefix_cache_hit_rate');
  return gauge === null ? null : Math.max(0, Math.min(1, gauge));
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause;
    if (e.name === 'TimeoutError') return 'Timed out';
    if (cause?.code) return `${e.message} (${cause.code})`;
    return e.message;
  }
  return String(e);
}
