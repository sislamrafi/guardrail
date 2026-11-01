import { authEnabled, clearCookies, cookieOf, refresh, sameOrigin, sessionCookies } from '@/lib/auth';
import { clientIp } from '@/lib/gateway';
import { REFRESH_COOKIE } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Swap the refresh cookie for a new access token. The refresh token is rotated every time.
export async function POST(req: Request) {
  if (!authEnabled()) return Response.json({ ok: true, open: true });
  if (!sameOrigin(req)) return Response.json({ error: 'Not allowed.' }, { status: 403 });
  const r = await refresh(cookieOf(req, REFRESH_COOKIE), { ip: clientIp(req), ua: req.headers.get('user-agent') });
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (!r.ok) {
    for (const c of clearCookies(req)) headers.append('Set-Cookie', c);
    return Response.json({ error: r.error }, { status: 401, headers });
  }
  for (const c of sessionCookies(req, r.issued.refreshToken)) headers.append('Set-Cookie', c);
  return Response.json({ ok: true, accessToken: r.issued.accessToken, expiresAt: r.issued.expiresAt }, { headers });
}
