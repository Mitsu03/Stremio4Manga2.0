/**
 * The one place `last_read_at` is written.
 *
 * The reader PATCHes a page number as the reader moves through a chapter, and
 * `read=true` on the last page. That is the only signal in the whole server that
 * means "somebody was reading this, just now" — `updateChapters(isRead:)` is a
 * bulk edit and deliberately leaves the stamp alone — so the continue-reading
 * shelf, which orders on it, exists entirely because of this file.
 *
 * The tracker is told from here too, and only from here, for the same reason:
 * progress pushed to AniList should mean a chapter was actually read to the end,
 * not that a checkbox was ticked over a backlog.
 */
import type { Db } from '../db/open.js';
import type { Logger } from '../types.js';
import { reportProgress } from '../tracker/records.js';
import { locateBySourceOrder } from './pages.js';

export interface ProgressDeps {
  db: Db;
  log: Logger;
}

export interface ProgressUpdate {
  lastPageRead?: number;
  read?: boolean;
}

/**
 * Record a reader's position in one chapter.
 *
 * Returns false when the chapter is not this account's — the caller turns that
 * into a 404, because whether somebody else's chapter exists is not something
 * this account is entitled to learn.
 */
export function recordProgress(
  deps: ProgressDeps,
  userId: string,
  mangaId: number,
  sourceOrder: number,
  update: ProgressUpdate,
): boolean {
  const { db, log } = deps;
  const location = locateBySourceOrder(db, userId, mangaId, sourceOrder);
  if (!location) return false;

  const assignments = ['last_read_at = ?'];
  const params: (string | number)[] = [Date.now()];

  if (update.lastPageRead !== undefined && Number.isFinite(update.lastPageRead)) {
    // Set, not raised: the reader scrolls backwards as well, and where they are
    // is the point rather than how far they once got.
    assignments.push('last_page_read = ?');
    params.push(Math.max(0, Math.floor(update.lastPageRead)));
  }
  if (update.read) {
    assignments.push('is_read = 1');
  }

  db.run(
    `UPDATE chapter SET ${assignments.join(', ')} WHERE id = ? AND user_id = ?`,
    ...params,
    location.id,
    userId,
  );

  if (update.read) {
    // Deliberately not awaited: AniList being slow, rate limiting or signed out
    // must not hold up the last page of a chapter. `reportProgress` never
    // throws and never moves a remote count downwards, so the worst case is a
    // number the library's next refresh reconciles.
    void reportProgress(db, userId, mangaId, location.chapterNumber).catch((error: unknown) => {
      log.warn(`tracker report failed for manga ${mangaId}: ${(error as Error).message}`);
    });
  }

  return true;
}
