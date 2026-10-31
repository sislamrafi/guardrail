import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// One connection per process. Next.js dev reloads modules, so keep it on globalThis.
const g = globalThis as unknown as { __grDb?: Database.Database; __grSchema?: number };

// Bump when migrate() gains a step. The connection outlives code reloads in dev,
// so getDb() re-runs migrate() whenever the code expects a newer schema.
const SCHEMA_VERSION = 10;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  api_key TEXT,
  role TEXT NOT NULL DEFAULT 'inference',      -- inference | guard
  status TEXT NOT NULL DEFAULT 'unknown',      -- online | down | unknown
  latency_ms INTEGER,
  last_error TEXT,
  last_checked INTEGER,
  cache_hit_rate REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  context_len INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,           -- clients may use it
  present INTEGER NOT NULL DEFAULT 1,           -- seen on the last discovery
  discovered_at INTEGER NOT NULL,
  UNIQUE(server_id, name)
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES groups(id) ON DELETE RESTRICT,
  description TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '{}',          -- { key: { mode, value } }
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  exceptions TEXT NOT NULL DEFAULT '{}',
  expires_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS context_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS context_file_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES context_files(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,                          -- global | server | model
  server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  model_name TEXT,
  rate_limit INTEGER,                           -- requests per minute per key
  allowed_groups TEXT,                          -- JSON array of group ids, null = everyone
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  target TEXT NOT NULL DEFAULT 'any',           -- any | user | tool
  match_type TEXT NOT NULL DEFAULT 'contains',  -- contains | regex
  pattern TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'block',         -- block | redact | escalate
  group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  message TEXT NOT NULL DEFAULT '',
  hits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  key_id INTEGER,
  key_name TEXT,
  owner TEXT,
  group_id INTEGER,
  group_name TEXT,
  ip TEXT,
  path TEXT,
  schema TEXT,
  model TEXT,
  server TEXT,
  c1_score REAL,
  c1_status TEXT,                               -- clean | flagged | skipped | off | not_run
  c2_status TEXT,                               -- allow | block | skipped | off | not_run | error
  c2_reason TEXT,
  outcome TEXT NOT NULL,                        -- answered | false_alarm | blocked | rejected | error
  status_code INTEGER,
  reason TEXT,
  latency_ms INTEGER,
  tokens_out INTEGER,
  stages TEXT NOT NULL DEFAULT '{}',            -- { stage: ms }
  steps TEXT NOT NULL DEFAULT '[]',             -- timeline for the "Why?" panel
  feedback TEXT,
  prompt_file TEXT                              -- Markdown file with the full prompt, relative to the prompts folder
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON request_logs(ts);
CREATE INDEX IF NOT EXISTS idx_logs_outcome ON request_logs(outcome, ts);
`;

export function dbPath(): string {
  return process.env.GUARDRAIL_DB || path.join(process.cwd(), 'data', 'guardrail.db');
}

export function openDb(file = dbPath()): Database.Database {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  bootstrap(db);
  return db;
}

export function getDb(): Database.Database {
  if (!g.__grDb) g.__grDb = openDb();
  if (g.__grSchema !== SCHEMA_VERSION) {
    migrate(g.__grDb);
    g.__grSchema = SCHEMA_VERSION;
  }
  return g.__grDb;
}

/** Test hook: swap the process-wide connection. */
export function setDb(db: Database.Database) {
  g.__grDb = db;
  g.__grSchema = SCHEMA_VERSION;
}

// Columns added after the first release; CREATE TABLE IF NOT EXISTS skips them on old databases.
function migrate(db: Database.Database) {
  const have = new Set((db.prepare('PRAGMA table_info(request_logs)').all() as { name: string }[]).map((c) => c.name));
  if (!have.has('prompt_file')) db.exec('ALTER TABLE request_logs ADD COLUMN prompt_file TEXT');
  // Per-layer guard results, what was injected, and whether it was test traffic (Studio, replay).
  if (!have.has('decisions')) db.exec('ALTER TABLE request_logs ADD COLUMN decisions TEXT');
  if (!have.has('injected')) db.exec('ALTER TABLE request_logs ADD COLUMN injected TEXT');
  if (!have.has('test')) db.exec('ALTER TABLE request_logs ADD COLUMN test INTEGER NOT NULL DEFAULT 0');
  // Test traffic used to log "Studio"/"Replay" as its address and "Studio" as its person.
  db.exec("UPDATE request_logs SET ip = NULL WHERE test = 1 AND ip IN ('Studio', 'Replay')");
  db.exec("UPDATE request_logs SET owner = 'Admin' WHERE test = 1 AND owner = 'Studio'");
  // Servers no longer have a "guard only" role: every model is a normal model and guard layers pick any.
  // Models of former guard servers start hidden from clients, so nothing becomes callable by surprise.
  const guards = db.prepare("SELECT COUNT(*) n FROM servers WHERE role = 'guard'").get() as { n: number };
  if (guards.n) {
    db.exec("UPDATE models SET enabled = 0 WHERE server_id IN (SELECT id FROM servers WHERE role = 'guard')");
    db.exec("UPDATE servers SET role = 'inference' WHERE role = 'guard'");
  }
  const modelCols = new Set((db.prepare('PRAGMA table_info(models)').all() as { name: string }[]).map((c) => c.name));
  // USD per 1M tokens, when the server reports prices (OpenRouter does; vLLM does not).
  if (!modelCols.has('price_in')) db.exec('ALTER TABLE models ADD COLUMN price_in REAL');
  if (!modelCols.has('price_out')) db.exec('ALTER TABLE models ADD COLUMN price_out REAL');
  // What a model is for (text, image, embedding, classifier…): detected, plus the admin's override.
  if (!modelCols.has('kind')) db.exec('ALTER TABLE models ADD COLUMN kind TEXT');
  if (!modelCols.has('kind_override')) db.exec('ALTER TABLE models ADD COLUMN kind_override TEXT');
  if (!modelCols.has('manual')) db.exec('ALTER TABLE models ADD COLUMN manual INTEGER NOT NULL DEFAULT 0');
  // Saved Studio scenarios (chat transcript + settings).
  db.exec(`CREATE TABLE IF NOT EXISTS studio_scenarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    settings TEXT NOT NULL DEFAULT '{}',
    transcript TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const keyCols = new Set((db.prepare('PRAGMA table_info(api_keys)').all() as { name: string }[]).map((c) => c.name));
  // Optional IP allow-list per key: JSON list of IPs and CIDR ranges; empty means any address.
  if (!keyCols.has('ip_allow')) db.exec("ALTER TABLE api_keys ADD COLUMN ip_allow TEXT NOT NULL DEFAULT '[]'");
  // The secret, encrypted (see secret-box.ts), so admins can reveal it. Older keys have only a hash.
  if (!keyCols.has('secret_enc')) db.exec('ALTER TABLE api_keys ADD COLUMN secret_enc TEXT');
}

// A fresh install gets one root group so keys can be created right away.
function bootstrap(db: Database.Database) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number };
  if (n.n === 0) {
    db.prepare('INSERT INTO groups (name, parent_id, description, settings, created_at) VALUES (?, NULL, ?, ?, ?)').run(
      'Everyone',
      'The root group. Every key inherits these rules.',
      JSON.stringify({ servers: { mode: 'set', value: null }, models: { mode: 'set', value: [] }, context: { mode: 'set', value: [] } }),
      Date.now(),
    );
  }
}

export const now = () => Date.now();
