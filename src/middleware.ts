import { env } from '@/lib/env';
import { NextRequest, NextResponse } from 'next/server';
import { HINT_COOKIE, bearerOf, verifyAccess } from '@/lib/session';

// With GUARDRAIL_ADMIN_PASSWORD set, the admin API needs a valid access token (Authorization: Bearer),
// checked here and again in Node (where revoked sessions are seen). Console pages hold no data; they
// only redirect to /login when this browser has not signed in. /v1 and /mcp use API keys instead.
export async function middleware(req: NextRequest) {
  if (!env.adminPassword() || req.nextUrl.pathname === '/mcp') return NextResponse.next();
  if (req.nextUrl.pathname.startsWith('/api/admin/')) {
    if (await verifyAccess(bearerOf(req.headers))) return NextResponse.next();
    return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  }
  if (req.cookies.get(HINT_COOKIE)?.value) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', req.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!v1/|api/auth/|login|_next/|favicon|brand/|manifest.webmanifest).*)'],
};
