import fs from 'node:fs';
import path from 'node:path';

/** One mark on the design board: a pin (no size) or an area (with size). Positions are % of the board. */
export interface BoardNote {
  id: string;
  /** Which picture the note sits on: public/designer/<board>.png */
  board: string;
  n: number;
  x: number;
  y: number;
  w?: number;
  h?: number;
  region: string;
  text: string;
  done: boolean;
  created_at: number;
  updated_at: number;
}

const MAX_NOTES = 500;
const MAX_TEXT = 4000;

export function boardNotesFile() {
  return process.env.GUARDRAIL_BOARD_NOTES || path.join(process.cwd(), 'data', 'board-notes.json');
}

const pct = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0);

function clean(raw: unknown, i: number): BoardNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && /^[\w-]{1,40}$/.test(r.id) ? r.id : null;
  if (!id) return null;
  const note: BoardNote = {
    id,
    board: typeof r.board === 'string' && /^[\w-]{1,40}$/.test(r.board) ? r.board : 'reference',
    n: typeof r.n === 'number' && r.n > 0 ? Math.floor(r.n) : i + 1,
    x: pct(r.x),
    y: pct(r.y),
    region: typeof r.region === 'string' ? r.region.slice(0, 80) : '',
    text: typeof r.text === 'string' ? r.text.slice(0, MAX_TEXT) : '',
    done: r.done === true,
    created_at: typeof r.created_at === 'number' ? r.created_at : Date.now(),
    updated_at: typeof r.updated_at === 'number' ? r.updated_at : Date.now(),
  };
  if (typeof r.w === 'number' && typeof r.h === 'number' && r.w > 0 && r.h > 0) {
    note.w = pct(r.w);
    note.h = pct(r.h);
  }
  return note;
}

export function readBoardNotes(): BoardNote[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(boardNotesFile(), 'utf8')) as { notes?: unknown[] };
    return (parsed.notes ?? []).map(clean).filter((n): n is BoardNote => !!n);
  } catch {
    return [];
  }
}

export function writeBoardNotes(notes: unknown): BoardNote[] {
  if (!Array.isArray(notes)) throw new Error('notes must be a list.');
  if (notes.length > MAX_NOTES) throw new Error(`At most ${MAX_NOTES} notes.`);
  const cleaned = notes.map(clean).filter((n): n is BoardNote => !!n);
  const file = boardNotesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, saved_at: new Date().toISOString(), notes: cleaned }, null, 2));
  fs.renameSync(tmp, file);
  return cleaned;
}
