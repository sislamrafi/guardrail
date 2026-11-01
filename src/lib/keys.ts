import crypto from 'crypto';
import { getDb, now } from './db';
import { parseIpList } from './ip';
import { open, seal } from './secret-box';
import { GroupSettings, SETTING_DEFS, SettingKey, StoredSetting, getGroup, normalizeSetting } from './groups';

export interface ApiKeyRow {
  id: number;
  name: string;
  owner: string;
  group_id: number;
  prefix: string;
  hash: string;
  exceptions: string;
  expires_at: number | null;
  revoked: number;
  last_used_at: number | null;
  created_at: number;
  ip_allow: string;
  secret_enc: string | null;
  id_key: number;
  id_owner: number;
  mcp: number;
}

export interface ApiKey {
  id: number;
  name: string;
  owner: string;
  groupId: number;
  prefix: string;
  exceptions: GroupSettings;
  expiresAt: number | null;
  revoked: boolean;
  lastUsedAt: number | null;
  createdAt: number;
  /** IPs and CIDR ranges this key may be used from; empty means anywhere. */
  ipAllow: string[];
  /** Whether the secret was stored encrypted and can be shown again. */
  canReveal: boolean;
  /** Tell the model who is calling: the key's name and/or its owner, at the very start of the context. */
  identity: { key: boolean; owner: boolean };
  /** May use the MCP docs server (/mcp). */
  mcp: boolean;
}

/** The caller line GuardRail puts first in the context, or '' when the key has it off. Byte-stable per key. */
export function identityLine(k: Pick<ApiKey, 'name' | 'owner' | 'identity'>): string {
  const who = k.identity.owner && k.owner.trim() ? k.owner.trim() : '';
  const key = k.identity.key && k.name.trim() ? k.name.trim() : '';
  if (who && key) return `Request from: ${who} (API key: ${key})`;
  if (who) return `Request from: ${who}`;
  if (key) return `Request from API key: ${key}`;
  return '';
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateSecret(): string {
  const bytes = crypto.randomBytes(32);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `grk_live_${s}`;
}

export const hashKey = (secret: string) => crypto.createHash('sha256').update(secret).digest('hex');

const safeList = (v: string | null | undefined): string[] => {
  try {
    const l = JSON.parse(v ?? '[]');
    return Array.isArray(l) ? l.map(String) : [];
  } catch {
    return [];
  }
};

function parse(r: ApiKeyRow): ApiKey {
  let exceptions: GroupSettings = {};
  try {
    exceptions = JSON.parse(r.exceptions);
  } catch {
    exceptions = {};
  }
  return {
    id: r.id,
    name: r.name,
    owner: r.owner,
    groupId: r.group_id,
    prefix: r.prefix,
    exceptions,
    expiresAt: r.expires_at,
    revoked: !!r.revoked,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    ipAllow: safeList(r.ip_allow),
    canReveal: !!r.secret_enc,
    identity: { key: r.id_key !== 0, owner: r.id_owner !== 0 },
    mcp: r.mcp !== 0,
  };
}

/** Exceptions may only add to lists or override numbers and text. */
export function cleanExceptions(input: unknown): GroupSettings {
  const out: GroupSettings = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input as Record<string, StoredSetting>)) {
    if (!SETTING_DEFS.some((d) => d.key === k) || !v || typeof v !== 'object') continue;
    out[k as SettingKey] = normalizeSetting(k as SettingKey, v, false);
  }
  return out;
}

export function createKey(input: { name: string; owner: string; groupId: number; exceptions?: unknown; expiresAt?: number | null; ipAllow?: unknown }) {
  const name = input.name.trim();
  const owner = input.owner.trim();
  if (!owner) throw new Error('Say who the key is for.');
  if (!name) throw new Error('Give the key a name.');
  if (!getGroup(input.groupId)) throw new Error('Pick a group.');
  const ipAllow = parseIpList(input.ipAllow);
  const secret = generateSecret();
  const r = getDb()
    .prepare(
      `INSERT INTO api_keys (name, owner, group_id, prefix, hash, exceptions, expires_at, created_at, ip_allow, secret_enc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(name, owner, input.groupId, secret.slice(0, 13), hashKey(secret), JSON.stringify(cleanExceptions(input.exceptions)), input.expiresAt ?? null, now(), JSON.stringify(ipAllow), seal(secret));
  return { key: getKey(Number(r.lastInsertRowid))!, secret };
}

export function getKey(id: number): ApiKey | undefined {
  const r = getDb().prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow | undefined;
  return r ? parse(r) : undefined;
}

export function listKeys(): ApiKey[] {
  return (getDb().prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as ApiKeyRow[]).map(parse);
}

export function updateKey(id: number, patch: { name?: string; owner?: string; groupId?: number; exceptions?: unknown; expiresAt?: number | null; revoked?: boolean; ipAllow?: unknown; identity?: { key?: boolean; owner?: boolean }; mcp?: boolean }) {
  const k = getKey(id);
  if (!k) throw new Error('Key not found.');
  if (patch.groupId !== undefined && !getGroup(patch.groupId)) throw new Error('Group not found.');
  getDb()
    .prepare('UPDATE api_keys SET name = ?, owner = ?, group_id = ?, exceptions = ?, expires_at = ?, revoked = ?, ip_allow = ?, id_key = ?, id_owner = ?, mcp = ? WHERE id = ?')
    .run(
      patch.name?.trim() || k.name,
      patch.owner?.trim() || k.owner,
      patch.groupId ?? k.groupId,
      JSON.stringify(patch.exceptions === undefined ? k.exceptions : cleanExceptions(patch.exceptions)),
      patch.expiresAt === undefined ? k.expiresAt : patch.expiresAt,
      (patch.revoked ?? k.revoked) ? 1 : 0,
      JSON.stringify(patch.ipAllow === undefined ? k.ipAllow : parseIpList(patch.ipAllow)),
      (patch.identity?.key ?? k.identity.key) ? 1 : 0,
      (patch.identity?.owner ?? k.identity.owner) ? 1 : 0,
      (patch.mcp ?? k.mcp) ? 1 : 0,
      id,
    );
  return getKey(id)!;
}

/** The full secret of a key created with reveal support; null for older keys (rotate them to get one). */
export function revealKey(id: number): string | null {
  const r = getDb().prepare('SELECT secret_enc FROM api_keys WHERE id = ?').get(id) as { secret_enc: string | null } | undefined;
  if (!r) throw new Error('Key not found.');
  return open(r.secret_enc);
}

/** Replace a key's secret. The old one stops working at once. */
export function rotateKey(id: number) {
  if (!getKey(id)) throw new Error('Key not found.');
  const secret = generateSecret();
  getDb().prepare('UPDATE api_keys SET prefix = ?, hash = ?, secret_enc = ? WHERE id = ?').run(secret.slice(0, 13), hashKey(secret), seal(secret), id);
  return { key: getKey(id)!, secret };
}

export function deleteKey(id: number) {
  getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

export type KeyLookup = { ok: true; key: ApiKey } | { ok: false; reason: string; key?: ApiKey };

export function lookupKey(secret: string | null): KeyLookup {
  if (!secret) return { ok: false, reason: 'No API key was sent.' };
  const r = getDb().prepare('SELECT * FROM api_keys WHERE hash = ?').get(hashKey(secret)) as ApiKeyRow | undefined;
  if (!r) return { ok: false, reason: 'The API key is not valid.' };
  return checkKey(parse(r));
}

/** Whether a key may be used right now. */
export function checkKey(key: ApiKey): KeyLookup {
  if (key.revoked) return { ok: false, reason: 'The API key was revoked.', key };
  if (key.expiresAt && key.expiresAt < now()) return { ok: false, reason: 'The API key has expired.', key };
  return { ok: true, key };
}

export function touchKey(id: number) {
  getDb().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), id);
}

export function requestsToday(): Map<number, number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const rows = getDb()
    .prepare('SELECT key_id, COUNT(*) n FROM request_logs WHERE ts >= ? AND key_id IS NOT NULL GROUP BY key_id')
    .all(start.getTime()) as { key_id: number; n: number }[];
  return new Map(rows.map((r) => [r.key_id, r.n]));
}
