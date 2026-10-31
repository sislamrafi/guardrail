'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Mark, diffMarks, messageText } from '@/components/prompt-view';
import type { PromptMessage, Step } from '@/lib/logs';
import { Ico } from '../icons';
import { Empty, Loading, Note, Page, Pill, clock, fmt, ms } from '../kit';
import { pathFor, subtree, useNav } from '../nav';
import { api, useStore, useUi } from '../store';
import type { LogEntry } from '../types';

type Counts = { all: number; blocked: number; false_alarm: number; clean: number; error: number };

const FILTERS: [string, string, keyof Counts][] = [
  ['', 'All', 'all'],
  ['blocked', 'Blocked', 'blocked'],
  ['false_alarm', 'False alarms', 'false_alarm'],
  ['clean', 'Clean', 'clean'],
  ['error', 'Errors', 'error'],
];

export const OUTCOME: Record<string, [string, 'ok' | 'warn' | 'bad']> = {
  answered: ['Answered', 'ok'],
  redacted: ['Redacted, answered', 'warn'],
  false_alarm: ['False alarm, answered', 'warn'],
  blocked: ['Blocked', 'bad'],
  rejected: ['Rejected', 'bad'],
  error: ['Error', 'bad'],
};

export function Outcome({ r }: { r: Pick<LogEntry, 'outcome' | 'status_code'> }) {
  const [label, tone] = OUTCOME[r.outcome] ?? [r.outcome, 'warn'];
  return <Pill tone={tone}>{r.outcome === 'rejected' || r.outcome === 'error' ? `${label} ${r.status_code ?? ''}` : label}</Pill>;
}

function C1({ r }: { r: LogEntry }) {
  if (r.c1_status === 'flagged') return <Pill tone="warn">{r.c1_score?.toFixed(2)} flagged</Pill>;
  if (r.c1_status === 'clean') return <Pill tone="ok">{r.c1_score?.toFixed(2)} clean</Pill>;
  return <Pill>{r.c1_status === 'skipped' ? 'Nothing new' : r.c1_status === 'off' ? 'Off' : 'Not run'}</Pill>;
}

function C2({ r }: { r: LogEntry }) {
  if (r.c2_status === 'block') return <Pill tone="bad">Block</Pill>;
  if (r.c2_status === 'error') return <Pill tone="bad">Failed, blocked</Pill>;
  if (r.c2_status === 'allow') return <Pill tone="ok">Allow</Pill>;
  return <Pill>{r.c2_status === 'skipped' ? 'Skipped' : r.c2_status === 'off' ? 'Off' : 'Not run'}</Pill>;
}

// ---------------------------------------------------------------- /activity

export function ActivityHome() {
  const { data } = useStore();
  const nav = useNav();
  const params = useSearchParams();
  const [filter, setFilter] = useState(params.get('filter') ?? '');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<LogEntry[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const load = useCallback(async () => {
    try {
      const r = await api<{ rows: LogEntry[]; counts: Counts }>(`logs?filter=${filter}&q=${encodeURIComponent(query)}&limit=300`);
      setRows(r.rows);
      setCounts(r.counts);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [filter, query]);
  useEffect(() => {
    void load();
    if (!live) return;
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), 10000);
    return () => clearInterval(t);
  }, [load, live]);

  const groups = data?.groups ?? [];
  const g = groups.find((x) => x.id === nav.group);
  const scope = g && g.parentId !== null ? subtree(g.id, groups) : null;
  const shown = useMemo(() => (rows ?? []).filter((r) => !scope || (r.group_id !== null && scope.has(r.group_id))), [rows, scope]);

  const exportCsv = () => {
    const cols: (keyof LogEntry)[] = ['id', 'ts', 'owner', 'key_name', 'group_name', 'ip', 'model', 'server', 'schema', 'c1_score', 'c1_status', 'c2_status', 'c2_reason', 'outcome', 'status_code', 'reason', 'latency_ms', 'tokens_out', 'feedback'];
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? '' : typeof v === 'number' && v > 1e12 ? new Date(v).toISOString() : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...shown.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'guardrail-activity.csv';
    a.click();
  };

  return (
    <Page
      icon="activity"
      title={scope ? `Activity · ${g!.name}` : 'Activity'}
      sub={scope ? 'Requests from keys in this group and its sub-groups. Pick the root group in the sidebar to see all.' : 'Every request, who sent it, and what each check decided.'}
      wide
      actions={
        <>
          <input className="cx-input sm" type="search" placeholder="Search person, key, group or ID" aria-label="Search activity" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="button" className={`cx-btn ${live ? 'on' : ''}`} aria-pressed={live} onClick={() => setLive(!live)} title="Refresh every 10 seconds">
            <span className={`cx-live ${live ? 'on' : ''}`} /> Live
          </button>
          <button type="button" className="cx-btn" onClick={exportCsv} disabled={!shown.length}>
            <Ico n="download" size={14} /> Export CSV
          </button>
        </>
      }
    >
      <div className="cx-filters" role="tablist" aria-label="Outcome">
        {FILTERS.map(([v, l, c]) => (
          <button key={v} type="button" role="tab" aria-selected={filter === v} className={`cx-chip ${filter === v ? 'on' : ''}`} onClick={() => setFilter(v)}>
            {l} <span>{fmt(counts?.[c] ?? 0)}</span>
          </button>
        ))}
      </div>
      {!rows ? (
        <Loading error={err} />
      ) : shown.length === 0 ? (
        <Empty icon="activity" title="No requests yet">
          Point a client at <span className="mono">/v1</span> with a key, or send one from Studio.
        </Empty>
      ) : (
        <div className="cx-table-wrap">
          <table className="cx-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Person · key</th>
                <th>Group</th>
                <th>Model</th>
                <th>Check 1 · PIGuard</th>
                <th>Check 2 · OSS</th>
                <th>Outcome</th>
                <th>Latency</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="click" tabIndex={0} onClick={() => nav.go(pathFor('activity', r.id))} onKeyDown={(e) => e.key === 'Enter' && nav.go(pathFor('activity', r.id))}>
                  <td className="mono">{clock(r.ts)}</td>
                  <td>
                    <b>{r.owner ?? 'unknown'}</b>
                    <div className="mono cx-muted">{r.key_name ?? 'no key'}</div>
                  </td>
                  <td>{r.group_name ? <Pill tone="info">{r.group_name}</Pill> : <span className="cx-muted">–</span>}</td>
                  <td className="mono">{r.model ?? '–'}</td>
                  <td>
                    <C1 r={r} />
                  </td>
                  <td>
                    <C2 r={r} />
                  </td>
                  <td>
                    <Outcome r={r} />
                  </td>
                  <td className="tnum">{ms(r.latency_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------- /activity/:id

const TITLES: Record<string, string> = {
  answered: 'Clean request',
  redacted: 'Answered after redaction',
  false_alarm: 'False alarm, corrected by check 2',
  blocked: 'Blocked before the model',
  rejected: 'Rejected before the checks',
  error: 'Failed at the backend',
};
const FEEDBACK: Record<string, [string, string]> = {
  blocked: ['mistake', 'This was a mistake'],
  false_alarm: ['confirmed_safe', 'Confirm it was safe'],
  answered: ['missed_attack', 'Report a missed attack'],
  redacted: ['missed_attack', 'Report a missed attack'],
};
const EXPIRED = 'This prompt was deleted. Prompt files are kept for 20 days by default (GUARDRAIL_PROMPT_RETENTION_DAYS).';

export function LogDetail({ id }: { id: string }) {
  const ui = useUi();
  const nav = useNav();
  const [d, setD] = useState<LogEntry | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'steps' | 'prompt' | 'sent'>('steps');
  const load = useCallback(() => api<LogEntry>(`logs/${encodeURIComponent(id)}`).then(setD, (e) => setErr((e as Error).message)), [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const marks = useMemo(() => (d?.forwarded ? diffMarks(d.forwarded, d.prompt) : []), [d]);
  if (!d) return <Loading error={err} />;
  const fb = FEEDBACK[d.outcome];
  return (
    <Page
      icon="activity"
      title={TITLES[d.outcome] ?? 'Request'}
      sub={
        <>
          {new Date(d.ts).toLocaleString('en-GB')} · <span className="mono">{d.id}</span>
        </>
      }
      actions={
        <>
          <Outcome r={d} />
          {fb && (
            <button
              type="button"
              className={`cx-btn ${d.feedback === fb[0] ? 'on' : ''}`}
              onClick={async () => {
                await ui.run(() => api(`logs/${d.id}`, { method: 'PATCH', body: { feedback: d.feedback === fb[0] ? null : fb[0] } }), d.feedback === fb[0] ? 'Feedback removed' : 'Thanks, noted for tuning', { reload: false });
                void load();
              }}
            >
              {d.feedback === fb[0] ? `Marked: ${fb[1].toLowerCase()}` : fb[1]}
            </button>
          )}
          <button type="button" className="cx-btn" onClick={() => nav.go('/guard')}>
            Tune checks
          </button>
        </>
      }
    >
      <div className="cx-stats wide">
        <div className="cx-stat">
          <span>Person · key</span>
          <b className="small">{d.owner ?? 'unknown'} · {d.key_name ?? 'no key'}</b>
        </div>
        <div className="cx-stat">
          <span>Group</span>
          <b className="small">{d.group_name ?? '–'}</b>
        </div>
        <div className="cx-stat">
          <span>Model · server</span>
          <b className="small mono">{d.model ?? '–'}{d.server ? ` · ${d.server}` : ''}</b>
        </div>
        <div className="cx-stat">
          <span>Total time</span>
          <b className="small">{ms(d.latency_ms)}</b>
        </div>
        <div className="cx-stat">
          <span>Schema · tokens out</span>
          <b className="small">{d.schema ?? '–'} · {fmt(d.tokens_out)}</b>
        </div>
      </div>
      <div className="cx-subtabs" role="tablist" aria-label="Request view">
        {(
          [
            ['steps', 'What happened'],
            ['prompt', `Prompt${d.prompt ? ` (${d.prompt.length})` : ''}`],
            ['sent', 'Sent to the model'],
          ] as const
        ).map(([t, l]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'steps' && <Timeline steps={d.steps} />}
      {tab === 'prompt' && <Messages messages={d.prompt} empty={d.prompt_expired ? EXPIRED : 'No prompt was recorded. The request was rejected before its body was read.'} />}
      {tab === 'sent' && (
        <>
          {d.forwarded && marks.some(Boolean) && <Note>Highlighted messages were added or changed by GuardRail (context or redaction).</Note>}
          <Messages messages={d.forwarded} marks={marks} empty={d.prompt_expired ? EXPIRED : 'Nothing was sent to the model: the request was rejected or blocked first.'} />
        </>
      )}
      {d.prompt_file && !d.prompt_expired && (
        <p className="cx-hint">
          Prompt file <span className="mono">{d.prompt_file}</span> in the gateway&apos;s prompts folder.
        </p>
      )}
    </Page>
  );
}

export function Timeline({ steps }: { steps: Step[] }) {
  if (!steps.length) return <Note>No steps were recorded.</Note>;
  return (
    <ol className="cx-timeline">
      {steps.map((s, i) => (
        <li key={i} className={s.tone}>
          <span className="cx-tl-dot">{i + 1}</span>
          <div className="cx-tl-body">
            <div className="cx-tl-head">
              <b>{s.head}</b>
              <span className="mono cx-muted">{ms(s.ms)}</span>
            </div>
            <div className="cx-muted">{s.text}</div>
            {s.quote && <blockquote className="cx-quote">{s.quote}</blockquote>}
            {s.why && <pre className="cx-pre">{s.why}</pre>}
          </div>
        </li>
      ))}
    </ol>
  );
}

const ROLE_TONE: Record<string, 'info' | 'ok' | 'warn' | ''> = { system: 'info', developer: 'info', user: 'ok', assistant: '', tool: 'warn', function: 'warn' };

export function Messages({ messages, marks, empty }: { messages: PromptMessage[] | null | undefined; marks?: (Mark | null)[]; empty: string }) {
  const ui = useUi();
  if (!messages?.length) return <Note>{empty}</Note>;
  const chars = messages.reduce((a, m) => a + messageText(m).length, 0);
  return (
    <div className="cx-msgs">
      <div className="cx-form-row center">
        <span className="cx-muted small">
          {messages.length} {messages.length === 1 ? 'message' : 'messages'} · {fmt(chars)} characters
        </span>
        <span className="grow" />
        <button type="button" className="cx-btn sm" onClick={() => navigator.clipboard.writeText(JSON.stringify(messages, null, 2)).then(() => ui.toast('Copied as JSON'), () => ui.toast('Could not copy', true))}>
          <Ico n="copy" size={14} /> Copy JSON
        </button>
      </div>
      {messages.map((m, i) => (
        <Message key={i} m={m} n={i + 1} mark={marks?.[i] ?? null} />
      ))}
    </div>
  );
}

function Message({ m, n, mark }: { m: PromptMessage; n: number; mark: Mark | null }) {
  const text = messageText(m);
  const [open, setOpen] = useState(text.length <= 1200);
  const extra = Object.fromEntries(Object.entries(m).filter(([k, v]) => k !== 'role' && k !== 'content' && v != null));
  const role = m.role ?? 'unknown';
  return (
    <div className={`cx-msg ${mark ? 'mark' : ''}`}>
      <div className="cx-form-row center">
        <span className="mono cx-muted">{n}.</span>
        <Pill tone={ROLE_TONE[role] ?? ''}>{role}</Pill>
        {typeof m.name === 'string' && <span className="mono cx-muted">{m.name}</span>}
        {mark && <Pill tone="info">{mark === 'added' ? 'Added by GuardRail' : 'Changed by GuardRail'}</Pill>}
        <span className="grow" />
        <span className="mono cx-muted small">{fmt(text.length)} chars</span>
      </div>
      {text && <pre className={`cx-msg-text ${open ? '' : 'folded'}`}>{text}</pre>}
      {text.length > 1200 && (
        <button type="button" className="cx-link" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
      {Object.keys(extra).length > 0 && <pre className="cx-pre small">{JSON.stringify(extra, null, 2)}</pre>}
    </div>
  );
}
