import { authEnabled, clearCookies, login, sameOrigin, sessionCookies } from '@/lib/auth';
import { clientIp } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The password is only ever checked here, on the server. A match returns a short-lived access token
// (kept in memory by the console) and sets the httpOnly refresh cookie.
export async function POST(req: Request) {
  if (!authEnabled()) return Response.json({ ok: true, open: true });
  if (!sameOrigin(req)) return Response.json({ error: 'Not allowed.' }, { status: 403 });
  const { password } = (await req.json().catch(() => ({}))) as { password?: unknown };
  const meta = { ip: clientIp(req), ua: req.headers.get('user-agent') };
  const r = await login(typeof password === 'string' ? password : '', meta);
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (!r.ok) {
    if (r.retryAfter) headers.set('Retry-After', String(r.retryAfter));
    for (const c of clearCookies(req)) headers.append('Set-Cookie', c);
    return Response.json({ error: r.error }, { status: r.status, headers });
  }
  for (const c of sessionCookies(req, r.issued.refreshToken)) headers.append('Set-Cookie', c);
  return Response.json({ ok: true, accessToken: r.issued.accessToken, expiresAt: r.issued.expiresAt }, { headers });
}
