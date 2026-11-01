import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '@/components/console/markdown';
import { parsePath, pathFor, selectedGroupId, subtree } from '@/components/console/paths';

describe('console routes', () => {
  it('creates new groups inside the selected group, not next to it', () => {
    const groups = [
      { id: 1, parentId: null },
      { id: 2, parentId: 1 },
      { id: 3, parentId: 1 },
    ];
    // Groups view: the group open in the editor is the parent, even with no ?group= filter.
    expect(selectedGroupId({ view: 'groups', id: '3', group: null }, groups)).toBe(3);
    expect(selectedGroupId({ view: 'groups', id: '3', group: 2 }, groups)).toBe(3);
    // Keys view: the open key's group.
    expect(selectedGroupId({ view: 'keys', id: '9', group: null }, groups, [{ id: 9, groupId: 2 }])).toBe(2);
    // Elsewhere: the picked group, else the root.
    expect(selectedGroupId({ view: 'context', id: null, group: 2 }, groups)).toBe(2);
    expect(selectedGroupId({ view: 'groups', id: null, group: null }, groups)).toBe(1);
    expect(selectedGroupId({ view: 'groups', id: '99', group: null }, groups)).toBe(1);
  });

  it('maps paths to views and ids', () => {
    expect(parsePath('/')).toEqual({ view: 'overview', id: null });
    expect(parsePath('/keys')).toEqual({ view: 'keys', id: null });
    expect(parsePath('/context/12')).toEqual({ view: 'context', id: '12' });
    expect(parsePath('/activity/req_ab%2Fc')).toEqual({ view: 'activity', id: 'req_ab/c' });
    expect(parsePath('/nope/1')).toEqual({ view: 'overview', id: '1' });
  });

  it('builds paths that parse back', () => {
    expect(pathFor('overview')).toBe('/');
    expect(pathFor('servers', 'new')).toBe('/servers/new');
    expect(parsePath(pathFor('activity', 'req_ab/c'))).toEqual({ view: 'activity', id: 'req_ab/c' });
  });

  it('finds a group subtree, so a group cannot be moved into its own child', () => {
    const groups = [
      { id: 1, parentId: null },
      { id: 2, parentId: 1 },
      { id: 3, parentId: 2 },
      { id: 4, parentId: 1 },
    ];
    expect([...subtree(2, groups)].sort()).toEqual([2, 3]);
    expect([...subtree(1, groups)].sort()).toEqual([1, 2, 3, 4]);
    expect(subtree(4, groups).has(3)).toBe(false);
  });
});

describe('markdown preview', () => {
  it('renders the basics', () => {
    const html = renderMarkdown('# Title\n\nUse **REST** and `GET`.\n\n- one\n- two\n\n```\ncode <b>\n```');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>REST</strong>');
    expect(html).toContain('<code>GET</code>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<pre><code>code &lt;b&gt;</code></pre>');
  });

  it('escapes HTML so a context file cannot inject markup', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1))');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('&lt;img');
  });
});

describe('Markdown in chats', () => {
  it('renders tables, strikethrough and code blocks with a copy button, still escaping HTML', () => {
    const html = renderMarkdown('I can help with **frontend** ~~backend~~\n\n| a | b |\n|---|---|\n| 1 | <b>2</b> |\n\n```ts\nconst x = 1;\n```');
    expect(html).toContain('<strong>frontend</strong>');
    expect(html).toContain('<del>backend</del>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>&lt;b&gt;2&lt;/b&gt;</td>');
    expect(html).toContain('data-md-copy');
    expect(html).toContain('<span class="md-lang">ts</span>');
  });
});

describe('UI preferences', () => {
  it('remembers values per browser and a reset clears only layout prefs', async () => {
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
    const g = globalThis as Record<string, unknown>;
    g.localStorage = new Proxy(fake, { ownKeys: () => [...store.keys()], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) });
    g.sessionStorage = { clear: () => undefined };
    const { readPref, writePref, resetUiPrefs } = await import('@/components/console/prefs');
    expect(readPref('flat.keys', false)).toBe(false);
    writePref('flat.keys', true);
    writePref('group.tab.3', 'guard');
    store.set('cx-theme', 'dark');
    expect(readPref('flat.keys', false)).toBe(true);
    expect(readPref('group.tab.3', 'eff')).toBe('guard');
    resetUiPrefs();
    expect(readPref('flat.keys', false)).toBe(false);
    expect(store.get('cx-theme')).toBe('dark');
  });
});
