// Saved Studio scenarios: a chat transcript plus the settings it is sent with.
import { getDb, now } from './db';
import { getKey } from './keys';
import { getLog, type PromptMessage } from './logs';

export interface ScenarioSettings {
  /** Send as a real key (no secret needed) or as any key in a group. */
  mode: 'key' | 'group';
  keyId: number | null;
  groupId: number | null;
  model: string;
  schema: 'openai_chat' | 'openai_completions' | 'anthropic_messages';
  system: string;
  /** OpenAI-style function tools, as JSON text. */
  tools: string;
  /** Extra context files sent as client content (in addition to the group's own context). */
  extraContext: number[];
  temperature: number | null;
  maxTokens: number | null;
  stream: boolean;
  /** Guard layer ids to run; null means the group's own layers. */
  layers: string[] | null;
}

export interface Turn {
  /** Index of the assistant (or blocked) message this trace belongs to. */
  at: number;
  logId: string | null;
  status: number;
  outcome: string | null;
  ms: number;
}

export interface Scenario {
  id: number;
  name: string;
  description: string;
  notes: string;
  tags: string[];
  settings: ScenarioSettings;
  messages: PromptMessage[];
  turns: Turn[];
  created_at: number;
  updated_at: number;
}

export const DEFAULT_SCENARIO: ScenarioSettings = { mode: 'group', keyId: null, groupId: null, model: '', schema: 'openai_chat', system: '', tools: '', extraContext: [], temperature: null, maxTokens: null, stream: false, layers: null };

type Row = { id: number; name: string; description: string; notes: string; tags: string; settings: string; transcript: string; created_at: number; updated_at: number };

const json = <T,>(s: string, d: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};

function parse(r: Row): Scenario {
  const t = json<{ messages?: PromptMessage[]; turns?: Turn[] }>(r.transcript, {});
  return { id: r.id, name: r.name, description: r.description, notes: r.notes, tags: json(r.tags, []), settings: { ...DEFAULT_SCENARIO, ...json(r.settings, {}) }, messages: t.messages ?? [], turns: t.turns ?? [], created_at: r.created_at, updated_at: r.updated_at };
}

export function listScenarios(): Scenario[] {
  return (getDb().prepare('SELECT * FROM studio_scenarios ORDER BY name').all() as Row[]).map(parse);
}

export function getScenario(id: number): Scenario | undefined {
  const r = getDb().prepare('SELECT * FROM studio_scenarios WHERE id = ?').get(id) as Row | undefined;
  return r ? parse(r) : undefined;
}

export function createScenario(input: Partial<Scenario>): Scenario {
  const name = String(input.name ?? '').trim() || 'New scenario';
  const r = getDb()
    .prepare('INSERT INTO studio_scenarios (name, description, notes, tags, settings, transcript, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(name, String(input.description ?? ''), String(input.notes ?? ''), JSON.stringify(input.tags ?? []), JSON.stringify({ ...DEFAULT_SCENARIO, ...(input.settings ?? {}) }), JSON.stringify({ messages: input.messages ?? [], turns: input.turns ?? [] }), now(), now());
  return getScenario(Number(r.lastInsertRowid))!;
}

export function updateScenario(id: number, patch: Partial<Scenario>): Scenario {
  const s = getScenario(id);
  if (!s) throw new Error('Scenario not found.');
  const next = { ...s, ...patch, settings: { ...s.settings, ...(patch.settings ?? {}) } };
  getDb()
    .prepare('UPDATE studio_scenarios SET name = ?, description = ?, notes = ?, tags = ?, settings = ?, transcript = ?, updated_at = ? WHERE id = ?')
    .run(String(next.name).trim() || s.name, next.description, next.notes, JSON.stringify(next.tags ?? []), JSON.stringify(next.settings), JSON.stringify({ messages: next.messages ?? [], turns: next.turns ?? [] }), now(), id);
  return getScenario(id)!;
}

export function duplicateScenario(id: number): Scenario {
  const s = getScenario(id);
  if (!s) throw new Error('Scenario not found.');
  return createScenario({ ...s, name: `${s.name} (copy)` });
}

export function deleteScenario(id: number) {
  getDb().prepare('DELETE FROM studio_scenarios WHERE id = ?').run(id);
}

/** A new scenario from a logged request: same key (or group), model and conversation. */
export function scenarioFromLog(logId: string): Scenario {
  const l = getLog(logId);
  if (!l) throw new Error('Request not found.');
  if (!l.prompt?.length) throw new Error('No prompt was recorded for this request.');
  const sys = l.prompt.filter((m) => m.role === 'system' || m.role === 'developer');
  const rest = l.prompt.filter((m) => m.role !== 'system' && m.role !== 'developer');
  // Drop the last user turn into the conversation as-is; the tester sends it again.
  const key = l.key_id ? getKey(l.key_id) : undefined;
  return createScenario({
    name: `From ${l.id}`,
    description: `${l.key_name ?? 'unknown key'} · ${l.group_name ?? ''} · ${new Date(l.ts).toISOString().slice(0, 16).replace('T', ' ')}`,
    notes: `Original outcome: ${l.outcome}${l.reason ? ` (${l.reason})` : ''}`,
    tags: ['from activity'],
    settings: { ...DEFAULT_SCENARIO, mode: key ? 'key' : 'group', keyId: key?.id ?? null, groupId: key ? null : l.group_id, model: l.model ?? '', system: sys.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n\n') },
    messages: rest,
  });
}
