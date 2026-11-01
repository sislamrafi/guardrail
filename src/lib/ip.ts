// Client addresses and per-key IP allow-lists (single IPs and CIDR ranges, IPv4 and IPv6).
import net from 'node:net';

/** "::ffff:10.0.0.5" and "10.0.0.5" are the same caller. */
export function normalizeIp(ip: string): string {
  const t = ip.trim().replace(/^\[|\]$/g, '');
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(t);
  return m ? m[1] : t.toLowerCase();
}

/**
 * The caller's address. server.mjs puts the socket address in x-guardrail-peer, replacing anything
 * a client sent, so that is the default. Only with `trustProxy` on (GuardRail behind your own
 * reverse proxy) do we believe X-Forwarded-For's first entry, which the proxy reports as the client.
 * Without server.mjs (plain `next dev`) we fall back to X-Forwarded-For's last entry.
 */
export function clientIp(headers: Headers, trustProxy: boolean): string | null {
  const peer = headers.get('x-guardrail-peer');
  if (!trustProxy && peer) return normalizeIp(peer);
  const list = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length) return normalizeIp(trustProxy ? list[0] : list[list.length - 1]);
  const real = trustProxy ? headers.get('x-real-ip') : null;
  return real ? normalizeIp(real) : null;
}

function toBigInt(ip: string): { v: bigint; bits: number } | null {
  if (net.isIPv4(ip)) return { v: ip.split('.').reduce((a, p) => (a << 8n) + BigInt(Number(p)), 0n), bits: 32 };
  if (!net.isIPv6(ip)) return null;
  // Expand "::" and read the eight 16-bit groups.
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = ip.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8) return null;
  return { v: groups.reduce((a, g) => (a << 16n) + BigInt(parseInt(g || '0', 16)), 0n), bits: 128 };
}

/** One allow-list entry: an IP or a CIDR range. Returns an error message for bad input. */
export function checkIpRule(rule: string): string | null {
  const [addr, len, extra] = rule.trim().split('/');
  if (extra !== undefined) return `"${rule}" is not an IP or CIDR range.`;
  const p = toBigInt(normalizeIp(addr ?? ''));
  if (!p) return `"${rule}" is not an IP or CIDR range.`;
  if (len !== undefined && (!/^\d+$/.test(len) || Number(len) > p.bits)) return `"${rule}" has an invalid prefix length.`;
  return null;
}

/** Split and validate a comma, space or newline separated allow-list. Empty means "any address". */
export function parseIpList(input: unknown): string[] {
  const parts = (Array.isArray(input) ? input.map(String) : String(input ?? '').split(/[\s,]+/)).map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    const err = checkIpRule(p);
    if (err) throw new Error(err);
  }
  return [...new Set(parts)];
}

export function ipAllowed(ip: string | null, rules: string[]): boolean {
  if (!rules.length) return true;
  if (!ip) return false;
  const a = toBigInt(normalizeIp(ip));
  if (!a) return false;
  return rules.some((rule) => {
    const [addr, len] = rule.split('/');
    const r = toBigInt(normalizeIp(addr));
    if (!r || r.bits !== a.bits) return false;
    const n = len === undefined ? r.bits : Number(len);
    const shift = BigInt(r.bits - n);
    return a.v >> shift === r.v >> shift;
  });
}
