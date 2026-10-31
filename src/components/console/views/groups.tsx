'use client';

import { useEffect, useState } from 'react';
import { display } from '@/components/format-setting';
import { useActions } from '../actions';
import { Ico } from '../icons';
import { Empty, Field, GroupSelect, Loading, Note, Page, Pill, Section, Seg, Stat, Switch, fmtTokens } from '../kit';
import { pathFor, subtree, useNav } from '../nav';
import { api, useStore } from '../store';
import type { Data, GroupC, Resolution, SettingKey } from '../types';
import { useItemTab } from '../prefs';
import { SaveState, useAutoSave, useQuietSave } from '../autosave';
import { layerState, useLayerToggle } from './guard';
import { type GuardLayer, adapterFor } from '@/lib/layers';
import type { LayerOpt } from '@/lib/groups';

type StoredSetting = { mode: 'set' | 'add' | 'override'; value: unknown };

// ---------------------------------------------------------------- /groups

export function GroupsHome() {
  const { data, error } = useStore();
  const nav = useNav();
  const act = useActions();
  const [name, setName] = useState('');
  const [parent, setParent] = useState<number | null>(null);
  if (!data) return <Loading error={error} />;
  const root = data.groups.find((g) => g.parentId === null);
  return (
    <Page icon="groups" title="Groups" sub="Keys live in groups. A sub-group gets everything from its parent, then adds or replaces what it needs.">
      <Section title="New group">
        <form
          className="cx-form-row"
          onSubmit={async (e) => {
            e.preventDefault();
            const g = await act.createGroup(name.trim(), parent ?? root?.id ?? null);
            if (g) {
              setName('');
              nav.go(pathFor('groups', g.id));
            }
          }}
        >
          <Field label="Name" grow>
            <input className="cx-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Frontend team" />
          </Field>
          <Field label="Inside">
            <GroupSelect groups={data.groups} value={parent ?? root?.id ?? null} onChange={setParent} />
          </Field>
          <button type="submit" className="cx-btn pri tall" disabled={!name.trim()}>
            Create group
          </button>
        </form>
      </Section>
      <Section title={`All groups · ${data.groups.length}`} hint="Double-click a group in the sidebar to rename it (or press F2). Drag one onto another to move it.">
        <div className="cx-table-wrap">
          <table className="cx-table">
            <thead>
              <tr>
                <th>Group</th>
                <th>Keys</th>
                <th>Sub-groups</th>
                <th>Own context</th>
                <th>Overrides</th>
              </tr>
            </thead>
            <tbody>
              {data.groups.map((g) => (
                <tr key={g.id} className="click" onClick={() => nav.go(pathFor('groups', g.id))}>
                  <td style={{ paddingLeft: 10 + g.depth * 16 }}>
                    <span className="cx-inline-ico folder">
                      <Ico n="folder" size={14} />
                    </span>
                    <b>{g.name}</b>
                    {g.description && <span className="cx-muted"> · {g.description}</span>}
                  </td>
                  <td className="tnum">{g.keyCount}</td>
                  <td className="tnum">{g.childCount}</td>
                  <td className="tnum">{g.own.length}</td>
                  <td>{Object.keys(g.settings).length ? Object.keys(g.settings).length : <span className="cx-muted">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </Page>
  );
}

// ---------------------------------------------------------------- /groups/:id

type Tab = 'eff' | 'access' | 'ctx' | 'guard' | 'keys';

export function GroupEditor({ id }: { id: number }) {
  const { data, error } = useStore();
  const nav = useNav();
  const act = useActions();
  const [res, setRes] = useState<{ chain: { id: number; name: string }[]; resolution: Resolution } | null>(null);
  const [tab, setTab] = useItemTab<Tab>('group', id, 'eff');
  const g = data?.groups.find((x) => x.id === id);
  const sig = g ? JSON.stringify([g.name, g.settings, g.parentId, data?.settings.guard, data?.groups.length]) : '';
  useEffect(() => {
    let live = true;
    api<{ chain: { id: number; name: string }[]; resolution: Resolution }>(`groups/${id}`).then(
      (r) => live && setRes(r),
      () => live && setRes(null),
    );
    return () => {
      live = false;
    };
  }, [id, sig]);

  if (!data) return <Loading error={error} />;
  if (!g) return <Empty icon="groups" title="This group was deleted" />;
  const isRoot = g.parentId === null;
  const save = (key: SettingKey, setting: StoredSetting | null, ok?: string) => act.saveSetting(g, key, setting, ok);

  return (
    <Page
      scrollKey={tab}
      pinned={
      <div className="cx-subtabs" role="tablist" aria-label="Group settings">
          {(
            [
              ['eff', 'Effective rules'],
              ['access', 'Servers and models'],
              ['ctx', `Context (${g.context.length})`],
              ['guard', 'Guard layers and limits'],
              ['keys', `Keys (${g.keyCount})`],
            ] as [Tab, string][]
          ).map(([t, l]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {l}
            </button>
          ))}
        </div>
      }
      icon="folder"
      title={g.name}
      sub={g.path}
      actions={
        <>
          <button type="button" className="cx-btn" onClick={() => nav.go(`/keys/new?group=${g.id}`)}>
            <Ico n="key" size={14} /> New key here
          </button>
          <button type="button" className="cx-btn" onClick={() => nav.go(`/activity?group=${g.id}`)}>
            <Ico n="activity" size={14} /> Activity
          </button>
          {!isRoot && (
            <button type="button" className="cx-btn danger" onClick={() => void act.deleteGroup(g)}>
              <Ico n="trash" size={14} /> Delete
            </button>
          )}
        </>
      }
    >
      <GroupDetails g={g} data={data} />
      {res && (
        <div className="cx-chain" aria-label="Inherits from">
          <span className="cx-muted">Inherits from</span>
          {res.chain.map((c, i) => (
            <span key={c.id} className="cx-chain-step">
              <button type="button" className={`cx-chip ${c.id === g.id ? 'on' : ''}`} onClick={() => nav.go(pathFor('groups', c.id))}>
                {c.name}
              </button>
              {i < res.chain.length - 1 && <Ico n="chevron" size={12} />}
            </span>
          ))}
        </div>
      )}
      {!res ? (
        <Loading />
      ) : (
        <>
          {tab === 'eff' && <Effective g={g} res={res} data={data} />}
          {tab === 'access' && <Access g={g} res={res} data={data} save={save} />}
          {tab === 'ctx' && <Context g={g} res={res} data={data} save={save} />}
          {tab === 'guard' && <Guard g={g} res={res} data={data} />}
          {tab === 'keys' && <Keys g={g} data={data} />}
        </>
      )}
    </Page>
  );
}

function GroupDetails({ g, data }: { g: GroupC; data: Data }) {
  const act = useActions();
  const [name, setName] = useState(g.name);
  const [desc, setDesc] = useState(g.description);
  const [parent, setParent] = useState(g.parentId);
  useEffect(() => {
    setName(g.name);
    setDesc(g.description);
    setParent(g.parentId);
  }, [g.name, g.description, g.parentId]);
  const dirty = name !== g.name || desc !== g.description || parent !== g.parentId;
  const blocked = subtree(g.id, data.groups);
  const quiet = useQuietSave();
  // Name and description save themselves; moving the group under another stays a click on Save.
  const textDirty = name !== g.name || desc !== g.description;
  const sibling = data.groups.some((x) => x.parentId === g.parentId && x.id !== g.id && x.name.toLowerCase() === name.trim().toLowerCase());
  const auto = useAutoSave({
    value: [name, desc],
    dirty: textDirty,
    invalid: !name.trim() ? 'Give the group a name.' : sibling ? `A group named "${name.trim()}" is already here.` : null,
    save: () => quiet(() => api(`groups/${g.id}`, { method: 'PATCH', body: { name, description: desc } })),
  });
  return (
    <form
      className="cx-form-row"
      onSubmit={(e) => {
        e.preventDefault();
        void act.updateGroup(g, { name, description: desc, ...(g.parentId !== null && parent !== null ? { parentId: parent } : {}) });
      }}
    >
      <Field label="Name">
        <input className="cx-input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description" grow>
        <input className="cx-input" value={desc} placeholder={g.parentId === null ? 'The root group. Every key inherits these rules.' : 'What this group is for'} onChange={(e) => setDesc(e.target.value)} />
      </Field>
      {g.parentId !== null && (
        <Field label="Inside">
          <GroupSelect groups={data.groups} value={parent} onChange={(v) => v && setParent(v)} exclude={blocked} />
        </Field>
      )}
      <button type="submit" className={`cx-btn tall ${parent !== g.parentId || !auto.auto ? 'pri' : ''}`} disabled={!dirty || !name.trim()}>
        {parent !== g.parentId ? 'Move' : 'Save'}
      </button>
      <SaveState s={auto} />
    </form>
  );
}

const lookups = (data: Data) => ({ files: data.files, servers: data.servers.map((s) => ({ id: s.id, name: s.name })), layers: data.settings.guard.layers });

function effValue(key: SettingKey, r: Resolution): unknown {
  const e = r.effective;
  if (key === 'blocked_reply') return e.blocked_reply.split('\n')[0];
  return e[key as keyof typeof e];
}

function Effective({ g, res, data }: { g: GroupC; res: { chain: { id: number; name: string }[]; resolution: Resolution }; data: Data }) {
  const TAG = { inherited: 'inherited', set: 'set', add: 'adds', override: 'replaces' } as const;
  const L = lookups(data);
  return (
    <div className="cx-table-wrap">
      <table className="cx-table cx-matrix">
        <thead>
          <tr>
            <th>Setting</th>
            {res.chain.map((c) => (
              <th key={c.id}>{c.name}</th>
            ))}
            <th className="mx-res">What keys in {g.name} get</th>
          </tr>
        </thead>
        <tbody>
          {res.resolution.matrix.map((row) => (
            <tr key={row.key}>
              <td>
                <b>{row.label}</b>
              </td>
              {row.cells.map((c, i) => (
                <td key={i} className={`mx-cell ${c.state}`}>
                  <span className="mx-tag">{TAG[c.state]}</span>
                  {c.state === 'inherited' ? <span className="cx-muted">{i === 0 ? 'Default' : 'Same as parent'}</span> : (c.state === 'add' ? '+ ' : '') + display(row.key, c.value as never, L)}
                </td>
              ))}
              <td className="mx-res">
                <b>{display(row.key, effValue(row.key, res.resolution) as never, L)}</b>
                <div className="cx-muted small">From {res.resolution.sources[row.key].join(' + ')}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModeBar({ g, stored, what, onMode }: { g: GroupC; stored: StoredSetting | undefined; what: string; onMode: (m: 'inherit' | 'add' | 'override') => void }) {
  if (g.parentId === null) return null;
  const cur = !stored ? 'inherit' : stored.mode === 'add' ? 'add' : 'override';
  return (
    <div className="cx-form-row center">
      <span className="cx-muted">{what}:</span>
      <Seg value={cur} onChange={onMode} label={what} options={[['inherit', 'Same as parent'], ['add', 'Add to parent'], ['override', 'Replace']]} />
    </div>
  );
}

type Save = (key: SettingKey, s: StoredSetting | null, ok?: string) => Promise<unknown>;
type Res = { chain: { id: number; name: string }[]; resolution: Resolution };

function Access({ g, res, data, save }: { g: GroupC; res: Res; data: Data; save: Save }) {
  const isRoot = g.parentId === null;
  const own = g.settings as Record<string, StoredSetting | undefined>;
  const eff = res.resolution.effective;
  const ownModels = (own.models?.value as string[] | undefined) ?? [];
  const mode = isRoot ? 'set' : own.models ? own.models.mode : 'inherit';
  const all = eff.models.includes('*');
  const [q, setQ] = useState('');
  const src = (m: string) => {
    let from = 'Not allowed';
    res.chain.forEach((c, i) => {
      const cell = res.resolution.matrix.find((r) => r.key === 'models')!.cells[i];
      if (cell.state === 'inherited') return;
      const v = (cell.value as string[]) ?? [];
      if (cell.state !== 'add') from = v.includes(m) || v.includes('*') ? (c.id === g.id ? 'Set here' : `From ${c.name}`) : 'Not allowed';
      else if (v.includes(m) || v.includes('*')) from = c.id === g.id ? 'Added here' : `From ${c.name}`;
    });
    return from;
  };
  const toggle = (m: string, on: boolean) => {
    const base = mode === 'inherit' ? 'add' : mode;
    const next = on ? [...ownModels, m] : ownModels.filter((x) => x !== m);
    void save('models', { mode: base as StoredSetting['mode'], value: next }, on ? `${m === '*' ? 'All models' : m} allowed` : `${m === '*' ? 'All models' : m} removed`);
  };
  const ownServers = (own.servers?.value as number[] | null | undefined) ?? null;
  const inference = data.servers;
  const models = data.models.filter((m) => !q || m.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <Section title="Models" hint={`Which models keys in ${g.name} can call. A model must also be turned on for clients on its server.`} actions={<input className="cx-input sm" type="search" placeholder="Filter models" aria-label="Filter models" value={q} onChange={(e) => setQ(e.target.value)} />}>
        <ModeBar g={g} stored={own.models} what="Models" onMode={(m) => void save('models', m === 'inherit' ? null : { mode: m, value: m === 'override' ? eff.models : ownModels })} />
        <div className="cx-table-wrap">
          <table className="cx-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Servers</th>
                <th>Comes from</th>
                <th>Allowed</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <b>All models, including ones added later</b>
                </td>
                <td className="cx-muted">Every server</td>
                <td>{all ? <Pill>{src('*')}</Pill> : <Pill>Off</Pill>}</td>
                <td>
                  <Switch on={all} label="Allow all models" disabled={mode === 'add' && all && !ownModels.includes('*')} onChange={(v) => toggle('*', v)} />
                </td>
              </tr>
              {data.models.length === 0 && (
                <tr>
                  <td colSpan={4} className="cx-muted">
                    No models turned on yet. Turn some on in Servers.
                  </td>
                </tr>
              )}
              {models.map((m) => {
                const on = all || eff.models.includes(m);
                const s = src(m);
                const inherited = on && !s.endsWith('here');
                return (
                  <tr key={m}>
                    <td className="mono">{m}</td>
                    <td className="cx-muted">{data.modelServers[m]?.join(', ')}</td>
                    <td>
                      <Pill tone={s.endsWith('here') ? 'info' : ''}>{all && !eff.models.includes(m) ? 'Via All models' : s}</Pill>
                    </td>
                    <td>
                      <Switch on={on} label={`Allow ${m}`} disabled={(inherited && mode !== 'override' && mode !== 'set') || (all && !eff.models.includes(m))} onChange={(v) => toggle(m, v)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Servers" hint={`Keys in ${g.name} reach: ${display('servers', eff.servers, lookups(data))}.`}>
        <Seg
          value={own.servers ? 'only' : 'same'}
          label="Servers"
          onChange={(v) => void save('servers', v === 'same' ? (isRoot ? { mode: 'set', value: null } : null) : { mode: 'override', value: inference.map((s) => s.id) })}
          options={[
            ['same', isRoot ? 'All servers' : 'Same as parent'],
            ['only', 'Only these servers'],
          ]}
        />
        {own.servers && ownServers !== null && (
          <div className="cx-checklist inline">
            {inference.map((s) => (
              <label key={s.id} className="cx-check">
                <input type="checkbox" checked={ownServers.includes(s.id)} onChange={(e) => void save('servers', { mode: 'override', value: e.target.checked ? [...ownServers, s.id] : ownServers.filter((x) => x !== s.id) })} />
                {s.name}
              </label>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function Context({ g, res, data, save }: { g: GroupC; res: Res; data: Data; save: Save }) {
  const nav = useNav();
  const isRoot = g.parentId === null;
  const own = g.settings.context as StoredSetting | undefined;
  const ownIds = (own?.value as number[] | undefined) ?? [];
  const eff = res.resolution.effective.context;
  const [add, setAdd] = useState('');
  const mode = isRoot ? 'set' : own ? own.mode : 'inherit';
  const srcOf = (fid: number) => {
    if (ownIds.includes(fid)) return 'Added here';
    for (let i = res.chain.length - 2; i >= 0; i--) {
      const cell = res.resolution.matrix.find((r) => r.key === 'context')!.cells[i];
      if (cell.state !== 'inherited' && ((cell.value as number[]) ?? []).includes(fid)) return `From ${res.chain[i].name}`;
    }
    return 'Inherited';
  };
  const setOwn = (ids: number[]) => save('context', { mode: (mode === 'inherit' ? 'add' : mode) as StoredSetting['mode'], value: ids });
  const move = (fid: number, d: -1 | 1) => {
    const i = ownIds.indexOf(fid);
    const j = i + d;
    if (i < 0 || j < 0 || j >= ownIds.length) return;
    const n = [...ownIds];
    [n[i], n[j]] = [n[j], n[i]];
    void setOwn(n);
  };
  const tokens = eff.reduce((a, fid) => a + (data.files.find((f) => f.id === fid)?.tokens ?? 0), 0);
  return (
    <Section title="Context files" hint={`Added to every request from ${g.name}, in this order; inherited files come first. ${tokens.toLocaleString()} tokens in total.`}>
      <ModeBar g={g} stored={own} what="Context files" onMode={(m) => void save('context', m === 'inherit' ? null : { mode: m, value: m === 'override' ? eff : ownIds })} />
      <div className="cx-list">
        {eff.length === 0 && <div className="cx-list-row cx-muted">No context files yet.</div>}
        {eff.map((fid) => {
          const f = data.files.find((x) => x.id === fid);
          const mine = ownIds.includes(fid);
          return (
            <div key={fid} className="cx-list-row">
              <span className="cx-inline-ico md">
                <Ico n="file" size={14} />
              </span>
              <button type="button" className="cx-link grow mono" onClick={() => nav.go(pathFor('context', fid))}>
                {f?.name ?? 'Deleted file'}
              </button>
              <span className="cx-muted tnum">{fmtTokens(f?.tokens)} tok</span>
              <Pill tone={mine ? 'info' : ''}>{srcOf(fid)}</Pill>
              {mine && (
                <span className="cx-row-btns">
                  <button type="button" className="cx-icon-btn" aria-label="Move up" onClick={() => move(fid, -1)}>
                    <Ico n="back" size={14} />
                  </button>
                  <button type="button" className="cx-icon-btn" aria-label="Move down" onClick={() => move(fid, 1)}>
                    <Ico n="forward" size={14} />
                  </button>
                  <button type="button" className="cx-icon-btn" aria-label={`Remove ${f?.name}`} onClick={() => void setOwn(ownIds.filter((x) => x !== fid))}>
                    <Ico n="close" size={14} />
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="cx-form-row">
        <select className="cx-input" style={{ width: 280 }} value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Context file to add">
          <option value="">Pick a file to add…</option>
          {data.files
            .filter((f) => !eff.includes(f.id))
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
        </select>
        <button type="button" className="cx-btn" disabled={!add} onClick={() => (void setOwn([...ownIds, Number(add)]), setAdd(''))}>
          Add
        </button>
      </div>
    </Section>
  );
}

function Guard({ g, res, data }: { g: GroupC; res: Res; data: Data }) {
  const nav = useNav();
  const eff = res.resolution.effective;
  const src = res.resolution.sources;
  const st = g.settings as Record<string, StoredSetting | undefined>;
  const layers = data.settings.guard.layers;
  const own = (st.layer_opts?.value ?? {}) as Record<string, LayerOpt>;
  const [reply, setReply] = useState(String(st.blocked_reply?.value ?? ''));
  const [rate, setRate] = useState(String(st.rate_limit?.value ?? ''));
  useEffect(() => {
    setReply(String(st.blocked_reply?.value ?? ''));
    setRate(String(st.rate_limit?.value ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g.id, JSON.stringify(g.settings)]);
  const onCount = layers.filter((l) => layerState(l, g, data.groups).on).length;
  const quiet = useQuietSave();
  const putSetting = (key: string, setting: unknown) => quiet(() => api(`groups/${g.id}/settings`, { method: 'PUT', body: { key, setting } }));
  const replyAuto = useAutoSave({
    value: reply,
    dirty: reply !== String(st.blocked_reply?.value ?? ''),
    save: () => putSetting('blocked_reply', reply.trim() ? { mode: 'override', value: reply } : null),
  });
  const rateAuto = useAutoSave({
    value: rate,
    dirty: rate !== String(st.rate_limit?.value ?? ''),
    invalid: rate !== '' && !(Number(rate) >= 1) ? 'Use a whole number of 1 or more, or leave it empty.' : null,
    save: () => putSetting('rate_limit', rate ? { mode: 'override', value: Number(rate) } : null),
  });
  // Save this group's own settings for one layer, keeping its settings for the others.
  const saveOpt = (layer: GuardLayer, patch: LayerOpt) => {
    const next = { ...own, [layer.id]: { ...own[layer.id], ...patch } };
    const o = next[layer.id];
    if (o.threshold == null) delete o.threshold;
    if (!o.prompt?.trim()) delete o.prompt;
    if (!Object.keys(o).length) delete next[layer.id];
    return putSetting('layer_opts', Object.keys(next).length || g.parentId === null ? { mode: g.parentId === null ? 'set' : 'override', value: next } : null);
  };
  return (
    <>
      <Section title="Guard layers" hint={<>In pipeline order. Each layer can be on or off for {g.name} and its sub-groups, and some take a group setting of their own. Add or edit layers in <button type="button" className="cx-link" onClick={() => nav.go('/guard')}>Guard checks</button>.</>}>
        {layers.length === 0 ? (
          <Note>
            No guard layers yet. Add one in{' '}
            <button type="button" className="cx-link" onClick={() => nav.go('/guard')}>
              Guard checks
            </button>
            .
          </Note>
        ) : (
          <div className="cx-list">
            {layers.map((l, i) => (
              <GroupLayerRow key={l.id} n={i + 1} layer={l} g={g} data={data} eff={eff} own={own[l.id]} saveOpt={saveOpt} />
            ))}
          </div>
        )}
        {layers.length > 0 && onCount === 0 && <Note tone="bad">Every guard layer is off for {g.name}. Its requests go straight to the model unscreened.</Note>}
      </Section>
      <div className="cx-stats wide">
        <Stat label="Layers on" value={layers.length ? `${onCount} of ${layers.length}` : '–'} />
        <Stat label="Rate limit" value={`${eff.rate_limit}/min`} hint={`From ${src.rate_limit.join(' + ')}`} />
        <Stat label="Layer settings changed" value={Object.keys(eff.layer_opts).length} hint="Layers whose threshold or prompt this group or a parent changed" />
      </div>
      <div className="cx-form-row">
        <Section title="Blocked reply">
          <textarea className="cx-input" rows={4} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={`Empty uses the inherited reply. Use {reason} and {request_id}.`} />
          <div className="cx-form-row end">
            <SaveState s={replyAuto} />
            <button type="button" className="cx-btn" disabled={reply === String(st.blocked_reply?.value ?? '')} onClick={() => void replyAuto.flush()}>
              Save reply
            </button>
          </div>
        </Section>
        <Section title="Rate limit">
          <Field label="Requests per minute, per key" hint={`Empty uses the inherited ${eff.rate_limit}.`}>
            <input className="cx-input" type="number" min={1} value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
          <div className="cx-form-row end">
            <SaveState s={rateAuto} />
            <button type="button" className="cx-btn" disabled={rate === String(st.rate_limit?.value ?? '')} onClick={() => void rateAuto.flush()}>
              Save limit
            </button>
          </div>
        </Section>
      </div>
    </>
  );
}

/** One guard layer on a group's page: on/off for the group, plus the settings its type takes. */
function GroupLayerRow({ n, layer, g, data, eff, own, saveOpt }: { n: number; layer: GuardLayer; g: GroupC; data: Data; eff: Resolution['effective']; own?: LayerOpt; saveOpt: (l: GuardLayer, p: LayerOpt) => Promise<unknown> }) {
  const nav = useNav();
  const toggle = useLayerToggle();
  const ls = layerState(layer, g, data.groups);
  const scoring = layer.type === 'classifier' || layer.type === 'patterns';
  // Lines a group adds go into the layer's system prompt, or a decision model's policy.
  const mrow = data.servers.find((x) => x.id === layer.serverId)?.models.find((m) => m.name === layer.model);
  const fmt = adapterFor(layer, mrow ? { api: mrow.api ?? null, structured: !!mrow.structured } : null);
  const judge = layer.type === 'judge' || fmt === 'decisions';
  const target = fmt === 'decisions' ? 'policy' : 'prompt';
  const opt = eff.layer_opts[layer.id];
  const [t, setT] = useState(own?.threshold != null ? String(own.threshold) : '');
  const [lines, setLines] = useState(own?.prompt ?? '');
  useEffect(() => {
    setT(own?.threshold != null ? String(own.threshold) : '');
    setLines(own?.prompt ?? '');
  }, [own?.threshold, own?.prompt]);
  // What applies without this group's own value: a parent's, else the layer's.
  const parentT = opt?.thresholdFrom && opt.thresholdFrom !== g.name ? opt.threshold : null;
  const inheritedT = parentT ?? layer.threshold;
  const inheritedLines = (opt?.prompt_parts ?? []).filter((p) => p.from !== g.name);
  const tAuto = useAutoSave({
    value: t,
    dirty: t !== (own?.threshold != null ? String(own.threshold) : ''),
    invalid: t !== '' && !(Number(t) > 0 && Number(t) < 1) ? 'Use a number between 0 and 1, or leave it empty.' : null,
    save: () => saveOpt(layer, { threshold: t === '' ? null : Number(t) }),
  });
  const linesAuto = useAutoSave({ value: lines, dirty: lines !== (own?.prompt ?? ''), save: () => saveOpt(layer, { prompt: lines }) });
  return (
    <div className="cx-list-row tall cx-glayer">
      <span className="cx-layer-n">{n}</span>
      <div className="grow">
        <div className="cx-form-row center nowrap">
          <div className="grow">
            <button type="button" className="cx-link" onClick={() => nav.go(`/guard/${layer.id}`)}>
              <b>{layer.name}</b>
            </button>{' '}
            <span className="cx-muted small">{layer.type}</span>
            <div className="small">
              <Pill tone={ls.on ? 'ok' : 'warn'}>{ls.on ? 'On' : 'Off'}</Pill> <span className="cx-muted">from {ls.from}</span>
            </div>
          </div>
          <Seg
            value={ls.own === null ? 'inherit' : ls.own ? 'on' : 'off'}
            label={`${layer.name} for ${g.name}`}
            onChange={(v) => void toggle(g, layer, v)}
            options={[
              ['inherit', g.parentId === null ? 'Layer default' : 'Same as parent'],
              ['on', 'On'],
              ['off', 'Off (bypass)'],
            ]}
          />
        </div>
        {scoring && (
          <div className="cx-form-row center">
            <Field label={`${layer.name} flags at`} hint={`Empty uses ${inheritedT.toFixed(2)}${parentT != null ? ` from ${opt!.thresholdFrom}` : ' (the layer’s own)'}. Lower catches more.`}>
              <input className="cx-input" type="number" min={0.05} max={0.99} step={0.05} value={t} placeholder={inheritedT.toFixed(2)} onChange={(e) => setT(e.target.value)} />
            </Field>
            <SaveState s={tAuto} />
            <button type="button" className="cx-btn" disabled={t === (own?.threshold != null ? String(own.threshold) : '')} onClick={() => void tAuto.flush()}>
              Save
            </button>
          </div>
        )}
        {judge && (
          <>
            {inheritedLines.length > 0 && <pre className="cx-pre small">{inheritedLines.map((p) => `# from ${p.from}\n${p.text}`).join('\n\n')}</pre>}
            <Field label={`Lines ${g.name} adds to ${layer.name}’s ${target}`}>
              <textarea className="cx-input mono" rows={3} value={lines} onChange={(e) => setLines(e.target.value)} placeholder="For example: Files in tests/fixtures contain fake secrets on purpose." />
            </Field>
            <div className="cx-form-row end">
              <SaveState s={linesAuto} />
              <button type="button" className="cx-btn" disabled={lines === (own?.prompt ?? '')} onClick={() => void linesAuto.flush()}>
                Save prompt lines
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Keys({ g, data }: { g: GroupC; data: Data }) {
  const nav = useNav();
  const act = useActions();
  const keys = data.keys.filter((k) => k.groupId === g.id);
  return (
    <Section title={`Keys in ${g.name}`} actions={<button type="button" className="cx-btn" onClick={() => nav.go(`/keys/new?group=${g.id}`)}><Ico n="plus" size={14} /> New key</button>}>
      {keys.length === 0 ? (
        <Note>No keys in this group yet.</Note>
      ) : (
        <div className="cx-list">
          {keys.map((k) => (
            <div key={k.id} className={`cx-list-row ${k.revoked ? 'dim' : ''}`}>
              <span className="cx-inline-ico key">
                <Ico n="key" size={14} />
              </span>
              <button type="button" className="cx-link grow" onClick={() => nav.go(pathFor('keys', k.id))}>
                {k.name}
              </button>
              <span className="cx-muted">{k.owner}</span>
              <span className="mono cx-muted">{k.prefix}…</span>
              {Object.keys(k.exceptions).length > 0 && <Pill tone="info">{Object.keys(k.exceptions).length} exception(s)</Pill>}
              <Switch on={!k.revoked} label={k.revoked ? `Restore ${k.name}` : `Revoke ${k.name}`} onChange={(v) => void act.revokeKey(k, !v)} />
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
