import crypto from 'crypto';
import type { LayerResult } from './pipeline';
import { getDb } from './db';
import { getSettings } from './settings';
import { prunePromptFiles, readPromptFile, retentionDays, writePromptFile } from './prompt-files';

export type Outcome = 'answered' | 'false_alarm' | 'blocked' | 'redacted' | 'rejected' | 'error';

export interface Step {
  tone: 'neutral' | 'ok' | 'warn' | 'bad';
  head: string;
  ms: number;
  text: string;
  quote?: string;
  why?: string;
}

/** The reply to one request, as the client got it (streams are put back together). */
export interface ModelResponse {
  message: PromptMessage & { tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[]; reasoning?: string };
  finish_reason?: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  /** The reply was GuardRail's blocked message, not the model's. */
  blocked?: boolean;
  /** The upstream error text, when the model call failed. */
  error?: string;
  streamed?: boolean;
  /** The client stopped reading before the stream ended. */
  interrupted?: boolean;
  /** Text was cut at the size limit. */
  truncated?: boolean;
  /** The backend that answered (OpenRouter's provider), to check that checks and calls share a cache. */
  provider?: string;
}

/** One message of a logged prompt. Completions requests are stored as a single user message. */
export interface PromptMessage {
  role?: string;
  content?: unknown;
  [k: string]: unknown;
}

export interface LogEntry {
  id: string;
  ts: number;
  key_id: number | null;
  key_name: string | null;
  owner: string | null;
  group_id: number | null;
  group_name: string | null;
  ip: string | null;
  path: string | null;
  schema: string | null;
  model: string | null;
  server: string | null;
  c1_score: number | null;
  c1_status: string | null;
  c2_status: string | null;
  c2_reason: string | null;
  outcome: Outcome;
  status_code: number | null;
  reason: string | null;
  latency_ms: number | null;
  tokens_out: number | null;
  stages: Record<string, number>;
  steps: Step[];
  feedback: string | null;
  /** The request's Markdown file, relative to the prompts folder. */
  prompt_file: string | null;
  /** Read from prompt_file by getLog only; lists leave them out. */
  prompt?: PromptMessage[] | null;
  forwarded?: PromptMessage[] | null;
  /** What came back for this request (model reply, tool calls, the blocked reply or the error), also kept in the file. */
  response?: ModelResponse | null;
  /** True when the file was deleted by the retention rule. */
  prompt_expired?: boolean;
  /** Each guard layer's result, in order (see pipeline.ts). */
  decisions?: LayerResult[] | null;
  /** What GuardRail added to the request: context files, policy prompt, tokens, placement. */
  injected?: { files: { name: string; tokens: number }[]; policy: boolean; tokens: number; placement: string; identity?: string } | null;
  /** Studio or replay traffic, kept out of normal lists and stats. */
  test?: boolean;
}

type Row = Omit<LogEntry, 'stages' | 'steps' | 'prompt' | 'forwarded' | 'prompt_expired' | 'decisions' | 'injected' | 'test'> & { stages: string; steps: string; decisions: string | null; injected: string | null; test: number | null };

/** A shallow copy of the messages for the prompt file; anything that isn't a list is no prompt. */
export function promptForLog(messages: unknown): PromptMessage[] | null {
  if (!Array.isArray(messages)) return null;
  return messages.map((m) => (m && typeof m === 'object' ? { ...(m as PromptMessage) } : { content: String(m) }));
}

export const newRequestId = () => 'req_' + crypto.randomBytes(6).toString('hex');

const COLS = ['id', 'ts', 'key_id', 'key_name', 'owner', 'group_id', 'group_name', 'ip', 'path', 'schema', 'model', 'server', 'c1_score', 'c1_status', 'c2_status', 'c2_reason', 'outcome', 'status_code', 'reason', 'latency_ms', 'tokens_out', 'stages', 'steps', 'feedback', 'prompt_file', 'decisions', 'injected', 'test'] as const;
const JSON_COLS = ['stages', 'steps', 'decisions', 'injected'];
const SELECT_COLS = COLS.join(', ');

// Pruning runs at most this often, from the write path, so no separate job is needed.
const PRUNE_EVERY = 3600_000;
const g = globalThis as unknown as { __grPrunedAt?: number };

/** Delete prompt files past the retention period and clear their paths. */
export function prunePrompts(at = Date.now()) {
  g.__grPrunedAt = at;
  const files = prunePromptFiles(at);
  getDb().prepare('UPDATE request_logs SET prompt_file = NULL WHERE prompt_file IS NOT NULL AND ts < ?').run(at - retentionDays() * 86400_000);
  return files;
}

function maybePrune() {
  if (Date.now() - (g.__grPrunedAt ?? 0) < PRUNE_EVERY) return;
  try {
    prunePrompts();
  } catch (err) {
    console.error('GuardRail: pruning prompt files failed:', err);
  }
}

export function writeLog(e: Partial<LogEntry> & { id: string; ts: number; outcome: Outcome }) {
  const { prompt, forwarded, response, ...rest } = e;
  const row: Record<string, unknown> = { ...rest, stages: JSON.stringify(e.stages ?? {}), steps: JSON.stringify(e.steps ?? []), decisions: e.decisions ? JSON.stringify(e.decisions) : null, injected: e.injected ? JSON.stringify(e.injected) : null, test: e.test ? 1 : 0 };
  if (prompt !== undefined || forwarded !== undefined || response !== undefined) row.prompt_file = writePromptFile({ ...blankFileEntry, ...e });
  getDb()
    .prepare(`INSERT OR REPLACE INTO request_logs (${COLS.join(', ')}) VALUES (${COLS.map((c) => '@' + c).join(', ')})`)
    .run(Object.fromEntries(COLS.map((c) => [c, row[c] ?? null])));
  maybePrune();
}

const blankFileEntry = { owner: null, key_name: null, group_name: null, ip: null, path: null, schema: null, model: null, server: null, status_code: null, reason: null, c1_score: null, c1_status: null, c2_status: null, c2_reason: null };

export function updateLog(id: string, patch: Partial<LogEntry>) {
  const sets: string[] = [];
  const vals: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(patch)) {
    if (!(COLS as readonly string[]).includes(k) || k === 'id') continue;
    sets.push(`${k} = @${k}`);
    vals[k] = JSON_COLS.includes(k) ? JSON.stringify(v) : v;
  }
  if (sets.length) getDb().prepare(`UPDATE request_logs SET ${sets.join(', ')} WHERE id = @id`).run(vals);
  // A stream finishes after its row was written; bring the file's steps and reply up to date.
  if (patch.steps || patch.response) {
    const l = getLog(id);
    if (l?.prompt_file && (l.prompt || l.forwarded || patch.response)) writePromptFile({ ...l, ...patch }, l.prompt_file);
  }
}

const parse = (r: Row): LogEntry => ({ ...r, stages: safeJson(r.stages, {}), steps: safeJson(r.steps, []), decisions: safeJson(r.decisions, null), injected: safeJson(r.injected, null), test: !!r.test });

function safeJson<T>(s: string | null | undefined, d: T): T {
  if (s === null || s === undefined) return d;
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
}

export function getLog(id: string): LogEntry | undefined {
  const r = getDb().prepare(`SELECT ${SELECT_COLS} FROM request_logs WHERE id = ?`).get(id) as Row | undefined;
  if (!r) return undefined;
  const e = parse(r);
  const file = e.prompt_file ? readPromptFile(e.prompt_file) : null;
  e.prompt = file?.prompt ?? null;
  e.forwarded = file?.forwarded ?? null;
  e.response = file?.response ?? null;
  if (!file) e.prompt_expired = e.ts < Date.now() - retentionDays() * 86400_000;
  return e;
}

export const OUTCOME_FILTERS: Record<string, Outcome[]> = {
  // Blocked: a guard layer or rule stopped a real key's request. Rejected: refused before that (no or bad key, IP, limit).
  blocked: ['blocked'],
  rejected: ['rejected'],
  false_alarm: ['false_alarm'],
  clean: ['answered', 'redacted'],
  error: ['error'],
};

const inList = (n: number) => `(${Array.from({ length: n }, () => '?').join(',')})`;

/** Log filters shared by lists, counts, the overview and exports. `groups` limits to those group ids. */
export interface LogScope {
  groups?: number[];
  /** One API key's requests only. */
  key?: number;
  since?: number;
  until?: number;
  /** Studio and replay traffic is left out unless asked for. */
  test?: 'exclude' | 'include' | 'only';
}

function scopeWhere(scope: LogScope, where: string[], args: unknown[]) {
  if ((scope.test ?? 'exclude') === 'exclude') where.push('test = 0');
  else if (scope.test === 'only') where.push('test = 1');
  if (scope.key) {
    where.push('key_id = ?');
    args.push(scope.key);
  }
  if (scope.groups) {
    where.push(scope.groups.length ? `group_id IN ${inList(scope.groups.length)}` : '0');
    args.push(...scope.groups);
  }
  if (scope.since) {
    where.push('ts >= ?');
    args.push(scope.since);
  }
  if (scope.until) {
    where.push('ts < ?');
    args.push(scope.until);
  }
}

export function queryLogs(opts: { filter?: string; q?: string; limit?: number; before?: number; since?: number; until?: number; groups?: number[]; key?: number; feedback?: string[]; test?: LogScope['test'] }) {
  const where: string[] = [];
  const args: unknown[] = [];
  scopeWhere({ groups: opts.groups, key: opts.key, until: opts.until, test: opts.test }, where, args);
  if (opts.feedback?.length) {
    where.push(`feedback IN ${inList(opts.feedback.length)}`);
    args.push(...opts.feedback);
  }
  // MCP docs traffic (no model involved) is its own filter.
  if (opts.filter === 'mcp') where.push("path = '/mcp'");
  const outs = opts.filter ? OUTCOME_FILTERS[opts.filter] : undefined;
  if (outs) {
    where.push(`outcome IN (${outs.map(() => '?').join(',')})`);
    args.push(...outs);
  }
  if (opts.q) {
    where.push('(owner LIKE ? OR key_name LIKE ? OR group_name LIKE ? OR model LIKE ? OR id LIKE ? OR ip LIKE ?)');
    const like = `%${opts.q}%`;
    args.push(like, like, like, like, like, like);
  }
  if (opts.before) {
    where.push('ts < ?');
    args.push(opts.before);
  }
  if (opts.since) {
    where.push('ts >= ?');
    args.push(opts.since);
  }
  const sql = `SELECT ${SELECT_COLS} FROM request_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
  args.push(Math.min(opts.limit ?? 100, 5000));
  return (getDb().prepare(sql).all(...args) as Row[]).map(parse);
}

export function countByFilter(since?: number, groups?: number[], test?: LogScope['test'], key?: number) {
  const where: string[] = [];
  const args: unknown[] = [];
  scopeWhere({ since, groups, test, key }, where, args);
  const rows = getDb()
    .prepare(`SELECT outcome, COUNT(*) n, SUM(path = '/mcp') mcp FROM request_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY outcome`)
    .all(...args) as { outcome: Outcome; n: number; mcp: number | null }[];
  const by = Object.fromEntries(rows.map((r) => [r.outcome, r.n])) as Record<string, number>;
  const sum = (xs: Outcome[]) => xs.reduce((a, o) => a + (by[o] ?? 0), 0);
  return {
    all: rows.reduce((a, r) => a + r.n, 0),
    blocked: sum(OUTCOME_FILTERS.blocked),
    rejected: sum(OUTCOME_FILTERS.rejected),
    false_alarm: sum(OUTCOME_FILTERS.false_alarm),
    clean: sum(OUTCOME_FILTERS.clean),
    error: sum(OUTCOME_FILTERS.error),
    mcp: rows.reduce((a, r) => a + (r.mcp ?? 0), 0),
  };
}

export const RANGES: Record<string, { ms: number; bucket: number; label: (d: Date) => string }> = {
  '1h': { ms: 3600_000, bucket: 5 * 60_000, label: (d) => hhmm(d) },
  '24h': { ms: 86400_000, bucket: 3600_000, label: (d) => hhmm(d) },
  '7d': { ms: 7 * 86400_000, bucket: 86400_000, label: (d) => d.toLocaleDateString('en', { weekday: 'short' }) },
  '30d': { ms: 30 * 86400_000, bucket: 86400_000, label: (d) => `${d.getMonth() + 1}/${d.getDate()}` },
};

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function pct(xs: number[], p: number) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

export const STAGE_LABELS: Record<string, string> = {
  auth: 'Auth and key check',
  schema: 'Schema detection',
  access: 'Model access and limits',
  rules: 'Custom rules',
  context: 'Context injection',
};

/** Guard layer timings are stored as layer_<id> (older requests: piguard, oss). */
const layerOfStage = (k: string) => (k.startsWith('layer_') ? k.slice(6) : k === 'piguard' ? 'piguard' : k === 'oss' ? 'judge' : null);

export function overview(range = '24h', at = Date.now(), groups?: number[], key?: number) {
  const R = RANGES[range] ?? RANGES['24h'];
  const since = at - R.ms;
  const prevCounts = countByFilter(since - R.ms, groups);
  const counts = countByFilter(since, groups);
  const prevAll = prevCounts.all - counts.all;
  const where: string[] = [];
  const args: unknown[] = [];
  scopeWhere({ since, groups, key }, where, args);
  const rows = getDb()
    .prepare(`SELECT ts, outcome, stages FROM request_logs WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT 20000`)
    .all(...args) as { ts: number; outcome: Outcome; stages: string }[];

  const first = Math.floor(since / R.bucket) * R.bucket;
  const n = Math.max(1, Math.ceil((at - first) / R.bucket));
  const req = Array.from({ length: n }, (_, i) => ({ t: first + i * R.bucket, label: R.label(new Date(first + i * R.bucket)), total: 0, blocked: 0 }));
  const stageVals: Record<string, number[]> = {};
  const overhead: number[] = [];
  const guardTimes: number[] = [];
  for (const r of rows) {
    const i = Math.min(n - 1, Math.max(0, Math.floor((r.ts - first) / R.bucket)));
    req[i].total++;
    if (r.outcome === 'blocked') req[i].blocked++;
    const st = safeJson<Record<string, number>>(r.stages, {});
    let o = 0;
    let g = 0;
    for (const [k, v] of Object.entries(st)) {
      if (k === 'upstream') continue;
      (stageVals[k] ??= []).push(v);
      o += v;
      if (layerOfStage(k)) g += v;
    }
    overhead.push(o);
    if (g) guardTimes.push(g);
  }
  // Fixed stages, then each guard layer in pipeline order (named as on the Guard checks page), then context.
  const layers = getSettings().guard.layers;
  const layerKeys = Object.keys(stageVals)
    .filter((k) => layerOfStage(k))
    .sort((a, b) => layers.findIndex((l) => l.id === layerOfStage(a)) - layers.findIndex((l) => l.id === layerOfStage(b)));
  const order = ['auth', 'schema', 'access', 'rules', ...layerKeys, 'context'];
  const stages = order
    .filter((k) => stageVals[k]?.length)
    .map((k) => {
      const id = layerOfStage(k);
      const name = id ? `Guard layer · ${layers.find((l) => l.id === id)?.name ?? id}` : STAGE_LABELS[k];
      return { key: k, name, p50: median(stageVals[k])! };
    });
  const recentBlocks = queryLogs({ filter: 'blocked', limit: 6, groups });
  return {
    range,
    counts,
    change: prevAll > 0 ? Math.round(((counts.all - prevAll) / prevAll) * 100) : null,
    overheadP95: pct(overhead, 0.95),
    guardP50: median(guardTimes),
    /** Kept for the old UI. */
    ossP50: median(guardTimes),
    buckets: req,
    stages,
    recentBlocks,
  };
}

export function setFeedback(id: string, feedback: string | null) {
  getDb().prepare('UPDATE request_logs SET feedback = ? WHERE id = ?').run(feedback, id);
}

export function falseAlarmCount(since: number) {
  return (getDb().prepare("SELECT COUNT(*) n FROM request_logs WHERE ts >= ? AND outcome = 'false_alarm'").get(since) as { n: number }).n;
}
