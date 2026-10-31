import type { ReactNode } from 'react';
import { Splash } from '@/components/console/splash';
import { SPLASH_BOOT } from '@/components/console/theme-boot';

export default function LoginLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: SPLASH_BOOT }} />
      <Splash />
      {children}
    </>
  );
}
