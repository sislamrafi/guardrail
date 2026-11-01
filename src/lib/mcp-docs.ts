// Docs served to agents over MCP. Unlike context files (pushed into every prompt), MCP docs are
// pulled on demand: an agent lists, searches and reads them with its Opsara key. Each doc has a
// slug for its URI (opsara://docs/<slug>), a description and tags so agents can tell when to read it.
// Who sees a doc is the group setting "mcp_docs" (inherited, add/override) plus a key's own exceptions.
import { getDb, now } from './db';
import { type Group, listGroups, resolveGroup } from './groups';
import type { ApiKey } from './keys';

export interface McpDoc {
  id: number;
  slug: string;
  title: string;
  description: string;
  tags: string[];
  body: string;
  version: number;
  created_at: number;
  updated_at: number;
}

type Row = Omit<McpDoc, 'tags'> & { tags: string };

const parse = (r: Row): McpDoc => {
  let tags: string[] = [];
  try {
    const t = JSON.parse(r.tags);
    tags = Array.isArray(t) ? t.map(String) : [];
  } catch {
    tags = [];
  }
  return { ...r, tags };
};

/** A URL-safe slug: "Deploy runbook (v2)" → "deploy-runbook-v2". */
export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9/._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .slice(0, 80);

const cleanTags = (v: unknown): string[] =>
  [...new Set((Array.isArray(v) ? v : String(v ?? '').split(',')).map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20);

export function listDocs(): McpDoc[] {
  return (getDb().prepare('SELECT * FROM mcp_docs ORDER BY title COLLATE NOCASE').all() as Row[]).map(parse);
}

export function getDoc(id: number): McpDoc | undefined {
  const r = getDb().prepare('SELECT * FROM mcp_docs WHERE id = ?').get(id) as Row | undefined;
  return r ? parse(r) : undefined;
}

export function docBySlug(slug: string): McpDoc | undefined {
  const r = getDb().prepare('SELECT * FROM mcp_docs WHERE slug = ?').get(slug) as Row | undefined;
  return r ? parse(r) : undefined;
}

function freeSlug(base: string, self?: number) {
  const b = slugify(base) || 'doc';
  let s = b;
  for (let i = 2; getDb().prepare('SELECT id FROM mcp_docs WHERE slug = ? AND id IS NOT ?').get(s, self ?? null); i++) s = `${b}-${i}`;
  return s;
}

export function createDoc(input: { title?: string; slug?: string; description?: string; tags?: unknown; body?: string }): McpDoc {
  const title = String(input.title ?? '').trim();
  if (!title) throw new Error('Give the doc a title.');
  const body = String(input.body ?? '');
  const db = getDb();
  const r = db
    .prepare('INSERT INTO mcp_docs (slug, title, description, tags, body, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
    .run(freeSlug(input.slug || title), title, String(input.description ?? '').trim(), JSON.stringify(cleanTags(input.tags)), body, now(), now());
  const id = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO mcp_doc_versions (doc_id, version, title, body, created_at) VALUES (?, 1, ?, ?, ?)').run(id, title, body, now());
  return getDoc(id)!;
}

/** Same versioning as context files: new text is a new version; autosaves within two minutes update it. */
const COALESCE_MS = 2 * 60 * 1000;
export function updateDoc(id: number, patch: { title?: string; slug?: string; description?: string; tags?: unknown; body?: string; autosave?: boolean }): McpDoc {
  const db = getDb();
  const d = getDoc(id);
  if (!d) throw new Error('Doc not found.');
  const title = patch.title !== undefined ? patch.title.trim() || d.title : d.title;
  let slug = d.slug;
  if (patch.slug !== undefined && patch.slug.trim() && slugify(patch.slug) !== d.slug) {
    slug = slugify(patch.slug);
    if (!slug) throw new Error('The slug needs letters or numbers.');
    if (docBySlug(slug)) throw new Error(`Another doc already uses the slug "${slug}".`);
  }
  const changed = patch.body !== undefined && patch.body !== d.body;
  const last = db.prepare('SELECT version, created_at, auto FROM mcp_doc_versions WHERE doc_id = ? ORDER BY version DESC LIMIT 1').get(id) as { version: number; created_at: number; auto: number } | undefined;
  const coalesce = changed && patch.autosave && last?.auto === 1 && last.version === d.version && now() - last.created_at < COALESCE_MS;
  const version = changed && !coalesce ? d.version + 1 : d.version;
  const body = changed ? patch.body! : d.body;
  db.transaction(() => {
    db.prepare('UPDATE mcp_docs SET slug = ?, title = ?, description = ?, tags = ?, body = ?, version = ?, updated_at = ? WHERE id = ?').run(
      slug,
      title,
      patch.description !== undefined ? patch.description.trim() : d.description,
      JSON.stringify(patch.tags !== undefined ? cleanTags(patch.tags) : d.tags),
      body,
      version,
      now(),
      id,
    );
    if (coalesce) db.prepare('UPDATE mcp_doc_versions SET body = ?, title = ?, created_at = ? WHERE doc_id = ? AND version = ?').run(body, title, now(), id, version);
    else if (changed) db.prepare('INSERT INTO mcp_doc_versions (doc_id, version, title, body, created_at, auto) VALUES (?, ?, ?, ?, ?, ?)').run(id, version, title, body, now(), patch.autosave ? 1 : 0);
  })();
  return getDoc(id)!;
}

export function deleteDoc(id: number) {
  getDb().prepare('DELETE FROM mcp_doc_versions WHERE doc_id = ?').run(id);
  getDb().prepare('DELETE FROM mcp_docs WHERE id = ?').run(id);
}

export function docHistory(id: number) {
  return getDb().prepare('SELECT version, title, body, created_at FROM mcp_doc_versions WHERE doc_id = ? ORDER BY version DESC LIMIT 50').all(id) as { version: number; title: string; body: string; created_at: number }[];
}

/** Exactly the docs a key can see: its group chain's "mcp_docs" plus its own exceptions. Off when MCP access is off. */
export function docsForKey(key: Pick<ApiKey, 'groupId' | 'exceptions' | 'mcp'>, groups: Group[] = listGroups(), all: McpDoc[] = listDocs()): McpDoc[] {
  if (!key.mcp) return [];
  const ids = new Set(resolveGroup(key.groupId, key.exceptions, groups).effective.mcp_docs);
  return all.filter((d) => ids.has(d.id));
}

/** One-line summary an agent sees in list_docs and resources/list. */
export const docSummary = (d: McpDoc) => ({ slug: d.slug, title: d.title, description: d.description, tags: d.tags, updated: new Date(d.updated_at).toISOString(), version: d.version, size: Buffer.byteLength(d.body) });

// ---------------------------------------------------------------- search (BM25)

const tokenize = (s: string) => s.toLowerCase().match(/[a-z0-9_]+/g)?.filter((t) => t.length > 1) ?? [];

export interface SearchHit {
  doc: McpDoc;
  score: number;
  snippet: string;
}

/**
 * Okapi BM25 over title (weighted ×3), tags (×2), description (×2) and body. Small corpora only:
 * docs are indexed per call, which is fast for the few hundred docs a key sees.
 */
export function searchDocs(docs: McpDoc[], query: string, limit = 5): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !docs.length) return [];
  const toks = docs.map((d) => [...Array(3).fill(tokenize(d.title)).flat(), ...Array(2).fill(tokenize(`${d.tags.join(' ')} ${d.description}`)).flat(), ...tokenize(d.body)] as string[]);
  const avg = toks.reduce((n, t) => n + t.length, 0) / toks.length || 1;
  const k1 = 1.2;
  const b = 0.75;
  const df = new Map(terms.map((t) => [t, toks.filter((ts) => ts.includes(t)).length]));
  const hits: SearchHit[] = [];
  docs.forEach((doc, i) => {
    const tf = new Map<string, number>();
    for (const t of toks[i]) if (df.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of terms) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks[i].length) / avg)));
    }
    if (score > 0) hits.push({ doc, score: Math.round(score * 1000) / 1000, snippet: snippetFor(doc.body, terms) });
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(20, limit)));
}

function snippetFor(body: string, terms: string[]): string {
  const low = body.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, at - 80);
  const text = body.slice(start, start + 240).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + text + (start + 240 < body.length ? '…' : '');
}
