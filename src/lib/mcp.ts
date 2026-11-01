// Opsara AI Docs: an MCP server over Streamable HTTP at /mcp (stateless, JSON responses).
// Agents authenticate with their Opsara API key and see exactly the docs their key resolves to
// (see mcp-docs.ts). Docs are exposed both as resources (opsara://docs/<slug>) and as tools,
// because many agents (Cline, most IDE agents) only use tools.
// Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
import { clientIp, bearer } from './gateway';
import { ipAllowed } from './ip';
import { type ApiKey, lookupKey, touchKey } from './keys';
import { listGroups, groupPath, resolveGroup } from './groups';
import { takeToken } from './limits';
import { newRequestId, writeLog, type Outcome, type Step } from './logs';
import { type McpDoc, docSummary, docsForKey, searchDocs } from './mcp-docs';

export const MCP_PATH = '/mcp';
export const SERVER_INFO = { name: 'Opsara AI Docs', title: 'Opsara AI Docs', version: '1.0.0' };
/** Newest first; we answer with the client's version when we know it. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const URI_PREFIX = 'opsara://docs/';
/** The scheme from before the rename; still accepted when reading. */
const OLD_PREFIX = 'guardrail://docs/';
const slugOfUri = (uri: string) => (uri.startsWith(URI_PREFIX) ? uri.slice(URI_PREFIX.length) : uri.startsWith(OLD_PREFIX) ? uri.slice(OLD_PREFIX.length) : null);
export const docUri = (slug: string) => `${URI_PREFIX}${slug}`;

// ---------------------------------------------------------------- tool registry

export interface ToolContext {
  key: ApiKey;
  docs: McpDoc[];
  /** Slugs the call touched, for the Activity log. */
  touched: string[];
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  run: (ctx: ToolContext, args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;
}

const text = (t: string, structured?: Record<string, unknown>, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}), ...(isError ? { isError: true } : {}) });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Built-in doc tools. Custom tools (later) register here the same way. */
const registry = new Map<string, McpTool>();
export function registerTool(t: McpTool) {
  registry.set(t.name, t);
}
export const listTools = () => [...registry.values()];

registerTool({
  name: 'list_docs',
  title: 'List team docs',
  description:
    "List the documentation your team shared with you through Opsara (runbooks, conventions, architecture notes, API guides). Call this first when you start a task in this codebase or when you're unsure how the team does something; then read the relevant docs with read_doc. Returns slug, title, description, tags and last update for each doc.",
  inputSchema: { type: 'object', properties: { tag: { type: 'string', description: 'Only docs with this tag.' } }, additionalProperties: false },
  annotations: { title: 'List team docs', ...READ_ONLY },
  run: ({ docs }, args) => {
    const tag = String(args.tag ?? '').trim().toLowerCase();
    const list = docs.filter((d) => !tag || d.tags.includes(tag)).map(docSummary);
    if (!list.length) return text(tag ? `No docs tagged "${tag}".` : 'No docs are shared with this key yet.', { docs: [] });
    const lines = list.map((d) => `- ${d.slug}: ${d.title}${d.description ? ` — ${d.description}` : ''}${d.tags.length ? ` [${d.tags.join(', ')}]` : ''}`);
    return text(`${list.length} doc${list.length === 1 ? '' : 's'} available. Read one with read_doc(slug).\n\n${lines.join('\n')}`, { docs: list });
  },
});

registerTool({
  name: 'read_doc',
  title: 'Read a team doc',
  description: 'Read one doc in full (Markdown) by its slug, as returned by list_docs or search_docs. Use it before changing code the doc covers, and follow what it says over your own assumptions.',
  inputSchema: { type: 'object', properties: { slug: { type: 'string', description: 'The doc slug, e.g. "deploy-runbook".' } }, required: ['slug'], additionalProperties: false },
  annotations: { title: 'Read a team doc', ...READ_ONLY },
  run: (ctx, args) => {
    const slug = String(args.slug ?? '').trim().replace(URI_PREFIX, '').replace(OLD_PREFIX, '');
    const d = ctx.docs.find((x) => x.slug === slug);
    if (!d) return text(`No doc "${slug}" is shared with this key. Call list_docs to see the available slugs.`, undefined, true);
    ctx.touched.push(d.slug);
    return text(`# ${d.title}\n\n${d.description ? `> ${d.description}\n\n` : ''}${d.body}`);
  },
});

registerTool({
  name: 'search_docs',
  title: 'Search team docs',
  description: 'Full-text search across the docs shared with you. Use it when you need the team\'s guidance on a topic (e.g. "deploy", "error handling", "auth tokens") but don\'t know which doc covers it. Returns the best matches with a snippet; then read_doc the useful ones.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Words to look for.' }, limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many results (default 5).' } },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: { title: 'Search team docs', ...READ_ONLY },
  run: (ctx, args) => {
    const q = String(args.query ?? '').trim();
    if (!q) return text('Give a search query.', undefined, true);
    const hits = searchDocs(ctx.docs, q, Number(args.limit) || 5);
    ctx.touched.push(...hits.map((h) => h.doc.slug));
    if (!hits.length) return text(`No doc matches "${q}". Call list_docs to see everything available.`, { results: [] });
    const results = hits.map((h) => ({ slug: h.doc.slug, title: h.doc.title, score: h.score, snippet: h.snippet }));
    return text(results.map((r, i) => `${i + 1}. ${r.slug} — ${r.title} (score ${r.score})\n   ${r.snippet}`).join('\n'), { results });
  },
});

// ---------------------------------------------------------------- JSON-RPC

type Id = string | number | null;
interface RpcRequest {
  jsonrpc: '2.0';
  id?: Id;
  method: string;
  params?: Record<string, unknown>;
}

export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

const instructionsFor = (docs: McpDoc[]) =>
  docs.length
    ? `Opsara AI Docs serves ${docs.length} doc${docs.length === 1 ? '' : 's'} your team shared with this key: project conventions, runbooks and reference notes. Before working on something a doc may cover, call search_docs or list_docs, then read_doc, and follow the docs. Docs are also available as resources (${URI_PREFIX}<slug>).`
    : 'Opsara AI Docs: no docs are shared with this key yet. Ask your Opsara admin to assign docs to your group or key.';

/** Which client is talking, from its last initialize (stateless transport, so remembered per key and address). */
const g = globalThis as unknown as { __grMcpClients?: Map<string, string> };
const clients = (g.__grMcpClients ??= new Map());

export interface CallInfo {
  method: string;
  tool?: string;
  slugs: string[];
  bytes: number;
  error?: string;
}

/** Run one JSON-RPC message for a key. Returns the result, or throws RpcError. */
export async function dispatch(msg: RpcRequest, key: ApiKey, info: CallInfo, who = ''): Promise<unknown> {
  const docs = docsForKey(key);
  const p = msg.params ?? {};
  switch (msg.method) {
    case 'initialize': {
      const asked = String(p.protocolVersion ?? '');
      const ci = p.clientInfo as { name?: string; version?: string } | undefined;
      if (ci?.name && who) clients.set(who, `${ci.name}${ci.version ? ` ${ci.version}` : ''}`);
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: instructionsFor(docs),
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listTools().map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, ...(annotations ? { annotations } : {}) })) };
    case 'tools/call': {
      const name = String(p.name ?? '');
      info.tool = name;
      const tool = registry.get(name);
      if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
      const ctx: ToolContext = { key, docs, touched: [] };
      const out = await tool.run(ctx, (p.arguments && typeof p.arguments === 'object' ? p.arguments : {}) as Record<string, unknown>);
      info.slugs.push(...ctx.touched);
      if (out.isError) info.error = out.content[0]?.text;
      return out;
    }
    case 'resources/list':
      return { resources: docs.map((d) => ({ uri: docUri(d.slug), name: d.slug, title: d.title, description: d.description || undefined, mimeType: 'text/markdown', size: Buffer.byteLength(d.body) })) };
    case 'resources/templates/list':
      return { resourceTemplates: [{ uriTemplate: `${URI_PREFIX}{slug}`, name: 'doc', title: 'Team doc', description: 'A doc shared with you, by slug (see list_docs).', mimeType: 'text/markdown' }] };
    case 'resources/read': {
      const uri = String(p.uri ?? '');
      const slug = slugOfUri(uri);
      const d = slug !== null ? docs.find((x) => x.slug === slug) : undefined;
      if (!d) throw new RpcError(-32002, 'Resource not found', { uri });
      info.slugs.push(d.slug);
      return { contents: [{ uri, mimeType: 'text/markdown', text: d.body }] };
    }
    case 'prompts/list':
      return { prompts: [] };
    default:
      throw new RpcError(-32601, `Method not found: ${msg.method}`);
  }
}

const rpcError = (id: Id, code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });
}

// ---------------------------------------------------------------- HTTP

/** POST /mcp: one JSON-RPC message or a batch. Notifications and responses get 202 with no body. */
export async function handleMcp(req: Request): Promise<Response> {
  const t0 = performance.now();
  const ip = clientIp(req);
  const log = (outcome: Outcome, status: number, reason: string, extra: { key?: ApiKey; info?: CallInfo; client?: string } = {}) => {
    const k = extra.key;
    const groups = k ? listGroups() : [];
    const steps: Step[] = [{ tone: outcome === 'answered' ? 'ok' : 'bad', head: extra.info ? `MCP ${extra.info.method}${extra.info.tool ? ` › ${extra.info.tool}` : ''}` : 'MCP request', ms: 0, text: reason }];
    if (extra.info?.slugs.length) steps.push({ tone: 'neutral', head: 'Docs', ms: 0, text: [...new Set(extra.info.slugs)].join(', ') });
    try {
      writeLog({
        id: newRequestId(),
        ts: Date.now(),
        key_id: k?.id ?? null,
        key_name: k?.name ?? null,
        owner: k?.owner ?? null,
        group_id: k?.groupId ?? null,
        group_name: k ? (groups.find((x) => x.id === k.groupId)?.name ?? null) : null,
        ip,
        path: MCP_PATH,
        schema: 'mcp',
        model: extra.info ? `${extra.info.method}${extra.info.tool ? `:${extra.info.tool}` : ''}` : null,
        server: extra.client ?? null,
        outcome,
        status_code: status,
        reason,
        latency_ms: Math.round(performance.now() - t0),
        tokens_out: extra.info?.bytes ?? null,
        c1_status: 'not_run',
        c2_status: 'not_run',
        steps,
        stages: {},
      });
    } catch (e) {
      console.error('Opsara: could not log an MCP call:', e);
    }
  };

  // 1. Who is calling: the same key checks as the gateway (revoked, expired, IP list, MCP access, rate limit).
  const found = lookupKey(bearer(req));
  if (!found.ok) {
    log('rejected', 401, found.reason, { key: found.key });
    return json(rpcError(null, -32001, found.reason), 401, { 'WWW-Authenticate': 'Bearer realm="Opsara"' });
  }
  const key = found.key;
  if (!ipAllowed(ip, key.ipAllow)) {
    const reason = `This key can only be used from ${key.ipAllow.join(', ')}. The request came from ${ip ?? 'an unknown address'}.`;
    log('rejected', 403, reason, { key });
    return json(rpcError(null, -32001, reason), 403);
  }
  if (!key.mcp) {
    const reason = 'MCP access is turned off for this key.';
    log('rejected', 403, reason, { key });
    return json(rpcError(null, -32001, reason), 403);
  }
  const eff = resolveGroup(key.groupId, key.exceptions).effective;
  if (!takeToken(`mcp:key:${key.id}`, eff.rate_limit)) {
    const reason = `Rate limit reached for this key (${eff.rate_limit} requests per minute).`;
    log('rejected', 429, reason, { key });
    return json(rpcError(null, -32001, reason), 429, { 'Retry-After': '60' });
  }
  touchKey(key.id);

  // 2. The message(s)
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    log('rejected', 400, 'Body is not valid JSON', { key });
    return json(rpcError(null, -32700, 'Parse error'), 400);
  }
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as RpcRequest[];
  if (!msgs.length) return json(rpcError(null, -32600, 'Invalid Request'), 400);
  const who = `${key.id}|${ip ?? ''}`;
  const out: unknown[] = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
      // A response sent back to us (we never ask the client anything), or junk.
      if (m && typeof m === 'object' && ('result' in m || 'error' in m)) continue;
      out.push(rpcError((m as RpcRequest | null)?.id ?? null, -32600, 'Invalid Request'));
      continue;
    }
    const isNote = m.id === undefined;
    if (isNote) continue; // notifications/initialized, cancelled…: nothing to do in stateless mode
    const info: CallInfo = { method: m.method, slugs: [], bytes: 0 };
    try {
      const result = await dispatch(m, key, info, who);
      const res = { jsonrpc: '2.0', id: m.id, result };
      info.bytes = Buffer.byteLength(JSON.stringify(res));
      out.push(res);
      if (m.method !== 'ping') log(info.error ? 'error' : 'answered', 200, summarize(info), { key, info, client: clients.get(who) });
    } catch (e) {
      const err = e instanceof RpcError ? e : new RpcError(-32603, 'Internal error');
      if (!(e instanceof RpcError)) console.error('Opsara MCP:', e);
      info.error = err.message;
      out.push(rpcError(m.id ?? null, err.code, err.message, err.data));
      log('error', 200, `${summarize(info)}: ${err.message}`, { key, info, client: clients.get(who) });
    }
  }
  if (!out.length) return new Response(null, { status: 202 });
  return json(batch ? out : out[0]);
}

function summarize(i: CallInfo) {
  const kb = i.bytes >= 1024 ? `${(i.bytes / 1024).toFixed(1)} kB` : `${i.bytes} B`;
  const what = i.tool ? `${i.tool}` : i.method;
  const slugs = [...new Set(i.slugs)];
  return `${what}${slugs.length ? ` (${slugs.slice(0, 5).join(', ')}${slugs.length > 5 ? ` +${slugs.length - 5}` : ''})` : ''} · ${kb}`;
}

/** For the console's "Test as key": run one call as a key, skipping the IP list (the admin is not the key's machine). */
export async function testAsKey(key: ApiKey, method: string, params: Record<string, unknown>) {
  const info: CallInfo = { method, slugs: [], bytes: 0 };
  const t0 = performance.now();
  try {
    const result = await dispatch({ jsonrpc: '2.0', id: 1, method, params }, key, info);
    return { ok: true, result, ms: Math.round(performance.now() - t0), group: groupPath(key.groupId), docs: docsForKey(key).length };
  } catch (e) {
    return { ok: false, error: e instanceof RpcError ? { code: e.code, message: e.message } : { code: -32603, message: String(e) }, ms: Math.round(performance.now() - t0) };
  }
}
