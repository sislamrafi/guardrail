'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { display } from '@/components/format-setting';
import { useActions } from '../actions';
import { SaveState, useAutoSave, useQuietSave } from '../autosave';
import { Ico } from '../icons';
import { Empty, Field, GroupSelect, Loading, Note, Page, Pill, Section, Stat, Switch, ago, fmt } from '../kit';
import { pathFor, subtree, useNav } from '../nav';
import { api, useStore, useUi } from '../store';
import type { Data, GroupSettings, KeyC, Resolution } from '../types';
import { KeyMcpSection } from './docs';

const lookups = (data: Data) => ({ docs: data.docs, files: data.files, servers: data.servers.map((s) => ({ id: s.id, name: s.name })), layers: data.settings.guard.layers });

function excText(e: GroupSettings, data: Data) {
  const L = lookups(data);
  const parts: string[] = [];
  if (e.context) parts.push(`+ ${display('context', e.context.value, L)}`);
  if (e.models) parts.push(`+ ${display('models', e.models.value, L)}`);
  if (e.rate_limit) parts.push(`${e.rate_limit.value}/min`);
  return parts.join(', ');
}

/** Which guard layers run for this key's group, in order, with any threshold a group changed. */
function guardText(e: Resolution['effective'], data: Data) {
  const layers = data.settings.guard.layers;
  if (!layers.length) return 'No guard layers yet';
  const on = layers.filter((l) => (l.id in e.layers ? e.layers[l.id] : l.enabled));
  if (!on.length) return <b>All off (bypassed)</b>;
  return on.map((l) => `${l.name}${e.layer_opts[l.id]?.threshold != null ? ` at ${e.layer_opts[l.id].threshold!.toFixed(2)}` : ''}`).join(' → ');
}

const status = (k: KeyC) => {
  const expired = !!k.expiresAt && k.expiresAt < Date.now();
  return k.revoked ? <Pill tone="bad">Revoked</Pill> : expired ? <Pill tone="warn">Expired</Pill> : <Pill tone="ok">Active</Pill>;
};

// ---------------------------------------------------------------- /keys

export function KeysHome() {
  const { data, error } = useStore();
  const nav = useNav();
  const act = useActions();
  const [q, setQ] = useState('');
  if (!data) return <Loading error={error} />;
  const scope = nav.group && data.groups.find((g) => g.id === nav.group)?.parentId !== null ? subtree(nav.group, data.groups) : null;
  const rows = data.keys.filter((k) => (!scope || scope.has(k.groupId)) && (!q || `${k.name} ${k.owner} ${k.groupName} ${k.prefix}`.toLowerCase().includes(q.toLowerCase())));
  const group = scope ? data.groups.find((g) => g.id === nav.group) : null;
  return (
    <Page
      icon="keys"
      title={group ? `API keys · ${group.name}` : 'API keys'}
      sub="Each key belongs to one person or bot and one group, so every request can be traced back to them."
      actions={
        <>
          <input className="cx-input sm" type="search" placeholder="Search person, key or group" aria-label="Search keys" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="button" className="cx-btn pri" onClick={() => nav.go(`/keys/new${nav.group ? `?group=${nav.group}` : ''}`)}>
            <Ico n="plus" size={14} /> New key
          </button>
        </>
      }
    >
      {data.keys.length === 0 ? (
        <Empty icon="keys" title="No keys yet">
          <button type="button" className="cx-link" onClick={() => nav.go('/keys/new')}>Create the first key</button> and point a client at <span className="mono">/v1</span>.
        </Empty>
      ) : rows.length === 0 ? (
        <Note>No key matches{group ? ` in ${group.name}` : ''}.</Note>
      ) : (
        <div className="cx-table-wrap">
          <table className="cx-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Person or bot</th>
                <th>Group</th>
                <th>Exceptions</th>
                <th>Last used</th>
                <th>Today</th>
                <th>Status</th>
                <th>Active</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k.id} className={`click ${k.revoked ? 'dim' : ''}`} onClick={() => nav.go(pathFor('keys', k.id))}>
                  <td>
                    <b>{k.name}</b>
                    <div className="mono cx-muted">{k.prefix}…</div>
                  </td>
                  <td>{k.owner}</td>
                  <td>
                    <Pill tone="info" title={k.groupPath}>
                      {k.groupName}
                    </Pill>
                  </td>
                  <td className="cx-muted">{excText(k.exceptions, data) || '–'}</td>
                  <td className="cx-muted">{ago(k.lastUsedAt)}</td>
                  <td className="tnum">{fmt(k.requestsToday)}</td>
                  <td>
                    {status(k)} {k.ipAllow.length > 0 && <Pill tone="info" title={k.ipAllow.join(', ')}>IP-bound</Pill>}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Switch on={!k.revoked} label={k.revoked ? `Restore ${k.name}` : `Revoke ${k.name}`} onChange={(v) => void act.revokeKey(k, !v)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------- shared form pieces

/** Same settings, whatever the key order. */
const canon = (e: GroupSettings) => JSON.stringify(Object.fromEntries(Object.entries(e).sort(([a], [b]) => a.localeCompare(b))));

function useExceptions(init: GroupSettings = {}) {
  const [ctx, setCtx] = useState<number[]>((init.context?.value as number[]) ?? []);
  const [models, setModels] = useState<string[]>((init.models?.value as string[]) ?? []);
  const [rate, setRate] = useState<string>(init.rate_limit ? String(init.rate_limit.value) : '');
  // Panels elsewhere (Context, Guard, MCP) also change a key's exceptions: follow the saved values.
  const sig = JSON.stringify(init);
  useEffect(() => {
    setCtx((init.context?.value as number[]) ?? []);
    setModels((init.models?.value as string[]) ?? []);
    setRate(init.rate_limit ? String(init.rate_limit.value) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const value: GroupSettings = {};
  if (ctx.length || init.context?.mode === 'override') value.context = { mode: init.context?.mode === 'override' ? 'override' : 'add', value: ctx };
  if (models.length) value.models = { mode: 'add', value: models };
  if (rate) value.rate_limit = { mode: 'override', value: Number(rate) };
  return { ctx, setCtx, models, setModels, rate, setRate, value };
}

function Exceptions({ ex, data }: { ex: ReturnType<typeof useExceptions>; data: Data }) {
  const [adding, setAdding] = useState<'ctx' | 'model' | 'rate' | null>(null);
  const [pick, setPick] = useState('');
  return (
    <div className="cx-list">
      {ex.ctx.map((id) => (
        <div className="cx-list-row" key={`c${id}`}>
          <Pill tone="warn">Adds</Pill>
          <span className="grow">
            Context file <span className="mono">{data.files.find((f) => f.id === id)?.name}</span>
          </span>
          <button type="button" className="cx-btn sm" onClick={() => ex.setCtx(ex.ctx.filter((x) => x !== id))}>
            Remove
          </button>
        </div>
      ))}
      {ex.models.map((m) => (
        <div className="cx-list-row" key={`m${m}`}>
          <Pill tone="warn">Adds</Pill>
          <span className="grow">
            Model <span className="mono">{m}</span>
          </span>
          <button type="button" className="cx-btn sm" onClick={() => ex.setModels(ex.models.filter((x) => x !== m))}>
            Remove
          </button>
        </div>
      ))}
      {ex.rate && adding !== 'rate' && (
        <div className="cx-list-row">
          <Pill tone="warn">Replaces</Pill>
          <span className="grow">Rate limit {ex.rate} per minute</span>
          <button type="button" className="cx-btn sm" onClick={() => ex.setRate('')}>
            Remove
          </button>
        </div>
      )}
      {adding ? (
        <div className="cx-list-row">
          {adding === 'rate' ? (
            <input className="cx-input" style={{ width: 200 }} type="number" min={1} placeholder="Requests per minute" aria-label="Requests per minute" value={pick} onChange={(e) => setPick(e.target.value)} autoFocus />
          ) : (
            <select className="cx-input" style={{ width: 280 }} value={pick} onChange={(e) => setPick(e.target.value)} aria-label={adding === 'ctx' ? 'Context file' : 'Model'} autoFocus>
              <option value="">Pick…</option>
              {adding === 'ctx'
                ? data.files
                    .filter((f) => !ex.ctx.includes(f.id))
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))
                : data.models
                    .filter((m) => !ex.models.includes(m))
                    .map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
            </select>
          )}
          <button
            type="button"
            className="cx-btn"
            disabled={!pick}
            onClick={() => {
              if (adding === 'ctx') ex.setCtx([...ex.ctx, Number(pick)]);
              else if (adding === 'model') ex.setModels([...ex.models, pick]);
              else ex.setRate(pick);
              setAdding(null);
              setPick('');
            }}
          >
            Add
          </button>
          <button type="button" className="cx-btn" onClick={() => (setAdding(null), setPick(''))}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="cx-form-row">
          <button type="button" className="cx-btn sm dash" onClick={() => setAdding('ctx')}>
            + Extra context file
          </button>
          <button type="button" className="cx-btn sm dash" onClick={() => setAdding('model')}>
            + Extra model
          </button>
          <button type="button" className="cx-btn sm dash" onClick={() => setAdding('rate')}>
            + Different rate limit
          </button>
        </div>
      )}
    </div>
  );
}

function Preview({ groupId, exceptions, data, caller }: { groupId: number; exceptions: GroupSettings; data: Data; caller?: string }) {
  const [r, setR] = useState<Resolution | null>(null);
  const key = JSON.stringify(exceptions);
  useEffect(() => {
    let live = true;
    api<Resolution>('keys/preview', { body: { groupId, exceptions: JSON.parse(key) } }).then(
      (x) => live && setR(x),
      () => live && setR(null),
    );
    return () => {
      live = false;
    };
  }, [groupId, key]);
  const e = r?.effective;
  const L = lookups(data);
  const g = data.groups.find((x) => x.id === groupId);
  return (
    <aside className="cx-preview" aria-label="What this key gets">
      <h3>This key gets</h3>
      <p className="cx-muted small">Everything from {g?.path}{Object.keys(exceptions).length ? ', plus its exceptions' : ''}.</p>
      {!e ? (
        <Loading />
      ) : (
        <dl>
          <dt>Servers</dt>
          <dd>{display('servers', e.servers, L)}</dd>
          <dt>Models</dt>
          <dd className="mono">{display('models', e.models, L)}</dd>
          <dt>Context</dt>
          <dd className="mono">{display('context', e.context, L)}</dd>
          <dt>Caller line</dt>
          <dd className="mono">{caller || 'off'}</dd>
          <dt>Guard layers</dt>
          <dd>{guardText(e, data)}</dd>
          <dt>Rate limit</dt>
          <dd>{e.rate_limit} per minute</dd>
          <dt>MCP docs</dt>
          <dd className="mono">{display('mcp_docs', e.mcp_docs ?? [], L)}</dd>
        </dl>
      )}
    </aside>
  );
}

const toDate = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 10) : '');
const fromDate = (s: string) => (s ? new Date(s + 'T23:59:59').getTime() : null);

// ---------------------------------------------------------------- /keys/new

export function KeyNew() {
  const { data, error, reload } = useStore();
  const nav = useNav();
  const ui = useUi();
  const params = useSearchParams();
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState<number | null>(null);
  const [expires, setExpires] = useState('');
  const [ips, setIps] = useState('');
  const ex = useExceptions();
  const [made, setMade] = useState<{ secret: string; id: number; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return <Loading error={error} />;
  const want = Number(params.get('group') ?? nav.group) || null;
  const gid = groupId ?? (want && data.groups.some((g) => g.id === want) ? want : (data.groups.find((g) => g.parentId !== null) ?? data.groups[0])?.id) ?? null;
  const base = typeof window === 'undefined' ? '/v1' : `${window.location.origin}/v1`;

  const create = async () => {
    setBusy(true);
    await ui.run(
      async () => {
        const r = await api<{ secret: string; key: KeyC }>('keys', { body: { owner, name, groupId: gid, exceptions: ex.value, expiresAt: fromDate(expires), ipAllow: ips } });
        setMade({ secret: r.secret, id: r.key.id, name: r.key.name });
        setName('');
      },
      'Key created',
      { reload: false },
    );
    setBusy(false);
    void reload();
  };

  return (
    <Page icon="keys" title="New API key" sub="The key is shown once. GuardRail stores only its hash.">
      {made && (
        <div className="cx-secret-box" role="status">
          <div className="cx-form-row center">
            <Ico n="check" size={16} />
            <b>{made.name} is ready. Copy it now: it will not be shown again.</b>
          </div>
          <div className="cx-form-row center">
            <code className="cx-secret">{made.secret}</code>
            <button type="button" className="cx-btn pri" onClick={() => navigator.clipboard.writeText(made.secret).then(() => ui.toast('Key copied'), () => ui.toast('Copy blocked: select the key and copy it', true))}>
              <Ico n="copy" size={14} /> Copy
            </button>
          </div>
          <p className="cx-muted small">
            In Cline or Claude Code pick OpenAI Compatible, set the base URL to <span className="mono">{base}</span> and paste this key.
          </p>
          <div className="cx-form-row">
            <button type="button" className="cx-btn" onClick={() => nav.go(pathFor('keys', made.id))}>
              Open the key
            </button>
            <button type="button" className="cx-btn" onClick={() => setMade(null)}>
              Create another
            </button>
          </div>
        </div>
      )}
      {!made && (
        <div className="cx-split">
          <form
            className="cx-form grow"
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <div className="cx-form-row">
              <Field label="Who is it for" grow>
                <input className="cx-input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="rafi" autoFocus />
              </Field>
              <Field label="Key name" grow>
                <input className="cx-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="rafi-laptop-cline" />
              </Field>
            </div>
            <div className="cx-form-row">
              <Field label="Group" grow>
                <GroupSelect groups={data.groups} value={gid} onChange={setGroupId} />
              </Field>
              <Field label="Expiry date (optional)">
                <input className="cx-input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
              </Field>
            </div>
            <Field label="Allowed IPs (optional)" hint="One IP or CIDR range per line or comma, e.g. 10.0.0.0/8. Empty allows any address; others get a 403.">
              <textarea className="cx-input mono" rows={2} value={ips} onChange={(e) => setIps(e.target.value)} placeholder="203.0.113.10, 10.0.0.0/8" />
            </Field>
            <Field label="Exceptions for this key only (optional)">
              <Exceptions ex={ex} data={data} />
            </Field>
            <div className="cx-form-row end">
              <button type="submit" className="cx-btn pri" disabled={busy || !owner.trim() || !name.trim() || !gid}>
                Create key
              </button>
            </div>
          </form>
          {gid && <Preview groupId={gid} exceptions={ex.value} data={data} caller={owner.trim() && name.trim() ? `Request from: ${owner.trim()} (API key: ${name.trim()})` : owner.trim() ? `Request from: ${owner.trim()}` : name.trim() ? `Request from API key: ${name.trim()}` : 'on (fill in the name and person)'} />}
        </div>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------- /keys/:id

export function KeyEditor({ id }: { id: number }) {
  const { data, error } = useStore();
  const k = data?.keys.find((x) => x.id === id);
  if (!data) return <Loading error={error} />;
  if (!k) return <Empty icon="keys" title="This key was deleted" />;
  return <KeyForm key={`${k.id}:${k.groupId}:${JSON.stringify(k.exceptions)}`} k={k} data={data} />;
}

function KeyForm({ k, data }: { k: KeyC; data: Data }) {
  const act = useActions();
  const ui = useUi();
  const nav = useNav();
  const [name, setName] = useState(k.name);
  const [owner, setOwner] = useState(k.owner);
  const [groupId, setGroupId] = useState(k.groupId);
  const [expires, setExpires] = useState(toDate(k.expiresAt));
  const [ips, setIps] = useState(k.ipAllow.join(', '));
  const ex = useExceptions(k.exceptions);
  // Layer switches and MCP docs for this key are edited in their own panels (and saved at once): keep them.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { context: _c, models: _m, rate_limit: _r, ...kept } = k.exceptions;
  const exAll = { ...kept, ...ex.value };
  const dirty = name !== k.name || owner !== k.owner || groupId !== k.groupId || expires !== toDate(k.expiresAt) || canon(exAll) !== canon(k.exceptions) || ips !== k.ipAllow.join(', ');
  const save = () => ui.run(() => api(`keys/${k.id}`, { method: 'PATCH', body: { name, owner, groupId, exceptions: exAll, expiresAt: fromDate(expires), ipAllow: ips } }), `${name} saved`);
  // Name and owner save themselves. Group, expiry, IPs and exceptions change what the key can do: Save.
  const quiet = useQuietSave();
  const auto = useAutoSave({
    value: [name, owner],
    dirty: name !== k.name || owner !== k.owner,
    invalid: !name.trim() ? 'Give the key a name.' : !owner.trim() ? 'Say who uses this key.' : null,
    save: () => quiet(() => api(`keys/${k.id}`, { method: 'PATCH', body: { name, owner } })),
  });
  const accessDirty = groupId !== k.groupId || expires !== toDate(k.expiresAt) || canon(exAll) !== canon(k.exceptions) || ips !== k.ipAllow.join(', ');
  return (
    <Page
      icon="key"
      title={
        <>
          {k.name} {status(k)}
        </>
      }
      sub={
        <>
          <span className="mono">{k.prefix}…</span> · {k.owner} · {k.groupPath}
        </>
      }
      actions={
        <>
          <button type="button" className="cx-btn" onClick={() => nav.go(`/activity?group=${k.groupId}`)}>
            <Ico n="activity" size={14} /> Activity
          </button>
          <button type="button" className="cx-btn" onClick={() => void act.revokeKey(k)}>
            {k.revoked ? 'Restore' : 'Revoke'}
          </button>
          <button type="button" className="cx-btn danger" onClick={() => void act.deleteKey(k)}>
            <Ico n="trash" size={14} /> Delete
          </button>
        </>
      }
    >
      <SecretBox k={k} weak={data.summary.weakSecret} />
      <div className="cx-stats wide">
        <Stat label="Requests today" value={fmt(k.requestsToday)} />
        <Stat label="Last used" value={ago(k.lastUsedAt)} />
        <Stat label="Created" value={new Date(k.createdAt).toLocaleDateString()} />
        <Stat label="Expires" value={k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : 'Never'} tone={k.expiresAt && k.expiresAt < Date.now() ? 'warn' : undefined} />
      </div>
      <div className="cx-split">
        <form
          className="cx-form grow"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Section title="Key">
            <div className="cx-form-row">
              <Field label="Key name" grow>
                <input className="cx-input" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Person or bot" grow>
                <input className="cx-input" value={owner} onChange={(e) => setOwner(e.target.value)} />
              </Field>
            </div>
            <div className="cx-form-row">
              <Field label="Group" grow>
                <GroupSelect groups={data.groups} value={groupId} onChange={(v) => v && setGroupId(v)} />
              </Field>
              <Field label="Expiry date">
                <input className="cx-input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
              </Field>
            </div>
          </Section>
          <IdentitySection k={k} name={name} owner={owner} />
          <KeyMcpSection k={k} />
          <Section title="Allowed IPs" hint="Requests from any other address are rejected with a 403. Empty allows any address.">
            <textarea className="cx-input mono" rows={2} value={ips} onChange={(e) => setIps(e.target.value)} placeholder="203.0.113.10, 10.0.0.0/8" aria-label="Allowed IPs" />
          </Section>
          <Section title="Exceptions for this key only">
            <Exceptions ex={ex} data={data} />
          </Section>
          <div className="cx-form-row end center">
            <SaveState s={auto} />
            <button type="submit" className={`cx-btn ${accessDirty || !auto.auto ? 'pri' : ''}`} disabled={!dirty || !name.trim() || !owner.trim()}>
              {accessDirty ? 'Save access changes' : 'Save key'}
            </button>
          </div>
        </form>
        <Preview groupId={groupId} exceptions={exAll} data={data} caller={(() => { const i = k.identity ?? { key: true, owner: true }; const w = i.owner ? owner.trim() : ''; const n = i.key ? name.trim() : ''; return w && n ? `Request from: ${w} (API key: ${n})` : w ? `Request from: ${w}` : n ? `Request from API key: ${n}` : ''; })()} />
      </div>
    </Page>
  );
}

function SecretBox({ k, weak }: { k: KeyC; weak: boolean }) {
  const ui = useUi();
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reveal = async () => {
    if (secret) return setSecret(null);
    setBusy(true);
    await ui.run(async () => setSecret((await api<{ secret: string }>(`keys/${k.id}/secret`)).secret), undefined, { reload: false });
    setBusy(false);
  };
  const copy = async () => {
    let s = secret;
    if (!s) {
      try {
        s = (await api<{ secret: string }>(`keys/${k.id}/secret`)).secret;
      } catch (e) {
        return ui.toast((e as Error).message, true);
      }
    }
    navigator.clipboard.writeText(s).then(
      () => ui.toast('Key copied'),
      () => {
        setSecret(s);
        ui.toast('Copy blocked: the key is shown, select it and copy', true);
      },
    );
  };
  const rotate = async () => {
    const ok = await ui.confirm({ title: `Rotate the key ${k.name}?`, body: 'A new secret replaces the current one. Clients using the old secret stop working right away.', ok: 'Rotate key', danger: true });
    if (!ok) return;
    await ui.run(async () => {
      const r = await api<{ secret: string }>(`keys/${k.id}/rotate`, { body: {} });
      setSecret(r.secret);
    }, 'Key rotated. Update your clients with the new secret.');
  };
  return (
    <Section title="Secret">
      {weak && <Note tone="warn">GUARDRAIL_SECRET is still the default &quot;change-me&quot;, so stored secrets are only weakly protected. Set a long random GUARDRAIL_SECRET (or GUARDRAIL_KEY_SECRET) in .env, then rotate your keys.</Note>}
      {k.canReveal ? (
        <div className="cx-form-row center">
          <code className="cx-secret">{secret ?? `${k.prefix}${'•'.repeat(30)}`}</code>
          <button type="button" className="cx-btn" disabled={busy} onClick={() => void reveal()}>
            {secret ? 'Hide' : 'Reveal'}
          </button>
          <button type="button" className="cx-btn pri" onClick={() => void copy()}>
            <Ico n="copy" size={14} /> Copy
          </button>
          <button type="button" className="cx-btn" onClick={() => void rotate()}>
            <Ico n="refresh" size={14} /> Rotate
          </button>
        </div>
      ) : (
        <div className="cx-form-row center">
          <code className="cx-secret">{secret ?? `${k.prefix}…`}</code>
          {secret ? (
            <button type="button" className="cx-btn pri" onClick={() => void copy()}>
              <Ico n="copy" size={14} /> Copy
            </button>
          ) : (
            <span className="cx-muted small">Created before reveal was available. Rotate to get a secret you can view.</span>
          )}
          <button type="button" className="cx-btn" onClick={() => void rotate()}>
            <Ico n="refresh" size={14} /> Rotate
          </button>
        </div>
      )}
    </Section>
  );
}

/** Whether this key tells the model who is calling. Saved on click, like a switch. */
function IdentitySection({ k, name, owner }: { k: KeyC; name: string; owner: string }) {
  const ui = useUi();
  const id = k.identity ?? { key: true, owner: true };
  const set = (patch: Partial<KeyC['identity']>) => {
    const next = { ...id, ...patch };
    void ui.run(() => api(`keys/${k.id}`, { method: 'PATCH', body: { identity: next } }), next.key || next.owner ? 'Caller line updated' : 'The model is no longer told who is calling');
  };
  const who = id.owner && owner.trim() ? owner.trim() : '';
  const kn = id.key && name.trim() ? name.trim() : '';
  const line = who && kn ? `Request from: ${who} (API key: ${kn})` : who ? `Request from: ${who}` : kn ? `Request from API key: ${kn}` : '';
  return (
    <Section title="Tell the model who is calling" hint="Put one short line first in the context of every request from this key, before the context files and policy. It never contains the secret, and it stays the same on every request, so prompt caching still works.">
      <div className="cx-form-row center">
        <label className="cx-check">
          <input type="checkbox" checked={id.owner} onChange={(e) => set({ owner: e.target.checked })} /> Person or bot ({owner || '–'})
        </label>
        <label className="cx-check">
          <input type="checkbox" checked={id.key} onChange={(e) => set({ key: e.target.checked })} /> Key name ({name || '–'})
        </label>
      </div>
      {line ? <pre className="cx-pre small">{line}</pre> : <span className="cx-muted small">Off: nothing about the caller is added.</span>}
    </Section>
  );
}
