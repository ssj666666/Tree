import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Admin password hashing for Tree's single-admin login.
 *
 * No new dependency: Node's built-in scrypt (N=16384, r=8, p=1, 64-byte key).
 * Stored format: `scrypt$<salt hex>$<hash hex>`. Only the hash goes into the
 * environment variable TREE_ADMIN_PASSWORD_HASH; the plain password is never
 * stored anywhere.
 */
const PREFIX = 'scrypt';
const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN, { N: 16384, r: 8, p: 1 });
  return `${PREFIX}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== PREFIX) return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (salt.length !== 16 || expected.length !== KEY_LEN) return false;
    const actual = scryptSync(password, salt, KEY_LEN, { N: 16384, r: 8, p: 1 });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
