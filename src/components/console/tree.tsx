'use client';

import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Ico, type IconName } from './icons';
import { type MenuItem, useUi } from './store';
import { readPref, writePref } from './prefs';

export interface TreeNode {
  key: string;
  label: ReactNode;
  /** Plain text for renaming and type-to-find. */
  text: string;
  icon?: IconName;
  iconClass?: string;
  badge?: ReactNode;
  meta?: ReactNode;
  title?: string;
  dim?: boolean;
  selected?: boolean;
  children?: TreeNode[];
  /** Start in rename mode (used for "new item" rows). */
  editing?: boolean;
  onOpen?: () => void;
  onRename?: (name: string) => void;
  /** Checks a new name; a message keeps the box open and is shown under it. */
  validate?: (name: string) => string | null;
  onCancelEdit?: () => void;
  onDelete?: () => void;
  menu?: () => MenuItem[];
  /** Drag payload, e.g. "file:3". */
  drag?: string;
  canDrop?: (payload: string) => boolean;
  onDrop?: (payload: string) => void;
  actions?: { icon: IconName; label: string; run: () => void }[];
}

// The payload being dragged; dataTransfer can't be read during dragover.
let dragging: string | null = null;

/** Let something outside a tree (e.g. a library list) be dropped onto tree rows: "file:3", "doc:5". */
export function setTreeDrag(payload: string | null) {
  dragging = payload;
}

interface Flat {
  node: TreeNode;
  depth: number;
  parent: string | null;
}

function flatten(nodes: TreeNode[], expanded: Set<string>, depth = 0, parent: string | null = null, out: Flat[] = []): Flat[] {
  for (const n of nodes) {
    out.push({ node: n, depth, parent });
    if (n.children?.length && expanded.has(n.key)) flatten(n.children, expanded, depth + 1, n.key, out);
  }
  return out;
}

/**
 * A VS Code-style tree: 22px rows, 8px indent per level, twisties, keyboard navigation
 * (arrows, Home/End, Enter, F2, Delete, Shift+F10), right-click menus, inline rename and drag and drop.
 */
export function Tree({ nodes, expanded, onToggle, label, empty }: { nodes: TreeNode[]; expanded: Set<string>; onToggle: (key: string, open?: boolean) => void; label: string; empty?: ReactNode }) {
  const ui = useUi();
  const rows = useMemo(() => flatten(nodes, expanded), [nodes, expanded]);
  const [focus, setFocus] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // One selection per tree, like VS Code: the row you last clicked, until the open page changes.
  const [picked, setPicked] = useState<string | null>(null);
  const pathSel = rows.find((r) => r.node.selected)?.node.key ?? null;
  useEffect(() => setPicked(null), [pathSel]);
  const isSel = (n: TreeNode) => (picked && rows.some((r) => r.node.key === picked) ? n.key === picked : !!n.selected);
  const ref = useRef<HTMLDivElement>(null);

  const editingKey = rows.find((r) => r.node.editing)?.node.key ?? renaming;
  const focusKey = focus && rows.some((r) => r.node.key === focus) ? focus : (rows.find((r) => r.node.selected)?.node.key ?? rows[0]?.node.key ?? null);

  useEffect(() => {
    const a = document.activeElement;
    if (!focusKey || !ref.current?.contains(a) || a?.tagName === 'INPUT') return;
    (ref.current.querySelector(`[data-key="${CSS.escape(focusKey)}"]`) as HTMLElement | null)?.focus();
  }, [focusKey]);

  const openMenu = (n: TreeNode, x: number, y: number) => {
    const items = n.menu?.() ?? [];
    if (n.onRename && !items.some((i) => i.label === 'Rename')) {
      const at = items.findIndex((i) => i.sep);
      items.splice(at < 0 ? items.length : at, 0, { label: 'Rename', hint: 'F2', run: () => setRenaming(n.key) });
    }
    if (items.length) ui.menu(x, y, items);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editingKey) return;
    // The focused row is the truth; state can lag a fast keypress.
    const activeKey = (document.activeElement as HTMLElement | null)?.dataset?.key ?? focusKey;
    const i = rows.findIndex((r) => r.node.key === activeKey);
    const cur = rows[i];
    if (!cur) return;
    const n = cur.node;
    const go = (j: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (r) setFocus(r.node.key);
    };
    switch (e.key) {
      case 'ArrowDown':
        go(i + 1);
        break;
      case 'ArrowUp':
        go(i - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(rows.length - 1);
        break;
      case 'ArrowRight':
        if (n.children?.length && !expanded.has(n.key)) onToggle(n.key, true);
        else if (n.children?.length) go(i + 1);
        break;
      case 'ArrowLeft':
        if (n.children?.length && expanded.has(n.key)) onToggle(n.key, false);
        else if (cur.parent) setFocus(cur.parent);
        break;
      case 'Enter':
      case ' ':
        setPicked(n.key);
        n.onOpen?.();
        if (n.children?.length && !n.onOpen) onToggle(n.key);
        break;
      case 'F2':
        if (n.onRename) setRenaming(n.key);
        break;
      case 'Delete':
        n.onDelete?.();
        break;
      case 'Backspace':
        if (e.metaKey) n.onDelete?.();
        else return;
        break;
      case 'ContextMenu':
      case 'F10': {
        if (e.key === 'F10' && !e.shiftKey) return;
        const el = ref.current?.querySelector(`[data-key="${CSS.escape(n.key)}"]`)?.getBoundingClientRect();
        if (el) openMenu(n, el.left + 24, el.bottom);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  if (!rows.length && empty) return <div className="cx-tree-empty">{empty}</div>;

  return (
    <div ref={ref} className="cx-tree" role="tree" aria-label={label} onKeyDown={onKey}>
      {rows.map(({ node: n, depth }) => {
        const hasKids = !!n.children?.length;
        const open = expanded.has(n.key);
        const editing = editingKey === n.key;
        return (
          <div
            key={n.key}
            data-key={n.key}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={hasKids ? open : undefined}
            aria-selected={isSel(n)}
            tabIndex={n.key === focusKey ? 0 : -1}
            className={`cx-row ${isSel(n) ? 'sel' : ''} ${n.dim ? 'dim' : ''} ${over === n.key ? 'drop-on' : ''}`}
            style={{ paddingLeft: 8 + depth * 12 }}
            title={n.title}
            draggable={!!n.drag && !editing}
            onFocus={(e) => e.target === e.currentTarget && setFocus(n.key)}
            onClick={() => {
              setFocus(n.key);
              setPicked(n.key);
              if (n.onOpen) n.onOpen();
              else if (hasKids) onToggle(n.key);
            }}
            onDoubleClick={(e) => {
              if (n.onRename) {
                e.preventDefault();
                setRenaming(n.key);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setFocus(n.key);
              openMenu(n, e.clientX, e.clientY);
            }}
            onDragStart={(e) => {
              dragging = n.drag ?? null;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', n.text);
            }}
            onDragEnd={() => {
              dragging = null;
              setOver(null);
            }}
            onDragOver={(e) => {
              if (dragging && n.onDrop && (n.canDrop?.(dragging) ?? true)) {
                e.preventDefault();
                if (over !== n.key) setOver(n.key);
              }
            }}
            onDragLeave={() => over === n.key && setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const p = dragging;
              dragging = null;
              if (p && n.onDrop && (n.canDrop?.(p) ?? true)) n.onDrop(p);
            }}
          >
            <span
              className={`cx-twist ${open ? 'open' : ''} ${hasKids ? '' : 'none'}`}
              onClick={(e) => {
                e.stopPropagation();
                if (hasKids) onToggle(n.key);
              }}
            >
              <Ico n="chevron" size={14} />
            </span>
            {n.icon && (
              <span className={`cx-ico ${n.iconClass ?? ''}`}>
                <Ico n={n.icon === 'folder' && open && hasKids ? 'folderOpen' : n.icon} />
              </span>
            )}
            {editing ? (
              <input
                className="cx-inline"
                autoFocus
                ref={(el) => el?.scrollIntoView({ block: 'nearest' })}
                defaultValue={n.editing ? '' : n.text}
                aria-label={n.editing ? 'Name' : `Rename ${n.text}`}
                spellCheck={false}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => {
                  // Select the name without its extension, like VS Code (folders: the whole name).
                  const v = e.target.value;
                  const dot = n.icon === 'folder' ? -1 : v.lastIndexOf('.');
                  e.target.setSelectionRange(0, dot > 0 ? dot : v.length);
                }}
                onChange={() => nameErr && setNameErr(null)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') {
                    const v = (e.target as HTMLInputElement).value.trim();
                    const err = v && !(!n.editing && v === n.text) ? (n.validate?.(v) ?? null) : null;
                    if (err) return setNameErr(err);
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === 'Escape') {
                    (e.target as HTMLInputElement).dataset.cancel = '1';
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  const cancelled = e.target.dataset.cancel === '1';
                  const bad = !cancelled && v && !(!n.editing && v === n.text) ? (n.validate?.(v) ?? null) : null;
                  setRenaming(null);
                  setNameErr(null);
                  if (bad) ui.toast(bad, true);
                  if (cancelled || bad || !v || (!n.editing && v === n.text)) n.onCancelEdit?.();
                  else n.onRename?.(v);
                  ref.current?.focus();
                }}
              />
            ) : (
              <span className="cx-label">{n.label}</span>
            )}
            {editing && nameErr && (
              <span className="cx-inline-err" role="alert">
                {nameErr}
              </span>
            )}
            {!editing && n.badge !== undefined && n.badge !== null && n.badge !== 0 && <span className="cx-badge">{n.badge}</span>}
            {!editing && n.meta && <span className="cx-meta">{n.meta}</span>}
            {!editing &&
              n.actions?.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  className="cx-row-act"
                  title={a.label}
                  aria-label={a.label}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    a.run();
                  }}
                >
                  <Ico n={a.icon} size={14} />
                </button>
              ))}
          </div>
        );
      })}
    </div>
  );
}

/** Expanded-state helper that remembers itself per tree in this browser. */
export function useExpanded(id: string, initial: string[] = []) {
  const [set, setSet] = useState<Set<string>>(() => new Set(readPref<string[]>(`exp.${id}`, initial)));
  const toggle = (key: string, open?: boolean) =>
    setSet((s) => {
      const n = new Set(s);
      const want = open ?? !n.has(key);
      if (want) n.add(key);
      else n.delete(key);
      writePref(`exp.${id}`, [...n]);
      return n;
    });
  const expand = (keys: string[]) => keys.forEach((k) => toggle(k, true));
  const collapseAll = () => {
    setSet(new Set());
    writePref(`exp.${id}`, []);
  };
  return { expanded: set, toggle, expand, collapseAll };
}
