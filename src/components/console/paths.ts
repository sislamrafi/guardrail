import { VIEWS, type View } from './types';

/**
 * The URL is the source of truth: /<view>/<id>?group=<id>.
 * "/" is the overview. Every open editor tab is one path.
 */
export function parsePath(path: string): { view: View; id: string | null } {
  const [a, b] = path.split('/').filter(Boolean);
  const view = (VIEWS as readonly string[]).includes(a) ? (a as View) : 'overview';
  return { view, id: b ? decodeURIComponent(b) : null };
}

export function pathFor(view: View, id?: string | number | null) {
  if (view === 'overview' && id == null) return '/';
  return id == null ? `/${view}` : `/${view}/${encodeURIComponent(String(id))}`;
}

/** Group ids in the subtree under `id`, itself included. */
export function subtree(id: number, groups: { id: number; parentId: number | null }[]): Set<number> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of groups)
      if (g.parentId !== null && out.has(g.parentId) && !out.has(g.id)) {
        out.add(g.id);
        grew = true;
      }
  }
  return out;
}

/**
 * The group an explorer's "New group" (and similar) buttons act on: the group open in the editor,
 * the open key's group, else the group picked as a filter, else the root.
 */
export function selectedGroupId(
  at: { view: View; id: string | null; group: number | null },
  groups: { id: number; parentId: number | null }[],
  keys: { id: number; groupId: number }[] = [],
): number | null {
  const has = (id: number | null | undefined) => (id != null && groups.some((g) => g.id === id) ? id : null);
  const open = at.view === 'groups' && at.id ? has(Number(at.id)) : at.view === 'keys' && at.id ? has(keys.find((k) => k.id === Number(at.id))?.groupId) : null;
  return open ?? has(at.group) ?? groups.find((g) => g.parentId === null)?.id ?? null;
}
