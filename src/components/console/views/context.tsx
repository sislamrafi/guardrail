'use client';

import { useEffect, useRef, useState } from 'react';
import { useActions } from '../actions';
import { Ico } from '../icons';
import { Empty, Field, IconBtn, Loading, Note, Page, Pill, Section, Seg, Stat, ago, fmtTokens } from '../kit';
import { renderMarkdown } from '../markdown';
import { pathFor, useNav } from '../nav';
import { api, useStore, useUi } from '../store';
import type { Data, FileC } from '../types';
import { ScopeItems, scopeItems } from '../scope-items';
import { readPref, usePref, writePref } from '../prefs';
import { SaveState, useAutoSave } from '../autosave';
import { copyCode } from '../md-text';

// ---------------------------------------------------------------- /context

export function ContextHome() {
  const { data, error } = useStore();
  const nav = useNav();
  const ui = useUi();
  const [policy, setPolicy] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const pol = policy ?? data.settings.policyPrompt;
  const total = data.files.reduce((a, f) => a + f.tokens, 0);
  return (
    <Page icon="context" title="Context files" sub="Markdown about your project, added to every request. Attach a file to a group and every key in it gets the file; sub-groups inherit it.">
      <div className="cx-stats wide">
        <Stat label="Files" value={data.files.length} />
        <Stat label="Tokens in all files" value={fmtTokens(total)} />
        <Stat label="Not in any group" value={data.files.filter((f) => !data.groups.some((g) => g.own.includes(f.id))).length} />
        <Stat label="Prefix cache hit" value={data.cache.length ? `${Math.round((data.cache.reduce((a, c) => a + c.rate, 0) / data.cache.length) * 100)}%` : '–'} hint="vLLM prefix cache hit rate across inference servers" />
      </div>
      <Section title="What the model receives" hint="In this order, so the shared part stays byte-identical and vLLM's prefix cache can reuse it.">
        <ol className="cx-steps">
          <li>
            <b>Gateway policy prompt</b> <span className="cx-muted">{data.settings.policyPrompt ? `${data.settings.policyPrompt.length} characters` : 'empty'}</span> <Pill tone="ok">Cached</Pill>
          </li>
          <li>
            <b>The group&apos;s context files</b> <span className="cx-muted">inherited first, then the group&apos;s own</span> <Pill tone="ok">Cached per group</Pill>
          </li>
          <li>
            <b>The agent&apos;s own prompt and messages</b> <span className="cx-muted">from the client, unchanged</span>
          </li>
        </ol>
        <Field label="Where GuardRail puts it">
          <Seg
            value={data.settings.contextPlacement}
            label="Placement"
            onChange={(p) => void ui.run(() => api('settings', { method: 'PATCH', body: { contextPlacement: p } }), 'Placement saved')}
            options={[
              ['top', 'Top of the system prompt (cacheable)'],
              ['end', 'Before the last user message'],
            ]}
          />
        </Field>
        <Field label="Gateway policy prompt (sent first with every request)">
          <textarea className="cx-input mono" rows={5} value={pol} onChange={(e) => setPolicy(e.target.value)} placeholder="Rules every agent behind this gateway must follow." />
        </Field>
        <div className="cx-form-row end">
          {policy !== null && policy !== data.settings.policyPrompt && (
            <button type="button" className="cx-btn" onClick={() => setPolicy(null)}>
              Discard
            </button>
          )}
          <button type="button" className="cx-btn pri" disabled={policy === null || policy === data.settings.policyPrompt} onClick={async () => (await ui.run(() => api('settings', { method: 'PATCH', body: { policyPrompt: pol } }), 'Policy prompt saved')) && setPolicy(null)}>
            Save policy prompt
          </button>
        </div>
      </Section>
      <Section title={`All files · ${data.files.length}`} hint="The library. Pick a group or key on the left: the right panel shows the files it sends, in order (own or inherited), and adds or removes them. New files and uploads go to the picked group or key.">
        {data.files.length === 0 ? (
          <Empty icon="context" title="No context files yet">
            Use the new-file button in the sidebar, or upload .md files.
          </Empty>
        ) : (
          <div className="cx-table-wrap">
            <table className="cx-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Tokens</th>
                  <th>Attached to</th>
                  <th>Groups reached</th>
                  <th>Version</th>
                  <th>Edited</th>
                </tr>
              </thead>
              <tbody>
                {data.files.map((f) => (
                  <tr key={f.id} className="click" onClick={() => nav.go(pathFor('context', f.id))}>
                    <td className="mono">
                      <span className="cx-inline-ico md">
                        <Ico n="file" size={14} />
                      </span>
                      {f.name}
                    </td>
                    <td className="tnum">{fmtTokens(f.tokens)}</td>
                    <td>{f.usedBy.join(', ') || <span className="cx-muted">Not in any group</span>}</td>
                    <td className="tnum">{f.reach}</td>
                    <td className="tnum">v{f.version}</td>
                    <td className="cx-muted">{ago(f.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </Page>
  );
}

// ---------------------------------------------------------------- /context/:id

export function ContextFileEditor({ id }: { id: number }) {
  const { data, error } = useStore();
  const f = data?.files.find((x) => x.id === id);
  if (!data) return <Loading error={error} />;
  if (!f) return <Empty icon="context" title="This file was deleted" />;
  return <FileEditor f={f} />;
}

/** Remembers the text/preview toggle per file in this browser (new files start with the last choice). */
function usePreview(id: number): [boolean, (v: boolean) => void] {
  const [v, setV] = usePref(`context.preview.${id}`, readPref('context.preview', false));
  return [
    v,
    (x: boolean) => {
      setV(x);
      writePref('context.preview', x);
    },
  ];
}

function FileEditor({ f }: { f: FileC }) {
  const nav = useNav();
  const act = useActions();
  const path = pathFor('context', f.id);
  const text = nav.drafts[path] ?? f.body;
  const dirty = nav.drafts[path] !== undefined && nav.drafts[path] !== f.body;
  // Someone else (another tab, the agent) saved a new version while this one has unsaved text.
  const draftBase = useRef<number | null>(null);
  if (!dirty) draftBase.current = null;
  else draftBase.current ??= f.version;
  const changedElsewhere = dirty && draftBase.current !== null && draftBase.current !== f.version;
  const [preview, setPreview] = usePreview(f.id);
  const [history, setHistory] = useState(false);
  const [cur, setCur] = useState({ ln: 1, col: 1 });
  const ta = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = text.split('\n').length;

  const { reload } = useStore();
  // ⌘S and the Save button make a new version; autosaves update the version being typed.
  const save = async () => {
    if (!dirty) return;
    if (await act.saveFile(f, text)) nav.setDraft(path, null);
  };
  const auto = useAutoSave({
    value: text,
    dirty,
    save: async () => {
      const body = text;
      await api(`context/${f.id}`, { method: 'PATCH', body: { body, autosave: true } });
      await reload();
      // Keep anything typed while it was saving.
      nav.setDraft(path, null, body);
    },
  });
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });
  // Tell the status bar where the cursor is.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('cx-cursor', { detail: preview ? null : cur }));
  }, [cur, preview]);
  useEffect(() => () => void window.dispatchEvent(new CustomEvent('cx-cursor', { detail: null })), []);

  const track = () => {
    const el = ta.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    setCur({ ln: before.split('\n').length, col: before.length - before.lastIndexOf('\n') });
  };

  return (
    <div className="cx-file">
      <div className="cx-file-bar">
        <span className="cx-muted small">
          {fmtTokens(f.tokens)} tokens · v{f.version} · edited {ago(f.updated_at)} <SaveState s={auto} />
        </span>
        <span className="grow" />
        {dirty && (
          <button type="button" className="cx-btn sm" onClick={() => nav.setDraft(path, null)}>
            Discard changes
          </button>
        )}
        <IconBtn icon="save" label={dirty ? 'Save (⌘S)' : 'Saved'} disabled={!dirty} onClick={() => void save()} />
        <IconBtn icon={preview ? 'code' : 'preview'} label={preview ? 'Edit as text' : 'Show rendered Markdown'} active={preview} onClick={() => setPreview(!preview)} />
        <IconBtn icon="history" label="Version history" active={history} onClick={() => setHistory(!history)} />
        <IconBtn icon="trash" label="Delete file" onClick={() => void act.deleteFile(f)} />
      </div>
      {changedElsewhere && (
        <Note tone="warn">
          {f.name} was changed elsewhere (now v{f.version}) while you were editing. Your text is kept; <b>Discard changes</b> to load the new version, or save to replace it.
        </Note>
      )}
      <div className="cx-file-body">
        {preview ? (
          <article className="cx-md" onClick={copyCode} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
        ) : (
          <div className="cx-code">
            <div className="cx-gutter" ref={gutter} aria-hidden="true">
              {Array.from({ length: lines }, (_, i) => (
                <div key={i} className={i + 1 === cur.ln ? 'cur' : ''}>
                  {i + 1}
                </div>
              ))}
            </div>
            <textarea
              ref={ta}
              className="cx-textarea"
              value={text}
              spellCheck={false}
              wrap="off"
              aria-label={`Edit ${f.name}`}
              onChange={(e) => {
                nav.setDraft(path, e.target.value === f.body ? null : e.target.value);
                track();
              }}
              onKeyUp={track}
              onClick={track}
              onScroll={(e) => gutter.current && (gutter.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop)}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && !e.shiftKey) {
                  e.preventDefault();
                  const el = e.currentTarget;
                  const s = el.selectionStart;
                  const v = el.value.slice(0, s) + '  ' + el.value.slice(el.selectionEnd);
                  nav.setDraft(path, v);
                  requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
                }
              }}
            />
          </div>
        )}
        {history && <History f={f} onRestore={(body) => nav.setDraft(path, body === f.body ? null : body)} onClose={() => setHistory(false)} />}
      </div>
    </div>
  );
}

function History({ f, onRestore, onClose }: { f: FileC; onRestore: (body: string) => void; onClose: () => void }) {
  const [h, setH] = useState<{ version: number; body: string; created_at: number }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    api<{ history: { version: number; body: string; created_at: number }[] }>(`context/${f.id}`).then(
      (r) => setH(r.history),
      (e) => setErr((e as Error).message),
    );
  }, [f.id, f.version]);
  return (
    <aside className="cx-history" aria-label="Version history">
      <div className="cx-side-head">
        <span>HISTORY</span>
        <div className="cx-side-acts">
          <button type="button" aria-label="Close history" onClick={onClose}>
            <Ico n="close" />
          </button>
        </div>
      </div>
      {!h ? (
        <Loading error={err} />
      ) : h.length === 0 ? (
        <Note>No earlier versions.</Note>
      ) : (
        <div className="cx-history-list">
          {h.map((v) => (
            <div key={v.version} className={`cx-history-item ${open === v.version ? 'open' : ''}`}>
              <button type="button" className="cx-history-head" onClick={() => setOpen(open === v.version ? null : v.version)} aria-expanded={open === v.version}>
                <b>v{v.version}</b>
                {v.version === f.version && <Pill tone="info">Current</Pill>}
                <span className="cx-muted">{ago(v.created_at)}</span>
              </button>
              {open === v.version && (
                <>
                  <pre className="cx-pre small">{v.body.length > 1500 ? v.body.slice(0, 1500) + '\n…' : v.body}</pre>
                  {v.version !== f.version && (
                    <button type="button" className="cx-btn sm" onClick={() => onRestore(v.body)}>
                      Restore into the editor
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------- right sidebar: what the picked group or key sends

export function ContextPanel({ data }: { data: Data }) {
  const nav = useNav();
  const key = data.keys.find((k) => k.id === nav.key) ?? null;
  const g = data.groups.find((x) => x.id === (key?.groupId ?? nav.group)) ?? data.groups.find((x) => x.parentId === null);
  if (!g) return null;
  const { list, off } = scopeItems(data, 'context', g, key);
  const files = list.map((x) => data.files.find((f) => f.id === x.id)).filter((f): f is FileC => !!f);
  const own = list.filter((x) => x.st.kind !== 'inherited').length;
  const q = key ? `?group=${g.id}&key=${key.id}` : `?group=${g.id}`;
  const footer = `${files.length} file${files.length === 1 ? '' : 's'} · ${fmtTokens(files.reduce((a, f) => a + f.tokens, 0))} tokens · ${own} own · ${list.length - own} inherited${off.length ? ` · ${off.length} off` : ''}${key ? ` · caller line ${key.identity.key || key.identity.owner ? 'on' : 'off'}` : ''}`;
  return (
    <ScopeItems
      data={data}
      kind="context"
      g={g}
      keyRow={key}
      noun={{ one: 'file', many: 'files' }}
      footer={footer}
      items={data.files.map((f) => ({ id: f.id, name: f.name, meta: fmtTokens(f.tokens), title: `${f.name} · ${f.tokens} tokens` }))}
      open={(id) => nav.go(`${pathFor('context', id)}${q}`)}
    />
  );
}
