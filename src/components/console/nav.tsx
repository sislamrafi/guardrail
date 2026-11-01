'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { parsePath, pathFor } from './paths';
import type { View } from './types';
import { readPref, writePref } from './prefs';

export { parsePath, pathFor, subtree } from './paths';

interface Nav {
  path: string;
  view: View;
  id: string | null;
  /** The group picked in the groups-and-keys explorer (?group=). */
  group: number | null;
  /** The API key picked in the explorer (?key=), if any; its group is then `group`. */
  key: number | null;
  tabs: string[];
  go: (path: string, opts?: { replace?: boolean }) => void;
  setGroup: (id: number | null) => void;
  /** Pick a group, or a key (with its group), keeping the open page. */
  setScope: (s: { group: number | null; key?: number | null }) => void;
  closeTab: (path: string) => void;
  closeOthers: (path: string) => void;
  /** Unsaved editor text, keyed by tab path. */
  drafts: Record<string, string>;
  /** Set or clear unsaved text. With `onlyIf`, clear only while the draft still equals that text. */
  setDraft: (path: string, text: string | null, onlyIf?: string) => void;
}

const NavCtx = createContext<Nav | null>(null);
const TABS_KEY = 'tabs';

export function NavProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const raw = usePathname() || '/';
  // One canonical path per editor (so "/overview" and "/" are the same tab).
  const pathname = pathFor(parsePath(raw).view, parsePath(raw).id);
  const params = useSearchParams();
  // The scope (group or key) lives in the URL; a page opened without one reuses the last one picked.
  const urlKey = params.get('key') ? Number(params.get('key')) : null;
  const urlGroup = params.get('group') ? Number(params.get('group')) : null;
  const remembered = readPref<{ group: number | null; key: number | null }>('scope', { group: null, key: null });
  const hasScope = urlKey !== null || urlGroup !== null;
  const key = hasScope ? urlKey : remembered.key;
  const group = hasScope ? urlGroup : remembered.group;
  const { view, id } = parsePath(pathname);
  const [tabs, setTabs] = useState<string[]>(() => {
    try {
      // A reload starts fresh (just the page in the address bar) unless the viewer chose to reopen tabs.
      const t = readPref('reopenTabs', false) ? readPref<string[]>(TABS_KEY, []) : [];
      return Array.isArray(t) ? [...new Set(t.filter((x) => typeof x === 'string').map((x) => pathFor(parsePath(x).view, parsePath(x).id)))] : [];
    } catch {
      return [];
    }
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // Where we are (or are heading): several closes in a row (Close all) must see each other's moves.
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  // Every path you visit becomes (or focuses) a tab.
  useEffect(() => {
    setTabs((t) => (t.includes(pathname) ? t : [...t, pathname]));
  }, [pathname]);
  useEffect(() => {
    writePref(TABS_KEY, tabs);
  }, [tabs]);

  useEffect(() => {
    if (hasScope) writePref('scope', { group: urlGroup, key: urlKey });
  }, [hasScope, urlGroup, urlKey]);
  const scopeQuery = useCallback((g: number | null, k: number | null) => [g ? `group=${g}` : '', k ? `key=${k}` : ''].filter(Boolean).join('&'), []);
  // A path that brings its own query (e.g. "/keys/new?group=3") keeps it.
  const withGroup = useCallback((p: string, g: number | null, k: number | null = key) => (p.includes('?') || (!g && !k) ? p : `${p}?${scopeQuery(g, k)}`), [key, scopeQuery]);
  const go = useCallback(
    (p: string, opts?: { replace?: boolean }) => {
      if (!opts?.replace) return router.push(withGroup(p, group));
      // A replace (e.g. "Add server" becoming the saved server) swaps the tab instead of opening another.
      const bare = p.split('?')[0];
      setTabs((t) => [...new Set(t.map((x) => (x === pathname ? bare : x)))]);
      router.replace(withGroup(p, group));
    },
    [router, group, withGroup, pathname],
  );
  const setGroup = useCallback((g: number | null) => router.replace(withGroup(pathname, g, null)), [router, pathname, withGroup]);
  const setScope = useCallback((s: { group: number | null; key?: number | null }) => router.replace(withGroup(pathname, s.group, s.key ?? null)), [router, pathname, withGroup]);

  const closeTab = useCallback(
    (p: string) => {
      // Work out the next tabs first, then navigate: updaters must not have side effects.
      const t = tabsRef.current;
      const i = t.indexOf(p);
      const next = t.filter((x) => x !== p);
      tabsRef.current = next;
      setTabs(next);
      if (p === pathRef.current) {
        const dest = next[Math.max(0, i - 1)] ?? '/';
        pathRef.current = dest;
        router.push(withGroup(dest, group));
      }
      setDrafts((d) => {
        const n = { ...d };
        delete n[p];
        return n;
      });
    },
    [router, group, withGroup],
  );
  const closeOthers = useCallback(
    (p: string) => {
      setTabs([p]);
      if (p !== pathname) router.push(withGroup(p, group));
    },
    [pathname, router, group, withGroup],
  );
  const setDraft = useCallback(
    (p: string, text: string | null, onlyIf?: string) =>
      setDrafts((d) => {
        if (text === null && onlyIf !== undefined && d[p] !== onlyIf) return d;
        const n = { ...d };
        if (text === null) delete n[p];
        else n[p] = text;
        return n;
      }),
    [],
  );

  const value = useMemo(
    () => ({ path: pathname, view, id, group, key, tabs, go, setGroup, setScope, closeTab, closeOthers, drafts, setDraft }),
    [pathname, view, id, group, key, tabs, go, setGroup, setScope, closeTab, closeOthers, drafts, setDraft],
  );
  return <NavCtx.Provider value={value}>{children}</NavCtx.Provider>;
}

export function useNav() {
  const n = useContext(NavCtx);
  if (!n) throw new Error('useNav outside NavProvider');
  return n;
}
