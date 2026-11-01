'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePref } from './prefs';
import { useStore } from './store';

// Autosave, like VS Code's "after delay": a form saves itself a few seconds after the last keystroke.
// Each new keystroke restarts the wait. Leaving the form (or the page) with changes saves them at once.
// Only plain edits use this; deleting, revoking, rotating and server connection changes stay explicit.

export interface AutoSavePrefs {
  on: boolean;
  ms: number;
}
export const AUTOSAVE_DEFAULT: AutoSavePrefs = { on: true, ms: 5000 };
export const useAutoSavePrefs = () => usePref<AutoSavePrefs>('autosave', AUTOSAVE_DEFAULT);

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'invalid' | 'error';

export function useAutoSave({ value, dirty, invalid, save }: { value: unknown; dirty: boolean; invalid?: string | null; save: () => Promise<unknown> }) {
  const [prefs] = useAutoSavePrefs();
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const latest = useRef({ dirty, invalid, save, on: prefs.on });
  latest.current = { dirty, invalid, save, on: prefs.on };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sig = JSON.stringify(value);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const l = latest.current;
    if (!l.dirty || l.invalid) return false;
    setStatus('saving');
    try {
      await l.save();
      setStatus('saved');
      setError(null);
      return true;
    } catch (e) {
      setStatus('error');
      setError((e as Error).message);
      return false;
    }
  }, []);

  // Restart the wait on every change.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!dirty) {
      setStatus((s) => (s === 'saving' || s === 'saved' ? s : 'idle'));
      return;
    }
    if (invalid) {
      setStatus('invalid');
      setError(invalid);
      return;
    }
    setError(null);
    setStatus('pending');
    if (prefs.on) timer.current = setTimeout(() => void flush(), prefs.ms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, dirty, invalid, prefs.on, prefs.ms]);

  // Leaving the form or the page saves what is left.
  useEffect(() => {
    const away = () => {
      const l = latest.current;
      if (l.on && l.dirty && !l.invalid) void l.save();
    };
    window.addEventListener('pagehide', away);
    return () => {
      window.removeEventListener('pagehide', away);
      if (timer.current) clearTimeout(timer.current);
      away();
    };
  }, []);

  return { status: dirty && status === 'saved' ? 'pending' : status, error, flush, auto: prefs.on };
}

/** "● Unsaved", "Saving…", "Saved" or the reason it can't save, next to a form. */
export function SaveState({ s }: { s: { status: SaveStatus; error: string | null; auto: boolean } }) {
  if (s.status === 'idle') return null;
  const text = s.status === 'pending' ? (s.auto ? 'Unsaved · saves when you stop typing' : 'Unsaved') : s.status === 'saving' ? 'Saving…' : s.status === 'saved' ? 'Saved' : s.error;
  return (
    <span className={`cx-savestate ${s.status}`} role={s.status === 'error' || s.status === 'invalid' ? 'alert' : 'status'}>
      {s.status === 'pending' && <i aria-hidden="true">●</i>} {text}
    </span>
  );
}

/** Run a save without a toast (autosave shows its own state); errors are thrown to the form. Reloads data after. */
export function useQuietSave() {
  const { reload } = useStore();
  return useCallback(
    async (fn: () => Promise<unknown>) => {
      await fn();
      await reload();
    },
    [reload],
  );
}
