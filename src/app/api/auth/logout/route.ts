import { clearCookies, cookieOf, logout, sameOrigin } from '@/lib/auth';
import { clientIp } from '@/lib/gateway';
import { REFRESH_COOKIE } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Ends this sign-in everywhere it was refreshed (the whole session family).
export async function POST(req: Request) {
  if (!sameOrigin(req)) return Response.json({ error: 'Not allowed.' }, { status: 403 });
  logout(cookieOf(req, REFRESH_COOKIE), { ip: clientIp(req), ua: req.headers.get('user-agent') });
  const headers = new Headers();
  for (const c of clearCookies(req)) headers.append('Set-Cookie', c);
  return Response.json({ ok: true }, { headers });
}
