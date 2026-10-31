'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardNote } from '@/lib/board-notes';

type Tool = 'select' | 'pin' | 'area';
type Save = 'idle' | 'saving' | 'saved' | 'error';

/** Rough map of the VS Code reference screenshot, in % of the picture, so each mark knows where it sits. */
const REGIONS: { name: string; test: (x: number, y: number) => boolean }[] = [
  { name: 'Title bar / command center', test: (_x, y) => y < 3.4 },
  { name: 'Status bar', test: (_x, y) => y > 97.6 },
  { name: 'Activity bar', test: (x) => x < 2.6 },
  { name: 'Primary side bar (Explorer)', test: (x) => x < 18.3 },
  { name: 'Secondary side bar (Chat)', test: (x) => x > 84.6 },
  { name: 'Editor tabs', test: (_x, y) => y < 6.6 },
  { name: 'Editor breadcrumbs', test: (_x, y) => y < 8.2 },
  { name: 'Editor', test: () => true },
];
const regionAt = (x: number, y: number) => REGIONS.find((r) => r.test(x, y))!.name;

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

async function call<T>(method: string, body?: unknown): Promise<T> {
  const res = await fetch('/api/admin/board-notes', {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function DesignBoard({ board }: { board: string }) {
  const [all, setAll] = useState<BoardNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('pin');
  const [sel, setSel] = useState<string | null>(null);
  const [save, setSave] = useState<Save>('idle');
  const [fit, setFit] = useState(true);
  const [showMarks, setShowMarks] = useState(true);
  const [showDone, setShowDone] = useState(true);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [imgMissing, setImgMissing] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  const notes = useMemo(() => all.filter((n) => n.board === board).sort((a, b) => a.n - b.n), [all, board]);
  const selected = notes.find((n) => n.id === sel) ?? null;

  useEffect(() => {
    call<{ notes: BoardNote[] }>('GET')
      .then((r) => {
        setAll(r.notes);
        setLoaded(true);
      })
      // Never save over a file we could not read.
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  // Autosave the whole list shortly after the last change.
  useEffect(() => {
    if (!loaded || !dirty.current) return;
    if (timer.current) clearTimeout(timer.current);
    setSave('saving');
    timer.current = setTimeout(() => {
      dirty.current = false;
      call('PUT', { notes: all })
        .then(() => setSave('saved'))
        .catch(() => setSave('error'));
    }, 500);
  }, [all, loaded]);

  const change = useCallback((fn: (prev: BoardNote[]) => BoardNote[]) => {
    dirty.current = true;
    setAll(fn);
  }, []);

  const patch = (id: string, p: Partial<BoardNote>) => change((prev) => prev.map((n) => (n.id === id ? { ...n, ...p, updated_at: Date.now() } : n)));
  const remove = (id: string) => {
    change((prev) => prev.filter((n) => n.id !== id));
    setSel(null);
  };

  const add = (x: number, y: number, w?: number, h?: number) => {
    const n = (notes.reduce((m, x) => Math.max(m, x.n), 0) || 0) + 1;
    const cx = w ? x + w / 2 : x;
    const cy = h ? y + h / 2 : y;
    const note: BoardNote = { id: uid(), board, n, x, y, ...(w && h ? { w, h } : {}), region: regionAt(cx, cy), text: '', done: false, created_at: Date.now(), updated_at: Date.now() };
    change((prev) => [...prev, note]);
    setSel(note.id);
  };

  const pos = (e: { clientX: number; clientY: number }) => {
    const r = surface.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)), y: Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100)) };
  };

  const onDown = (e: React.PointerEvent) => {
    if (!loaded || e.button !== 0 || (e.target as HTMLElement).closest('.vsd-mark, .vsd-pop')) return;
    const p = pos(e);
    // Marks are added on pointer-up, so the new comment box keeps focus after the click.
    if (tool === 'pin' || tool === 'area') {
      setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } else setSel(null);
  };

  const onMove = (e: React.PointerEvent) => {
    if (draft && tool === 'area') {
      const p = pos(e);
      setDraft({ ...draft, x1: p.x, y1: p.y });
    } else if (drag.current) {
      const p = pos(e);
      drag.current.moved = true;
      const { id, dx, dy } = drag.current;
      setAll((prev) => prev.map((n) => (n.id === id ? { ...n, x: Math.max(0, Math.min(100 - (n.w ?? 0), p.x - dx)), y: Math.max(0, Math.min(100 - (n.h ?? 0), p.y - dy)) } : n)));
    }
  };

  const onUp = () => {
    if (draft) {
      const x = Math.min(draft.x0, draft.x1);
      const y = Math.min(draft.y0, draft.y1);
      const w = Math.abs(draft.x1 - draft.x0);
      const h = Math.abs(draft.y1 - draft.y0);
      setDraft(null);
      if (tool === 'area' && w > 0.8 && h > 0.8) add(x, y, w, h);
      else add(draft.x0, draft.y0);
    }
    if (drag.current) {
      const { id, moved } = drag.current;
      drag.current = null;
      if (moved) {
        dirty.current = true;
        setAll((prev) => prev.map((n) => (n.id === id ? { ...n, region: regionAt(n.x + (n.w ?? 0) / 2, n.y + (n.h ?? 0) / 2), updated_at: Date.now() } : n)));
      }
    }
  };

  const startDrag = (e: React.PointerEvent, n: BoardNote) => {
    e.stopPropagation();
    setSel(n.id);
    const p = pos(e);
    drag.current = { id: n.id, dx: p.x - n.x, dy: p.y - n.y, moved: false };
    surface.current?.setPointerCapture(e.pointerId);
  };

  // Keyboard: V / P / A tools, Esc closes, Delete removes the selected mark (when not typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('textarea, input');
      if (e.key === 'Escape') {
        setSel(null);
        setDraft(null);
        (document.activeElement as HTMLElement | null)?.blur();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'v') setTool('select');
      else if (k === 'p') setTool('pin');
      else if (k === 'a') setTool('area');
      else if (k === 'h') setShowMarks((s) => !s);
      else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) remove(sel);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const markdown = () =>
    [`# Design notes: ${board}`, '', ...notes.map((n) => `${n.n}. [${n.done ? 'x' : ' '}] **${n.region}**${n.w ? ' (area)' : ''}: ${n.text.trim() || '_(no comment)_'}`)].join('\n');

  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy the notes:', markdown());
    }
  };

  const open = notes.filter((n) => !n.done).length;
  const visible = notes.filter((n) => showDone || !n.done);

  return (
    <div className="vsd">
      <header className="vsd-top">
        <div className="vsd-brand">
          <span className="vsd-logo" aria-hidden>◆</span> GuardRail <span className="vsd-dim">· Design board</span>
          <span className="vsd-chip">{board}</span>
        </div>
        <div className="vsd-tools" role="toolbar" aria-label="Tools">
          <ToolBtn on={tool === 'select'} onClick={() => setTool('select')} k="V" label="Select / move">
            <path d="M5 3l14 8-6 2-3 6z" />
          </ToolBtn>
          <ToolBtn on={tool === 'pin'} onClick={() => setTool('pin')} k="P" label="Pin + comment">
            <path d="M12 21s-6-5.3-6-10a6 6 0 1112 0c0 4.7-6 10-6 10z" />
            <circle cx="12" cy="11" r="2" />
          </ToolBtn>
          <ToolBtn on={tool === 'area'} onClick={() => setTool('area')} k="A" label="Mark an area">
            <rect x="4" y="5" width="16" height="14" rx="1" strokeDasharray="3 2" />
          </ToolBtn>
          <span className="vsd-sep" />
          <button type="button" className="vsd-btn" onClick={() => setFit((f) => !f)} title="Fit to window or show at full size">
            {fit ? 'Fit' : '100%'}
          </button>
          <button type="button" className={`vsd-btn ${showMarks ? '' : 'off'}`} onClick={() => setShowMarks((s) => !s)} title="Show or hide marks (H)">
            {showMarks ? 'Marks on' : 'Marks off'}
          </button>
        </div>
        <div className="vsd-right">
          <span className={`vsd-save ${save}`}>{save === 'saving' ? 'Saving…' : save === 'saved' ? 'Saved' : save === 'error' ? 'Not saved' : loadError ? `Could not load: ${loadError}` : loaded ? '' : 'Loading…'}</span>
          <button type="button" className="vsd-btn pri" onClick={copy} disabled={!notes.length}>
            {copied ? 'Copied' : 'Copy as Markdown'}
          </button>
        </div>
      </header>

      <div className="vsd-body">
        <main className={`vsd-stage ${fit ? 'fit' : ''}`}>
          <div
            ref={surface}
            className={`vsd-surface tool-${tool}`}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/designer/${board}.png`} alt="Reference layout" draggable={false} onError={() => setImgMissing(true)} />
            {imgMissing && <div className="vsd-missing">No picture at public/designer/{board}.png</div>}
            {showMarks &&
              visible.map((n) =>
                n.w && n.h ? (
                  <div
                    key={n.id}
                    className={`vsd-mark vsd-area ${n.id === sel ? 'sel' : ''} ${n.done ? 'done' : ''}`}
                    style={{ left: `${n.x}%`, top: `${n.y}%`, width: `${n.w}%`, height: `${n.h}%` }}
                    onPointerDown={(e) => startDrag(e, n)}
                    title={n.text || n.region}
                  >
                    <span className="vsd-num">{n.n}</span>
                  </div>
                ) : (
                  <button
                    key={n.id}
                    type="button"
                    className={`vsd-mark vsd-pin ${n.id === sel ? 'sel' : ''} ${n.done ? 'done' : ''}`}
                    style={{ left: `${n.x}%`, top: `${n.y}%` }}
                    onPointerDown={(e) => startDrag(e, n)}
                    title={n.text || n.region}
                  >
                    <span>{n.n}</span>
                  </button>
                ),
              )}
            {draft && tool === 'area' && (
              <div
                className="vsd-area draft"
                style={{ left: `${Math.min(draft.x0, draft.x1)}%`, top: `${Math.min(draft.y0, draft.y1)}%`, width: `${Math.abs(draft.x1 - draft.x0)}%`, height: `${Math.abs(draft.y1 - draft.y0)}%` }}
              />
            )}
            {selected && showMarks && <Popover note={selected} onPatch={(p) => patch(selected.id, p)} onDelete={() => remove(selected.id)} onClose={() => setSel(null)} />}
          </div>
        </main>

        <aside className="vsd-side">
          <div className="vsd-side-head">
            <span>COMMENTS</span>
            <span className="vsd-dim">
              {open} open · {notes.length - open} done
            </span>
          </div>
          <label className="vsd-check">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show done
          </label>
          {!notes.length && (
            <div className="vsd-empty">
              <p>
                Pick <b>Pin</b> (P) and click anywhere on the picture, or <b>Area</b> (A) and drag a box. Then write what should go there.
              </p>
              <p className="vsd-dim">Comments save automatically to data/board-notes.json on this machine.</p>
            </div>
          )}
          <ol className="vsd-list">
            {visible.map((n) => (
              <li key={n.id} className={`${n.id === sel ? 'sel' : ''} ${n.done ? 'done' : ''}`} onClick={() => setSel(n.id)}>
                <span className={`vsd-num ${n.w ? 'sq' : ''}`}>{n.n}</span>
                <div>
                  <div className="vsd-region">{n.region}</div>
                  <div className="vsd-text">{n.text.trim() || <i className="vsd-dim">No comment yet</i>}</div>
                </div>
              </li>
            ))}
          </ol>
          <div className="vsd-keys vsd-dim">V select · P pin · A area · H hide · Del remove · Esc close</div>
        </aside>
      </div>
    </div>
  );
}

function ToolBtn({ on, onClick, k, label, children }: { on: boolean; onClick: () => void; k: string; label: string; children: React.ReactNode }) {
  return (
    <button type="button" className={`vsd-tool ${on ? 'on' : ''}`} onClick={onClick} title={`${label} (${k})`} aria-pressed={on} aria-label={label}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

function Popover({ note, onPatch, onDelete, onClose }: { note: BoardNote; onPatch: (p: Partial<BoardNote>) => void; onDelete: () => void; onClose: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!note.text) ref.current?.focus();
    // Focus only when a different note opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);
  const right = note.x + (note.w ?? 0);
  const left = right > 70 ? `calc(${note.x}% - 300px)` : `calc(${right}% + 18px)`;
  const top = `min(${note.y}%, calc(100% - 230px))`;
  return (
    <div className="vsd-pop" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="vsd-pop-head">
        <span className={`vsd-num ${note.w ? 'sq' : ''}`}>{note.n}</span>
        <span className="vsd-region">{note.region}</span>
        <button type="button" className="vsd-x" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <textarea
        ref={ref}
        value={note.text}
        placeholder="What goes here? e.g. Servers list with status dots"
        onChange={(e) => onPatch({ text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onClose();
        }}
      />
      <div className="vsd-pop-foot">
        <label className="vsd-check">
          <input type="checkbox" checked={note.done} onChange={(e) => onPatch({ done: e.target.checked })} /> Done
        </label>
        <button type="button" className="vsd-btn danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}
