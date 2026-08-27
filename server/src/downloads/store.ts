/**
 * Every read and write of `download_queue`, in one place.
 *
 * Two rules hold throughout and are the reason this is a module rather than a
 * handful of statements inside the resolvers:
 *
 *   * **Every statement filters on `user_id`.** The queue is one table for the
 *     whole server, so a missing filter is not a bug that shows the wrong row —
 *     it is one account reordering another's downloads.
 *   * **`position` is a dense 0-based sequence per account**, because that is
 *     what `reorderChapterDownload.to` indexes. Anything that removes or moves a
 *     row renumbers the rest inside the same transaction, so a reader can never
 *     observe a gap and mistake it for a position.
 *
 * A finished chapter leaves the queue entirely; what survives is
 * `chapter.is_downloaded`. That is the old server's behaviour and the UI is
 * built on it — the Downloads screen asks a second query for what is on disk
 * precisely because a chapter vanishes from here the moment it lands.
 */
import type { Config } from '../config.js';
import type { Db } from '../db/open.js';
import { chapterLocation, removeChapterFiles } from './paths.js';
import { downloaderState, type DownloaderState } from './state.js';

// The queue carries whole ChapterType and MangaType objects, and there is
// exactly one right way to build each. Importing them keeps a second, subtly
// different mapping from existing.
import { MANGA_COLUMNS, mapManga } from '../graphql/resolvers/library.js';
import { CHAPTER_COLUMNS, mapChapter } from '../graphql/resolvers/chapter.js';

export type DownloadState = 'QUEUED' | 'DOWNLOADING' | 'FINISHED' | 'ERROR';

export interface QueueRow {
  id: number;
  user_id: string;
  chapter_id: number;
  position: number;
  state: DownloadState;
  progress: number;
  tries: number;
  error: string | null;
  enqueued_at: number;
}

/** One entry as `DownloadType` wants it. */
export interface DownloadItem {
  chapter: unknown;
  manga: unknown;
  position: number;
  progress: number;
  state: DownloadState;
  tries: number;
}

export interface DownloadStatus {
  state: DownloaderState;
  queue: DownloadItem[];
}

const QUEUE_COLUMNS =
  'id, user_id, chapter_id, position, state, progress, tries, error, enqueued_at';

const placeholders = (count: number): string =>
  Array.from({ length: count }, () => '?').join(', ');

/** Whole numbers only: an id arrives from the client and indexes nothing else. */
const ids = (raw: readonly number[]): number[] =>
  [...new Set(raw)].filter((id) => Number.isInteger(id) && id > 0);

/**
 * Rewrites `position` as 0, 1, 2 … in the order the rows already have.
 *
 * Always called inside a transaction by its callers; on its own it would leave
 * the queue readable mid-renumber, which is the one moment two rows can share a
 * position.
 */
function renumber(db: Db, userId: string): void {
  const rows = db.all<{ id: number }>(
    'SELECT id FROM download_queue WHERE user_id = ? ORDER BY position, id',
    userId,
  );
  rows.forEach((row, index) => {
    db.run('UPDATE download_queue SET position = ? WHERE id = ?', index, row.id);
  });
}

/**
 * Appends chapters to the end of the account's queue.
 *
 * Silently skips three things rather than failing the whole call: chapters that
 * belong to somebody else, chapters already on disk, and chapters already
 * queued. All three are ordinary — "download all" over a partly-downloaded
 * manga sends every id there is — and a mutation that refused the batch because
 * one chapter was already there would be unusable.
 */
export function enqueue(db: Db, userId: string, chapterIds: readonly number[]): void {
  const wanted = ids(chapterIds);
  if (wanted.length === 0) return;

  db.transaction(() => {
    const tail = db.get<{ next: number }>(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM download_queue WHERE user_id = ?',
      userId,
    );
    let position = tail?.next ?? 0;
    const now = Date.now();

    for (const chapterId of wanted) {
      const owned = db.get<{ id: number }>(
        'SELECT id FROM chapter WHERE id = ? AND user_id = ? AND is_downloaded = 0',
        chapterId,
        userId,
      );
      if (!owned) continue;
      const result = db.run(
        `INSERT INTO download_queue
           (user_id, chapter_id, position, state, progress, tries, error, enqueued_at)
         VALUES (?, ?, ?, 'QUEUED', 0, 0, NULL, ?)
         ON CONFLICT (chapter_id) DO NOTHING`,
        userId,
        chapterId,
        position,
        now,
      );
      if (result.changes > 0) position += 1;
    }
  });
}

/** Removes chapters from the account's queue and closes the gaps. */
export function dequeue(db: Db, userId: string, chapterIds: readonly number[]): void {
  const wanted = ids(chapterIds);
  if (wanted.length === 0) return;

  db.transaction(() => {
    db.run(
      `DELETE FROM download_queue WHERE user_id = ? AND chapter_id IN (${placeholders(wanted.length)})`,
      userId,
      ...wanted,
    );
    renumber(db, userId);
  });
}

/**
 * Moves one chapter to a 0-based index in the account's queue.
 *
 * `to` is clamped rather than rejected: the client computes it from a drag, and
 * a drop past the end of a queue that shrank in the meantime means "last".
 */
export function reorder(db: Db, userId: string, chapterId: number, to: number): void {
  db.transaction(() => {
    const rows = db.all<{ id: number; chapter_id: number }>(
      'SELECT id, chapter_id FROM download_queue WHERE user_id = ? ORDER BY position, id',
      userId,
    );
    const from = rows.findIndex((row) => row.chapter_id === chapterId);
    if (from < 0) return;

    const [moved] = rows.splice(from, 1);
    const target = Math.min(Math.max(Math.trunc(to), 0), rows.length);
    rows.splice(target, 0, moved);
    rows.forEach((row, index) => {
      db.run('UPDATE download_queue SET position = ? WHERE id = ?', index, row.id);
    });
  });
}

/** Empties the account's queue. Nothing already written to disk is touched. */
export function clear(db: Db, userId: string): void {
  db.run('DELETE FROM download_queue WHERE user_id = ?', userId);
}

/**
 * Puts the account's in-flight chapter back to QUEUED.
 *
 * Pausing must not leave a row reading DOWNLOADING with nothing downloading it:
 * the worker checks the downloader state between pages and steps away, so this
 * is what the row says the moment the mutation answers.
 */
export function pause(db: Db, userId: string): void {
  db.run("UPDATE download_queue SET state = 'QUEUED' WHERE user_id = ? AND state = 'DOWNLOADING'", userId);
}

/**
 * The same, for every account at once — used when the worker starts and when it
 * stops. A DOWNLOADING row left by a killed process would otherwise be skipped
 * forever, since the loop only ever picks up QUEUED.
 */
export function releaseInFlight(db: Db): void {
  db.run("UPDATE download_queue SET state = 'QUEUED', progress = 0 WHERE state = 'DOWNLOADING'");
}

/** The head of the account's queue, or nothing when there is no work. */
export function nextQueued(db: Db, userId: string): QueueRow | undefined {
  return db.get<QueueRow>(
    `SELECT ${QUEUE_COLUMNS} FROM download_queue
     WHERE user_id = ? AND state = 'QUEUED'
     ORDER BY position, id LIMIT 1`,
    userId,
  );
}

/** Accounts with work waiting, in a stable order the round-robin can rotate. */
export function usersWithWork(db: Db): string[] {
  return db
    .all<{ user_id: string }>(
      "SELECT DISTINCT user_id FROM download_queue WHERE state = 'QUEUED' ORDER BY user_id",
    )
    .map((row) => row.user_id);
}

export function queueRow(db: Db, id: number): QueueRow | undefined {
  return db.get<QueueRow>(`SELECT ${QUEUE_COLUMNS} FROM download_queue WHERE id = ?`, id);
}

/** Is there anything left for the loop to pick up? */
export function hasQueuedWork(db: Db, userId: string): boolean {
  return nextQueued(db, userId) !== undefined;
}

/**
 * Is anything happening at all — waiting *or* in flight?
 *
 * The distinction matters to `startDownloader`, which the client sends again
 * while a chapter is already downloading. Asking `hasQueuedWork` there would
 * see the only row as DOWNLOADING rather than QUEUED and switch the downloader
 * off, which is the opposite of what was pressed.
 */
export function hasPendingWork(db: Db, userId: string): boolean {
  return (
    db.get<{ id: number }>(
      `SELECT id FROM download_queue
       WHERE user_id = ? AND state IN ('QUEUED', 'DOWNLOADING') LIMIT 1`,
      userId,
    ) !== undefined
  );
}

// --------------------------------------------------------------- reporting --

type ChapterRow = Parameters<typeof mapChapter>[0];
type MangaRow = Parameters<typeof mapManga>[0];

/**
 * The whole `DownloadStatus`, which is all the Downloads screen ever asks for.
 *
 * Chapters and mangas are fetched in one statement each rather than per row:
 * the client polls this once a second while anything is running, and a
 * fifty-chapter queue would otherwise be a hundred and one queries a second.
 */
export function status(db: Db, userId: string): DownloadStatus {
  const rows = db.all<QueueRow>(
    `SELECT ${QUEUE_COLUMNS} FROM download_queue WHERE user_id = ? ORDER BY position, id`,
    userId,
  );
  const state = downloaderState(userId);
  if (rows.length === 0) return { state, queue: [] };

  const chapterIds = rows.map((row) => row.chapter_id);
  const chapters = db.all<ChapterRow>(
    `SELECT ${CHAPTER_COLUMNS} FROM chapter
     WHERE user_id = ? AND id IN (${placeholders(chapterIds.length)})`,
    userId,
    ...chapterIds,
  );
  const byChapterId = new Map(chapters.map((row) => [row.id, row]));

  const mangaIds = [...new Set(chapters.map((row) => row.manga_id))];
  const mangas =
    mangaIds.length === 0
      ? []
      : db.all<MangaRow>(
          `SELECT ${MANGA_COLUMNS} FROM manga
           WHERE user_id = ? AND id IN (${placeholders(mangaIds.length)})`,
          userId,
          ...mangaIds,
        );
  const byMangaId = new Map(mangas.map((row) => [row.id, row]));

  const queue: DownloadItem[] = [];
  for (const row of rows) {
    const chapter = byChapterId.get(row.chapter_id);
    const manga = chapter ? byMangaId.get(chapter.manga_id) : undefined;
    // Both are non-null in the schema, so an entry whose chapter or manga row
    // has gone is dropped rather than sent as a null the client cannot render.
    if (!chapter || !manga) continue;
    queue.push({
      chapter: mapChapter(chapter),
      manga: mapManga(manga),
      position: row.position,
      progress: row.progress,
      state: row.state,
      tries: row.tries,
    });
  }
  return { state, queue };
}

// ---------------------------------------------------------------- deleting --

interface DeletableRow {
  id: number;
  name: string;
  scanlator: string | null;
  manga_title: string;
  source_id: string;
}

/**
 * Removes the files of already-downloaded chapters and clears the flag.
 *
 * The flag is cleared even when a file was already missing: the flag's job is to
 * answer "can this be read offline", and a chapter whose folder somebody deleted
 * by hand cannot. Read state, bookmarks and the queue are untouched — the UI
 * promises "they stay read, and can be downloaded again".
 */
export async function deleteDownloaded(
  db: Db,
  config: Config,
  userId: string,
  chapterIds: readonly number[],
): Promise<unknown[]> {
  const wanted = ids(chapterIds);
  if (wanted.length === 0) return [];

  const rows = db.all<DeletableRow>(
    `SELECT c.id, c.name, c.scanlator, m.title AS manga_title, m.source_id
     FROM chapter c JOIN manga m ON m.id = c.manga_id
     WHERE c.user_id = ? AND c.id IN (${placeholders(wanted.length)})`,
    userId,
    ...wanted,
  );

  for (const row of rows) {
    await removeChapterFiles(
      chapterLocation(config, {
        userId,
        sourceId: row.source_id,
        mangaTitle: row.manga_title,
        chapterId: row.id,
        chapterName: row.name,
        scanlator: row.scanlator,
      }),
    );
  }

  const deleted = rows.map((row) => row.id);
  if (deleted.length > 0) {
    db.run(
      `UPDATE chapter SET is_downloaded = 0
       WHERE user_id = ? AND id IN (${placeholders(deleted.length)})`,
      userId,
      ...deleted,
    );
  }

  const after = db.all<ChapterRow>(
    `SELECT ${CHAPTER_COLUMNS} FROM chapter
     WHERE user_id = ? AND id IN (${placeholders(wanted.length)})`,
    userId,
    ...wanted,
  );
  return after.map((row) => mapChapter(row));
}
