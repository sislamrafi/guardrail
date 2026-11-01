'use client';

import { useState } from 'react';
import { renderMarkdown } from './markdown';
import { usePref } from './prefs';

/** Click handler for rendered Markdown: the Copy button on a code block copies its code. */
export function copyCode(e: React.MouseEvent) {
  const b = (e.target as HTMLElement).closest('[data-md-copy]');
  if (!b) return;
  const code = b.parentElement?.querySelector('code')?.textContent ?? '';
  void navigator.clipboard?.writeText(code).then(() => {
    b.textContent = 'Copied';
    setTimeout(() => (b.textContent = 'Copy'), 1200);
  });
}

/** Chats show Markdown rendered unless the viewer chose raw text (Settings › Appearance). */
export const useChatMarkdown = () => usePref('chat.markdown', true);

/**
 * One chat message's text: Markdown rendered by default, with a small Raw / Rendered switch.
 * The renderer escapes HTML first; code blocks get a Copy button.
 */
export function MdText({ text, className = '' }: { text: string; className?: string }) {
  const [global] = useChatMarkdown();
  const [own, setOwn] = useState<boolean | null>(null);
  const rendered = own ?? global;
  // Plain one-liners look the same either way: no switch for them.
  const hasMd = /[*_`#>|~\[]|^\s*([-*]|\d+\.)\s/m.test(text);
  return (
    <div className={`cx-turn-body ${rendered && hasMd ? 'md' : ''} ${className}`}>
      {hasMd && (
        <button type="button" className="cx-md-toggle" title={rendered ? 'Show the raw text' : 'Show it rendered'} onClick={() => setOwn(!rendered)}>
          {rendered ? 'Raw' : 'Rendered'}
        </button>
      )}
      {rendered && hasMd ? (
        <div
          className="cx-chat-md"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
          onClick={copyCode}
        />
      ) : (
        text
      )}
    </div>
  );
}
