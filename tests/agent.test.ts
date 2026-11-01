// The console agent against the mock model, which calls a tool when told "[tool:name {args}]".
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb, openDb, setDb } from '@/lib/db';
import { createServer } from '@/lib/servers';
import { createKey, getKey, listKeys } from '@/lib/keys';
import { listGroups } from '@/lib/groups';
import { createFile, getFile } from '@/lib/context';
import { applyUndo, listChanges, undoPlan } from '@/lib/agent/changes';
import { createChat, listMessages, resolvePending, sendMessage, type AgentEvent } from '@/lib/agent/run';

const PORT = 19000 + Math.floor(Math.random() * 1000);
let mock: ChildProcess;
let chatId = 0;
let serverId = 0;

beforeAll(async () => {
  setDb(openDb(':memory:'));
  mock = spawn(process.execPath, [path.resolve('scripts/mock-vllm.mjs'), String(PORT), 'agent-model'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/v1/models`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  // The server's API key must never reach the model's context.
  serverId = createServer({ name: 'mock', url: `http://127.0.0.1:${PORT}`, apiKey: 'sk-test-SECRET-never-shown', models: [{ name: 'agent-model', contextLen: 8000 }] }).id;
  chatId = createChat('agent-model', serverId).id;
});
afterAll(() => mock?.kill());

const say = async (text: string) => {
  const events: AgentEvent[] = [];
  await sendMessage(chatId, text, (e) => events.push(e));
  return events;
};

describe('console agent', () => {
  it('chats and titles the chat', async () => {
    const ev = await say('hello agent');
    expect(ev.some((e) => e.type === 'token')).toBe(true);
    expect(ev.find((e) => e.type === 'title')).toMatchObject({ title: 'hello agent' });
  });

  it('runs a tool, logs the change, and undoes it', async () => {
    const root = listGroups()[0];
    const ev = await say(`[tool:create_group {"name":"Agents","parentId":${root.id}}]`);
    expect(ev.some((e) => e.type === 'tool' && e.status === 'done')).toBe(true);
    expect(listGroups().some((g) => g.name === 'Agents')).toBe(true);
    const ch = listChanges(chatId).find((c) => c.tbl === 'groups' && c.action === 'created');
    expect(ch?.summary).toContain('Agents');
    applyUndo(chatId, ch!.turn);
    expect(listGroups().some((g) => g.name === 'Agents')).toBe(false);
    expect(listMessages(chatId).filter((m) => m.turn === ch!.turn).every((m) => m.undone === 1)).toBe(true);
  });

  it('edits a context file as a new version, and undo brings the old text back', async () => {
    const f = createFile('style.md', 'Use tabs.');
    await say(`[tool:edit_context_file {"fileId":${f.id},"find":"tabs","replace":"two spaces"}]`);
    expect(getFile(f.id)!.body).toBe('Use two spaces.');
    const turn = listChanges(chatId).filter((c) => c.tbl === 'context_files').at(-1)!.turn;
    applyUndo(chatId, turn);
    expect(getFile(f.id)!.body).toBe('Use tabs.');
    expect(getFile(f.id)!.version).toBe(3);
  });

  it('reports a conflict when someone changed the row since', async () => {
    const root = listGroups()[0];
    await say(`[tool:create_group {"name":"Temp","parentId":${root.id}}]`);
    const c = listChanges(chatId).filter((x) => x.tbl === 'groups' && !x.undone_at).at(-1)!;
    getDb().prepare('UPDATE groups SET description = ? WHERE id = ?').run('edited by a person', Number(c.row_id));
    expect(undoPlan(chatId, c.turn)[0].conflict).toBe(true);
    const r = applyUndo(chatId, c.turn);
    expect(r.skipped).toHaveLength(1);
    expect(listGroups().some((g) => g.name === 'Temp')).toBe(true);
  });

  it('asks before destructive actions and only runs after confirming', async () => {
    const k = createKey({ name: 'bot', owner: 'ci', groupId: listGroups()[0].id }).key;
    const ev = await say(`[tool:revoke_key {"keyId":${k.id}}]`);
    const confirm = ev.flatMap((e) => (e.type === 'ui' ? e.components : [])).find((c) => c.kind === 'confirm');
    expect(confirm).toBeTruthy();
    expect(getKey(k.id)!.revoked).toBe(false);
    await resolvePending(chatId, (confirm as { pending: string }).pending, true, () => {});
    expect(getKey(k.id)!.revoked).toBe(true);
  });

  it('never puts secrets in the model context or the change log', async () => {
    // A write tool that returns the whole key row (prefix included) must not leak it either.
    const victim = createKey({ name: 'leak-check', owner: 'o', groupId: listGroups()[0].id });
    const ev = await say(`[tool:revoke_key {"keyId":${victim.key.id},"restore":true}]`);
    expect(JSON.stringify(ev)).not.toContain(victim.secret.slice(0, 13));
    await say('[tool:list_servers_and_models {}]');
    await say(`[tool:create_key {"name":"agent-key","owner":"a","groupId":${listGroups()[0].id}}]`);
    const stored = JSON.stringify(listMessages(chatId)) + JSON.stringify(listChanges(chatId));
    expect(stored).not.toContain('sk-test-SECRET');
    expect(stored).not.toMatch(/(grk|ops)_live_[A-Za-z0-9]{10}/);
    for (const k of listKeys()) expect(stored).not.toContain(k.prefix);
    expect(stored).toContain('secret_reveal');
  });
});
