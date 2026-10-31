// Line icons in the spirit of VS Code's codicons, drawn on a 24px grid.

const P: Record<string, React.ReactNode> = {
  overview: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
      <rect x="13.5" y="3.5" width="7" height="4" rx="1" />
      <rect x="13.5" y="10.5" width="7" height="10" rx="1" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1" />
    </>
  ),
  activity: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
  guard: (
    <>
      <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z" />
      <path d="M9 12l2.2 2.2L15.5 10" />
    </>
  ),
  servers: (
    <>
      <rect x="3.5" y="4" width="17" height="6.5" rx="1.2" />
      <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.2" />
      <path d="M7 7.25h.01M7 16.75h.01M11 7.25h6M11 16.75h6" />
    </>
  ),
  groups: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8" />
      <circle cx="17" cy="9" r="2.3" />
      <path d="M15.8 14.3c2.3.1 4 1.6 4.7 4.2" />
    </>
  ),
  keys: (
    <>
      <circle cx="8" cy="15" r="4.5" />
      <path d="M11.3 11.7L20 3M16.5 6.5l2.5 2.5M14 9l2 2" />
    </>
  ),
  context: (
    <>
      <path d="M6 3h8l4.5 4.5V21H6z" />
      <path d="M14 3v4.5h4.5M9 12h6M9 15.5h6" />
    </>
  ),
  studio: (
    <>
      <path d="M8 6.5L5 5M16 6.5L19 5M4 12h3M17 12h3M5 19l3-1.5M19 19l-3-1.5" />
      <path d="M8 9a4 4 0 018 0v5a4 4 0 01-8 0z" />
      <path d="M12 10v8" />
    </>
  ),
  account: (
    <>
      <circle cx="12" cy="9" r="3.6" />
      <path d="M5 20c.9-3.6 3.7-5.6 7-5.6s6.1 2 7 5.6" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2L5.5 5.5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5.5 5.5" />
    </>
  ),
  block: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 6l12 12" />
    </>
  ),
  chevron: <path d="M9 6l6 6-6 6" />,
  folder: <path d="M3.5 6.5a1 1 0 011-1h5l2 2h8a1 1 0 011 1v9a1 1 0 01-1 1h-15a1 1 0 01-1-1z" />,
  folderOpen: <path d="M3.5 18.5v-12a1 1 0 011-1h5l2 2h7a1 1 0 011 1v2M3.5 18.5l2.6-7.3a1 1 0 01.9-.7h14l-2.7 8z" />,
  file: (
    <>
      <path d="M6.5 3.5h7l4 4v13h-11z" />
      <path d="M13.5 3.5v4h4" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="3.5" />
      <path d="M10.5 12.5L18 5M15.5 7.5l2 2" />
    </>
  ),
  newFile: (
    <>
      <path d="M13.5 3.5h-7v17h11v-13l-4-4zM13.5 3.5v4h4" />
      <path d="M12 11v6M9 14h6" />
    </>
  ),
  newFolder: (
    <>
      <path d="M3.5 6.5a1 1 0 011-1h5l2 2h8a1 1 0 011 1v9a1 1 0 01-1 1h-15a1 1 0 01-1-1z" />
      <path d="M12 10.5v5M9.5 13h5" />
    </>
  ),
  listTree: <path d="M4 5h6M7 5v12h4M7 11h4M14 11h6M14 17h6M14 5h6" />,
  listFlat: <path d="M4 6h16M4 12h16M4 18h16" />,
  refresh: <path d="M19 8a7.5 7.5 0 10.6 6M19.5 3.5V8H15" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  trash: <path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13M10.5 10.5v6M13.5 10.5v6" />,
  preview: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  code: <path d="M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5" />,
  layoutLeft: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M9 4.5v15" />
    </>
  ),
  layoutRight: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M15 4.5v15" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="4" />,
  link: <path d="M10 14l4-4M8.5 11.5l-2 2a3 3 0 004.2 4.2l2-2M15.5 12.5l2-2a3 3 0 00-4.2-4.2l-2 2" />,
};

export type IconName = keyof typeof P;

export function Ico({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {P[name]}
    </svg>
  );
}
