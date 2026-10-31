// Encrypts API key secrets at rest so an admin can reveal them later.
// AES-256-GCM with a key derived from GUARDRAIL_KEY_SECRET (or GUARDRAIL_SECRET).
// Authentication never uses this: keys are still checked against their SHA-256 hash.
import crypto from 'node:crypto';

const DEFAULT = 'change-me';

function masterSecret(): string {
  return process.env.GUARDRAIL_KEY_SECRET || process.env.GUARDRAIL_SECRET || DEFAULT;
}

/** True when secrets are encrypted with the shipped default and anyone with the source could decrypt them. */
export function weakSecret(): boolean {
  return masterSecret() === DEFAULT;
}

const keyFor = (salt: Buffer) => crypto.hkdfSync('sha256', masterSecret(), salt, 'guardrail api key secret v1', 32);

/** "v1.<salt>.<iv>.<tag>.<ciphertext>", all base64url. */
export function seal(plain: string): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyFor(salt)), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', salt, iv, c.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

/** The secret, or null when the box is missing, malformed or sealed with another master secret. */
export function open(box: string | null | undefined): string | null {
  if (!box) return null;
  const [v, salt, iv, tag, ct] = box.split('.');
  if (v !== 'v1' || !ct) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyFor(Buffer.from(salt, 'base64url'))), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
