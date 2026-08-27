/**
 * Writing a backup: the library as it stands, turned into one archive on disk.
 *
 * The file is written rather than streamed back because both callers want it on
 * disk — the nightly job has nobody to hand it to, and `createBackup` answers
 * with a URL that the browser then downloads through `/api/v1/backup/<name>`.
 * One code path, one place the archives live, and the manual export shows up in
 * the same list as the automatic ones.
 *
 * What goes in is decided by the seven `include*` flags, all of which default to
 * on: the export is maximal unless somebody deliberately narrowed it.
 *
 * One thing here is not obvious. The backup carries titles that are **not** in
 * the library: an entry bound to another entry through
 * `stremio4manga.source-binding` points at a row that is usually a search result
 * rather than a library entry, and dropping it would restore a library whose
 * bindings all dangle. Those rows come along with `inLibrary: false`, which is
 * exactly what they were.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dataPaths, type Config } from '../config.js';
import type { Db } from '../db/open.js';
import { readSettings } from '../graphql/resolvers/settings.js';
import { allDefinitions } from '../sources/registry.js';
import { ANILIST_SOURCE_ID } from '../tracker/anilist.js';
import {
  BACKUP_APP,
  BACKUP_VERSION,
  writeBackupZip,
  type BackupCategoryEntry,
  type BackupChapterEntry,
  type BackupDocument,
  type BackupMangaEntry,
  type BackupSourceEntry,
  type BackupTrackEntry,
} from './format.js';

/** The meta key whose value is another entry's id. See the note at the top. */
export const SOURCE_BINDING_META_KEY = 'stremio4manga.source-binding';

export interface BackupFlags {
  includeManga: boolean;
  includeCategories: boolean;
  includeChapters: boolean;
  includeTracking: boolean;
  /** Reading history — when a chapter was last opened, and how far. */
  includeHistory: boolean;
  /** Client state: global meta and per-title meta. Source bindings live here. */
  includeClientData: boolean;
  includeServerSettings: boolean;
}

/** Everything, which is what `createBackup(input: {})` means. */
export const ALL_FLAGS: BackupFlags = {
  includeManga: true,
  includeCategories: true,
  includeChapters: true,
  includeTracking: true,
  includeHistory: true,
  includeClientData: true,
  includeServerSettings: true,
};

/** A flag left out of the input means "include it"; only `false` excludes. */
export function resolveFlags(input?: Partial<Record<keyof BackupFlags, boolean | null>>): BackupFlags {
  const flags = { ...ALL_FLAGS };
  if (!input) return flags;
  for (const key of Object.keys(ALL_FLAGS) as (keyof BackupFlags)[]) {
    if (input[key] === false) flags[key] = false;
  }
  return flags;
}

export interface CreatedBackup {
  filename: string;
  /** Absolute path on disk. */
  path: string;
  /** Same-origin relative path, which is what `CreateBackupPayload.url` carries. */
  url: string;
}

// ------------------------------------------------------------------ reading --

interface MangaRow {
  id: number;
  source_id: string;
  url: string;
  title: string;
  artist: string | null;
  author: string | null;
  description: string | null;
  genre: string | null;
  status: string;
  thumbnail_url: string | null;
  real_url: string | null;
  initialized: number;
  in_library: number;
  in_library_at: number;
}

interface ChapterRow {
  manga_id: number;
  url: string;
  name: string;
  scanlator: string | null;
  chapter_number: number;
  source_order: number;
  date_upload: number;
  real_url: string | null;
  is_read: number;
  is_bookmarked: number;
  last_page_read: number;
  last_read_at: number;
  page_count: number;
}

interface TrackRow {
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

const MANGA_COLUMNS =
  'id, source_id, url, title, artist, author, description, genre, status, thumbnail_url, ' +
  'real_url, initialized, in_library, in_library_at';

function parseGenre(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * The library, plus whatever it points at.
 *
 * One extra pass, not a loop: a binding names a source entry, and a source entry
 * is never itself bound to a third. Guarding against a cycle anyway costs one
 * `Set` and means a hand-edited meta value cannot hang the export.
 */
function collectMangaRows(db: Db, userId: string): MangaRow[] {
  const rows = db.all<MangaRow>(
    `SELECT ${MANGA_COLUMNS} FROM manga WHERE user_id = ? AND in_library = 1 ORDER BY id`,
    userId,
  );
  const byId = new Map(rows.map((row) => [row.id, row]));

  const referenced = new Set<number>();
  for (const row of rows) {
    const binding = db.get<{ value: string }>(
      'SELECT value FROM manga_meta WHERE manga_id = ? AND key = ?',
      row.id,
      SOURCE_BINDING_META_KEY,
    );
    const target = Number(binding?.value);
    if (Number.isInteger(target) && target > 0 && !byId.has(target)) referenced.add(target);
  }

  if (referenced.size > 0) {
    const ids = [...referenced];
    const extra = db.all<MangaRow>(
      `SELECT ${MANGA_COLUMNS} FROM manga WHERE user_id = ? AND id IN (${placeholders(ids.length)})`,
      userId,
      ...ids,
    );
    for (const row of extra) {
      byId.set(row.id, row);
      rows.push(row);
    }
  }

  return rows;
}

function groupBy<T extends { manga_id: number }>(rows: T[]): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const row of rows) {
    const list = grouped.get(row.manga_id);
    if (list) list.push(row);
    else grouped.set(row.manga_id, [row]);
  }
  return grouped;
}

function toChapter(row: ChapterRow, includeHistory: boolean): BackupChapterEntry {
  return {
    url: row.url,
    name: row.name,
    scanlator: row.scanlator,
    chapterNumber: row.chapter_number,
    sourceOrder: row.source_order,
    dateUpload: row.date_upload,
    realUrl: row.real_url,
    isRead: row.is_read === 1,
    isBookmarked: row.is_bookmarked === 1,
    // "History" is when and how far, not whether: a chapter stays read with the
    // history flag off, it simply stops saying which evening that was.
    lastPageRead: includeHistory ? row.last_page_read : 0,
    lastReadAt: includeHistory ? row.last_read_at : 0,
    pageCount: row.page_count,
  };
}

function toTrack(row: TrackRow): BackupTrackEntry {
  return {
    trackerId: row.tracker_id,
    remoteId: row.remote_id,
    title: row.title,
    lastChapterRead: row.last_chapter_read,
    totalChapters: row.total_chapters,
    status: row.status,
    score: row.score,
    remoteUrl: row.remote_url,
    startDate: row.start_date,
    finishDate: row.finish_date,
  };
}

/** Names for the sources the backup mentions, so a restore elsewhere can say which. */
function sourcesFor(sourceIds: Set<string>): BackupSourceEntry[] {
  const known = new Map(allDefinitions().map((definition) => [definition.id, definition.name]));
  known.set(ANILIST_SOURCE_ID, 'AniList');
  return [...sourceIds].map((id) => ({ id, name: known.get(id) ?? `Source ${id}` }));
}

/** The whole document, in memory. A library is thousands of rows, not millions. */
export function buildDocument(db: Db, userId: string, flags: BackupFlags): BackupDocument {
  const categories: BackupCategoryEntry[] = flags.includeCategories
    ? db
        .all<{ id: number; name: string; ord: number }>(
          'SELECT id, name, ord FROM category WHERE user_id = ? ORDER BY ord, id',
          userId,
        )
        .map((row) => ({ id: row.id, name: row.name, order: row.ord }))
    : [];

  const manga: BackupMangaEntry[] = [];
  const sourceIds = new Set<string>();

  if (flags.includeManga) {
    const rows = collectMangaRows(db, userId);

    const chapters = flags.includeChapters
      ? groupBy(
          db.all<ChapterRow>(
            `SELECT manga_id, url, name, scanlator, chapter_number, source_order, date_upload,
                    real_url, is_read, is_bookmarked, last_page_read, last_read_at, page_count
             FROM chapter WHERE user_id = ? ORDER BY manga_id, source_order`,
            userId,
          ),
        )
      : new Map<number, ChapterRow[]>();

    const tracks = flags.includeTracking
      ? groupBy(
          db.all<TrackRow>(
            `SELECT manga_id, tracker_id, remote_id, title, last_chapter_read, total_chapters,
                    status, score, remote_url, start_date, finish_date
             FROM track_record WHERE user_id = ? ORDER BY manga_id, tracker_id`,
            userId,
          ),
        )
      : new Map<number, TrackRow[]>();

    // Category membership and meta are joined against `manga` so that another
    // account's rows can never be reached through a shared child table.
    const memberships = new Map<number, number[]>();
    if (flags.includeCategories) {
      for (const row of db.all<{ manga_id: number; category_id: number }>(
        `SELECT cm.manga_id, cm.category_id FROM category_manga cm
         JOIN manga m ON m.id = cm.manga_id
         WHERE m.user_id = ?`,
        userId,
      )) {
        const list = memberships.get(row.manga_id);
        if (list) list.push(row.category_id);
        else memberships.set(row.manga_id, [row.category_id]);
      }
    }

    const metas = new Map<number, Record<string, string>>();
    if (flags.includeClientData) {
      for (const row of db.all<{ manga_id: number; key: string; value: string }>(
        `SELECT mm.manga_id, mm.key, mm.value FROM manga_meta mm
         JOIN manga m ON m.id = mm.manga_id
         WHERE m.user_id = ?`,
        userId,
      )) {
        const bag = metas.get(row.manga_id) ?? {};
        bag[row.key] = row.value;
        metas.set(row.manga_id, bag);
      }
    }

    for (const row of rows) {
      sourceIds.add(row.source_id);
      manga.push({
        id: row.id,
        sourceId: row.source_id,
        url: row.url,
        title: row.title,
        artist: row.artist,
        author: row.author,
        description: row.description,
        genre: parseGenre(row.genre),
        status: row.status,
        thumbnailUrl: row.thumbnail_url,
        realUrl: row.real_url,
        initialized: row.initialized === 1,
        inLibrary: row.in_library === 1,
        inLibraryAt: row.in_library_at,
        categories: memberships.get(row.id) ?? [],
        chapters: (chapters.get(row.id) ?? []).map((chapter) =>
          toChapter(chapter, flags.includeHistory),
        ),
        tracking: (tracks.get(row.id) ?? []).map(toTrack),
        meta: metas.get(row.id) ?? {},
      });
    }
  }

  const globalMeta: Record<string, string> = {};
  if (flags.includeClientData) {
    for (const row of db.all<{ key: string; value: string }>(
      'SELECT key, value FROM global_meta WHERE user_id = ?',
      userId,
    )) {
      globalMeta[row.key] = row.value;
    }
  }

  return {
    version: BACKUP_VERSION,
    app: BACKUP_APP,
    createdAt: Date.now(),
    sources: sourcesFor(sourceIds),
    categories,
    manga,
    globalMeta,
    settings: flags.includeServerSettings ? readSettings(db, userId) : null,
  };
}

// ------------------------------------------------------------------ writing --

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * `stremio4manga-2026-08-27T02-14-00.zip` — sorts by date as text, and reads as
 * the local time the person was looking at when it was taken rather than UTC.
 */
export function backupFilename(when: Date, suffix = 0): string {
  const stamp =
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `T${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`;
  return suffix === 0 ? `stremio4manga-${stamp}.zip` : `stremio4manga-${stamp}-${suffix}.zip`;
}

/**
 * Where one account's archives live. The username is the directory name, so a
 * name that could climb out of the tree is refused rather than sanitised —
 * `s4m users add` cannot produce one, and a database edited by hand should not
 * be able to write outside the data directory.
 */
export function backupDir(config: Config, userId: string): string {
  if (userId === '' || /[\\/]|^\.\.?$/.test(userId)) {
    throw new Error(`"${userId}" cannot be used as a backup directory name.`);
  }
  return join(dataPaths(config).backups, userId);
}

/** Take a backup and leave it on disk. Returns where it went, in both senses. */
export function createBackup(
  db: Db,
  config: Config,
  userId: string,
  flags: Partial<Record<keyof BackupFlags, boolean | null>> | BackupFlags = ALL_FLAGS,
): CreatedBackup {
  const resolved = resolveFlags(flags);
  const document = buildDocument(db, userId, resolved);

  const directory = backupDir(config, userId);
  mkdirSync(directory, { recursive: true });

  const when = new Date(document.createdAt);
  let filename = backupFilename(when);
  // Two backups inside one second are possible — a manual export next to the
  // nightly one — and the second must not silently replace the first.
  for (let suffix = 1; existsSync(join(directory, filename)) && suffix < 100; suffix += 1) {
    filename = backupFilename(when, suffix);
  }

  const path = join(directory, filename);
  writeFileSync(path, writeBackupZip(document, when));

  // Relative on purpose: the client turns it into an <a download> against its own
  // origin, and an absolute URL would break the moment the server moved hosts.
  return { filename, path, url: `/api/v1/backup/${encodeURIComponent(filename)}` };
}

export interface StoredBackup {
  filename: string;
  path: string;
  sizeBytes: number;
  createdAt: number;
}

/**
 * What is on disk for one account, newest first.
 *
 * This listing is also the security boundary for every by-name operation: a
 * filename from a client is looked up *in here* rather than joined onto the
 * directory, so `..`, an absolute path or a drive letter can only ever fail to
 * match. Building the path first and checking it afterwards is the version of
 * this that has a bug in it.
 */
export function listBackups(config: Config, userId: string): StoredBackup[] {
  const directory = backupDir(config, userId);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    // No directory yet simply means no backups yet.
    return [];
  }

  const files: StoredBackup[] = [];
  for (const name of names) {
    if (!name.endsWith('.zip')) continue;
    const path = join(directory, name);
    try {
      const stats = statSync(path);
      if (!stats.isFile()) continue;
      files.push({ filename: name, path, sizeBytes: stats.size, createdAt: stats.mtimeMs });
    } catch {
      // Vanished between the listing and the stat; it is simply not there.
    }
  }

  return files.sort((left, right) => right.createdAt - left.createdAt);
}

/** One stored backup by name, or undefined. Resolved against the listing, never joined. */
export function findBackup(config: Config, userId: string, filename: string): StoredBackup | undefined {
  return listBackups(config, userId).find((file) => file.filename === filename);
}
