import type { ReactNode } from 'react';
import { ConsoleApp } from '@/components/console/shell';
import { THEME_BOOT } from '@/components/console/theme-boot';
import './console.css';

// One console for every route in this group, so tabs and sidebars survive navigation.
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {/* Apply the saved theme before anything paints. */}
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      <ConsoleApp />
      {children}
    </>
  );
}
