// The agent's tools: typed wrappers over the admin API, so the agent can manage everything the console
// can, under the same checks. Rules every tool follows:
//   - Secrets never go to the model. Server API keys are typed by the person into a secure field the
//     console shows (the model only learns "saved"); key secrets are revealed in the console on click.
//   - Tools that write list the tables they may touch; the runner snapshots them before and after,
//     so every change is logged and can be undone.
//   - Destructive tools need the person to confirm in the chat before they run.
import { invoke } from '../admin-api';
import type { Table } from './changes';

export type UiComponent =
  | { kind: 'confirm'; pending: string; title: string; body: string; danger?: boolean }
  | { kind: 'secret_input'; serverId: number; serverName: string }
  | { kind: 'secret_reveal'; keyId: number; keyName: string }
  | { kind: 'table'; title?: string; columns: string[]; rows: (string | number | null)[][] }
  | { kind: 'chart'; title?: string; unit?: string; bars: { label: string; value: number; hint?: string }[] }
  | { kind: 'choice'; question: string; options: { label: string; value: string }[] }
  | { kind: 'form'; title: string; fields: { name: string; label: string; type?: 'text' | 'number' | 'select' | 'textarea'; options?: string[]; value?: string }[]; submit?: string }
  | { kind: 'diff'; title: string; before: string; after: string }
  | { kind: 'link'; label: string; path: string }
  | { kind: 'ui_effect'; effect: { pref?: string; value?: unknown; navigate?: string; theme?: string } };

export interface ToolCtx {
  chatId: number;
  turn: number;
}
export interface ToolOut {
  /** What the model sees (compact JSON or text). */
  result: unknown;
  /** Components shown in the chat. */
  ui?: UiComponent[];
  /** A browser-side change (theme, preference, page). */
  uiEffect?: { summary: string; effect: { pref?: string; value?: unknown; navigate?: string; theme?: string } };
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Tables it may change (empty: read only). */
  touches: Table[];
  /** A question to confirm before running, or null when it can run straight away. */
  confirm?: (args: Record<string, unknown>) => string | null;
  run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolOut> | ToolOut;
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });
const bool = (description: string) => ({ type: 'boolean', description });
const n = (v: unknown, what: string) => {
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(`${what} must be a number.`);
  return x;
};
const ok = (result: unknown, ui?: UiComponent[]): ToolOut => ({ result, ...(ui ? { ui } : {}) });

type G = { id: number; name: string; parentId: number | null; path: string; description: string; settings: Record<string, { mode: string; value: unknown; exclude?: number[] }>; keyCount: number };
type K = { id: number; name: string; owner: string; groupId: number; groupPath: string; revoked: boolean; mcp: boolean; ipAllow: string[]; exceptions: Record<string, unknown>; requestsToday: number; identity: { key: boolean; owner: boolean } };
type S = { id: number; name: string; url: string; status: string; hasKey: boolean; models: { id: number; name: string; enabled: number; kind: string | null; kind_override: string | null; price_in: number | null; price_out: number | null; context_len: number | null; api: string | null }[] };

const groups = async () => (await invoke<{ groups: G[] }>('GET', 'context')).groups;
const keys = async () => (await invoke<{ keys: K[] }>('GET', 'keys')).keys;
const servers = async () => (await invoke<{ servers: S[] }>('GET', 'servers')).servers;
const findGroup = async (id: unknown) => {
  const g = (await groups()).find((x) => x.id === n(id, 'groupId'));
  if (!g) throw new Error(`No group ${id}.`);
  return g;
};
const findKey = async (id: unknown) => {
  const k = (await keys()).find((x) => x.id === n(id, 'keyId'));
  if (!k) throw new Error(`No API key ${id}.`);
  return k;
};
const settings = async () => (await invoke<{ settings: { guard: { layers: Record<string, unknown>[] } } & Record<string, unknown> }>('GET', 'settings')).settings;
const kindOf = (m: S['models'][number]) => m.kind_override ?? m.kind ?? 'text';

/** Put one id in or out of a group's list setting, keeping its mode and exclusions. */
async function setGroupList(g: G, key: 'context' | 'mcp_docs', id: number, mode: 'add' | 'remove' | 'exclude' | 'include') {
  const cur = g.settings[key];
  const value = Array.isArray(cur?.value) ? (cur!.value as number[]) : [];
  const exclude = cur?.exclude ?? [];
  const isRoot = g.parentId === null;
  const next = {
    value: mode === 'add' ? [...new Set([...value, id])] : mode === 'remove' ? value.filter((x) => x !== id) : value,
    exclude: mode === 'exclude' ? [...new Set([...exclude, id])] : mode === 'include' ? exclude.filter((x) => x !== id) : exclude,
  };
  if (mode === 'exclude' && isRoot) throw new Error('The root group has nothing inherited to switch off; remove the item instead.');
  const setting = next.value.length || next.exclude.length || isRoot ? { mode: cur?.mode ?? (isRoot ? 'set' : 'add'), value: next.value, ...(next.exclude.length ? { exclude: next.exclude } : {}) } : null;
  await invoke('PUT', `groups/${g.id}/settings`, { key, setting });
}

async function setKeyList(k: K, key: 'context' | 'mcp_docs', id: number, mode: 'add' | 'remove' | 'exclude' | 'include') {
  const cur = k.exceptions[key] as { mode: string; value: number[]; exclude?: number[] } | undefined;
  const value = Array.isArray(cur?.value) ? cur!.value : [];
  const exclude = cur?.exclude ?? [];
  const v = mode === 'add' ? [...new Set([...value, id])] : mode === 'remove' ? value.filter((x) => x !== id) : value;
  const ex = mode === 'exclude' ? [...new Set([...exclude, id])] : mode === 'include' ? exclude.filter((x) => x !== id) : exclude;
  const exceptions = { ...k.exceptions };
  if (v.length || ex.length || cur?.mode === 'override') exceptions[key] = { mode: cur?.mode === 'override' ? 'override' : 'add', value: v, ...(ex.length ? { exclude: ex } : {}) };
  else delete exceptions[key];
  await invoke('PATCH', `keys/${k.id}`, { exceptions });
}

const scopeArgs = {
  groupId: int('Group id (the item applies to this group and its sub-groups).'),
  keyId: int('API key id (the item applies to this key only). Give groupId or keyId.'),
};
const MODES = { type: 'string', enum: ['add', 'remove', 'exclude', 'include'], description: 'add: give it here; remove: take back an own item; exclude: switch an inherited item off here; include: switch it back on.' };

export const TOOLS: AgentTool[] = [
  // ------------------------------------------------------------ read
  {
    name: 'get_overview',
    description: 'Gateway summary: servers online, groups, keys, blocked today, and request counts for a range.',
    parameters: obj({ range: { type: 'string', enum: ['1h', '24h', '7d', '30d'] } }),
    touches: [],
    run: async (a) => {
      const sum = await invoke<Record<string, unknown>>('GET', 'summary');
      const ov = await invoke<{ counts: unknown; overheadP95: unknown }>('GET', `overview?range=${a.range ?? '24h'}`);
      return ok({ summary: sum, counts: ov.counts, guardOverheadP95ms: ov.overheadP95 });
    },
  },
  {
    name: 'list_groups',
    description: 'All groups (tree order) with id, parent, path, key count and which settings each group sets itself.',
    parameters: obj({}),
    touches: [],
    run: async () => ok((await groups()).map((g) => ({ id: g.id, name: g.name, parentId: g.parentId, path: g.path, description: g.description, keys: g.keyCount, sets: Object.keys(g.settings) }))),
  },
  {
    name: 'get_group',
    description: "One group's own settings and what it resolves to (servers, models, context files, guard layers, MCP docs, rate limit), with where each value comes from.",
    parameters: obj({ groupId: int('Group id') }, ['groupId']),
    touches: [],
    run: async (a) => {
      const r = await invoke<{ group: unknown; resolution: { effective: unknown; sources: unknown } }>('GET', `groups/${n(a.groupId, 'groupId')}`);
      return ok({ group: r.group, effective: r.resolution?.effective, sources: r.resolution?.sources });
    },
  },
  {
    name: 'list_keys',
    description: 'API keys with id, name, owner, group, state, MCP access, IP list and own exceptions. Never includes secrets.',
    parameters: obj({ groupId: int('Only keys in this group (optional).') }),
    touches: [],
    run: async (a) =>
      ok(
        (await keys())
          .filter((k) => !a.groupId || k.groupId === Number(a.groupId))
          .map((k) => ({ id: k.id, name: k.name, owner: k.owner, groupId: k.groupId, group: k.groupPath, revoked: k.revoked, mcp: k.mcp, ipAllow: k.ipAllow, exceptions: k.exceptions, requestsToday: k.requestsToday, callerLine: k.identity })),
      ),
  },
  {
    name: 'list_servers_and_models',
    description: 'Model servers and their models: type (text, image, embedding, decision/classifier…), price in/out per 1M tokens, context size, on/off. Server API keys are never shown; only whether one is saved.',
    parameters: obj({ kind: str('Only this model type, e.g. text, classifier, image (optional).') }),
    touches: [],
    run: async (a) =>
      ok(
        (await servers()).map((s) => ({
          id: s.id,
          name: s.name,
          url: s.url,
          status: s.status,
          keySaved: s.hasKey,
          models: s.models.filter((m) => !a.kind || kindOf(m) === a.kind).map((m) => ({ id: m.id, name: m.name, type: kindOf(m), on: !!m.enabled, priceIn: m.price_in, priceOut: m.price_out, context: m.context_len, decisionsApi: m.api === 'decisions' })),
        })),
      ),
  },
  {
    name: 'model_price_analytics',
    description: 'Compare model prices: per type, cheapest and most expensive, averages, and a chart in the chat.',
    parameters: obj({ kind: str('Model type to compare (default text).'), top: int('How many to chart (default 12).') }),
    touches: [],
    run: async (a) => {
      const kind = String(a.kind ?? 'text');
      const ms = (await servers()).flatMap((s) => s.models.map((m) => ({ ...m, server: s.name, type: kindOf(m) })));
      const byType: Record<string, number> = {};
      for (const m of ms) byType[m.type] = (byType[m.type] ?? 0) + 1;
      const priced = ms.filter((m) => m.type === kind && m.price_in != null).sort((x, y) => (x.price_in ?? 0) + (x.price_out ?? 0) - ((y.price_in ?? 0) + (y.price_out ?? 0)));
      const avg = (f: (m: (typeof priced)[number]) => number) => (priced.length ? Math.round((priced.reduce((t, m) => t + f(m), 0) / priced.length) * 1000) / 1000 : null);
      const top = priced.slice(0, Number(a.top) || 12);
      return {
        result: { modelsByType: byType, kind, priced: priced.length, avgInPer1M: avg((m) => m.price_in ?? 0), avgOutPer1M: avg((m) => m.price_out ?? 0), cheapest: top.slice(0, 5).map((m) => `${m.name} (${m.server}) $${m.price_in}/$${m.price_out}`), priciest: priced.slice(-3).map((m) => `${m.name} $${m.price_in}/$${m.price_out}`) },
        ui: [
          { kind: 'chart', title: `${kind} models: $ per 1M tokens (in + out)`, unit: '$', bars: top.map((m) => ({ label: m.name, value: Math.round(((m.price_in ?? 0) + (m.price_out ?? 0)) * 1000) / 1000, hint: `${m.server} · in $${m.price_in} · out $${m.price_out}` })) },
          { kind: 'table', title: 'Models by type', columns: ['Type', 'Models'], rows: Object.entries(byType).map(([t, c]) => [t, c]) },
        ],
      };
    },
  },
  {
    name: 'list_context_files',
    description: 'Context files (sent at the top of every request for the groups they are attached to): id, name, tokens, version, groups.',
    parameters: obj({}),
    touches: [],
    run: async () => ok((await invoke<{ files: { id: number; name: string; tokens: number; version: number; usedBy: string[] }[] }>('GET', 'context')).files.map((f) => ({ id: f.id, name: f.name, tokens: f.tokens, version: f.version, attachedTo: f.usedBy }))),
  },
  {
    name: 'read_context_file',
    description: 'The full text of a context file, with its version history (versions only, not bodies).',
    parameters: obj({ fileId: int('File id') }, ['fileId']),
    touches: [],
    run: async (a) => {
      const r = await invoke<{ file: { id: number; name: string; body: string; version: number }; history: { version: number; created_at: number }[] }>('GET', `context/${n(a.fileId, 'fileId')}`);
      return ok({ ...r.file, versions: r.history.map((h) => h.version) });
    },
  },
  {
    name: 'list_mcp_docs',
    description: 'MCP docs (read by agents on demand at /mcp): id, slug, title, description, tags, who they are shared with, how many keys read them.',
    parameters: obj({}),
    touches: [],
    run: async () => ok((await invoke<{ docs: { id: number; slug: string; title: string; description: string; tags: string[]; groups: number[]; keys: number[]; reach: number; version: number }[] }>('GET', 'docs')).docs.map(({ id, slug, title, description, tags, groups: gs, keys: ks, reach, version }) => ({ id, slug, title, description, tags, groups: gs, keys: ks, reach, version }))),
  },
  {
    name: 'read_mcp_doc',
    description: 'The full Markdown of an MCP doc.',
    parameters: obj({ docId: int('Doc id') }, ['docId']),
    touches: [],
    run: async (a) => ok((await invoke<{ doc: unknown }>('GET', `docs/${n(a.docId, 'docId')}`)).doc),
  },
  {
    name: 'list_guard_layers',
    description: 'The guard pipeline in order: each layer id, name, type, stage (input = before the model, output = after), model, on/off default, what a hit does.',
    parameters: obj({}),
    touches: [],
    run: async () => ok((await settings()).guard.layers.map((l) => ({ id: l.id, name: l.name, type: l.type, stage: l.stage ?? 'input', enabled: l.enabled, model: l.model, onFail: l.onFail, scope: l.scope, placement: l.placement ?? 'prefix' }))),
  },
  {
    name: 'list_rules',
    description: 'Custom regex/contains rules: block, redact or escalate matching content.',
    parameters: obj({}),
    touches: [],
    run: async () => ok((await invoke<{ rules: unknown[] }>('GET', 'rules')).rules),
  },
  {
    name: 'query_activity',
    description: 'Recent requests (newest first) with key, person, group, model, outcome and reason. Filters: blocked, rejected, false_alarm, clean, error, mcp.',
    parameters: obj({ filter: str('Outcome filter (optional).'), groupId: int('Group (and sub-groups) only.'), keyId: int('One key only.'), q: str('Search text.'), limit: int('Rows, default 20, max 100.') }),
    touches: [],
    run: async (a) => {
      const qs = new URLSearchParams({ limit: String(Math.min(100, Number(a.limit) || 20)) });
      if (a.filter) qs.set('filter', String(a.filter));
      if (a.groupId) qs.set('group', String(a.groupId));
      if (a.keyId) qs.set('key', String(a.keyId));
      if (a.q) qs.set('q', String(a.q));
      const r = await invoke<{ rows: Record<string, unknown>[]; counts: unknown }>('GET', `logs?${qs}`);
      return ok({ counts: r.counts, rows: r.rows.map((x) => ({ id: x.id, time: new Date(Number(x.ts)).toISOString(), key: x.key_name, owner: x.owner, group: x.group_name, model: x.model, outcome: x.outcome, reason: x.reason, ms: x.latency_ms })) });
    },
  },
  {
    name: 'get_settings',
    description: 'Global settings: policy prompt, context placement, schema policy, default rate limit, blocked reply, what layers read.',
    parameters: obj({}),
    touches: [],
    run: async () => {
      const s = await settings();
      return ok({ policyPrompt: s.policyPrompt, contextPlacement: s.contextPlacement, schemaPolicy: s.schemaPolicy, defaultRateLimit: s.defaultRateLimit, trustProxy: s.trustProxy, blockedReply: (s.guard as Record<string, unknown>).reply, scan: (s.guard as Record<string, unknown>).scan, flagNobodyCleared: (s.guard as Record<string, unknown>).unresolvedFlag });
    },
  },

  // ------------------------------------------------------------ groups
  {
    name: 'create_group',
    description: 'Create a group under a parent group (default: the root).',
    parameters: obj({ name: str('Group name'), parentId: int('Parent group id'), description: str('Optional description') }, ['name']),
    touches: ['groups'],
    run: async (a) => {
      const root = (await groups()).find((g) => g.parentId === null);
      const g = await invoke<G>('POST', 'groups', { name: a.name, parentId: a.parentId ?? root?.id, description: a.description ?? '' });
      return ok({ created: { id: g.id, name: g.name } }, [{ kind: 'link', label: `Open ${g.name}`, path: `/groups/${g.id}?group=${g.id}` }]);
    },
  },
  {
    name: 'update_group',
    description: 'Rename a group, change its description, or move it under another parent.',
    parameters: obj({ groupId: int('Group id'), name: str('New name'), description: str('New description'), parentId: int('New parent group id') }, ['groupId']),
    touches: ['groups'],
    run: async (a) => ok(await invoke('PATCH', `groups/${n(a.groupId, 'groupId')}`, { ...(a.name ? { name: a.name } : {}), ...(a.description !== undefined ? { description: a.description } : {}), ...(a.parentId ? { parentId: a.parentId } : {}) })),
  },
  {
    name: 'delete_group',
    description: 'Delete an empty group (no sub-groups, no keys). Asks the person to confirm.',
    parameters: obj({ groupId: int('Group id') }, ['groupId']),
    touches: ['groups'],
    confirm: (a) => `Delete group #${a.groupId}? Its own settings go with it.`,
    run: async (a) => ok(await invoke('DELETE', `groups/${n(a.groupId, 'groupId')}`)),
  },
  {
    name: 'set_group_setting',
    description:
      'Set one inherited setting on a group. key: servers (ids, null = all), models (names, "*" = all), context (file ids), mcp_docs (doc ids), layers ({layerId: true|false}), layer_opts ({layerId: {threshold, prompt}}), blocked_reply (text), rate_limit (per minute). mode: add (append to parent) or override (replace); the root uses set. Pass clear=true to inherit again.',
    parameters: obj(
      { groupId: int('Group id'), key: { type: 'string', enum: ['servers', 'models', 'context', 'mcp_docs', 'layers', 'layer_opts', 'blocked_reply', 'rate_limit'] }, mode: { type: 'string', enum: ['set', 'add', 'override'] }, value: { description: 'The value (see description).' }, exclude: { type: 'array', items: { type: 'integer' }, description: 'context/mcp_docs: inherited ids switched off here.' }, clear: bool('Remove the group own setting (inherit again).') },
      ['groupId', 'key'],
    ),
    touches: ['groups'],
    run: async (a) => ok(await invoke('PUT', `groups/${n(a.groupId, 'groupId')}/settings`, { key: a.key, setting: a.clear ? null : { mode: a.mode ?? 'override', value: a.value ?? null, ...(a.exclude ? { exclude: a.exclude } : {}) } })),
  },

  // ------------------------------------------------------------ keys
  {
    name: 'create_key',
    description: 'Create an API key for a person or bot in a group. The secret is shown to the person in the chat (with a reveal button); it is never given to you.',
    parameters: obj({ name: str('Key name, e.g. mina-laptop'), owner: str('Person or bot it is for'), groupId: int('Group id'), ipAllow: str('Optional IPs/CIDRs, comma separated') }, ['name', 'owner', 'groupId']),
    touches: ['api_keys'],
    run: async (a) => {
      const r = await invoke<{ key: { id: number; name: string } }>('POST', 'keys', { name: a.name, owner: a.owner, groupId: a.groupId, ipAllow: a.ipAllow ?? '' });
      return ok({ created: { id: r.key.id, name: r.key.name }, secret: 'shown to the person in the chat, not to you' }, [{ kind: 'secret_reveal', keyId: r.key.id, keyName: r.key.name }]);
    },
  },
  {
    name: 'update_key',
    description: "Change a key: name, owner, group, IP allow-list, caller line (identity: {key, owner}), MCP access, expiry (ms timestamp or null). Exceptions are changed with assign_* and set_layer tools.",
    parameters: obj({ keyId: int('Key id'), name: str('Name'), owner: str('Owner'), groupId: int('Move to group'), ipAllow: str('IPs/CIDRs, comma separated; empty = any'), mcp: bool('MCP access'), identityKey: bool('Caller line includes key name'), identityOwner: bool('Caller line includes owner'), expiresAt: { type: ['integer', 'null'] } }, ['keyId']),
    touches: ['api_keys'],
    run: async (a) => {
      const k = await findKey(a.keyId);
      const body: Record<string, unknown> = {};
      for (const f of ['name', 'owner', 'groupId', 'ipAllow', 'mcp', 'expiresAt']) if (a[f] !== undefined) body[f] = a[f];
      if (a.identityKey !== undefined || a.identityOwner !== undefined) body.identity = { key: a.identityKey ?? k.identity.key, owner: a.identityOwner ?? k.identity.owner };
      await invoke('PATCH', `keys/${k.id}`, body);
      return ok({ updated: k.name });
    },
  },
  {
    name: 'revoke_key',
    description: 'Revoke (or restore) an API key. Clients using it stop working. Asks to confirm.',
    parameters: obj({ keyId: int('Key id'), restore: bool('true to restore a revoked key') }, ['keyId']),
    touches: ['api_keys'],
    confirm: (a) => (a.restore ? null : `Revoke API key #${a.keyId}? Agents using it stop working right away.`),
    run: async (a) => ok(await invoke('PATCH', `keys/${n(a.keyId, 'keyId')}`, { revoked: !a.restore })),
  },
  {
    name: 'rotate_key',
    description: 'Issue a new secret for a key; the old one stops working. The new secret is shown to the person only. Asks to confirm. Cannot be undone.',
    parameters: obj({ keyId: int('Key id') }, ['keyId']),
    touches: ['api_keys'],
    confirm: (a) => `Rotate API key #${a.keyId}? The old secret stops working at once and this cannot be undone.`,
    run: async (a) => {
      const k = await findKey(a.keyId);
      await invoke('POST', `keys/${k.id}/rotate`);
      return ok({ rotated: k.name, secret: 'shown to the person only' }, [{ kind: 'secret_reveal', keyId: k.id, keyName: k.name }]);
    },
  },
  {
    name: 'delete_key',
    description: 'Delete an API key for good. Prefer revoke_key. Asks to confirm. Cannot be undone.',
    parameters: obj({ keyId: int('Key id') }, ['keyId']),
    touches: ['api_keys'],
    confirm: (a) => `Delete API key #${a.keyId} for good? This cannot be undone (revoking keeps the record).`,
    run: async (a) => ok(await invoke('DELETE', `keys/${n(a.keyId, 'keyId')}`)),
  },
  {
    name: 'reveal_key_secret',
    description: "Show a key's secret to the person (a reveal button in the chat). You never see it.",
    parameters: obj({ keyId: int('Key id') }, ['keyId']),
    touches: [],
    run: async (a) => {
      const k = await findKey(a.keyId);
      return ok({ shown: 'to the person only' }, [{ kind: 'secret_reveal', keyId: k.id, keyName: k.name }]);
    },
  },

  // ------------------------------------------------------------ context files and MCP docs
  {
    name: 'create_context_file',
    description: 'Create a Markdown context file (added to every request of the groups/keys it is given to). Optionally give it to a group or key right away.',
    parameters: obj({ name: str('File name, e.g. api-style.md'), body: str('Markdown'), ...scopeArgs }, ['name', 'body']),
    touches: ['context_files', 'groups', 'api_keys'],
    run: async (a) => {
      const f = await invoke<{ id: number; name: string }>('POST', 'context', { name: a.name, body: a.body });
      if (a.keyId) await setKeyList(await findKey(a.keyId), 'context', f.id, 'add');
      else if (a.groupId) await setGroupList(await findGroup(a.groupId), 'context', f.id, 'add');
      return ok({ created: f }, [{ kind: 'link', label: `Open ${f.name}`, path: `/context/${f.id}` }]);
    },
  },
  {
    name: 'edit_context_file',
    description: 'Change a context file: replace its whole body, or replace one exact text (find → replace), or rename it. Every edit is a new version (history kept, undo possible).',
    parameters: obj({ fileId: int('File id'), body: str('New full body'), find: str('Exact text to replace'), replace: str('Replacement text'), name: str('New name') }, ['fileId']),
    touches: ['context_files'],
    run: async (a) => {
      const id = n(a.fileId, 'fileId');
      const cur = (await invoke<{ file: { name: string; body: string } }>('GET', `context/${id}`)).file;
      let body = a.body !== undefined ? String(a.body) : undefined;
      if (a.find !== undefined) {
        if (!cur.body.includes(String(a.find))) throw new Error('The text to replace was not found; read the file first.');
        body = cur.body.replace(String(a.find), String(a.replace ?? ''));
      }
      const f = await invoke<{ version: number }>('PATCH', `context/${id}`, { ...(body !== undefined ? { body } : {}), ...(a.name ? { name: a.name } : {}) });
      return ok({ saved: cur.name, version: f.version }, body !== undefined ? [{ kind: 'diff', title: cur.name, before: cur.body, after: body }] : undefined);
    },
  },
  {
    name: 'delete_context_file',
    description: 'Delete a context file (removed from every group). Asks to confirm. Undo restores it.',
    parameters: obj({ fileId: int('File id') }, ['fileId']),
    touches: ['context_files', 'groups', 'api_keys'],
    confirm: (a) => `Delete context file #${a.fileId}? Groups stop sending it.`,
    run: async (a) => ok(await invoke('DELETE', `context/${n(a.fileId, 'fileId')}`)),
  },
  {
    name: 'assign_context_file',
    description: 'Give a context file to a group or key, take an own one back, or switch an inherited one off/on there.',
    parameters: obj({ fileId: int('File id'), mode: MODES, ...scopeArgs }, ['fileId', 'mode']),
    touches: ['groups', 'api_keys'],
    run: async (a) => {
      const id = n(a.fileId, 'fileId');
      const mode = a.mode as 'add' | 'remove' | 'exclude' | 'include';
      if (a.keyId) await setKeyList(await findKey(a.keyId), 'context', id, mode);
      else await setGroupList(await findGroup(a.groupId), 'context', id, mode);
      return ok({ done: `${mode} file #${id}` });
    },
  },
  {
    name: 'create_mcp_doc',
    description: 'Create an MCP doc (agents read it on demand with list_docs/read_doc). Give it a clear description so agents know when to open it. Optionally share it with a group or key.',
    parameters: obj({ title: str('Title'), body: str('Markdown'), description: str('When agents should read it'), tags: { type: 'array', items: { type: 'string' } }, slug: str('Optional slug'), ...scopeArgs }, ['title', 'body']),
    touches: ['mcp_docs', 'groups', 'api_keys'],
    run: async (a) => {
      const d = await invoke<{ id: number; slug: string; title: string }>('POST', 'docs', { title: a.title, body: a.body, description: a.description ?? '', tags: a.tags ?? [], ...(a.slug ? { slug: a.slug } : {}) });
      if (a.keyId) await setKeyList(await findKey(a.keyId), 'mcp_docs', d.id, 'add');
      else if (a.groupId) await setGroupList(await findGroup(a.groupId), 'mcp_docs', d.id, 'add');
      return ok({ created: d }, [{ kind: 'link', label: `Open ${d.title}`, path: `/docs/${d.id}` }]);
    },
  },
  {
    name: 'edit_mcp_doc',
    description: 'Change an MCP doc: body (whole, or find → replace), title, slug, description, tags. Every edit is a new version (undo possible).',
    parameters: obj({ docId: int('Doc id'), body: str('New full body'), find: str('Exact text to replace'), replace: str('Replacement'), title: str('Title'), slug: str('Slug'), description: str('Description'), tags: { type: 'array', items: { type: 'string' } } }, ['docId']),
    touches: ['mcp_docs'],
    run: async (a) => {
      const id = n(a.docId, 'docId');
      const cur = (await invoke<{ doc: { title: string; body: string } }>('GET', `docs/${id}`)).doc;
      let body = a.body !== undefined ? String(a.body) : undefined;
      if (a.find !== undefined) {
        if (!cur.body.includes(String(a.find))) throw new Error('The text to replace was not found; read the doc first.');
        body = cur.body.replace(String(a.find), String(a.replace ?? ''));
      }
      const patch: Record<string, unknown> = {};
      for (const f of ['title', 'slug', 'description', 'tags']) if (a[f] !== undefined) patch[f] = a[f];
      if (body !== undefined) patch.body = body;
      const d = await invoke<{ version: number }>('PATCH', `docs/${id}`, patch);
      return ok({ saved: cur.title, version: d.version }, body !== undefined ? [{ kind: 'diff', title: cur.title, before: cur.body, after: body }] : undefined);
    },
  },
  {
    name: 'delete_mcp_doc',
    description: 'Delete an MCP doc (unshared everywhere). Asks to confirm. Undo restores it.',
    parameters: obj({ docId: int('Doc id') }, ['docId']),
    touches: ['mcp_docs', 'groups', 'api_keys'],
    confirm: (a) => `Delete MCP doc #${a.docId}? Agents lose it right away.`,
    run: async (a) => ok(await invoke('DELETE', `docs/${n(a.docId, 'docId')}`)),
  },
  {
    name: 'assign_mcp_doc',
    description: 'Share an MCP doc with a group or key, take an own share back, or switch an inherited doc off/on there.',
    parameters: obj({ docId: int('Doc id'), mode: MODES, ...scopeArgs }, ['docId', 'mode']),
    touches: ['groups', 'api_keys'],
    run: async (a) => {
      const id = n(a.docId, 'docId');
      const mode = a.mode as 'add' | 'remove' | 'exclude' | 'include';
      if (a.keyId) await setKeyList(await findKey(a.keyId), 'mcp_docs', id, mode);
      else await setGroupList(await findGroup(a.groupId), 'mcp_docs', id, mode);
      return ok({ done: `${mode} doc #${id}` });
    },
  },

  // ------------------------------------------------------------ guard layers
  {
    name: 'add_guard_layer',
    description:
      'Add a guard layer. type: classifier, judge, patterns, redactor, router. stage: input (before the model) or output (checks the answer). onFail: block, flag, redact (input) or retry (output). Give serverId+model for model layers, a prompt for judges.',
    parameters: obj({ name: str('Name'), type: { type: 'string', enum: ['classifier', 'judge', 'patterns', 'redactor', 'router'] }, stage: { type: 'string', enum: ['input', 'output'] }, serverId: int('Server id'), model: str('Model name'), prompt: str('Judge system prompt'), onFail: { type: 'string', enum: ['block', 'flag', 'redact', 'retry'] }, enabled: bool('On by default') }, ['name', 'type']),
    touches: ['settings'],
    run: async (a) => {
      const s = await settings();
      const layers = s.guard.layers;
      let i = layers.length + 1;
      while (layers.some((l) => l.id === `layer-${i}`)) i++;
      const layer = { id: `layer-${i}`, name: a.name, type: a.type, stage: a.stage ?? 'input', serverId: a.serverId ?? null, model: a.model ?? '', prompt: a.prompt ?? '', onFail: a.onFail ?? (a.stage === 'output' ? 'retry' : 'block'), enabled: a.enabled !== false };
      await invoke('PATCH', 'settings', { guard: { layers: [...layers, layer] } });
      return ok({ added: layer.id }, [{ kind: 'link', label: `Open ${a.name}`, path: `/guard/${layer.id}` }]);
    },
  },
  {
    name: 'update_guard_layer',
    description: 'Change fields of a guard layer (name, model, serverId, prompt, threshold, onFail, onError, timeoutMs, scope, placement, sameModel, enabled, retries…).',
    parameters: obj({ layerId: str('Layer id'), patch: { type: 'object', description: 'Fields to change' } }, ['layerId', 'patch']),
    touches: ['settings'],
    run: async (a) => {
      const s = await settings();
      const layers = s.guard.layers.map((l) => (l.id === a.layerId ? { ...l, ...(a.patch as Record<string, unknown>), id: l.id } : l));
      if (!s.guard.layers.some((l) => l.id === a.layerId)) throw new Error(`No layer ${a.layerId}.`);
      await invoke('PATCH', 'settings', { guard: { layers } });
      return ok({ updated: a.layerId });
    },
  },
  {
    name: 'remove_guard_layer',
    description: 'Remove a guard layer from the pipeline. Asks to confirm. Undo restores it.',
    parameters: obj({ layerId: str('Layer id') }, ['layerId']),
    touches: ['settings'],
    confirm: (a) => `Remove guard layer "${a.layerId}" from the pipeline?`,
    run: async (a) => {
      const s = await settings();
      await invoke('PATCH', 'settings', { guard: { layers: s.guard.layers.filter((l) => l.id !== a.layerId) } });
      return ok({ removed: a.layerId });
    },
  },
  {
    name: 'reorder_guard_layers',
    description: 'Set the pipeline order: every layer id, in the new order.',
    parameters: obj({ order: { type: 'array', items: { type: 'string' } } }, ['order']),
    touches: ['settings'],
    run: async (a) => {
      const s = await settings();
      const order = a.order as string[];
      const layers = [...s.guard.layers].sort((x, y) => order.indexOf(String(x.id)) - order.indexOf(String(y.id)));
      await invoke('PATCH', 'settings', { guard: { layers } });
      return ok({ order: layers.map((l) => l.id) });
    },
  },
  {
    name: 'set_layer_for_scope',
    description: 'Switch a guard layer on or off for one group (and its sub-groups) or one key, or back to inherit.',
    parameters: obj({ layerId: str('Layer id'), state: { type: 'string', enum: ['on', 'off', 'inherit'] }, ...scopeArgs }, ['layerId', 'state']),
    touches: ['groups', 'api_keys'],
    run: async (a) => {
      const id = String(a.layerId);
      if (a.keyId) {
        const k = await findKey(a.keyId);
        const cur = { ...((k.exceptions.layers as { value?: Record<string, boolean> } | undefined)?.value ?? {}) };
        if (a.state === 'inherit') delete cur[id];
        else cur[id] = a.state === 'on';
        const exceptions = { ...k.exceptions };
        if (Object.keys(cur).length) exceptions.layers = { mode: 'override', value: cur };
        else delete exceptions.layers;
        await invoke('PATCH', `keys/${k.id}`, { exceptions });
      } else {
        const g = await findGroup(a.groupId);
        const cur = { ...((g.settings.layers?.value as Record<string, boolean> | undefined) ?? {}) };
        if (a.state === 'inherit') delete cur[id];
        else cur[id] = a.state === 'on';
        await invoke('PUT', `groups/${g.id}/settings`, { key: 'layers', setting: Object.keys(cur).length || g.parentId === null ? { mode: g.parentId === null ? 'set' : 'override', value: cur } : null });
      }
      return ok({ done: `${id} ${a.state}` });
    },
  },

  // ------------------------------------------------------------ rules
  {
    name: 'create_rule',
    description: 'Create a custom rule: target (user, tool, any), match_type (contains, regex), pattern, action (block, redact, escalate), optional group_id and message.',
    parameters: obj({ name: str('Name'), pattern: str('Text or regex'), match_type: { type: 'string', enum: ['contains', 'regex'] }, action: { type: 'string', enum: ['block', 'redact', 'escalate'] }, target: { type: 'string', enum: ['user', 'tool', 'any'] }, group_id: int('Only this group (optional)'), message: str('Message when blocked') }, ['name', 'pattern']),
    touches: ['rules'],
    run: async (a) => ok(await invoke('POST', 'rules', a)),
  },
  {
    name: 'update_rule',
    description: 'Change a custom rule (any field, or enabled 0/1).',
    parameters: obj({ ruleId: int('Rule id'), patch: { type: 'object' } }, ['ruleId', 'patch']),
    touches: ['rules'],
    run: async (a) => ok(await invoke('PATCH', `rules/${n(a.ruleId, 'ruleId')}`, a.patch as Record<string, unknown>)),
  },
  {
    name: 'delete_rule',
    description: 'Delete a custom rule. Asks to confirm. Undo restores it.',
    parameters: obj({ ruleId: int('Rule id') }, ['ruleId']),
    touches: ['rules'],
    confirm: (a) => `Delete custom rule #${a.ruleId}?`,
    run: async (a) => ok(await invoke('DELETE', `rules/${n(a.ruleId, 'ruleId')}`)),
  },

  // ------------------------------------------------------------ servers and models
  {
    name: 'add_server',
    description: 'Add an OpenAI-compatible model server (vLLM, OpenRouter…) by name and URL. If it needs an API key, the person types it into a secure field in the chat; never ask them to paste it into the chat. Models are discovered and start hidden.',
    parameters: obj({ name: str('Name'), url: str('Base URL, e.g. https://openrouter.ai/api'), needsKey: bool('Show the secure API key field') }, ['name', 'url']),
    touches: ['servers', 'models'],
    run: async (a) => {
      const found = await invoke<{ ok: boolean; models?: unknown[]; error?: string }>('POST', 'servers/discover', { url: a.url }).catch((e) => ({ ok: false, error: String(e), models: [] }));
      const s = await invoke<{ id: number; name: string }>('POST', 'servers', { name: a.name, url: a.url, models: found.ok ? found.models : [], enabled: [] });
      return ok(
        { created: { id: s.id, name: s.name }, modelsFound: found.ok ? (found.models?.length ?? 0) : 0, note: found.ok ? 'Models start hidden; turn on the ones clients may use.' : 'Could not list models yet (it may need an API key).' },
        [...(a.needsKey !== false ? [{ kind: 'secret_input' as const, serverId: s.id, serverName: s.name }] : []), { kind: 'link', label: `Open ${s.name}`, path: `/servers/${s.id}` }],
      );
    },
  },
  {
    name: 'request_server_key',
    description: 'Show the secure API key field for an existing server (to add or replace its key). The key goes straight to the server; you only learn that it was saved.',
    parameters: obj({ serverId: int('Server id') }, ['serverId']),
    touches: [],
    run: async (a) => {
      const s = (await servers()).find((x) => x.id === Number(a.serverId));
      if (!s) throw new Error(`No server ${a.serverId}.`);
      return ok({ shown: 'secure key field' }, [{ kind: 'secret_input', serverId: s.id, serverName: s.name }]);
    },
  },
  {
    name: 'update_server',
    description: 'Rename a server or change its URL.',
    parameters: obj({ serverId: int('Server id'), name: str('Name'), url: str('URL') }, ['serverId']),
    touches: ['servers'],
    run: async (a) => ok(await invoke('PATCH', `servers/${n(a.serverId, 'serverId')}`, { ...(a.name ? { name: a.name } : {}), ...(a.url ? { url: a.url } : {}) })),
  },
  {
    name: 'rediscover_models',
    description: "Re-read a server's model list (new models arrive hidden).",
    parameters: obj({ serverId: int('Server id') }, ['serverId']),
    touches: ['models', 'servers'],
    run: async (a) => ok(await invoke('POST', `servers/${n(a.serverId, 'serverId')}/rediscover`)),
  },
  {
    name: 'set_model',
    description: 'Turn a model on/off for clients, or set its type (text, image, audio, video, embedding, rerank, classifier, other; null = auto).',
    parameters: obj({ modelId: int('Model id (from list_servers_and_models)'), enabled: bool('On for clients'), kind: { type: ['string', 'null'] } }, ['modelId']),
    touches: ['models'],
    run: async (a) => ok(await invoke('PATCH', `models/${n(a.modelId, 'modelId')}`, { ...(a.enabled !== undefined ? { enabled: a.enabled } : {}), ...(a.kind !== undefined ? { kind: a.kind } : {}) })),
  },
  {
    name: 'delete_server',
    description: 'Remove a model server and its models. Asks to confirm. Undo brings the server back without its API key.',
    parameters: obj({ serverId: int('Server id') }, ['serverId']),
    touches: ['servers', 'models', 'limits'],
    confirm: (a) => `Remove server #${a.serverId} and its models? Clients can no longer reach them, and its saved API key is lost.`,
    run: async (a) => ok(await invoke('DELETE', `servers/${n(a.serverId, 'serverId')}`)),
  },

  // ------------------------------------------------------------ settings and UI
  {
    name: 'update_settings',
    description: 'Change global settings: policyPrompt, contextPlacement (top|end), schemaPolicy (strict|accept_known), defaultRateLimit, trustProxy, guard.reply {template, includeReason}, guard.scan {user, tool, system}, guard.unresolvedFlag (block|allow).',
    parameters: obj({ patch: { type: 'object' } }, ['patch']),
    touches: ['settings'],
    run: async (a) => {
      const p = { ...(a.patch as Record<string, unknown>) };
      if (p.guard && typeof p.guard === 'object') delete (p.guard as Record<string, unknown>).layers;
      await invoke('PATCH', 'settings', p);
      return ok({ saved: Object.keys(p) });
    },
  },
  {
    name: 'set_ui',
    description: "Change the console's look or open a page for the person: theme (offwhite, light, dark), a preference (autosave on/off, chat Markdown…), or navigate to a path like /groups/3 or /activity?filter=blocked.",
    parameters: obj({ theme: { type: 'string', enum: ['offwhite', 'light', 'dark'] }, pref: str('Preference key, e.g. autosave'), value: { description: 'Preference value' }, navigate: str('Console path to open') }),
    touches: [],
    run: (a) => {
      const effect = { ...(a.theme ? { theme: String(a.theme) } : {}), ...(a.pref ? { pref: String(a.pref), value: a.value } : {}), ...(a.navigate ? { navigate: String(a.navigate) } : {}) };
      const summary = [a.theme && `Theme → ${a.theme}`, a.pref && `${a.pref} → ${JSON.stringify(a.value)}`, a.navigate && `Opened ${a.navigate}`].filter(Boolean).join(', ');
      return { result: { done: summary }, ui: [{ kind: 'ui_effect', effect }], uiEffect: { summary, effect } };
    },
  },
  {
    name: 'show_ui',
    description: 'Show an interactive component in the chat: table {columns, rows}, chart {bars:[{label,value}]}, choice {question, options:[{label,value}]} (the pick comes back as the next message), or form {title, fields:[{name,label,type,options}]} (the answers come back as the next message).',
    parameters: obj({ component: { type: 'object', description: 'One component: {kind: "table"|"chart"|"choice"|"form", …}' } }, ['component']),
    touches: [],
    run: (a) => {
      const c = a.component as UiComponent;
      if (!['table', 'chart', 'choice', 'form'].includes(String(c?.kind))) throw new Error('kind must be table, chart, choice or form.');
      return { result: { shown: c.kind }, ui: [c] };
    },
  },
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

/** The OpenAI "tools" list sent to the model. */
export const toolSpecs = () => TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
