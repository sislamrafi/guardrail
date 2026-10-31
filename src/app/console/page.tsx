'use client';

import { type DragEvent, type KeyboardEvent as RKeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Ico, type IconName } from '@/components/console/icons';
import { renderMarkdown } from '@/components/console/markdown';
import { api } from '@/components/ui';
import './console.css';

/*
 * GuardRail console: a VS Code-style workbench.
 * Activity bar picks a view; the primary sidebar is always the group explorer, shaped by that view;
 * the editor opens what you pick; the secondary sidebar shows stats for the selected group.
 */

type View = 'overview' | 'activity' | 'guard' | 'servers' | 'groups' | 'keys' | 'context' | 'studio' | 'settings';

interface GroupC {
  id: number;
  name: string;
  parentId: number | null;
  description: string;
  path: string;
  depth: number;
  keyCount: number;
  childCount: number;
  context: number[];
  own: number[];
  mode: 'set' | 'add' | 'override' | null;
  keys: string[];
}
interface FileC {
  id: number;
  name: string;
  body: string;
  version: number;
  updated_at: number;
  tokens: number;
  usedBy: string[];
  reach: number;
}
interface KeyC {
  id: number;
  name: string;
  owner: string;
  groupId: number;
  prefix: string;
  revoked: boolean;
  expiresAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  requestsToday: number;
  groupPath: string;
}
interface ServerC {
  id: number;
  name: string;
  url: string;
  role: 'inference' | 'guard';
  status: string;
  latency_ms: number | null;
  cache_hit_rate: number | null;
  models: { id: number; name: string; enabled: number; context_len: number | null; price_in?: number | null; price_out?: number | null }[];
}
interface LogC {
  id: string;
  ts: number;
  key_name: string | null;
  group_id: number | null;
  group_name: string | null;
  model: string | null;
  outcome: string;
  reason: string | null;
  latency_ms: number | null;
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
interface Resolution {
  effective: Record<string, unknown> & { context: number[]; piguard_enabled: boolean; piguard_threshold: number; oss_enabled: boolean; oss_prompt_parts: { from: string; text: string }[]; rate_limit: number; models: string[]; servers: number[] | null };
}
type Tab =
  | { id: string; kind: 'file'; ref: number }
  | { id: string; kind: 'group'; ref: number }
  | { id: string; kind: 'key'; ref: number }
  | { id: string; kind: 'server'; ref: number }
  | { id: string; kind: 'page'; ref: 'overview' | 'activity' | 'guard' | 'studio' | 'settings' | 'welcome' };

const ACTIVITY: { id: View; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Overview', icon: 'overview' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'guard', label: 'Guard checks', icon: 'guard' },
  { id: 'servers', label: 'Servers', icon: 'servers' },
  { id: 'groups', label: 'Groups', icon: 'groups' },
  { id: 'keys', label: 'API keys', icon: 'keys' },
  { id: 'context', label: 'Context files', icon: 'context' },
];
const VIEW_LABEL: Record<View, string> = {
  overview: 'Overview',
  activity: 'Activity',
  guard: 'Guard checks',
  servers: 'Servers',
  groups: 'Groups',
  keys: 'API keys',
  context: 'Context files',
  studio: 'Studio',
  settings: 'Settings',
};

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const ago = (t: number | null) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const OUTCOME_TONE: Record<string, string> = { answered: 'ok', redacted: 'warn', false_alarm: 'warn', blocked: 'bad', rejected: 'bad', error: 'bad' };

/** Group ids in the subtree rooted at `id` (inclusive). */
const subtree = (id: number, groups: GroupC[]): Set<number> => {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of groups)
      if (g.parentId !== null && out.has(g.parentId) && !out.has(g.id)) {
        out.add(g.id);
        grew = true;
      }
  }
  return out;
};

export default function Console() {
  const [view, setView] = useState<View>('context');
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [leftW, setLeftW] = useState(300);
  const [rightW, setRightW] = useState(300);

  const [groups, setGroups] = useState<GroupC[]>([]);
  const [files, setFiles] = useState<FileC[]>([]);
  const [keys, setKeys] = useState<KeyC[]>([]);
  const [servers, setServers] = useState<ServerC[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [cache, setCache] = useState<{ name: string; rate: number }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);

  const [selGroup, setSelGroup] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [ctxMode, setCtxMode] = useState<'groups' | 'all'>('groups');
  const [creating, setCreating] = useState<{ kind: 'file' | 'group' | 'key'; parent: number | null } | null>(null);
  const [renaming, setRenaming] = useState<{ kind: 'file' | 'group'; id: number } | null>(null);

  const [tabs, setTabs] = useState<Tab[]>([{ id: 'page:welcome', kind: 'page', ref: 'welcome' }]);
  const [active, setActive] = useState('page:welcome');
  const [history, setHistory] = useState<{ list: string[]; at: number }>({ list: ['page:welcome'], at: 0 });
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<Record<number, boolean>>({});
  const [cursor, setCursor] = useState({ ln: 1, col: 1 });
  const [quick, setQuick] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ text: string; ok: string; run: () => Promise<void> } | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);

  const notify = (text: string, bad = false) => {
    setToast({ text, bad });
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 3200);
  };

  const load = useCallback(async () => {
    try {
      const [c, k, s, sm] = await Promise.all([
        api<{ files: FileC[]; groups: GroupC[]; cache: { name: string; rate: number }[] }>('context'),
        api<{ keys: KeyC[] }>('keys'),
        api<{ servers: ServerC[] }>('servers'),
        api<Summary>('summary'),
      ]);
      setFiles(c.files);
      setGroups(c.groups);
      setCache(c.cache);
      setKeys(k.keys);
      setServers(s.servers);
      setSummary(sm);
      setError(null);
      setLoaded(true);
      setExpanded((e) => (e.size ? e : new Set(c.groups.filter((g) => g.parentId === null).map((g) => g.id))));
      setSelGroup((g) => g ?? c.groups.find((x) => x.parentId === null)?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) notify(ok);
      await load();
      return true;
    } catch (e) {
      notify((e as Error).message, true);
      return false;
    }
  };

  // ---------- tabs ----------
  const tabTitle = (t: Tab): { title: string; icon: IconName; dirty?: boolean } => {
    if (t.kind === 'file') {
      const f = files.find((x) => x.id === t.ref);
      return { title: f?.name ?? 'Deleted file', icon: 'file', dirty: f ? drafts[t.ref] !== undefined && drafts[t.ref] !== f.body : false };
    }
    if (t.kind === 'group') return { title: groups.find((g) => g.id === t.ref)?.name ?? 'Deleted group', icon: 'folder' };
    if (t.kind === 'key') return { title: keys.find((k) => k.id === t.ref)?.name ?? 'Deleted key', icon: 'key' };
    if (t.kind === 'server') return { title: servers.find((s) => s.id === t.ref)?.name ?? 'Deleted server', icon: 'servers' };
    const labels = { overview: 'Overview', activity: 'Activity', guard: 'Guard checks', studio: 'Studio', settings: 'Settings', welcome: 'Welcome' } as const;
    const icons = { overview: 'overview', activity: 'activity', guard: 'guard', studio: 'studio', settings: 'settings', welcome: 'guard' } as const;
    return { title: labels[t.ref], icon: icons[t.ref] };
  };

  const open = (t: Tab) => {
    setTabs((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]));
    setActive(t.id);
    setHistory((h) => (h.list[h.at] === t.id ? h : { list: [...h.list.slice(0, h.at + 1), t.id], at: h.at + 1 }));
  };
  const close = (id: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      if (id === active) setActive(next[Math.max(0, i - 1)]?.id ?? '');
      return next;
    });
  };
  const go = (d: -1 | 1) => {
    const at = history.at + d;
    if (at < 0 || at >= history.list.length) return;
    const id = history.list[at];
    setHistory({ ...history, at });
    if (tabs.some((t) => t.id === id)) setActive(id);
  };
  const activeTab = tabs.find((t) => t.id === active) ?? null;

  const pickView = (v: View) => {
    if (v === view && showLeft) setShowLeft(false);
    else {
      setView(v);
      setShowLeft(true);
    }
    if (v === 'overview' || v === 'activity' || v === 'guard' || v === 'studio' || v === 'settings') open({ id: `page:${v}`, kind: 'page', ref: v });
  };

  // ---------- context editing ----------
  const saveFile = async (id: number) => {
    const body = drafts[id];
    if (body === undefined) return;
    if (
      await act(() => api(`context/${id}`, { method: 'PATCH', body: { body } }), 'Saved')
    )
      setDrafts((d) => {
        const n = { ...d };
        delete n[id];
        return n;
      });
  };
  const attach = (fileId: number, groupId: number) => {
    const g = groups.find((x) => x.id === groupId);
    if (!g) return;
    if (g.own.includes(fileId)) return notify(`Already in ${g.name}`);
    const mode = g.mode ?? (g.parentId === null ? 'set' : 'add');
    void act(() => api(`groups/${groupId}/settings`, { method: 'PUT', body: { key: 'context', setting: { mode, value: [...g.own, fileId] } } }), `Attached to ${g.name}`);
  };
  const detach = (fileId: number, groupId: number) => {
    const g = groups.find((x) => x.id === groupId);
    if (!g) return;
    const value = g.own.filter((x) => x !== fileId);
    void act(() => api(`groups/${groupId}/settings`, { method: 'PUT', body: { key: 'context', setting: value.length || g.parentId === null ? { mode: g.mode ?? 'set', value } : null } }), `Removed from ${g.name}`);
  };

  // ---------- create / rename ----------
  const submitCreate = async (name: string) => {
    if (!creating) return;
    const c = creating;
    setCreating(null);
    if (!name.trim()) return;
    if (c.kind === 'group') {
      await act(() => api('groups', { body: { name, parentId: c.parent ?? groups.find((g) => g.parentId === null)?.id } }), 'Group created');
      if (c.parent) setExpanded((e) => new Set(e).add(c.parent!));
    } else if (c.kind === 'file') {
      try {
        const f = await api<FileC>('context', { body: { name, body: `# ${name.replace(/\.md$/, '')}\n\n` } });
        if (c.parent) {
          const g = groups.find((x) => x.id === c.parent);
          if (g) await api(`groups/${g.id}/settings`, { method: 'PUT', body: { key: 'context', setting: { mode: g.mode ?? (g.parentId === null ? 'set' : 'add'), value: [...g.own, f.id] } } });
        }
        await load();
        open({ id: `file:${f.id}`, kind: 'file', ref: f.id });
        notify('File created');
      } catch (e) {
        notify((e as Error).message, true);
      }
    } else {
      const gid = c.parent ?? groups.find((g) => g.parentId === null)?.id;
      try {
        const r = await api<{ key: KeyC; secret: string }>('keys', { body: { name, owner: summary?.name ?? 'Admin', groupId: gid } });
        await load();
        setSecret({ name, value: r.secret });
        open({ id: `key:${r.key.id}`, kind: 'key', ref: r.key.id });
      } catch (e) {
        notify((e as Error).message, true);
      }
    }
  };
  const submitRename = async (name: string) => {
    if (!renaming) return;
    const r = renaming;
    setRenaming(null);
    if (!name.trim()) return;
    if (r.kind === 'file') await act(() => api(`context/${r.id}`, { method: 'PATCH', body: { name } }), 'Renamed');
    else await act(() => api(`groups/${r.id}`, { method: 'PATCH', body: { name } }), 'Renamed');
  };

  // ---------- keyboard ----------
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 's' && activeTab?.kind === 'file') {
        e.preventDefault();
        void saveFile(activeTab.ref);
      } else if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setQuick('');
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        if (e.altKey) setShowRight((v) => !v);
        else setShowLeft((v) => !v);
      } else if (e.key === 'Escape') {
        setQuick(null);
        setConfirm(null);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const root = groups.find((g) => g.parentId === null) ?? null;
  const selected = groups.find((g) => g.id === selGroup) ?? root;
  const childrenOf = (id: number | null) => groups.filter((g) => g.parentId === id);
  const unattached = files.filter((f) => !groups.some((g) => g.own.includes(f.id)));

  // ---------- sidebar tree ----------
  const toggle = (id: number) =>
    setExpanded((e) => {
      const n = new Set(e);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const InlineInput = ({ depth, icon, initial, onDone }: { depth: number; icon: IconName; initial?: string; onDone: (v: string) => void }) => (
    <div className="cx-row" style={{ paddingLeft: 8 + depth * 8 + 16 }}>
      <span className="cx-ico">
        <Ico n={icon} />
      </span>
      <input
        className="cx-inline"
        autoFocus
        defaultValue={initial}
        spellCheck={false}
        onBlur={(e) => onDone(e.target.value)}
        onKeyDown={(e: RKeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            (e.target as HTMLInputElement).value = '';
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );

  const fileRow = (f: FileC, depth: number, group?: GroupC) => {
    const id = `file:${f.id}`;
    if (renaming?.kind === 'file' && renaming.id === f.id) return <InlineInput key={id + group?.id} depth={depth} icon="file" initial={f.name} onDone={submitRename} />;
    return (
      <div
        key={`${id}:${group?.id ?? 'x'}`}
        className={`cx-row ${active === id ? 'sel' : ''}`}
        style={{ paddingLeft: 8 + depth * 8 + 16 }}
        draggable
        onDragStart={(e: DragEvent) => e.dataTransfer.setData('text/x-file', String(f.id))}
        onClick={() => open({ id, kind: 'file', ref: f.id })}
        onDoubleClick={() => setRenaming({ kind: 'file', id: f.id })}
        title={`${f.name} · ${f.tokens} tokens · drag onto a group to attach`}
      >
        <span className="cx-ico md">
          <Ico n="file" />
        </span>
        <span className="cx-label">{f.name}</span>
        {drafts[f.id] !== undefined && drafts[f.id] !== f.body && <span className="cx-dot" />}
        <span className="cx-meta">{fmtTokens(f.tokens)}</span>
        {group && (
          <button
            className="cx-row-act"
            title={`Remove from ${group.name}`}
            onClick={(e) => {
              e.stopPropagation();
              detach(f.id, group.id);
            }}
          >
            <Ico n="unlink" size={14} />
          </button>
        )}
      </div>
    );
  };

  const groupRow = (g: GroupC, depth: number): ReactNode => {
    const open_ = expanded.has(g.id);
    const kids = childrenOf(g.id);
    const ownFiles = view === 'context' ? g.own.map((id) => files.find((f) => f.id === id)).filter(Boolean as unknown as (f: FileC | undefined) => f is FileC) : [];
    const gKeys = view === 'keys' ? keys.filter((k) => k.groupId === g.id) : [];
    const hasKids = kids.length > 0 || ownFiles.length > 0 || gKeys.length > 0 || (creating?.parent === g.id);
    const badge = view === 'keys' ? g.keyCount : view === 'context' ? g.own.length : null;
    return (
      <div key={`g${g.id}`}>
        {renaming?.kind === 'group' && renaming.id === g.id ? (
          <InlineInput depth={depth} icon="folder" initial={g.name} onDone={submitRename} />
        ) : (
          <div
            className={`cx-row ${selGroup === g.id ? (activeTab?.kind === 'file' || activeTab?.kind === 'key' ? 'sel-soft' : 'sel') : ''}`}
            style={{ paddingLeft: 8 + depth * 8 }}
            onClick={() => {
              setSelGroup(g.id);
              if (view === 'groups') open({ id: `group:${g.id}`, kind: 'group', ref: g.id });
              if (hasKids && !open_) toggle(g.id);
            }}
            onDoubleClick={() => g.parentId !== null && setRenaming({ kind: 'group', id: g.id })}
            onDragOver={(e) => view === 'context' && e.preventDefault()}
            onDragEnter={(e) => (e.currentTarget as HTMLElement).classList.add('drop')}
            onDragLeave={(e) => (e.currentTarget as HTMLElement).classList.remove('drop')}
            onDrop={(e) => {
              (e.currentTarget as HTMLElement).classList.remove('drop');
              const fid = Number(e.dataTransfer.getData('text/x-file'));
              if (fid) attach(fid, g.id);
            }}
          >
            <span
              className={`cx-twist ${open_ ? 'open' : ''} ${hasKids ? '' : 'none'}`}
              onClick={(e) => {
                e.stopPropagation();
                toggle(g.id);
              }}
            >
              <Ico n="chevron" size={14} />
            </span>
            <span className="cx-ico folder">
              <Ico n={open_ && hasKids ? 'folderOpen' : 'folder'} />
            </span>
            <span className="cx-label">{g.name}</span>
            {badge !== null && badge > 0 && <span className="cx-badge">{badge}</span>}
          </div>
        )}
        {open_ && (
          <>
            {creating?.parent === g.id && creating.kind === 'group' && <InlineInput depth={depth + 1} icon="folder" onDone={submitCreate} />}
            {kids.map((k) => groupRow(k, depth + 1))}
            {creating?.parent === g.id && creating.kind === 'file' && <InlineInput depth={depth + 1} icon="file" onDone={submitCreate} />}
            {ownFiles.map((f) => fileRow(f, depth + 1, g))}
            {creating?.parent === g.id && creating.kind === 'key' && <InlineInput depth={depth + 1} icon="key" onDone={submitCreate} />}
            {gKeys.map((k) => (
              <div key={`k${k.id}`} className={`cx-row ${active === `key:${k.id}` ? 'sel' : ''} ${k.revoked ? 'dim' : ''}`} style={{ paddingLeft: 8 + (depth + 1) * 8 + 16 }} onClick={() => open({ id: `key:${k.id}`, kind: 'key', ref: k.id })}>
                <span className="cx-ico key">
                  <Ico n="key" />
                </span>
                <span className="cx-label">{k.name}</span>
                <span className="cx-meta mono">{k.prefix}…</span>
              </div>
            ))}
          </>
        )}
      </div>
    );
  };

  const headerActions: { icon: IconName; title: string; run: () => void }[] = [];
  const parentForNew = selected?.id ?? null;
  if (view === 'context') {
    headerActions.push({ icon: 'newFile', title: 'New context file in the selected group', run: () => (setCreating({ kind: 'file', parent: ctxMode === 'groups' ? parentForNew : null }), parentForNew && setExpanded((e) => new Set(e).add(parentForNew))) });
    headerActions.push({ icon: 'newFolder', title: 'New group inside the selected group', run: () => (setCreating({ kind: 'group', parent: parentForNew }), parentForNew && setExpanded((e) => new Set(e).add(parentForNew))) });
    headerActions.push({ icon: ctxMode === 'groups' ? 'list' : 'tree', title: ctxMode === 'groups' ? 'Show all files' : 'Show files by group', run: () => setCtxMode((m) => (m === 'groups' ? 'all' : 'groups')) });
  }
  if (view === 'groups') headerActions.push({ icon: 'newFolder', title: 'New group inside the selected group', run: () => (setCreating({ kind: 'group', parent: parentForNew }), parentForNew && setExpanded((e) => new Set(e).add(parentForNew))) });
  if (view === 'keys') headerActions.push({ icon: 'plus', title: 'New API key in the selected group', run: () => (setCreating({ kind: 'key', parent: parentForNew }), parentForNew && setExpanded((e) => new Set(e).add(parentForNew))) });
  headerActions.push({ icon: 'refresh', title: 'Refresh', run: () => void load().then(() => notify('Refreshed')) });
  headerActions.push({ icon: 'collapse', title: 'Collapse all', run: () => setExpanded(new Set(root ? [root.id] : [])) });

  const sidebar = (
    <aside className="cx-side" style={{ width: leftW }}>
      <div className="cx-side-head">
        <span>{VIEW_LABEL[view].toUpperCase()}</span>
        <div className="cx-side-acts">
          {headerActions.map((a) => (
            <button key={a.title} title={a.title} aria-label={a.title} onClick={a.run}>
              <Ico n={a.icon} />
            </button>
          ))}
        </div>
      </div>
      <div className="cx-side-body">
        {!loaded && !error && <div className="cx-empty">Loading…</div>}
        {error && <div className="cx-empty bad">{error}</div>}
        {loaded && view === 'servers' && (
          <>
            <div className="cx-section">SERVERS</div>
            {servers.length === 0 && <div className="cx-empty">No servers yet. Add one from Settings → Add a server.</div>}
            {servers.map((s) => (
              <div key={s.id}>
                <div className={`cx-row ${active === `server:${s.id}` ? 'sel' : ''}`} style={{ paddingLeft: 8 }} onClick={() => open({ id: `server:${s.id}`, kind: 'server', ref: s.id })}>
                  <span className={`cx-sdot ${s.status}`} />
                  <span className="cx-label">{s.name}</span>
                  <span className="cx-meta">{s.role === 'guard' ? 'guard' : `${s.models.filter((m) => m.enabled).length} models`}</span>
                </div>
              </div>
            ))}
          </>
        )}
        {loaded && view !== 'servers' && (view !== 'context' || ctxMode === 'groups') && (
          <>
            <div className="cx-section">{view === 'keys' ? `GROUPS · ${keys.length} KEYS` : view === 'context' ? 'GROUPS' : 'GROUPS'}</div>
            {root && groupRow(root, 0)}
            {view === 'context' && (
              <>
                <div className="cx-section" style={{ marginTop: 8 }}>
                  NOT IN ANY GROUP <span className="cx-badge">{unattached.length}</span>
                </div>
                {creating?.kind === 'file' && creating.parent === null && <InlineInput depth={0} icon="file" onDone={submitCreate} />}
                {unattached.length === 0 && !creating && <div className="cx-empty small">Every file is attached to a group.</div>}
                {unattached.map((f) => fileRow(f, 0))}
              </>
            )}
          </>
        )}
        {loaded && view === 'context' && ctxMode === 'all' && (
          <>
            <div className="cx-section">ALL FILES · {files.length}</div>
            {creating?.kind === 'file' && <InlineInput depth={0} icon="file" onDone={submitCreate} />}
            {files.length === 0 && !creating && <div className="cx-empty">No context files yet.</div>}
            {files.map((f) => fileRow(f, 0))}
          </>
        )}
      </div>
    </aside>
  );

  // ---------- editor ----------
  const crumbs = (): string[] => {
    if (!activeTab) return [];
    if (activeTab.kind === 'file') {
      const f = files.find((x) => x.id === activeTab.ref);
      const g = groups.find((x) => x.own.includes(activeTab.ref));
      return ['context', ...(g ? g.path.split(' / ') : ['not in any group']), f?.name ?? ''];
    }
    if (activeTab.kind === 'group') return ['groups', ...(groups.find((g) => g.id === activeTab.ref)?.path.split(' / ') ?? [])];
    if (activeTab.kind === 'key') {
      const k = keys.find((x) => x.id === activeTab.ref);
      return ['keys', ...(k?.groupPath.split(' / ') ?? []), k?.name ?? ''];
    }
    if (activeTab.kind === 'server') return ['servers', servers.find((s) => s.id === activeTab.ref)?.name ?? ''];
    return [tabTitle(activeTab).title.toLowerCase(), ...(activeTab.ref !== 'welcome' && selected ? [selected.name] : [])];
  };

  let editor: ReactNode = <Welcome onOpen={(v) => pickView(v)} />;
  if (activeTab?.kind === 'file') {
    const f = files.find((x) => x.id === activeTab.ref);
    editor = f ? (
      <FileEditor
        file={f}
        text={drafts[f.id] ?? f.body}
        preview={!!preview[f.id]}
        onChange={(t) => setDrafts((d) => ({ ...d, [f.id]: t }))}
        onCursor={setCursor}
      />
    ) : (
      <div className="cx-empty">This file was deleted.</div>
    );
  } else if (activeTab?.kind === 'group') {
    editor = <GroupPage id={activeTab.ref} groups={groups} files={files} keys={keys} onOpenFile={(id) => open({ id: `file:${id}`, kind: 'file', ref: id })} />;
  } else if (activeTab?.kind === 'key') {
    const k = keys.find((x) => x.id === activeTab.ref);
    editor = k ? <KeyPage k={k} act={act} ask={setConfirm} /> : <div className="cx-empty">This key was deleted.</div>;
  } else if (activeTab?.kind === 'server') {
    const s = servers.find((x) => x.id === activeTab.ref);
    editor = s ? <ServerPage s={s} /> : <div className="cx-empty">This server was removed.</div>;
  } else if (activeTab?.kind === 'page') {
    if (activeTab.ref === 'overview') editor = <OverviewPage group={selected} groups={groups} />;
    if (activeTab.ref === 'activity') editor = <ActivityPage group={selected} groups={groups} />;
    if (activeTab.ref === 'guard') editor = <GuardPage group={selected} />;
    if (activeTab.ref === 'studio') editor = <LinkPage title="Studio" text="Send test requests through the gateway as any key and watch every guard stage. The new Studio moves here next; for now it opens the current page." href="/studio" />;
    if (activeTab.ref === 'settings') editor = <SettingsPage />;
  }

  const fileTab = activeTab?.kind === 'file' ? files.find((x) => x.id === activeTab.ref) : null;
  const dirtyActive = fileTab ? drafts[fileTab.id] !== undefined && drafts[fileTab.id] !== fileTab.body : false;

  // ---------- quick open ----------
  const quickItems = useMemo(() => {
    if (quick === null) return [];
    const q = quick.toLowerCase();
    const items: { label: string; hint: string; icon: IconName; run: () => void }[] = [
      ...files.map((f) => ({ label: f.name, hint: 'context file', icon: 'file' as IconName, run: () => (setView('context'), open({ id: `file:${f.id}`, kind: 'file', ref: f.id })) })),
      ...groups.map((g) => ({ label: g.name, hint: g.path, icon: 'folder' as IconName, run: () => (setSelGroup(g.id), setView('groups'), open({ id: `group:${g.id}`, kind: 'group', ref: g.id })) })),
      ...keys.map((k) => ({ label: k.name, hint: `key · ${k.groupPath}`, icon: 'key' as IconName, run: () => (setView('keys'), open({ id: `key:${k.id}`, kind: 'key', ref: k.id })) })),
      ...servers.map((s) => ({ label: s.name, hint: `server · ${s.url}`, icon: 'servers' as IconName, run: () => (setView('servers'), open({ id: `server:${s.id}`, kind: 'server', ref: s.id })) })),
    ];
    return items.filter((i) => !q || i.label.toLowerCase().includes(q) || i.hint.toLowerCase().includes(q)).slice(0, 12);
  }, [quick, files, groups, keys, servers]);

  return (
    <div className="cx">
      {/* ---------- title bar ---------- */}
      <header className="cx-title">
        <div className="cx-brand">
          <Ico n="guard" size={16} stroke={2} />
          <span>GuardRail</span>
        </div>
        <div className="cx-title-center">
          <button className="cx-tbtn" title="Back" onClick={() => go(-1)} disabled={history.at === 0}>
            <Ico n="back" />
          </button>
          <button className="cx-tbtn" title="Forward" onClick={() => go(1)} disabled={history.at >= history.list.length - 1}>
            <Ico n="forward" />
          </button>
          <button className="cx-command" onClick={() => setQuick('')}>
            <Ico n="search" size={14} />
            <span>Search files, groups, keys, servers</span>
            <kbd>⌘P</kbd>
          </button>
          <button
            className="cx-tbtn cx-blocked"
            title={`Blocked requests today: ${summary?.blockedToday ?? 0}. Open in Activity.`}
            onClick={() => (setView('activity'), open({ id: 'page:activity', kind: 'page', ref: 'activity' }))}
          >
            <Ico n="blocked" />
            {!!summary?.blockedToday && <span className="cx-count">{summary.blockedToday > 99 ? '99+' : summary.blockedToday}</span>}
          </button>
        </div>
        <div className="cx-title-right">
          <button className={`cx-tbtn ${showLeft ? 'on' : ''}`} title="Toggle primary sidebar (⌘B)" onClick={() => setShowLeft(!showLeft)}>
            <Ico n="sidebarLeft" />
          </button>
          <button className={`cx-tbtn ${showRight ? 'on' : ''}`} title="Toggle secondary sidebar (⌥⌘B)" onClick={() => setShowRight(!showRight)}>
            <Ico n="sidebarRight" />
          </button>
        </div>
      </header>

      <div className="cx-body">
        {/* ---------- activity bar ---------- */}
        <nav className="cx-activity" aria-label="Views">
          {ACTIVITY.map((a) => (
            <button key={a.id} className={`cx-act ${view === a.id && showLeft ? 'on' : ''}`} title={a.label} aria-label={a.label} onClick={() => pickView(a.id)}>
              <Ico n={a.icon} size={24} stroke={1.5} />
              {a.id === 'activity' && !!summary?.blockedToday && <span className="cx-act-badge">{summary.blockedToday > 99 ? '99+' : summary.blockedToday}</span>}
            </button>
          ))}
          <div className="cx-grow" />
          <button className={`cx-act ${view === 'studio' && showLeft ? 'on' : ''}`} title="Studio: send test requests" aria-label="Studio" onClick={() => pickView('studio')}>
            <Ico n="studio" size={24} stroke={1.5} />
          </button>
          <AccountButton name={summary?.name ?? 'Admin'} auth={!!summary?.authEnabled} />
          <button className={`cx-act ${view === 'settings' && showLeft ? 'on' : ''}`} title="Settings" aria-label="Settings" onClick={() => pickView('settings')}>
            <Ico n="settings" size={24} stroke={1.5} />
          </button>
        </nav>

        {showLeft && (
          <>
            {sidebar}
            <Sash onDrag={(d) => setLeftW((w) => Math.min(560, Math.max(180, w + d)))} />
          </>
        )}

        {/* ---------- editor ---------- */}
        <main className="cx-editor">
          {tabs.length > 0 && (
            <div className="cx-tabs" role="tablist">
              {tabs.map((t) => {
                const tt = tabTitle(t);
                return (
                  <div
                    key={t.id}
                    role="tab"
                    aria-selected={t.id === active}
                    className={`cx-tab ${t.id === active ? 'on' : ''}`}
                    onClick={() => setActive(t.id)}
                    onMouseDown={(e) => e.button === 1 && close(t.id)}
                  >
                    <span className={`cx-ico ${tt.icon === 'file' ? 'md' : tt.icon === 'folder' ? 'folder' : ''}`}>
                      <Ico n={tt.icon} size={15} />
                    </span>
                    <span className="cx-tab-label">{tt.title}</span>
                    <button
                      className={`cx-tab-x ${tt.dirty ? 'dirty' : ''}`}
                      title="Close"
                      onClick={(e) => {
                        e.stopPropagation();
                        close(t.id);
                      }}
                    >
                      <Ico n="close" size={14} />
                    </button>
                  </div>
                );
              })}
              <div className="cx-grow" />
              {fileTab && (
                <div className="cx-tab-acts">
                  <button title={dirtyActive ? 'Save (⌘S)' : 'Saved'} disabled={!dirtyActive} onClick={() => saveFile(fileTab.id)}>
                    <Ico n="save" />
                  </button>
                  <button
                    title={preview[fileTab.id] ? 'Edit as text' : 'Open rendered Markdown'}
                    className={preview[fileTab.id] ? 'on' : ''}
                    onClick={() => setPreview((p) => ({ ...p, [fileTab.id]: !p[fileTab.id] }))}
                  >
                    <Ico n={preview[fileTab.id] ? 'code' : 'preview'} />
                  </button>
                  <button
                    title="Delete file"
                    onClick={() =>
                      setConfirm({
                        text: `Delete ${fileTab.name}? Groups that use it stop sending it to the model.`,
                        ok: 'Delete',
                        run: async () => {
                          if (await act(() => api(`context/${fileTab.id}`, { method: 'DELETE' }), 'File deleted')) close(`file:${fileTab.id}`);
                        },
                      })
                    }
                  >
                    <Ico n="trash" />
                  </button>
                </div>
              )}
            </div>
          )}
          {activeTab && (
            <div className="cx-crumbs">
              {crumbs().map((c, i, a) => (
                <span key={i}>
                  {c}
                  {i < a.length - 1 && <Ico n="chevron" size={12} />}
                </span>
              ))}
            </div>
          )}
          <div className="cx-pane">{activeTab ? editor : <Welcome onOpen={(v) => pickView(v)} />}</div>
        </main>

        {showRight && (
          <>
            <Sash onDrag={(d) => setRightW((w) => Math.min(560, Math.max(220, w - d)))} />
            <aside className="cx-side cx-right" style={{ width: rightW }}>
              <div className="cx-side-head">
                <span>{fileTab ? 'FILE' : 'GROUP'} DETAILS</span>
              </div>
              <div className="cx-side-body">
                {fileTab ? (
                  <FileStats file={fileTab} groups={groups} keys={keys} onAttach={(gid) => attach(fileTab.id, gid)} onDetach={(gid) => detach(fileTab.id, gid)} />
                ) : selected ? (
                  <GroupStats g={selected} groups={groups} files={files} keys={keys} cache={cache} onOpenFile={(id) => (setView('context'), open({ id: `file:${id}`, kind: 'file', ref: id }))} />
                ) : (
                  <div className="cx-empty">Pick a group.</div>
                )}
              </div>
            </aside>
          </>
        )}
      </div>

      {/* ---------- status bar ---------- */}
      <footer className="cx-status">
        <span className="cx-status-brand">
          <Ico n="guard" size={13} stroke={2} /> GuardRail
        </span>
        <span title="Inference servers online">
          <span className={`cx-status-dot ${summary && summary.servers && summary.online === summary.servers ? 'ok' : summary?.servers ? 'warn' : ''}`} />
          {summary ? `${summary.online}/${summary.servers} servers online` : '…'}
        </span>
        <span title="Guard checks">
          <Ico n={summary?.guard ? 'guard' : 'shieldOff'} size={13} /> Guard {summary?.guard ? 'on' : 'off'}
        </span>
        <span>
          <Ico n="blocked" size={13} /> {summary?.blockedToday ?? 0} blocked today
        </span>
        <div className="cx-grow" />
        {fileTab && !preview[fileTab.id] && (
          <span>
            Ln {cursor.ln}, Col {cursor.col}
          </span>
        )}
        {fileTab && <span>Markdown</span>}
        <span>
          <Ico n="folder" size={13} /> {selected?.name ?? '—'}
        </span>
        <span>
          {summary?.groups ?? 0} groups · {summary?.keys ?? 0} keys
        </span>
      </footer>

      {quick !== null && (
        <div className="cx-quick-wrap" onMouseDown={() => setQuick(null)}>
          <div className="cx-quick" onMouseDown={(e) => e.stopPropagation()}>
            <input
              autoFocus
              value={quick}
              placeholder="Search files, groups, keys and servers by name"
              onChange={(e) => setQuick(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && quickItems[0]) {
                  quickItems[0].run();
                  setQuick(null);
                }
              }}
            />
            <div className="cx-quick-list">
              {quickItems.length === 0 && <div className="cx-empty small">Nothing matches.</div>}
              {quickItems.map((i, n) => (
                <button
                  key={n}
                  className="cx-quick-item"
                  onClick={() => {
                    i.run();
                    setQuick(null);
                  }}
                >
                  <Ico n={i.icon} size={15} />
                  <span>{i.label}</span>
                  <span className="cx-meta">{i.hint}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <div className="cx-quick-wrap" onMouseDown={() => setConfirm(null)}>
          <div className="cx-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <p>{confirm.text}</p>
            <div className="cx-dialog-acts">
              <button className="cx-btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="cx-btn danger"
                autoFocus
                onClick={async () => {
                  const c = confirm;
                  setConfirm(null);
                  await c.run();
                }}
              >
                {confirm.ok}
              </button>
            </div>
          </div>
        </div>
      )}

      {secret && (
        <div className="cx-quick-wrap">
          <div className="cx-dialog">
            <p>
              <b>{secret.name}</b> was created. Copy the key now: it is shown only once.
            </p>
            <code className="cx-secret">{secret.value}</code>
            <div className="cx-dialog-acts">
              <button className="cx-btn" onClick={() => void navigator.clipboard.writeText(secret.value).then(() => notify('Key copied'), () => notify('Copy blocked: select the key and copy it', true))}>
                Copy
              </button>
              <button className="cx-btn pri" onClick={() => setSecret(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`cx-toast ${toast.bad ? 'bad' : ''}`}>{toast.text}</div>}
    </div>
  );
}

// ======================================================================================

function Sash({ onDrag }: { onDrag: (dx: number) => void }) {
  return (
    <div
      className="cx-sash"
      onMouseDown={(e) => {
        e.preventDefault();
        let x = e.clientX;
        const move = (ev: MouseEvent) => {
          onDrag(ev.clientX - x);
          x = ev.clientX;
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          document.body.style.cursor = '';
        };
        document.body.style.cursor = 'ew-resize';
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
    />
  );
}

function AccountButton({ name, auth }: { name: string; auth: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="cx-acc">
      <button className={`cx-act ${open ? 'on' : ''}`} title={`Signed in as ${name}`} aria-label="Account" onClick={() => setOpen(!open)}>
        <span className="cx-avatar">{name.slice(0, 2).toUpperCase()}</span>
      </button>
      {open && (
        <div className="cx-menu" onMouseLeave={() => setOpen(false)}>
          <div className="cx-menu-head">{name}</div>
          <Link className="cx-menu-item" href="/">
            Open classic admin panel
          </Link>
          {auth && (
            <button
              className="cx-menu-item"
              onClick={async () => {
                await fetch('/api/auth/logout', { method: 'POST' });
                window.location.href = '/login';
              }}
            >
              Sign out
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Welcome({ onOpen }: { onOpen: (v: View) => void }) {
  return (
    <div className="cx-welcome">
      <div className="cx-welcome-mark">
        <Ico n="guard" size={72} stroke={0.9} />
      </div>
      <h1>GuardRail</h1>
      <p>Security gateway for your vLLM servers.</p>
      <div className="cx-welcome-grid">
        {(
          [
            ['context', 'Context files', 'Write the instructions each group sends with every request.'],
            ['keys', 'API keys', 'Give people keys and decide which group they belong to.'],
            ['groups', 'Groups', 'Shape access, models and checks as a tree that inherits.'],
            ['activity', 'Activity', 'See every request and why a check blocked it.'],
          ] as [View, string, string][]
        ).map(([v, t, d]) => (
          <button key={v} className="cx-welcome-card" onClick={() => onOpen(v)}>
            <b>{t}</b>
            <span>{d}</span>
          </button>
        ))}
      </div>
      <p className="cx-welcome-keys">
        <kbd>⌘P</kbd> search · <kbd>⌘S</kbd> save · <kbd>⌘B</kbd> sidebar · drag a file onto a group to attach it
      </p>
    </div>
  );
}

function FileEditor({ file, text, preview, onChange, onCursor }: { file: FileC; text: string; preview: boolean; onChange: (t: string) => void; onCursor: (c: { ln: number; col: number }) => void }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = text.split('\n').length;
  const [curLine, setCurLine] = useState(1);
  const track = () => {
    const el = ta.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    const ln = before.split('\n').length;
    setCurLine(ln);
    onCursor({ ln, col: before.length - before.lastIndexOf('\n') });
  };
  if (preview) return <article className="cx-md" key={`p${file.id}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
  return (
    <div className="cx-code">
      <div className="cx-gutter" ref={gutter} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={i + 1 === curLine ? 'cur' : ''}>
            {i + 1}
          </div>
        ))}
      </div>
      <textarea
        ref={ta}
        key={file.id}
        className="cx-textarea"
        value={text}
        spellCheck={false}
        wrap="off"
        onChange={(e) => {
          onChange(e.target.value);
          track();
        }}
        onKeyUp={track}
        onClick={track}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            const el = e.currentTarget;
            const s = el.selectionStart;
            const v = el.value.slice(0, s) + '  ' + el.value.slice(el.selectionEnd);
            onChange(v);
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
          }
        }}
        aria-label={`Edit ${file.name}`}
      />
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="cx-stat" title={hint}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function GroupStats({ g, groups, files, keys, cache, onOpenFile }: { g: GroupC; groups: GroupC[]; files: FileC[]; keys: KeyC[]; cache: { name: string; rate: number }[]; onOpenFile: (id: number) => void }) {
  const eff = g.context.map((id) => files.find((f) => f.id === id)).filter((f): f is FileC => !!f);
  const tokens = eff.reduce((a, f) => a + f.tokens, 0);
  const inherited = eff.filter((f) => !g.own.includes(f.id));
  const reach = subtree(g.id, groups);
  const reachKeys = keys.filter((k) => reach.has(k.groupId) && !k.revoked);
  const rate = cache.length ? cache.reduce((a, c) => a + c.rate, 0) / cache.length : null;
  const today = reachKeys.reduce((a, k) => a + k.requestsToday, 0);
  return (
    <div className="cx-details">
      <div className="cx-details-title">
        <Ico n="folder" /> {g.name}
      </div>
      {g.description && <p className="cx-muted">{g.description}</p>}
      <div className="cx-stats">
        <Stat label="Context files" value={eff.length} hint="Files every request from this group carries, including inherited ones" />
        <Stat label="Context tokens" value={fmtTokens(tokens)} hint="Approximate tokens added to each request" />
        <Stat label="Own / inherited" value={`${g.own.length} / ${inherited.length}`} />
        <Stat label="Prefix cache hit" value={rate === null ? '—' : `${Math.round(rate * 100)}%`} hint="vLLM prefix cache hit rate across inference servers" />
        <Stat label="Keys that get it" value={reachKeys.length} hint="Active keys in this group and its sub-groups" />
        <Stat label="Requests today" value={today} />
      </div>
      <div className="cx-details-sec">FILES SENT</div>
      {eff.length === 0 && <div className="cx-empty small">No context files. Drag a file onto this group in the sidebar.</div>}
      {eff.map((f) => (
        <button key={f.id} className="cx-li" onClick={() => onOpenFile(f.id)}>
          <span className="cx-ico md">
            <Ico n="file" size={14} />
          </span>
          <span className="cx-label">{f.name}</span>
          <span className="cx-meta">{g.own.includes(f.id) ? fmtTokens(f.tokens) : 'inherited'}</span>
        </button>
      ))}
      <div className="cx-details-sec">KEYS THAT GET IT</div>
      {reachKeys.length === 0 && <div className="cx-empty small">No active keys in this group yet.</div>}
      {reachKeys.slice(0, 30).map((k) => (
        <div key={k.id} className="cx-li static">
          <span className="cx-ico key">
            <Ico n="key" size={14} />
          </span>
          <span className="cx-label">{k.name}</span>
          <span className="cx-meta">{k.owner}</span>
        </div>
      ))}
      {cache.length > 0 && (
        <>
          <div className="cx-details-sec">CACHE BY SERVER</div>
          {cache.map((c) => (
            <div key={c.name} className="cx-bar-row">
              <span>{c.name}</span>
              <span className="cx-bar">
                <i style={{ width: `${Math.round(c.rate * 100)}%` }} />
              </span>
              <span className="cx-meta">{Math.round(c.rate * 100)}%</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function FileStats({ file, groups, keys, onAttach, onDetach }: { file: FileC; groups: GroupC[]; keys: KeyC[]; onAttach: (gid: number) => void; onDetach: (gid: number) => void }) {
  const attached = groups.filter((g) => g.own.includes(file.id));
  const reached = groups.filter((g) => g.context.includes(file.id));
  const reachKeys = keys.filter((k) => reached.some((g) => g.id === k.groupId) && !k.revoked);
  const [pick, setPick] = useState('');
  return (
    <div className="cx-details">
      <div className="cx-details-title">
        <Ico n="file" /> {file.name}
      </div>
      <div className="cx-stats">
        <Stat label="Tokens" value={fmtTokens(file.tokens)} />
        <Stat label="Version" value={`v${file.version}`} />
        <Stat label="Groups reached" value={reached.length} hint="Groups that send this file, directly or by inheritance" />
        <Stat label="Keys reached" value={reachKeys.length} />
        <Stat label="Lines" value={file.body.split('\n').length} />
        <Stat label="Edited" value={ago(file.updated_at)} />
      </div>
      <div className="cx-details-sec">ATTACHED TO</div>
      {attached.length === 0 && <div className="cx-empty small">Not attached to any group, so no request carries it.</div>}
      {attached.map((g) => (
        <div key={g.id} className="cx-li static">
          <span className="cx-ico folder">
            <Ico n="folder" size={14} />
          </span>
          <span className="cx-label">{g.path}</span>
          <button className="cx-row-act show" title={`Remove from ${g.name}`} onClick={() => onDetach(g.id)}>
            <Ico n="unlink" size={14} />
          </button>
        </div>
      ))}
      <div className="cx-attach">
        <select id="attach-group" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Attach to group">
          <option value="">Attach to a group…</option>
          {groups
            .filter((g) => !g.own.includes(file.id))
            .map((g) => (
              <option key={g.id} value={g.id}>
                {' '.repeat(g.depth * 2)}
                {g.name}
              </option>
            ))}
        </select>
        <button
          className="cx-btn pri"
          disabled={!pick}
          onClick={() => {
            onAttach(Number(pick));
            setPick('');
          }}
        >
          Attach
        </button>
      </div>
      {reached.length > attached.length && (
        <>
          <div className="cx-details-sec">INHERITED BY</div>
          {reached
            .filter((g) => !g.own.includes(file.id))
            .map((g) => (
              <div key={g.id} className="cx-li static">
                <span className="cx-ico folder">
                  <Ico n="folder" size={14} />
                </span>
                <span className="cx-label">{g.path}</span>
              </div>
            ))}
        </>
      )}
    </div>
  );
}

function GroupPage({ id, groups, files, keys, onOpenFile }: { id: number; groups: GroupC[]; files: FileC[]; keys: KeyC[]; onOpenFile: (id: number) => void }) {
  const [res, setRes] = useState<Resolution | null>(null);
  const g = groups.find((x) => x.id === id);
  useEffect(() => {
    api<{ resolution: Resolution }>(`groups/${id}`).then((r) => setRes(r.resolution), () => setRes(null));
  }, [id, groups]);
  if (!g) return <div className="cx-empty">This group was deleted.</div>;
  const e = res?.effective;
  const rows: [string, ReactNode][] = e
    ? [
        ['Servers', e.servers === null ? 'Every server' : `${e.servers.length} server(s)`],
        ['Models', e.models.includes('*') ? 'Every enabled model' : e.models.join(', ') || 'None'],
        ['Context files', e.context.map((c) => files.find((f) => f.id === c)?.name).filter(Boolean).join(', ') || 'None'],
        ['PIGuard check', e.piguard_enabled ? `On, flags at ${e.piguard_threshold}` : 'Off'],
        ['Second check (OSS)', e.oss_enabled ? 'On' : 'Off'],
        ['Rate limit', `${e.rate_limit} requests/min`],
      ]
    : [];
  return (
    <div className="cx-page">
      <h2>
        <Ico n="folder" size={20} /> {g.name}
      </h2>
      <p className="cx-muted">{g.path}</p>
      {g.description && <p>{g.description}</p>}
      <div className="cx-stats wide">
        <Stat label="Sub-groups" value={g.childCount} />
        <Stat label="Keys" value={g.keyCount} />
        <Stat label="Own context files" value={g.own.length} />
      </div>
      <h3>Effective settings</h3>
      <p className="cx-muted">What a key in this group gets after inheriting from its parents.</p>
      <table className="cx-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Own context files</h3>
      {g.own.length === 0 && <p className="cx-muted">None. Drag a file onto this group in the Context files view.</p>}
      {g.own.map((fid) => {
        const f = files.find((x) => x.id === fid);
        return f ? (
          <button key={fid} className="cx-li" onClick={() => onOpenFile(fid)}>
            <span className="cx-ico md">
              <Ico n="file" size={14} />
            </span>
            <span className="cx-label">{f.name}</span>
            <span className="cx-meta">{fmtTokens(f.tokens)} tokens</span>
          </button>
        ) : null;
      })}
      <h3>Keys</h3>
      {keys.filter((k) => k.groupId === id).length === 0 && <p className="cx-muted">No keys in this group.</p>}
      {keys
        .filter((k) => k.groupId === id)
        .map((k) => (
          <div key={k.id} className="cx-li static">
            <span className="cx-ico key">
              <Ico n="key" size={14} />
            </span>
            <span className="cx-label">{k.name}</span>
            <span className="cx-meta">{k.owner}</span>
          </div>
        ))}
    </div>
  );
}

function KeyPage({ k, act, ask }: { k: KeyC; act: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>; ask: (c: { text: string; ok: string; run: () => Promise<void> }) => void }) {
  return (
    <div className="cx-page">
      <h2>
        <Ico n="key" size={20} /> {k.name} {k.revoked && <span className="cx-pill bad">Revoked</span>}
      </h2>
      <p className="cx-muted">{k.groupPath}</p>
      <table className="cx-table">
        <tbody>
          <tr>
            <td>Key</td>
            <td className="mono">{k.prefix}…</td>
          </tr>
          <tr>
            <td>Owner</td>
            <td>{k.owner}</td>
          </tr>
          <tr>
            <td>Created</td>
            <td>{new Date(k.createdAt).toLocaleString()}</td>
          </tr>
          <tr>
            <td>Last used</td>
            <td>{ago(k.lastUsedAt)}</td>
          </tr>
          <tr>
            <td>Requests today</td>
            <td>{k.requestsToday}</td>
          </tr>
          <tr>
            <td>Expires</td>
            <td>{k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : 'Never'}</td>
          </tr>
        </tbody>
      </table>
      <div className="cx-row-btns">
        <button className="cx-btn" onClick={() => act(() => api(`keys/${k.id}`, { method: 'PATCH', body: { revoked: !k.revoked } }), k.revoked ? 'Key restored' : 'Key revoked')}>
          {k.revoked ? 'Restore key' : 'Revoke key'}
        </button>
        <button className="cx-btn danger" onClick={() => ask({ text: `Delete ${k.name}? Anyone using it is cut off immediately.`, ok: 'Delete key', run: async () => void (await act(() => api(`keys/${k.id}`, { method: 'DELETE' }), 'Key deleted')) })}>
          Delete key
        </button>
      </div>
    </div>
  );
}

function ServerPage({ s }: { s: ServerC }) {
  return (
    <div className="cx-page">
      <h2>
        <span className={`cx-sdot ${s.status}`} /> {s.name}
      </h2>
      <p className="cx-muted mono">{s.url}</p>
      <div className="cx-stats wide">
        <Stat label="Status" value={s.status} />
        <Stat label="Latency" value={s.latency_ms === null ? '—' : `${s.latency_ms} ms`} />
        <Stat label="Prefix cache hit" value={s.cache_hit_rate === null ? '—' : `${Math.round(s.cache_hit_rate * 100)}%`} />
      </div>
      <h3>Models</h3>
      <table className="cx-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Context</th>
            <th>Price in / out per 1M</th>
            <th>Clients</th>
          </tr>
        </thead>
        <tbody>
          {s.models.map((m) => (
            <tr key={m.id}>
              <td className="mono">{m.name}</td>
              <td>{m.context_len ? fmtTokens(m.context_len) : '—'}</td>
              <td>{m.price_in != null || m.price_out != null ? `$${m.price_in ?? 0} / $${m.price_out ?? 0}` : '—'}</td>
              <td>{m.enabled ? 'Allowed' : 'Hidden'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OverviewPage({ group, groups }: { group: GroupC | null; groups: GroupC[] }) {
  const [d, setD] = useState<{ counts: Record<string, number>; buckets: { label: string; total: number; blocked: number }[]; overheadP95: number | null; recentBlocks: LogC[] } | null>(null);
  useEffect(() => {
    api<typeof d>('overview?range=24h').then(setD, () => setD(null));
  }, []);
  const ids = group ? subtree(group.id, groups) : null;
  const max = Math.max(1, ...(d?.buckets.map((b) => b.total) ?? [1]));
  const blocks = (d?.recentBlocks ?? []).filter((l) => !ids || group?.parentId === null || (l.group_id !== null && ids.has(l.group_id)));
  return (
    <div className="cx-page">
      <h2>Overview</h2>
      <p className="cx-muted">Last 24 hours, every group.</p>
      <div className="cx-stats wide">
        <Stat label="Requests" value={d?.counts.all ?? '—'} />
        <Stat label="Blocked" value={d?.counts.blocked ?? '—'} />
        <Stat label="False alarms" value={d?.counts.false_alarm ?? '—'} />
        <Stat label="Errors" value={d?.counts.error ?? '—'} />
        <Stat label="Guard overhead p95" value={d?.overheadP95 != null ? `${d.overheadP95} ms` : '—'} />
      </div>
      <h3>Requests per hour</h3>
      <div className="cx-chart">
        {(d?.buckets ?? []).map((b, i) => (
          <div key={i} className="cx-chart-col" title={`${b.label}: ${b.total} requests, ${b.blocked} blocked`}>
            <i style={{ height: `${(b.total / max) * 100}%` }}>
              <em style={{ height: `${b.total ? (b.blocked / b.total) * 100 : 0}%` }} />
            </i>
            {i % 3 === 0 && <span>{b.label}</span>}
          </div>
        ))}
      </div>
      <h3>Recent blocks{group && group.parentId !== null ? ` in ${group.name}` : ''}</h3>
      {blocks.length === 0 && <p className="cx-muted">Nothing blocked.</p>}
      {blocks.map((l) => (
        <LogRow key={l.id} l={l} />
      ))}
    </div>
  );
}

function LogRow({ l }: { l: LogC }) {
  return (
    <div className="cx-log">
      <span className={`cx-pill ${OUTCOME_TONE[l.outcome] ?? ''}`}>{l.outcome.replace('_', ' ')}</span>
      <span className="mono cx-muted">{new Date(l.ts).toLocaleTimeString()}</span>
      <span>{l.key_name ?? 'no key'}</span>
      <span className="cx-muted">{l.group_name ?? ''}</span>
      <span className="mono cx-muted">{l.model ?? ''}</span>
      <span className="cx-log-reason">{l.reason ?? ''}</span>
    </div>
  );
}

function ActivityPage({ group, groups }: { group: GroupC | null; groups: GroupC[] }) {
  const [filter, setFilter] = useState('');
  const [rows, setRows] = useState<LogC[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    api<{ rows: LogC[]; counts: Record<string, number> }>(`logs?limit=300${filter ? `&filter=${filter}` : ''}`).then(
      (r) => (setRows(r.rows), setCounts(r.counts)),
      () => setRows([]),
    );
  }, [filter]);
  const ids = group && group.parentId !== null ? subtree(group.id, groups) : null;
  const shown = (rows ?? []).filter((l) => !ids || (l.group_id !== null && ids.has(l.group_id)));
  return (
    <div className="cx-page">
      <h2>Activity{ids ? ` · ${group!.name}` : ''}</h2>
      <p className="cx-muted">{ids ? 'Requests from keys in this group and its sub-groups. Pick the root group to see all.' : 'Every request through the gateway. Pick a group in the sidebar to narrow it.'}</p>
      <div className="cx-filters">
        {[
          ['', 'All', counts.all],
          ['blocked', 'Blocked', counts.blocked],
          ['false_alarm', 'False alarms', counts.false_alarm],
          ['clean', 'Clean', counts.clean],
          ['error', 'Errors', counts.error],
        ].map(([v, l, n]) => (
          <button key={String(v)} className={`cx-chip ${filter === v ? 'on' : ''}`} onClick={() => setFilter(String(v))}>
            {l} <span>{n ?? 0}</span>
          </button>
        ))}
      </div>
      {rows === null && <p className="cx-muted">Loading…</p>}
      {rows && shown.length === 0 && <p className="cx-muted">No requests yet.</p>}
      {shown.map((l) => (
        <LogRow key={l.id} l={l} />
      ))}
    </div>
  );
}

function GuardPage({ group }: { group: GroupC | null }) {
  const [res, setRes] = useState<Resolution | null>(null);
  const [stats, setStats] = useState<{ blocked: number; falseAlarms: number; all: number } | null>(null);
  useEffect(() => {
    api<typeof stats>('guard/stats').then(setStats, () => setStats(null));
  }, []);
  useEffect(() => {
    if (group) api<{ resolution: Resolution }>(`groups/${group.id}`).then((r) => setRes(r.resolution), () => setRes(null));
  }, [group]);
  const e = res?.effective;
  return (
    <div className="cx-page">
      <h2>Guard checks{group ? ` · ${group.name}` : ''}</h2>
      <p className="cx-muted">Checks every request from this group passes before it reaches a model.</p>
      <div className="cx-stats wide">
        <Stat label="Requests today" value={stats?.all ?? '—'} />
        <Stat label="Blocked today" value={stats?.blocked ?? '—'} />
        <Stat label="False alarms" value={stats?.falseAlarms ?? '—'} />
      </div>
      {e && (
        <>
          <div className="cx-check">
            <span className={`cx-pill ${e.piguard_enabled ? 'ok' : ''}`}>{e.piguard_enabled ? 'On' : 'Off'}</span>
            <div>
              <b>Check 1 · PIGuard</b>
              <p className="cx-muted">Scores each prompt for injection. Flags at {e.piguard_threshold}.</p>
            </div>
          </div>
          <div className="cx-check">
            <span className={`cx-pill ${e.oss_enabled ? 'ok' : ''}`}>{e.oss_enabled ? 'On' : 'Off'}</span>
            <div>
              <b>Check 2 · Policy judge</b>
              <p className="cx-muted">A second model reads the prompt against your policy.</p>
              {e.oss_prompt_parts.map((p, i) => (
                <p key={i} className="cx-quote">
                  <span className="cx-muted">{p.from}:</span> {p.text}
                </p>
              ))}
            </div>
          </div>
        </>
      )}
      <p className="cx-muted">
        Editing checks moves here next. For now use <Link href="/guard">the current Guard page</Link>.
      </p>
    </div>
  );
}

function LinkPage({ title, text, href }: { title: string; text: string; href: string }) {
  return (
    <div className="cx-page">
      <h2>{title}</h2>
      <p>{text}</p>
      <Link className="cx-btn pri" href={href}>
        Open {title}
      </Link>
    </div>
  );
}

function SettingsPage() {
  const links: [string, string, string][] = [
    ['/servers', 'Servers and models', 'Add a vLLM or OpenAI-compatible server and pick its models.'],
    ['/guard', 'Guard checks', 'Turn checks on, set thresholds and the policy prompt.'],
    ['/rules', 'Rules', 'Rate limits and quotas per server, model or group.'],
    ['/schemas', 'Schemas', 'Which request formats the gateway accepts.'],
  ];
  return (
    <div className="cx-page">
      <h2>Settings</h2>
      <p className="cx-muted">These still open the classic pages while they move into the console.</p>
      {links.map(([href, t, d]) => (
        <Link key={href} className="cx-link-card" href={href}>
          <b>{t}</b>
          <span className="cx-muted">{d}</span>
        </Link>
      ))}
    </div>
  );
}
