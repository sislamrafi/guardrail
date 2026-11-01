'use client';

import { useMemo } from 'react';
import { pathFor, useNav } from './nav';
import { api, useStore, useUi } from './store';
import type { DocC, FileC, GroupC, KeyC, ModelKind, Rule, ServerC } from './types';

/** Every create / update / delete the console can do, with confirms, toasts and optimistic updates. */
export function useActions() {
  const { data, patch, reload } = useStore();
  const ui = useUi();
  const nav = useNav();

  return useMemo(() => {
    const groups = data?.groups ?? [];
    const root = groups.find((g) => g.parentId === null);
    const contextSetting = (g: GroupC, value: number[], exclude = g.ctxExclude) =>
      // The root sets the list; a sub-group adds to its parent's unless it already replaces it. Exclusions stay.
      value.length || exclude.length || g.parentId === null ? { mode: g.mode ?? (g.parentId === null ? 'set' : 'add'), value, ...(exclude.length && g.parentId !== null ? { exclude } : {}) } : null;

    const docsSetting = (g: GroupC, value: number[], exclude = g.docsExclude) =>
      value.length || exclude.length || g.parentId === null ? { mode: g.docsMode ?? (g.parentId === null ? 'set' : 'add'), value, ...(exclude.length && g.parentId !== null ? { exclude } : {}) } : null;
    // A key's own list for a list setting (context files, MCP docs), added on top of its group's.
    const keyList = (k: KeyC, key: 'context' | 'mcp_docs') => (Array.isArray(k.exceptions[key]?.value) ? (k.exceptions[key]!.value as number[]) : []);
    const putKeyList = (k: KeyC, key: 'context' | 'mcp_docs', ids: number[]) => {
      const exceptions = { ...k.exceptions };
      // A key that replaces its group's list keeps replacing it; its exclusions stay.
      const exclude = k.exceptions[key]?.exclude ?? [];
      if (ids.length || exclude.length || k.exceptions[key]?.mode === 'override') exceptions[key] = { mode: k.exceptions[key]?.mode === 'override' ? 'override' : 'add', value: [...new Set(ids)], ...(exclude.length ? { exclude } : {}) };
      else delete exceptions[key];
      return api(`keys/${k.id}`, { method: 'PATCH', body: { exceptions } });
    };
    const putDocs = (g: GroupC, value: number[]) => api(`groups/${g.id}/settings`, { method: 'PUT', body: { key: 'mcp_docs', setting: docsSetting(g, value) } });

    return {
      // ---------------- groups
      createGroup: async (name: string, parentId: number | null) => {
        let made: GroupC | null = null;
        await ui.run(async () => {
          made = await api<GroupC>('groups', { body: { name, parentId: parentId ?? root?.id } });
        }, `Group ${name} created`);
        return made as GroupC | null;
      },
      renameGroup: (g: GroupC, name: string) => {
        patch((d) => ({ ...d, groups: d.groups.map((x) => (x.id === g.id ? { ...x, name } : x)) }));
        return ui.run(() => api(`groups/${g.id}`, { method: 'PATCH', body: { name } }), 'Renamed');
      },
      updateGroup: (g: GroupC, body: { name?: string; description?: string; parentId?: number }) => ui.run(() => api(`groups/${g.id}`, { method: 'PATCH', body }), 'Group saved'),
      moveGroup: (g: GroupC, parentId: number) => {
        const target = groups.find((x) => x.id === parentId);
        if (!target || g.parentId === null || g.parentId === parentId) return Promise.resolve(false);
        return ui.run(() => api(`groups/${g.id}`, { method: 'PATCH', body: { parentId } }), `${g.name} moved into ${target.name}`);
      },
      deleteGroup: async (g: GroupC) => {
        if (g.parentId === null) return ui.toast('The root group cannot be deleted.', true);
        const ok = await ui.confirm({ title: `Delete the group ${g.name}?`, body: 'Its own settings and context attachments go with it. Sub-groups and keys must be moved out first.', ok: 'Delete group', danger: true });
        if (!ok) return;
        if (await ui.run(() => api(`groups/${g.id}`, { method: 'DELETE' }), `Group ${g.name} deleted`)) {
          nav.closeTab(pathFor('groups', g.id));
          if (nav.group === g.id) nav.setGroup(g.parentId);
        }
      },
      saveSetting: (g: GroupC, key: string, setting: unknown, ok = 'Saved') => ui.run(() => api(`groups/${g.id}/settings`, { method: 'PUT', body: { key, setting } }), ok),

      // ---------------- context files
      /** New file, given to one key (as its own exception) or else to a group. A free name is picked. */
      createFile: async (name: string, groupId: number | null, key?: KeyC | null, body?: string) => {
        let n = /\.[a-z]+$/i.test(name) ? name : `${name}.md`;
        if (body === undefined) for (let i = 2; data?.files.some((f) => f.name === n); i++) n = `${name.replace(/\.[a-z]+$/i, '')}-${i}.md`;
        let made: FileC | null = null;
        await ui.run(async () => {
          made = await api<FileC>('context', { body: { name: n, body: body ?? `# ${n.replace(/\.[a-z]+$/i, '')}\n\n` } });
          const g = groups.find((x) => x.id === groupId);
          if (key && made) await putKeyList(key, 'context', [...keyList(key, 'context'), (made as FileC).id]);
          else if (g && made) await api(`groups/${g.id}/settings`, { method: 'PUT', body: { key: 'context', setting: contextSetting(g, [...g.own, (made as FileC).id]) } });
        }, `${n} created`);
        if (made && body === undefined) nav.go(pathFor('context', (made as FileC).id));
        return made as FileC | null;
      },
      /** Give one key a context file on top of its group's, or take that back. */
      setKeyFile: (k: KeyC, fileId: number, on: boolean) => {
        const cur = keyList(k, 'context');
        return ui.run(() => putKeyList(k, 'context', on ? [...new Set([...cur, fileId])] : cur.filter((i) => i !== fileId)), on ? `Added for ${k.name}` : `Removed from ${k.name}`);
      },
      /** Turn an inherited context file or MCP doc off (or back on) for a group or a key. Sub-groups inherit it. */
      setOff: (kind: 'context' | 'mcp_docs', id: number, off: boolean, scope: { group?: GroupC; key?: KeyC | null }) => {
        const name = (kind === 'context' ? data?.files.find((f) => f.id === id)?.name : data?.docs.find((d) => d.id === id)?.title) ?? 'It';
        const toggle = (cur: number[]) => (off ? [...new Set([...cur, id])] : cur.filter((i) => i !== id));
        if (scope.key) {
          const k = scope.key;
          const cur = k.exceptions[kind];
          const exclude = toggle(cur?.exclude ?? []);
          const value = Array.isArray(cur?.value) ? (cur!.value as number[]) : [];
          const exceptions = { ...k.exceptions };
          if (value.length || exclude.length || cur?.mode === 'override') exceptions[kind] = { mode: cur?.mode === 'override' ? 'override' : 'add', value, ...(exclude.length ? { exclude } : {}) };
          else delete exceptions[kind];
          return ui.run(() => api(`keys/${k.id}`, { method: 'PATCH', body: { exceptions } }), `${name} ${off ? 'off' : 'back on'} for ${k.name}`);
        }
        const g = scope.group;
        if (!g || g.parentId === null) return ui.toast('The root group has nothing inherited to turn off; remove the item instead.', true);
        const setting = kind === 'context' ? contextSetting(g, g.own, toggle(g.ctxExclude)) : docsSetting(g, g.ownDocs, toggle(g.docsExclude));
        return ui.run(() => api(`groups/${g.id}/settings`, { method: 'PUT', body: { key: kind, setting } }), `${name} ${off ? 'off' : 'back on'} for ${g.name}`);
      },
      /** Replace the context files one key gets (e.g. to leave out an inherited file for that key only). */
      setKeyFiles: (k: KeyC, ids: number[], ok: string) => {
        const exceptions = { ...k.exceptions, context: { mode: 'override' as const, value: ids } };
        return ui.run(() => api(`keys/${k.id}`, { method: 'PATCH', body: { exceptions } }), ok);
      },
      /** Turn a guard layer on or off for one key, or back to its group's choice (null). */
      setKeyLayer: (k: KeyC, layerId: string, on: boolean | null) => {
        const cur = { ...((k.exceptions.layers?.value as Record<string, boolean> | undefined) ?? {}) };
        if (on === null) delete cur[layerId];
        else cur[layerId] = on;
        const exceptions = { ...k.exceptions };
        if (Object.keys(cur).length) exceptions.layers = { mode: 'override', value: cur };
        else delete exceptions.layers;
        return ui.run(() => api(`keys/${k.id}`, { method: 'PATCH', body: { exceptions } }), on === null ? `${k.name} follows its group again` : `${on ? 'On' : 'Off'} for ${k.name}`);
      },
      renameFile: (f: FileC, name: string) => {
        patch((d) => ({ ...d, files: d.files.map((x) => (x.id === f.id ? { ...x, name } : x)) }));
        return ui.run(() => api(`context/${f.id}`, { method: 'PATCH', body: { name } }), 'Renamed');
      },
      saveFile: (f: FileC, body: string) => ui.run(() => api(`context/${f.id}`, { method: 'PATCH', body: { body } }), `${f.name} saved`),
      deleteFile: async (f: FileC) => {
        const ok = await ui.confirm({ title: `Delete ${f.name}?`, body: f.usedBy.length ? `It is attached to ${f.usedBy.join(', ')}. Those groups stop sending it.` : 'No group uses it.', ok: 'Delete file', danger: true });
        if (!ok) return;
        if (await ui.run(() => api(`context/${f.id}`, { method: 'DELETE' }), `${f.name} deleted`)) nav.closeTab(pathFor('context', f.id));
      },
      attach: (fileId: number, groupId: number) => {
        const g = groups.find((x) => x.id === groupId);
        const f = data?.files.find((x) => x.id === fileId);
        if (!g || !f) return;
        if (g.own.includes(fileId)) return ui.toast(`${f.name} is already in ${g.name}`);
        patch((d) => ({ ...d, groups: d.groups.map((x) => (x.id === g.id ? { ...x, own: [...x.own, fileId] } : x)) }));
        return ui.run(() => api(`groups/${g.id}/settings`, { method: 'PUT', body: { key: 'context', setting: contextSetting(g, [...g.own, fileId]) } }), `${f.name} attached to ${g.name}`);
      },
      detach: (fileId: number, groupId: number) => {
        const g = groups.find((x) => x.id === groupId);
        if (!g) return;
        patch((d) => ({ ...d, groups: d.groups.map((x) => (x.id === g.id ? { ...x, own: x.own.filter((i) => i !== fileId) } : x)) }));
        return ui.run(() => api(`groups/${g.id}/settings`, { method: 'PUT', body: { key: 'context', setting: contextSetting(g, g.own.filter((i) => i !== fileId)) } }), `Removed from ${g.name}`);
      },
      /** Move a file from one group to another (drag between folders). */
      moveFile: async (fileId: number, from: number | null, to: number) => {
        const target = groups.find((x) => x.id === to);
        const src = groups.find((x) => x.id === from);
        if (!target || from === to) return;
        await ui.run(async () => {
          if (!target.own.includes(fileId)) await api(`groups/${to}/settings`, { method: 'PUT', body: { key: 'context', setting: contextSetting(target, [...target.own, fileId]) } });
          if (src) await api(`groups/${src.id}/settings`, { method: 'PUT', body: { key: 'context', setting: contextSetting(src, src.own.filter((i) => i !== fileId)) } });
        }, `Moved to ${target.name}`);
      },

      // ---------------- MCP docs
      createDoc: async (title: string, groupId: number | null, body?: string, key?: KeyC | null) => {
        let made: DocC | null = null;
        const t = title.replace(/\.(md|markdown|txt)$/i, '');
        await ui.run(async () => {
          made = await api<DocC>('docs', { body: { title: t, body: body ?? `# ${t}\n\n` } });
          const g = groups.find((x) => x.id === groupId);
          if (key && made) await putKeyList(key, 'mcp_docs', [...keyList(key, 'mcp_docs'), (made as DocC).id]);
          else if (g && made) await putDocs(g, [...g.ownDocs, (made as DocC).id]);
        }, `${t} created`);
        if (made && body === undefined) nav.go(pathFor('docs', (made as DocC).id));
        return made as DocC | null;
      },
      renameDoc: (d: DocC, title: string) => {
        patch((x) => ({ ...x, docs: x.docs.map((y) => (y.id === d.id ? { ...y, title } : y)) }));
        return ui.run(() => api(`docs/${d.id}`, { method: 'PATCH', body: { title } }), 'Renamed');
      },
      deleteDoc: async (d: DocC) => {
        const ok = await ui.confirm({ title: `Delete ${d.title}?`, body: d.reach ? `${d.reach} key${d.reach === 1 ? '' : 's'} can read it now; agents lose it right away.` : 'No key can read it.', ok: 'Delete doc', danger: true });
        if (!ok) return;
        if (await ui.run(() => api(`docs/${d.id}`, { method: 'DELETE' }), `${d.title} deleted`)) nav.closeTab(pathFor('docs', d.id));
      },
      shareDoc: (docId: number, groupId: number) => {
        const g = groups.find((x) => x.id === groupId);
        const d = data?.docs.find((x) => x.id === docId);
        if (!g || !d) return;
        if (g.ownDocs.includes(docId)) return ui.toast(`${d.title} is already shared with ${g.name}`);
        patch((x) => ({ ...x, groups: x.groups.map((y) => (y.id === g.id ? { ...y, ownDocs: [...y.ownDocs, docId] } : y)) }));
        return ui.run(() => putDocs(g, [...g.ownDocs, docId]), `${d.title} shared with ${g.name}`);
      },
      unshareDoc: (docId: number, groupId: number) => {
        const g = groups.find((x) => x.id === groupId);
        if (!g) return;
        patch((x) => ({ ...x, groups: x.groups.map((y) => (y.id === g.id ? { ...y, ownDocs: y.ownDocs.filter((i) => i !== docId) } : y)) }));
        return ui.run(() => putDocs(g, g.ownDocs.filter((i) => i !== docId)), `No longer shared with ${g.name}`);
      },
      /** Drag between groups moves the doc; from the list (no source group) it only adds. */
      moveDoc: async (docId: number, from: number | null, to: number) => {
        const target = groups.find((x) => x.id === to);
        const src = groups.find((x) => x.id === from);
        if (!target || from === to) return;
        await ui.run(async () => {
          if (!target.ownDocs.includes(docId)) await putDocs(target, [...target.ownDocs, docId]);
          if (src) await putDocs(src, src.ownDocs.filter((i) => i !== docId));
        }, src ? `Moved to ${target.name}` : `Shared with ${target.name}`);
      },
      /** Give one key a doc (or take it away) as its own exception, on top of its group's. */
      setKeyDoc: (k: KeyC, docId: number, on: boolean) => {
        const cur = Array.isArray(k.exceptions.mcp_docs?.value) ? (k.exceptions.mcp_docs!.value as number[]) : [];
        const next = on ? [...new Set([...cur, docId])] : cur.filter((i) => i !== docId);
        const exceptions = { ...k.exceptions };
        if (next.length) exceptions.mcp_docs = { mode: 'add', value: next };
        else delete exceptions.mcp_docs;
        return ui.run(() => api(`keys/${k.id}`, { method: 'PATCH', body: { exceptions } }), on ? `Shared with ${k.name}` : `No longer shared with ${k.name}`);
      },
      setKeyMcp: (k: KeyC, mcp: boolean) => {
        patch((x) => ({ ...x, keys: x.keys.map((y) => (y.id === k.id ? { ...y, mcp } : y)) }));
        return ui.run(() => api(`keys/${k.id}`, { method: 'PATCH', body: { mcp } }), mcp ? `MCP access on for ${k.name}` : `MCP access off for ${k.name}`);
      },

      // ---------------- keys
      revokeKey: (k: KeyC, revoked = !k.revoked) => {
        patch((d) => ({ ...d, keys: d.keys.map((x) => (x.id === k.id ? { ...x, revoked } : x)) }));
        return ui.run(() => api(`keys/${k.id}`, { method: 'PATCH', body: { revoked } }), revoked ? `${k.name} revoked` : `${k.name} restored`);
      },
      moveKey: (k: KeyC, groupId: number) => {
        const g = groups.find((x) => x.id === groupId);
        if (!g || k.groupId === groupId) return;
        return ui.run(() => api(`keys/${k.id}`, { method: 'PATCH', body: { groupId } }), `${k.name} moved to ${g.name}`);
      },
      renameKey: (k: KeyC, name: string) => ui.run(() => api(`keys/${k.id}`, { method: 'PATCH', body: { name } }), 'Renamed'),
      deleteKey: async (k: KeyC) => {
        const ok = await ui.confirm({ title: `Delete the key ${k.name}?`, body: 'Clients using it stop working right away. This cannot be undone; revoking keeps the record.', ok: 'Delete key', danger: true });
        if (!ok) return;
        if (await ui.run(() => api(`keys/${k.id}`, { method: 'DELETE' }), `${k.name} deleted`)) nav.closeTab(pathFor('keys', k.id));
      },

      // ---------------- servers and models
      toggleModel: (modelId: number, enabled: boolean) => {
        patch((d) => ({ ...d, servers: d.servers.map((s) => ({ ...s, models: s.models.map((m) => (m.id === modelId ? { ...m, enabled: enabled ? 1 : 0 } : m)) })) }));
        return ui.run(() => api(`models/${modelId}`, { method: 'PATCH', body: { enabled } }));
      },
      setModelKind: (modelId: number, kind: ModelKind | null) => {
        patch((d) => ({ ...d, servers: d.servers.map((s) => ({ ...s, models: s.models.map((m) => (m.id === modelId ? { ...m, kind_override: kind } : m)) })) }));
        return ui.run(() => api(`models/${modelId}`, { method: 'PATCH', body: { kind } }), 'Model type saved');
      },
      setAllModels: (s: ServerC, enabled: boolean) =>
        ui.run(async () => {
          for (const m of s.models) if (!!m.enabled !== enabled) await api(`models/${m.id}`, { method: 'PATCH', body: { enabled } });
        }, enabled ? `Every model on ${s.name} is on` : `Every model on ${s.name} is off`),
      rediscover: (s: ServerC) =>
        ui.run(async () => {
          const r = await api<{ ok: boolean; error?: string; found?: number; newModels?: number; notes?: string[] }>(`servers/${s.id}/rediscover`, { body: {} });
          if (!r.ok) throw new Error(`Could not reach ${s.name}: ${r.error}`);
          ui.toast(`${s.name}: ${r.found} models${r.newModels ? `, ${r.newModels} new (off until you turn them on)` : ''}${r.notes?.length ? `. ${r.notes.join(' ')}` : ''}`);
        }),
      renameServer: (s: ServerC, name: string) => ui.run(() => api(`servers/${s.id}`, { method: 'PATCH', body: { name } }), 'Renamed'),
      deleteServer: async (s: ServerC) => {
        const ok = await ui.confirm({ title: `Remove the server ${s.name}?`, body: `Its ${s.models.length} models and their rules go with it. Clients can no longer reach them.`, ok: 'Remove server', danger: true });
        if (!ok) return;
        if (await ui.run(() => api(`servers/${s.id}`, { method: 'DELETE' }), `${s.name} removed`)) nav.closeTab(pathFor('servers', s.id));
      },
      deleteLimit: (id: number) => ui.run(() => api(`limits/${id}`, { method: 'DELETE' }), 'Limit removed'),

      // ---------------- rules
      toggleRule: (r: Rule, enabled: boolean) => ui.run(() => api(`rules/${r.id}`, { method: 'PATCH', body: { enabled: enabled ? 1 : 0 } }), enabled ? `${r.name} on` : `${r.name} off`),
      deleteRule: async (r: Rule) => {
        const ok = await ui.confirm({ title: `Delete the rule ${r.name}?`, ok: 'Delete rule', danger: true });
        if (!ok) return false;
        const done = await ui.run(() => api(`rules/${r.id}`, { method: 'DELETE' }), 'Rule deleted');
        if (done) nav.closeTab(pathFor('rules', r.id));
        return done;
      },

      reload,
    };
  }, [data, patch, ui, nav, reload]);
}
