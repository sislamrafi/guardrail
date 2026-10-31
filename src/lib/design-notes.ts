import fs from 'fs';
import path from 'path';

// Pins and boxes dropped on the /workbench mockup. Kept as a tracked JSON file in the repo
// so the design conversation (and Claude) can read them back.
const FILE = path.join(process.cwd(), 'design', 'workbench-notes.json');

export interface DesignNote {
  id: string;
  n: number;
  /** Which board the mark sits on: the live shell or the reference screenshot. */
  board?: 'shell' | 'screenshot';
  kind: 'pin' | 'box';
  /** Percent of the workbench viewport, so marks survive window resizes. */
  x: number;
  y: number;
  w?: number;
  h?: number;
  zone: string;
  text: string;
  done?: boolean;
  createdAt: number;
}

export function readNotes(): DesignNote[] {
  try {
    const v = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function writeNotes(notes: unknown): DesignNote[] {
  if (!Array.isArray(notes)) throw new Error('Notes must be a list.');
  const clean: DesignNote[] = notes.map((n: Partial<DesignNote>, i) => ({
    id: String(n.id ?? `${Date.now()}-${i}`),
    n: Number(n.n) || i + 1,
    board: n.board === 'screenshot' ? 'screenshot' : 'shell',
    kind: n.kind === 'box' ? 'box' : 'pin',
    x: Number(n.x) || 0,
    y: Number(n.y) || 0,
    ...(n.kind === 'box' ? { w: Number(n.w) || 0, h: Number(n.h) || 0 } : {}),
    zone: String(n.zone ?? ''),
    text: String(n.text ?? '').slice(0, 4000),
    ...(n.done ? { done: true } : {}),
    createdAt: Number(n.createdAt) || Date.now(),
  }));
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}
