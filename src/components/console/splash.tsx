'use client';

import { useEffect, useState } from 'react';
import { Logo } from '@/components/logo';
import '@/app/splash.css';

/** Show the splash now (Settings' preview), for a random 5–10 s. */
export function previewSplash() {
  const d = document.documentElement;
  const total = 5000 + Math.floor(Math.random() * 5001);
  d.removeAttribute('data-cx-splash-out');
  d.style.setProperty('--cx-splash-ms', `${total}ms`);
  d.setAttribute('data-cx-splash', String(total));
  window.dispatchEvent(new Event('cx-splash'));
}

/** The branded loading screen. Hidden unless the boot script (SPLASH_BOOT) or a preview marked this load for it. */
export function Splash() {
  const [run, setRun] = useState(0);
  useEffect(() => {
    const again = () => setRun((r) => r + 1);
    window.addEventListener('cx-splash', again);
    return () => window.removeEventListener('cx-splash', again);
  }, []);
  useEffect(() => {
    const d = document.documentElement;
    const total = Number(d.getAttribute('data-cx-splash'));
    if (!total) return;
    const fade = setTimeout(() => d.setAttribute('data-cx-splash-out', ''), total - 500);
    const done = setTimeout(() => {
      d.removeAttribute('data-cx-splash');
      d.removeAttribute('data-cx-splash-out');
    }, total);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [run]);
  return (
    <div key={run} className="cx-splash" role="status" aria-label="Loading Opsara AI">
      <div className="cx-splash-mark">
        <span className="cx-splash-glow" />
        <Logo size={96} />
      </div>
      <div className="cx-splash-name">Opsara AI</div>
      <div className="cx-splash-tag">Security gateway for agentic coding</div>
      <div className="cx-splash-bar">
        <i />
      </div>
    </div>
  );
}
