/**
 * The `tracker_credential` table, one row per account per tracker.
 *
 * The access token lives here and nowhere else. `TrackerType` has no field for
 * it on purpose: the browser starts the OAuth flow and hands the callback URL
 * back, but the token itself is extracted server-side and never leaves — a
 * token in a GraphQL response would end up in every client-side cache the UI
 * keeps, and in the urql devtools of anyone who opens them.
 *
 * The profile columns (`remote_user`, `display_name`, `avatar_url`,
 * `score_type`) are a cache of the tracker's own answer, filled the first time
 * `TrackerType.user` is asked for. They are cache, not truth: when AniList is
 * unreachable the resolver returns whatever is here, or null, and does not
 * fail the query.
 */
import type { Db } from '../db/open.js';

export interface TrackerCredential {
  trackerId: number;
  accessToken: string;
  /** Epoch milliseconds; 0 means "no expiry was reported". */
  expiresAt: number;
  /** The tracker's own numeric account id, as text. */
  remoteUser: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  /** AniList's scoreFormat, so a score can be shown in the account's units. */
  scoreType: string | null;
}

/** The half of a credential that comes from the tracker rather than OAuth. */
export interface TrackerProfile {
  remoteUser: string;
  displayName: string;
  avatarUrl: string | null;
  scoreType: string | null;
}

interface CredentialRow {
  tracker_id: number;
  access_token: string;
  expires_at: number;
  remote_user: string | null;
  display_name: string | null;
  avatar_url: string | null;
  score_type: string | null;
}

function fromRow(row: CredentialRow): TrackerCredential {
  return {
    trackerId: row.tracker_id,
    accessToken: row.access_token,
    expiresAt: row.expires_at,
    remoteUser: row.remote_user,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    scoreType: row.score_type,
  };
}

export function readCredential(
  db: Db,
  userId: string,
  trackerId: number,
): TrackerCredential | null {
  const row = db.get<CredentialRow>(
    `SELECT tracker_id, access_token, expires_at, remote_user, display_name, avatar_url, score_type
       FROM tracker_credential
      WHERE user_id = ? AND tracker_id = ?`,
    userId,
    trackerId,
  );
  return row ? fromRow(row) : null;
}

/**
 * Store a freshly obtained token.
 *
 * Signing in again replaces the token and its expiry but keeps whatever profile
 * is already cached, so the Settings banner does not blank out between the
 * login mutation and the next `user` resolution.
 */
export function saveCredential(
  db: Db,
  userId: string,
  trackerId: number,
  token: string,
  expiresAt: number,
): void {
  db.run(
    `INSERT INTO tracker_credential (user_id, tracker_id, access_token, expires_at)
          VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, tracker_id)
       DO UPDATE SET access_token = excluded.access_token,
                     expires_at   = excluded.expires_at`,
    userId,
    trackerId,
    token,
    expiresAt,
  );
}

/** Cache what the tracker says about the account. Never creates a row. */
export function saveProfile(
  db: Db,
  userId: string,
  trackerId: number,
  profile: TrackerProfile,
): void {
  db.run(
    `UPDATE tracker_credential
        SET remote_user = ?, display_name = ?, avatar_url = ?, score_type = ?
      WHERE user_id = ? AND tracker_id = ?`,
    profile.remoteUser,
    profile.displayName,
    profile.avatarUrl,
    profile.scoreType,
    userId,
    trackerId,
  );
}

export function deleteCredential(db: Db, userId: string, trackerId: number): void {
  db.run('DELETE FROM tracker_credential WHERE user_id = ? AND tracker_id = ?', userId, trackerId);
}

/**
 * An expiry of 0 means the tracker never said, which is not the same as expired
 * — treating it as expired would sign everyone out of a working connection.
 */
export function isExpired(
  credential: TrackerCredential | null,
  now: number = Date.now(),
): boolean {
  if (!credential) return false;
  return credential.expiresAt > 0 && credential.expiresAt <= now;
}

export class NotLoggedInError extends Error {
  constructor(trackerId: number) {
    super(`Not signed in to tracker ${trackerId}.`);
    this.name = 'NotLoggedInError';
  }
}

/**
 * The credential every remote call needs, or a refusal.
 *
 * An expired token is refused here rather than sent: AniList would answer 401
 * and the reader would see "AniList rejected the access token" for what is
 * really "sign in again", which the UI already has a button for.
 */
export function requireCredential(
  db: Db,
  userId: string,
  trackerId: number,
): TrackerCredential {
  const credential = readCredential(db, userId, trackerId);
  if (!credential || isExpired(credential)) throw new NotLoggedInError(trackerId);
  return credential;
}
