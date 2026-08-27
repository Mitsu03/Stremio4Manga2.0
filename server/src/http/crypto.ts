/**
 * Password hashing and the constant-time comparisons the front door depends on.
 *
 * scrypt rather than a bare hash because the threat is an offline attack on a
 * stolen database file, and scrypt is the strongest password KDF Node ships
 * without a dependency. Nothing in this module imports anything outside `node:`
 * on purpose: it is the one piece that stands between the open internet and
 * every account's library, and a supply chain is a poor thing to put there.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * N=2^15 costs ~32 MiB and ~100 ms per hash on a modern core. That is a
 * deliberate ceiling: the login path is rate limited to single digits per
 * minute, so the cost is invisible to a real person and ruinous to someone
 * grinding a stolen hash.
 */
const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 32;

// 128 * N * r is 32 MiB exactly, which is also Node's default ceiling — asking
// for exactly the default makes scrypt throw. Give it room rather than dropping
// the cost parameter.
const MAX_MEM = 96 * 1024 * 1024;

interface Cost {
  N: number;
  r: number;
  p: number;
}

function derive(password: string, salt: Buffer, keyLength: number, cost: Cost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      keyLength,
      { ...cost, maxmem: MAX_MEM },
      (error, key) => {
        if (error) reject(error);
        else resolve(key as Buffer);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, KEY_LENGTH, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a row somebody has
 * hand-edited into nonsense must fail the login, not crash the server and take
 * everyone else's session with it.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    if (salt.length === 0 || expected.length === 0) return false;

    const actual = await derive(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * A hash of a password nobody holds, used to spend the same ~100 ms on an
 * unknown username as on a known one. Without it, the response time tells an
 * attacker which usernames exist.
 */
export const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${randomBytes(SALT_LENGTH).toString(
  'base64',
)}$${randomBytes(KEY_LENGTH).toString('base64')}`;

/** A URL-safe opaque token. 32 bytes: far past guessing, short enough for a cookie. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Compare two strings without leaking where they diverge. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
