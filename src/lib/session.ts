// Admin access tokens. Edge-safe (Web Crypto only): used by the middleware and by the Node routes.
//
// Signing in returns a short-lived access token (15 minutes) that the console keeps in memory and
// sends as "Authorization: Bearer …" on every admin API call. A refresh token (an httpOnly cookie,
// stored hashed on the server, rotated on every use) gets a new one; see auth.ts.
// Format: "gra1.<base64url JSON payload>.<base64url HMAC-SHA256>".

import { env } from './env';
export const REFRESH_COOKIE = 'gr_refresh';
/** Not a secret: only tells the middleware a browser has signed in, so pages can redirect to /login. */
export const HINT_COOKIE = 'gr_in';
export const ACCESS_TTL_S = 15 * 60;

export interface AccessClaims {
  /** Session id (one per refresh-token rotation). */
  sid: string;
  /** Session family: every rotation of one sign-in shares it; revoking it ends them all. */
  fam: string;
  iat: number;
  exp: number;
}

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

const g = globalThis as unknown as { __grAccessKey?: { secret: string; key: Promise<CryptoKey> } };

/** The signing key, derived from GUARDRAIL_SECRET for this purpose only. */
function accessKey(): Promise<CryptoKey> {
  const secret = env.secret() || 'change-me';
  if (g.__grAccessKey?.secret === secret) return g.__grAccessKey.key;
  const key = (async () => {
    const base = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const derived = new Uint8Array(await crypto.subtle.sign('HMAC', base, enc.encode('guardrail-admin-access-v1')));
    return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  })();
  g.__grAccessKey = { secret, key };
  return key;
}

export async function signAccess(c: Omit<AccessClaims, 'iat' | 'exp'>, now = Date.now()): Promise<{ token: string; exp: number }> {
  const iat = Math.floor(now / 1000);
  const claims: AccessClaims = { ...c, iat, exp: iat + ACCESS_TTL_S };
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await accessKey(), enc.encode(`gra1.${body}`)));
  return { token: `gra1.${body}.${b64url(sig)}`, exp: claims.exp };
}

/** The claims of a valid, unexpired token; null for anything else. (Revocation is checked in Node.) */
export async function verifyAccess(token: string | null | undefined, now = Date.now()): Promise<AccessClaims | null> {
  if (!token) return null;
  const [v, body, sig] = token.split('.');
  if (v !== 'gra1' || !body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await accessKey(), unb64url(sig), enc.encode(`gra1.${body}`));
    if (!ok) return null;
    const c = JSON.parse(new TextDecoder().decode(unb64url(body))) as AccessClaims;
    if (typeof c.sid !== 'string' || typeof c.fam !== 'string' || typeof c.exp !== 'number') return null;
    return c.exp > Math.floor(now / 1000) ? c : null;
  } catch {
    return null;
  }
}

export const bearerOf = (h: Headers) => {
  const a = h.get('authorization');
  return a?.toLowerCase().startsWith('bearer ') ? a.slice(7).trim() : null;
};

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
