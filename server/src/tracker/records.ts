/**
 * `track_record`: the join between a library row and a title on AniList.
 *
 * Two facts shape everything here.
 *
 * **A series usually has two rows.** One is the library entry (an AniList shell
 * on source '1', or whatever the reader first added), the other is the manga as
 * a real source indexes it. Both must point at *one* remote record, which is
 * why `bindExistingRecord` exists and why a progress report updates every local
 * record that carries the same `remote_id`.
 *
 * **Progress only ever goes up.** `reportProgress` refuses anything at or below
 * what the record already holds. The library's AniList refresh relies on this:
 * it clears `isRead` on chapters AniList no longer counts as read, and that
 * must not travel back to AniList as a rollback.
 */
import type { Db } from '../db/open.js';
import * as anilist from './anilist.js';
import { ANILIST_SOURCE_ID, ANILIST_TRACKER_ID } from './anilist.js';
import {
  NotLoggedInError,
  readCredential,
  requireCredential,
  saveProfile,
  type TrackerCredential,
} from './credentials.js';

/**
 * Set once the AniList list has been pulled in for this account, so the
 * first-run auto-import does not run again after the reader has deleted the
 * entries it created.
 */
export const IMPORT_DONE_META_KEY = 'stremio4manga.anilist-import-done';

/** `TrackRecordType`, field for field. `remoteId` is a LongString: text. */
export interface TrackRecord {
  id: number;
  mangaId: number;
  trackerId: number;
  remoteId: string;
  title: string;
  lastChapterRead: number;
  totalChapters: number;
  status: number;
  score: number;
  remoteUrl: string;
  /** LongString epoch milliseconds; the schema serialises them as strings. */
  startDate: string;
  finishDate: string;
}

/** Enough of `MangaType` for the import payload; the rest resolves per field. */
export interface MangaShell {
  id: number;
  sourceId: string;
  url: string;
  title: string;
  thumbnailUrl: string | null;
  artist: string | null;
  author: string | null;
  description: string | null;
  genre: string[];
  status: string;
  realUrl: string | null;
  inLibrary: boolean;
  inLibraryAt: string;
  initialized: boolean;
}

interface RecordRow {
  id: number;
  manga_id: number;
  tracker_id: number;
  remote_id: string;
  title: string;
  last_chapter_read: number;
  total_chapters: number;
  status: number;
  score: number;
  remote_url: string | null;
  start_date: number;
  finish_date: number;
}

const RECORD_COLUMNS = `id, manga_id, tracker_id, remote_id, title, last_chapter_read,
                        total_chapters, status, score, remote_url, start_date, finish_date`;

function fromRow(row: RecordRow): TrackRecord {
  return {
    id: row.id,
    mangaId: row.manga_id,
    trackerId: row.tracker_id,
    remoteId: row.remote_id,
    title: row.title,
    lastChapterRead: row.last_chapter_read,
    totalChapters: row.total_chapters,
    status: row.status,
    score: row.score,
    // Non-null in the schema, nullable in the table: the UI links to it
    // unconditionally, so an empty string is the safe "no link" value.
    remoteUrl: row.remote_url ?? '',
    startDate: String(row.start_date),
    finishDate: String(row.finish_date),
  };
}

// ----------------------------------------------------------------- reads --

export function recordById(db: Db, userId: string, recordId: number): TrackRecord | null {
  const row = db.get<RecordRow>(
    `SELECT ${RECORD_COLUMNS} FROM track_record WHERE user_id = ? AND id = ?`,
    userId,
    recordId,
  );
  return row ? fromRow(row) : null;
}

export function recordsForManga(db: Db, userId: string, mangaId: number): TrackRecord[] {
  return db
    .all<RecordRow>(
      `SELECT ${RECORD_COLUMNS} FROM track_record
        WHERE user_id = ? AND manga_id = ?
        ORDER BY tracker_id`,
      userId,
      mangaId,
    )
    .map(fromRow);
}

// ---------------------------------------------------------------- writes --

/** Everything a record holds apart from the row's own identity. */
export interface RecordFields {
  trackerId: number;
  remoteId: string;
  title?: string;
  lastChapterRead?: number;
  totalChapters?: number;
  status?: number;
  score?: number;
  remoteUrl?: string;
  startDate?: number;
  finishDate?: number;
}

/**
 * Create or update the record for `(mangaId, trackerId)`.
 *
 * `lastChapterRead` is the one field that never moves backwards, even here: an
 * import or a re-bind that arrives while the reader is ahead of AniList must
 * not undo local progress that has not been pushed yet.
 */
export function upsertRecord(
  db: Db,
  userId: string,
  mangaId: number,
  record: RecordFields,
): TrackRecord {
  return db.transaction(() => {
    const existing = db.get<RecordRow>(
      `SELECT ${RECORD_COLUMNS} FROM track_record
        WHERE user_id = ? AND manga_id = ? AND tracker_id = ?`,
      userId,
      mangaId,
      record.trackerId,
    );

    const merged = {
      remoteId: record.remoteId,
      title: record.title ?? existing?.title ?? '',
      lastChapterRead: Math.max(record.lastChapterRead ?? 0, existing?.last_chapter_read ?? 0),
      totalChapters: record.totalChapters ?? existing?.total_chapters ?? 0,
      status: record.status ?? existing?.status ?? 0,
      score: record.score ?? existing?.score ?? 0,
      remoteUrl: record.remoteUrl ?? existing?.remote_url ?? '',
      startDate: record.startDate ?? existing?.start_date ?? 0,
      finishDate: record.finishDate ?? existing?.finish_date ?? 0,
    };

    if (existing) {
      db.run(
        `UPDATE track_record
            SET remote_id = ?, title = ?, last_chapter_read = ?, total_chapters = ?,
                status = ?, score = ?, remote_url = ?, start_date = ?, finish_date = ?
          WHERE id = ? AND user_id = ?`,
        merged.remoteId,
        merged.title,
        merged.lastChapterRead,
        merged.totalChapters,
        merged.status,
        merged.score,
        merged.remoteUrl,
        merged.startDate,
        merged.finishDate,
        existing.id,
        userId,
      );
      const updated = recordById(db, userId, existing.id);
      if (!updated) throw new Error('Track record vanished during update.');
      return updated;
    }

    const result = db.run(
      `INSERT INTO track_record
         (user_id, manga_id, tracker_id, remote_id, title, last_chapter_read,
          total_chapters, status, score, remote_url, start_date, finish_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      mangaId,
      record.trackerId,
      merged.remoteId,
      merged.title,
      merged.lastChapterRead,
      merged.totalChapters,
      merged.status,
      merged.score,
      merged.remoteUrl,
      merged.startDate,
      merged.finishDate,
    );
    const created = recordById(db, userId, result.lastInsertRowid);
    if (!created) throw new Error('Track record vanished after insert.');
    return created;
  });
}

/** Delete a record. The remote list entry is only touched when asked for. */
export async function unbindRecord(
  db: Db,
  userId: string,
  recordId: number,
  deleteRemoteTrack: boolean,
): Promise<TrackRecord | null> {
  const record = recordById(db, userId, recordId);
  if (!record) return null;

  if (deleteRemoteTrack && record.trackerId === ANILIST_TRACKER_ID) {
    // The UI always sends false. Honouring true is a deletion on someone
    // else's service, so it is best-effort: failing to reach AniList must not
    // leave a local record the reader has already been told is gone.
    try {
      const { credential, remoteUser } = await remoteAccount(db, userId, record.trackerId);
      await anilist.deleteListEntry(credential.accessToken, remoteUser, record.remoteId);
    } catch {
      // Swallowed on purpose — see above.
    }
  }

  db.run('DELETE FROM track_record WHERE user_id = ? AND id = ?', userId, recordId);
  return record;
}

// -------------------------------------------------------- remote account --

/**
 * The token plus the tracker's own account id, resolving and caching the id
 * when it is missing.
 *
 * The list queries need it and OAuth does not hand it over, so the first call
 * after a sign-in pays for one `Viewer` request and every call after it does
 * not.
 */
async function remoteAccount(
  db: Db,
  userId: string,
  trackerId: number,
): Promise<{ credential: TrackerCredential; remoteUser: string }> {
  const credential = requireCredential(db, userId, trackerId);
  if (credential.remoteUser) return { credential, remoteUser: credential.remoteUser };

  const profile = await anilist.viewer(credential.accessToken);
  saveProfile(db, userId, trackerId, {
    remoteUser: profile.id,
    displayName: profile.name,
    avatarUrl: profile.avatarUrl,
    scoreType: profile.scoreFormat,
  });
  return { credential: { ...credential, remoteUser: profile.id }, remoteUser: profile.id };
}

function fieldsFromEntry(entry: anilist.AniListEntry, trackerId: number): RecordFields {
  return {
    trackerId,
    remoteId: entry.remoteId,
    title: entry.title,
    lastChapterRead: entry.lastChapterRead,
    totalChapters: entry.totalChapters,
    status: entry.status,
    score: entry.score,
    remoteUrl: entry.trackingUrl,
    startDate: entry.startDate,
    finishDate: entry.finishDate,
  };
}

// ----------------------------------------------------------------- binds --

/**
 * `bindTrack`: point a manga at a remote id and pull that title's state down.
 *
 * The remote state is fetched rather than assumed because the reader is
 * usually binding a series they have already read part of elsewhere; showing
 * "0 / 120" until the next refresh would look like the bind failed.
 */
export async function bindByRemoteId(
  db: Db,
  userId: string,
  mangaId: number,
  trackerId: number,
  remoteId: string,
): Promise<TrackRecord> {
  const { credential, remoteUser } = await remoteAccount(db, userId, trackerId);
  const entry = await anilist.findListEntry(credential.accessToken, remoteUser, remoteId);
  if (!entry) throw new Error(`AniList has no manga with id ${remoteId}.`);
  return upsertRecord(db, userId, mangaId, fieldsFromEntry(entry, trackerId));
}

/**
 * `bindTrackRecord`: attach an existing record's remote title to a second
 * manga row.
 *
 * Copied rather than shared because `track_record` is keyed by
 * `(manga_id, tracker_id)` — one row per manga — so "the same record" means
 * two rows agreeing on `remote_id`, which is exactly what `reportProgress`
 * and the UI's deduplication key both look at.
 */
export function bindExistingRecord(
  db: Db,
  userId: string,
  mangaId: number,
  trackRecordId: number,
): TrackRecord {
  const source = recordById(db, userId, trackRecordId);
  if (!source) throw new Error(`No track record ${trackRecordId}.`);

  return upsertRecord(db, userId, mangaId, {
    trackerId: source.trackerId,
    remoteId: source.remoteId,
    title: source.title,
    lastChapterRead: source.lastChapterRead,
    totalChapters: source.totalChapters,
    status: source.status,
    score: source.score,
    remoteUrl: source.remoteUrl,
    startDate: Number(source.startDate),
    finishDate: Number(source.finishDate),
  });
}

/** `fetchTrack`: re-read one record's state from the tracker. */
export async function refreshRecord(
  db: Db,
  userId: string,
  recordId: number,
): Promise<TrackRecord> {
  const record = recordById(db, userId, recordId);
  if (!record) throw new Error(`No track record ${recordId}.`);

  const { credential, remoteUser } = await remoteAccount(db, userId, record.trackerId);
  const entry = await anilist.findListEntry(credential.accessToken, remoteUser, record.remoteId);
  if (!entry) return record;
  return upsertRecord(db, userId, record.mangaId, fieldsFromEntry(entry, record.trackerId));
}

// -------------------------------------------------------------- progress --

/**
 * Report a chapter as read, upwards only.
 *
 * Called by the reader when a chapter is marked read. `chapterNumber` is the
 * source's own chapter number, which AniList stores as a whole-chapter count.
 *
 * Returns whether anything was sent, so a caller that wants to log it can;
 * nothing here throws. A tracker that is signed out, rate limiting, or simply
 * down is not a reason to fail marking a chapter read locally — the library's
 * AniList refresh reconciles it later.
 */
export async function reportProgress(
  db: Db,
  userId: string,
  mangaId: number,
  chapterNumber: number,
): Promise<boolean> {
  if (!Number.isFinite(chapterNumber) || chapterNumber <= 0) return false;

  const records = recordsForManga(db, userId, mangaId).filter(
    (record) => record.trackerId === ANILIST_TRACKER_ID,
  );

  let reported = false;
  for (const record of records) {
    // The whole point of this module, in one line: never downwards.
    if (chapterNumber <= record.lastChapterRead) continue;

    let credential: TrackerCredential;
    try {
      credential = requireCredential(db, userId, record.trackerId);
    } catch (error) {
      if (error instanceof NotLoggedInError) return reported;
      throw error;
    }

    // Reading the first chapter of something filed under Planning (or never
    // filed at all) means it is being read now; finishing the last one means
    // it is done. Any other shelf the reader chose is left alone.
    let status: number | undefined;
    if (record.status === 0 || record.status === 5) status = 1;
    if (record.totalChapters > 0 && Math.floor(chapterNumber) >= record.totalChapters) status = 2;

    try {
      await anilist.updateProgress(
        credential.accessToken,
        record.remoteId,
        chapterNumber,
        status,
      );
    } catch {
      // Best effort by design; see the doc comment.
      continue;
    }
    reported = true;

    // Both local rows for this series carry the same remote id, and AniList
    // now agrees with the higher number, so both are moved. Without this the
    // library shelf would keep showing the old progress until a refresh.
    db.run(
      `UPDATE track_record
          SET last_chapter_read = ?, status = COALESCE(?, status)
        WHERE user_id = ? AND tracker_id = ? AND remote_id = ? AND last_chapter_read < ?`,
      chapterNumber,
      status ?? null,
      userId,
      record.trackerId,
      record.remoteId,
      chapterNumber,
    );
  }

  return reported;
}

// ---------------------------------------------------------------- import --

interface MangaRow {
  id: number;
  source_id: string;
  url: string;
  title: string;
  thumbnail_url: string | null;
  artist: string | null;
  author: string | null;
  description: string | null;
  genre: string | null;
  status: string;
  real_url: string | null;
  in_library: number;
  in_library_at: number;
  initialized: number;
}

const MANGA_COLUMNS = `id, source_id, url, title, thumbnail_url, artist, author, description,
                       genre, status, real_url, in_library, in_library_at, initialized`;

function mangaFromRow(row: MangaRow): MangaShell {
  let genre: string[] = [];
  if (row.genre) {
    try {
      const parsed: unknown = JSON.parse(row.genre);
      if (Array.isArray(parsed)) genre = parsed.filter((tag): tag is string => typeof tag === 'string');
    } catch {
      // A malformed genre blob is not worth failing an import over.
    }
  }
  return {
    id: row.id,
    sourceId: row.source_id,
    url: row.url,
    // Same-origin and server-relative, so the cover rides the session cookie
    // rather than leaking the reader's library to AniList's CDN logs.
    thumbnailUrl: row.thumbnail_url ? `/api/v1/manga/${row.id}/thumbnail` : null,
    title: row.title,
    artist: row.artist,
    author: row.author,
    description: row.description,
    genre,
    status: row.status,
    realUrl: row.real_url,
    inLibrary: row.in_library === 1,
    inLibraryAt: String(row.in_library_at),
    initialized: row.initialized === 1,
  };
}

/** `anilist:<mediaId>` — the shell's url, and its identity within source '1'. */
export function shellUrl(remoteId: string): string {
  return `anilist:${remoteId}`;
}

/**
 * Pull the whole AniList list in as library shells.
 *
 * Two things are deliberate.
 *
 * **The track records are written directly.** Nothing here calls `bindTrack`:
 * the state is already in hand from the one `MediaListCollection` request, and
 * a per-title round trip would rate-limit a library of any size before it
 * finished.
 *
 * **It is idempotent.** The shells are keyed by `(user_id, '1', 'anilist:id')`,
 * which the table already enforces as UNIQUE, so a second run updates the same
 * rows instead of doubling the library.
 */
export async function importLibrary(db: Db, userId: string): Promise<MangaShell[]> {
  const { credential, remoteUser } = await remoteAccount(db, userId, ANILIST_TRACKER_ID);
  const entries = await anilist.userMangaList(credential.accessToken, remoteUser);
  const now = Date.now();

  const imported = db.transaction(() => {
    const shells: MangaShell[] = [];
    for (const entry of entries) {
      const url = shellUrl(entry.remoteId);
      db.run(
        `INSERT INTO manga
           (user_id, source_id, url, title, thumbnail_url, status, genre,
            initialized, in_library, in_library_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', 1, 1, ?)
         ON CONFLICT (user_id, source_id, url) DO UPDATE SET
           title         = excluded.title,
           thumbnail_url = excluded.thumbnail_url,
           status        = excluded.status,
           in_library    = 1,
           -- When it joined the library is a fact about this server, not about
           -- AniList; re-importing must not reshuffle the "recently added" shelf.
           in_library_at = CASE WHEN manga.in_library_at = 0
                                THEN excluded.in_library_at
                                ELSE manga.in_library_at END`,
        userId,
        ANILIST_SOURCE_ID,
        url,
        entry.title,
        entry.coverUrl || null,
        entry.mangaStatus,
        now,
      );

      const row = db.get<MangaRow>(
        `SELECT ${MANGA_COLUMNS} FROM manga WHERE user_id = ? AND source_id = ? AND url = ?`,
        userId,
        ANILIST_SOURCE_ID,
        url,
      );
      if (!row) continue;

      upsertRecord(db, userId, row.id, fieldsFromEntry(entry, ANILIST_TRACKER_ID));
      shells.push(mangaFromRow(row));
    }

    db.run(
      `INSERT INTO global_meta (user_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
      userId,
      IMPORT_DONE_META_KEY,
      String(now),
    );

    return shells;
  });

  return imported;
}

/** Whether the first-run import has already happened for this account. */
export function hasImported(db: Db, userId: string): boolean {
  const row = db.get<{ value: string }>(
    'SELECT value FROM global_meta WHERE user_id = ? AND key = ?',
    userId,
    IMPORT_DONE_META_KEY,
  );
  return row !== undefined;
}

/**
 * The first-run import, which does nothing once it has run or when the account
 * has never connected AniList. Safe to call on every boot.
 */
export async function importLibraryOnce(db: Db, userId: string): Promise<MangaShell[]> {
  if (hasImported(db, userId)) return [];
  if (!readCredential(db, userId, ANILIST_TRACKER_ID)) return [];
  return importLibrary(db, userId);
}
