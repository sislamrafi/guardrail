import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '@/components/console/markdown';
import { parsePath, pathFor, subtree } from '@/components/console/paths';

describe('console routes', () => {
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
