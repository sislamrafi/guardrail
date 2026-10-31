import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, setDb } from '@/lib/db';
import { addModelByHand, createServer, discover, listModels, rediscover } from '@/lib/servers';

let server: http.Server;
let base = '';
let mainUp = true;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      if (!mainUp) return void res.writeHead(500).end('{}');
      return void res.end(JSON.stringify({ data: [{ id: 'qwen3-coder-30b', max_model_len: 32768 }] }));
    }
    if (req.url === '/v1/moderations/models') return void res.end(JSON.stringify({ data: [{ id: 'omni-moderation-latest' }, { id: 'qwen3-coder-30b' }] }));
    res.writeHead(404).end('{"error":"not found"}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setDb(openDb(':memory:'));
});
afterAll(() => server.close());

describe('discovery', () => {
  it('merges optional listings and notes the ones that are missing', async () => {
    const r = await discover(base);
    expect(r.models.map((m) => m.name).sort()).toEqual(['omni-moderation-latest', 'qwen3-coder-30b']);
    expect(r.models.find((m) => m.name === 'omni-moderation-latest')?.kind).toBe('classifier');
    expect(r.notes).toEqual(['Some optional model listings were unavailable.']);
  });

  it('still works when the main listing fails but another answers', async () => {
    mainUp = false;
    const r = await discover(base);
    expect(r.models.map((m) => m.name)).toContain('omni-moderation-latest');
    expect(r.notes[0]).toMatch(/main/);
    mainUp = true;
  });

  it('fails clearly when nothing answers', async () => {
    await expect(discover('http://127.0.0.1:9')).rejects.toThrow();
  });

  it('keeps models added by hand across rediscovery', async () => {
    const s = createServer({ name: 'or', url: base, models: [{ name: 'qwen3-coder-30b', contextLen: 32768 }] });
    const m = addModelByHand(s.id, 'meta-llama/llama-guard-4-12b');
    expect(m).toMatchObject({ manual: 1, enabled: 0, kind: 'classifier' });
    expect(() => addModelByHand(s.id, 'meta-llama/llama-guard-4-12b')).toThrow(/already/);
    await rediscover(s.id);
    expect(listModels(s.id).find((x) => x.name === 'meta-llama/llama-guard-4-12b')?.present).toBe(1);
  });
});
