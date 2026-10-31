'use client';

import { useEffect, useState } from 'react';

export const THEMES = [
  ['dark', 'Dark'],
  ['offwhite', 'Off-white'],
  ['white', 'White'],
] as const;
export type Theme = (typeof THEMES)[number][0];
const KEY = 'cx-theme';

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'dark' || t === 'white' || t === 'offwhite') return t;
  } catch {
    /* storage unavailable */
  }
  // No saved choice yet: Off-white.
  return 'offwhite';
}

export function applyTheme(t: Theme) {
  if (t === 'dark') document.documentElement.removeAttribute('data-cx-theme');
  else document.documentElement.setAttribute('data-cx-theme', t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent('cx-theme', { detail: t }));
}

/** The chosen theme, remembered per browser. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [t, setT] = useState<Theme>(read);
  useEffect(() => {
    const on = (e: Event) => setT((e as CustomEvent<Theme>).detail);
    window.addEventListener('cx-theme', on);
    return () => window.removeEventListener('cx-theme', on);
  }, []);
  return [t, applyTheme];
}
