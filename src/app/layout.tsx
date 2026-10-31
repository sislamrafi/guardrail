import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'GuardRail AI',
  description: 'Security gateway and admin panel for vLLM backends',
  manifest: '/manifest.webmanifest',
  icons: {
    // Black mark on light browser chrome, white on dark.
    icon: [
      { url: '/brand/guardrail-logo-black-32.png', sizes: '32x32', type: 'image/png', media: '(prefers-color-scheme: light)' },
      { url: '/brand/guardrail-logo-black-64.png', sizes: '64x64', type: 'image/png', media: '(prefers-color-scheme: light)' },
      { url: '/brand/guardrail-logo-white-32.png', sizes: '32x32', type: 'image/png', media: '(prefers-color-scheme: dark)' },
      { url: '/brand/guardrail-logo-white-64.png', sizes: '64x64', type: 'image/png', media: '(prefers-color-scheme: dark)' },
    ],
    apple: [{ url: '/brand/guardrail-logo-black-192.png', sizes: '192x192' }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
