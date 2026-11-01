import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, openDb, setDb } from '@/lib/db';
import { listGroups } from '@/lib/groups';
import { createKey, hashKey, lookupKey, revealKey, rotateKey } from '@/lib/keys';
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

  it('issues new keys with the Opsara prefix and still accepts old GuardRail keys', () => {
    const root = listGroups()[0];
    const { secret } = createKey({ name: 'new', owner: 'o', groupId: root.id });
    expect(secret.startsWith('ops_live_')).toBe(true);
    // A key issued before the rename: lookup is by hash, so its prefix doesn't matter.
    const old = 'grk_live_' + 'A'.repeat(32);
    getDb().prepare("INSERT INTO api_keys (name, owner, group_id, prefix, hash, exceptions, created_at) VALUES ('old', 'o', ?, ?, ?, '{}', 0)").run(root.id, old.slice(0, 13), hashKey(old));
    expect(lookupKey(old).ok).toBe(true);
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
