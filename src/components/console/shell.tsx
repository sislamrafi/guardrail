'use client';

import Link from 'next/link';
import { type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Logo } from '@/components/logo';
import { Details } from './details';
import { Ico, type IconName } from './icons';
import { NavProvider, parsePath, pathFor, useNav } from './nav';
import { Sidebar } from './sidebars';
import { THEMES, applyTheme, useTheme } from './theme';
import { DataProvider, UiProvider, useStore, useUi } from './store';
import type { Data, View } from './types';
import { ActivityHome, LogDetail } from './views/activity';
import { ContextFileEditor, ContextHome } from './views/context';
import { DocEditor, DocsHome, KeyMcpView } from './views/docs';
import { GroupEditor, GroupsHome } from './views/groups';
import { GuardPage, LayerEditor } from './views/guard';
import { KeyEditor, KeyNew, KeysHome } from './views/keys';
import { OverviewPage } from './views/overview';
import { RuleEditor, RulesHome } from './views/rules';
import { SchemasPage } from './views/schemas';
import { ServerEditor, ServerNew, ServersHome } from './views/servers';
import { SettingsPage } from './views/settings';
import { ScenarioChat, StudioHome } from './views/studio';
import { usePref } from './prefs';

const TOP: { view: View; label: string; icon: IconName }[] = [
  { view: 'overview', label: 'Overview', icon: 'overview' },
  { view: 'activity', label: 'Activity', icon: 'activity' },
  { view: 'groups', label: 'Groups', icon: 'groups' },
  { view: 'keys', label: 'API keys', icon: 'keys' },
  { view: 'guard', label: 'Guard checks', icon: 'guard' },
  { view: 'context', label: 'Context files', icon: 'context' },
  { view: 'rules', label: 'Custom rules', icon: 'filter' },
  { view: 'docs', label: 'MCP docs', icon: 'mcp' },
];
// Bottom of the activity bar, above Account and Settings.
const BOTTOM: { view: View; label: string; icon: IconName; title: string }[] = [
  { view: 'servers', label: 'Servers', icon: 'servers', title: 'Servers and models' },
  { view: 'studio', label: 'Studio', icon: 'studio', title: 'Studio: send test requests' },
  { view: 'schemas', label: 'Schemas', icon: 'braces', title: 'Schemas' },
];
const VIEW_ICON: Record<View, IconName> = { overview: 'overview', activity: 'activity', guard: 'guard', servers: 'servers', groups: 'groups', keys: 'keys', context: 'context', rules: 'filter', docs: 'mcp', schemas: 'braces', studio: 'studio', settings: 'settings' };
const VIEW_LABEL: Record<View, string> = { overview: 'Overview', activity: 'Activity', guard: 'Guard checks', servers: 'Servers', groups: 'Groups', keys: 'API keys', context: 'Context files', rules: 'Custom rules', docs: 'MCP docs', schemas: 'Schemas', studio: 'Studio', settings: 'Settings' };

/** The whole console. Mounted once by the (console) layout, so it survives navigation. */
export function ConsoleApp() {
  // Rendered only in the browser: the layout state lives in sessionStorage.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="cx cx-booting" aria-busy="true" />;
  return (
    <Suspense fallback={<div className="cx cx-booting" />}>
      <DataProvider>
        <NavProvider>
          <UiProvider>
            <Workbench />
          </UiProvider>
        </NavProvider>
      </DataProvider>
    </Suspense>
  );
}

function usePersisted(key: string, initial: number): [number, (f: (v: number) => number) => void] {
  const [v, setV] = useState(() => {
    try {
      return Number(localStorage.getItem(key)) || initial;
    } catch {
      return initial;
    }
  });
  return [
    v,
    (f) =>
      setV((x) => {
        const n = f(x);
        try {
          localStorage.setItem(key, String(n));
        } catch {
          /* storage unavailable */
        }
        return n;
      }),
  ];
}

function Workbench() {
  const nav = useNav();
  const ui = useUi();
  const { data, error } = useStore();
  const [left, setLeft] = usePersisted('cx-left', 300);
  const [right, setRight] = usePersisted('cx-right', 300);
  const [showLeft, setShowLeft] = usePref('show.left', true);
  const [showRight, setShowRight] = usePref('show.right', true);
  // Picking something whose details live on the right (e.g. a key in MCP docs) opens that sidebar.
  useEffect(() => {
    const open = () => setShowRight(true);
    window.addEventListener('cx-show-right', open);
    return () => window.removeEventListener('cx-show-right', open);
  }, [setShowRight]);
  const [quick, setQuick] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ ln: number; col: number } | null>(null);
  const [account, setAccount] = useState(false);
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    const on = (e: Event) => setCursor((e as CustomEvent).detail);
    window.addEventListener('cx-cursor', on);
    return () => window.removeEventListener('cx-cursor', on);
  }, []);

  // Global shortcuts, VS Code style.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setQuick('');
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        if (e.altKey) setShowRight((v) => !v);
        else setShowLeft((v) => !v);
      } else if (mod && e.altKey && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        void closeTab(nav.path);
      } else if (e.altKey && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        history[e.key === 'ArrowLeft' ? 'back' : 'forward']();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  // Ask before closing a tab with unsaved text.
  const closeTab = async (p: string) => {
    const d = nav.drafts[p];
    const pv = parsePath(p);
    const f = pv.view === 'context' ? data?.files.find((x) => x.id === Number(pv.id)) : pv.view === 'docs' ? data?.docs.map((x) => ({ ...x, name: x.title })).find((x) => x.id === Number(pv.id)) : null;
    if (d !== undefined && f && d !== f.body) {
      const ok = await ui.confirm({ title: `Close ${f.name} without saving?`, body: 'Your changes will be lost.', ok: "Don't save", danger: true });
      if (!ok) return;
    }
    nav.closeTab(p);
  };
  useEffect(() => {
    const dirty = Object.keys(nav.drafts).length > 0;
    const before = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [nav.drafts]);

  const pickView = (v: View) => {
    if (v === nav.view && showLeft && nav.path === pathFor(v)) return setShowLeft(false);
    setShowLeft(true);
    // The picked group or key stays picked across sections.
    nav.go(pathFor(v));
  };

  const sum = data?.summary;
  const group = data?.groups.find((g) => g.id === nav.group) ?? data?.groups.find((g) => g.parentId === null);

  return (
    <div className="cx">
      <header className="cx-title">
        <div className="cx-brand">
          <Logo size={18} />
          <span>GuardRail</span>
        </div>
        <div className="cx-title-center">
          <button type="button" className="cx-tbtn" title="Back (⌥⇧←)" aria-label="Back" onClick={() => history.back()}>
            <Ico n="back" />
          </button>
          <button type="button" className="cx-tbtn" title="Forward (⌥⇧→)" aria-label="Forward" onClick={() => history.forward()}>
            <Ico n="forward" />
          </button>
          <button type="button" className="cx-command" onClick={() => setQuick('')}>
            <Ico n="search" size={14} />
            <span>Search files, groups, keys, servers and commands</span>
            <kbd>⌘P</kbd>
          </button>
          <button type="button" className="cx-tbtn" title={`Blocked in the last 24 hours: ${sum?.blockedToday ?? 0}. Open in Activity.`} aria-label="Blocked requests" onClick={() => nav.go('/activity?filter=blocked')}>
            <Ico n="blocked" />
            {!!sum?.blockedToday && <span className="cx-count">{sum.blockedToday > 99 ? '99+' : sum.blockedToday}</span>}
          </button>
        </div>
        <div className="cx-title-right">
          <button type="button" className={`cx-tbtn ${showLeft ? 'on' : ''}`} title="Toggle primary sidebar (⌘B)" aria-pressed={showLeft} aria-label="Toggle primary sidebar" onClick={() => setShowLeft(!showLeft)}>
            <Ico n="sidebarLeft" />
          </button>
          <button type="button" className={`cx-tbtn ${showRight ? 'on' : ''}`} title="Toggle secondary sidebar (⌥⌘B)" aria-pressed={showRight} aria-label="Toggle secondary sidebar" onClick={() => setShowRight(!showRight)}>
            <Ico n="sidebarRight" />
          </button>
        </div>
      </header>

      <div className="cx-body">
        <nav className="cx-activity" aria-label="Views">
          {TOP.map((a) => (
            <button key={a.view} type="button" className={`cx-act ${nav.view === a.view && showLeft ? 'on' : ''}`} title={a.label} aria-label={a.label} aria-current={nav.view === a.view ? 'page' : undefined} onClick={() => pickView(a.view)}>
              <Ico n={a.icon} size={24} stroke={1.5} />
              {a.view === 'activity' && !!sum?.blockedToday && <span className="cx-act-badge">{sum.blockedToday > 99 ? '99+' : sum.blockedToday}</span>}
            </button>
          ))}
          <div className="cx-grow" />
          {BOTTOM.map((a) => (
            <button key={a.view} type="button" className={`cx-act ${nav.view === a.view && showLeft ? 'on' : ''}`} title={a.title} aria-label={a.title} aria-current={nav.view === a.view ? 'page' : undefined} onClick={() => pickView(a.view)}>
              <Ico n={a.icon} size={24} stroke={1.5} />
            </button>
          ))}
          <div className="cx-acc">
            <button type="button" className={`cx-act ${account ? 'on' : ''}`} title={`Signed in as ${sum?.name ?? 'Admin'}`} aria-label="Account" aria-expanded={account} onClick={() => setAccount(!account)}>
              <span className="cx-avatar">{(sum?.name ?? 'Admin').slice(0, 2).toUpperCase()}</span>
            </button>
            {account && (
              <div className="cx-menu up" role="menu" onMouseLeave={() => setAccount(false)}>
                <div className="cx-menu-head">{sum?.name ?? 'Admin'}</div>
                {THEMES.map(([t, label]) => (
                  <button key={t} type="button" role="menuitemradio" aria-checked={theme === t} className="cx-menu-item" onClick={() => setTheme(t)}>
                    <span>Theme: {label}</span>
                    {theme === t && <Ico n="check" size={14} />}
                  </button>
                ))}
                <div className="cx-menu-sep" role="separator" />
                <button type="button" role="menuitem" className="cx-menu-item" onClick={() => (setAccount(false), nav.go('/settings'))}>
                  Settings
                </button>
                <Link role="menuitem" className="cx-menu-item" href="/old">
                  Classic admin panel
                </Link>
                {sum?.authEnabled && (
                  <button
                    type="button"
                    role="menuitem"
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
          <button type="button" className={`cx-act ${nav.view === 'settings' && showLeft ? 'on' : ''}`} title="Settings" aria-label="Settings" onClick={() => pickView('settings')}>
            <Ico n="settings" size={24} stroke={1.5} />
          </button>
        </nav>

        {showLeft && (
          <>
            <Sidebar width={left} />
            <Sash onDrag={(d) => setLeft((w) => Math.min(560, Math.max(180, w + d)))} />
          </>
        )}

        <main className="cx-editor">
          <Tabs data={data} onClose={closeTab} />
          <Breadcrumbs data={data} />
          <div className="cx-pane" key={nav.path}>
            {error && !data ? <div className="cx-error-pane">{error}</div> : <Editor />}
          </div>
        </main>

        {showRight && (
          <>
            <Sash onDrag={(d) => setRight((w) => Math.min(560, Math.max(220, w - d)))} />
            <Details width={right} />
          </>
        )}
      </div>

      <footer className="cx-status">
        <span className="cx-status-brand">
          <Logo size={13} /> GuardRail
        </span>
        <button type="button" onClick={() => nav.go('/servers')} title="Inference servers online">
          <span className={`cx-status-dot ${sum && sum.servers && sum.online === sum.servers ? 'ok' : sum?.servers ? 'warn' : ''}`} />
          {sum ? `${sum.online}/${sum.servers} servers online` : '…'}
        </button>
        <button type="button" onClick={() => nav.go('/guard')}>
          <Ico n={sum?.guard ? 'guard' : 'shieldOff'} size={13} /> Guard {sum?.guard ? 'on' : 'off'}
        </button>
        <button type="button" onClick={() => nav.go('/activity?filter=blocked')}>
          <Ico n="blocked" size={13} /> {sum?.blockedToday ?? 0} blocked today
        </button>
        <div className="cx-grow" />
        {cursor && (
          <span>
            Ln {cursor.ln}, Col {cursor.col}
          </span>
        )}
        {(nav.view === 'context' || nav.view === 'docs') && nav.id && <span>Markdown</span>}
        <button type="button" onClick={() => nav.go(group ? pathFor('groups', group.id) : '/groups')} title="Selected group">
          <Ico n="folder" size={13} /> {group?.name ?? '–'}
        </button>
        <span>
          {sum?.groups ?? 0} groups · {sum?.keys ?? 0} keys
        </span>
      </footer>

      {quick !== null && <QuickOpen q={quick} setQ={setQuick} data={data} />}
    </div>
  );
}

function Sash({ onDrag }: { onDrag: (dx: number) => void }) {
  return (
    <div
      className="cx-sash"
      role="separator"
      aria-orientation="vertical"
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
          document.body.classList.remove('cx-resizing');
        };
        document.body.classList.add('cx-resizing');
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
    />
  );
}

// ---------------------------------------------------------------- tabs and breadcrumbs

function tabInfo(p: string, data: Data | null): { title: string; icon: IconName; cls?: string } {
  const { view, id } = parsePath(p);
  if (!id) return { title: VIEW_LABEL[view], icon: VIEW_ICON[view] };
  const n = Number(id);
  switch (view) {
    case 'context':
      return { title: data?.files.find((f) => f.id === n)?.name ?? 'File', icon: 'file', cls: 'md' };
    case 'docs':
      if (id.startsWith('k')) return { title: `${data?.keys.find((k) => k.id === Number(id.slice(1)))?.name ?? 'Key'} · MCP`, icon: 'key', cls: 'key' };
      return { title: data?.docs.find((d) => d.id === n)?.title ?? 'Doc', icon: 'file', cls: 'md' };
    case 'groups':
      return { title: data?.groups.find((g) => g.id === n)?.name ?? 'Group', icon: 'folder', cls: 'folder' };
    case 'keys':
      return id === 'new' ? { title: 'New key', icon: 'key', cls: 'key' } : { title: data?.keys.find((k) => k.id === n)?.name ?? 'Key', icon: 'key', cls: 'key' };
    case 'servers':
      return id === 'new' ? { title: 'Add server', icon: 'servers' } : { title: data?.servers.find((s) => s.id === n)?.name ?? 'Server', icon: 'servers' };
    case 'rules':
      return id === 'new' ? { title: 'New rule', icon: 'filter' } : { title: data?.rules.find((r) => r.id === n)?.name ?? 'Rule', icon: 'filter' };
    case 'activity':
      return { title: `Request ${id.slice(0, 8)}`, icon: 'activity' };
    case 'guard':
      return { title: data?.settings.guard.layers.find((l) => l.id === id)?.name ?? 'Layer', icon: 'guard' };
    case 'studio':
      return { title: data?.scenarios.find((s) => s.id === n)?.name ?? 'Scenario', icon: 'studio' };
    default:
      return { title: VIEW_LABEL[view], icon: VIEW_ICON[view] };
  }
}

function Tabs({ data, onClose }: { data: Data | null; onClose: (p: string) => void | Promise<void> }) {
  const nav = useNav();
  const ui = useUi();
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ l: false, r: false });
  const [list, setList] = useState<string | null>(null);
  const edges = () => {
    const el = ref.current;
    if (el) setFade({ l: el.scrollLeft > 2, r: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  };
  // Keep the active tab in view when the strip overflows.
  useEffect(() => {
    ref.current?.querySelector('.cx-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    edges();
  }, [nav.path, nav.tabs.length]);
  // Like VS Code: the mouse wheel scrolls the strip sideways (trackpads already swipe sideways).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('resize', edges);
    return () => {
      el.removeEventListener('wheel', wheel);
      window.removeEventListener('resize', edges);
    };
  }, []);
  const closeMany = async (paths: string[]) => {
    for (const x of paths) await onClose(x);
  };
  const shown = list === null ? [] : nav.tabs.filter((p) => tabInfo(p, data).title.toLowerCase().includes(list.toLowerCase()));
  return (
    <div className="cx-tabbar">
    <div ref={ref} className={`cx-tabs ${fade.l ? 'fade-l' : ''} ${fade.r ? 'fade-r' : ''}`} role="tablist" aria-label="Open editors" onScroll={edges}>
      {nav.tabs.map((p) => {
        const t = tabInfo(p, data);
        const on = p === nav.path;
        const dirty = nav.drafts[p] !== undefined;
        return (
          <div
            key={p}
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            className={`cx-tab ${on ? 'on' : ''}`}
            title={p}
            onClick={() => !on && nav.go(p)}
            onKeyDown={(e) => e.key === 'Enter' && nav.go(p)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(p);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              ui.menu(e.clientX, e.clientY, [
                { label: 'Close', hint: '⌥⌘W', run: () => onClose(p) },
                { label: 'Close others', run: () => nav.closeOthers(p) },
                { label: 'Close to the right', run: () => void closeMany(nav.tabs.slice(nav.tabs.indexOf(p) + 1)) },
                { label: 'Close all', run: () => void closeMany([...nav.tabs]) },
                { sep: true, label: '' },
                { label: 'Copy link', run: () => void navigator.clipboard.writeText(window.location.origin + p).then(() => ui.toast('Link copied')) },
              ]);
            }}
          >
            <span className={`cx-ico ${t.cls ?? ''}`}>
              <Ico n={t.icon} size={15} />
            </span>
            <span className="cx-tab-label">{t.title}</span>
            <button
              type="button"
              className={`cx-tab-x ${dirty ? 'dirty' : ''}`}
              aria-label={`Close ${t.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(p);
              }}
            >
              <Ico n="close" size={14} />
            </button>
          </div>
        );
      })}
      <div className="cx-grow" />
    </div>
      {nav.tabs.length > 1 && (
        <div className="cx-tablist">
          <button type="button" className="cx-tbtn" title="All open editors" aria-label="All open editors" aria-expanded={list !== null} onClick={() => setList(list === null ? '' : null)}>
            <Ico n="more" size={16} />
          </button>
          {list !== null && (
            <div className="cx-tablist-pop" role="dialog" aria-label="Open editors">
              <input
                className="cx-input sm"
                autoFocus
                type="search"
                placeholder={`Search ${nav.tabs.length} open editors`}
                value={list}
                onChange={(e) => setList(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setList(null);
                  if (e.key === 'Enter' && shown[0]) {
                    nav.go(shown[0]);
                    setList(null);
                  }
                }}
                onBlur={(e) => !e.currentTarget.parentElement?.contains(e.relatedTarget as Node) && setTimeout(() => setList(null), 150)}
              />
              <div className="cx-tablist-items">
                {shown.map((p) => {
                  const t = tabInfo(p, data);
                  return (
                    <button
                      key={p}
                      type="button"
                      className={`cx-li ${p === nav.path ? 'sel' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        nav.go(p);
                        setList(null);
                      }}
                    >
                      <span className={`cx-ico ${t.cls ?? ''}`}>
                        <Ico n={t.icon} size={14} />
                      </span>
                      <span className="cx-label">{t.title}</span>
                      {nav.drafts[p] !== undefined && <span className="cx-meta">●</span>}
                    </button>
                  );
                })}
                {shown.length === 0 && <p className="cx-details-empty">No open editor matches.</p>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Breadcrumbs({ data }: { data: Data | null }) {
  const nav = useNav();
  const crumbs: string[] = [VIEW_LABEL[nav.view]];
  const n = Number(nav.id);
  if (nav.id && data) {
    if (nav.view === 'context') {
      const g = data.groups.find((x) => x.own.includes(n));
      crumbs.push(...(g ? g.path.split(/ [›/] /) : ['not in any group']), data.files.find((f) => f.id === n)?.name ?? '');
    } else if (nav.view === 'groups') crumbs.push(...(data.groups.find((g) => g.id === n)?.path.split(/ [›/] /) ?? []));
    else if (nav.view === 'keys') {
      const k = data.keys.find((x) => x.id === n);
      crumbs.push(...(k ? [...k.groupPath.split(/ [›/] /), k.name] : [nav.id === 'new' ? 'new' : '']));
    } else crumbs.push(tabInfo(nav.path, data).title);
  } else if (nav.group && data && !['servers', 'rules', 'schemas', 'settings', 'studio'].includes(nav.view)) {
    const g = data.groups.find((x) => x.id === nav.group);
    if (g) crumbs.push(g.name);
  }
  return (
    <nav className="cx-crumbs" aria-label="Breadcrumbs">
      {crumbs.filter(Boolean).map((c, i, a) => (
        <span key={i}>
          {c}
          {i < a.length - 1 && <Ico n="chevron" size={12} />}
        </span>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------- editor router

function Editor(): ReactNode {
  const { view, id } = useNav();
  const n = Number(id);
  switch (view) {
    case 'overview':
      return <OverviewPage />;
    case 'activity':
      return id ? <LogDetail id={id} /> : <ActivityHome />;
    case 'guard':
      return id ? <LayerEditor id={id} /> : <GuardPage />;
    case 'servers':
      return id === 'new' ? <ServerNew /> : id ? <ServerEditor id={n} /> : <ServersHome />;
    case 'groups':
      return id ? <GroupEditor id={n} /> : <GroupsHome />;
    case 'keys':
      return id === 'new' ? <KeyNew /> : id ? <KeyEditor id={n} /> : <KeysHome />;
    case 'context':
      return id ? <ContextFileEditor id={n} /> : <ContextHome />;
    case 'rules':
      return id ? <RuleEditor id={id === 'new' ? 'new' : n} /> : <RulesHome />;
    case 'docs':
      return id?.startsWith('k') ? <KeyMcpView id={Number(id.slice(1))} /> : id ? <DocEditor id={n} /> : <DocsHome />;
    case 'schemas':
      return <SchemasPage />;
    case 'studio':
      return id ? <ScenarioChat id={n} /> : <StudioHome />;
    case 'settings':
      return <SettingsPage />;
  }
}

// ---------------------------------------------------------------- quick open (⌘P)

function QuickOpen({ q, setQ, data }: { q: string; setQ: (v: string | null) => void; data: Data | null }) {
  const nav = useNav();
  const [sel, setSel] = useState(0);
  const items = useMemo(() => {
    const out: { label: string; hint: string; icon: IconName; path: string; run?: () => void }[] = [
      ...THEMES.map(([t, label]) => ({ label: `Theme: ${label}`, hint: 'command', icon: 'settings' as IconName, path: '', run: () => applyTheme(t) })),
      ...TOP.map((t) => ({ label: t.label, hint: 'view', icon: t.icon, path: pathFor(t.view) })),
      ...BOTTOM.map((t) => ({ label: t.title, hint: 'view', icon: t.icon, path: pathFor(t.view) })),
      { label: 'Settings', hint: 'view', icon: 'settings', path: '/settings' },
      { label: 'New API key', hint: 'command', icon: 'plus', path: '/keys/new' },
      { label: 'Add a server', hint: 'command', icon: 'plus', path: '/servers/new' },
      { label: 'New rule', hint: 'command', icon: 'plus', path: '/rules/new' },
    ];
    if (data) {
      out.push(...data.files.map((f) => ({ label: f.name, hint: 'context file', icon: 'file' as IconName, path: pathFor('context', f.id) })));
      out.push(...data.docs.map((d) => ({ label: d.title, hint: `MCP doc · ${d.slug}`, icon: 'file' as IconName, path: pathFor('docs', d.id) })));
      out.push(...data.groups.map((g) => ({ label: g.name, hint: `group · ${g.path}`, icon: 'folder' as IconName, path: pathFor('groups', g.id) })));
      out.push(...data.keys.map((k) => ({ label: k.name, hint: `key · ${k.owner} · ${k.groupName}`, icon: 'key' as IconName, path: pathFor('keys', k.id) })));
      out.push(...data.servers.map((s) => ({ label: s.name, hint: `server · ${s.url}`, icon: 'servers' as IconName, path: pathFor('servers', s.id) })));
      out.push(...data.rules.map((r) => ({ label: r.name, hint: 'rule', icon: 'filter' as IconName, path: pathFor('rules', r.id) })));
    }
    const s = q.toLowerCase().trim();
    return out.filter((i) => !s || i.label.toLowerCase().includes(s) || i.hint.toLowerCase().includes(s)).slice(0, 14);
  }, [q, data]);
  const pick = (i: number) => {
    const it = items[i];
    if (!it) return;
    setQ(null);
    if (it.run) it.run();
    else nav.go(it.path);
  };
  return (
    <div className="cx-overlay at-top" onMouseDown={() => setQ(null)}>
      <div className="cx-quick" role="dialog" aria-label="Quick open" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          placeholder="Type to search files, groups, keys, servers, rules and commands"
          aria-label="Search"
          aria-controls="cx-quick-list"
          onChange={(e) => (setQ(e.target.value), setSel(0))}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQ(null);
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(items.length - 1, s + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            }
            else if (e.key === 'Enter') pick(sel);
          }}
        />
        <div className="cx-quick-list" id="cx-quick-list" role="listbox">
          {items.length === 0 && <div className="cx-quick-empty">Nothing matches.</div>}
          {items.map((i, n) => (
            <button key={`${i.path}${n}`} type="button" role="option" aria-selected={n === sel} className={`cx-quick-item ${n === sel ? 'on' : ''}`} onMouseEnter={() => setSel(n)} onClick={() => pick(n)}>
              <Ico n={i.icon} size={15} />
              <span>{i.label}</span>
              <span className="cx-meta">{i.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
