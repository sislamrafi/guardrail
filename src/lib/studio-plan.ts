// What the gateway will do with a Studio request, worked out before it is sent:
// the key and group chain, every group setting and where it comes from, the models,
// rules, context and guard layers. Studio's debug panel shows this next to the chat.
import { groupKey } from './client-run';
import { buildContextBlock, estimateTokens, listFiles } from './context';
import { allowedRoutes } from './gateway';
import { SETTING_DEFS, chainOf, listGroups, resolveGroup } from './groups';
import { getKey } from './keys';
import { adapterFor } from './layers';
import { layerOn } from './pipeline';
import { listRules } from './rules';
import { getServer, modelMeta } from './servers';
import { getSettings } from './settings';

export interface Plan {
  who: { key: string; owner: string; asGroup: boolean; problem: string | null };
  chain: { id: number; name: string }[];
  /** One row per group setting: the effective value and which group set it, with each group's own choice. */
  params: { key: string; label: string; value: string; from: string[]; cells: { group: string; state: string; value: string }[] }[];
  models: { allowed: string[]; picked: string; ok: boolean; servers: string[] };
  rules: { id: number; name: string; action: string; target: string; match: string; pattern: string; from: string }[];
  context: { placement: 'top' | 'end'; policy: string; tokens: number; files: { id: number; name: string; version: number; tokens: number; from: string; body: string }[] };
  layers: { id: string; n: number; name: string; type: string; on: boolean; why: string; model: string; server: string | null; adapter: string; scope: string; onFail: string; onError: string; threshold: number; timeoutMs: number; groupLines: string[] }[];
  unresolvedFlag: string;
  blockedReply: string;
  rateLimit: number;
}

const show = (v: unknown, names: Map<number, string>, key: string): string => {
  if (key === 'servers' && v === null) return 'every server';
  if (key === 'models' && Array.isArray(v) && v.includes('*')) return 'every enabled model';
  if (v === null || v === undefined) return '–';
  if (key === 'context' && Array.isArray(v)) return v.map((id) => names.get(Number(id)) ?? `#${id}`).join(', ') || 'none';
  if (key === 'servers' && Array.isArray(v)) return v.map((id) => getServer(Number(id))?.name ?? `#${id}`).join(', ') || 'none';
  if (Array.isArray(v)) return v.join(', ') || 'none';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (key === 'layer_opts' && typeof v === 'object') {
    const parts = Object.entries(v as Record<string, { threshold?: number | null; prompt?: string; prompt_parts?: unknown[] }>).flatMap(([id, o]) => [o.threshold != null ? `${id} at ${Number(o.threshold).toFixed(2)}` : '', o.prompt || o.prompt_parts?.length ? `${id} + prompt lines` : ''].filter(Boolean));
    return parts.join(', ') || 'layer defaults';
  }
  if (typeof v === 'object') return Object.entries(v as Record<string, boolean>).map(([k, on]) => `${k}: ${on ? 'on' : 'off'}`).join(', ') || 'none';
  return String(v);
};

export function planFor(input: { keyId?: number; groupId?: number; model: string; layers?: string[] | null }): Plan {
  const key = input.keyId ? getKey(input.keyId) : input.groupId ? groupKey(input.groupId) : undefined;
  if (!key) throw new Error('Pick a key or a group in the scenario settings.');
  const problem = key.revoked ? 'This key is revoked, so the request will be rejected.' : key.expiresAt && key.expiresAt < Date.now() ? 'This key has expired, so the request will be rejected.' : null;
  const settings = getSettings();
  const groups = listGroups();
  const chain = chainOf(key.groupId, groups);
  const res = resolveGroup(key.groupId, key.exceptions, groups);
  const eff = res.effective;
  const files = listFiles();
  const names = new Map(files.map((f) => [f.id, f.name]));
  const layerNames = [...chain.map((g) => g.name), ...(res.matrix[0]?.cells.length > chain.length ? ['This key'] : [])];

  const params = res.matrix.map((row) => ({
    key: row.key,
    label: row.label,
    value: show(eff[row.key as keyof typeof eff], names, row.key),
    from: res.sources[row.key],
    cells: row.cells.map((c, i) => ({ group: layerNames[i] ?? '?', state: c.state, value: c.state === 'inherited' ? '' : show(c.value, names, row.key) })),
  }));

  const { byModel } = allowedRoutes(key, eff);
  const allowed = [...byModel.keys()].sort();
  const routes = byModel.get(input.model) ?? [];

  // Which group in the chain added each context file.
  const ctxRow = res.matrix.find((r) => r.key === 'context');
  const fileFrom = new Map<number, string>();
  ctxRow?.cells.forEach((c, i) => {
    if (c.state === 'inherited' || !Array.isArray(c.value)) return;
    if (c.state !== 'add') fileFrom.clear();
    for (const id of c.value as number[]) if (!fileFrom.has(Number(id))) fileFrom.set(Number(id), layerNames[i] ?? '?');
  });
  const ctxFiles = eff.context.map((id) => files.find((f) => f.id === id)).filter((f) => !!f);
  const block = buildContextBlock(settings.policyPrompt, ctxFiles);

  const chainIds = chain.map((g) => g.id);
  const byId = new Map(groups.map((g) => [g.id, g.name]));
  const rules = listRules()
    .filter((r) => r.enabled && (r.group_id === null || chainIds.includes(r.group_id)))
    .map((r) => ({ id: r.id, name: r.name, action: r.action, target: r.target, match: r.match_type, pattern: r.pattern, from: r.group_id === null ? 'Every group' : (byId.get(r.group_id) ?? '?') }));

  const all = settings.guard.layers;
  const picked = input.layers ? all.filter((l) => input.layers!.includes(l.id)) : all;
  const layers = picked.map((l, i) => {
    const on = layerOn(l, eff);
    const why = !on ? (l.enabled && l.id in eff.layers ? `Turned off by ${res.sources.layers.join(' › ')}` : 'Switched off on the Guard checks page') : l.enabled ? 'On' : `Turned on by ${res.sources.layers.join(' › ')}`;
    const o = eff.layer_opts[l.id];
    return { id: l.id, n: i + 1, name: l.name, type: l.type, on, why, model: l.model, server: l.serverId ? (getServer(l.serverId)?.name ?? null) : null, adapter: l.type === 'patterns' ? 'built-in' : adapterFor(l, modelMeta(l.serverId, l.model)), scope: l.scope, onFail: l.onFail, onError: l.onError, threshold: o?.threshold ?? l.threshold, timeoutMs: l.timeoutMs, groupLines: (o?.prompt_parts ?? []).map((p) => `${p.from}: ${p.text}`) };
  });

  return {
    who: { key: key.name, owner: key.owner, asGroup: !input.keyId, problem },
    chain: chain.map((g) => ({ id: g.id, name: g.name })),
    params: params.filter((p) => SETTING_DEFS.some((d) => d.key === p.key)),
    models: { allowed, picked: input.model, ok: routes.length > 0, servers: routes.map((r) => r.server.name) },
    rules,
    context: { placement: settings.contextPlacement, policy: settings.policyPrompt, tokens: block ? estimateTokens(block) : 0, files: ctxFiles.map((f) => ({ id: f.id, name: f.name, version: f.version, tokens: estimateTokens(f.body), from: fileFrom.get(f.id) ?? '?', body: f.body })) },
    layers,
    unresolvedFlag: settings.guard.unresolvedFlag,
    blockedReply: eff.blocked_reply,
    rateLimit: eff.rate_limit,
  };
}
