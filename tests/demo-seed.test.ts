import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDb, setDb } from '@/lib/db';
import { seedDemo } from '@/lib/demo-seed';
import { getLog } from '@/lib/logs';
import { getSettings } from '@/lib/settings';

beforeAll(() => {
  process.env.GUARDRAIL_PROMPTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-demo-'));
  setDb(openDb(':memory:'));
});

describe('demo seed', () => {
  it('fills every area and can run twice without duplicates', () => {
    const first = seedDemo({ logs: 60 });
    expect(first.groups).toBeGreaterThanOrEqual(9);
    expect(first.files).toBe(12);
    expect(first.keys).toBe(15);
    expect(first.scenarios).toBe(5);
    expect(first.logs).toBe(60);
    expect(getSettings().guard.layers.map((l) => l.id)).toEqual(['secrets', 'piguard', 'judge', 'tools']);
    const second = seedDemo({ logs: 60 });
    expect(second).toEqual(first);
  });

  it('writes full sessions with prompts and layer decisions', () => {
    const l = getLog('req_demo0001')!;
    expect(l.prompt?.length).toBeGreaterThan(2);
    expect(l.decisions?.length).toBeGreaterThan(0);
  });
});
