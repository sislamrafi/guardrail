'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/components/ui';
import { Ico, type IconName } from './icons';
import { renderMarkdown } from './md';

/* ---------- data shapes (as the admin API returns them) ---------- */

interface GroupV {
  id: number;
  name: string;
  parentId: number | null;
  description: string;
  path: string;
  depth: number;
  keyCount: number;
  childCount: number;
  context: number[]; // effective, after inheritance
  own: number[]; // set on this group
  mode: string | null;
  keys: string[];
}
interface FileV {
  id: number;
  name: string;
  body: string;
  version: number;
  updated_at: number;
  tokens: number;
  usedBy: string[];
  reach: number;
}
interface KeyV {
  id: number;
  name: string;
  owner: string;
  groupId: number;
  prefix: string;
  expiresAt: number | null;
  revoked: boolean;
  lastUsedAt: number | null;
  createdAt: number;
  groupPath: string;
  requestsToday: number;
}
interface ModelV {
  id: number;
  name: string;
  context_len: number | null;
  price_in: number | null;
  price_out: number | null;
  enabled: number;
  present: number;
}
interface ServerV {
  id: number;
  name: string;
  url: string;
  role: 'inference' | 'guard';
  status: 'online' | 'down' | 'unknown';
  latency_ms: number | null;
  last_error: string | null;
  cache_hit_rate: number | null;
  hasKey: boolean;
  models: ModelV[];
}
interface Summary {
  online: number;
  servers: number;
  groups: number;
  keys: number;
  guard: boolean;
  blockedToday: number;
  name: string;
  authEnabled: boolean;
}
interface LogRow {
  id: string;
  ts: number;
  key_name: string | null;
  group_id: number | null;
  group_name: string | null;
  model: string | null;
  server: string | null;
  outcome: string;
  c1_score: number | null;
  c2_reason: string | null;
  total_ms?: number | null;
}
interface Resolution {
  effective: Record<string, unknown>;
}

type View = 'overview' | 'activity' | 'guard' | 'servers' | 'groups' | 'keys' | 'context' | 'studio' | 'account' | 'settings';
type Tab = { id: string; kind: 'file' | 'key' | 'server' | 'log'; ref: number | string; title: string };

const TOP: { view: View; icon: IconName; label: string }[] = [
  { view: 'overview', icon: 'overview', label: 'Overview' },
  { view: 'activity', icon: 'activity', label: 'Activity' },
  { view: 'guard', icon: 'guard', label: 'Guard checks' },
  { view: 'servers', icon: 'servers', label: 'Servers' },
  { view: 'groups', icon: 'groups', label: 'Groups' },
  { view: 'keys', icon: 'keys', label: 'API keys' },
  { view: 'context', icon: 'context', label: 'Context files' },
];
const BOTTOM: { view: View; icon: IconName; label: string }[] = [
  { view: 'studio', icon: 'studio', label: 'Studio (test requests)' },
  { view: 'account', icon: 'account', label: 'Account' },
  { view: 'settings', icon: 'settings', label: 'Settings' },
];
const LABEL: Record<View, string> = Object.fromEntries([...TOP, ...BOTTOM].map((a) => [a.view, a.label])) as Record<View, string>;

const ago = (t: number | null | undefined) => {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const pct = (r: number | null | undefined) => (r == null ? '–' : `${Math.round(r * 100)}%`);

/* ---------- the workbench ---------- */

export function Workbench() {
  const [view, setView] = useState<View>('context');
  const [sideOpen, setSideOpen] = useState(true);
  const [auxOpen, setAuxOpen] = useState(true);
  const [sideW, setSideW] = useState(300);
  const [auxW, setAuxW] = useState(300);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [groups, setGroups] = useState<GroupV[]>([]);
  const [files, setFiles] = useState<FileV[]>([]);
  const [keys, setKeys] = useState<KeyV[]>([]);
  const [servers, setServers] = useState<ServerV[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [sel, setSel] = useState<number | null>(null); // selected group
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null); // null = the view's home page
  const [buffers, setBuffers] = useState<Record<number, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [quick, setQuick] = useState(false);

  const flash = useCallback((t: string) => {
    setToast(t);
    window.setTimeout(() => setToast(null), 2200);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [s, c, k, sv] = await Promise.all([
        api<Summary>('summary'),
        api<{ files: FileV[]; groups: GroupV[] }>('context'),
        api<{ keys: KeyV[] }>('keys'),
        api<{ servers: ServerV[] }>('servers'),
      ]);
      setSummary(s);
      setGroups(c.groups);
      setFiles(c.files);
      setKeys(k.keys);
      setServers(sv.servers);
      setLoadErr(null);
      setLoaded(true);
      setSel((cur) => cur ?? c.groups[0]?.id ?? null);
      setOpen((cur) => (cur.size ? cur : new Set(c.groups.filter((g) => g.depth === 0).map((g) => g.id))));
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const group = groups.find((g) => g.id === sel) ?? null;

  const openTab = (t: Tab) => {
    setTabs((cur) => (cur.some((x) => x.id === t.id) ? cur : [...cur, t]));
    setActive(t.id);
  };
  const closeTab = (id: string) => {
    setTabs((cur) => {
      const i = cur.findIndex((t) => t.id === id);
      const next = cur.filter((t) => t.id !== id);
      if (active === id) setActive(next[Math.min(i, next.length - 1)]?.id ?? null);
      return next;
    });
  };
  const openFile = (f: FileV) => openTab({ id: `file:${f.id}`, kind: 'file', ref: f.id, title: f.name });

  const pickView = (v: View) => {
    if (v === view && sideOpen) setSideOpen(false);
    else {
      setView(v);
      setSideOpen(true);
    }
    setActive(null);
  };

  // Keyboard: ⌘B side bar, ⌘⌥B details, ⌘P quick open, ⌘W close tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'b' && e.altKey) {
        e.preventDefault();
        setAuxOpen((o) => !o);
      } else if (k === 'b') {
        e.preventDefault();
        setSideOpen((o) => !o);
      } else if (k === 'p') {
        e.preventDefault();
        setQuick(true);
      } else if (k === 'w' && active) {
        e.preventDefault();
        closeTab(active);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const activeTab = tabs.find((t) => t.id === active) ?? null;
  const dirtyIds = useMemo(() => new Set(Object.entries(buffers).filter(([id, text]) => files.find((f) => f.id === Number(id))?.body !== text).map(([id]) => Number(id))), [buffers, files]);

  const saveFile = async (id: number) => {
    const text = buffers[id];
    if (text === undefined) return;
    try {
      await api(`context/${id}`, { method: 'PATCH', body: { body: text } });
      setFiles((cur) => cur.map((f) => (f.id === id ? { ...f, body: text, tokens: Math.ceil(text.length / 4), updated_at: Date.now() } : f)));
      flash('Saved');
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Could not save');
    }
  };

  return (
    <div className="wb" style={{ ['--side-w' as string]: `${sideW}px`, ['--aux-w' as string]: `${auxW}px` }}>
      <TitleBar
        summary={summary}
        onQuick={() => setQuick(true)}
        onBlocked={() => {
          setView('activity');
          setSideOpen(true);
          setActive(null);
          setSel(groups[0]?.id ?? null);
        }}
        sideOpen={sideOpen}
        auxOpen={auxOpen}
        toggleSide={() => setSideOpen((o) => !o)}
        toggleAux={() => setAuxOpen((o) => !o)}
        title={activeTab ? activeTab.title : `${LABEL[view]}${group ? ` · ${group.name}` : ''}`}
      />
      <div className="wb-main">
        <nav className="wb-activity" aria-label="Views">
          <div className="wb-act-group">
            {TOP.map((a) => (
              <ActBtn key={a.view} a={a} on={view === a.view && sideOpen} onClick={() => pickView(a.view)} />
            ))}
          </div>
          <div className="wb-act-group">
            {BOTTOM.map((a) => (
              <ActBtn key={a.view} a={a} on={view === a.view && sideOpen} onClick={() => pickView(a.view)} />
            ))}
          </div>
        </nav>

        {sideOpen && (
          <>
            <aside className="wb-side" aria-label={`${LABEL[view]} explorer`}>
              {!loaded && !loadErr ? <div className="wb-empty-side" style={{ paddingTop: 12 }}>Loading…</div> : <SideBar
                view={view}
                groups={groups}
                files={files}
                keys={keys}
                servers={servers}
                sel={sel}
                setSel={(id) => {
                  setSel(id);
                  setActive(null);
                }}
                open={open}
                setOpen={setOpen}
                openFile={openFile}
                openKey={(k) => openTab({ id: `key:${k.id}`, kind: 'key', ref: k.id, title: k.name })}
                openServer={(s) => openTab({ id: `server:${s.id}`, kind: 'server', ref: s.id, title: s.name })}
                activeTab={activeTab}
                dirty={dirtyIds}
                reload={loadAll}
                flash={flash}
              />}
            </aside>
            <Sash onDrag={(dx) => setSideW((w) => Math.max(200, Math.min(560, w + dx)))} />
          </>
        )}

        <main className="wb-editor">
          <div className="wb-tabs" role="tablist">
            <div className={`wb-tab home ${active === null ? 'on' : ''}`} role="tab" aria-selected={active === null} onClick={() => setActive(null)}>
              <Ico name={[...TOP, ...BOTTOM].find((a) => a.view === view)!.icon} size={14} />
              <span>{LABEL[view]}</span>
            </div>
            {tabs.map((t) => (
              <div key={t.id} className={`wb-tab ${active === t.id ? 'on' : ''}`} role="tab" aria-selected={active === t.id} onClick={() => setActive(t.id)} onAuxClick={(e) => e.button === 1 && closeTab(t.id)}>
                <Ico name={t.kind === 'file' ? 'file' : t.kind === 'key' ? 'key' : t.kind === 'server' ? 'servers' : 'activity'} size={14} />
                <span>{t.title}</span>
                <button
                  type="button"
                  className={`wb-tab-x ${t.kind === 'file' && dirtyIds.has(Number(t.ref)) ? 'dirty' : ''}`}
                  aria-label={`Close ${t.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                >
                  <Ico name="close" size={14} className="x" />
                  <Ico name="dot" size={14} className="d" />
                </button>
              </div>
            ))}
            <div className="wb-tabs-fill" />
          </div>
          <Breadcrumbs view={view} group={group} groups={groups} tab={activeTab} files={files} />
          <div className="wb-editor-body">
            {loadErr ? (
              <div className="wb-page">
                <h2>Could not load GuardRail data</h2>
                <p className="dim">{loadErr}</p>
                <button className="wb-btn pri" onClick={() => void loadAll()}>
                  Try again
                </button>
              </div>
            ) : !loaded ? (
              <div className="wb-page dim">Loading…</div>
            ) : activeTab?.kind === 'file' ? (
              <FileEditor
                key={activeTab.id}
                file={files.find((f) => f.id === activeTab.ref)}
                text={buffers[Number(activeTab.ref)]}
                setText={(t) => setBuffers((b) => ({ ...b, [Number(activeTab.ref)]: t }))}
                onSave={() => void saveFile(Number(activeTab.ref))}
                dirty={dirtyIds.has(Number(activeTab.ref))}
              />
            ) : activeTab?.kind === 'key' ? (
              <KeyPage k={keys.find((k) => k.id === activeTab.ref)} />
            ) : activeTab?.kind === 'server' ? (
              <ServerPage s={servers.find((s) => s.id === activeTab.ref)} />
            ) : activeTab?.kind === 'log' ? (
              <LogPage id={String(activeTab.ref)} />
            ) : (
              <HomePage
                view={view}
                group={group}
                groups={groups}
                files={files}
                keys={keys}
                servers={servers}
                summary={summary}
                openFile={openFile}
                openLog={(l) => openTab({ id: `log:${l.id}`, kind: 'log', ref: l.id, title: `${l.key_name ?? 'request'} · ${new Date(l.ts).toLocaleTimeString()}` })}
              />
            )}
          </div>
        </main>

        {auxOpen && (
          <>
            <Sash onDrag={(dx) => setAuxW((w) => Math.max(220, Math.min(520, w - dx)))} />
            <aside className="wb-aux" aria-label="Group details">
              <GroupStats group={group} groups={groups} files={files} keys={keys} servers={servers} />
            </aside>
          </>
        )}
      </div>
      <StatusBar summary={summary} group={group} tab={activeTab} files={files} />
      {quick && (
        <QuickOpen
          onClose={() => setQuick(false)}
          items={[
            ...files.map((f) => ({ label: f.name, hint: 'Context file', icon: 'file' as IconName, run: () => openFile(f) })),
            ...groups.map((g) => ({ label: g.name, hint: g.path, icon: 'groups' as IconName, run: () => {
              setSel(g.id);
              setView('groups');
              setActive(null);
            } })),
            ...keys.map((k) => ({ label: k.name, hint: `API key · ${k.groupPath}`, icon: 'key' as IconName, run: () => openTab({ id: `key:${k.id}`, kind: 'key', ref: k.id, title: k.name }) })),
            ...servers.map((s) => ({ label: s.name, hint: s.url, icon: 'servers' as IconName, run: () => openTab({ id: `server:${s.id}`, kind: 'server', ref: s.id, title: s.name }) })),
          ]}
        />
      )}
      {toast && <div className="wb-toast">{toast}</div>}
    </div>
  );
}

/* ---------- chrome ---------- */

function TitleBar(p: { summary: Summary | null; onQuick: () => void; onBlocked: () => void; sideOpen: boolean; auxOpen: boolean; toggleSide: () => void; toggleAux: () => void; title: string }) {
  return (
    <header className="wb-title">
      <div className="wb-title-l">
        <span className="wb-logo" aria-hidden>
          <Ico name="guard" size={16} />
        </span>
        <span className="wb-appname">GuardRail</span>
      </div>
      <button type="button" className="wb-command" onClick={p.onQuick} title="Search files, groups, keys and servers (⌘P)">
        <Ico name="search" size={14} />
        <span>{p.title}</span>
        <kbd>⌘P</kbd>
      </button>
      <div className="wb-title-r">
        <button type="button" className="wb-icon-btn wb-blocked" onClick={p.onBlocked} title="Blocked requests today">
          <Ico name="block" size={16} />
          {!!p.summary?.blockedToday && <span className="wb-badge">{p.summary.blockedToday}</span>}
        </button>
        <span className="wb-sep" />
        <button type="button" className={`wb-icon-btn ${p.sideOpen ? 'on' : ''}`} onClick={p.toggleSide} title="Toggle side bar (⌘B)">
          <Ico name="layoutLeft" size={16} />
        </button>
        <button type="button" className={`wb-icon-btn ${p.auxOpen ? 'on' : ''}`} onClick={p.toggleAux} title="Toggle details (⌘⌥B)">
          <Ico name="layoutRight" size={16} />
        </button>
        <Link className="wb-icon-btn" href="/" title="Open the classic admin panel">
          <Ico name="link" size={16} />
        </Link>
      </div>
    </header>
  );
}

function ActBtn({ a, on, onClick }: { a: { view: View; icon: IconName; label: string }; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`wb-act ${on ? 'on' : ''}`} onClick={onClick} title={a.label} aria-label={a.label} aria-pressed={on}>
      <Ico name={a.icon} size={24} />
    </button>
  );
}

function Sash({ onDrag }: { onDrag: (dx: number) => void }) {
  const last = useRef<number | null>(null);
  return (
    <div
      className="wb-sash"
      onPointerDown={(e) => {
        last.current = e.clientX;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (last.current === null) return;
        onDrag(e.clientX - last.current);
        last.current = e.clientX;
      }}
      onPointerUp={() => (last.current = null)}
    />
  );
}

function Breadcrumbs({ view, group, groups, tab, files }: { view: View; group: GroupV | null; groups: GroupV[]; tab: Tab | null; files: FileV[] }) {
  const crumbs: string[] = [LABEL[view]];
  if (tab?.kind === 'file') {
    const f = files.find((x) => x.id === tab.ref);
    const owner = groups.find((g) => f && g.own.includes(f.id));
    if (owner) crumbs.push(...owner.path.split(' / '));
    crumbs.push(tab.title);
  } else if (tab) crumbs.push(tab.title);
  else if (group && view !== 'servers') crumbs.push(...group.path.split(' / '));
  return (
    <div className="wb-crumbs">
      {crumbs.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && <Ico name="chevron" size={12} className="sepi" />}
          <span>{c}</span>
        </Fragment>
      ))}
    </div>
  );
}

function StatusBar({ summary, group, tab, files }: { summary: Summary | null; group: GroupV | null; tab: Tab | null; files: FileV[] }) {
  const f = tab?.kind === 'file' ? files.find((x) => x.id === tab.ref) : null;
  return (
    <footer className="wb-status">
      <div className="wb-status-l">
        <span className="wb-status-item host">
          <Ico name="guard" size={13} /> GuardRail
        </span>
        {summary && (
          <>
            <span className={`wb-status-item ${summary.servers && summary.online < summary.servers ? 'warn' : ''}`}>
              <Ico name="servers" size={13} /> {summary.online}/{summary.servers} online
            </span>
            <span className="wb-status-item">
              <Ico name="guard" size={13} /> Guard {summary.guard ? 'on' : 'off'}
            </span>
            <span className="wb-status-item">
              <Ico name="block" size={13} /> {summary.blockedToday} blocked today
            </span>
          </>
        )}
      </div>
      <div className="wb-status-r">
        {f && <span className="wb-status-item">~{fmtK(f.tokens)} tokens</span>}
        {f && <span className="wb-status-item">Markdown</span>}
        {group && (
          <span className="wb-status-item">
            <Ico name="groups" size={13} /> {group.path}
          </span>
        )}
        {summary && (
          <span className="wb-status-item">
            <Ico name="account" size={13} /> {summary.name}
          </span>
        )}
      </div>
    </footer>
  );
}

/* ---------- primary side bar ---------- */

function SideBar(p: {
  view: View;
  groups: GroupV[];
  files: FileV[];
  keys: KeyV[];
  servers: ServerV[];
  sel: number | null;
  setSel: (id: number) => void;
  open: Set<number>;
  setOpen: (s: Set<number>) => void;
  openFile: (f: FileV) => void;
  openKey: (k: KeyV) => void;
  openServer: (s: ServerV) => void;
  activeTab: Tab | null;
  dirty: Set<number>;
  reload: () => Promise<void>;
  flash: (t: string) => void;
}) {
  const [ctxMode, setCtxMode] = useState<'groups' | 'all'>('groups');
  const [creating, setCreating] = useState<null | { kind: 'file' | 'group'; parent: number | null }>(null);
  const { view, groups, files, keys, sel } = p;

  const startCreate = (kind: 'file' | 'group') => {
    setCreating({ kind, parent: sel });
    if (sel !== null && !p.open.has(sel)) p.setOpen(new Set([...p.open, sel]));
  };

  const toggle = (id: number) => {
    const n = new Set(p.open);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    p.setOpen(n);
  };

  const create = async (name: string) => {
    const c = creating;
    setCreating(null);
    if (!c || !name.trim()) return;
    try {
      if (c.kind === 'group') {
        await api('groups', { body: { name: name.trim(), parentId: c.parent } });
        if (c.parent) p.setOpen(new Set([...p.open, c.parent]));
        p.flash(`Group "${name.trim()}" added`);
      } else {
        const f = await api<FileV>('context', { body: { name: name.trim().replace(/\.md$/i, '') + '.md', body: `# ${name.trim().replace(/\.md$/i, '')}\n\n` } });
        const g = groups.find((x) => x.id === c.parent);
        if (g) await attach(g, f.id);
        await p.reload();
        p.openFile({ ...f, tokens: 0, usedBy: [], reach: 0 });
        p.flash(`File "${f.name}" added${g ? ` to ${g.name}` : ''}`);
        return;
      }
      await p.reload();
    } catch (e) {
      p.flash(e instanceof Error ? e.message : 'Could not create it');
    }
  };

  const attach = async (g: GroupV, fileId: number) => {
    if (g.own.includes(fileId)) return;
    const isRoot = g.parentId === null;
    await api(`groups/${g.id}/settings`, { method: 'PUT', body: { key: 'context', setting: { mode: isRoot ? 'set' : (g.mode as string) || 'add', value: [...g.own, fileId] } } });
  };
  const detach = async (g: GroupV, fileId: number) => {
    const isRoot = g.parentId === null;
    const value = g.own.filter((x) => x !== fileId);
    await api(`groups/${g.id}/settings`, { method: 'PUT', body: { key: 'context', setting: !isRoot && value.length === 0 && g.mode === 'add' ? null : { mode: isRoot ? 'set' : (g.mode as string) || 'add', value } } });
  };

  const removeGroup = async (g: GroupV) => {
    if (g.parentId === null) return p.flash('The root group cannot be deleted.');
    if (g.childCount || g.keyCount) return p.flash('Move its sub-groups and keys first.');
    try {
      await api(`groups/${g.id}`, { method: 'DELETE' });
      await p.reload();
      p.flash(`Deleted ${g.name}`);
    } catch (e) {
      p.flash(e instanceof Error ? e.message : 'Could not delete it');
    }
  };

  const header = (title: string, actions?: React.ReactNode) => (
    <div className="wb-side-head">
      <span>{title.toUpperCase()}</span>
      <div className="wb-side-actions">{actions}</div>
    </div>
  );

  if (view === 'servers') {
    return (
      <>
        {header('Servers', <IconBtn icon="refresh" label="Refresh" onClick={() => void p.reload()} />)}
        <div className="wb-tree">
          {p.servers.length === 0 && <div className="wb-empty-side">No servers yet. Add one in the classic panel under Servers.</div>}
          {['inference', 'guard'].map((role) => {
            const list = p.servers.filter((s) => s.role === role);
            if (!list.length) return null;
            return (
              <div key={role}>
                <div className="wb-section">{role === 'inference' ? 'FOR CLIENTS' : 'GUARD MODELS'}</div>
                {list.map((s) => (
                  <div key={s.id} className={`wb-row ${p.activeTab?.id === `server:${s.id}` ? 'sel' : ''}`} style={{ paddingLeft: 12 }} onClick={() => p.openServer(s)}>
                    <span className={`wb-led ${s.status}`} />
                    <span className="wb-row-label">{s.name}</span>
                    <span className="wb-count">{s.models.filter((m) => m.enabled).length}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </>
    );
  }

  const groupActions =
    view === 'context' ? (
      <>
        <IconBtn icon="newFile" label="New context file" onClick={() => startCreate('file')} />
        <IconBtn icon="newFolder" label="New group" onClick={() => startCreate('group')} />
        <IconBtn icon={ctxMode === 'groups' ? 'listFlat' : 'listTree'} label={ctxMode === 'groups' ? 'Show all files' : 'Show by group'} onClick={() => setCtxMode((m) => (m === 'groups' ? 'all' : 'groups'))} />
      </>
    ) : view === 'groups' ? (
      <>
        <IconBtn icon="newFolder" label="New sub-group" onClick={() => startCreate('group')} />
        <IconBtn icon="trash" label="Delete group" onClick={() => {
          const g = groups.find((x) => x.id === sel);
          if (g) void removeGroup(g);
        }} />
      </>
    ) : (
      <IconBtn icon="refresh" label="Refresh" onClick={() => void p.reload()} />
    );

  const titleFor: Partial<Record<View, string>> = { context: 'Context files', keys: 'API keys', groups: 'Groups', guard: 'Guard checks by group', activity: 'Activity by group', overview: 'Groups' };

  const unattached = files.filter((f) => !groups.some((g) => g.own.includes(f.id)));

  const fileRow = (f: FileV, depth: number, owner?: GroupV) => (
    <div
      key={`f${owner?.id ?? 'x'}-${f.id}`}
      className={`wb-row file ${p.activeTab?.id === `file:${f.id}` ? 'sel' : ''}`}
      style={{ paddingLeft: 8 + depth * 8 + 16 }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/x-gr-file', String(f.id));
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => p.openFile(f)}
      title={f.usedBy.length ? `Included by ${f.usedBy.join(', ')}` : 'Not included by any group'}
    >
      <Ico name="file" size={16} className="ic-file" />
      <span className="wb-row-label">{f.name}</span>
      {p.dirty.has(f.id) && <span className="wb-dirty" aria-label="Unsaved changes" />}
      <span className="wb-count">{fmtK(f.tokens)}</span>
      {owner && (
        <button
          type="button"
          className="wb-row-act"
          title={`Remove from ${owner.name}`}
          onClick={async (e) => {
            e.stopPropagation();
            try {
              await detach(owner, f.id);
              await p.reload();
              p.flash(`Removed ${f.name} from ${owner.name}`);
            } catch (err) {
              p.flash(err instanceof Error ? err.message : 'Could not remove it');
            }
          }}
        >
          <Ico name="close" size={14} />
        </button>
      )}
    </div>
  );

  const renderGroup = (g: GroupV): React.ReactNode => {
    const kids = groups.filter((x) => x.parentId === g.id);
    const gFiles = view === 'context' ? g.own.map((id) => files.find((f) => f.id === id)).filter((f): f is FileV => !!f) : [];
    const gKeys = view === 'keys' ? keys.filter((k) => k.groupId === g.id) : [];
    const hasKids = kids.length > 0 || gFiles.length > 0 || gKeys.length > 0;
    const isOpen = p.open.has(g.id);
    const count = view === 'keys' ? keys.filter((k) => k.groupId === g.id).length : view === 'context' ? g.context.length : g.keyCount;
    return (
      <Fragment key={g.id}>
        <div
          className={`wb-row group ${sel === g.id ? 'sel' : ''}`}
          style={{ paddingLeft: 8 + g.depth * 8 }}
          onClick={() => {
            p.setSel(g.id);
            if (hasKids && !isOpen) toggle(g.id);
          }}
          onDragOver={(e) => {
            if (view === 'context' && e.dataTransfer.types.includes('text/x-gr-file')) {
              e.preventDefault();
              e.currentTarget.classList.add('drop');
            }
          }}
          onDragLeave={(e) => e.currentTarget.classList.remove('drop')}
          onDrop={async (e) => {
            e.currentTarget.classList.remove('drop');
            const fid = Number(e.dataTransfer.getData('text/x-gr-file'));
            if (!fid) return;
            try {
              await attach(g, fid);
              await p.reload();
              p.flash(`Added to ${g.name}`);
            } catch (err) {
              p.flash(err instanceof Error ? err.message : 'Could not add it');
            }
          }}
        >
          <span
            className={`wb-twistie ${hasKids ? '' : 'none'} ${isOpen ? 'open' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              toggle(g.id);
            }}
          >
            <Ico name="chevron" size={16} />
          </span>
          <Ico name={view === 'context' ? (isOpen && hasKids ? 'folderOpen' : 'folder') : 'groups'} size={16} className="ic-group" />
          <span className="wb-row-label">{g.name}</span>
          <span className="wb-count" title={view === 'keys' ? 'API keys' : view === 'context' ? 'Context files it gets' : 'API keys'}>
            {count}
          </span>
        </div>
        {isOpen && (
          <>
            {kids.map(renderGroup)}
            {gFiles.map((f) => fileRow(f, g.depth + 1, g))}
            {gKeys.map((k) => (
              <div key={`k${k.id}`} className={`wb-row ${p.activeTab?.id === `key:${k.id}` ? 'sel' : ''} ${k.revoked ? 'muted' : ''}`} style={{ paddingLeft: 8 + (g.depth + 1) * 8 + 16 }} onClick={() => p.openKey(k)}>
                <Ico name="key" size={16} className="ic-key" />
                <span className="wb-row-label">{k.name}</span>
                <span className="wb-count">{k.revoked ? 'revoked' : k.requestsToday ? `${k.requestsToday} today` : ''}</span>
              </div>
            ))}
            {creating && creating.parent === g.id && <NewRow depth={g.depth + 1} kind={creating.kind} onDone={create} />}
          </>
        )}
      </Fragment>
    );
  };

  return (
    <>
      {header(titleFor[view] ?? 'Groups', groupActions)}
      <div className="wb-tree" role="tree">
        {view === 'context' && ctxMode === 'all' ? (
          <>
            {files.length === 0 && <div className="wb-empty-side">No context files yet.</div>}
            {[...files].sort((a, b) => a.name.localeCompare(b.name)).map((f) => fileRow(f, 0))}
            {creating?.kind === 'file' && <NewRow depth={0} kind="file" onDone={create} />}
          </>
        ) : (
          <>
            {groups.filter((g) => g.parentId === null).map(renderGroup)}
            {creating && creating.parent === null && <NewRow depth={0} kind={creating.kind} onDone={create} />}
          </>
        )}
        {view === 'context' && ctxMode === 'groups' && (
          <>
            <div className="wb-section">NOT IN ANY GROUP</div>
            {unattached.length === 0 ? <div className="wb-empty-side">Every file is in a group.</div> : unattached.map((f) => fileRow(f, 0))}
            <div className="wb-hint">Drag a file onto a group to include it there.</div>
          </>
        )}
        {view === 'keys' && <div className="wb-hint">Numbers show how many API keys sit directly in each group.</div>}
      </div>
    </>
  );
}

function NewRow({ depth, kind, onDone }: { depth: number; kind: 'file' | 'group'; onDone: (name: string) => void }) {
  const [v, setV] = useState('');
  const done = useRef(false);
  const finish = (name: string) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <div className="wb-row new" style={{ paddingLeft: 8 + depth * 8 + 16 }}>
      <Ico name={kind === 'file' ? 'file' : 'folder'} size={16} />
      <input
        autoFocus
        className="wb-new-input"
        value={v}
        placeholder={kind === 'file' ? 'file-name.md' : 'Group name'}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(v);
          if (e.key === 'Escape') finish('');
        }}
        onBlur={() => finish(v)}
      />
    </div>
  );
}

function IconBtn({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button type="button" className="wb-icon-btn sm" title={label} aria-label={label} onClick={onClick}>
      <Ico name={icon} size={16} />
    </button>
  );
}

/* ---------- editor pages ---------- */

function FileEditor({ file, text, setText, onSave, dirty }: { file?: FileV; text?: string; setText: (t: string) => void; onSave: () => void; dirty: boolean }) {
  const [preview, setPreview] = useState(false);
  const [cursor, setCursor] = useState({ ln: 1, col: 1 });
  const gutter = useRef<HTMLDivElement>(null);
  if (!file) return <div className="wb-page dim">This file no longer exists.</div>;
  const value = text ?? file.body;
  const lines = value.split('\n').length;
  return (
    <div className="wb-file">
      <div className="wb-file-bar">
        <span className="dim">
          v{file.version} · saved {ago(file.updated_at)} · included by {file.usedBy.length ? file.usedBy.join(', ') : 'no group'}
        </span>
        <div className="wb-file-actions">
          {dirty && (
            <button type="button" className="wb-btn pri sm" onClick={onSave}>
              Save ⌘S
            </button>
          )}
          <button type="button" className={`wb-icon-btn ${preview ? 'on' : ''}`} title={preview ? 'Show text' : 'Show rendered Markdown'} aria-label={preview ? 'Show text' : 'Show rendered Markdown'} onClick={() => setPreview((v) => !v)}>
            <Ico name={preview ? 'code' : 'preview'} size={16} />
          </button>
        </div>
      </div>
      {preview ? (
        <div className="wb-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }} />
      ) : (
        <div className="wb-code">
          <div className="wb-gutter" ref={gutter} aria-hidden>
            {Array.from({ length: lines }, (_, i) => (
              <div key={i} className={i + 1 === cursor.ln ? 'cur' : ''}>
                {i + 1}
              </div>
            ))}
          </div>
          <textarea
            className="wb-textarea"
            spellCheck={false}
            value={value}
            aria-label={`Contents of ${file.name}`}
            onChange={(e) => setText(e.target.value)}
            onScroll={(e) => {
              if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onSelect={(e) => {
              const t = e.currentTarget;
              const before = t.value.slice(0, t.selectionStart);
              const ln = before.split('\n').length;
              setCursor({ ln, col: t.selectionStart - before.lastIndexOf('\n') });
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                onSave();
              } else if (e.key === 'Tab') {
                e.preventDefault();
                const t = e.currentTarget;
                const s = t.selectionStart;
                const next = t.value.slice(0, s) + '  ' + t.value.slice(t.selectionEnd);
                setText(next);
                requestAnimationFrame(() => t.setSelectionRange(s + 2, s + 2));
              }
            }}
          />
          <div className="wb-cursor-pos dim">
            Ln {cursor.ln}, Col {cursor.col}
          </div>
        </div>
      )}
    </div>
  );
}

function HomePage(p: { view: View; group: GroupV | null; groups: GroupV[]; files: FileV[]; keys: KeyV[]; servers: ServerV[]; summary: Summary | null; openFile: (f: FileV) => void; openLog: (l: LogRow) => void }) {
  const { view, group } = p;
  if (view === 'activity') return <ActivityPage group={group} groups={p.groups} openLog={p.openLog} />;
  if (view === 'overview') return <OverviewPage summary={p.summary} servers={p.servers} />;
  if (view === 'guard') return <GuardPage group={group} />;
  if (view === 'servers')
    return (
      <div className="wb-page">
        <h2>Servers</h2>
        <p className="dim">Pick a server on the left to see its models, context sizes and prices.</p>
        <Table head={['Server', 'Use', 'Status', 'Latency', 'Models on']} rows={p.servers.map((s) => [s.name, s.role === 'inference' ? 'Clients' : 'Guard', <Status key="s" s={s.status} />, s.latency_ms == null ? '–' : `${s.latency_ms} ms`, `${s.models.filter((m) => m.enabled).length} / ${s.models.length}`])} />
      </div>
    );
  if (view === 'studio' || view === 'settings' || view === 'account')
    return (
      <div className="wb-page">
        <h2>{LABEL[view]}</h2>
        <p className="dim">This part of the new layout comes next. Until then it lives in the classic panel.</p>
        <Link className="wb-btn" href={view === 'studio' ? '/studio' : view === 'settings' ? '/guard' : '/'}>
          Open in the classic panel
        </Link>
      </div>
    );
  if (!group) return <div className="wb-page dim">Pick a group on the left.</div>;
  if (view === 'context') {
    const eff = group.context.map((id) => p.files.find((f) => f.id === id)).filter((f): f is FileV => !!f);
    return (
      <div className="wb-page">
        <h2>
          <Ico name="folderOpen" size={18} /> {group.name}
        </h2>
        <p className="dim">{group.path}</p>
        <h3>Files every key in this group gets ({eff.length})</h3>
        {eff.length === 0 ? (
          <p className="dim">No context files reach this group yet. Create one with the new-file button, or drag a file onto the group.</p>
        ) : (
          <Table
            head={['File', 'Tokens', 'Comes from', 'Updated']}
            rows={eff.map((f) => [
              <button key="f" className="wb-link" onClick={() => p.openFile(f)}>
                {f.name}
              </button>,
              fmtK(f.tokens),
              group.own.includes(f.id) ? 'This group' : 'Inherited',
              ago(f.updated_at),
            ])}
          />
        )}
      </div>
    );
  }
  if (view === 'keys') {
    const ks = p.keys.filter((k) => k.groupId === group.id);
    return (
      <div className="wb-page">
        <h2>
          <Ico name="keys" size={18} /> Keys in {group.name}
        </h2>
        <p className="dim">{group.path}</p>
        {ks.length === 0 ? <p className="dim">No API keys sit directly in this group.</p> : <Table head={['Name', 'Owner', 'Prefix', 'Today', 'Last used', 'State']} rows={ks.map((k) => [k.name, k.owner || '–', <code key="p">{k.prefix}…</code>, k.requestsToday, ago(k.lastUsedAt), k.revoked ? 'Revoked' : k.expiresAt && k.expiresAt < Date.now() ? 'Expired' : 'Active'])} />}
      </div>
    );
  }
  // groups
  const kids = p.groups.filter((g) => g.parentId === group.id);
  return (
    <div className="wb-page">
      <h2>
        <Ico name="groups" size={18} /> {group.name}
      </h2>
      <p className="dim">{group.description || group.path}</p>
      <div className="wb-tiles">
        <Tile label="Sub-groups" value={kids.length} />
        <Tile label="API keys here" value={group.keyCount} />
        <Tile label="Context files it gets" value={group.context.length} />
      </div>
      {kids.length > 0 && (
        <>
          <h3>Sub-groups</h3>
          <Table head={['Group', 'Keys', 'Sub-groups']} rows={kids.map((k) => [k.name, k.keyCount, k.childCount])} />
        </>
      )}
    </div>
  );
}

function OverviewPage({ summary, servers }: { summary: Summary | null; servers: ServerV[] }) {
  const [data, setData] = useState<{ counts: Record<string, number>; overheadP95: number | null; recentBlocks: LogRow[] } | null>(null);
  useEffect(() => {
    api<{ counts: Record<string, number>; overheadP95: number | null; recentBlocks: LogRow[] }>('overview?range=24h').then(setData).catch(() => setData(null));
  }, []);
  return (
    <div className="wb-page">
      <h2>Overview · last 24 hours</h2>
      <div className="wb-tiles">
        <Tile label="Requests" value={data?.counts.all ?? '–'} />
        <Tile label="Blocked" value={data?.counts.blocked ?? '–'} tone="bad" />
        <Tile label="Guard overhead p95" value={data?.overheadP95 != null ? `${data.overheadP95} ms` : '–'} />
        <Tile label="Servers online" value={summary ? `${summary.online}/${summary.servers}` : '–'} />
      </div>
      <h3>Servers</h3>
      {servers.length === 0 ? <p className="dim">No servers yet.</p> : <Table head={['Server', 'Status', 'Latency', 'Cache hits']} rows={servers.map((s) => [s.name, <Status key="s" s={s.status} />, s.latency_ms == null ? '–' : `${s.latency_ms} ms`, pct(s.cache_hit_rate)])} />}
      <h3>Recent blocks</h3>
      {!data?.recentBlocks?.length ? <p className="dim">Nothing blocked recently.</p> : <Table head={['When', 'Key', 'Group', 'Reason']} rows={data.recentBlocks.map((l) => [ago(l.ts), l.key_name ?? '–', l.group_name ?? '–', l.c2_reason ?? l.outcome])} />}
    </div>
  );
}

function ActivityPage({ group, groups, openLog }: { group: GroupV | null; groups: GroupV[]; openLog: (l: LogRow) => void }) {
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'blocked'>('all');
  useEffect(() => {
    setRows(null);
    api<{ rows: LogRow[] }>(`logs?limit=300${filter === 'blocked' ? '&filter=blocked' : ''}`)
      .then((r) => setRows(r.rows))
      .catch(() => setRows([]));
  }, [filter]);
  // A group shows its own requests and its sub-groups'.
  const inScope = useMemo(() => {
    if (!group || group.parentId === null) return null;
    const ids = new Set<number>([group.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const g of groups)
        if (g.parentId !== null && ids.has(g.parentId) && !ids.has(g.id)) {
          ids.add(g.id);
          grew = true;
        }
    }
    return ids;
  }, [group, groups]);
  const shown = (rows ?? []).filter((r) => !inScope || (r.group_id !== null && inScope.has(r.group_id)));
  return (
    <div className="wb-page">
      <div className="wb-page-head">
        <h2>Activity{group && group.parentId !== null ? ` · ${group.name}` : ''}</h2>
        <div className="wb-seg">
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
            All
          </button>
          <button className={filter === 'blocked' ? 'on' : ''} onClick={() => setFilter('blocked')}>
            Blocked
          </button>
        </div>
      </div>
      {rows === null ? (
        <p className="dim">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="dim">No requests {inScope ? 'from this group ' : ''}yet.</p>
      ) : (
        <Table
          head={['Time', 'Key', 'Group', 'Model', 'Outcome']}
          rows={shown.map((l) => [new Date(l.ts).toLocaleString(), l.key_name ?? '–', l.group_name ?? '–', l.model ?? '–', <span key="o" className={`wb-pill ${l.outcome}`}>{l.outcome.replace('_', ' ')}</span>])}
          onRow={(i) => openLog(shown[i])}
        />
      )}
    </div>
  );
}

function GuardPage({ group }: { group: GroupV | null }) {
  const [res, setRes] = useState<Resolution | null>(null);
  useEffect(() => {
    if (!group) return;
    setRes(null);
    api<{ resolution: Resolution }>(`groups/${group.id}`).then((r) => setRes(r.resolution)).catch(() => setRes(null));
  }, [group]);
  if (!group) return <div className="wb-page dim">Pick a group on the left.</div>;
  const e = res?.effective ?? {};
  const on = (v: unknown) => (v ? <span className="wb-pill answered">On</span> : <span className="wb-pill blocked">Off (bypassed)</span>);
  return (
    <div className="wb-page">
      <h2>
        <Ico name="guard" size={18} /> Guard checks for {group.name}
      </h2>
      <p className="dim">What applies to every key in {group.path}, after inheritance.</p>
      {!res ? (
        <p className="dim">Loading…</p>
      ) : (
        <Table
          head={['Check', 'Setting']}
          rows={[
            ['PIGuard (check 1)', on(e.piguard_enabled)],
            ['Flags at score', String(e.piguard_threshold ?? '–')],
            ['Second check (OSS)', on(e.oss_enabled)],
            ['Rate limit', e.rate_limit ? `${e.rate_limit} per minute` : 'None'],
          ]}
        />
      )}
      <p>
        <Link className="wb-btn" href="/groups">
          Change in the classic panel
        </Link>
      </p>
    </div>
  );
}

function KeyPage({ k }: { k?: KeyV }) {
  if (!k) return <div className="wb-page dim">This key no longer exists.</div>;
  return (
    <div className="wb-page">
      <h2>
        <Ico name="key" size={18} /> {k.name}
      </h2>
      <Table
        head={['Field', 'Value']}
        rows={[
          ['Owner', k.owner || '–'],
          ['Group', k.groupPath],
          ['Prefix', <code key="p">{k.prefix}…</code>],
          ['Requests today', k.requestsToday],
          ['Last used', ago(k.lastUsedAt)],
          ['Expires', k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : 'Never'],
          ['State', k.revoked ? 'Revoked' : 'Active'],
          ['Created', new Date(k.createdAt).toLocaleDateString()],
        ]}
      />
    </div>
  );
}

function ServerPage({ s }: { s?: ServerV }) {
  if (!s) return <div className="wb-page dim">This server no longer exists.</div>;
  const price = (m: ModelV) => (m.price_in == null && m.price_out == null ? '–' : m.price_in === 0 && m.price_out === 0 ? 'Free' : `$${m.price_in ?? '?'} / $${m.price_out ?? '?'}`);
  return (
    <div className="wb-page">
      <h2>
        <span className={`wb-led ${s.status}`} /> {s.name}
      </h2>
      <p className="dim">
        <code>{s.url}</code> · {s.role === 'inference' ? 'for clients' : 'guard models only'} · {s.latency_ms == null ? 'no latency yet' : `${s.latency_ms} ms`} · cache hits {pct(s.cache_hit_rate)}
      </p>
      {s.last_error && <p className="wb-error">{s.last_error}</p>}
      <Table head={['Model', 'Context', 'Price in / out per 1M', 'Clients']} rows={s.models.map((m) => [<code key="m">{m.name}</code>, m.context_len ? `${fmtK(m.context_len)}` : '–', price(m), m.enabled ? 'On' : 'Hidden'])} />
    </div>
  );
}

function LogPage({ id }: { id: string }) {
  const [l, setL] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    api<Record<string, unknown>>(`logs/${id}`).then(setL).catch(() => setL({}));
  }, [id]);
  if (!l) return <div className="wb-page dim">Loading…</div>;
  const fields = ['ts', 'key_name', 'owner', 'group_name', 'model', 'server', 'outcome', 'c1_score', 'c1_status', 'c2_status', 'c2_reason', 'path', 'schema', 'ip'];
  return (
    <div className="wb-page">
      <h2>Request {id}</h2>
      <Table head={['Field', 'Value']} rows={fields.filter((f) => l[f] != null).map((f) => [f.replace(/_/g, ' '), f === 'ts' ? new Date(Number(l[f])).toLocaleString() : String(l[f])])} />
    </div>
  );
}

/* ---------- secondary side bar: group stats ---------- */

function GroupStats({ group, groups, files, keys, servers }: { group: GroupV | null; groups: GroupV[]; files: FileV[]; keys: KeyV[]; servers: ServerV[] }) {
  if (!group)
    return (
      <>
        <div className="wb-side-head">
          <span>DETAILS</span>
        </div>
        <div className="wb-empty-side">Pick a group to see its numbers.</div>
      </>
    );
  const eff = group.context.map((id) => files.find((f) => f.id === id)).filter((f): f is FileV => !!f);
  const tokens = eff.reduce((n, f) => n + f.tokens, 0);
  const own = eff.filter((f) => group.own.includes(f.id));
  const sub = (() => {
    const ids = new Set([group.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const g of groups)
        if (g.parentId !== null && ids.has(g.parentId) && !ids.has(g.id)) {
          ids.add(g.id);
          grew = true;
        }
    }
    return ids;
  })();
  const reach = keys.filter((k) => sub.has(k.groupId) && !k.revoked);
  const today = reach.reduce((n, k) => n + k.requestsToday, 0);
  const cache = servers.filter((s) => s.role === 'inference');
  return (
    <>
      <div className="wb-side-head">
        <span>{group.name.toUpperCase()}</span>
      </div>
      <div className="wb-aux-body">
        <Section title="Context">
          <Stat label="Files it gets" value={eff.length} />
          <Stat label="Set on this group" value={own.length} />
          <Stat label="Inherited" value={eff.length - own.length} />
          <Stat label="Tokens per request" value={`~${fmtK(tokens)}`} />
          <Bar value={Math.min(1, tokens / 32000)} label={`${Math.round((tokens / 32000) * 100)}% of a 32k window`} />
        </Section>
        <Section title="Prefix cache hit rate">
          {cache.length === 0 ? <div className="dim small">No inference servers yet.</div> : cache.map((s) => <Stat key={s.id} label={s.name} value={pct(s.cache_hit_rate)} />)}
        </Section>
        <Section title={`Keys that get it (${reach.length})`}>
          <Stat label="Requests today" value={today} />
          {reach.length === 0 ? (
            <div className="dim small">No active keys in this group or below.</div>
          ) : (
            <ul className="wb-keylist">
              {reach.slice(0, 30).map((k) => (
                <li key={k.id}>
                  <Ico name="key" size={13} /> <span>{k.name}</span> <span className="dim">{k.groupId === group.id ? '' : groups.find((g) => g.id === k.groupId)?.name}</span>
                </li>
              ))}
              {reach.length > 30 && <li className="dim">and {reach.length - 30} more</li>}
            </ul>
          )}
        </Section>
        <Section title="Group">
          <Stat label="Path" value={group.path} />
          <Stat label="Sub-groups" value={group.childCount} />
          <Stat label="Context rule" value={group.parentId === null ? 'Root (sets the base)' : group.mode === 'add' ? 'Adds to parent' : group.mode ? 'Replaces parent' : 'Same as parent'} />
        </Section>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="wb-sec">
      <button type="button" className="wb-sec-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`wb-twistie ${open ? 'open' : ''}`}>
          <Ico name="chevron" size={16} />
        </span>
        {title.toUpperCase()}
      </button>
      {open && <div className="wb-sec-body">{children}</div>}
    </section>
  );
}

const Stat = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="wb-stat">
    <span className="dim">{label}</span>
    <span>{value}</span>
  </div>
);
const Bar = ({ value, label }: { value: number; label: string }) => (
  <div className="wb-bar" title={label}>
    <div style={{ width: `${Math.round(value * 100)}%` }} className={value > 0.8 ? 'hot' : ''} />
    <span className="dim small">{label}</span>
  </div>
);
const Tile = ({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'bad' }) => (
  <div className={`wb-tile ${tone ?? ''}`}>
    <div className="dim small">{label}</div>
    <div className="wb-tile-v">{value}</div>
  </div>
);
const Status = ({ s }: { s: string }) => (
  <span>
    <span className={`wb-led ${s}`} /> {s === 'online' ? 'Online' : s === 'down' ? 'Down' : 'Not checked'}
  </span>
);

function Table({ head, rows, onRow }: { head: string[]; rows: React.ReactNode[][]; onRow?: (i: number) => void }) {
  return (
    <div className="wb-table-wrap">
      <table className="wb-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} onClick={onRow ? () => onRow(i) : undefined} className={onRow ? 'click' : ''}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- quick open (⌘P) ---------- */

function QuickOpen({ items, onClose }: { items: { label: string; hint: string; icon: IconName; run: () => void }[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const shown = items.filter((x) => (x.label + ' ' + x.hint).toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  const pick = (n: number) => {
    const it = shown[n];
    if (!it) return;
    onClose();
    it.run();
  };
  return (
    <div className="wb-quick-back" onMouseDown={onClose}>
      <div className="wb-quick" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Quick open">
        <input
          autoFocus
          className="wb-quick-input"
          placeholder="Search files, groups, keys and servers"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setI(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setI((n) => Math.min(shown.length - 1, n + 1));
            }
            else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setI((n) => Math.max(0, n - 1));
            }
            else if (e.key === 'Enter') pick(i);
          }}
        />
        <div className="wb-quick-list">
          {shown.length === 0 && <div className="wb-quick-item dim">No matches</div>}
          {shown.map((it, n) => (
            <div key={n} className={`wb-quick-item ${n === i ? 'on' : ''}`} onMouseEnter={() => setI(n)} onClick={() => pick(n)}>
              <Ico name={it.icon} size={16} />
              <span>{it.label}</span>
              <span className="dim">{it.hint}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
