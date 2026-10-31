'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/components/ui';
import type { Data, FileC, GroupC, KeyC, ServerC, Summary } from './types';

export { api };

// ---------------------------------------------------------------- data

interface Store {
  data: Data | null;
  error: string | null;
  reload: () => Promise<void>;
  /** Patch local data right away; the next reload replaces it with the server's truth. */
  patch: (fn: (d: Data) => Data) => void;
}

const StoreCtx = createContext<Store | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const n = ++seq.current;
    try {
      const [c, k, s, g, sum, r, sc] = await Promise.all([
        api<{ files: FileC[]; groups: GroupC[]; settings: Data['settings']; cache: Data['cache'] }>('context'),
        api<{ keys: KeyC[] }>('keys'),
        api<{ servers: ServerC[]; limits: Data['limits']; access: Data['access'] }>('servers'),
        api<{ models: string[]; modelServers: Record<string, string[]> }>('groups'),
        api<Summary>('summary'),
        api<{ rules: Data['rules'] }>('rules'),
        api<{ scenarios: Data['scenarios'] }>('studio/scenarios'),
      ]);
      if (n !== seq.current) return;
      setData({ groups: c.groups, files: c.files, settings: c.settings, cache: c.cache, keys: k.keys, servers: s.servers, limits: s.limits, access: s.access, models: g.models, modelServers: g.modelServers, summary: sum, rules: r.rules, scenarios: sc.scenarios });
      setError(null);
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    // Keep counts and server status fresh while the console is open.
    const t = setInterval(() => document.visibilityState === 'visible' && void reload(), 30000);
    return () => clearInterval(t);
  }, [reload]);

  const patch = useCallback((fn: (d: Data) => Data) => setData((d) => (d ? fn(d) : d)), []);
  const value = useMemo(() => ({ data, error, reload, patch }), [data, error, reload, patch]);
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const s = useContext(StoreCtx);
  if (!s) throw new Error('useStore outside DataProvider');
  return s;
}

// ---------------------------------------------------------------- toasts, confirm, context menu

export interface MenuItem {
  label: string;
  run?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
  sep?: boolean;
}

interface Confirm {
  title: string;
  body?: ReactNode;
  ok: string;
  danger?: boolean;
}

interface Ui {
  toast: (text: string, bad?: boolean) => void;
  confirm: (c: Confirm) => Promise<boolean>;
  menu: (x: number, y: number, items: MenuItem[]) => void;
  /** Run an action: toast its error, optionally toast success, reload data after. Returns false on error. */
  run: (fn: () => Promise<unknown>, ok?: string, opts?: { reload?: boolean }) => Promise<boolean>;
}

const UiCtx = createContext<Ui | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const { reload } = useStore();
  const [toasts, setToasts] = useState<{ id: number; text: string; bad?: boolean }[]>([]);
  const [conf, setConf] = useState<(Confirm & { resolve: (v: boolean) => void }) | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const nextId = useRef(1);

  const toast = useCallback((text: string, bad?: boolean) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-2), { id, text, bad }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), bad ? 6000 : 3000);
  }, []);
  const confirm = useCallback((c: Confirm) => new Promise<boolean>((resolve) => setConf({ ...c, resolve })), []);
  const openMenu = useCallback((x: number, y: number, items: MenuItem[]) => setMenu({ x, y, items }), []);
  const run = useCallback(
    async (fn: () => Promise<unknown>, ok?: string, opts?: { reload?: boolean }) => {
      try {
        await fn();
        if (ok) toast(ok);
        return true;
      } catch (e) {
        toast((e as Error).message, true);
        return false;
      } finally {
        if (opts?.reload !== false) await reload();
      }
    },
    [toast, reload],
  );

  const value = useMemo(() => ({ toast, confirm, menu: openMenu, run }), [toast, confirm, openMenu, run]);
  const close = (v: boolean) => {
    conf?.resolve(v);
    setConf(null);
  };

  return (
    <UiCtx.Provider value={value}>
      {children}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {conf && (
        <div className="cx-overlay" onMouseDown={() => close(false)}>
          <div className="cx-dialog" role="alertdialog" aria-modal="true" aria-label={conf.title} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && close(false)}>
            <h3>{conf.title}</h3>
            {conf.body && <div className="cx-dialog-body">{conf.body}</div>}
            <div className="cx-dialog-acts">
              <button type="button" className="cx-btn" onClick={() => close(false)}>
                Cancel
              </button>
              <button type="button" className={`cx-btn ${conf.danger ? 'danger-fill' : 'pri'}`} autoFocus onClick={() => close(true)}>
                {conf.ok}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="cx-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`cx-toast ${t.bad ? 'bad' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </UiCtx.Provider>
  );
}

export function useUi() {
  const u = useContext(UiCtx);
  if (!u) throw new Error('useUi outside UiProvider');
  return u;
}

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 4), y: Math.min(y, window.innerHeight - r.height - 4) });
    (el.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.focus();
    const away = (e: MouseEvent) => !el.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('blur', onClose);
    };
  }, [x, y, onClose]);
  const move = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = [...(ref.current?.querySelectorAll('button:not(:disabled)') ?? [])] as HTMLButtonElement[];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
  };
  return (
    <div ref={ref} className="cx-menu" role="menu" style={{ left: pos.x, top: pos.y }} onKeyDown={move} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="cx-menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`cx-menu-item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.run?.();
            }}
          >
            <span>{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
