// Line icons drawn on a 24px grid, sized like VS Code codicons.
const P: Record<string, string> = {
  overview: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  guard: 'M12 3l8 3v6c0 4.6-3.4 8.4-8 9-4.6-.6-8-4.4-8-9V6z',
  servers: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  groups: 'M3 6h6l2 2h10v11H3zM7 13h10',
  keys: 'M15 3a6 6 0 1 1-5.4 8.6L3 18v3h3v-2h2v-2h2l1.4-1.4A6 6 0 0 1 15 3zM16.5 7.5h.01',
  context: 'M14 3H6v18h12V7zM14 3v4h4M9 12h6M9 16h6',
  studio: 'M7 4l12 8-12 8zM3 4v16',
  account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1.2-4 4.4-6 8-6s6.8 2 8 6',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  blocked: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.8-4.8',
  newFile: 'M13 3H6v18h12V8zM13 3v5h5M12 11v6M9 14h6',
  newFolder: 'M3 6h6l2 2h10v11H3zM12 11v5M9.5 13.5h5',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  collapse: 'M4 4h16v16H4zM8 12h8',
  tree: 'M4 5h6M8 12h6M8 19h6M6 5v14',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  close: 'M6 6l12 12M18 6L6 18',
  chevron: 'M9 6l6 6-6 6',
  folder: 'M3 6h6l2 2h10v11H3z',
  folderOpen: 'M3 6h6l2 2h9v3M3 6v13h15l3-8H6l-3 8',
  file: 'M14 3H6v18h12V7zM14 3v4h4',
  key: 'M15 3a6 6 0 1 1-5.4 8.6L3 18v3h3v-2h2v-2h2l1.4-1.4A6 6 0 0 1 15 3z',
  preview: 'M3 4h18v16H3zM12 4v16M15 9h3M15 13h3',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
  save: 'M5 3h11l3 3v15H5zM8 3v5h7V3M8 21v-7h8v7',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3',
  plus: 'M12 5v14M5 12h14',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  back: 'M15 6l-6 6 6 6',
  forward: 'M9 6l6 6-6 6',
  sidebarLeft: 'M3 4h18v16H3zM9 4v16',
  sidebarRight: 'M3 4h18v16H3zM15 4v16',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  unlink: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7M4 4l16 16',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4',
  shieldOff: 'M12 3l8 3v6c0 4.6-3.4 8.4-8 9-4.6-.6-8-4.4-8-9V6zM4 4l16 16',
  check: 'M5 12l5 5 9-10',
  filter: 'M3 4h18l-7 8v6l-4 2v-8z',
  braces: 'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1',
  download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  upload: 'M12 21V9M7 14l5-5 5 5M4 3h16',
  copy: 'M9 9h12v12H9zM5 15H3V3h12v2',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  model: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  warning: 'M12 3l10 18H2zM12 10v4M12 17h.01',
};

export type IconName = keyof typeof P;

export function Ico({ n, size = 16, stroke = 1.6 }: { n: IconName; size?: number; stroke?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[n]} />
    </svg>
  );
}
