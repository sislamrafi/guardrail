import { describe, expect, it } from 'vitest';
import { checkIpRule, clientIp, ipAllowed, parseIpList } from '@/lib/ip';

describe('IP allow-lists', () => {
  it('matches single addresses and IPv4 ranges', () => {
    expect(ipAllowed('10.1.2.3', [])).toBe(true);
    expect(ipAllowed('10.1.2.3', ['10.1.2.3'])).toBe(true);
    expect(ipAllowed('10.1.2.4', ['10.1.2.3'])).toBe(false);
    expect(ipAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
    expect(ipAllowed('192.168.1.77', ['192.168.1.64/26'])).toBe(true);
    expect(ipAllowed('192.168.1.130', ['192.168.1.64/26'])).toBe(false);
    expect(ipAllowed(null, ['10.0.0.0/8'])).toBe(false);
  });

  it('treats IPv4-mapped IPv6 as IPv4 and handles IPv6 ranges', () => {
    expect(ipAllowed('::ffff:10.0.0.9', ['10.0.0.0/24'])).toBe(true);
    expect(ipAllowed('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(ipAllowed('2001:db9::1', ['2001:db8::/32'])).toBe(false);
    expect(ipAllowed('::1', ['::1'])).toBe(true);
    expect(ipAllowed('10.0.0.1', ['2001:db8::/32'])).toBe(false);
  });

  it('validates entries', () => {
    expect(checkIpRule('10.0.0.0/8')).toBeNull();
    expect(checkIpRule('10.0.0.0/33')).toMatch(/prefix/);
    expect(checkIpRule('banana')).toMatch(/not an IP/);
    expect(parseIpList('10.0.0.1, 10.0.0.0/8\n10.0.0.1')).toEqual(['10.0.0.1', '10.0.0.0/8']);
    expect(() => parseIpList('10.0.0.1, nope')).toThrow(/not an IP/);
  });

  it('uses the socket address from server.mjs unless a proxy is trusted', () => {
    const h = new Headers({ 'x-forwarded-for': '10.0.0.1', 'x-guardrail-peer': '::ffff:198.51.100.7' });
    expect(clientIp(h, false)).toBe('198.51.100.7');
    expect(clientIp(h, true)).toBe('10.0.0.1');
  });

  it('reads the caller from X-Forwarded-For, trusting the first entry only behind a trusted proxy', () => {
    const h = new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.2' });
    expect(clientIp(h, false)).toBe('10.0.0.2');
    expect(clientIp(h, true)).toBe('203.0.113.9');
    expect(clientIp(new Headers({ 'x-real-ip': '1.2.3.4' }), false)).toBeNull();
    expect(clientIp(new Headers({ 'x-real-ip': '1.2.3.4' }), true)).toBe('1.2.3.4');
  });
});
