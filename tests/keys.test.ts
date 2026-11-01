import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, openDb, setDb } from '@/lib/db';
import { listGroups } from '@/lib/groups';
import { createKey, lookupKey, revealKey, rotateKey } from '@/lib/keys';
import { open, seal } from '@/lib/secret-box';

beforeAll(() => setDb(openDb(':memory:')));

describe('key secrets at rest', () => {
  it('seals and opens, and refuses tampered boxes', () => {
    const box = seal('grk_live_abc');
    expect(box.startsWith('v1.')).toBe(true);
    expect(box).not.toContain('grk_live_abc');
    expect(open(box)).toBe('grk_live_abc');
    expect(open(box.slice(0, -2) + 'AA')).toBeNull();
    expect(open('nonsense')).toBeNull();
    expect(open(null)).toBeNull();
  });

  it('cannot be opened with another master secret', () => {
    const box = seal('grk_live_abc');
    const before = process.env.GUARDRAIL_KEY_SECRET;
    process.env.GUARDRAIL_KEY_SECRET = 'a-different-secret';
    expect(open(box)).toBeNull();
    if (before === undefined) delete process.env.GUARDRAIL_KEY_SECRET;
    else process.env.GUARDRAIL_KEY_SECRET = before;
  });

  it('reveals a new key and rotates it', () => {
    const root = listGroups()[0];
    const { key, secret } = createKey({ name: 'k', owner: 'o', groupId: root.id });
    expect(key.canReveal).toBe(true);
    expect(revealKey(key.id)).toBe(secret);
    const r = rotateKey(key.id);
    expect(r.secret).not.toBe(secret);
    expect(revealKey(key.id)).toBe(r.secret);
    expect(lookupKey(secret).ok).toBe(false);
    expect(lookupKey(r.secret).ok).toBe(true);
  });

  it('reports old hash-only keys as not revealable', () => {
    const root = listGroups()[0];
    const { key } = createKey({ name: 'old', owner: 'o', groupId: root.id });
    getDb().prepare('UPDATE api_keys SET secret_enc = NULL WHERE id = ?').run(key.id);
    expect(revealKey(key.id)).toBeNull();
  });
});
