import { beforeAll, describe, expect, it } from 'vitest';
import { openDb, setDb } from '@/lib/db';
import { createGroup, listGroups, setGroupSetting } from '@/lib/groups';
import { createKey, getKey, updateKey } from '@/lib/keys';
import { resetRateLimits } from '@/lib/limits';
import { queryLogs } from '@/lib/logs';
import { handleMcp } from '@/lib/mcp';
import { createDoc, docsForKey, searchDocs, slugify, updateDoc, docHistory } from '@/lib/mcp-docs';

let secret = '';
let childSecret = '';
let keyId = 0;
const ids: Record<string, number> = {};

beforeAll(() => {
  setDb(openDb(':memory:'));
  const root = listGroups()[0];
  const eng = createGroup({ name: 'Engineering', parentId: root.id });
  const fe = createGroup({ name: 'Frontend', parentId: eng.id });
  ids.deploy = createDoc({ title: 'Deploy runbook', description: 'How we ship to production', tags: ['ops', 'deploy'], body: 'Run `make release`, then watch the canary for 10 minutes before rolling out.' }).id;
  ids.style = createDoc({ title: 'React style guide', tags: 'frontend', body: 'Use function components and hooks. Prefer CSS modules.' }).id;
  ids.secret = createDoc({ title: 'Incident notes', body: 'Internal only.' }).id;
  ids.extra = createDoc({ title: 'Extra for one key', body: 'Just for this key.' }).id;
  setGroupSetting(root.id, 'mcp_docs', { mode: 'set', value: [ids.deploy] });
  setGroupSetting(fe.id, 'mcp_docs', { mode: 'add', value: [ids.style] });
  const k = createKey({ name: 'laptop', owner: 'mina', groupId: fe.id, exceptions: { mcp_docs: { mode: 'add', value: [ids.extra] } } });
  secret = k.secret;
  keyId = k.key.id;
  childSecret = createKey({ name: 'eng-bot', owner: 'ci', groupId: eng.id }).secret;
});

const rpc = (body: unknown, opts: { key?: string | null; headers?: Record<string, string> } = {}) =>
  handleMcp(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(opts.key === null ? {} : { authorization: `Bearer ${opts.key ?? secret}` }), ...opts.headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
const call = async (method: string, params: Record<string, unknown> = {}, opts: Parameters<typeof rpc>[1] = {}) => {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method, params }, opts);
  return { status: r.status, body: (await r.json()) as { result?: Record<string, unknown> & { content?: { text: string }[]; isError?: boolean }; error?: { code: number; message: string } } };
};

describe('MCP docs: store', () => {
  it('makes slugs and versions edits', () => {
    expect(slugify('Deploy runbook (v2)!')).toBe('deploy-runbook-v2');
    const d = createDoc({ title: 'Deploy runbook', body: 'x' });
    expect(d.slug).toBe('deploy-runbook-2');
    updateDoc(d.id, { body: 'y' });
    expect(docHistory(d.id).map((h) => h.version)).toEqual([2, 1]);
  });

  it('resolves docs through the group chain and the key exceptions', () => {
    const k = getKey(keyId)!;
    expect(docsForKey(k).map((d) => d.title).sort()).toEqual(['Deploy runbook', 'Extra for one key', 'React style guide']);
    expect(docsForKey({ ...k, mcp: false })).toEqual([]);
  });

  it('ranks search results with BM25', () => {
    const k = getKey(keyId)!;
    const hits = searchDocs(docsForKey(k), 'canary release');
    expect(hits[0].doc.slug).toBe('deploy-runbook');
    expect(hits[0].snippet).toContain('canary');
    expect(searchDocs(docsForKey(k), 'kubernetes')).toEqual([]);
  });
});

describe('MCP docs: protocol', () => {
  it('initializes with server info, capabilities and instructions', async () => {
    const r = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } });
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'GuardRail Docs' }, capabilities: { tools: {}, resources: {} } });
    expect(String(r.body.result!.instructions)).toContain('3 docs');
  });

  it('answers notifications with 202 and no body', async () => {
    const r = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(r.status).toBe(202);
    expect(await r.text()).toBe('');
  });

  it('lists the doc tools', async () => {
    const r = await call('tools/list');
    expect((r.body.result!.tools as { name: string }[]).map((t) => t.name)).toEqual(['list_docs', 'read_doc', 'search_docs']);
  });

  it('lists, reads and searches only the key’s docs', async () => {
    const list = await call('tools/call', { name: 'list_docs', arguments: {} });
    const text = list.body.result!.content![0].text;
    expect(text).toContain('deploy-runbook');
    expect(text).toContain('react-style-guide');
    expect(text).not.toContain('incident-notes');
    const tagged = await call('tools/call', { name: 'list_docs', arguments: { tag: 'ops' } });
    expect((tagged.body.result!.structuredContent as { docs: unknown[] }).docs).toHaveLength(1);

    const read = await call('tools/call', { name: 'read_doc', arguments: { slug: 'deploy-runbook' } });
    expect(read.body.result!.content![0].text).toContain('make release');
    const hidden = await call('tools/call', { name: 'read_doc', arguments: { slug: 'incident-notes' } });
    expect(hidden.body.result!.isError).toBe(true);

    const found = await call('tools/call', { name: 'search_docs', arguments: { query: 'hooks components' } });
    expect(found.body.result!.content![0].text).toContain('react-style-guide');
  });

  it('serves docs as resources', async () => {
    const list = await call('resources/list');
    const uris = (list.body.result!.resources as { uri: string; mimeType: string }[]).map((r) => r.uri);
    expect(uris).toContain('guardrail://docs/deploy-runbook');
    const read = await call('resources/read', { uri: 'guardrail://docs/react-style-guide' });
    expect((read.body.result!.contents as { text: string; mimeType: string }[])[0]).toMatchObject({ mimeType: 'text/markdown' });
    const missing = await call('resources/read', { uri: 'guardrail://docs/incident-notes' });
    expect(missing.body.error!.code).toBe(-32002);
    const templates = await call('resources/templates/list');
    expect(templates.body.result!.resourceTemplates).toHaveLength(1);
  });

  it('handles batches, unknown methods and bad JSON', async () => {
    const r = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'nope' },
    ]);
    const out = (await r.json()) as { id: number; result?: unknown; error?: { code: number } }[];
    expect(out[0].result).toEqual({});
    expect(out[1].error!.code).toBe(-32601);
    expect((await rpc('{oops')).status).toBe(400);
  });

  it('gives a sub-group only what it inherits', async () => {
    const r = await call('tools/call', { name: 'list_docs', arguments: {} }, { key: childSecret });
    const text = r.body.result!.content![0].text;
    expect(text).toContain('deploy-runbook');
    expect(text).not.toContain('react-style-guide');
  });
});

describe('MCP docs: access', () => {
  it('rejects missing and wrong keys', async () => {
    expect((await call('tools/list', {}, { key: null })).status).toBe(401);
    expect((await call('tools/list', {}, { key: 'grk_live_nope' })).status).toBe(401);
  });

  it('accepts x-api-key too', async () => {
    expect((await call('tools/list', {}, { key: null, headers: { 'x-api-key': secret } })).status).toBe(200);
  });

  it('honours IP binding, MCP access and revocation', async () => {
    const root = listGroups()[0];
    const bound = createKey({ name: 'office', owner: 'o', groupId: root.id, ipAllow: '10.0.0.0/8' });
    expect((await call('tools/list', {}, { key: bound.secret, headers: { 'x-guardrail-peer': '203.0.113.9' } })).status).toBe(403);
    expect((await call('tools/list', {}, { key: bound.secret, headers: { 'x-guardrail-peer': '10.1.2.3' } })).status).toBe(200);
    updateKey(bound.key.id, { mcp: false });
    expect((await call('tools/list', {}, { key: bound.secret, headers: { 'x-guardrail-peer': '10.1.2.3' } })).status).toBe(403);
    updateKey(bound.key.id, { mcp: true, revoked: true });
    expect((await call('tools/list', {}, { key: bound.secret, headers: { 'x-guardrail-peer': '10.1.2.3' } })).status).toBe(401);
  });

  it('applies the rate limit', async () => {
    const root = listGroups()[0];
    const g = createGroup({ name: 'Slow', parentId: root.id });
    setGroupSetting(g.id, 'rate_limit', { mode: 'override', value: 2 });
    const k = createKey({ name: 'slow', owner: 'o', groupId: g.id }).secret;
    resetRateLimits();
    expect((await call('ping', {}, { key: k })).status).toBe(200);
    expect((await call('ping', {}, { key: k })).status).toBe(200);
    expect((await call('ping', {}, { key: k })).status).toBe(429);
  });

  it('logs calls as MCP traffic', () => {
    const rows = queryLogs({ filter: 'mcp', limit: 100 });
    expect(rows.length).toBeGreaterThan(5);
    const read = rows.find((r) => r.model === 'tools/call:read_doc' && r.outcome === 'answered');
    expect(read?.reason).toContain('deploy-runbook');
    expect(read?.server).toBe('test-client 1.0');
    expect(rows.some((r) => r.status_code === 401)).toBe(true);
  });
});
