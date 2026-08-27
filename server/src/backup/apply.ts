/**
 * Writing a backup document back into the database.
 *
 * Shared by the upload restore, the "restore this nightly one" button and the
 * `.tachibk` migration, because all three end up holding the same document and
 * only differ in where it came from.
 *
 * Two rules shape everything below.
 *
 * **It is a merge, not a replacement.** Nothing is deleted. A restore adds what
 * the archive has and reconciles what both sides have, so running it against a
 * library that has moved on since the backup was taken cannot lose the newer
 * half. Where the two disagree about progress the *further* value wins — a
 * chapter read on either side stays read, `lastPageRead` and `lastReadAt` take
 * the larger — because a restore is meant to recover reading, never to undo it.
 *
 * **It is idempotent by natural key.** A manga is `(user_id, source_id, url)`, a
 * chapter is `(manga_id, url)`, a category is its name, a track record is
 * `(manga_id, tracker_id)`. Restoring the same archive twice therefore changes
 * nothing the second time, which is what makes a half-finished restore safe to
 * simply run again.
 *
 * The work is chunked and `await`ed between batches. `node:sqlite` is
 * synchronous, so a library of a few thousand titles restored in one go would
 * hold the event loop for seconds and the UI polling `restoreStatus` would see
 * nothing at all until it was over.
 */
import { bool, type Db } from '../db/open.js';
import { DEFAULT_SETTINGS, type Settings } from '../graphql/resolvers/settings.js';
import { SOURCE_BINDING_META_KEY } from './create.js';
import type { BackupChapterEntry, BackupDocument, BackupMangaEntry } from './format.js';

export interface ApplySummary {
  manga: number;
  chapters: number;
  categories: number;
  tracks: number;
  metas: number;
}

export type ApplyPhase = 'categories' | 'manga' | 'meta' | 'settings';

export interface ApplyHooks {
  /** Called as each phase begins, and after every batch of titles. */
  onPhase?(phase: ApplyPhase): void;
  onProgress?(done: number, total: number): void;
}

/**
 * Titles per transaction. Large enough that the per-transaction cost disappears,
 * small enough that the loop yields often enough for a poll to see movement.
 */
const BATCH = 25;

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

const MANGA_STATUSES = new Set([
  'UNKNOWN',
  'ONGOING',
  'COMPLETED',
  'LICENSED',
  'PUBLISHING_FINISHED',
  'CANCELLED',
  'ON_HIATUS',
]);

function yieldToLoop(): Promise<void> {
  return new Promise((done) => setImmediate(done));
}

// --------------------------------------------------------------- categories --

/**
 * Categories by name, creating what is missing.
 *
 * Returns the archive's own ids mapped onto this account's, which is what the
 * membership rows need: a backup taken elsewhere numbered its categories from
 * its own sequence and those numbers mean nothing here.
 */
function restoreCategories(db: Db, userId: string, document: BackupDocument): {
  mapping: Map<number, number>;
  created: number;
} {
  const mapping = new Map<number, number>();
  let created = 0;
  if (document.categories.length === 0) return { mapping, created };

  db.transaction(() => {
    const existing = db.all<{ id: number; name: string; ord: number }>(
      'SELECT id, name, ord FROM category WHERE user_id = ?',
      userId,
    );
    const byName = new Map(existing.map((row) => [row.name.toLowerCase(), row.id]));
    // Default occupies order 0 and is never a row, so a real one starts at 1.
    let nextOrder = Math.max(0, ...existing.map((row) => row.ord)) + 1;

    for (const category of document.categories) {
      const found = byName.get(category.name.toLowerCase());
      if (found !== undefined) {
        mapping.set(category.id, found);
        continue;
      }
      const { lastInsertRowid } = db.run(
        'INSERT INTO category (user_id, name, ord) VALUES (?, ?, ?)',
        userId,
        category.name,
        nextOrder,
      );
      nextOrder += 1;
      created += 1;
      byName.set(category.name.toLowerCase(), lastInsertRowid);
      mapping.set(category.id, lastInsertRowid);
    }
  });

  return { mapping, created };
}

// -------------------------------------------------------------------- manga --

interface ExistingManga {
  id: number;
  in_library: number;
  in_library_at: number;
}

/** Fields worth keeping from the archive; a null or empty one never overwrites. */
function preferred(incoming: string | null, current: string | null): string | null {
  return incoming !== null && incoming !== '' ? incoming : current;
}

function upsertManga(db: Db, userId: string, entry: BackupMangaEntry): number {
  const existing = db.get<ExistingManga>(
    'SELECT id, in_library, in_library_at FROM manga WHERE user_id = ? AND source_id = ? AND url = ?',
    userId,
    entry.sourceId,
    entry.url,
  );

  const status = MANGA_STATUSES.has(entry.status) ? entry.status : 'UNKNOWN';
  const genre = entry.genre.length > 0 ? JSON.stringify(entry.genre) : null;

  if (!existing) {
    const { lastInsertRowid } = db.run(
      `INSERT INTO manga (user_id, source_id, url, title, artist, author, description, genre,
                          status, thumbnail_url, real_url, initialized, in_library, in_library_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      entry.sourceId,
      entry.url,
      entry.title,
      entry.artist,
      entry.author,
      entry.description,
      genre,
      status,
      entry.thumbnailUrl,
      entry.realUrl,
      bool(entry.initialized),
      bool(entry.inLibrary),
      entry.inLibraryAt,
    );
    return lastInsertRowid;
  }

  const current = db.get<{
    artist: string | null;
    author: string | null;
    description: string | null;
    genre: string | null;
    thumbnail_url: string | null;
    real_url: string | null;
  }>(
    'SELECT artist, author, description, genre, thumbnail_url, real_url FROM manga WHERE id = ?',
    existing.id,
  );

  db.run(
    `UPDATE manga SET title = ?, artist = ?, author = ?, description = ?, genre = ?, status = ?,
                      thumbnail_url = ?, real_url = ?, initialized = ?, in_library = ?, in_library_at = ?
     WHERE id = ? AND user_id = ?`,
    entry.title,
    preferred(entry.artist, current?.artist ?? null),
    preferred(entry.author, current?.author ?? null),
    preferred(entry.description, current?.description ?? null),
    preferred(genre, current?.genre ?? null),
    status,
    preferred(entry.thumbnailUrl, current?.thumbnail_url ?? null),
    preferred(entry.realUrl, current?.real_url ?? null),
    bool(entry.initialized),
    // A restore never takes something out of the library, so these only ever
    // move one way; the earliest known "added on" is the true one.
    existing.in_library === 1 || entry.inLibrary ? 1 : 0,
    earliest(existing.in_library_at, entry.inLibraryAt),
    existing.id,
    userId,
  );
  return existing.id;
}

/** The earlier of two stamps, ignoring "never". */
function earliest(left: number, right: number): number {
  if (left === 0) return right;
  if (right === 0) return left;
  return Math.min(left, right);
}

function upsertChapters(
  db: Db,
  userId: string,
  mangaId: number,
  chapters: BackupChapterEntry[],
): number {
  let written = 0;
  for (const chapter of chapters) {
    const existing = db.get<{
      id: number;
      is_read: number;
      is_bookmarked: number;
      last_page_read: number;
      last_read_at: number;
    }>(
      'SELECT id, is_read, is_bookmarked, last_page_read, last_read_at FROM chapter WHERE manga_id = ? AND url = ?',
      mangaId,
      chapter.url,
    );

    if (!existing) {
      db.run(
        `INSERT INTO chapter (user_id, manga_id, url, name, scanlator, chapter_number, source_order,
                              date_upload, real_url, is_read, is_bookmarked, last_page_read,
                              last_read_at, page_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        userId,
        mangaId,
        chapter.url,
        chapter.name,
        chapter.scanlator,
        chapter.chapterNumber,
        chapter.sourceOrder,
        chapter.dateUpload,
        chapter.realUrl,
        bool(chapter.isRead),
        bool(chapter.isBookmarked),
        chapter.lastPageRead,
        chapter.lastReadAt,
        chapter.pageCount,
      );
    } else {
      db.run(
        `UPDATE chapter SET name = ?, scanlator = ?, chapter_number = ?, source_order = ?,
                            date_upload = ?, is_read = ?, is_bookmarked = ?, last_page_read = ?,
                            last_read_at = ?
         WHERE id = ?`,
        chapter.name,
        chapter.scanlator,
        chapter.chapterNumber,
        chapter.sourceOrder,
        chapter.dateUpload,
        existing.is_read === 1 || chapter.isRead ? 1 : 0,
        existing.is_bookmarked === 1 || chapter.isBookmarked ? 1 : 0,
        Math.max(existing.last_page_read, chapter.lastPageRead),
        Math.max(existing.last_read_at, chapter.lastReadAt),
        existing.id,
      );
    }
    written += 1;
  }
  return written;
}

function upsertTracks(db: Db, userId: string, mangaId: number, entry: BackupMangaEntry): number {
  let written = 0;
  for (const track of entry.tracking) {
    db.run(
      `INSERT INTO track_record (user_id, manga_id, tracker_id, remote_id, title, last_chapter_read,
                                 total_chapters, status, score, remote_url, start_date, finish_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (manga_id, tracker_id) DO UPDATE SET
         remote_id = excluded.remote_id,
         title = excluded.title,
         last_chapter_read = MAX(track_record.last_chapter_read, excluded.last_chapter_read),
         total_chapters = excluded.total_chapters,
         status = excluded.status,
         score = excluded.score,
         remote_url = excluded.remote_url,
         start_date = excluded.start_date,
         finish_date = excluded.finish_date`,
      userId,
      mangaId,
      track.trackerId,
      track.remoteId,
      track.title,
      track.lastChapterRead,
      track.totalChapters,
      track.status,
      track.score,
      track.remoteUrl,
      track.startDate,
      track.finishDate,
    );
    written += 1;
  }
  return written;
}

// --------------------------------------------------------------------- meta --

/**
 * Per-title meta, with the one value that is a *reference* translated.
 *
 * `stremio4manga.source-binding` holds the row id of the entry this one is read
 * from. Row ids are per-server, so carrying the number over verbatim would point
 * at whatever happens to occupy that id here — usually nothing, occasionally the
 * wrong title. The archive records each entry's original id, so the pairs can be
 * matched up and the binding rewritten. A binding whose target is not in the
 * archive is dropped rather than left dangling: no binding means "read from your
 * own catalogue", which is a working state; a wrong one is not.
 */
function upsertMangaMeta(
  db: Db,
  mangaId: number,
  meta: Record<string, string>,
  remap: Map<number, number>,
): number {
  let written = 0;
  for (const [key, value] of Object.entries(meta)) {
    let stored = value;
    if (key === SOURCE_BINDING_META_KEY) {
      const target = remap.get(Number(value));
      if (target === undefined) continue;
      stored = String(target);
    }
    db.run(
      `INSERT INTO manga_meta (manga_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT (manga_id, key) DO UPDATE SET value = excluded.value`,
      mangaId,
      key,
      stored,
    );
    written += 1;
  }
  return written;
}

/** Only the keys the settings table knows, and only with the type each promises. */
function restoreSettings(db: Db, userId: string, settings: Partial<Settings> | null): number {
  if (!settings) return 0;
  let written = 0;
  db.transaction(() => {
    for (const key of SETTING_KEYS) {
      const value = settings[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== typeof DEFAULT_SETTINGS[key]) continue;
      db.run(
        `INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
        userId,
        key,
        JSON.stringify(value),
      );
      written += 1;
    }
  });
  return written;
}

// -------------------------------------------------------------------- apply --

export async function applyDocument(
  db: Db,
  userId: string,
  document: BackupDocument,
  hooks: ApplyHooks = {},
): Promise<ApplySummary> {
  const summary: ApplySummary = { manga: 0, chapters: 0, categories: 0, tracks: 0, metas: 0 };

  hooks.onPhase?.('categories');
  const { mapping, created } = restoreCategories(db, userId, document);
  summary.categories = created;
  await yieldToLoop();

  hooks.onPhase?.('manga');
  const total = document.manga.length;
  hooks.onProgress?.(0, total);

  // Two passes over the titles: the first writes them and learns which archive id
  // became which row id, the second writes the meta that refers to those ids.
  // The binding of the first title can point at the last one, so nothing that
  // depends on the map may run before the map is complete.
  const idMap = new Map<number, number>();

  for (let start = 0; start < total; start += BATCH) {
    const batch = document.manga.slice(start, start + BATCH);
    db.transaction(() => {
      for (const entry of batch) {
        const mangaId = upsertManga(db, userId, entry);
        if (entry.id > 0) idMap.set(entry.id, mangaId);
        summary.manga += 1;
        summary.chapters += upsertChapters(db, userId, mangaId, entry.chapters);
        summary.tracks += upsertTracks(db, userId, mangaId, entry);

        for (const categoryId of entry.categories) {
          const target = mapping.get(categoryId);
          if (target === undefined) continue;
          db.run(
            'INSERT OR IGNORE INTO category_manga (category_id, manga_id) VALUES (?, ?)',
            target,
            mangaId,
          );
        }
      }
    });
    hooks.onProgress?.(Math.min(start + BATCH, total), total);
    await yieldToLoop();
  }

  hooks.onPhase?.('meta');
  for (let start = 0; start < total; start += BATCH) {
    const batch = document.manga.slice(start, start + BATCH);
    db.transaction(() => {
      for (const entry of batch) {
        const mangaId = entry.id > 0 ? idMap.get(entry.id) : undefined;
        const target =
          mangaId ??
          db.get<{ id: number }>(
            'SELECT id FROM manga WHERE user_id = ? AND source_id = ? AND url = ?',
            userId,
            entry.sourceId,
            entry.url,
          )?.id;
        if (target === undefined) continue;
        summary.metas += upsertMangaMeta(db, target, entry.meta, idMap);
      }
    });
    await yieldToLoop();
  }

  db.transaction(() => {
    for (const [key, value] of Object.entries(document.globalMeta)) {
      db.run(
        `INSERT INTO global_meta (user_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
        userId,
        key,
        value,
      );
      summary.metas += 1;
    }
  });
  await yieldToLoop();

  hooks.onPhase?.('settings');
  restoreSettings(db, userId, document.settings);

  return summary;
}
