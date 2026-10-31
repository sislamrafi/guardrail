import type { ReactNode } from 'react';
import { ConsoleApp } from '@/components/console/shell';
import './console.css';

// One console for every route in this group, so tabs and sidebars survive navigation.
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ConsoleApp />
      {children}
    </>
  );
}
