'use client';

import { type MouseEvent as RMouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/components/ui';
import type { DesignNote } from '@/lib/design-notes';
import './workbench.css';

/*
 * New frontend, design stage. A VS Code-style shell whose regions are still empty, with a
 * comment layer on top: click to drop a pin, drag to mark a box, and write what goes there.
 * Notes are saved to design/workbench-notes.json.
 */

type Board = 'shell' | 'screenshot';
type Draft = { kind: 'pin' | 'box'; x: number; y: number; w?: number; h?: number; zone: string };

const ACTIVITY = [
  { id: 'explorer', label: 'Explorer', d: 'M4 4h7l2 2h7v13H4z' },
  { id: 'search', label: 'Search', d: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5 20 20' },
  { id: 'servers', label: 'Servers', d: 'M4 5h16v5H4zM4 14h16v5H4zM7 7.5h.01M7 16.5h.01' },
  { id: 'keys', label: 'API keys', d: 'M14.5 4a5.5 5.5 0 1 1-4.9 8L4 17.6V20h3v-2h2v-2h2l1.5-1.5A5.5 5.5 0 0 1 14.5 4zM16 8h.01' },
  { id: 'guard', label: 'Guard', d: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z' },
  { id: 'activity', label: 'Activity', d: 'M3 12h4l3-7 4 14 3-7h4' },
];

const zoneOf = (x: number, y: number) => {
  for (const el of document.elementsFromPoint(x, y)) {
    const z = (el as HTMLElement).closest?.('[data-zone]');
    if (z) return z.getAttribute('data-zone') ?? '';
  }
  return '';
};

function Zone({ name, className, children, style }: { name: string; className?: string; children?: ReactNode; style?: React.CSSProperties }) {
  return (
    <div className={`wb-zone ${className ?? ''}`} data-zone={name} style={style}>
      <span className="wb-zone-tag">{name}</span>
      {children}
    </div>
  );
}

function Sash({ dir, onDrag }: { dir: 'x' | 'y'; onDrag: (delta: number) => void }) {
  const start = (e: RMouseEvent) => {
    e.preventDefault();
    let last = dir === 'x' ? e.clientX : e.clientY;
    const move = (ev: MouseEvent) => {
      const p = dir === 'x' ? ev.clientX : ev.clientY;
      onDrag(p - last);
      last = p;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return <div className={`wb-sash wb-sash-${dir}`} onMouseDown={start} />;
}

const Skel = ({ w, indent = 0 }: { w: number; indent?: number }) => <div className="wb-skel" style={{ width: `${w}%`, marginLeft: indent * 12 }} />;

export default function Workbench() {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [board, setBoard] = useState<Board>('shell');
  const [view, setView] = useState('explorer');
  const [left, setLeft] = useState(260);
  const [right, setRight] = useState(320);
  const [bottom, setBottom] = useState(200);
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [showBottom, setShowBottom] = useState(true);

  const [notes, setNotes] = useState<DesignNote[]>([]);
  const [mode, setMode] = useState(true);
  const [showMarks, setShowMarks] = useState(true);
  const [listOpen, setListOpen] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [hover, setHover] = useState<{ x: number; y: number; zone: string } | null>(null);

  useEffect(() => {
    api<{ notes: DesignNote[] }>('design-notes').then((r) => setNotes(r.notes)).catch((e) => setStatus(e.message));
  }, []);

  const save = useCallback(async (next: DesignNote[]) => {
    setNotes(next);
    try {
      await api('design-notes', { method: 'PUT', body: { notes: next } });
      setStatus('Saved');
    } catch (e) {
      setStatus(`Not saved: ${(e as Error).message}`);
    }
  }, []);

  // C toggles comment mode, Esc closes whatever is open.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('textarea, input');
      if (e.key === 'Escape') {
        setDraft(null);
        setOpen(null);
        setEditing(null);
      } else if (!typing && (e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey) {
        setMode((m) => !m);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const pct = (px: number, py: number) => {
    const r = (board === 'screenshot' ? canvas.current : root.current)!.getBoundingClientRect();
    return { x: ((px - r.left) / r.width) * 100, y: ((py - r.top) / r.height) * 100 };
  };

  // On the screenshot there is no DOM to ask, so name the VS Code region from its position.
  const zoneAt = (px: number, py: number) => {
    if (board === 'shell') return zoneOf(px, py);
    const { x, y } = pct(px, py);
    if (y < 3.3) return 'Screenshot · Title bar';
    if (y > 97.4) return 'Screenshot · Status bar';
    if (x < 2.6) return 'Screenshot · Activity bar';
    if (x < 18.3) return 'Screenshot · Primary sidebar';
    if (x > 84.6) return 'Screenshot · Secondary sidebar';
    if (y < 6.5) return 'Screenshot · Editor tabs';
    return 'Screenshot · Editor area';
  };
  const shown = notes.filter((x) => (x.board ?? 'shell') === board);

  const down = (e: RMouseEvent) => {
    if (e.button !== 0 || draft) return;
    setOpen(null);
    setDrag({ x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY });
  };
  const move = (e: RMouseEvent) => {
    if (drag) setDrag({ ...drag, x: e.clientX, y: e.clientY });
    setHover({ x: e.clientX, y: e.clientY, zone: zoneAt(e.clientX, e.clientY) });
  };
  const up = () => {
    if (!drag) return;
    const zone = zoneAt(drag.x0, drag.y0);
    const a = pct(Math.min(drag.x0, drag.x), Math.min(drag.y0, drag.y));
    const b = pct(Math.max(drag.x0, drag.x), Math.max(drag.y0, drag.y));
    const big = Math.abs(drag.x - drag.x0) > 8 && Math.abs(drag.y - drag.y0) > 8;
    setDraft(big ? { kind: 'box', x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, zone } : { kind: 'pin', ...pct(drag.x0, drag.y0), zone });
    setText('');
    setDrag(null);
  };

  const addDraft = () => {
    if (!draft || !text.trim()) return;
    const n = shown.reduce((m, x) => Math.max(m, x.n), 0) + 1;
    void save([...notes, { ...draft, board, id: `${Date.now()}`, n, text: text.trim(), createdAt: Date.now() }]);
    setDraft(null);
  };

  const update = (id: string, patch: Partial<DesignNote>) => save(notes.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const remove = (id: string) => {
    void save(notes.filter((x) => x.id !== id));
    setOpen(null);
  };

  const markdown = () =>
    shown
      .map((x) => `${x.n}. [${x.zone || 'workbench'}${x.kind === 'box' ? ', box' : ''}]${x.done ? ' (done)' : ''} ${x.text}`)
      .join('\n');

  const popPos = (x: number, y: number): React.CSSProperties => ({
    left: `min(calc(${x}% + 14px), calc(100% - 300px))`,
    top: `min(calc(${y}% + 14px), calc(100% - 220px))`,
  });

  const clickActivity = (id: string) => {
    if (id === view) setShowLeft(!showLeft);
    else {
      setView(id);
      setShowLeft(true);
    }
  };
  const viewLabel = ACTIVITY.find((a) => a.id === view)?.label ?? '';

  const layer = (
    <>
      {/* ---------- comment layer ---------- */}
      {mode && <div className="wb-capture" onMouseDown={down} onMouseMove={move} onMouseUp={up} onMouseLeave={() => setHover(null)} />}
      {mode && hover?.zone && !draft && (
        <div className="wb-hover-tag" style={{ left: hover.x + 14, top: hover.y + 16 }}>
          {hover.zone}
        </div>
      )}
      {mode && <div className="wb-mode-frame" />}

      {drag && (
        <div
          className="wb-rubber"
          style={{ left: Math.min(drag.x0, drag.x), top: Math.min(drag.y0, drag.y), width: Math.abs(drag.x - drag.x0), height: Math.abs(drag.y - drag.y0) }}
        />
      )}

      {showMarks &&
        shown.map((x) => (
          <div key={x.id}>
            {x.kind === 'box' && <div className={`wb-box ${x.done ? 'done' : ''}`} style={{ left: `${x.x}%`, top: `${x.y}%`, width: `${x.w}%`, height: `${x.h}%` }} />}
            <button
              className={`wb-pin ${x.done ? 'done' : ''} ${open === x.id ? 'sel' : ''}`}
              style={{ left: `${x.x}%`, top: `${x.y}%` }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(open === x.id ? null : x.id);
                setEditing(null);
              }}
              title={x.text}
            >
              {x.n}
            </button>
            {open === x.id && (
              <div className="wb-pop" style={popPos(x.x, x.y)} onMouseDown={(e) => e.stopPropagation()}>
                <div className="wb-pop-head">
                  <b>#{x.n}</b> <span>{x.zone || 'Workbench'}</span>
                  <span style={{ flex: 1 }} />
                  <button onClick={() => setOpen(null)}>×</button>
                </div>
                {editing === x.id ? (
                  <EditBox
                    initial={x.text}
                    onSave={(t) => {
                      void update(x.id, { text: t });
                      setEditing(null);
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <>
                    <div className="wb-pop-text">{x.text}</div>
                    <div className="wb-pop-actions">
                      <button onClick={() => setEditing(x.id)}>Edit</button>
                      <button onClick={() => update(x.id, { done: !x.done })}>{x.done ? 'Reopen' : 'Mark done'}</button>
                      <button className="danger" onClick={() => confirm(`Delete note #${x.n}?`) && remove(x.id)}>
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        ))}

      {draft && (
        <>
          {draft.kind === 'box' && <div className="wb-box draft" style={{ left: `${draft.x}%`, top: `${draft.y}%`, width: `${draft.w}%`, height: `${draft.h}%` }} />}
          <div className="wb-pin draft" style={{ left: `${draft.x}%`, top: `${draft.y}%` }}>
            +
          </div>
          <div className="wb-pop" style={popPos(draft.x, draft.y)} onMouseDown={(e) => e.stopPropagation()}>
            <div className="wb-pop-head">
              <b>New {draft.kind === 'box' ? 'area' : 'pin'}</b> <span>{draft.zone || 'Workbench'}</span>
            </div>
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What should go here? e.g. “List of servers with live status dots”"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addDraft();
              }}
            />
            <div className="wb-pop-actions">
              <span className="hint">⌘↵ to save · Esc to cancel</span>
              <button onClick={() => setDraft(null)}>Cancel</button>
              <button className="pri" onClick={addDraft} disabled={!text.trim()}>
                Comment
              </button>
            </div>
          </div>
        </>
      )}

    </>
  );

  return (
    <div className="wb" ref={root}>
      {/* ---------- title bar ---------- */}
      <Zone name="Title bar" className="wb-title">
        <div className="wb-brand">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />
          </svg>
          GuardRail
        </div>
        <div className="wb-menu">
          <span>File</span>
          <span>Edit</span>
          <span>View</span>
          <span>Go</span>
          <span>Help</span>
        </div>
        <div className="wb-command">Search servers, keys, logs… ⌘P</div>
        <div className="wb-layout-btns">
          <button className={showLeft ? 'on' : ''} onClick={() => setShowLeft(!showLeft)} title="Toggle primary sidebar">▏▢</button>
          <button className={showBottom ? 'on' : ''} onClick={() => setShowBottom(!showBottom)} title="Toggle panel">▁▢</button>
          <button className={showRight ? 'on' : ''} onClick={() => setShowRight(!showRight)} title="Toggle secondary sidebar">▢▕</button>
        </div>
      </Zone>

      <div className="wb-body">
        {/* ---------- activity bar ---------- */}
        <Zone name="Activity bar" className="wb-activity">
          {ACTIVITY.map((a) => (
            <button key={a.id} className={`wb-act ${a.id === view && showLeft ? 'on' : ''}`} title={a.label} onClick={() => clickActivity(a.id)}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d={a.d} />
              </svg>
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <button className="wb-act" title="Account">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6" /></svg>
          </button>
          <button className="wb-act" title="Settings">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></svg>
          </button>
        </Zone>

        {/* ---------- primary sidebar ---------- */}
        {showLeft && (
          <>
            <Zone name={`Primary sidebar · ${viewLabel}`} className="wb-side" style={{ width: left }}>
              <div className="wb-side-head">
                {viewLabel.toUpperCase()}
                <span>···</span>
              </div>
              <div className="wb-section">▾ SECTION A</div>
              <div className="wb-tree">
                <Skel w={60} />
                <Skel w={45} indent={1} />
                <Skel w={55} indent={1} />
                <Skel w={40} indent={1} />
                <Skel w={70} />
                <Skel w={50} indent={1} />
              </div>
              <div className="wb-section">▾ SECTION B</div>
              <div className="wb-tree">
                <Skel w={65} />
                <Skel w={35} />
                <Skel w={58} />
              </div>
              <div style={{ flex: 1 }} />
              <div className="wb-section">› OUTLINE</div>
              <div className="wb-section">› TIMELINE</div>
            </Zone>
            <Sash dir="x" onDrag={(d) => setLeft((w) => Math.min(600, Math.max(170, w + d)))} />
          </>
        )}

        {/* ---------- editor + panel ---------- */}
        <div className="wb-center">
          <Zone name="Editor tabs" className="wb-tabs">
            <div className="wb-tab on">
              <span className="wb-dot" /> Untitled view <span className="x">×</span>
            </div>
            <div className="wb-tab">
              <span className="wb-dot b" /> Another view
            </div>
            <div style={{ flex: 1 }} />
            <span className="wb-tab-actions">⫶ ▢ ···</span>
          </Zone>
          <Zone name="Breadcrumbs" className="wb-crumbs">
            guardrail › section › item
          </Zone>
          <Zone name="Editor area" className="wb-editor">
            <div className="wb-empty">
              <svg viewBox="0 0 24 24" width="88" height="88" fill="none" stroke="currentColor" strokeWidth="1">
                <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />
              </svg>
              <div className="wb-empty-title">GuardRail workbench</div>
              <div className="wb-empty-sub">
                Design mode. Click anywhere to drop a pin, drag to mark an area, and write what should go there.
                <br />
                Press <kbd>C</kbd> to switch between commenting and clicking through the UI.
              </div>
            </div>
          </Zone>
          {showBottom && (
            <>
              <Sash dir="y" onDrag={(d) => setBottom((h) => Math.min(600, Math.max(90, h - d)))} />
              <Zone name="Bottom panel" className="wb-panel" style={{ height: bottom }}>
                <div className="wb-panel-tabs">
                  <span className="on">PROBLEMS</span>
                  <span>OUTPUT</span>
                  <span>TERMINAL</span>
                  <span>PORTS</span>
                  <div style={{ flex: 1 }} />
                  <span onClick={() => setShowBottom(false)} style={{ cursor: 'pointer' }}>×</span>
                </div>
                <div className="wb-tree" style={{ padding: '8px 14px' }}>
                  <Skel w={50} />
                  <Skel w={72} />
                  <Skel w={38} />
                </div>
              </Zone>
            </>
          )}
        </div>

        {/* ---------- secondary sidebar ---------- */}
        {showRight && (
          <>
            <Sash dir="x" onDrag={(d) => setRight((w) => Math.min(640, Math.max(220, w - d)))} />
            <Zone name="Secondary sidebar" className="wb-side wb-right" style={{ width: right }}>
              <div className="wb-side-head">
                CHAT <span>＋ ···</span>
              </div>
              <div className="wb-tree" style={{ padding: 12 }}>
                <Skel w={80} />
                <Skel w={60} />
              </div>
              <div style={{ flex: 1 }} />
              <div className="wb-chatbox">Ask about a request, a rule, a key…</div>
            </Zone>
          </>
        )}
      </div>

      {/* ---------- status bar ---------- */}
      <Zone name="Status bar" className="wb-status">
        <span className="wb-status-remote">⇄</span>
        <span>⎇ main</span>
        <span>⊘ 0 ⚠ 0</span>
        <div style={{ flex: 1 }} />
        <span>Gateway: —</span>
        <span>Requests/min: —</span>
        <span>🔔</span>
      </Zone>

      {board === 'shell' ? (
        layer
      ) : (
        <div className="wb-stage">
          <div className="wb-canvas" ref={canvas}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/api/design-image/vscode" alt="Reference screenshot" draggable={false} />
            {layer}
          </div>
        </div>
      )}

      {/* ---------- design toolbar ---------- */}
      <div className="wb-toolbar" onMouseDown={(e) => e.stopPropagation()}>
        <div className="wb-seg" role="group" aria-label="Board">
          <button className={board === 'shell' ? 'on' : ''} onClick={() => { setBoard('shell'); setOpen(null); setDraft(null); }}>
            Live shell
          </button>
          <button className={board === 'screenshot' ? 'on' : ''} onClick={() => { setBoard('screenshot'); setOpen(null); setDraft(null); setMode(true); }}>
            Screenshot
          </button>
        </div>
        <button className={mode ? 'pri' : ''} onClick={() => setMode(!mode)} title="Toggle comment mode (C)">
          {mode ? '✎ Commenting' : '↖ Clicking UI'}
        </button>
        <button className={showMarks ? 'on' : ''} onClick={() => setShowMarks(!showMarks)}>
          {showMarks ? 'Hide marks' : 'Show marks'}
        </button>
        <button className={listOpen ? 'on' : ''} onClick={() => setListOpen(!listOpen)}>
          Notes ({shown.filter((x) => !x.done).length}/{shown.length})
        </button>
        {status && <span className="wb-toolbar-status">{status}</span>}
      </div>

      {listOpen && (
        <div className="wb-list" onMouseDown={(e) => e.stopPropagation()}>
          <div className="wb-pop-head">
            <b>Design notes</b>
            <span style={{ flex: 1 }} />
            <button
              onClick={() => {
                void navigator.clipboard.writeText(markdown());
                setStatus('Copied as Markdown');
              }}
            >
              Copy
            </button>
            <button onClick={() => setListOpen(false)}>×</button>
          </div>
          {shown.length === 0 && <div className="wb-pop-text muted">No notes yet. Click or drag anywhere on the workbench.</div>}
          {shown.map((x) => (
            <div
              key={x.id}
              className={`wb-list-item ${x.done ? 'done' : ''}`}
              onClick={() => {
                setShowMarks(true);
                setOpen(x.id);
              }}
            >
              <span className="wb-pin static">{x.n}</span>
              <div>
                <div className="wb-list-zone">{x.zone || 'Workbench'}</div>
                <div>{x.text}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (t: string) => void; onCancel: () => void }) {
  const [t, setT] = useState(initial);
  return (
    <>
      <textarea autoFocus value={t} onChange={(e) => setT(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && t.trim() && onSave(t.trim())} />
      <div className="wb-pop-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="pri" disabled={!t.trim()} onClick={() => onSave(t.trim())}>
          Save
        </button>
      </div>
    </>
  );
}
