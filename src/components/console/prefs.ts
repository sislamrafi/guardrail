'use client';

import { useCallback, useState } from 'react';

// UI preferences, remembered per browser: tree modes, expanded groups, panel sizes, tabs, filters…
// One versioned prefix so a future change of shape can start fresh, and "Reset UI layout" can clear it all.
const PREFIX = 'cx1:';
// Older keys from before this store; cleared by a reset too.
const LEGACY = ['cx-left', 'cx-right', 'cx-tabs'];

export function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown) {
  try {
    if (value === undefined) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

/** useState that remembers itself in this browser. The console renders only in the browser, so reading on init is safe. */
export function usePref<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => readPref(key, initial));
  const set = useCallback(
    (next: T | ((p: T) => T)) =>
      setV((p) => {
        const n = typeof next === 'function' ? (next as (p: T) => T)(p) : next;
        writePref(key, n);
        return n;
      }),
    [key],
  );
  return [v, set];
}

/** Forget every remembered layout and view choice (theme and splash settings stay). */
export function resetUiPrefs() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX) || LEGACY.includes(k)) localStorage.removeItem(k);
    sessionStorage.clear();
  } catch {
    /* storage unavailable */
  }
}

/**
 * The tab last open for one item (a group, a key…), restored when it is reopened.
 * An item with no memory yet starts on the tab last used for that kind of item.
 */
export function useItemTab<T extends string>(kind: string, id: string | number, fallback: T): [T, (t: T) => void] {
  const read = () => readPref<T>(`${kind}.tab.${id}`, readPref<T>(`${kind}.tab`, fallback));
  const [state, setState] = useState<{ id: string | number; tab: T }>(() => ({ id, tab: read() }));
  const tab = state.id === id ? state.tab : read();
  const set = (t: T) => {
    writePref(`${kind}.tab.${id}`, t);
    writePref(`${kind}.tab`, t);
    setState({ id, tab: t });
  };
  return [tab, set];
}
