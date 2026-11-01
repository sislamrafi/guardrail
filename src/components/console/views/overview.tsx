'use client';

import { useEffect, useState } from 'react';
import { Ico } from '../icons';
import { Empty, Loading, Page, Section, Seg, Stat, clock, fmt, ms } from '../kit';
import { pathFor, useNav } from '../nav';
import { api, useStore } from '../store';
import type { LogEntry } from '../types';
import { Outcome } from './activity';
import { usePref } from '../prefs';

interface Overview {
  counts: { all: number; blocked: number; rejected: number; false_alarm: number; clean: number; error: number };
  change: number | null;
  overheadP95: number | null;
  guardP50: number | null;
  buckets: { t: number; label: string; total: number; blocked: number }[];
  stages: { key: string; name: string; p50: number }[];
  recentBlocks: LogEntry[];
}

const RANGES: [string, string][] = [
  ['1h', '1 hour'],
  ['24h', '24 hours'],
  ['7d', '7 days'],
  ['30d', '30 days'],
];

export function OverviewPage() {
  const { data } = useStore();
  const nav = useNav();
  const [range, setRange] = usePref('overview.range', '24h');
  const group = data?.groups.find((g) => g.id === nav.group);
  const scoped = group && group.parentId !== null ? group : null;
  const scopedId = scoped?.id ?? null;
  const scopeKey = data?.keys.find((k) => k.id === nav.key) ?? null;
  const scopeKeyId = scopeKey?.id ?? null;
  const [d, setD] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      api<Overview>(`overview?range=${range}${scopedId ? `&group=${scopedId}` : ''}${scopeKeyId ? `&key=${scopeKeyId}` : ''}`).then(
        (r) => live && (setD(r), setErr(null)),
        (e) => live && setErr((e as Error).message),
      );
    void load();
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), 30000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [range, scopedId, scopeKeyId]);
  const max = Math.max(1, ...(d?.buckets.map((b) => b.total) ?? [1]));
  const maxStage = Math.max(1, ...(d?.stages.map((s) => s.p50) ?? [1]));
  const sum = data?.summary;
  return (
    <Page
      icon="overview"
      title={scopeKey ? `Overview · ${scopeKey.name}` : scoped ? `Overview · ${scoped.name}` : 'Overview'}
      sub={scoped ? `Traffic from keys in ${scoped.path} and its sub-groups. Pick the root group to see everything.` : 'How the gateway is doing: traffic, what the checks caught, and where the time goes.'}
      wide
      actions={<Seg value={range} onChange={setRange} label="Time range" options={RANGES} />}
    >
      {!d ? (
        <Loading error={err} />
      ) : (
        <>
          <div className="cx-stats wide">
            <Stat label="Requests" value={fmt(d.counts.all)} hint={d.change === null ? undefined : `${d.change >= 0 ? '+' : ''}${d.change}% vs the previous period`} />
            <Stat label="Blocked" value={fmt(d.counts.blocked)} tone={d.counts.blocked ? 'bad' : undefined} hint="Stopped by a guard layer or custom rule" />
            <Stat label="Rejected" value={fmt(d.counts.rejected)} hint="Refused before any check: no or invalid key, address not allowed, revoked or expired key, rate limit" />
            <Stat label="False alarms corrected" value={fmt(d.counts.false_alarm)} tone={d.counts.false_alarm ? 'warn' : undefined} />
            <Stat label="Errors" value={fmt(d.counts.error)} tone={d.counts.error ? 'bad' : undefined} />
            <Stat label="Guard overhead p95" value={ms(d.overheadP95)} hint="Time GuardRail adds before the model: checks, guard layers and context" />
            <Stat label="Guard layers p50" value={ms(d.guardP50)} hint="Time all guard layers take together on a typical request" />
          </div>
          <Section title="Requests" hint="Red is the share that was blocked.">
            {d.counts.all === 0 ? (
              <Empty icon="activity" title="No traffic in this period" />
            ) : (
              <div className="cx-chart" role="img" aria-label={`Requests per period, ${d.counts.all} in total`}>
                {d.buckets.map((b, i) => (
                  <div key={i} className="cx-chart-col" title={`${b.label}: ${b.total} requests, ${b.blocked} blocked`}>
                    <i style={{ height: `${(b.total / max) * 100}%` }}>
                      <em style={{ height: `${b.total ? (b.blocked / b.total) * 100 : 0}%` }} />
                    </i>
                    {(i % Math.ceil(d.buckets.length / 8) === 0 || i === d.buckets.length - 1) && <span>{b.label}</span>}
                  </div>
                ))}
              </div>
            )}
          </Section>
          <div className="cx-cols">
            <Section title="Recent blocks" actions={<button type="button" className="cx-btn sm" onClick={() => nav.go(`/activity?filter=blocked${scoped ? `&group=${scoped.id}` : ''}`)}>Open in Activity</button>}>
              {d.recentBlocks.length === 0 ? (
                <p className="cx-muted">Nothing blocked.</p>
              ) : (
                <div className="cx-list">
                  {d.recentBlocks.map((r) => (
                    <button key={r.id} type="button" className="cx-list-row click" onClick={() => nav.go(pathFor('activity', r.id))}>
                      <span className="mono cx-muted">{clock(r.ts)}</span>
                      <span className="grow">
                        <b>{r.owner ?? 'unknown'}</b> <span className="cx-muted">{r.reason ?? ''}</span>
                      </span>
                      <Outcome r={r} />
                    </button>
                  ))}
                </div>
              )}
            </Section>
            <Section title="Stage latency, p50">
              {d.stages.length === 0 ? (
                <p className="cx-muted">No timings yet.</p>
              ) : (
                d.stages.map((s) => (
                  <div key={s.key} className="cx-bar-row">
                    <span>{s.name}</span>
                    <span className="cx-bar">
                      <i style={{ width: `${(s.p50 / maxStage) * 100}%` }} />
                    </span>
                    <span className="mono cx-muted">{ms(s.p50)}</span>
                  </div>
                ))
              )}
            </Section>
          </div>
          <Section title="Servers" actions={<button type="button" className="cx-btn sm" onClick={() => nav.go('/servers')}>Manage</button>}>
            {!data?.servers.length ? (
              <Empty icon="servers" title="No servers yet">
                <button type="button" className="cx-link" onClick={() => nav.go('/servers/new')}>Add a vLLM server</button>
              </Empty>
            ) : (
              <div className="cx-list">
                {data.servers.map((s) => (
                  <button key={s.id} type="button" className="cx-list-row click" onClick={() => nav.go(pathFor('servers', s.id))}>
                    <span className={`cx-sdot ${s.status}`} />
                    <b>{s.name}</b>
                    <span className="mono cx-muted grow">{s.url}</span>
                    <span className="cx-muted">{s.status === 'online' ? ms(s.latency_ms) : s.status}</span>
                  </button>
                ))}
              </div>
            )}
          </Section>
          {sum && (
            <p className="cx-hint">
              <Ico n="guard" size={12} /> {sum.groups} groups · {sum.keys} active keys · guard checks {sum.guard ? 'on' : 'off'}
            </p>
          )}
        </>
      )}
    </Page>
  );
}
