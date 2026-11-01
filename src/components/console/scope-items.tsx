'use client';

import { useRef, useState } from 'react';
import { useActions } from './actions';
import { Ico } from './icons';
import { Pill, Switch } from './kit';
import { useNav } from './nav';
import { api, useUi } from './store';
import { setTreeDrag } from './tree';
import type { Data, GroupC, KeyC } from './types';

// The right panel's two parts for Context files and MCP docs, for the group or key picked on the left:
//   1. what applies to it, in order: own items, items from this key only, inherited ones (each can be
//      switched off here; sub-groups inherit that) and the ones switched off here (switch back on);
//   2. the library: every file or doc, to add to it (or drag onto a group or key in the tree).

export type Kind = 'context' | 'mcp_docs';
type Item = { id: number; name: string; meta: string; title: string };
type Status = { kind: 'own' | 'key' | 'inherited' | 'off'; from?: GroupC };

const chainUp = (g: GroupC, groups: GroupC[]) => {
  const out: GroupC[] = [];
  for (let x: GroupC | undefined = g; x; x = groups.find((p) => p.id === x!.parentId)) out.push(x);
  return out;
};
const ownOf = (g: GroupC, kind: Kind) => (kind === 'context' ? g.own : g.ownDocs);

/** What a group (or a key, on top of its group) gets, in order, with why; plus what it switched off. */
export function scopeItems(data: Data, kind: Kind, g: GroupC, key: KeyC | null): { list: { id: number; st: Status }[]; off: number[] } {
  const base = kind === 'context' ? g.context : g.docs;
  const chain = chainUp(g, data.groups);
  const s = key?.exceptions[kind];
  const mine = Array.isArray(s?.value) ? (s!.value as number[]) : [];
  const off = key ? (s?.exclude ?? []) : kind === 'context' ? g.ctxExclude : g.docsExclude;
  const ids = key ? (s?.mode === 'override' ? mine : [...base, ...mine.filter((id) => !base.includes(id))]).filter((id) => !off.includes(id)) : base;
  const list = ids.map((id) => {
    if (key && mine.includes(id) && !base.includes(id)) return { id, st: { kind: 'key' } as Status };
    const from = chain.find((x) => ownOf(x, kind).includes(id));
    return { id, st: (!key && from?.id === g.id ? { kind: 'own' } : { kind: 'inherited', from }) as Status };
  });
  return { list, off };
}

function StatusPill({ st }: { st: Status }) {
  if (st.kind === 'own') return <Pill tone="ok">Own</Pill>;
  if (st.kind === 'key') return <Pill tone="info">This key</Pill>;
  if (st.kind === 'off') return <Pill tone="warn">Off here</Pill>;
  return <Pill title={st.from ? `Inherited from ${st.from.path}` : 'Inherited'}>{st.from ? `via ${st.from.name}` : 'Inherited'}</Pill>;
}

export function ScopeItems({ data, kind, g, keyRow, items, open, noun }: { data: Data; kind: Kind; g: GroupC; keyRow: KeyC | null; items: Item[]; open: (id: number) => void; noun: { one: string; many: string } }) {
  const act = useActions();
  const ui = useUi();
  const nav = useNav();
  const [q, setQ] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  const { list, off } = scopeItems(data, kind, g, keyRow);
  const who = keyRow ? keyRow.name : g.name;
  const scope = { group: g, key: keyRow };
  const add = (id: number) =>
    kind === 'context' ? (keyRow ? act.setKeyFile(keyRow, id, true) : act.attach(id, g.id)) : keyRow ? act.setKeyDoc(keyRow, id, true) : act.shareDoc(id, g.id);
  const remove = (id: number) =>
    kind === 'context' ? (keyRow ? act.setKeyFile(keyRow, id, false) : act.detach(id, g.id)) : keyRow ? act.setKeyDoc(keyRow, id, false) : act.unshareDoc(id, g.id);
  const create = () => (kind === 'context' ? act.createFile('new-file', g.id, keyRow) : act.createDoc('New doc', keyRow ? null : g.id, undefined, keyRow));
  const byId = (id: number) => items.find((x) => x.id === id);
  const row = (id: number, st: Status) => {
    const it = byId(id);
    if (!it) return null;
    const canOff = st.kind === 'inherited' && (keyRow || g.parentId !== null);
    return (
      <div key={`${st.kind}-${id}`} className={`cx-li ${nav.id === String(id) ? 'on' : ''} ${st.kind === 'off' ? 'cx-dim' : ''}`}>
        <span className="cx-ico md">
          <Ico n="file" size={14} />
        </span>
        <button type="button" className="cx-label cx-link-plain" title={it.title} onClick={() => open(id)}>
          {it.name}
        </button>
        <StatusPill st={st} />
        {st.kind === 'own' || st.kind === 'key' ? (
          <button type="button" className="cx-row-act show" title={`Remove from ${who}`} aria-label={`Remove from ${who}`} onClick={() => void remove(id)}>
            <Ico n="unlink" size={14} />
          </button>
        ) : canOff || st.kind === 'off' ? (
          <Switch on={st.kind !== 'off'} label={st.kind === 'off' ? `Turn ${it.name} back on for ${who}` : `Turn ${it.name} off for ${who}`} onChange={(v) => void act.setOff(kind, id, !v, scope)} />
        ) : null}
      </div>
    );
  };
  const applied = new Set(list.map((x) => x.id));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const lib = items.filter((it) => words.every((w) => `${it.name} ${it.title}`.toLowerCase().includes(w)));
  const uploadFiles = async (files: FileList) => {
    await ui.run(async () => {
      for (const f of Array.from(files)) {
        if (!/\.(md|markdown|txt)$/i.test(f.name)) {
          ui.toast(`${f.name} is not a Markdown file, skipped`, true);
          continue;
        }
        const body = await f.text();
        if (kind === 'context') {
          const existing = data.files.find((x) => x.name === f.name);
          if (existing) await api(`context/${existing.id}`, { method: 'PATCH', body: { body } });
          else await act.createFile(f.name, g.id, keyRow, body);
        } else {
          const title = f.name.replace(/\.(md|markdown|txt)$/i, '');
          const existing = data.docs.find((x) => x.title === title);
          if (existing) await api(`docs/${existing.id}`, { method: 'PATCH', body: { body } });
          else await act.createDoc(title, keyRow ? null : g.id, body, keyRow);
        }
      }
    }, `Uploaded for ${who}`);
  };
  return (
    <>
      <div className="cx-details-sec">
        APPLIES TO {who.toUpperCase()} · {list.length}
      </div>
      {list.length === 0 && <p className="cx-details-empty">No {noun.many} yet. Add one from the library below, or create one.</p>}
      {list.map((x) => row(x.id, x.st))}
      {off.map((id) => row(id, { kind: 'off' }))}
      <div className="cx-attach">
        <button type="button" className="cx-btn sm pri" onClick={() => void create()}>
          <Ico n="newFile" size={13} /> New {noun.one}
        </button>
        <button type="button" className="cx-btn sm" onClick={() => upload.current?.click()}>
          <Ico n="upload" size={13} /> Upload .md
        </button>
        <input ref={upload} type="file" accept=".md,.markdown,.txt" multiple hidden onChange={(e) => e.target.files && void uploadFiles(e.target.files).then(() => (e.target.value = ''))} />
      </div>
      {list.some((x) => x.st.kind === 'inherited') && <p className="cx-details-empty">Switch an inherited {noun.one} off to leave it out for {who}{keyRow ? '' : ' and its sub-groups'}.</p>}

      <div className="cx-details-sec">
        ALL {noun.many.toUpperCase()} · {items.length}
      </div>
      <div className="cx-attach">
        <input className="cx-input sm" type="search" placeholder={`Search ${noun.many}`} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${noun.many}`} />
      </div>
      <div className="cx-lib">
        {lib.map((it) => {
          const isOn = applied.has(it.id);
          const isOff = off.includes(it.id);
          return (
            <div
              key={it.id}
              className="cx-li"
              draggable
              title={`${it.title}. Drag onto a group or key on the left to add it there.`}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', it.name);
                setTreeDrag(`${kind === 'context' ? 'file' : 'doc'}:${it.id}`);
              }}
              onDragEnd={() => setTreeDrag(null)}
            >
              <span className="cx-ico md">
                <Ico n="file" size={14} />
              </span>
              <button type="button" className="cx-label cx-link-plain" onClick={() => open(it.id)}>
                {it.name}
              </button>
              <span className="cx-meta">{it.meta}</span>
              {isOn ? (
                <Pill tone="ok">Added</Pill>
              ) : isOff ? (
                <Pill tone="warn">Off here</Pill>
              ) : (
                <button type="button" className="cx-btn sm" onClick={() => void add(it.id)}>
                  Add
                </button>
              )}
            </div>
          );
        })}
        {lib.length === 0 && <p className="cx-details-empty">Nothing matches.</p>}
      </div>
    </>
  );
}
