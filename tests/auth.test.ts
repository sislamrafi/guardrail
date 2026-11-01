import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, setDb } from '@/lib/db';
import { checkAdmin, login, logout, logoutEverywhere, passwordMatches, refresh, resetLoginLimits } from '@/lib/auth';
import { signAccess, verifyAccess } from '@/lib/session';

const before = process.env.GUARDRAIL_ADMIN_PASSWORD;
const meta = { ip: '10.0.0.1', ua: 'test' };
const withBearer = (t: string) => new Request('http://localhost/api/admin/summary', { headers: { authorization: `Bearer ${t}` } });

beforeAll(() => {
  setDb(openDb(':memory:'));
  process.env.GUARDRAIL_ADMIN_PASSWORD = 'correct horse battery staple';
});
afterAll(() => {
  if (before === undefined) delete process.env.GUARDRAIL_ADMIN_PASSWORD;
  else process.env.GUARDRAIL_ADMIN_PASSWORD = before;
});
beforeEach(() => resetLoginLimits());

describe('admin sign-in', () => {
  it('checks the password on the server only', () => {
    expect(passwordMatches('correct horse battery staple')).toBe(true);
    expect(passwordMatches('wrong')).toBe(false);
    expect(passwordMatches('')).toBe(false);
  });

  it('issues an access token that the admin API accepts, and refuses a tampered or missing one', async () => {
    const r = await login('correct horse battery staple', meta);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.issued.accessToken.startsWith('gra1.')).toBe(true);
    expect((await checkAdmin(withBearer(r.issued.accessToken))).ok).toBe(true);
    const bad = r.issued.accessToken.slice(0, -3) + 'AAA';
    expect((await checkAdmin(withBearer(bad))).ok).toBe(false);
    expect((await checkAdmin(new Request('http://localhost/api/admin/summary'))).ok).toBe(false);
  });

  it('reads OPSARA_ADMIN_PASSWORD first, GUARDRAIL_ADMIN_PASSWORD as a fallback', () => {
    process.env.OPSARA_ADMIN_PASSWORD = 'new name wins';
    expect(passwordMatches('new name wins')).toBe(true);
    expect(passwordMatches('correct horse battery staple')).toBe(false);
    delete process.env.OPSARA_ADMIN_PASSWORD;
    expect(passwordMatches('correct horse battery staple')).toBe(true);
  });

  it('expires access tokens after 15 minutes', async () => {
    const { token } = await signAccess({ sid: 's', fam: 'f' }, Date.now() - 16 * 60_000);
    expect(await verifyAccess(token)).toBeNull();
  });

  it('locks an address out after five wrong passwords', async () => {
    for (let i = 0; i < 5; i++) expect((await login('nope', meta)).ok).toBe(false);
    const r = await login('correct horse battery staple', meta);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(429);
    expect((await login('correct horse battery staple', { ...meta, ip: '10.0.0.2' })).ok).toBe(true);
  });

  it('rotates the refresh token and revokes the sign-in when an old one is reused', async () => {
    const r = await login('correct horse battery staple', meta);
    if (!r.ok) throw new Error('login failed');
    const first = r.issued.refreshToken;
    const second = await refresh(first, meta);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.issued.refreshToken).not.toBe(first);
    // The first token comes back: treat it as stolen and end the whole sign-in.
    expect((await refresh(first, meta)).ok).toBe(false);
    expect((await refresh(second.issued.refreshToken, meta)).ok).toBe(false);
    expect((await checkAdmin(withBearer(second.issued.accessToken))).ok).toBe(false);
  });

  it('signs out one sign-in, or every one', async () => {
    const a = await login('correct horse battery staple', meta);
    const b = await login('correct horse battery staple', meta);
    if (!a.ok || !b.ok) throw new Error('login failed');
    logout(a.issued.refreshToken, meta);
    expect((await checkAdmin(withBearer(a.issued.accessToken))).ok).toBe(false);
    expect((await checkAdmin(withBearer(b.issued.accessToken))).ok).toBe(true);
    logoutEverywhere(meta);
    expect((await checkAdmin(withBearer(b.issued.accessToken))).ok).toBe(false);
    expect((await refresh(b.issued.refreshToken, meta)).ok).toBe(false);
  });
});
