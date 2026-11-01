import { handleMcp } from '@/lib/mcp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// MCP Streamable HTTP, stateless: every request is one POST with a JSON-RPC message (or batch).
export function POST(req: Request) {
  return handleMcp(req);
}

// No server-initiated stream and no sessions to end (allowed by the spec for stateless servers).
const notAllowed = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed. Send JSON-RPC messages with POST.' } }), { status: 405, headers: { Allow: 'POST', 'Content-Type': 'application/json' } });
export const GET = notAllowed;
export const DELETE = notAllowed;
