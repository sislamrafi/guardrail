'use client';

import { useMemo, useState } from 'react';
import { useActions } from '../actions';
import { Ico } from '../icons';
import { Dialog, Empty, Field, IconBtn, Loading, Note, Page, Pill, Section, Seg, Stat, Switch, ago, fmtTokens, ms, price, secretProps } from '../kit';
import { pathFor, useNav } from '../nav';
import { api, useStore, useUi } from '../store';
import type { Data, LimitView, ServerC } from '../types';

const statusPill = (s: ServerC) =>
  s.status === 'online' ? <Pill tone="ok">Online · {ms(s.latency_ms)}</Pill> : s.status === 'down' ? <Pill tone="bad">Down</Pill> : <Pill>Not checked</Pill>;

function describe(l: LimitView, data: Data) {
  const parts: string[] = [];
  if (l.allowedGroups?.length) parts.push(`${l.allowedGroups.map((id) => data.groups.find((g) => g.id === id)?.name ?? '?').join(', ')} only`);
  if (l.rate_limit) parts.push(`${l.rate_limit} requests/min per key`);
  return parts.join(' · ') || l.note || 'No limit set';
}

// ---------------------------------------------------------------- /servers

export function ServersHome() {
  const { data, error } = useStore();
  const nav = useNav();
  const [limit, setLimit] = useState<Partial<LimitView> | null>(null);
  const act = useActions();
  if (!data) return <Loading error={error} />;
  const global = data.limits.find((l) => l.scope === 'global');
  return (
    <Page
      icon="servers"
      title="Servers and models"
      sub="vLLM or any OpenAI-compatible server. GuardRail finds the models each one serves; turn on the ones clients may use."
      actions={
        <button type="button" className="cx-btn pri" onClick={() => nav.go('/servers/new')}>
          <Ico n="plus" size={14} /> Add server
        </button>
      }
    >
      {data.servers.length === 0 ? (
        <Empty icon="servers" title="No servers yet">
          Add a vLLM server to start. <button type="button" className="cx-link" onClick={() => nav.go('/servers/new')}>Add a server</button>
        </Empty>
      ) : (
        <div className="cx-table-wrap">
          <table className="cx-table">
            <thead>
              <tr>
                <th>Server</th>
                <th>Status</th>
                <th>Used for</th>
                <th>Models on</th>
                <th>Prefix cache</th>
                <th>Checked</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data.servers.map((s) => (
                <tr key={s.id} className="click" onClick={() => nav.go(pathFor('servers', s.id))}>
                  <td>
                    <b>{s.name}</b>
                    <div className="mono cx-muted">{s.url}</div>
                  </td>
                  <td>{statusPill(s)}</td>
                  <td>{s.role === 'guard' ? <Pill tone="info">Guard checks</Pill> : 'Clients'}</td>
                  <td className="tnum">
                    {s.models.filter((m) => m.enabled).length} / {s.models.length}
                  </td>
                  <td className="tnum">{s.cache_hit_rate == null ? '–' : `${Math.round(s.cache_hit_rate * 100)}%`}</td>
                  <td className="cx-muted">{ago(s.last_checked)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <span className="cx-row-btns">
                      <IconBtn icon="refresh" label={`Rediscover ${s.name}`} onClick={() => void act.rediscover(s)} />
                      <IconBtn icon="trash" label={`Remove ${s.name}`} onClick={() => void act.deleteServer(s)} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Limits data={data} onEdit={setLimit} />
      {limit && <LimitDialog init={limit} data={data} onClose={() => setLimit(null)} />}
      {!global && data.servers.length > 0 && <p className="cx-hint">Who may use a model is set on groups. Limits here apply on top, to everyone.</p>}
    </Page>
  );
}

function Limits({ data, onEdit }: { data: Data; onEdit: (l: Partial<LimitView>) => void }) {
  const act = useActions();
  const sname = (id: number | null) => data.servers.find((s) => s.id === id)?.name ?? '?';
  const global = data.limits.find((l) => l.scope === 'global');
  const rest = data.limits.filter((l) => l.scope !== 'global');
  return (
    <Section
      title="Limits"
      hint="Rate limits and group restrictions for all servers, one server or one model. The narrowest one wins."
      actions={
        <button type="button" className="cx-btn" onClick={() => onEdit({ scope: 'model' })}>
          <Ico n="plus" size={14} /> Add limit
        </button>
      }
    >
      <div className="cx-list">
        <div className="cx-list-row">
          <Pill>All servers</Pill>
          <span className="grow">{global ? describe(global, data) : <span className="cx-muted">No global limit. Group rate limits still apply.</span>}</span>
          <button type="button" className="cx-btn sm" onClick={() => onEdit(global ?? { scope: 'global' })}>
            {global ? 'Edit' : 'Set'}
          </button>
          {global && <IconBtn icon="trash" label="Remove the global limit" onClick={() => void act.deleteLimit(global.id)} />}
        </div>
        {rest.map((l) => (
          <div key={l.id} className="cx-list-row">
            <Pill tone="info">{l.scope === 'server' ? 'Server' : 'Model'}</Pill>
            <span className="grow">
              <b className="mono">{l.scope === 'server' ? sname(l.server_id) : `${l.model_name} on ${sname(l.server_id)}`}</b>
              <span className="cx-muted"> · {describe(l, data)}</span>
            </span>
            <button type="button" className="cx-btn sm" onClick={() => onEdit(l)}>
              Edit
            </button>
            <IconBtn icon="trash" label="Remove limit" onClick={() => void act.deleteLimit(l.id)} />
          </div>
        ))}
      </div>
    </Section>
  );
}

export function LimitDialog({ init, data, onClose }: { init: Partial<LimitView>; data: Data; onClose: () => void }) {
  const ui = useUi();
  const inference = data.servers.filter((s) => s.role === 'inference');
  const [scope, setScope] = useState<LimitView['scope']>(init.scope ?? 'model');
  const [serverId, setServerId] = useState<number | null>(init.server_id ?? inference[0]?.id ?? null);
  const [model, setModel] = useState(init.model_name ?? '');
  const [rate, setRate] = useState(init.rate_limit ? String(init.rate_limit) : '');
  const [groups, setGroups] = useState<number[]>(init.allowedGroups ?? []);
  const [busy, setBusy] = useState(false);
  const models = inference.find((s) => s.id === serverId)?.models ?? [];
  const save = async () => {
    setBusy(true);
    const ok = await ui.run(() => api('limits', { body: { id: init.id, scope, serverId, modelName: model, rateLimit: rate ? Number(rate) : null, allowedGroups: groups } }), 'Limit saved');
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog
      title={init.id ? 'Edit limit' : 'Add a limit'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cx-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="cx-btn pri" disabled={busy || (scope === 'model' && !model) || (scope !== 'global' && !serverId)} onClick={save}>
            Save limit
          </button>
        </>
      }
    >
      <Field label="Applies to">
        <Seg value={scope} onChange={setScope} label="Applies to" options={[['global', 'All servers'], ['server', 'One server'], ['model', 'One model']]} />
      </Field>
      {scope !== 'global' && (
        <Field label="Server">
          <select className="cx-input" value={serverId ?? ''} onChange={(e) => (setServerId(Number(e.target.value)), setModel(''))}>
            {inference.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {scope === 'model' && (
        <Field label="Model">
          <select className="cx-input mono" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">Pick a model</option>
            {models.map((m) => (
              <option key={m.id} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Rate limit per key (requests per minute)" hint="Empty for no limit.">
        <input className="cx-input" type="number" min={1} value={rate} onChange={(e) => setRate(e.target.value)} />
      </Field>
      <Field label="Only these groups (and their sub-groups)" hint="None ticked means every group.">
        <div className="cx-checklist">
          {data.groups.map((g) => (
            <label key={g.id} className="cx-check" style={{ paddingLeft: g.depth * 16 }}>
              <input type="checkbox" checked={groups.includes(g.id)} onChange={(e) => setGroups(e.target.checked ? [...groups, g.id] : groups.filter((x) => x !== g.id))} />
              {g.name}
            </label>
          ))}
        </div>
      </Field>
    </Dialog>
  );
}

// ---------------------------------------------------------------- /servers/new

interface Found {
  ok: boolean;
  error?: string;
  url?: string;
  latency?: number;
  models?: { name: string; contextLen: number | null; priceIn?: number | null; priceOut?: number | null }[];
}

export function AddServer({ role = 'inference', onSaved }: { role?: 'inference' | 'guard'; onSaved?: (s: { id: number; name: string }) => void }) {
  const ui = useUi();
  const nav = useNav();
  const { reload } = useStore();
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [asRole, setAsRole] = useState<'inference' | 'guard'>(role);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  const discover = async () => {
    setBusy(true);
    try {
      const r = await api<Found>('servers/discover', { body: { url, apiKey: key } });
      setFound(r);
      if (r.ok) {
        // Nothing starts picked: only the models you tick are offered to clients.
        setPicked(new Set());
        if (!name) {
          try {
            setName(new URL(r.url!).hostname.replace(/\./g, '-'));
          } catch {
            setName('server');
          }
        }
      }
    } catch (e) {
      ui.toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    let made: { id: number; name: string } | null = null;
    await ui.run(async () => {
      made = await api<{ id: number; name: string }>('servers', { body: { name, url: found?.url ?? url, apiKey: key, role: asRole, models: found?.models ?? [], enabled: [...picked], latency: found?.latency } });
    }, `${name} added`);
    setBusy(false);
    if (made) {
      await reload();
      if (onSaved) onSaved(made);
      else nav.go(pathFor('servers', (made as { id: number }).id), { replace: true });
    }
  };
  const shown = (found?.models ?? []).filter((m) => !q || m.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="cx-form">
      <form
        className="cx-form-row"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void discover();
        }}
      >
        <Field label="Server address" grow>
          <input className="cx-input mono" placeholder="http://10.0.1.5:8000" value={url} onChange={(e) => setUrl(e.target.value)} required autoFocus />
        </Field>
        <Field label="Server API key (optional)">
          <input className="cx-input mono" {...secretProps} name="gr-upstream-secret" value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <button type="submit" className="cx-btn pri tall" disabled={busy || !url.trim()}>
          <Ico n="search" size={14} /> {busy && !found ? 'Looking…' : 'Discover models'}
        </button>
      </form>
      {found && !found.ok && <Note tone="bad">Could not connect: {found.error}. Check the address and that the server is running with its OpenAI API.</Note>}
      {found?.ok && (
        <>
          <div className="cx-form-row center">
            <Pill tone="ok">Connected · {ms(found.latency)}</Pill>
            <span className="cx-muted">
              Found {found.models!.length} models. {picked.size} picked for {asRole === 'guard' ? 'the guard checks' : 'clients'}.
            </span>
            <span className="grow" />
            <input className="cx-input sm" type="search" placeholder="Filter models" aria-label="Filter models" value={q} onChange={(e) => setQ(e.target.value)} />
            <button type="button" className="cx-btn sm" onClick={() => setPicked(new Set([...picked, ...shown.map((m) => m.name)]))}>
              Pick {q ? 'shown' : 'all'}
            </button>
            <button type="button" className="cx-btn sm" onClick={() => setPicked(new Set([...picked].filter((n) => !shown.some((m) => m.name === n))))}>
              Clear {q ? 'shown' : 'all'}
            </button>
          </div>
          <div className="cx-pick-list" role="group" aria-label="Models">
            {shown.slice(0, 500).map((m) => (
              <label key={m.name} className="cx-pick">
                <input type="checkbox" checked={picked.has(m.name)} onChange={(e) => setPicked((p) => (e.target.checked ? new Set(p).add(m.name) : new Set([...p].filter((x) => x !== m.name))))} />
                <span className="mono grow">{m.name}</span>
                {price(m.priceIn, m.priceOut) && <span className="cx-muted">{price(m.priceIn, m.priceOut)}</span>}
                <span className="cx-muted tnum">{m.contextLen ? `${fmtTokens(m.contextLen)} ctx` : 'context unknown'}</span>
              </label>
            ))}
          </div>
          <div className="cx-form-row end">
            <Seg value={asRole} onChange={setAsRole} label="Server use" options={[['inference', 'For clients'], ['guard', 'Guard models only']]} />
            <input className="cx-input" style={{ width: 220 }} aria-label="Server name" placeholder="Server name" value={name} onChange={(e) => setName(e.target.value)} />
            <button type="button" className="cx-btn pri" disabled={busy || !name.trim()} onClick={save}>
              Save server
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function ServerNew() {
  return (
    <Page icon="servers" title="Add a server" sub="Paste a vLLM or OpenAI-compatible address. GuardRail lists the models it serves.">
      <AddServer />
    </Page>
  );
}

// ---------------------------------------------------------------- /servers/:id

export function ServerEditor({ id }: { id: number }) {
  const { data, error } = useStore();
  const act = useActions();
  const ui = useUi();
  const [limit, setLimit] = useState<Partial<LimitView> | null>(null);
  const [q, setQ] = useState('');
  const s = data?.servers.find((x) => x.id === id);
  const [form, setForm] = useState<{ name: string; url: string; key: string; role: 'inference' | 'guard' } | null>(null);
  const f = form ?? (s ? { name: s.name, url: s.url, key: '', role: s.role } : null);
  const dirty = !!s && !!f && (f.name !== s.name || f.url !== s.url || f.key !== '' || f.role !== s.role);
  const models = useMemo(() => (s?.models ?? []).filter((m) => !q || m.name.toLowerCase().includes(q.toLowerCase())), [s, q]);
  if (!data) return <Loading error={error} />;
  if (!s || !f) return <Empty icon="servers" title="This server was removed" />;
  const serverRule = data.limits.find((l) => l.scope === 'server' && l.server_id === s.id);
  const save = async () => {
    if (await ui.run(() => api(`servers/${s.id}`, { method: 'PATCH', body: { name: f.name, url: f.url, role: f.role, ...(f.key ? { apiKey: f.key } : {}) } }), `${f.name} saved`)) setForm(null);
  };
  return (
    <Page
      icon="servers"
      title={s.name}
      sub={<span className="mono">{s.url}</span>}
      actions={
        <>
          {statusPill(s)}
          <button type="button" className="cx-btn" onClick={() => void act.rediscover(s)}>
            <Ico n="refresh" size={14} /> Rediscover
          </button>
          <button type="button" className="cx-btn danger" onClick={() => void act.deleteServer(s)}>
            <Ico n="trash" size={14} /> Remove
          </button>
        </>
      }
    >
      {s.status === 'down' && s.last_error && <Note tone="bad">{s.last_error}</Note>}
      <div className="cx-stats wide">
        <Stat label="Latency" value={ms(s.latency_ms)} />
        <Stat label="Models on" value={`${s.models.filter((m) => m.enabled).length} / ${s.models.length}`} />
        <Stat label="Prefix cache hit" value={s.cache_hit_rate == null ? '–' : `${Math.round(s.cache_hit_rate * 100)}%`} />
        <Stat label="Last checked" value={ago(s.last_checked)} />
      </div>

      <Section title="Connection">
        <form
          className="cx-form"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="cx-form-row">
            <Field label="Name">
              <input className="cx-input" value={f.name} onChange={(e) => setForm({ ...f, name: e.target.value })} />
            </Field>
            <Field label="Address" grow>
              <input className="cx-input mono" value={f.url} onChange={(e) => setForm({ ...f, url: e.target.value })} />
            </Field>
          </div>
          <div className="cx-form-row">
            <Field label={s.hasKey ? 'New API key (empty keeps the current one)' : 'API key (optional)'} grow>
              <input className="cx-input mono" {...secretProps} name="gr-upstream-secret" value={f.key} onChange={(e) => setForm({ ...f, key: e.target.value })} />
            </Field>
            <Field label="Used for">
              <Seg value={f.role} onChange={(role) => setForm({ ...f, role })} label="Used for" options={[['inference', 'Client models'], ['guard', 'Guard models only']]} />
            </Field>
          </div>
          <div className="cx-form-row end">
            {dirty && (
              <button type="button" className="cx-btn" onClick={() => setForm(null)}>
                Discard
              </button>
            )}
            <button type="submit" className="cx-btn pri" disabled={!dirty}>
              Save connection
            </button>
          </div>
        </form>
      </Section>

      <Section
        title={`Models · ${s.models.length}`}
        hint={s.role === 'guard' ? 'Guard servers are never offered to clients; the Guard checks page picks which model to use.' : 'Turn a model on to offer it to clients. Groups then decide who may use it.'}
        actions={
          <>
            <input className="cx-input sm" type="search" placeholder="Filter models" aria-label="Filter models" value={q} onChange={(e) => setQ(e.target.value)} />
            {s.role === 'inference' && (
              <>
                <button type="button" className="cx-btn sm" onClick={() => void act.setAllModels(s, true)}>
                  All on
                </button>
                <button type="button" className="cx-btn sm" onClick={() => void act.setAllModels(s, false)}>
                  All off
                </button>
                <button type="button" className="cx-btn sm" onClick={() => setLimit(serverRule ?? { scope: 'server', server_id: s.id })}>
                  {serverRule ? 'Server limit' : 'Add server limit'}
                </button>
              </>
            )}
          </>
        }
      >
        {s.models.length === 0 ? (
          <Note>No models found. Click Rediscover once the server is up.</Note>
        ) : (
          <div className="cx-table-wrap">
            <table className="cx-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Context</th>
                  <th>Price</th>
                  <th>{s.role === 'guard' ? 'Used for' : 'Groups that can use it'}</th>
                  <th>Limit</th>
                  <th>{s.role === 'guard' ? '' : 'Clients'}</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => {
                  const rule = data.limits.find((l) => l.scope === 'model' && l.server_id === s.id && l.model_name === m.name);
                  const groups = data.access[m.id] ?? [];
                  return (
                    <tr key={m.id} className={m.enabled ? '' : 'dim'}>
                      <td className="mono">
                        {m.name} {!m.present && <Pill tone="bad">Gone from server</Pill>}
                      </td>
                      <td className="tnum">{m.context_len ? fmtTokens(m.context_len) : '–'}</td>
                      <td className="cx-muted">{price(m.price_in, m.price_out) ?? '–'}</td>
                      <td>{s.role === 'guard' ? <span className="cx-muted">Guard checks</span> : m.enabled ? groups.join(', ') || <span className="cx-muted">No group allows it yet</span> : <span className="cx-muted">Hidden from clients</span>}</td>
                      <td>
                        {s.role === 'inference' && (
                          <button type="button" className={`cx-pill btn ${rule ? 'info' : ''}`} onClick={() => setLimit(rule ?? { scope: 'model', server_id: s.id, model_name: m.name })}>
                            {rule ? describe(rule, data) : serverRule ? 'Server limit' : 'Add'}
                          </button>
                        )}
                      </td>
                      <td>{s.role === 'inference' && <Switch on={!!m.enabled} label={`Let clients use ${m.name}`} onChange={(v) => void act.toggleModel(m.id, v)} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {limit && <LimitDialog init={limit} data={data} onClose={() => setLimit(null)} />}
    </Page>
  );
}

