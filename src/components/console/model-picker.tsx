'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Ico } from './icons';
import { fmtTokens } from './kit';
import { KIND_LABEL, type ModelKind, type ServerC, kindOf } from './types';

type Row = { serverId: number; server: string; name: string; kind: ModelKind; ctx: number | null; pin: number | null; pout: number | null; enabled: boolean };
type SortKey = 'name' | 'server' | 'ctx' | 'pin' | 'pout';

const money = (n: number | null) => (n == null ? '–' : n === 0 ? 'free' : `$${n < 0.01 ? n.toPrecision(2) : n.toFixed(2)}`);

/**
 * Pick a model from every server: a searchable, sortable table instead of a long dropdown.
 * Search matches model, provider and server; chips narrow by type; ↑ ↓ Enter and Esc work.
 */
export function ModelPicker({
  servers,
  value,
  onPick,
  only,
  placeholder = 'Pick a model',
  label = 'Model',
}: {
  servers: ServerC[];
  value: { serverId: number | null; model: string };
  onPick: (serverId: number, model: string) => void;
  /** Limit the rows, e.g. to models clients may use. */
  only?: (r: { enabled: boolean; kind: ModelKind; name: string }) => boolean;
  placeholder?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<ModelKind | 'all'>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [active, setActive] = useState(0);
  // Placed in the window (not the page), so a wide table never pushes the page sideways.
  const [pos, setPos] = useState<{ top: number; left: number; width: number; list: number } | null>(null);
  const place = () => {
    const b = box.current?.getBoundingClientRect();
    if (!b) return;
    const width = Math.min(920, window.innerWidth - 24);
    const left = Math.max(12, Math.min(b.left, window.innerWidth - width - 12));
    const below = window.innerHeight - b.bottom - 16;
    const top = below > 300 ? b.bottom + 4 : Math.max(12, b.top - Math.min(520, b.top - 12) - 4);
    setPos({ top, left, width, list: Math.max(160, Math.min(360, (below > 300 ? below : b.top - 12) - 130)) });
  };
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const all = useMemo<Row[]>(
    () =>
      servers
        .flatMap((s) => s.models.map((m) => ({ serverId: s.id, server: s.name, name: m.name, kind: kindOf(m), ctx: m.context_len, pin: m.price_in ?? null, pout: m.price_out ?? null, enabled: !!m.enabled })))
        .filter((r) => !only || only(r)),
    [servers, only],
  );
  const counts = useMemo(() => {
    const c = new Map<ModelKind, number>();
    for (const r of all) c.set(r.kind, (c.get(r.kind) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [all]);
  const rows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out = all.filter((r) => (kind === 'all' || r.kind === kind) && words.every((w) => `${r.name} ${r.server} ${KIND_LABEL[r.kind]}`.toLowerCase().includes(w)));
    const v = (r: Row) => (sort.key === 'name' ? r.name : sort.key === 'server' ? r.server : r[sort.key]);
    return out.sort((a, b) => {
      const x = v(a);
      const y = v(b);
      // Unknown prices and sizes go last either way.
      if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1;
      return (typeof x === 'string' ? x.localeCompare(String(y)) : Number(x) - Number(y)) * sort.dir;
    });
  }, [all, q, kind, sort]);

  useEffect(() => setActive(0), [q, kind, sort]);
  useEffect(() => {
    if (!open) return;
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (r: Row) => {
    onPick(r.serverId, r.name);
    setOpen(false);
    setQ('');
  };
  const current = all.find((r) => r.name === value.model && (value.serverId == null || r.serverId === value.serverId));
  const th = (key: SortKey, text: string, cls = '') => (
    <th className={cls}>
      <button type="button" className={sort.key === key ? 'on' : ''} onClick={() => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : key === 'name' || key === 'server' ? 1 : -1 }))}>
        {text} {sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : ''}
      </button>
    </th>
  );

  return (
    <div className="cx-mpick" ref={box}>
      <button type="button" className="cx-input cx-mpick-btn" aria-haspopup="dialog" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}>
        {value.model ? (
          <>
            <span className="mono grow">{value.model}</span>
            <span className="cx-muted small">{current ? `${current.server} · ${KIND_LABEL[current.kind]}` : 'not on any server'}</span>
          </>
        ) : (
          <span className="cx-muted grow">{placeholder}</span>
        )}
        <Ico n="chevron" size={12} />
      </button>
      {open && (
        <div className="cx-mpick-pop" role="dialog" aria-label={`${label} picker`} style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { visibility: 'hidden' }}>
          <div className="cx-form-row center nowrap">
            <input
              className="cx-input grow"
              autoFocus
              type="search"
              placeholder="Search model, provider or server"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(rows.length - 1, a + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === 'Enter' && rows[active]) {
                  e.preventDefault();
                  pick(rows[active]);
                } else if (e.key === 'Escape') setOpen(false);
              }}
            />
            <span className="cx-muted small tnum">
              {rows.length} of {all.length}
            </span>
          </div>
          {counts.length > 1 && (
            <div className="cx-filters" role="radiogroup" aria-label="Model type">
              <button type="button" role="radio" aria-checked={kind === 'all'} className={`cx-chip ${kind === 'all' ? 'on' : ''}`} onClick={() => setKind('all')}>
                All <span>{all.length}</span>
              </button>
              {counts.map(([k, n]) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} className={`cx-chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
                  {KIND_LABEL[k]} <span>{n}</span>
                </button>
              ))}
            </div>
          )}
          <div className="cx-mpick-list" ref={list} style={pos ? { maxHeight: pos.list } : undefined}>
            <table className="cx-table cx-mpick-table">
              <thead>
                <tr>
                  {th('name', 'Model')}
                  {th('server', 'Server')}
                  <th>Type</th>
                  {th('ctx', 'Context', 'num')}
                  {th('pin', 'In $/1M', 'num')}
                  {th('pout', 'Out $/1M', 'num')}
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 600).map((r, i) => {
                  const sel = r.name === value.model && r.serverId === value.serverId;
                  return (
                    <tr key={`${r.serverId}::${r.name}`} data-i={i} className={`click ${i === active ? 'active' : ''} ${sel ? 'sel' : ''}`} aria-selected={sel} onMouseEnter={() => setActive(i)} onClick={() => pick(r)}>
                      <td className="mono">{r.name}</td>
                      <td className="cx-muted">{r.server}</td>
                      <td className="cx-muted">{KIND_LABEL[r.kind]}</td>
                      <td className="num tnum">{r.ctx ? fmtTokens(r.ctx) : '–'}</td>
                      <td className="num tnum">{money(r.pin)}</td>
                      <td className="num tnum">{money(r.pout)}</td>
                      <td className={r.enabled ? '' : 'cx-muted'}>{r.enabled ? 'on' : 'hidden'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 && <p className="cx-details-empty">No model matches.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
