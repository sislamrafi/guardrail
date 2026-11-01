'use client';

import { useEffect, useRef, useState } from 'react';
import { useActions } from './actions';
import { Ico, type IconName } from './icons';
import { pathFor, subtree, useNav } from './nav';
import { api, useStore, useUi } from './store';
import { Tree, type TreeNode, useExpanded } from './tree';
import type { Data, GroupC, KeyC, View } from './types';

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
  docs: 'MCP docs',
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
  else body = <GroupsSide data={data} />;
  return (
    <aside className="cx-side" style={{ width }} aria-label={`${LABEL[view]} sidebar`}>
      {body}
    </aside>
  );
}

// ---------------------------------------------------------------- the groups-and-keys explorer
//
// One tree for every section that works on a group or a key (Overview, Activity, Groups, API keys,
// Guard checks, Context files, MCP docs): groups, and under each group its API keys. Picking one sets
// the scope (?group= / ?key=) the section's right panel and pages work on; it stays picked across
// sections. Groups and API keys open their settings page instead.

function GroupsSide({ data }: { data: Data }) {
  const nav = useNav();
  const act = useActions();
  const ui = useUi();
  const root = data.groups.find((g) => g.parentId === null);
  const { expanded, toggle, expand, collapseAll } = useExpanded('scope', root ? [`g:${root.id}`] : []);
  const [creating, setCreating] = useState<Creating>(null);
  const upload = useRef<HTMLInputElement>(null);
  const view = nav.view;
  const editorKey = view === 'keys' && nav.id && nav.id !== 'new' ? Number(nav.id) : null;
  const editorGroup = view === 'groups' && nav.id ? Number(nav.id) : null;
  // The one selected row: the open group/key page in Groups and API keys, else the picked scope.
  const selKey = view === 'groups' ? null : view === 'keys' ? editorKey : nav.key;
  const keyRow = data.keys.find((k) => k.id === selKey) ?? null;
  const selGroupId = editorGroup ?? keyRow?.groupId ?? (view === 'keys' && nav.id ? null : nav.group) ?? root?.id ?? null;
  const sel = data.groups.find((g) => g.id === selGroupId) ?? root ?? null;

  // Keep the selection visible: open every group above it.
  useEffect(() => {
    if (!sel) return;
    const keys: string[] = [];
    for (let g = keyRow ? sel : data.groups.find((x) => x.id === sel.parentId); g; g = data.groups.find((x) => x.id === g!.parentId)) keys.push(`g:${g.id}`);
    if (keys.length) expand(keys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.id, keyRow?.id]);

  const showRight = () => window.dispatchEvent(new Event('cx-show-right'));
  const pickGroup = (g: GroupC) => {
    if (view === 'groups') return nav.go(`${pathFor('groups', g.id)}?group=${g.id}`);
    if (view === 'keys') return nav.go(`${pathFor('keys')}?group=${g.id}`);
    // A section's own item page (a request, a layer) has nothing to do with the scope; its library or a file stays open.
    nav.setScope({ group: g.id });
    showRight();
  };
  const pickKey = (k: KeyC) => {
    if (view === 'keys' || view === 'groups') return nav.go(`${pathFor('keys', k.id)}?group=${k.groupId}&key=${k.id}`);
    nav.setScope({ group: k.groupId, key: k.id });
    showRight();
  };

  const startCreate = (kind: 'group' | 'file', parent: number | null) => {
    setCreating({ kind, parent });
    const keys: string[] = [];
    for (let g = data.groups.find((x) => x.id === parent); g; g = data.groups.find((x) => x.id === g!.parentId)) keys.push(`g:${g.id}`);
    expand(keys);
  };
  const groupName = (parent: number | null, self?: number) => (name: string) =>
    data.groups.some((x) => x.parentId === parent && x.id !== self && x.name.toLowerCase() === name.toLowerCase()) ? `A group named "${name}" is already here.` : null;
  const newGroupNode = (parent: number | null): TreeNode => ({
    key: 'new:group',
    label: '',
    text: '',
    icon: 'folder',
    iconClass: 'folder',
    editing: true,
    validate: groupName(parent),
    onRename: async (name) => {
      setCreating(null);
      const g = await act.createGroup(name, parent);
      if (g && view === 'groups') nav.go(`${pathFor('groups', g.id)}?group=${g.id}`);
      else if (g) nav.setScope({ group: g.id });
    },
    onCancelEdit: () => setCreating(null),
  });

  const keyNode = (k: KeyC): TreeNode => {
    const expired = !!k.expiresAt && k.expiresAt < Date.now();
    const state = k.revoked ? 'revoked' : expired ? 'expired' : null;
    const mcpOff = view === 'docs' && !k.mcp;
    return {
      key: `k:${k.id}`,
      label: k.name,
      text: k.name,
      icon: 'key',
      iconClass: 'key',
      meta: state ?? (mcpOff ? 'MCP off' : k.owner),
      dim: !!state || mcpOff,
      title: `${k.name} · ${k.prefix}… · ${k.owner} · ${data.groups.find((g) => g.id === k.groupId)?.path ?? ''}`,
      selected: selKey === k.id,
      onOpen: () => pickKey(k),
      onRename: (name) => void act.renameKey(k, name),
      onDelete: () => void act.deleteKey(k),
      drag: `key:${k.id}`,
      // A file or doc dragged from the right panel's library is added to this key.
      canDrop: (p) => (p.startsWith('file:') && view === 'context') || (p.startsWith('doc:') && view === 'docs'),
      onDrop: (p) => {
        const id = Number(p.split(':')[1]);
        if (p.startsWith('file:')) void act.setKeyFile(k, id, true);
        else void act.setKeyDoc(k, id, true);
      },
      menu: () => [
        { label: 'Open key settings', run: () => nav.go(`${pathFor('keys', k.id)}?group=${k.groupId}&key=${k.id}`) },
        { label: k.revoked ? 'Restore key' : 'Revoke key', run: () => void act.revokeKey(k) },
        { label: k.mcp ? 'Turn MCP access off' : 'Turn MCP access on', run: () => void act.setKeyMcp(k, !k.mcp) },
        { label: 'Show its activity', run: () => nav.go(`${pathFor('activity')}?group=${k.groupId}&key=${k.id}`) },
        { sep: true, label: '' },
        { label: 'Delete', hint: 'Del', danger: true, run: () => void act.deleteKey(k) },
      ],
    };
  };

  const groupNode = (g: GroupC): TreeNode => {
    const isRoot = g.parentId === null;
    const kids: TreeNode[] = [];
    if (creating?.parent === g.id && creating.kind === 'group') kids.push(newGroupNode(g.id));
    kids.push(...data.groups.filter((c) => c.parentId === g.id).map(groupNode));
    kids.push(...data.keys.filter((k) => k.groupId === g.id).map(keyNode));
    return {
      key: `g:${g.id}`,
      label: g.name,
      text: g.name,
      icon: 'folder',
      iconClass: 'folder',
      badge: g.keyCount || null,
      title: g.description || g.path,
      selected: !selKey && sel?.id === g.id && !(view === 'keys' && editorKey === null && nav.id),
      children: kids,
      onOpen: () => pickGroup(g),
      onRename: (name) => void act.renameGroup(g, name),
      validate: groupName(g.parentId, g.id),
      onDelete: isRoot ? undefined : () => void act.deleteGroup(g),
      drag: isRoot ? undefined : `group:${g.id}`,
      canDrop: (p) => {
        const [t, id] = p.split(':');
        if (t === 'group') return !subtree(Number(id), data.groups).has(g.id) && data.groups.find((x) => x.id === Number(id))?.parentId !== g.id;
        if (t === 'key') return data.keys.find((k) => k.id === Number(id))?.groupId !== g.id;
        if (t === 'file') return view === 'context';
        if (t === 'doc') return view === 'docs';
        return false;
      },
      onDrop: (p) => {
        const [t, id] = p.split(':');
        if (t === 'group') {
          const moving = data.groups.find((x) => x.id === Number(id));
          if (moving) void act.moveGroup(moving, g.id);
        } else if (t === 'key') {
          const k = data.keys.find((x) => x.id === Number(id));
          if (k) void act.moveKey(k, g.id);
        } else if (t === 'file') void act.attach(Number(id), g.id);
        else if (t === 'doc') void act.shareDoc(Number(id), g.id);
      },
      menu: () => [
        { label: 'Open group settings', run: () => nav.go(`${pathFor('groups', g.id)}?group=${g.id}`) },
        { label: 'New sub-group', run: () => startCreate('group', g.id) },
        { label: 'New API key here', run: () => nav.go(`/keys/new?group=${g.id}`) },
        { label: 'Show activity', run: () => nav.go(`${pathFor('activity')}?group=${g.id}`) },
        { sep: true, label: '' },
        { label: 'Delete', hint: 'Del', danger: true, disabled: isRoot, run: () => void act.deleteGroup(g) },
      ],
    };
  };

  const parent = sel?.id ?? root?.id ?? null;
  const actions: { icon: IconName; label: string; run: () => void }[] = [];
  if (view === 'context') {
    actions.push({ icon: 'newFile', label: `New context file for ${keyRow ? keyRow.name : (sel?.name ?? 'this group')}`, run: () => void act.createFile('new-file', parent, keyRow) });
    actions.push({ icon: 'upload', label: 'Upload .md files', run: () => upload.current?.click() });
  }
  if (view === 'docs') {
    actions.push({ icon: 'newFile', label: `New MCP doc for ${keyRow ? keyRow.name : (sel?.name ?? 'this group')}`, run: () => void act.createDoc('New doc', keyRow ? null : parent, undefined, keyRow) });
    actions.push({ icon: 'upload', label: 'Upload .md files as MCP docs', run: () => upload.current?.click() });
  }
  actions.push({ icon: 'plus', label: 'New API key in the selected group', run: () => nav.go(`/keys/new${parent ? `?group=${parent}` : ''}`) });
  actions.push({ icon: 'newFolder', label: 'New group inside the selected group', run: () => startCreate('group', parent) });
  actions.push({ icon: 'refresh', label: 'Refresh', run: () => void act.reload().then(() => ui.toast('Refreshed')) });
  actions.push({ icon: 'collapse', label: 'Collapse all', run: collapseAll });

  const uploadFiles = async (list: FileList) => {
    await ui.run(async () => {
      for (const f of Array.from(list)) {
        if (!/\.(md|markdown|txt)$/i.test(f.name)) {
          ui.toast(`${f.name} is not a Markdown file, skipped`, true);
          continue;
        }
        const body = await f.text();
        if (view === 'docs') {
          const title = f.name.replace(/\.(md|markdown|txt)$/i, '');
          const existing = data.docs.find((x) => x.title === title);
          if (existing) await api(`docs/${existing.id}`, { method: 'PATCH', body: { body } });
          else await act.createDoc(title, keyRow ? null : parent, body, keyRow);
        } else {
          const existing = data.files.find((x) => x.name === f.name);
          if (existing) await api(`context/${existing.id}`, { method: 'PATCH', body: { body } });
          else await act.createFile(f.name, parent, keyRow, body);
        }
      }
    }, `Uploaded for ${keyRow ? keyRow.name : (sel?.name ?? 'the group')}`);
  };

  return (
    <>
      <Header title="Groups & keys" actions={actions} />
      <input ref={upload} type="file" accept=".md,.markdown,.txt" multiple hidden onChange={(e) => e.target.files && void uploadFiles(e.target.files).then(() => (e.target.value = ''))} />
      <div className="cx-side-body">
        <div className="cx-section">
          GROUPS <span className="cx-badge">{data.groups.length}</span> KEYS <span className="cx-badge">{data.keys.length}</span>
        </div>
        <Tree label="Groups and API keys" nodes={root ? [groupNode(root)] : []} expanded={expanded} onToggle={toggle} />
      </div>
      {sel && (
        <div className="cx-side-foot">
          <Ico n={keyRow ? 'key' : 'folder'} size={13} /> {keyRow ? `${sel.path} › ${keyRow.name}` : sel.path}
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
    meta: `${s.models.filter((m) => m.enabled).length}/${s.models.length}${s.hasKey ? ' · key' : ''}`,
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
    ['decisions', 'Decision schemas'],
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
