/**
 * Reading a backup from the Suwayomi server this one replaces.
 *
 * This is the reason the rest of the backup code exists. A `.tachibk` (or
 * `.proto.gz`) is gzip around a protobuf message that Tachiyomi defined and
 * Suwayomi extended, and it is the only complete record of a library that lived
 * in an H2 database no Node process can open. Nothing else carries the reading
 * progress across.
 *
 * The schema below is not guessed. It is transcribed from the Kotlin models in
 * the fork that wrote these files —
 * `suwayomi/tachidesk/manga/impl/backup/proto/models/*.kt`, where every field
 * carries an explicit `@ProtoNumber` — and checked against the bytes of a real
 * nightly backup. Three consequences of it being *kotlinx-serialization* rather
 * than protoc are worth knowing:
 *
 *   * A field equal to its Kotlin default is not written at all. `favorite`
 *     defaults to **true**, so an absent field 100 means favourite, and reading
 *     it as proto3's `false` would drop the whole library. Decoding therefore
 *     runs with `defaults: false` and every absence is decided here.
 *   * `Map<String, String>` is a repeated `{1: key, 2: value}` message, which is
 *     exactly what proto3's `map<string, string>` decodes.
 *   * Fields this file does not declare — the 9001 server settings block, the
 *     chapter `memo` — are skipped by their wire type, so the fork adding one
 *     more of them cannot break the import.
 *
 * What the format does **not** carry is any row id, so
 * `stremio4manga.source-binding` — whose value is another entry's id in the old
 * database — cannot be translated and is dropped by the restore rather than left
 * pointing at whatever now occupies that number. The bindings are the one thing
 * a migrated library has to be told again.
 */
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { parse as parseProto } from 'protobufjs';

import type { Db } from '../db/open.js';
import { allDefinitions, definitionById, getSource } from '../sources/registry.js';
import { ANILIST_SOURCE_ID, ANILIST_TRACKER_ID } from '../tracker/anilist.js';
import { applyDocument, type ApplySummary } from './apply.js';
import {
  BACKUP_APP,
  BACKUP_VERSION,
  BackupFormatError,
  type BackupChapterEntry,
  type BackupDocument,
  type BackupMangaEntry,
  type BackupSourceEntry,
  type BackupTrackEntry,
} from './format.js';

/** Transcribed from the fork's `@ProtoNumber` annotations. See the note above. */
const SCHEMA = `
syntax = "proto3";

message Backup {
  repeated BackupManga backupManga = 1;
  repeated BackupCategory backupCategories = 2;
  repeated BackupSource backupSources = 101;
  map<string, string> meta = 9000;
}

message BackupManga {
  int64 source = 1;
  string url = 2;
  string title = 3;
  string artist = 4;
  string author = 5;
  string description = 6;
  repeated string genre = 7;
  int32 status = 8;
  string thumbnailUrl = 9;
  int64 dateAdded = 13;
  repeated BackupChapter chapters = 16;
  repeated int32 categories = 17;
  repeated BackupTracking tracking = 18;
  bool favorite = 100;
  repeated BackupHistory history = 104;
  int64 lastModifiedAt = 106;
  bool initialized = 111;
  map<string, string> meta = 9000;
}

message BackupChapter {
  string url = 1;
  string name = 2;
  string scanlator = 3;
  bool read = 4;
  bool bookmark = 5;
  int32 lastPageRead = 6;
  int64 dateFetch = 7;
  int64 dateUpload = 8;
  float chapterNumber = 9;
  int32 sourceOrder = 10;
  int64 lastModifiedAt = 11;
  map<string, string> meta = 9000;
}

message BackupHistory {
  string url = 1;
  int64 lastRead = 2;
}

message BackupTracking {
  int32 syncId = 1;
  int64 libraryId = 2;
  string trackingUrl = 4;
  string title = 5;
  float lastChapterRead = 6;
  int32 totalChapters = 7;
  float score = 8;
  int32 status = 9;
  int64 startedReadingDate = 10;
  int64 finishedReadingDate = 11;
  int64 mediaId = 100;
}

message BackupCategory {
  string name = 1;
  int32 order = 2;
  map<string, string> meta = 9000;
}

message BackupSource {
  string name = 1;
  int64 sourceId = 2;
  map<string, string> meta = 9000;
}
`;

/** `SManga.status` as Tachiyomi numbers it; the order is ours too, by construction. */
const STATUSES = [
  'UNKNOWN',
  'ONGOING',
  'COMPLETED',
  'LICENSED',
  'PUBLISHING_FINISHED',
  'CANCELLED',
  'ON_HIATUS',
];

/**
 * Suwayomi's own "Default" is a real row at order 0; ours is virtual and never
 * stored. Importing it would create a category called Default sitting beside the
 * one the UI already derives, so it is dropped and its members simply come out
 * unfiled — which is what Default means here.
 */
const SUWAYOMI_DEFAULT_CATEGORY = 'Default';

// ------------------------------------------------------------------ decoding --

/** Shapes after `toObject({ longs: String })`: 64-bit values arrive as decimal strings. */
interface RawChapter {
  url?: string;
  name?: string;
  scanlator?: string;
  read?: boolean;
  bookmark?: boolean;
  lastPageRead?: number;
  dateUpload?: string;
  chapterNumber?: number;
  sourceOrder?: number;
  meta?: Record<string, string>;
}

interface RawTracking {
  syncId?: number;
  libraryId?: string;
  trackingUrl?: string;
  title?: string;
  lastChapterRead?: number;
  totalChapters?: number;
  score?: number;
  status?: number;
  startedReadingDate?: string;
  finishedReadingDate?: string;
  mediaId?: string;
}

interface RawManga {
  source?: string;
  url?: string;
  title?: string;
  artist?: string;
  author?: string;
  description?: string;
  genre?: string[];
  status?: number;
  thumbnailUrl?: string;
  dateAdded?: string;
  chapters?: RawChapter[];
  categories?: number[];
  tracking?: RawTracking[];
  favorite?: boolean;
  history?: { url?: string; lastRead?: string }[];
  initialized?: boolean;
  meta?: Record<string, string>;
}

interface RawBackup {
  backupManga?: RawManga[];
  backupCategories?: { name?: string; order?: number }[];
  backupSources?: { name?: string; sourceId?: string }[];
  meta?: Record<string, string>;
}

let cachedType: ReturnType<typeof parseProto>['root'] | undefined;

function backupType() {
  cachedType ??= parseProto(SCHEMA).root;
  return cachedType.lookupType('Backup');
}

/** Epoch milliseconds from a decimal string, ignoring anything that is not one. */
function millis(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

// ------------------------------------------------------------ source mapping --

function normalise(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function hostKey(url: string): string | undefined {
  try {
    return normalise(new URL(url).hostname.replace(/^www\./, '').replace(/\.[a-z.]+$/, ''));
  } catch {
    return undefined;
  }
}

/**
 * Every spelling of one of our sources: its display name, its package slug and
 * the domain it reads from. A keiyoushi extension calls itself the same thing the
 * site does, so name and domain between them catch the ones we have — "Asura
 * Scans" against `asurascans`, "Comick" against `comick.io`.
 */
function nativeSourceKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const definition of allDefinitions()) {
    const add = (key: string | undefined): void => {
      if (key && key !== '' && !keys.has(key)) keys.set(key, definition.id);
    };
    add(normalise(definition.name));
    add(normalise(definition.pkgName));
    const source = getSource(definition.id);
    if (source) add(hostKey(source.baseUrl));
  }
  return keys;
}

interface SourceResolution {
  /** The source id to store. Ours when matched, the file's own when not. */
  id: string;
  matched: boolean;
}

/**
 * Which of our sources a backup source is, if any.
 *
 * An unmatched source keeps its original id rather than being dropped. The UI
 * already draws "source not installed" for a library entry it cannot resolve,
 * and a row that shows a title and remembers where the reader got to is worth
 * far more than the reading progress that dropping it would throw away.
 */
function resolveSource(
  sourceId: string,
  name: string | undefined,
  url: string,
  keys: Map<string, string>,
): SourceResolution {
  // Suwayomi's id 1 is the AniList pseudo-source, and every entry it holds has an
  // `anilist:<mediaId>` url. Either signal alone is enough.
  if (sourceId === '1' || url.startsWith('anilist:')) {
    return { id: ANILIST_SOURCE_ID, matched: true };
  }
  const byName = name ? keys.get(normalise(name)) : undefined;
  if (byName) return { id: byName, matched: true };
  const byHost = keys.get(hostKey(url) ?? '');
  if (byHost) return { id: byHost, matched: true };
  return { id: sourceId, matched: false };
}

// ------------------------------------------------------------------- mapping --

function toChapters(raw: RawManga): BackupChapterEntry[] {
  const chapters = raw.chapters ?? [];
  if (chapters.length === 0) return [];

  // `includeHistory` writes the read stamps into a separate list keyed by chapter
  // url; the chapter itself only says *whether* it was read.
  const lastReadByUrl = new Map<string, number>();
  for (const entry of raw.history ?? []) {
    if (!entry.url) continue;
    const stamp = millis(entry.lastRead);
    lastReadByUrl.set(entry.url, Math.max(lastReadByUrl.get(entry.url) ?? 0, stamp));
  }

  // Suwayomi numbers chapters from 1 and Tachiyomi from 0. Shifting a list whose
  // lowest order is 0 keeps our own 1-based reader routes valid either way.
  const lowest = Math.min(...chapters.map((chapter) => chapter.sourceOrder ?? 0));
  const shift = lowest === 0 ? 1 : 0;

  const out: BackupChapterEntry[] = [];
  for (const chapter of chapters) {
    if (!chapter.url) continue;
    out.push({
      url: chapter.url,
      name: chapter.name ?? chapter.url,
      scanlator: chapter.scanlator ?? null,
      chapterNumber: typeof chapter.chapterNumber === 'number' ? chapter.chapterNumber : -1,
      sourceOrder: (chapter.sourceOrder ?? 0) + shift,
      dateUpload: millis(chapter.dateUpload),
      realUrl: null,
      isRead: chapter.read === true,
      isBookmarked: chapter.bookmark === true,
      lastPageRead: chapter.lastPageRead ?? 0,
      lastReadAt: lastReadByUrl.get(chapter.url) ?? 0,
      pageCount: -1,
    });
  }
  return out;
}

function toTracking(raw: RawManga): { records: BackupTrackEntry[]; otherTrackers: number[] } {
  const records: BackupTrackEntry[] = [];
  const otherTrackers: number[] = [];

  for (const track of raw.tracking ?? []) {
    const trackerId = track.syncId ?? 0;
    if (trackerId !== ANILIST_TRACKER_ID) {
      if (trackerId > 0) otherTrackers.push(trackerId);
      continue;
    }
    // `mediaId` is the AniList work; `libraryId` is the reader's list entry for
    // it. Everything downstream looks a title up by the former.
    const remoteId = millis(track.mediaId) || millis(track.libraryId);
    if (remoteId === 0) continue;
    records.push({
      trackerId,
      remoteId: String(remoteId),
      title: track.title ?? '',
      lastChapterRead: track.lastChapterRead ?? 0,
      totalChapters: track.totalChapters ?? 0,
      status: track.status ?? 0,
      score: track.score ?? 0,
      remoteUrl: track.trackingUrl ?? null,
      startDate: millis(track.startedReadingDate),
      finishDate: millis(track.finishedReadingDate),
    });
  }

  return { records, otherTrackers };
}

export interface TachibkReading {
  document: BackupDocument;
  /** Sources referenced by the file that this server has no native equivalent for. */
  unmatchedSources: BackupSourceEntry[];
  /** Tracker ids other than AniList; their records are not imported. */
  otherTrackers: number[];
}

/** Decode a `.tachibk`'s bytes into the document the restore path already speaks. */
export function readTachibk(bytes: Buffer): TachibkReading {
  let inflated: Buffer;
  try {
    inflated = gunzipSync(bytes);
  } catch {
    throw new BackupFormatError('That file is not a Suwayomi backup — it is not gzip.');
  }

  let raw: RawBackup;
  try {
    const type = backupType();
    // `defaults: false` is deliberate: kotlinx omits a field equal to its Kotlin
    // default, and those defaults are not always proto3's. See the note above.
    raw = type.toObject(type.decode(inflated), { longs: String }) as RawBackup;
  } catch (error) {
    throw new BackupFormatError(
      `That file is not a readable Suwayomi backup: ${(error as Error).message}`,
    );
  }

  const keys = nativeSourceKeys();
  const namesById = new Map<string, string>();
  for (const source of raw.backupSources ?? []) {
    if (source.sourceId) namesById.set(source.sourceId, source.name ?? `Source ${source.sourceId}`);
  }

  const categories = (raw.backupCategories ?? [])
    .map((category, index) => ({
      id: category.order ?? index,
      name: (category.name ?? '').trim(),
      order: category.order ?? index,
    }))
    .filter(
      (category) =>
        category.name !== '' &&
        !(category.name === SUWAYOMI_DEFAULT_CATEGORY && category.order === 0),
    );

  const manga: BackupMangaEntry[] = [];
  const unmatched = new Map<string, string>();
  const otherTrackers = new Set<number>();
  // Keyed by the id the entries end up carrying, which is ours when a source
  // matched and the file's own when it did not.
  const sourceNames = new Map<string, string>();

  for (const entry of raw.backupManga ?? []) {
    const url = entry.url ?? '';
    if (url === '') continue;

    const sourceId = entry.source ?? '0';
    const name = namesById.get(sourceId);
    const resolved = resolveSource(sourceId, name, url, keys);
    if (resolved.matched) {
      // Our name for it, not the extension's: "Comick" in a keiyoushi backup is
      // the source this server calls "ComicK", and the reader should see ours.
      sourceNames.set(
        resolved.id,
        resolved.id === ANILIST_SOURCE_ID
          ? 'AniList'
          : (definitionById(resolved.id)?.name ?? name ?? `Source ${resolved.id}`),
      );
    } else {
      const label = name ?? `Source ${resolved.id}`;
      unmatched.set(resolved.id, label);
      sourceNames.set(resolved.id, label);
    }

    const tracking = toTracking(entry);
    for (const tracker of tracking.otherTrackers) otherTrackers.add(tracker);

    const added = millis(entry.dateAdded);
    manga.push({
      // No row ids exist in this format, so nothing can refer to another entry.
      id: 0,
      sourceId: resolved.id,
      url,
      title: entry.title ?? url,
      artist: entry.artist ?? null,
      author: entry.author ?? null,
      description: entry.description ?? null,
      genre: entry.genre ?? [],
      status: STATUSES[entry.status ?? 0] ?? 'UNKNOWN',
      thumbnailUrl: entry.thumbnailUrl ?? null,
      realUrl: null,
      initialized: entry.initialized === true,
      // Absent means true: `favorite` defaults to true in Kotlin and is therefore
      // never written for a title that is in the library.
      inLibrary: entry.favorite !== false,
      inLibraryAt: added,
      categories: entry.categories ?? [],
      chapters: toChapters(entry),
      tracking: tracking.records,
      meta: entry.meta ?? {},
    });
  }

  const sources: BackupSourceEntry[] = [...sourceNames.entries()].map(([id, name]) => ({ id, name }));

  return {
    document: {
      version: BACKUP_VERSION,
      app: BACKUP_APP,
      createdAt: Date.now(),
      sources,
      categories,
      manga,
      globalMeta: raw.meta ?? {},
      // The 9001 server-settings block is Suwayomi's own configuration — download
      // paths, ports, extension repositories — and none of it means anything here.
      settings: null,
      unsupportedTrackers: [...otherTrackers],
    },
    unmatchedSources: [...unmatched.entries()].map(([id, name]) => ({ id, name })),
    otherTrackers: [...otherTrackers],
  };
}

// -------------------------------------------------------------------- import --

export interface ImportOptions {
  /** Read and map the file, report what it holds, write nothing. */
  dryRun?: boolean;
  onProgress?(done: number, total: number): void;
}

export interface ImportSummary extends ApplySummary {
  /** Sources the file references that this server cannot read from. */
  unmatchedSources: BackupSourceEntry[];
  /** Trackers other than AniList; their records were not imported. */
  otherTrackers: number[];
  /** Bindings the format cannot carry — see the note at the top of this file. */
  droppedBindings: number;
}

/**
 * The migration entry point: read one `.tachibk` off disk into an account.
 *
 * Merges, like every other restore here, so running it twice imports nothing the
 * second time and running it against an account that has already been used adds
 * to what is there instead of replacing it.
 */
export async function importTachibk(
  db: Db,
  userId: string,
  filePath: string,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  if (!db.get('SELECT 1 FROM users WHERE username = ?', userId)) {
    throw new Error(`No account "${userId}". Create it first: s4m users add ${userId}`);
  }

  const { document, unmatchedSources, otherTrackers } = readTachibk(readFileSync(filePath));
  const droppedBindings = document.manga.filter(
    (entry) => entry.meta['stremio4manga.source-binding'] !== undefined,
  ).length;

  if (options.dryRun) {
    return {
      manga: document.manga.length,
      chapters: document.manga.reduce((total, entry) => total + entry.chapters.length, 0),
      categories: document.categories.length,
      tracks: document.manga.reduce((total, entry) => total + entry.tracking.length, 0),
      // Minus the bindings, which a real run would drop, so that a dry run
      // predicts the number the real one reports rather than a larger one.
      metas:
        Object.keys(document.globalMeta).length +
        document.manga.reduce((total, entry) => total + Object.keys(entry.meta).length, 0) -
        droppedBindings,
      unmatchedSources,
      otherTrackers,
      droppedBindings,
    };
  }

  const summary = await applyDocument(db, userId, document, {
    onProgress: options.onProgress,
  });

  return { ...summary, unmatchedSources, otherTrackers, droppedBindings };
}
