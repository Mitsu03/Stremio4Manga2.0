/**
 * Login throttling.
 *
 * Two independent counters, because the two attacks look nothing alike: one
 * address trying many usernames is a scanner, and many addresses trying one
 * username is a credential-stuffing run. A limiter that only counted addresses
 * would wave the second one straight through.
 *
 * Held in memory only. A restart clears the counters, which is fine: a restart
 * is not something an attacker on the far side of the server can provoke.
 */
import type { Config } from '../config.js';

interface Bucket {
  failures: number;
  firstAt: number;
  lockedUntil: number;
}

export class LoginLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #maxFailures: number;
  readonly #windowMs: number;
  readonly #lockoutMs: number;

  constructor(login: Config['login']) {
    this.#maxFailures = login.maxFailures;
    this.#windowMs = login.windowMs;
    this.#lockoutMs = login.lockoutMs;
  }

  #bucket(key: string): Bucket {
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = { failures: 0, firstAt: 0, lockedUntil: 0 };
      this.#buckets.set(key, bucket);
    }
    return bucket;
  }

  /** Milliseconds the caller must wait, or 0 if they may try now. */
  retryAfter(keys: readonly string[]): number {
    const now = Date.now();
    let wait = 0;
    for (const key of keys) {
      const bucket = this.#buckets.get(key);
      if (bucket && bucket.lockedUntil > now) wait = Math.max(wait, bucket.lockedUntil - now);
    }
    return wait;
  }

  recordFailure(keys: readonly string[]): void {
    const now = Date.now();
    for (const key of keys) {
      const bucket = this.#bucket(key);
      // The window slides only when it has fully elapsed: a patient attacker
      // pacing one guess per window still never accumulates, and a person who
      // mistyped twice last week starts clean.
      if (now - bucket.firstAt > this.#windowMs) {
        bucket.failures = 0;
        bucket.firstAt = now;
      }
      bucket.failures += 1;
      if (bucket.failures >= this.#maxFailures) {
        // Back off harder each time the lockout is re-earned, capped so a
        // locked-out account is never permanently unreachable by its real owner.
        const streak = Math.min(bucket.failures - this.#maxFailures, 5);
        bucket.lockedUntil = now + this.#lockoutMs * 2 ** streak;
      }
    }
  }

  recordSuccess(keys: readonly string[]): void {
    for (const key of keys) this.#buckets.delete(key);
  }

  sweep(): void {
    const now = Date.now();
    for (const [key, bucket] of this.#buckets) {
      if (bucket.lockedUntil < now && now - bucket.firstAt > this.#windowMs) {
        this.#buckets.delete(key);
      }
    }
  }
}
