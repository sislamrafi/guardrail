import { getDb, now } from './db';
import { getSettings } from './settings';

/**
 * Group settings inherit down the tree. Each group stores only what it changes:
 *   set       - root group's own value
 *   add       - list settings: append to the parent's list; text settings: append lines
 *   override  - replace the parent's value
 * A setting a group doesn't store is inherited unchanged.
 */
export type Mode = 'set' | 'add' | 'override';
export type SettingKey = 'servers' | 'models' | 'context' | 'layers' | 'layer_opts' | 'blocked_reply' | 'rate_limit';

export interface SettingDef {
  key: SettingKey;
  label: string;
  kind: 'list' | 'number' | 'text' | 'map' | 'opts';
  canAdd: boolean;
}

export const SETTING_DEFS: SettingDef[] = [
  { key: 'servers', label: 'Servers', kind: 'list', canAdd: true },
  { key: 'models', label: 'Models', kind: 'list', canAdd: true },
  { key: 'context', label: 'Context files', kind: 'list', canAdd: true },
  { key: 'layers', label: 'Guard layers on/off', kind: 'map', canAdd: false },
  { key: 'layer_opts', label: 'Guard layer settings', kind: 'opts', canAdd: false },
  { key: 'blocked_reply', label: 'Blocked reply', kind: 'text', canAdd: false },
  { key: 'rate_limit', label: 'Rate limit', kind: 'number', canAdd: false },
];

/** A group's own settings for one guard layer: a score threshold (scoring layers), extra prompt lines (judges). */
export interface LayerOpt {
  threshold?: number | null;
  prompt?: string;
}
export type SettingValue = number[] | string[] | number | string | boolean | null | Record<string, boolean> | Record<string, LayerOpt>;
export interface StoredSetting {
  mode: Mode;
  value: SettingValue;
}
export type GroupSettings = Partial<Record<SettingKey, StoredSetting>>;

export interface GroupRow {
  id: number;
  name: string;
  parent_id: number | null;
  description: string;
  settings: string;
  created_at: number;
}

export interface Group {
  id: number;
  name: string;
  parentId: number | null;
  description: string;
  settings: GroupSettings;
}

export interface Layer {
  name: string;
  settings: GroupSettings;
}

export interface Cell {
  state: 'inherited' | 'set' | 'add' | 'override';
  value: SettingValue;
}

export interface Effective {
  /** null = every server */
  servers: number[] | null;
  /** '*' = every enabled model */
  models: string[];
  context: number[];
  /** Per-layer on/off chosen by this group or a parent; a layer not listed follows its own default. */
  layers: Record<string, boolean>;
  /** Per-layer settings groups changed: a threshold (the nearest group's wins) and prompt lines (every group's, in order). */
  layer_opts: Record<string, { threshold: number | null; thresholdFrom: string | null; prompt_parts: { from: string; text: string }[] }>;
  blocked_reply: string;
  rate_limit: number;
}

export interface Resolution {
  effective: Effective;
  sources: Record<SettingKey, string[]>;
  matrix: { key: SettingKey; label: string; cells: Cell[] }[];
}

export interface Defaults {
  blocked_reply: string;
  rate_limit: number;
}

export function defaultsFromSettings(): Defaults {
  const s = getSettings();
  return {
    blocked_reply: s.guard.reply.template,
    rate_limit: s.defaultRateLimit,
  };
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/** Pure resolver: walk the layers from root to leaf. */
export function resolveLayers(layers: Layer[], defaults: Defaults): Resolution {
  const eff: Effective = {
    servers: null,
    models: [],
    context: [],
    layers: {},
    layer_opts: {},
    blocked_reply: defaults.blocked_reply,
    rate_limit: defaults.rate_limit,
  };
  const sources = Object.fromEntries(SETTING_DEFS.map((d) => [d.key, ['Default']])) as Record<SettingKey, string[]>;
  const matrix = SETTING_DEFS.map((d) => ({ key: d.key, label: d.label, cells: [] as Cell[] }));

  layers.forEach((layer) => {
    for (const row of matrix) {
      const s = layer.settings[row.key];
      if (!s) {
        row.cells.push({ state: 'inherited', value: null });
        continue;
      }
      const def = SETTING_DEFS.find((d) => d.key === row.key)!;
      const additive = s.mode === 'add' && def.canAdd;
      row.cells.push({ state: additive ? 'add' : s.mode === 'set' ? 'set' : 'override', value: s.value });
      apply(eff, row.key, s.value, additive, layer.name);
      if (additive) sources[row.key] = sources[row.key][0] === 'Default' ? [layer.name] : [...sources[row.key], layer.name];
      else sources[row.key] = [layer.name];
    }
  });
  return { effective: eff, sources, matrix };
}

function apply(eff: Effective, key: SettingKey, value: SettingValue, additive: boolean, from: string) {
  switch (key) {
    case 'servers': {
      const v = Array.isArray(value) ? (value as number[]).map(Number) : null;
      if (v === null) eff.servers = null;
      else eff.servers = additive && eff.servers ? uniq([...eff.servers, ...v]) : additive && eff.servers === null ? null : v;
      break;
    }
    case 'models': {
      const v = Array.isArray(value) ? (value as string[]).map(String) : [];
      eff.models = additive ? uniq([...eff.models, ...v]) : v;
      break;
    }
    case 'context': {
      const v = Array.isArray(value) ? (value as number[]).map(Number) : [];
      eff.context = additive ? uniq([...eff.context, ...v]) : v;
      break;
    }
    case 'layers': {
      // A group's choices replace its parent's for the same layer and keep the rest.
      if (value && typeof value === 'object' && !Array.isArray(value)) eff.layers = { ...eff.layers, ...(value as Record<string, boolean>) };
      break;
    }
    case 'layer_opts': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) break;
      for (const [id, o] of Object.entries(value as Record<string, LayerOpt>)) {
        const cur = eff.layer_opts[id] ?? { threshold: null, thresholdFrom: null, prompt_parts: [] };
        const t = Number(o?.threshold);
        if (o?.threshold != null && t > 0 && t < 1) Object.assign(cur, { threshold: t, thresholdFrom: from });
        const text = String(o?.prompt ?? '').trim();
        if (text) cur.prompt_parts = [...cur.prompt_parts, { from, text }];
        eff.layer_opts[id] = cur;
      }
      break;
    }
    case 'rate_limit': {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) eff.rate_limit = n;
      break;
    }
    case 'blocked_reply': {
      const t = String(value ?? '');
      if (t.trim()) eff.blocked_reply = t;
      break;
    }
  }
}

// ---- storage ----

function parse(row: GroupRow): Group {
  let settings: GroupSettings = {};
  try {
    settings = JSON.parse(row.settings) as GroupSettings;
  } catch {
    settings = {};
  }
  return { id: row.id, name: row.name, parentId: row.parent_id, description: row.description, settings };
}

export function listGroups(): Group[] {
  return (getDb().prepare('SELECT * FROM groups ORDER BY id').all() as GroupRow[]).map(parse);
}

export function getGroup(id: number): Group | undefined {
  const row = getDb().prepare('SELECT * FROM groups WHERE id = ?').get(id) as GroupRow | undefined;
  return row ? parse(row) : undefined;
}

/** Root first, `id` last. */
export function chainOf(id: number, all = listGroups()): Group[] {
  const byId = new Map(all.map((g) => [g.id, g]));
  const out: Group[] = [];
  const seen = new Set<number>();
  for (let g = byId.get(id); g && !seen.has(g.id); g = g.parentId ? byId.get(g.parentId) : undefined) {
    seen.add(g.id);
    out.unshift(g);
  }
  return out;
}

export function groupPath(id: number, all = listGroups()): string {
  return chainOf(id, all).map((g) => g.name).join(' › ');
}

export function resolveGroup(id: number, exceptions?: GroupSettings, all = listGroups()): Resolution {
  const layers: Layer[] = chainOf(id, all).map((g) => ({ name: g.name, settings: g.settings }));
  if (exceptions && Object.keys(exceptions).length) layers.push({ name: 'This key', settings: exceptions });
  return resolveLayers(layers, defaultsFromSettings());
}

export function isDescendant(id: number, ancestorId: number, all = listGroups()): boolean {
  return chainOf(id, all).some((g) => g.id === ancestorId);
}

/** Sibling groups need different names, or the tree and paths become ambiguous. */
function checkSiblingName(name: string, parentId: number | null, self?: number) {
  const clash = listGroups().some((g) => g.parentId === parentId && g.id !== self && g.name.toLowerCase() === name.toLowerCase());
  if (clash) throw new Error(`A group named "${name}" is already there.`);
}

export function createGroup(input: { name: string; parentId: number | null; description?: string }): Group {
  const name = input.name.trim();
  if (!name) throw new Error('Give the group a name.');
  checkSiblingName(name, input.parentId);
  if (input.parentId !== null && !getGroup(input.parentId)) throw new Error('Parent group not found.');
  if (input.parentId === null) throw new Error('Pick a parent group. There is only one root group.');
  const r = getDb()
    .prepare('INSERT INTO groups (name, parent_id, description, settings, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, input.parentId, input.description ?? '', '{}', now());
  return getGroup(Number(r.lastInsertRowid))!;
}

export function updateGroup(id: number, patch: { name?: string; description?: string; parentId?: number }) {
  const g = getGroup(id);
  if (!g) throw new Error('Group not found.');
  let parentId = g.parentId;
  if (patch.parentId !== undefined && patch.parentId !== g.parentId) {
    if (g.parentId === null) throw new Error('The root group cannot be moved.');
    if (!getGroup(patch.parentId)) throw new Error('Parent group not found.');
    if (isDescendant(patch.parentId, id)) throw new Error('A group cannot move under one of its own sub-groups.');
    parentId = patch.parentId;
  }
  if (patch.name !== undefined && !patch.name.trim()) throw new Error('Give the group a name.');
  const name = patch.name?.trim() || g.name;
  if (name !== g.name || parentId !== g.parentId) checkSiblingName(name, parentId, id);
  getDb()
    .prepare('UPDATE groups SET name = ?, description = ?, parent_id = ? WHERE id = ?')
    .run(name, patch.description ?? g.description, parentId, id);
  return getGroup(id)!;
}

/** Set (or clear, with null) one setting on a group. */
export function setGroupSetting(id: number, key: SettingKey, setting: StoredSetting | null) {
  const g = getGroup(id);
  if (!g) throw new Error('Group not found.');
  if (!SETTING_DEFS.some((d) => d.key === key)) throw new Error('Unknown setting.');
  const next = { ...g.settings };
  if (setting === null) delete next[key];
  else next[key] = normalizeSetting(key, setting, g.parentId === null);
  getDb().prepare('UPDATE groups SET settings = ? WHERE id = ?').run(JSON.stringify(next), id);
  return getGroup(id)!;
}

export function normalizeSetting(key: SettingKey, s: StoredSetting, isRoot: boolean): StoredSetting {
  const def = SETTING_DEFS.find((d) => d.key === key)!;
  let mode: Mode = isRoot ? 'set' : s.mode === 'add' && def.canAdd ? 'add' : 'override';
  if (isRoot && s.mode === 'add') mode = 'set';
  let value: SettingValue = s.value;
  if (def.kind === 'list') {
    if (key === 'servers' && value === null) value = null;
    else if (!Array.isArray(value)) value = [];
    else if (key === 'models') value = uniq((value as unknown[]).map(String).filter(Boolean));
    else value = uniq((value as unknown[]).map(Number).filter(Number.isFinite));
  } else if (def.kind === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${def.label} must be a positive number.`);
    value = key === 'rate_limit' ? Math.round(n) : n;
  } else if (def.kind === 'map') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${def.label} must be a list of layers switched on or off.`);
    value = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>;
    mode = isRoot ? 'set' : 'override';
  } else if (def.kind === 'opts') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${def.label} must be a list of layers.`);
    const out: Record<string, LayerOpt> = {};
    for (const [id, raw] of Object.entries(value as Record<string, LayerOpt>)) {
      const o: LayerOpt = {};
      if (raw?.threshold != null && raw.threshold !== ('' as never)) {
        const t = Number(raw.threshold);
        if (!(t > 0 && t < 1)) throw new Error('A layer threshold must be between 0 and 1.');
        o.threshold = t;
      }
      if (String(raw?.prompt ?? '').trim()) o.prompt = String(raw.prompt).trim();
      if (Object.keys(o).length) out[id] = o;
    }
    value = out;
    mode = isRoot ? 'set' : 'override';
  } else value = String(value ?? '');
  return { mode, value };
}

export function deleteGroup(id: number) {
  const db = getDb();
  const g = getGroup(id);
  if (!g) return;
  if (g.parentId === null) throw new Error('The root group cannot be deleted.');
  const kids = db.prepare('SELECT COUNT(*) n FROM groups WHERE parent_id = ?').get(id) as { n: number };
  if (kids.n) throw new Error('Move or delete its sub-groups first.');
  const keys = db.prepare('SELECT COUNT(*) n FROM api_keys WHERE group_id = ?').get(id) as { n: number };
  if (keys.n) throw new Error('Move its keys to another group first.');
  db.prepare('DELETE FROM groups WHERE id = ?').run(id);
}
