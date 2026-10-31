'use client';

import { useState } from 'react';
import { useActions } from './actions';
import { Ico } from './icons';
import { Stat, ago, fmtTokens } from './kit';
import { pathFor, subtree, useNav } from './nav';
import { useStore } from './store';
import { StudioDebug } from './studio-debug';
import type { Data, FileC, GroupC } from './types';
import { ActivityList } from './views/activity';
import { LayersPanel } from './views/guard';

/** The secondary sidebar: stats for the open file, or for the selected group. */
export function Details({ width }: { width: number }) {
  const { data } = useStore();
  const nav = useNav();
  if (!data) return <aside className="cx-side cx-right" style={{ width }} />;
  const root = data.groups.find((g) => g.parentId === null);
  const file = nav.view === 'context' && nav.id ? data.files.find((f) => f.id === Number(nav.id)) : null;
  const key = nav.view === 'keys' && nav.id && nav.id !== 'new' ? data.keys.find((k) => k.id === Number(nav.id)) : null;
  const gid = nav.view === 'groups' && nav.id ? Number(nav.id) : (key?.groupId ?? nav.group);
  const group = data.groups.find((g) => g.id === gid) ?? root;
  const scenario = nav.view === 'studio' && nav.id ? Number(nav.id) : null;
  return (
    <aside className="cx-side cx-right" style={{ width }} aria-label="Details">
      <div className="cx-side-head">
        <span>{nav.view === 'guard' ? 'GUARD LAYERS' : nav.view === 'activity' ? 'REQUESTS' : scenario ? 'REQUEST DEBUG' : file ? 'FILE DETAILS' : 'GROUP DETAILS'}</span>
      </div>
      <div className={`cx-side-body ${nav.view === 'activity' ? 'flush' : ''}`}>{nav.view === 'activity' ? <ActivityList /> : nav.view === 'guard' ? <LayersPanel data={data} /> : scenario ? <StudioDebug key={scenario} id={scenario} /> : file ? <FileStats f={file} data={data} /> : group ? <GroupStats g={group} data={data} /> : null}</div>
    </aside>
  );
}

function GroupStats({ g, data }: { g: GroupC; data: Data }) {
  const nav = useNav();
  const eff = g.context.map((id) => data.files.find((f) => f.id === id)).filter((f): f is FileC => !!f);
  const tokens = eff.reduce((a, f) => a + f.tokens, 0);
  const reach = subtree(g.id, data.groups);
  const keys = data.keys.filter((k) => reach.has(k.groupId) && !k.revoked);
  const rate = data.cache.length ? data.cache.reduce((a, c) => a + c.rate, 0) / data.cache.length : null;
  const today = keys.reduce((a, k) => a + k.requestsToday, 0);
  const overrides = Object.keys(g.settings).length;
  return (
    <div className="cx-details">
      <button type="button" className="cx-details-title" onClick={() => nav.go(pathFor('groups', g.id))} title="Open group settings">
        <Ico n="folder" /> {g.name}
      </button>
      <p className="cx-details-sub">{g.description || g.path}</p>
      <div className="cx-stats">
        <Stat label="Context files" value={eff.length} hint="Files every request from this group carries, inherited ones included" />
        <Stat label="Context tokens" value={fmtTokens(tokens)} hint="Approximate tokens added to each request" />
        <Stat label="Own / inherited" value={`${g.own.length} / ${eff.length - eff.filter((f) => g.own.includes(f.id)).length}`} />
        <Stat label="Prefix cache hit" value={rate === null ? '–' : `${Math.round(rate * 100)}%`} hint="vLLM prefix cache hit rate across inference servers" />
        <Stat label="Keys that get it" value={keys.length} hint="Active keys in this group and its sub-groups" />
        <Stat label="Requests today" value={today} />
        <Stat label="Sub-groups" value={reach.size - 1} />
        <Stat label="Own overrides" value={overrides} />
      </div>
      <div className="cx-details-sec">FILES SENT, IN ORDER</div>
      {eff.length === 0 && <p className="cx-details-empty">No context files. Drag a file onto this group in Context files.</p>}
      {eff.map((f) => (
        <button key={f.id} type="button" className="cx-li" onClick={() => nav.go(pathFor('context', f.id))}>
          <span className="cx-ico md">
            <Ico n="file" size={14} />
          </span>
          <span className="cx-label">{f.name}</span>
          <span className="cx-meta">{g.own.includes(f.id) ? fmtTokens(f.tokens) : 'inherited'}</span>
        </button>
      ))}
      <div className="cx-details-sec">KEYS THAT GET IT · {keys.length}</div>
      {keys.length === 0 && <p className="cx-details-empty">No active keys here yet.</p>}
      {keys.slice(0, 40).map((k) => (
        <button key={k.id} type="button" className="cx-li" onClick={() => nav.go(pathFor('keys', k.id))}>
          <span className="cx-ico key">
            <Ico n="key" size={14} />
          </span>
          <span className="cx-label">{k.name}</span>
          <span className="cx-meta">{k.requestsToday ? `${k.requestsToday} today` : k.owner}</span>
        </button>
      ))}
      {data.cache.length > 0 && (
        <>
          <div className="cx-details-sec">CACHE BY SERVER</div>
          {data.cache.map((c) => (
            <div key={c.name} className="cx-bar-row compact">
              <span>{c.name}</span>
              <span className="cx-bar">
                <i style={{ width: `${Math.round(c.rate * 100)}%` }} />
              </span>
              <span className="cx-meta">{Math.round(c.rate * 100)}%</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function FileStats({ f, data }: { f: FileC; data: Data }) {
  const act = useActions();
  const nav = useNav();
  const [pick, setPick] = useState('');
  const attached = data.groups.filter((g) => g.own.includes(f.id));
  const reached = data.groups.filter((g) => g.context.includes(f.id));
  const keys = data.keys.filter((k) => reached.some((g) => g.id === k.groupId) && !k.revoked);
  return (
    <div className="cx-details">
      <div className="cx-details-title static">
        <Ico n="file" /> {f.name}
      </div>
      <div className="cx-stats">
        <Stat label="Tokens" value={fmtTokens(f.tokens)} />
        <Stat label="Version" value={`v${f.version}`} />
        <Stat label="Groups reached" value={reached.length} hint="Groups that send this file, directly or by inheritance" />
        <Stat label="Keys reached" value={keys.length} />
        <Stat label="Lines" value={f.body.split('\n').length} />
        <Stat label="Edited" value={ago(f.updated_at)} />
      </div>
      <div className="cx-details-sec">ATTACHED TO</div>
      {attached.length === 0 && <p className="cx-details-empty">Not attached to any group, so no request carries it.</p>}
      {attached.map((g) => (
        <div key={g.id} className="cx-li">
          <span className="cx-ico folder">
            <Ico n="folder" size={14} />
          </span>
          <button type="button" className="cx-label cx-link-plain" onClick={() => nav.go(pathFor('groups', g.id))}>
            {g.path}
          </button>
          <button type="button" className="cx-row-act show" title={`Remove from ${g.name}`} aria-label={`Remove from ${g.name}`} onClick={() => void act.detach(f.id, g.id)}>
            <Ico n="unlink" size={14} />
          </button>
        </div>
      ))}
      <form
        className="cx-attach"
        onSubmit={(e) => {
          e.preventDefault();
          if (pick) void act.attach(f.id, Number(pick));
          setPick('');
        }}
      >
        <select className="cx-input sm" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Attach to group">
          <option value="">Attach to a group…</option>
          {data.groups
            .filter((g) => !g.own.includes(f.id))
            .map((g) => (
              <option key={g.id} value={g.id}>
                {'  '.repeat(g.depth)}
                {g.name}
              </option>
            ))}
        </select>
        <button type="submit" className="cx-btn sm pri" disabled={!pick}>
          Attach
        </button>
      </form>
      {reached.length > attached.length && (
        <>
          <div className="cx-details-sec">INHERITED BY</div>
          {reached
            .filter((g) => !g.own.includes(f.id))
            .map((g) => (
              <div key={g.id} className="cx-li">
                <span className="cx-ico folder">
                  <Ico n="folder" size={14} />
                </span>
                <span className="cx-label">{g.path}</span>
              </div>
            ))}
        </>
      )}
    </div>
  );
}
