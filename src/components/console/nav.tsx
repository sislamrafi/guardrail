'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { parsePath, pathFor } from './paths';
import type { View } from './types';

export { parsePath, pathFor, subtree } from './paths';

interface Nav {
  path: string;
  view: View;
  id: string | null;
  group: number | null;
  tabs: string[];
  go: (path: string, opts?: { replace?: boolean }) => void;
  setGroup: (id: number | null) => void;
  closeTab: (path: string) => void;
  closeOthers: (path: string) => void;
  /** Unsaved editor text, keyed by tab path. */
  drafts: Record<string, string>;
  setDraft: (path: string, text: string | null) => void;
}

const NavCtx = createContext<Nav | null>(null);
const TABS_KEY = 'cx-tabs';

export function NavProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const raw = usePathname() || '/';
  // One canonical path per editor (so "/overview" and "/" are the same tab).
  const pathname = pathFor(parsePath(raw).view, parsePath(raw).id);
  const params = useSearchParams();
  const group = params.get('group') ? Number(params.get('group')) : null;
  const { view, id } = parsePath(pathname);
  const [tabs, setTabs] = useState<string[]>(() => {
    try {
      const t = JSON.parse(sessionStorage.getItem(TABS_KEY) ?? '[]') as string[];
      return Array.isArray(t) ? [...new Set(t.filter((x) => typeof x === 'string').map((x) => pathFor(parsePath(x).view, parsePath(x).id)))] : [];
    } catch {
      return [];
    }
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Every path you visit becomes (or focuses) a tab.
  useEffect(() => {
    setTabs((t) => (t.includes(pathname) ? t : [...t, pathname]));
  }, [pathname]);
  useEffect(() => {
    try {
      sessionStorage.setItem(TABS_KEY, JSON.stringify(tabs));
    } catch {
      /* storage unavailable */
    }
  }, [tabs]);

  // A path that brings its own query (e.g. "/keys/new?group=3") keeps it.
  const withGroup = useCallback((p: string, g: number | null) => (g && !p.includes('?') ? `${p}?group=${g}` : p), []);
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
  const setGroup = useCallback((g: number | null) => router.replace(withGroup(pathname, g)), [router, pathname, withGroup]);

  const closeTab = useCallback(
    (p: string) => {
      setTabs((t) => {
        const i = t.indexOf(p);
        const next = t.filter((x) => x !== p);
        if (p === pathname) router.push(withGroup(next[Math.max(0, i - 1)] ?? '/', group));
        return next;
      });
      setDrafts((d) => {
        const n = { ...d };
        delete n[p];
        return n;
      });
    },
    [pathname, router, group, withGroup],
  );
  const closeOthers = useCallback(
    (p: string) => {
      setTabs([p]);
      if (p !== pathname) router.push(withGroup(p, group));
    },
    [pathname, router, group, withGroup],
  );
  const setDraft = useCallback(
    (p: string, text: string | null) =>
      setDrafts((d) => {
        const n = { ...d };
        if (text === null) delete n[p];
        else n[p] = text;
        return n;
      }),
    [],
  );

  const value = useMemo(
    () => ({ path: pathname, view, id, group, tabs, go, setGroup, closeTab, closeOthers, drafts, setDraft }),
    [pathname, view, id, group, tabs, go, setGroup, closeTab, closeOthers, drafts, setDraft],
  );
  return <NavCtx.Provider value={value}>{children}</NavCtx.Provider>;
}

export function useNav() {
  const n = useContext(NavCtx);
  if (!n) throw new Error('useNav outside NavProvider');
  return n;
}
