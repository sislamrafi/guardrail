// What the agent changed, row by row, and how to undo it.
//
// Before a tool that writes runs, the tables it may touch are snapshotted (secret columns left out);
// afterwards they are compared. Every row that differs becomes a change entry with its before and
// after state. Undo puts the "before" back, newest first. If a row no longer matches its "after"
// (someone changed it since), that change is reported as a conflict instead of being overwritten.
import { getDb, now } from '../db';
import { updateDoc } from '../mcp-docs';
import { updateFile } from '../context';

/** Tables the agent can change, their id column, and the columns never read (secrets). */
export const TABLES = {
  groups: { id: 'id', secret: [] as string[], label: 'Group' },
  api_keys: { id: 'id', secret: ['hash', 'secret_enc', 'prefix', 'last_used_at'], label: 'API key' },
  context_files: { id: 'id', secret: ['updated_at'], label: 'Context file' },
  mcp_docs: { id: 'id', secret: ['updated_at'], label: 'MCP doc' },
  settings: { id: 'key', secret: [], label: 'Settings' },
  servers: { id: 'id', secret: ['api_key', 'status', 'latency_ms', 'last_error', 'last_checked', 'cache_hit_rate'], label: 'Server' },
  models: { id: 'id', secret: ['present'], label: 'Model' },
  rules: { id: 'id', secret: ['hits'], label: 'Custom rule' },
  limits: { id: 'id', secret: [], label: 'Limit' },
} as const;
export type Table = keyof typeof TABLES;

type Row = Record<string, unknown>;
export type Snapshot = Partial<Record<Table, Map<string, Row>>>;

function columns(t: Table): string[] {
  const all = (getDb().prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  return all.filter((c) => !(TABLES[t].secret as readonly string[]).includes(c));
}

export function snapshot(tables: readonly Table[]): Snapshot {
  const out: Snapshot = {};
  for (const t of new Set(tables)) {
    const cols = columns(t);
    const rows = getDb().prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${t}`).all() as Row[];
    out[t] = new Map(rows.map((r) => [String(r[TABLES[t].id]), r]));
  }
  return out;
}

export interface RowChange {
  table: Table;
  rowId: string;
  action: 'created' | 'updated' | 'deleted';
  before: Row | null;
  after: Row | null;
  /** Changed columns (updates only). */
  fields: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diff(before: Snapshot, after: Snapshot): RowChange[] {
  const out: RowChange[] = [];
  for (const t of Object.keys(after) as Table[]) {
    const b = before[t] ?? new Map();
    const a = after[t]!;
    for (const [id, row] of a) {
      const old = b.get(id);
      if (!old) out.push({ table: t, rowId: id, action: 'created', before: null, after: row, fields: [] });
      else {
        const fields = Object.keys(row).filter((k) => !same(row[k], old[k]));
        if (fields.length) out.push({ table: t, rowId: id, action: 'updated', before: old, after: row, fields });
      }
    }
    for (const [id, row] of b) if (!a.has(id)) out.push({ table: t, rowId: id, action: 'deleted', before: row, after: null, fields: [] });
  }
  return out;
}

/** A one-line summary for the change log. */
export function describe(c: RowChange): string {
  const name = String((c.after ?? c.before)?.name ?? (c.after ?? c.before)?.title ?? (c.table === 'settings' ? c.rowId : `#${c.rowId}`));
  const label = TABLES[c.table].label;
  if (c.action === 'created') return `${label} "${name}" created`;
  if (c.action === 'deleted') return `${label} "${name}" deleted`;
  return `${label} "${name}": ${c.fields.join(', ')} changed`;
}

// ---------------------------------------------------------------- stored change log

export function ensureAgentTables() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS agent_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT 'New chat',
    model TEXT,
    server_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    turn INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    tool_calls TEXT,
    tool_call_id TEXT,
    name TEXT,
    ui TEXT,
    undone INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_messages_chat ON agent_messages(chat_id, id)');
  db.exec(`CREATE TABLE IF NOT EXISTS agent_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    turn INTEGER NOT NULL,
    tool TEXT NOT NULL,
    tbl TEXT NOT NULL,
    row_id TEXT NOT NULL,
    action TEXT NOT NULL,
    before TEXT,
    after TEXT,
    fields TEXT NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL,
    ui_effect TEXT,
    created_at INTEGER NOT NULL,
    undone_at INTEGER
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_changes_chat ON agent_changes(chat_id, turn)');
  db.exec(`CREATE TABLE IF NOT EXISTS agent_pending (
    id TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    turn INTEGER NOT NULL,
    tool TEXT NOT NULL,
    args TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    done_at INTEGER
  )`);
  return db;
}

export interface ChangeRow {
  id: number;
  chat_id: number;
  turn: number;
  tool: string;
  tbl: Table | 'ui';
  row_id: string;
  action: string;
  before: Row | null;
  after: Row | null;
  fields: string[];
  summary: string;
  ui_effect: unknown;
  created_at: number;
  undone_at: number | null;
}

export function recordChanges(chatId: number, turn: number, tool: string, changes: RowChange[]): ChangeRow[] {
  const db = ensureAgentTables();
  const ins = db.prepare('INSERT INTO agent_changes (chat_id, turn, tool, tbl, row_id, action, before, after, fields, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const ids = changes.map((c) => Number(ins.run(chatId, turn, tool, c.table, c.rowId, c.action, c.before ? JSON.stringify(c.before) : null, c.after ? JSON.stringify(c.after) : null, JSON.stringify(c.fields), describe(c), now()).lastInsertRowid));
  return ids.length ? listChanges(chatId).filter((c) => ids.includes(c.id)) : [];
}

/** A UI-only change (theme, open page…): logged, undone by the browser. */
export function recordUiEffect(chatId: number, turn: number, tool: string, summary: string, effect: unknown, before: unknown) {
  ensureAgentTables()
    .prepare("INSERT INTO agent_changes (chat_id, turn, tool, tbl, row_id, action, before, after, summary, ui_effect, created_at) VALUES (?, ?, ?, 'ui', ?, 'updated', ?, ?, ?, ?, ?)")
    .run(chatId, turn, tool, tool, JSON.stringify(before ?? null), JSON.stringify(effect), summary, JSON.stringify(effect), now());
}

const parseRow = (r: Record<string, unknown>): ChangeRow => ({
  ...(r as unknown as ChangeRow),
  before: r.before ? JSON.parse(String(r.before)) : null,
  after: r.after ? JSON.parse(String(r.after)) : null,
  fields: JSON.parse(String(r.fields ?? '[]')),
  ui_effect: r.ui_effect ? JSON.parse(String(r.ui_effect)) : null,
});

export function listChanges(chatId: number): ChangeRow[] {
  return (ensureAgentTables().prepare('SELECT * FROM agent_changes WHERE chat_id = ? ORDER BY id').all(chatId) as Record<string, unknown>[]).map(parseRow);
}

// ---------------------------------------------------------------- undo

function current(t: Table, id: string): Row | null {
  const cols = columns(t);
  return (getDb().prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${t} WHERE "${TABLES[t].id}" = ?`).get(id) as Row | undefined) ?? null;
}

export interface UndoPlanItem {
  change: ChangeRow;
  /** The row was changed by someone else since; undoing would overwrite that. */
  conflict: boolean;
  /** Cannot be undone (e.g. a deleted API key: its secret is gone). */
  impossible: string | null;
}

/** What "undo to here" would revert: every change from this turn on, newest first. */
export function undoPlan(chatId: number, fromTurn: number, only?: number[]): UndoPlanItem[] {
  return listChanges(chatId)
    .filter((c) => !c.undone_at && c.turn >= fromTurn && (!only || only.includes(c.id)))
    .reverse()
    .map((c) => {
      if (c.tbl === 'ui') return { change: c, conflict: false, impossible: null };
      const t = c.tbl as Table;
      const now = current(t, c.row_id);
      const impossible = t === 'api_keys' && c.action === 'deleted' ? 'A deleted API key cannot come back (its secret is gone). Create a new key instead.' : null;
      // Compare only the columns the change knew about.
      const conflict = c.action === 'deleted' ? !!now : !now || !c.after || Object.keys(c.after).some((k) => !same(now[k], c.after![k]));
      return { change: c, conflict, impossible };
    });
}

/** Put one row back the way it was before the change. */
function revert(c: ChangeRow) {
  const db = getDb();
  const t = c.tbl as Table;
  const key = TABLES[t].id;
  if (c.action === 'created') {
    if (t === 'context_files') db.prepare('DELETE FROM context_file_versions WHERE file_id = ?').run(c.row_id);
    if (t === 'mcp_docs') db.prepare('DELETE FROM mcp_doc_versions WHERE doc_id = ?').run(c.row_id);
    db.prepare(`DELETE FROM ${t} WHERE "${key}" = ?`).run(c.row_id);
    return;
  }
  const before = c.before!;
  if (c.action === 'deleted') {
    const cols = Object.keys(before);
    if (t === 'context_files' || t === 'mcp_docs') {
      // A restored file or doc is a new version of itself (history kept).
      db.prepare(`INSERT INTO ${t} (${cols.map((x) => `"${x}"`).join(', ')}, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?)`).run(...cols.map((x) => before[x] as never), now());
      return;
    }
    db.prepare(`INSERT INTO ${t} (${cols.map((x) => `"${x}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((x) => before[x] as never));
    return;
  }
  // Updated: texts go back as a new version; everything else column by column.
  if (t === 'context_files' && c.fields.some((f) => f === 'body' || f === 'name')) {
    updateFile(Number(c.row_id), { name: String(before.name), body: String(before.body) });
    return;
  }
  if (t === 'mcp_docs' && c.fields.some((f) => ['body', 'title', 'slug', 'description', 'tags'].includes(f))) {
    updateDoc(Number(c.row_id), { title: String(before.title), slug: String(before.slug), description: String(before.description), tags: JSON.parse(String(before.tags ?? '[]')), body: String(before.body) });
    return;
  }
  const cols = c.fields.filter((f) => f in before);
  if (cols.length) db.prepare(`UPDATE ${t} SET ${cols.map((x) => `"${x}" = ?`).join(', ')} WHERE "${key}" = ?`).run(...cols.map((x) => before[x] as never), c.row_id);
}

/**
 * Undo every change from `fromTurn` on (or only `only`), newest first. Conflicting rows are skipped
 * unless listed in `force`. Returns what was undone, skipped, and the UI effects the browser must revert.
 */
export function applyUndo(chatId: number, fromTurn: number, opts: { force?: number[]; only?: number[] } = {}) {
  const plan = undoPlan(chatId, fromTurn, opts.only);
  const done: ChangeRow[] = [];
  const skipped: UndoPlanItem[] = [];
  const ui: { effect: unknown; before: unknown }[] = [];
  const db = getDb();
  db.transaction(() => {
    for (const p of plan) {
      if (p.impossible || (p.conflict && !opts.force?.includes(p.change.id))) {
        skipped.push(p);
        continue;
      }
      if (p.change.tbl === 'ui') ui.push({ effect: p.change.ui_effect, before: p.change.before });
      else revert(p.change);
      db.prepare('UPDATE agent_changes SET undone_at = ? WHERE id = ?').run(now(), p.change.id);
      done.push(p.change);
    }
    if (!opts.only) db.prepare('UPDATE agent_messages SET undone = 1 WHERE chat_id = ? AND turn >= ?').run(chatId, fromTurn);
  })();
  return { done, skipped, ui };
}
