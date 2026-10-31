'use client';

import { useMemo } from 'react';
import { pathFor, useNav } from './nav';
import { api, useStore, useUi } from './store';
import type { FileC, GroupC, KeyC, ModelKind, Rule, ServerC } from './types';

/** Every create / update / delete the console can do, with confirms, toasts and optimistic updates. */
export function useActions() {
  const { data, patch, reload } = useStore();
  const ui = useUi();
  const nav = useNav();

  return useMemo(() => {
    const groups = data?.groups ?? [];
    const root = groups.find((g) => g.parentId === null);
    const contextSetting = (g: GroupC, value: number[]) =>
      // The root sets the list; a sub-group adds to its parent's unless it already replaces it.
      value.length || g.parentId === null ? { mode: g.mode ?? (g.parentId === null ? 'set' : 'add'), value } : null;

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
      createFile: async (name: string, groupId: number | null) => {
        const n = /\.[a-z]+$/i.test(name) ? name : `${name}.md`;
        let made: FileC | null = null;
        await ui.run(async () => {
          made = await api<FileC>('context', { body: { name: n, body: `# ${n.replace(/\.[a-z]+$/i, '')}\n\n` } });
          const g = groups.find((x) => x.id === groupId);
          if (g && made) await api(`groups/${g.id}/settings`, { method: 'PUT', body: { key: 'context', setting: contextSetting(g, [...g.own, made.id]) } });
        }, `${n} created`);
        if (made) nav.go(pathFor('context', (made as FileC).id));
        return made as FileC | null;
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
