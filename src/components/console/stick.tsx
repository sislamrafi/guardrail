'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Ico } from './icons';

/**
 * Keep a scroll box at the bottom while its content grows (streamed text, live steps, Markdown
 * re-rendering), as long as the viewer is at or near the bottom. Scrolling up stops following and
 * marks new output as unseen; jump() goes back down and follows again.
 */
export function useStickToBottom<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const following = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const toBottom = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  const jump = useCallback(() => {
    following.current = true;
    setUnseen(false);
    requestAnimationFrame(toBottom);
  }, [toBottom]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (following.current) setUnseen(false);
    };
    const grew = () => {
      if (following.current) requestAnimationFrame(toBottom);
      else setUnseen(true);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(grew);
    for (const c of Array.from(el.children)) ro.observe(c);
    const mo = new MutationObserver(() => {
      for (const c of Array.from(el.children)) ro.observe(c);
      grew();
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    toBottom();
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      mo.disconnect();
    };
  }, [toBottom]);
  return { ref, unseen, jump };
}

/** "↓ New output": shown while new content arrived below what the viewer is reading. */
export function NewOutput({ show, onClick }: { show: boolean; onClick: () => void }) {
  if (!show) return null;
  return (
    <button type="button" className="cx-newout" onClick={onClick}>
      <Ico n="chevron" size={12} /> New output
    </button>
  );
}
