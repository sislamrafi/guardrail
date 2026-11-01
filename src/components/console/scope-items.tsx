'use client';

import { type ReactNode, useRef, useState } from 'react';
import { useActions } from './actions';
import { Ico, type IconName } from './icons';
import { Switch } from './kit';
import { useNav } from './nav';
import { usePref } from './prefs';
import { api, useUi } from './store';
import { setTreeDrag } from './tree';
import type { Data, GroupC, KeyC } from './types';

// The right panel for Context files and MCP docs, for the group or key picked on the left:
//   a scope line (name and path), two tabs (what is active for it / everything) with an on/off switch
//   on every row, and a small footer with counts that can be hidden.

export type Kind = 'context' | 'mcp_docs';
type Item = { id: number; name: string; meta: string; title: string };
export type Status = { kind: 'own' | 'key' | 'inherited' | 'off'; from?: GroupC };

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

/** Short source tag: Own, Key, ↳ dev, Off here. */
export function SourceTag({ st }: { st?: Status }) {
  if (!st) return null;
  const [text, cls, title] =
    st.kind === 'own' ? ['Own', 'own', 'Set on this group'] : st.kind === 'key' ? ['Key', 'key', 'Set on this key only'] : st.kind === 'off' ? ['Off here', 'off', 'Inherited, switched off here'] : [`↳ ${st.from?.name ?? 'parent'}`, '', st.from ? `Inherited from ${st.from.path}` : 'Inherited'];
  return (
    <span className={`cx-src ${cls}`} title={title}>
      {text}
    </span>
  );
}

/** Scope line at the top of a right panel: icon, name, and the group path. */
export function ScopeLine({ g, keyRow, title }: { g: GroupC; keyRow: KeyC | null; title?: string }) {
  return (
    <div className="cx-scope-line" title={title}>
      <b>
        <Ico n={keyRow ? 'key' : 'folder'} size={14} /> {keyRow ? keyRow.name : g.name}
      </b>
      <span>{keyRow ? `${g.path.replace(/ › /g, ' > ')} > ${keyRow.name}` : g.path.replace(/ › /g, ' > ')}</span>
    </div>
  );
}

/** Tabs right under the scope line, remembered per section. */
export function ScopeTabs<T extends string>({ id, tabs, children }: { id: string; tabs: [T, string][]; children: (tab: T) => ReactNode }) {
  const [tab, setTab] = usePref<T>(`panel.tab.${id}`, tabs[0][0]);
  const cur = tabs.some(([t]) => t === tab) ? tab : tabs[0][0];
  return (
    <>
      <div className="cx-ptabs" role="tablist">
        {tabs.map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={cur === t} className={cur === t ? 'on' : ''} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      <div className="cx-ptab-body">{children(cur)}</div>
    </>
  );
}

/** A small footer with counts (and extras), hideable. */
export function ScopeFooter({ id, text, children }: { id: string; text: string; children?: ReactNode }) {
  const [open, setOpen] = usePref(`panel.foot.${id}`, true);
  return (
    <div className={`cx-pfoot ${open ? '' : 'closed'}`}>
      <button type="button" className="cx-pfoot-head" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? 'Hide' : 'Show'}>
        <Ico n="chevron" size={11} /> <span>{text}</span>
      </button>
      {open && children && <div className="cx-pfoot-body">{children}</div>}
    </div>
  );
}

/** Small icon buttons for a tab header. */
export function ToolBtn({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button type="button" className="cx-tool" title={label} aria-label={label} onClick={onClick}>
      <Ico n={icon} size={14} />
    </button>
  );
}

export function ScopeItems({ data, kind, g, keyRow, items, open, noun, footer, footerExtra }: { data: Data; kind: Kind; g: GroupC; keyRow: KeyC | null; items: Item[]; open: (id: number) => void; noun: { one: string; many: string }; footer: string; footerExtra?: ReactNode }) {
  const act = useActions();
  const ui = useUi();
  const nav = useNav();
  const [q, setQ] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  const { list, off } = scopeItems(data, kind, g, keyRow);
  const who = keyRow ? keyRow.name : g.name;
  const scope = { group: g, key: keyRow };
  const status = new Map<number, Status>([...list.map((x) => [x.id, x.st] as const), ...off.map((id) => [id, { kind: 'off' } as Status] as const)]);

  const add = (id: number) => (kind === 'context' ? (keyRow ? act.setKeyFile(keyRow, id, true) : act.attach(id, g.id)) : keyRow ? act.setKeyDoc(keyRow, id, true) : act.shareDoc(id, g.id));
  const remove = (id: number) => (kind === 'context' ? (keyRow ? act.setKeyFile(keyRow, id, false) : act.detach(id, g.id)) : keyRow ? act.setKeyDoc(keyRow, id, false) : act.unshareDoc(id, g.id));
  /** One switch for every row: own/key items are added or removed; inherited ones are switched off here (or back on). */
  const flip = (id: number, on: boolean) => {
    const st = status.get(id);
    if (on) return st?.kind === 'off' ? act.setOff(kind, id, false, scope) : add(id);
    if (st?.kind === 'own' || st?.kind === 'key') return remove(id);
    if (st?.kind === 'inherited') return act.setOff(kind, id, true, scope);
  };
  const create = () => (kind === 'context' ? act.createFile('new-file', g.id, keyRow) : act.createDoc('New doc', keyRow ? null : g.id, undefined, keyRow));
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

  const row = (it: Item | undefined) => {
    if (!it) return null;
    const st = status.get(it.id);
    const on = !!st && st.kind !== 'off';
    // The root has nothing inherited to switch off.
    const locked = st?.kind === 'inherited' && !keyRow && g.parentId === null;
    return (
      <div
        key={it.id}
        className={`cx-prow ${nav.id === String(it.id) ? 'on' : ''} ${on ? '' : 'dim'}`}
        draggable
        title={`${it.title}. Drag onto a group or key on the left to add it there.`}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', it.name);
          setTreeDrag(`${kind === 'context' ? 'file' : 'doc'}:${it.id}`);
        }}
        onDragEnd={() => setTreeDrag(null)}
      >
        <Ico n="file" size={13} />
        <button type="button" className="cx-prow-name" onClick={() => open(it.id)}>
          {it.name}
        </button>
        <SourceTag st={st} />
        <Switch on={on} disabled={locked} label={`${it.name} ${on ? 'on' : 'off'} for ${who}`} onChange={(v) => void flip(it.id, v)} />
      </div>
    );
  };
  const byId = (id: number) => items.find((x) => x.id === id);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const lib = items.filter((it) => words.every((w) => `${it.name} ${it.title}`.toLowerCase().includes(w)));
  const tools = (
    <div className="cx-ptools">
      <ToolBtn icon="newFile" label={`New ${noun.one} for ${who}`} onClick={() => void create()} />
      <ToolBtn icon="upload" label={`Upload .md for ${who}`} onClick={() => upload.current?.click()} />
      <input ref={upload} type="file" accept=".md,.markdown,.txt" multiple hidden onChange={(e) => e.target.files && void uploadFiles(e.target.files).then(() => (e.target.value = ''))} />
    </div>
  );
  return (
    <div className="cx-scope-panel">
      <ScopeLine g={g} keyRow={keyRow} />
      <ScopeTabs<'active' | 'all'>
        id={kind}
        tabs={[
          ['active', `Active (${list.length})`],
          ['all', `All (${items.length})`],
        ]}
      >
        {(tab) =>
          tab === 'active' ? (
            <>
              <div className="cx-ptab-head">
                <span>In effect for {who}, in order</span>
                {tools}
              </div>
              {list.length === 0 && off.length === 0 && <p className="cx-details-empty">Nothing yet. Switch {noun.many} on in All, or create one.</p>}
              {list.map((x) => row(byId(x.id)))}
              {off.map((id) => row(byId(id)))}
            </>
          ) : (
            <>
              <div className="cx-ptab-head">
                <input className="cx-input sm" type="search" placeholder={`Search ${noun.many}`} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${noun.many}`} />
                {tools}
              </div>
              {lib.map(row)}
              {lib.length === 0 && <p className="cx-details-empty">Nothing matches.</p>}
            </>
          )
        }
      </ScopeTabs>
      <ScopeFooter id={kind} text={footer}>
        {footerExtra}
      </ScopeFooter>
    </div>
  );
}
