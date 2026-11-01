// Admin sign-in (Node only). The password lives in .env and is only ever compared here, on the server.
//
//  - Login: the password is compared as scrypt hashes in constant time. Failures are limited per IP
//    (5 tries, then a lockout that doubles up to an hour). Every attempt goes to the audit log.
//  - A session family starts at login. Each refresh rotates the refresh token: the old session row
//    is retired, a new one (same family) takes over. A retired token used again means it was stolen,
//    so the whole family is revoked. Logout revokes the family too.
//  - Refresh tokens are random, stored as SHA-256 hashes, and sent only as an httpOnly cookie.
import { env } from './env';
import crypto from 'crypto';
import { getDb, now } from './db';
import { REFRESH_COOKIE, HINT_COOKIE, signAccess, verifyAccess, timingSafeEqual, bearerOf } from './session';

export const REFRESH_TTL_MS = 30 * 86400_000;
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60_000;

export const authEnabled = () => !!env.adminPassword();

function ensureTables() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS admin_sessions (
    id TEXT PRIMARY KEY,
    family TEXT NOT NULL,
    refresh_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_used_at INTEGER,
    ip TEXT,
    ua TEXT,
    retired_at INTEGER,
    revoked_at INTEGER,
    revoked_reason TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_admin_sessions_family ON admin_sessions(family)');
  db.exec(`CREATE TABLE IF NOT EXISTS admin_audit (
    ts INTEGER NOT NULL,
    event TEXT NOT NULL,
    ip TEXT,
    ua TEXT,
    family TEXT,
    detail TEXT
  )`);
  return db;
}

export function audit(event: string, x: { ip?: string | null; ua?: string | null; family?: string | null; detail?: string } = {}) {
  ensureTables().prepare('INSERT INTO admin_audit (ts, event, ip, ua, family, detail) VALUES (?, ?, ?, ?, ?, ?)').run(now(), event, x.ip ?? null, (x.ua ?? '').slice(0, 200) || null, x.family ?? null, x.detail ?? null);
}

// ---------------------------------------------------------------- password

const g = globalThis as unknown as { __grPw?: { src: string; salt: Buffer; hash: Buffer }; __grFails?: Map<string, { n: number; first: number; until: number }> };

/** Constant-time check against GUARDRAIL_ADMIN_PASSWORD, hashed once per process with a random salt. */
export function passwordMatches(input: string): boolean {
  const expected = env.adminPassword();
  if (!expected) return false;
  if (g.__grPw?.src !== expected) {
    const salt = crypto.randomBytes(16);
    g.__grPw = { src: expected, salt, hash: crypto.scryptSync(expected, salt, 32) };
  }
  const got = crypto.scryptSync(String(input ?? ''), g.__grPw.salt, 32);
  return crypto.timingSafeEqual(got, g.__grPw.hash);
}

const fails = () => (g.__grFails ??= new Map());

/** Seconds until this IP may try again, or 0. */
export function lockedFor(ip: string, at = Date.now()): number {
  const f = fails().get(ip);
  return f && f.until > at ? Math.ceil((f.until - at) / 1000) : 0;
}

function noteFailure(ip: string, at = Date.now()) {
  const m = fails();
  const f = m.get(ip);
  const cur = f && at - f.first < WINDOW_MS ? f : { n: 0, first: at, until: 0 };
  cur.n++;
  // After 5 failures: 1 minute, then 2, 4, 8… up to an hour.
  if (cur.n >= MAX_FAILS) cur.until = at + Math.min(60, 2 ** (cur.n - MAX_FAILS)) * 60_000;
  m.set(ip, cur);
}

export function resetLoginLimits() {
  fails().clear();
}

// ---------------------------------------------------------------- sessions

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const rid = (n = 16) => crypto.randomBytes(n).toString('base64url');

export interface Issued {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  family: string;
}

async function issue(family: string, meta: { ip?: string | null; ua?: string | null }, at = now()): Promise<Issued> {
  const db = ensureTables();
  const id = rid(12);
  const secret = rid(32);
  db.prepare('INSERT INTO admin_sessions (id, family, refresh_hash, created_at, expires_at, last_used_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, family, sha(secret), at, at + REFRESH_TTL_MS, at, meta.ip ?? null, (meta.ua ?? '').slice(0, 200) || null);
  const { token, exp } = await signAccess({ sid: id, fam: family }, at);
  return { accessToken: token, expiresAt: exp * 1000, refreshToken: `${id}.${secret}`, family };
}

export type LoginResult = { ok: true; issued: Issued } | { ok: false; status: 401 | 429; error: string; retryAfter?: number };

export async function login(password: string, meta: { ip?: string | null; ua?: string | null }): Promise<LoginResult> {
  const ip = meta.ip ?? 'unknown';
  const wait = lockedFor(ip);
  if (wait) {
    audit('login_locked', { ...meta });
    return { ok: false, status: 429, error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`, retryAfter: wait };
  }
  if (!passwordMatches(password)) {
    noteFailure(ip);
    audit('login_fail', { ...meta });
    return { ok: false, status: 401, error: 'Wrong password.' };
  }
  fails().delete(ip);
  const issued = await issue(rid(12), meta);
  audit('login_ok', { ...meta, family: issued.family });
  return { ok: true, issued };
}

export type RefreshResult = { ok: true; issued: Issued } | { ok: false; error: string };

/** Rotate a refresh token. A retired one used again revokes its whole family. */
export async function refresh(token: string | null | undefined, meta: { ip?: string | null; ua?: string | null }): Promise<RefreshResult> {
  const db = ensureTables();
  const [id, secret] = String(token ?? '').split('.');
  if (!id || !secret) return { ok: false, error: 'Sign in first.' };
  const row = db.prepare('SELECT id, family, refresh_hash, expires_at, retired_at, revoked_at FROM admin_sessions WHERE id = ?').get(id) as
    | { id: string; family: string; refresh_hash: string; expires_at: number; retired_at: number | null; revoked_at: number | null }
    | undefined;
  if (!row || !timingSafeEqual(row.refresh_hash, sha(secret))) return { ok: false, error: 'Sign in first.' };
  if (row.revoked_at || familyRevoked(row.family)) return { ok: false, error: 'Signed out. Sign in again.' };
  if (row.retired_at) {
    revokeFamily(row.family, 'reuse');
    audit('refresh_reuse', { ...meta, family: row.family, detail: 'A used refresh token came back; every session of this sign-in was ended.' });
    return { ok: false, error: 'Signed out for safety. Sign in again.' };
  }
  if (row.expires_at < now()) return { ok: false, error: 'Session expired. Sign in again.' };
  db.prepare('UPDATE admin_sessions SET retired_at = ?, last_used_at = ? WHERE id = ?').run(now(), now(), id);
  return { ok: true, issued: await issue(row.family, meta) };
}

function familyRevoked(family: string): boolean {
  return !!ensureTables().prepare('SELECT 1 FROM admin_sessions WHERE family = ? AND revoked_at IS NOT NULL LIMIT 1').get(family);
}

export function revokeFamily(family: string, reason: string) {
  ensureTables().prepare('UPDATE admin_sessions SET revoked_at = ?, revoked_reason = ? WHERE family = ? AND revoked_at IS NULL').run(now(), reason, family);
}

export function logout(token: string | null | undefined, meta: { ip?: string | null; ua?: string | null }) {
  const id = String(token ?? '').split('.')[0];
  if (!id) return;
  const row = ensureTables().prepare('SELECT family FROM admin_sessions WHERE id = ?').get(id) as { family: string } | undefined;
  if (!row) return;
  revokeFamily(row.family, 'logout');
  audit('logout', { ...meta, family: row.family });
}

export function logoutEverywhere(meta: { ip?: string | null; ua?: string | null }) {
  ensureTables().prepare("UPDATE admin_sessions SET revoked_at = ?, revoked_reason = 'logout_all' WHERE revoked_at IS NULL").run(now());
  audit('logout_all', meta);
}

/** Signed-in browsers: one row per sign-in (family), with its latest use. */
export function listSessions() {
  return ensureTables()
    .prepare(
      `SELECT family, MIN(created_at) AS started, MAX(COALESCE(last_used_at, created_at)) AS last_used, MAX(expires_at) AS expires,
              (SELECT ip FROM admin_sessions s2 WHERE s2.family = s.family ORDER BY created_at DESC LIMIT 1) AS ip,
              (SELECT ua FROM admin_sessions s2 WHERE s2.family = s.family ORDER BY created_at DESC LIMIT 1) AS ua,
              MAX(revoked_at IS NOT NULL) AS revoked
       FROM admin_sessions s GROUP BY family ORDER BY last_used DESC LIMIT 50`,
    )
    .all() as { family: string; started: number; last_used: number; expires: number; ip: string | null; ua: string | null; revoked: number }[];
}

export function recentAudit(limit = 50) {
  return ensureTables().prepare('SELECT ts, event, ip, ua, family, detail FROM admin_audit ORDER BY ts DESC LIMIT ?').all(limit);
}

/**
 * Whether an admin API request is allowed: a valid, unexpired access token from a live session family.
 * With no admin password set (local development), everything is allowed.
 */
export async function checkAdmin(req: Request): Promise<{ ok: true; family: string | null } | { ok: false; error: string }> {
  if (!authEnabled()) return { ok: true, family: null };
  const c = await verifyAccess(bearerOf(req.headers));
  if (!c) return { ok: false, error: 'Sign in first.' };
  if (familyRevoked(c.fam)) return { ok: false, error: 'Signed out. Sign in again.' };
  return { ok: true, family: c.fam };
}

const secureOf = (req: Request) => (new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https' ? '; Secure' : '');

/** Cookies set at login and refresh: the refresh token (httpOnly, only sent to /api/auth) and the page hint. */
export function sessionCookies(req: Request, refreshToken: string): string[] {
  const s = secureOf(req);
  const age = Math.floor(REFRESH_TTL_MS / 1000);
  return [`${REFRESH_COOKIE}=${refreshToken}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=${age}${s}`, `${HINT_COOKIE}=1; Path=/; SameSite=Strict; Max-Age=${age}${s}`];
}

export function clearCookies(req: Request): string[] {
  const s = secureOf(req);
  return [`${REFRESH_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=0${s}`, `${HINT_COOKIE}=; Path=/; SameSite=Strict; Max-Age=0${s}`];
}

export function cookieOf(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Refresh and logout only take requests from this site's own pages. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return req.headers.get('sec-fetch-site') !== 'cross-site';
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
