/**
 * Server-side sessions.
 *
 * Server-side rather than a self-contained token because logout has to *mean*
 * something here: a session is the key to one person's whole reading history,
 * and a stateless token cannot be revoked before it expires.
 *
 * The table holds a *hash* of each session id, never the id itself. The cookie
 * carries the id, so someone who reads the database off the disk still cannot
 * forge a request with what they find.
 */
import { createHash } from 'node:crypto';

import type { Config } from '../config.js';
import type { Db } from '../db/open.js';
import { randomToken } from './crypto.js';

export const COOKIE_NAME = 's4m_session';

interface SessionRow {
  username: string;
  created_at: number;
  seen_at: number;
}

/**
 * What a live session tells the caller. `createdAt` is part of the answer
 * because expiry is not the only reason to refuse a session: a password changed
 * since it was issued must invalidate it too, and only the caller knows when
 * that happened.
 */
export interface LiveSession {
  username: string;
  createdAt: number;
}

function fingerprint(id: string): string {
  return createHash('sha256').update(id).digest('base64url');
}

export class SessionStore {
  readonly #db: Db;
  readonly #idleMs: number;
  readonly #absoluteMs: number;

  constructor(db: Db, session: Config['session']) {
    this.#db = db;
    this.#idleMs = session.idleMs;
    this.#absoluteMs = session.absoluteMs;
    this.sweep();
  }

  create(username: string): string {
    const id = randomToken();
    const now = Date.now();
    this.#db.run(
      'INSERT INTO sessions (id_hash, username, created_at, seen_at) VALUES (?, ?, ?, ?)',
      fingerprint(id),
      username,
      now,
      now,
    );
    return id;
  }

  /** Slides the idle window forward, or returns null if the session is not valid. */
  touch(id: string | undefined): LiveSession | null {
    if (!id) return null;
    const key = fingerprint(id);
    const row = this.#db.get<SessionRow>(
      'SELECT username, created_at, seen_at FROM sessions WHERE id_hash = ?',
      key,
    );
    if (!row) return null;

    const now = Date.now();
    // Two clocks, on purpose: idle expiry logs out the tablet left on the sofa,
    // absolute expiry puts a hard ceiling on how long a stolen cookie is worth
    // anything.
    if (now - row.seen_at > this.#idleMs || now - row.created_at > this.#absoluteMs) {
      this.#db.run('DELETE FROM sessions WHERE id_hash = ?', key);
      return null;
    }

    this.#db.run('UPDATE sessions SET seen_at = ? WHERE id_hash = ?', now, key);
    return { username: row.username, createdAt: row.created_at };
  }

  destroy(id: string | undefined): void {
    if (!id) return;
    this.#db.run('DELETE FROM sessions WHERE id_hash = ?', fingerprint(id));
  }

  /** Used when an account is removed or its password changes — every device it left signed in drops. */
  destroyAllFor(username: string): number {
    return this.#db.run('DELETE FROM sessions WHERE username = ?', username).changes;
  }

  sweep(): number {
    const now = Date.now();
    return this.#db.run(
      'DELETE FROM sessions WHERE seen_at < ? OR created_at < ?',
      now - this.#idleMs,
      now - this.#absoluteMs,
    ).changes;
  }

  get size(): number {
    return this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')?.n ?? 0;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!header) return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      jar[name] = decodeURIComponent(raw);
    } catch {
      jar[name] = raw;
    }
  }
  return jar;
}

export function sessionCookie(
  id: string,
  options: { secure: boolean; maxAgeSeconds: number },
): string {
  const bits = [
    `${COOKIE_NAME}=${id}`,
    'Path=/',
    'HttpOnly',
    // Lax, not Strict, and this is load-bearing: AniList finishes its OAuth flow
    // by sending the browser to /handle/oauth/result as a top-level navigation
    // from anilist.co. Strict would withhold the cookie on exactly that hop, and
    // the callback would land signed out.
    'SameSite=Lax',
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearedCookie(options: { secure: boolean }): string {
  const bits = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (options.secure) bits.push('Secure');
  return bits.join('; ');
}
