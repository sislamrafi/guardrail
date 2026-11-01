'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useActions } from '../actions';
import { Ico } from '../icons';
import { Empty, Field, IconBtn, Loading, Note, Page, Pill, Section, Seg, Stat, Switch, ago, clock, ms } from '../kit';
import { renderMarkdown } from '../markdown';
import { pathFor, useNav } from '../nav';
import { api, useStore, useUi } from '../store';
import type { Data, DocC, GroupC, KeyC, LogEntry } from '../types';
import { readPref, usePref, writePref } from '../prefs';
import { SaveState, useAutoSave } from '../autosave';
import { copyCode } from '../md-text';
import { ScopeItems, scopeItems } from '../scope-items';

const size = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n} B`);
const bytes = (s: string) => new TextEncoder().encode(s).length;
const PLACEHOLDER = 'grk_live_YOUR_KEY_HERE';

/** Groups that give a doc to a group: itself or any group above it. */
function sharedVia(d: DocC, g: GroupC, groups: GroupC[]): GroupC | null {
  for (let x: GroupC | undefined = g; x; x = groups.find((y) => y.id === x!.parentId)) if (x.ownDocs.includes(d.id)) return x;
  return null;
}

// ---------------------------------------------------------------- /docs

type Client = 'claude' | 'cline' | 'cursor' | 'vscode';
function connectConfig(client: Client, url: string): { file: string; text: string } {
  const headers = { Authorization: `Bearer ${PLACEHOLDER}` };
  switch (client) {
    case 'claude':
      return { file: 'Terminal', text: `claude mcp add --transport http guardrail ${url} \\\n  --header "Authorization: Bearer ${PLACEHOLDER}"` };
    case 'cline':
      return { file: 'Cline › MCP Servers › Configure › cline_mcp_settings.json', text: JSON.stringify({ mcpServers: { guardrail: { type: 'streamableHttp', url, headers, disabled: false } } }, null, 2) };
    case 'cursor':
      return { file: '~/.cursor/mcp.json (or .cursor/mcp.json in the project)', text: JSON.stringify({ mcpServers: { guardrail: { url, headers } } }, null, 2) };
    case 'vscode':
      return { file: '.vscode/mcp.json', text: JSON.stringify({ servers: { guardrail: { type: 'http', url, headers } } }, null, 2) };
  }
}

export function DocsHome() {
  const { data, error } = useStore();
  const nav = useNav();
  const ui = useUi();
  const [client, setClient] = usePref<Client>('docs.client', 'claude');
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  if (!data) return <Loading error={error} />;
  const url = `${origin}${data.mcpPath}`;
  const cfg = connectConfig(client, url);
  const withAccess = data.docKeys.filter((k) => k.mcp && !k.revoked);
  return (
    <Page icon="mcp" title="MCP docs" sub="Markdown docs that agents read on demand through GuardRail's MCP server, with their own API key. Share a doc with a group (sub-groups inherit it) or with one key. Unlike context files, docs are never added to prompts.">
      <div className="cx-stats wide">
        <Stat label="Docs" value={data.docs.length} />
        <Stat label="Keys with MCP access" value={`${withAccess.length} / ${data.docKeys.length}`} />
        <Stat label="Keys that see a doc" value={withAccess.filter((k) => k.docs.length).length} />
        <Stat label="Not shared" value={data.docs.filter((d) => !d.reach).length} hint="Docs no key can read yet" />
      </div>

      <Section title="Connect an agent" hint="Streamable HTTP. Agents sign in with their GuardRail API key, the same one they use for /v1. Replace the placeholder with the key's secret (API keys › Reveal).">
        <Field label="Endpoint">
          <div className="cx-form-row center nowrap">
            <input className="cx-input mono grow" readOnly value={url} aria-label="MCP endpoint" />
            <button type="button" className="cx-btn" onClick={() => void navigator.clipboard?.writeText(url).then(() => ui.toast('Endpoint copied'))}>
              <Ico n="copy" size={14} /> Copy
            </button>
          </div>
        </Field>
        <Field label="Client">
          <Seg
            value={client}
            label="Client"
            onChange={setClient}
            options={[
              ['claude', 'Claude Code'],
              ['cline', 'Cline'],
              ['cursor', 'Cursor'],
              ['vscode', 'VS Code / mcp.json'],
            ]}
          />
        </Field>
        <div className="cx-codebox">
          <div className="cx-codebox-head">
            <span className="cx-muted small">{cfg.file}</span>
            <button type="button" className="cx-btn sm" onClick={() => void navigator.clipboard?.writeText(cfg.text).then(() => ui.toast('Copied'))}>
              <Ico n="copy" size={13} /> Copy
            </button>
          </div>
          <pre className="cx-pre">{cfg.text}</pre>
        </div>
      </Section>

      <Section title="Tools agents get" hint="Read-only. Docs are also exposed as MCP resources (guardrail://docs/<slug>) for clients that browse resources.">
        <div className="cx-table-wrap">
          <table className="cx-table">
            <tbody>
              {data.mcpTools.map((t) => (
                <tr key={t.name}>
                  <td className="mono nowrap">{t.name}</td>
                  <td>{t.description}</td>
                </tr>
              ))}
              <tr className="cx-dim">
                <td className="mono">custom tools</td>
                <td className="cx-muted">Coming later: your own tools served to agents next to the docs.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <TestAsKey data={data} />

      <Section title={`What each key sees · ${data.docKeys.length}`} hint="Exactly the docs a key can list and read: its group chain, plus docs shared with the key itself.">
        <div className="cx-table-wrap">
          <table className="cx-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Group</th>
                <th>MCP</th>
                <th className="num">Docs</th>
                <th>Sees</th>
              </tr>
            </thead>
            <tbody>
              {data.docKeys.map((k) => (
                <tr key={k.id} className={`click ${k.revoked ? 'cx-dim' : ''}`} onClick={() => nav.go(pathFor('keys', k.id))}>
                  <td>
                    {k.name} <span className="cx-muted small">{k.owner}</span>
                  </td>
                  <td className="cx-muted">{data.groups.find((g) => g.id === k.groupId)?.path}</td>
                  <td>{k.revoked ? <Pill tone="bad">Revoked</Pill> : k.mcp ? <Pill tone="ok">On</Pill> : <Pill>Off</Pill>}</td>
                  <td className="num tnum">{k.docs.length}</td>
                  <td className="cx-muted small">
                    {k.docs
                      .map((id) => data.docs.find((d) => d.id === id)?.slug)
                      .filter(Boolean)
                      .join(', ') || '–'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={`All docs · ${data.docs.length}`} hint="The library. Pick a group or key on the left: the right panel shows the docs it can read (own or inherited) and shares or removes them. New docs and uploads go to the picked group or key.">
        {data.docs.length === 0 ? (
          <Empty icon="mcp" title="No MCP docs yet">
            Use the new-doc button in the sidebar, or upload .md files.
          </Empty>
        ) : (
          <div className="cx-table-wrap">
            <table className="cx-table">
              <thead>
                <tr>
                  <th>Doc</th>
                  <th>Slug</th>
                  <th>Tags</th>
                  <th>Shared with</th>
                  <th className="num">Keys</th>
                  <th className="num">Size</th>
                  <th>Edited</th>
                </tr>
              </thead>
              <tbody>
                {data.docs.map((d) => (
                  <tr key={d.id} className="click" onClick={() => nav.go(pathFor('docs', d.id))}>
                    <td>
                      <span className="cx-inline-ico md">
                        <Ico n="file" size={14} />
                      </span>
                      {d.title}
                    </td>
                    <td className="mono small">{d.slug}</td>
                    <td>
                      {d.tags.map((t) => (
                        <Pill key={t}>{t}</Pill>
                      ))}
                    </td>
                    <td>{[...d.groups.map((id) => data.groups.find((g) => g.id === id)?.name), ...d.keys.map((id) => `key ${data.keys.find((k) => k.id === id)?.name}`)].filter(Boolean).join(', ') || <span className="cx-muted">Nobody</span>}</td>
                    <td className="num tnum">{d.reach}</td>
                    <td className="num tnum">{size(bytes(d.body))}</td>
                    <td className="cx-muted">{ago(d.updated_at)}</td>
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

type TestTool = 'list_docs' | 'search_docs' | 'read_doc' | 'resources/list';

/** Run a call as a key, the way an agent would see it (the key's IP list is skipped). */
function TestAsKey({ data, keyId }: { data: Data; keyId?: number }) {
  const [who, setWho] = useState<number | ''>(keyId ?? [...data.docKeys].filter((k) => k.mcp && !k.revoked).sort((a, b) => b.docs.length - a.docs.length)[0]?.id ?? '');
  const [tool, setTool] = useState<TestTool>('list_docs');
  const [arg, setArg] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ text: string; ms: number; error?: boolean } | null>(null);
  const k = data.docKeys.find((x) => x.id === who);
  const run = async () => {
    if (!who) return;
    setBusy(true);
    try {
      const body =
        tool === 'resources/list'
          ? { keyId: who, method: 'resources/list' }
          : { keyId: who, method: 'tools/call', params: { name: tool, arguments: tool === 'read_doc' ? { slug: arg } : tool === 'search_docs' ? { query: arg } : {} } };
      const r = await api<{ ok: boolean; result?: { content?: { text: string }[]; isError?: boolean; resources?: { uri: string; title: string }[] }; error?: { message: string }; ms: number }>('docs/test', { body });
      const text = !r.ok ? r.error!.message : r.result?.content ? r.result.content.map((c) => c.text).join('\n') : JSON.stringify(r.result, null, 2);
      setOut({ text, ms: r.ms, error: !r.ok || !!r.result?.isError });
    } catch (e) {
      setOut({ text: (e as Error).message, ms: 0, error: true });
    } finally {
      setBusy(false);
    }
  };
  const needsArg = tool === 'read_doc' || tool === 'search_docs';
  return (
    <Section title="Test as a key" hint="Runs the call exactly as that key's agent would, without logging it. The key's IP list is skipped here.">
      <div className="cx-form-row center">
        {keyId === undefined && (
          <Field label="Key">
            <select className="cx-input" value={who} onChange={(e) => setWho(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Pick a key</option>
              {data.docKeys.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} ({x.owner}) · {x.docs.length} docs{x.mcp ? '' : ' · MCP off'}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Call">
          <select className="cx-input" value={tool} onChange={(e) => setTool(e.target.value as TestTool)}>
            <option value="list_docs">list_docs</option>
            <option value="search_docs">search_docs</option>
            <option value="read_doc">read_doc</option>
            <option value="resources/list">resources/list</option>
          </select>
        </Field>
        {needsArg && (
          <Field label={tool === 'read_doc' ? 'Slug' : 'Query'} grow>
            {tool === 'read_doc' && k ? (
              <select className="cx-input" value={arg} onChange={(e) => setArg(e.target.value)}>
                <option value="">Pick a doc</option>
                {k.docs.map((id) => {
                  const d = data.docs.find((x) => x.id === id);
                  return d ? (
                    <option key={id} value={d.slug}>
                      {d.slug}
                    </option>
                  ) : null;
                })}
              </select>
            ) : (
              <input className="cx-input" value={arg} onChange={(e) => setArg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void run()} placeholder={tool === 'read_doc' ? 'deploy-runbook' : 'deploy canary'} />
            )}
          </Field>
        )}
        <button type="button" className="cx-btn pri" disabled={!who || busy || (needsArg && !arg.trim())} onClick={() => void run()}>
          {busy ? 'Running…' : 'Run'}
        </button>
      </div>
      {k && !k.mcp && <Note tone="warn">MCP access is off for {k.name}. A real agent would be refused; the test shows what it would see once it is on.</Note>}
      {out && (
        <div className="cx-codebox">
          <div className="cx-codebox-head">
            <span className={`small ${out.error ? 'cx-bad' : 'cx-muted'}`}>{out.error ? 'Error' : 'Result'} · {out.ms} ms</span>
          </div>
          <pre className="cx-pre">{out.text}</pre>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- /docs/:id

export function DocEditor({ id }: { id: number }) {
  const { data, error } = useStore();
  const d = data?.docs.find((x) => x.id === id);
  if (!data) return <Loading error={error} />;
  if (!d) return <Empty icon="mcp" title="This doc was deleted" />;
  return <DocFile d={d} data={data} />;
}

function usePreview(id: number): [boolean, (v: boolean) => void] {
  const [v, setV] = usePref(`docs.preview.${id}`, readPref('docs.preview', false));
  return [
    v,
    (x: boolean) => {
      setV(x);
      writePref('docs.preview', x);
    },
  ];
}

type Meta = { title: string; slug: string; description: string; tags: string };
const metaOf = (d: DocC): Meta => ({ title: d.title, slug: d.slug, description: d.description, tags: d.tags.join(', ') });

function DocFile({ d, data }: { d: DocC; data: Data }) {
  const nav = useNav();
  const act = useActions();
  const { reload } = useStore();
  const path = pathFor('docs', d.id);
  const text = nav.drafts[path] ?? d.body;
  const dirty = nav.drafts[path] !== undefined && nav.drafts[path] !== d.body;
  // Someone else (another tab, the agent) saved a new version while this one has unsaved text.
  const draftBase = useRef<number | null>(null);
  if (!dirty) draftBase.current = null;
  else draftBase.current ??= d.version;
  const changedElsewhere = dirty && draftBase.current !== null && draftBase.current !== d.version;
  const [preview, setPreview] = usePreview(d.id);
  const [panel, setPanel] = usePref<'share' | 'history' | null>('docs.panel', 'share');
  const [meta, setMeta] = useState<Meta>(() => metaOf(d));
  // Pick up saved values (and other tabs' edits) when the doc changes underneath.
  const base = useRef(metaOf(d));
  useEffect(() => {
    const next = metaOf(d);
    if (JSON.stringify(next) !== JSON.stringify(base.current)) {
      base.current = next;
      setMeta(next);
    }
  }, [d]);
  const metaDirty = JSON.stringify(meta) !== JSON.stringify(metaOf(d));

  const save = async () => {
    if (!dirty) return;
    await api(`docs/${d.id}`, { method: 'PATCH', body: { body: text } });
    await reload();
    nav.setDraft(path, null, text);
  };
  const auto = useAutoSave({
    value: text,
    dirty,
    save: async () => {
      const body = text;
      await api(`docs/${d.id}`, { method: 'PATCH', body: { body, autosave: true } });
      await reload();
      nav.setDraft(path, null, body);
    },
  });
  const metaAuto = useAutoSave({
    value: meta,
    dirty: metaDirty,
    invalid: !meta.title.trim() ? 'Give the doc a title.' : null,
    save: async () => {
      await api(`docs/${d.id}`, { method: 'PATCH', body: { title: meta.title, slug: meta.slug, description: meta.description, tags: meta.tags } });
      await reload();
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

  return (
    <div className="cx-file">
      <div className="cx-file-bar">
        <span className="cx-muted small">
          {size(bytes(text))} · v{d.version} · {d.reach} key{d.reach === 1 ? '' : 's'} can read it · edited {ago(d.updated_at)} <SaveState s={auto} /> <SaveState s={metaAuto} />
        </span>
        <span className="grow" />
        {dirty && (
          <button type="button" className="cx-btn sm" onClick={() => nav.setDraft(path, null)}>
            Discard changes
          </button>
        )}
        <IconBtn icon="save" label={dirty ? 'Save (⌘S)' : 'Saved'} disabled={!dirty} onClick={() => void save()} />
        <IconBtn icon={preview ? 'code' : 'preview'} label={preview ? 'Edit as text' : 'Show rendered Markdown'} active={preview} onClick={() => setPreview(!preview)} />
        <IconBtn icon="groups" label="Who can see this" active={panel === 'share'} onClick={() => setPanel(panel === 'share' ? null : 'share')} />
        <IconBtn icon="history" label="Version history" active={panel === 'history'} onClick={() => setPanel(panel === 'history' ? null : 'history')} />
        <IconBtn icon="trash" label="Delete doc" onClick={() => void act.deleteDoc(d)} />
      </div>
      <div className="cx-doc-meta">
        <Field label="Title">
          <input className="cx-input" value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} />
        </Field>
        <Field label="Slug" hint={`guardrail://docs/${meta.slug || '…'}`}>
          <input className="cx-input mono" value={meta.slug} onChange={(e) => setMeta({ ...meta, slug: e.target.value })} />
        </Field>
        <Field label="Tags" hint="Comma separated">
          <input className="cx-input" value={meta.tags} onChange={(e) => setMeta({ ...meta, tags: e.target.value })} placeholder="ops, deploy" />
        </Field>
        <Field label="Description (agents read this to decide whether to open the doc)" grow>
          <input className="cx-input" value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} placeholder="How we deploy to production, step by step" />
        </Field>
      </div>
      {changedElsewhere && (
        <Note tone="warn">
          {d.title} was changed elsewhere (now v{d.version}) while you were editing. Your text is kept; <b>Discard changes</b> to load the new version, or save to replace it.
        </Note>
      )}
      <div className="cx-file-body">
        {preview ? (
          <article className="cx-md" onClick={copyCode} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
        ) : (
          <div className="cx-code">
            <textarea
              className="cx-textarea plain"
              value={text}
              spellCheck={false}
              aria-label={`Edit ${d.title}`}
              onChange={(e) => nav.setDraft(path, e.target.value === d.body ? null : e.target.value)}
            />
          </div>
        )}
        {panel === 'share' && <WhoCanSee d={d} data={data} onClose={() => setPanel(null)} />}
        {panel === 'history' && <DocHistory d={d} onRestore={(body) => nav.setDraft(path, body === d.body ? null : body)} onClose={() => setPanel(null)} />}
      </div>
    </div>
  );
}

/** Share a doc with groups (inherited by sub-groups) and single keys. */
function WhoCanSee({ d, data, onClose }: { d: DocC; data: Data; onClose: () => void }) {
  const act = useActions();
  const seeing = useMemo(() => new Set(data.docKeys.filter((k) => k.docs.includes(d.id)).map((k) => k.id)), [data.docKeys, d.id]);
  // The group above the key that shares the doc (not just the key's own group).
  const viaName = (k: KeyC) => {
    const g = data.groups.find((x) => x.id === k.groupId);
    return (g && sharedVia(d, g, data.groups)?.name) ?? k.groupName;
  };
  return (
    <aside className="cx-history" aria-label="Who can see this">
      <div className="cx-side-head">
        <span>WHO CAN SEE THIS</span>
        <div className="cx-side-acts">
          <button type="button" aria-label="Close" onClick={onClose}>
            <Ico n="close" />
          </button>
        </div>
      </div>
      <div className="cx-history-list cx-share">
        <div className="cx-section">GROUPS</div>
        {data.groups.map((g) => {
          const own = g.ownDocs.includes(d.id);
          const via = own ? null : sharedVia(d, g, data.groups);
          return (
            <label key={g.id} className="cx-share-row" style={{ paddingLeft: 12 + g.depth * 14 }} title={via ? `Inherited from ${via.name}` : undefined}>
              <input type="checkbox" checked={own || !!via} disabled={!!via} onChange={(e) => void (e.target.checked ? act.shareDoc(d.id, g.id) : act.unshareDoc(d.id, g.id))} />
              <span className="grow">{g.name}</span>
              {via && <span className="cx-muted small">via {via.name}</span>}
            </label>
          );
        })}
        <div className="cx-section gap">KEYS · {seeing.size} CAN READ IT</div>
        {data.keys.map((k: KeyC) => {
          const own = Array.isArray(k.exceptions.mcp_docs?.value) && (k.exceptions.mcp_docs!.value as number[]).includes(d.id);
          const viaGroup = !own && seeing.has(k.id);
          return (
            <label key={k.id} className={`cx-share-row ${k.revoked ? 'cx-dim' : ''}`} title={!k.mcp ? 'MCP access is off for this key' : undefined}>
              <input type="checkbox" checked={own || viaGroup} disabled={viaGroup} onChange={(e) => void act.setKeyDoc(k, d.id, e.target.checked)} />
              <span className="grow">
                {k.name} <span className="cx-muted small">{k.owner}</span>
              </span>
              {!k.mcp ? <span className="cx-muted small">MCP off</span> : viaGroup ? <span className="cx-muted small">via {viaName(k)}</span> : own ? <span className="cx-muted small">this key</span> : null}
            </label>
          );
        })}
      </div>
    </aside>
  );
}

function DocHistory({ d, onRestore, onClose }: { d: DocC; onRestore: (body: string) => void; onClose: () => void }) {
  const [h, setH] = useState<{ version: number; title: string; body: string; created_at: number }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    api<{ history: { version: number; title: string; body: string; created_at: number }[] }>(`docs/${d.id}`).then(
      (r) => setH(r.history),
      (e) => setErr((e as Error).message),
    );
  }, [d.id, d.version]);
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
      ) : (
        <div className="cx-history-list">
          {h.map((v) => (
            <div key={v.version} className={`cx-history-item ${open === v.version ? 'open' : ''}`}>
              <button type="button" className="cx-history-head" onClick={() => setOpen(open === v.version ? null : v.version)} aria-expanded={open === v.version}>
                <b>v{v.version}</b>
                {v.version === d.version && <Pill tone="info">Current</Pill>}
                <span className="cx-muted">{ago(v.created_at)}</span>
              </button>
              {open === v.version && (
                <>
                  <pre className="cx-pre small">{v.body.length > 1500 ? v.body.slice(0, 1500) + '\n…' : v.body}</pre>
                  {v.version !== d.version && (
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

/** For the key page: MCP access switch, what the key sees, and a quick test. */
export function KeyMcpSection({ k }: { k: KeyC }) {
  const { data } = useStore();
  const act = useActions();
  const nav = useNav();
  if (!data) return null;
  const seen = data.docKeys.find((x) => x.id === k.id)?.docs ?? [];
  return (
    <Section title="MCP docs" hint="Docs this key's agent can list and read at /mcp, from its group chain plus docs shared with the key itself.">
      <div className="cx-form-row center">
        <Switch on={k.mcp} label="MCP access" onChange={(v) => void act.setKeyMcp(k, v)} />
        <span>{k.mcp ? `MCP access on · sees ${seen.length} doc${seen.length === 1 ? '' : 's'}` : 'MCP access off: /mcp refuses this key'}</span>
        <span className="grow" />
        <button type="button" className="cx-btn sm" onClick={() => nav.go(pathFor('docs'))}>
          Connection setup
        </button>
      </div>
      {k.mcp && seen.length > 0 && (
        <ul className="cx-plainlist">
          {seen.map((id) => {
            const d = data.docs.find((x) => x.id === id);
            return d ? (
              <li key={id}>
                <button type="button" className="cx-link" onClick={() => nav.go(pathFor('docs', id))}>
                  {d.title}
                </button>{' '}
                <span className="cx-muted small mono">{d.slug}</span>
              </li>
            ) : null;
          })}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- what one group or key can read

type Status = { kind: 'own' | 'inherited' | 'key'; from?: GroupC };
interface Target {
  key: KeyC | null;
  group: GroupC;
  /** Effective docs, each with why it is there. */
  docs: { d: DocC; st: Status }[];
}

/** The docs a group (or a key, on top of its group) can read, and where each comes from. */
function targetDocs(data: Data, group: GroupC, key: KeyC | null): Target {
  const out: { d: DocC; st: Status }[] = [];
  for (const id of group.docs) {
    const d = data.docs.find((x) => x.id === id);
    if (!d) continue;
    const from = sharedVia(d, group, data.groups);
    out.push({ d, st: from && from.id === group.id && !key ? { kind: 'own' } : { kind: 'inherited', from: from ?? undefined } });
  }
  if (key) {
    const own = Array.isArray(key.exceptions.mcp_docs?.value) ? (key.exceptions.mcp_docs!.value as number[]) : [];
    for (const id of own) {
      const d = data.docs.find((x) => x.id === id);
      if (d && !out.some((o) => o.d.id === id)) out.push({ d, st: { kind: 'key' } });
    }
  }
  return { key, group, docs: out.sort((a, b) => a.d.title.localeCompare(b.d.title)) };
}

/** The group or key picked in the MCP docs tree (?key= first, then ?group=, then the root). */
function useTarget(data: Data): Target | null {
  const nav = useNav();
  const fromPath = nav.id?.startsWith('k') ? Number(nav.id.slice(1)) : null;
  const key = data.keys.find((k) => k.id === (nav.key ?? fromPath)) ?? null;
  const group = data.groups.find((g) => g.id === (key?.groupId ?? nav.group)) ?? data.groups.find((g) => g.parentId === null);
  return group ? targetDocs(data, group, key) : null;
}

function StatusChip({ st, keyName }: { st: Status; keyName?: string }) {
  if (st.kind === 'own') return <Pill tone="ok">Own</Pill>;
  if (st.kind === 'key') return <Pill tone="info" title={`Shared with ${keyName ?? 'this key'} only`}>This key</Pill>;
  return <Pill title={st.from ? `Inherited from ${st.from.path}; change it there` : 'Inherited'}>{st.from ? `via ${st.from.name}` : 'Inherited'}</Pill>;
}

/** Right sidebar on MCP docs: what the picked group or key can read; MCP switch and test in the footer. */
export function McpPanel({ data }: { data: Data }) {
  const t = useTarget(data);
  const nav = useNav();
  const act = useActions();
  if (!t) return null;
  const { key, group } = t;
  const q = key ? `?group=${group.id}&key=${key.id}` : `?group=${group.id}`;
  const { list, off } = scopeItems(data, 'mcp_docs', group, key);
  const own = list.filter((x) => x.st.kind !== 'inherited').length;
  const inGroup = data.keys.filter((k) => k.groupId === group.id);
  const withMcp = data.docKeys.filter((k) => !k.revoked && k.mcp && data.groups.some((g) => g.id === k.groupId && (g.id === group.id || g.path.startsWith(`${group.path} `))));
  const readable = key && (!key.mcp || key.revoked) ? 0 : list.length;
  const footer = `${readable} doc${readable === 1 ? '' : 's'} readable · ${own} own · ${list.length - own} inherited${off.length ? ` · ${off.length} off` : ''}${key ? ` · MCP ${key.mcp ? 'on' : 'off'}` : ` · ${withMcp.length} key${withMcp.length === 1 ? '' : 's'} with MCP`}`;
  return (
    <ScopeItems
      data={data}
      kind="mcp_docs"
      g={group}
      keyRow={key}
      noun={{ one: 'doc', many: 'docs' }}
      footer={footer}
      items={data.docs.map((d) => ({ id: d.id, name: d.title, meta: d.slug, title: `${d.title} · ${d.slug}${d.description ? ` · ${d.description}` : ''}` }))}
      open={(id) => nav.go(`${pathFor('docs', id)}${q}`)}
      footerExtra={
        key ? (
          <div className="cx-pfoot-row">
            <Switch on={key.mcp} label="MCP access" onChange={(v) => void act.setKeyMcp(key, v)} />
            <span>MCP access</span>
            <span className="grow" />
            <button type="button" className="cx-btn sm" onClick={() => nav.go(`${pathFor('docs', `k${key.id}`)}?group=${key.groupId}&key=${key.id}`)}>
              Test as this key
            </button>
          </div>
        ) : inGroup.length ? (
          <div className="cx-pfoot-row small">
            Keys here:{' '}
            {inGroup.map((k, i) => (
              <span key={k.id}>
                {i ? ', ' : ''}
                <button type="button" className="cx-link" onClick={() => nav.setScope({ group: k.groupId, key: k.id })}>
                  {k.name}
                </button>
              </span>
            ))}
          </div>
        ) : null
      }
    />
  );
}

/** The middle view for a key picked in the MCP tree: its docs, a live test, and its recent MCP calls. */
export function KeyMcpView({ id }: { id: number }) {
  const { data, error } = useStore();
  const nav = useNav();
  const act = useActions();
  const [calls, setCalls] = useState<LogEntry[] | null>(null);
  const k = data?.keys.find((x) => x.id === id);
  useEffect(() => {
    if (!k) return;
    api<{ rows: LogEntry[] }>(`logs?filter=mcp&test=include&limit=200&q=${encodeURIComponent(k.name)}`).then(
      (r) => setCalls(r.rows.filter((x) => x.key_id === k.id).slice(0, 20)),
      () => setCalls([]),
    );
  }, [k?.id, k?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <Loading error={error} />;
  if (!k) return <Empty icon="key" title="This key was deleted" />;
  const group = data.groups.find((g) => g.id === k.groupId);
  // Exclusions count: what the key really gets.
  const t = group
    ? {
        docs: scopeItems(data, 'mcp_docs', group, k)
          .list.map((x) => ({ d: data.docs.find((d) => d.id === x.id)!, st: x.st as Status }))
          .filter((x) => !!x.d),
      }
    : null;
  return (
    <Page
      icon="mcp"
      title={`${k.name} · MCP`}
      sub={`${k.owner} · ${k.groupPath}. What this key's agent sees at /mcp.`}
      actions={
        <button type="button" className="cx-btn" onClick={() => nav.go(pathFor('keys', k.id))}>
          <Ico n="key" size={14} /> Open key page
        </button>
      }
    >
      <div className="cx-form-row center">
        <Switch on={k.mcp} label="MCP access" onChange={(v) => void act.setKeyMcp(k, v)} />
        <span>{k.revoked ? 'This key is revoked: /mcp refuses it.' : k.mcp ? 'MCP access on' : 'MCP access off: /mcp refuses this key'}</span>
      </div>
      <Section title={`Docs it can read · ${t?.docs.length ?? 0}`} hint="From its group chain, plus docs shared with this key only. Share or remove them in the right panel.">
        {!t?.docs.length ? (
          <Empty icon="mcp" title="No docs yet">
            Share a doc with this key or its group from the right panel.
          </Empty>
        ) : (
          <div className="cx-table-wrap">
            <table className="cx-table">
              <thead>
                <tr>
                  <th>Doc</th>
                  <th>Slug</th>
                  <th>Why</th>
                  <th className="num">Size</th>
                  <th>Edited</th>
                </tr>
              </thead>
              <tbody>
                {t.docs.map(({ d, st }) => (
                  <tr key={d.id} className="click" onClick={() => nav.go(`${pathFor('docs', d.id)}?group=${k.groupId}&key=${k.id}`)}>
                    <td>{d.title}</td>
                    <td className="mono small">{d.slug}</td>
                    <td>
                      <StatusChip st={st} keyName={k.name} />
                    </td>
                    <td className="num tnum">{size(bytes(d.body))}</td>
                    <td className="cx-muted">{ago(d.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <TestAsKey key={k.id} data={data} keyId={k.id} />
      <Section title="Recent MCP calls" hint="From Activity (MCP filter).">
        {!calls ? (
          <Loading />
        ) : calls.length === 0 ? (
          <p className="cx-muted">No MCP calls from this key yet.</p>
        ) : (
          <div className="cx-table-wrap">
            <table className="cx-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Call</th>
                  <th>Result</th>
                  <th>Client</th>
                  <th className="num">Time</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id} className="click" onClick={() => nav.go(pathFor('activity', c.id))}>
                    <td className="mono cx-muted">{clock(c.ts)}</td>
                    <td className="mono small">{c.model ?? '–'}</td>
                    <td className={c.outcome === 'answered' ? '' : 'cx-bad'}>{c.reason}</td>
                    <td className="cx-muted small">{c.server ?? '–'}</td>
                    <td className="num tnum">{ms(c.latency_ms)}</td>
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
