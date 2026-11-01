// Runs Next.js behind a tiny HTTP server that records the real peer address.
// Route handlers can't see the socket, and clients can set X-Forwarded-For themselves,
// so the address that actually connected goes in x-guardrail-peer (any client value is replaced).
// Usage: node server.mjs [--dev] [-p 3000]
import { createServer } from 'node:http';
import next from 'next';

const args = process.argv.slice(2);
const dev = args.includes('--dev');
const pi = args.indexOf('-p');
const port = Number(pi >= 0 ? args[pi + 1] : process.env.PORT || 3000);
const hostname = process.env.HOSTNAME || '0.0.0.0';

const app = next({ dev, port, hostname: 'localhost' });
const handle = app.getRequestHandler();
await app.prepare();
const upgrade = app.getUpgradeHandler?.();

const server = createServer((req, res) => {
  req.headers['x-guardrail-peer'] = req.socket.remoteAddress ?? '';
  handle(req, res);
});
if (upgrade) server.on('upgrade', (req, socket, head) => upgrade(req, socket, head));
server.listen(port, hostname, () => {
  console.log(`  ▲ Opsara ${dev ? 'dev' : 'production'} server on http://localhost:${port} (listening on ${hostname})`);
});
