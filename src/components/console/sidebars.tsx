'use client';

import { useRef, useState } from 'react';
import { useActions } from './actions';
import { Ico, type IconName } from './icons';
import { fmtTokens } from './kit';
import { pathFor, subtree, useNav } from './nav';
import { selectedGroupId } from './paths';
import { api, type MenuItem, useStore, useUi } from './store';
import { Tree, type TreeNode, useExpanded } from './tree';
import type { Data, GroupC, View } from './types';

type Creating = { kind: 'group' | 'file'; parent: number | null } | null;

const LABEL: Record<View, string> = {
  overview: 'Overview',
  activity: 'Activity',
  guard: 'Guard checks',
  servers: 'Servers',
  groups: 'Groups',
  keys: 'API keys',
  context: 'Context files',
  rules: 'Custom rules',
  schemas: 'Schemas',
  studio: 'Studio',
  settings: 'Settings',
};

function Header({ title, actions }: { title: string; actions: { icon: IconName; label: string; run: () => void }[] }) {
  return (
    <div className="cx-side-head">
      <span>{title.toUpperCase()}</span>
      <div className="cx-side-acts">
        {actions.map((a) => (
          <button key={a.label} type="button" title={a.label} aria-label={a.label} onClick={a.run}>
            <Ico n={a.icon} />
          </button>
        ))}
      </div>
    </div>
  );
}

export function Sidebar({ width }: { width: number }) {
  const { view } = useNav();
  const { data, error } = useStore();
  let body: React.ReactNode;
  if (error && !data) body = <div className="cx-side-msg bad">{error}</div>;
  else if (!data) body = <div className="cx-side-msg">Loading…</div>;
  else if (view === 'servers') body = <ServersSide data={data} />;
  else if (view === 'rules') body = <RulesSide data={data} />;
  else if (view === 'studio') body = <StudioSide data={data} />;
  else if (view === 'schemas' || view === 'settings') body = <OutlineSide view={view} />;
  else body = <GroupsSide data={data} mode={view === 'groups' ? 'groups' : view === 'keys' ? 'keys' : view === 'context' ? 'context' : 'filter'} />;
  return (
    <aside className="cx-side" style={{ width }} aria-label={`${LABEL[view]} sidebar`}>
      {body}
    </aside>
  );
}

// ---------------------------------------------------------------- group trees (groups, keys, context, filters)

function GroupsSide({ data, mode }: { data: Data; mode: 'filter' | 'groups' | 'keys' | 'context' }) {
  const nav = useNav();
  const act = useActions();
  const ui = useUi();
  const root = data.groups.find((g) => g.parentId === null);
  const { expanded, toggle, expand, collapseAll } = useExpanded(`groups-${mode}`, root ? [`g:${root.id}`] : []);
  const [creating, setCreating] = useState<Creating>(null);
  const [allFiles, setAllFiles] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  // New groups, files and keys go inside the selected group (the one open in Groups, or the open key's).
  const selId = selectedGroupId({ view: nav.view, id: nav.id, group: nav.group }, data.groups, data.keys);
  const sel = data.groups.find((g) => g.id === selId) ?? null;

  const startCreate = (kind: 'group' | 'file', parent: number | null) => {
    setCreating({ kind, parent });
    // Open the parent and every folder above it so the name box is visible.
    const keys: string[] = [];
    for (let g = data.groups.find((x) => x.id === parent); g; g = data.groups.find((x) => x.id === g!.parentId)) keys.push(`g:${g.id}`);
    expand(keys);
  };
  const newNode = (kind: 'group' | 'file', parent: number | null): TreeNode => ({
    key: `new:${kind}`,
    label: '',
    text: '',
    icon: kind === 'group' ? 'folder' : 'file',
    iconClass: kind === 'group' ? 'folder' : 'md',
    editing: true,
    onRename: async (name) => {
      setCreating(null);
      if (kind === 'group') {
        const g = await act.createGroup(name, parent);
        if (g && mode === 'groups') nav.go(pathFor('groups', g.id));
      } else await act.createFile(name, parent);
    },
    onCancelEdit: () => setCreating(null),
  });

  const fileNode = (fid: number, g: GroupC | null): TreeNode | null => {
    const f = data.files.find((x) => x.id === fid);
    if (!f) return null;
    const path = pathFor('context', f.id);
    const dirty = nav.drafts[path] !== undefined && nav.drafts[path] !== f.body;
    return {
      key: `f:${g?.id ?? 'x'}:${f.id}`,
      label: (
        <>
          {f.name}
          {dirty && <span className="cx-dot" aria-label="unsaved" />}
        </>
      ),
      text: f.name,
      icon: 'file',
      iconClass: 'md',
      meta: fmtTokens(f.tokens),
      title: `${f.name} · ${f.tokens} tokens${g ? ` · in ${g.name}` : ''}. Drag onto a group to move it.`,
      selected: nav.path === path,
      onOpen: () => nav.go(path),
      onRename: (name) => void act.renameFile(f, name),
      onDelete: () => void act.deleteFile(f),
      drag: `file:${f.id}:${g?.id ?? ''}`,
      actions: g ? [{ icon: 'unlink', label: `Remove from ${g.name}`, run: () => void act.detach(f.id, g.id) }] : [],
      menu: () => [
        { label: 'Open', run: () => nav.go(path) },
        ...(g ? [{ label: `Remove from ${g.name}`, run: () => void act.detach(f.id, g.id) }] : []),
        { sep: true, label: '' },
        { label: 'Delete', hint: 'Del', danger: true, run: () => void act.deleteFile(f) },
      ],
    };
  };

  const groupNode = (g: GroupC): TreeNode => {
    const isRoot = g.parentId === null;
    const kids: TreeNode[] = [];
    if (creating?.parent === g.id && creating.kind === 'group') kids.push(newNode('group', g.id));
    kids.push(...data.groups.filter((c) => c.parentId === g.id).map(groupNode));
    if (mode === 'context') {
      if (creating?.parent === g.id && creating.kind === 'file') kids.push(newNode('file', g.id));
      kids.push(...(g.own.map((fid) => fileNode(fid, g)).filter(Boolean) as TreeNode[]));
    }
    if (mode === 'keys')
      kids.push(
        ...data.keys
          .filter((k) => k.groupId === g.id)
          .map(
            (k): TreeNode => ({
              key: `k:${k.id}`,
              label: k.name,
              text: k.name,
              icon: 'key',
              iconClass: 'key',
              meta: k.revoked ? 'revoked' : k.owner,
              dim: k.revoked,
              title: `${k.name} · ${k.prefix}… · ${k.owner}`,
              selected: nav.path === pathFor('keys', k.id),
              onOpen: () => nav.go(pathFor('keys', k.id)),
              onRename: (name) => void act.renameKey(k, name),
              onDelete: () => void act.deleteKey(k),
              drag: `key:${k.id}`,
              menu: () => [
                { label: 'Open', run: () => nav.go(pathFor('keys', k.id)) },
                { label: k.revoked ? 'Restore key' : 'Revoke key', run: () => void act.revokeKey(k) },
                { label: 'Show activity', run: () => nav.go(pathFor('activity')) },
                { sep: true, label: '' },
                { label: 'Delete', hint: 'Del', danger: true, run: () => void act.deleteKey(k) },
              ],
            }),
          ),
      );
    const selected = mode === 'groups' ? nav.path === pathFor('groups', g.id) : sel?.id === g.id;
    const items = (): MenuItem[] => [
      ...(mode !== 'groups' ? [{ label: 'Open group settings', run: () => nav.go(pathFor('groups', g.id)) }] : []),
      { label: 'New sub-group', run: () => startCreate('group', g.id) },
      ...(mode === 'context' ? [{ label: 'New context file here', run: () => startCreate('file', g.id) }] : []),
      ...(mode === 'keys' || mode === 'groups' ? [{ label: 'New API key here', run: () => nav.go(`/keys/new?group=${g.id}`) }] : []),
      { label: 'Show activity', run: () => nav.go(`/activity?group=${g.id}`) },
      { sep: true, label: '' },
      { label: 'Delete', hint: 'Del', danger: true, disabled: isRoot, run: () => void act.deleteGroup(g) },
    ];
    return {
      key: `g:${g.id}`,
      label: g.name,
      text: g.name,
      icon: 'folder',
      iconClass: 'folder',
      badge: mode === 'keys' ? g.keyCount || null : mode === 'context' ? g.own.length || null : null,
      title: g.description || g.path,
      selected,
      children: kids,
      onOpen: () => {
        nav.setGroup(g.id);
        if (mode === 'groups') nav.go(pathFor('groups', g.id));
      },
      onRename: isRoot ? undefined : (name) => void act.renameGroup(g, name),
      onDelete: isRoot ? undefined : () => void act.deleteGroup(g),
      drag: isRoot ? undefined : `group:${g.id}`,
      canDrop: (p) => {
        const [t, id] = p.split(':');
        if (t === 'group') return !subtree(Number(id), data.groups).has(g.id) && data.groups.find((x) => x.id === Number(id))?.parentId !== g.id;
        if (t === 'file') return mode === 'context';
        if (t === 'key') return mode === 'keys';
        return false;
      },
      onDrop: (p) => {
        const [t, id, from] = p.split(':');
        if (t === 'group') {
          const moving = data.groups.find((x) => x.id === Number(id));
          if (moving) void act.moveGroup(moving, g.id);
        } else if (t === 'file') void act.moveFile(Number(id), from ? Number(from) : null, g.id);
        else if (t === 'key') {
          const k = data.keys.find((x) => x.id === Number(id));
          if (k) void act.moveKey(k, g.id);
        }
      },
      menu: items,
    };
  };

  const unattached = data.files.filter((f) => !data.groups.some((g) => g.own.includes(f.id)));
  const nodes: TreeNode[] = root ? [groupNode(root)] : [];
  const parent = sel?.id ?? root?.id ?? null;

  const actions: { icon: IconName; label: string; run: () => void }[] = [];
  if (mode === 'context') {
    actions.push({ icon: 'newFile', label: 'New context file in the selected group', run: () => startCreate('file', allFiles ? null : parent) });
    actions.push({ icon: 'newFolder', label: 'New group inside the selected group', run: () => startCreate('group', parent) });
    actions.push({ icon: 'upload', label: 'Upload .md files', run: () => upload.current?.click() });
    actions.push({ icon: allFiles ? 'tree' : 'list', label: allFiles ? 'Show files by group' : 'Show all files', run: () => setAllFiles(!allFiles) });
  }
  if (mode === 'groups') actions.push({ icon: 'newFolder', label: 'New group inside the selected group', run: () => startCreate('group', parent) });
  if (mode === 'keys') {
    actions.push({ icon: 'plus', label: 'New API key in the selected group', run: () => nav.go(`/keys/new${parent ? `?group=${parent}` : ''}`) });
    actions.push({ icon: 'newFolder', label: 'New group inside the selected group', run: () => startCreate('group', parent) });
  }
  actions.push({ icon: 'refresh', label: 'Refresh', run: () => void act.reload().then(() => ui.toast('Refreshed')) });
  actions.push({ icon: 'collapse', label: 'Collapse all', run: collapseAll });

  const uploadFiles = async (list: FileList) => {
    const target = data.groups.find((g) => g.id === parent);
    await ui.run(async () => {
      for (const f of Array.from(list)) {
        if (!/\.(md|markdown|txt)$/i.test(f.name)) {
          ui.toast(`${f.name} is not a Markdown file, skipped`, true);
          continue;
        }
        const body = await f.text();
        const existing = data.files.find((x) => x.name === f.name);
        if (existing) await api(`context/${existing.id}`, { method: 'PATCH', body: { body } });
        else {
          const made = await api<{ id: number }>('context', { body: { name: f.name, body } });
          if (target) {
            const own = [...target.own, made.id];
            target.own = own;
            await api(`groups/${target.id}/settings`, { method: 'PUT', body: { key: 'context', setting: { mode: target.mode ?? (target.parentId === null ? 'set' : 'add'), value: own } } });
          }
        }
      }
    }, `Uploaded${target ? ` into ${target.name}` : ''}`);
  };

  const title = mode === 'filter' ? LABEL[nav.view] : mode === 'context' ? 'Context files' : mode === 'keys' ? 'API keys' : 'Groups';
  return (
    <>
      <Header title={title} actions={actions} />
      <input ref={upload} type="file" accept=".md,.markdown,.txt" multiple hidden onChange={(e) => e.target.files && void uploadFiles(e.target.files).then(() => (e.target.value = ''))} />
      <div className="cx-side-body">
        {mode === 'context' && allFiles ? (
          <>
            <div className="cx-section">ALL FILES · {data.files.length}</div>
            <Tree
              label="All context files"
              nodes={[...(creating?.kind === 'file' ? [newNode('file', null)] : []), ...(data.files.map((f) => fileNode(f.id, null)).filter(Boolean) as TreeNode[])]}
              expanded={expanded}
              onToggle={toggle}
              empty={<span>No context files yet.</span>}
            />
          </>
        ) : (
          <>
            <div className="cx-section">
              GROUPS {mode === 'keys' && <span className="cx-badge">{data.keys.length}</span>}
              {mode === 'filter' && <span className="cx-section-hint">pick one to narrow the view</span>}
            </div>
            <Tree label="Groups" nodes={nodes} expanded={expanded} onToggle={toggle} />
            {mode === 'context' && (
              <>
                <div className="cx-section gap">
                  NOT IN ANY GROUP <span className="cx-badge">{unattached.length}</span>
                </div>
                <Tree
                  label="Files not in any group"
                  nodes={[...(creating?.kind === 'file' && creating.parent === null ? [newNode('file', null)] : []), ...(unattached.map((f) => fileNode(f.id, null)).filter(Boolean) as TreeNode[])]}
                  expanded={expanded}
                  onToggle={toggle}
                  empty={<span>Every file is in a group. Drag a file here from the files list to see it.</span>}
                />
              </>
            )}
          </>
        )}
      </div>
      {sel && mode !== 'groups' && (
        <div className="cx-side-foot">
          <Ico n="folder" size={13} /> {sel.path}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- servers

function ServersSide({ data }: { data: Data }) {
  const nav = useNav();
  const act = useActions();
  const ui = useUi();
  const { expanded, toggle, collapseAll } = useExpanded('servers', data.servers.map((s) => `s:${s.id}`));
  const nodes: TreeNode[] = data.servers.map((s) => ({
    key: `s:${s.id}`,
    label: s.name,
    text: s.name,
    icon: 'servers',
    iconClass: `srv ${s.status}`,
    meta: `${s.models.filter((m) => m.enabled).length}/${s.models.length}`,
    title: `${s.url} · ${s.status}${s.latency_ms != null ? ` · ${s.latency_ms} ms` : ''}`,
    selected: nav.path === pathFor('servers', s.id),
    onOpen: () => nav.go(pathFor('servers', s.id)),
    onRename: (name) => void act.renameServer(s, name),
    onDelete: () => void act.deleteServer(s),
    actions: [{ icon: 'refresh', label: `Rediscover ${s.name}`, run: () => void act.rediscover(s) }],
    menu: () => [
      { label: 'Open', run: () => nav.go(pathFor('servers', s.id)) },
      { label: 'Rediscover models', run: () => void act.rediscover(s) },
      { label: 'Turn every model on', run: () => void act.setAllModels(s, true) },
      { label: 'Turn every model off', run: () => void act.setAllModels(s, false) },
      { sep: true, label: '' },
      { label: 'Remove server', hint: 'Del', danger: true, run: () => void act.deleteServer(s) },
    ],
    children: s.models.map((m) => ({
      key: `m:${m.id}`,
      label: m.name,
      text: m.name,
      icon: 'model',
      iconClass: m.enabled ? 'on' : '',
      dim: !m.enabled || !m.present,
      meta: !m.present ? 'gone' : m.enabled ? 'on' : 'off',
      title: `${m.name}${m.enabled ? ' · clients can use it' : ' · hidden from clients'}`,
      onOpen: () => nav.go(pathFor('servers', s.id)),
      actions: [{ icon: m.enabled ? 'check' : 'plus', label: m.enabled ? `Turn ${m.name} off` : `Turn ${m.name} on`, run: () => void act.toggleModel(m.id, !m.enabled) }],
      menu: () => [{ label: m.enabled ? 'Turn off for clients' : 'Turn on for clients', run: () => void act.toggleModel(m.id, !m.enabled) }],
    })),
  }));
  return (
    <>
      <Header
        title="Servers"
        actions={[
          { icon: 'plus', label: 'Add a server', run: () => nav.go('/servers/new') },
          { icon: 'refresh', label: 'Refresh', run: () => void act.reload().then(() => ui.toast('Refreshed')) },
          { icon: 'collapse', label: 'Collapse all', run: collapseAll },
        ]}
      />
      <div className="cx-side-body">
        <div className="cx-section">SERVERS · {data.servers.length}</div>
        <Tree
          label="Servers and models"
          nodes={nodes}
          expanded={expanded}
          onToggle={toggle}
          empty={
            <span>
              No servers yet. <button type="button" className="cx-link" onClick={() => nav.go('/servers/new')}>Add a server</button>
            </span>
          }
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- rules

function RulesSide({ data }: { data: Data }) {
  const nav = useNav();
  const act = useActions();
  const { expanded, toggle } = useExpanded('rules');
  const nodes: TreeNode[] = data.rules.map((r) => ({
    key: `r:${r.id}`,
    label: r.name,
    text: r.name,
    icon: 'filter',
    iconClass: r.action === 'block' ? 'bad' : r.action === 'redact' ? 'warn' : 'info',
    dim: !r.enabled,
    meta: r.enabled ? `${r.hits} hits` : 'off',
    selected: nav.path === pathFor('rules', r.id),
    onOpen: () => nav.go(pathFor('rules', r.id)),
    onDelete: () => void act.deleteRule(r),
    menu: () => [
      { label: 'Open', run: () => nav.go(pathFor('rules', r.id)) },
      { label: r.enabled ? 'Turn off' : 'Turn on', run: () => void act.toggleRule(r, !r.enabled) },
      { sep: true, label: '' },
      { label: 'Delete', hint: 'Del', danger: true, run: () => void act.deleteRule(r) },
    ],
  }));
  return (
    <>
      <Header title="Custom rules" actions={[{ icon: 'plus', label: 'New rule', run: () => nav.go('/rules/new') }]} />
      <div className="cx-side-body">
        <div className="cx-section">RULES · {data.rules.length}</div>
        <Tree
          label="Custom rules"
          nodes={nodes}
          expanded={expanded}
          onToggle={toggle}
          empty={
            <span>
              No rules yet. <button type="button" className="cx-link" onClick={() => nav.go('/rules/new')}>Create one</button>
            </span>
          }
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- simple outlines

const OUTLINES: Record<string, [string, string][]> = {
  schemas: [
    ['policy', 'Schema policy'],
    ['known', 'Known schemas'],
    ['tester', 'Detection tester'],
  ],
  settings: [
    ['appearance', 'Appearance'],
    ['general', 'General'],
    ['context', 'Context and policy prompt'],
    ['limits', 'Server and model limits'],
    ['account', 'Account'],
  ],
};

function OutlineSide({ view }: { view: 'schemas' | 'settings' }) {
  const nav = useNav();
  const items = OUTLINES[view];
  return (
    <>
      <Header title={LABEL[view]} actions={[]} />
      <div className="cx-side-body">
        <div className="cx-section">ON THIS PAGE</div>
        <div role="list">
          {items.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="listitem"
              className="cx-row"
              style={{ paddingLeft: 24 }}
              onClick={() => {
                if (nav.path !== pathFor(view)) nav.go(pathFor(view));
                setTimeout(() => document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
              }}
            >
              <span className="cx-ico">
                <Ico n="chevron" size={14} />
              </span>
              <span className="cx-label">{label}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- studio scenarios

function StudioSide({ data }: { data: Data }) {
  const nav = useNav();
  const ui = useUi();
  const { expanded, toggle } = useExpanded('studio');
  const [creating, setCreating] = useState(false);
  const create = async (name: string) => {
    setCreating(false);
    let id = 0;
    if (await ui.run(async () => (id = (await api<{ id: number }>('studio/scenarios', { body: { name } })).id), `${name} created`)) nav.go(pathFor('studio', id));
  };
  const remove = async (id: number, name: string) => {
    if (!(await ui.confirm({ title: `Delete the scenario ${name}?`, body: 'Its chat and settings are removed. Logged requests stay in Activity.', ok: 'Delete scenario', danger: true }))) return;
    if (await ui.run(() => api(`studio/scenarios/${id}`, { method: 'DELETE' }), `${name} deleted`)) nav.closeTab(pathFor('studio', id));
  };
  const nodes: TreeNode[] = [
    ...(creating ? [{ key: 'new', label: '', text: '', icon: 'send' as IconName, editing: true, onRename: (n: string) => void create(n), onCancelEdit: () => setCreating(false) }] : []),
    ...data.scenarios.map((sc) => ({
      key: `sc:${sc.id}`,
      label: sc.name,
      text: sc.name,
      icon: 'send' as IconName,
      meta: sc.tags.slice(0, 2).join(', '),
      title: [sc.description, sc.notes].filter(Boolean).join(' · '),
      selected: nav.path === pathFor('studio', sc.id),
      onOpen: () => nav.go(pathFor('studio', sc.id)),
      onRename: (name: string) => void ui.run(() => api(`studio/scenarios/${sc.id}`, { method: 'PATCH', body: { name } }), 'Renamed'),
      onDelete: () => void remove(sc.id, sc.name),
      menu: () => [
        { label: 'Open', run: () => nav.go(pathFor('studio', sc.id)) },
        { label: 'Duplicate', run: () => void ui.run(async () => nav.go(pathFor('studio', (await api<{ id: number }>('studio/scenarios', { body: { duplicateOf: sc.id } })).id)), 'Duplicated') },
        { sep: true, label: '' },
        { label: 'Delete', hint: 'Del', danger: true, run: () => void remove(sc.id, sc.name) },
      ],
    })),
  ];
  return (
    <>
      <Header title="Studio" actions={[{ icon: 'plus', label: 'New scenario', run: () => setCreating(true) }]} />
      <div className="cx-side-body">
        <div className="cx-section">SCENARIOS · {data.scenarios.length}</div>
        <Tree label="Studio scenarios" nodes={nodes} expanded={expanded} onToggle={toggle} empty={<span>No scenarios yet. <button type="button" className="cx-link" onClick={() => setCreating(true)}>Create one</button></span>} />
      </div>
    </>
  );
}
