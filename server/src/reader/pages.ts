/**
 * Where a page's bytes come from.
 *
 * Three places, in this order: the chapter's download, the page cache, and the
 * source itself. Only the first is permanent — a download is something the
 * reader asked for and expects to survive going offline, and it belongs to
 * `downloads/`, which owns both the layout and the two finished forms (a folder
 * of images, or a CBZ). This module only ever reads them, through
 * `chapterLocation`, so the writer stays the only thing that decides where a
 * chapter lives.
 *
 * The cache is disposable by design: keyed by chapter id and page index, never
 * invalidated, and deleting the whole directory costs nothing but the next
 * chapter being slower. That is deliberate. A cache with an invalidation policy
 * is a second source of truth about what a chapter contains, and the source
 * already is one.
 *
 * The page *list*, by contrast, is stored rather than cached, because it is what
 * the reader's routes index into: `/api/v1/manga/:mangaId/chapter/:sourceOrder/page/:n`
 * is only meaningful against a fixed list, and re-asking the source mid-chapter
 * could quietly renumber it under the reader.
 */
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { extname, join } from 'node:path';

import { dataPaths, type Config } from '../config.js';
import type { Db } from '../db/open.js';
import type { Logger } from '../types.js';
import { chapterLocation, pageFileName, type ChapterLocation } from '../downloads/paths.js';
import { getSource, sourceHttpFor } from '../sources/registry.js';
import type { Source } from '../sources/types.js';

export interface ReaderDeps {
  config: Config;
  db: Db;
  log: Logger;
}

export interface PageRow {
  chapter_id: number;
  idx: number;
  url: string;
  image_url: string | null;
}

/** Bytes plus the one header a browser needs to render them. */
export interface ImageBytes {
  bytes: Buffer;
  contentType: string;
}

// ------------------------------------------------------------- file types --

const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
};

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
};

const typeForFile = (name: string): string =>
  IMAGE_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';

const isImageName = (name: string): boolean => extname(name).toLowerCase() in IMAGE_TYPES;

/** `001` — the stem `downloads/paths.ts` writes and this module looks for. */
const pageStem = (index: number): string => String(index + 1).padStart(3, '0');

function extensionFor(contentType: string, url: string): string {
  const type = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const known = EXTENSION_BY_TYPE[type];
  if (known) return known;
  const guess = /\.(jpe?g|png|webp|gif|avif|bmp|tiff)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  if (guess) return guess === 'jpeg' ? 'jpg' : guess;
  // Every source here serves JPEG or WebP; an unlabelled body is far more likely
  // to be the former than to be undisplayable.
  return 'jpg';
}

/**
 * A username is already constrained to `[a-z0-9][a-z0-9._-]{0,31}` by the
 * account CLI, so it is a legal directory name. This is the belt to that
 * braces: an id that ever stopped being constrained must not become a path.
 */
function userDir(userId: string): string {
  const safe = userId.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
  return safe === '' || safe === '.' || safe === '..' ? '_' : safe;
}

/**
 * The disposable half of the layout. Opaque ids rather than titles, unlike the
 * download tree: nobody browses this directory, and a chapter renamed by its
 * source must not strand its own cache under the old name.
 */
export function chapterCacheDir(config: Config, userId: string, chapterId: number): string {
  return join(dataPaths(config).cache, userDir(userId), String(chapterId));
}

export function thumbnailDir(config: Config, userId: string): string {
  return join(dataPaths(config).thumbnails, userDir(userId));
}

/** The file for `stem` whatever extension it was saved under, or null. */
function findFile(directory: string, stem: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    // A missing directory is the common case, not an error.
    return null;
  }
  for (const entry of entries) {
    const extension = extname(entry);
    if (entry.slice(0, entry.length - extension.length) !== stem) continue;
    if (!isImageName(entry)) continue;
    const file = join(directory, entry);
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      // Vanished between listing and stat; keep looking.
    }
  }
  return null;
}

/**
 * A cached or downloaded image, or null if it has gone.
 *
 * Null rather than a throw: a file deleted out from under the cache is a reason
 * to fetch it again, not a reason to fail the request.
 */
export function readImageFile(file: string): ImageBytes | null {
  try {
    return { bytes: readFileSync(file), contentType: typeForFile(file) };
  } catch {
    return null;
  }
}

/**
 * Write through a temporary name.
 *
 * A cache entry is only useful if it is whole: a torn file left behind by a
 * crash mid-write would be served as a broken image for as long as the cache
 * lived, and the cache is never invalidated.
 */
function writeAtomic(directory: string, name: string, bytes: Buffer, log: Logger): void {
  try {
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `.${name}.part`);
    writeFileSync(temporary, bytes);
    renameSync(temporary, join(directory, name));
  } catch (error) {
    // The bytes are already in hand and about to be served; failing to keep a
    // copy is slower next time, not a failure now.
    log.warn(`could not cache ${name}: ${(error as Error).message}`);
  }
}

// ------------------------------------------------------------- cbz reading --

/**
 * Just enough ZIP to read one entry out of a CBZ.
 *
 * `downloads/zip.ts` writes the archives and deliberately writes the simplest
 * subset there is — no ZIP64, no encryption, no data descriptors, store or
 * deflate — so this is its mirror image and no more. It reads through the
 * central directory rather than scanning, and pulls only the one entry's bytes
 * off disk: a chapter can be sixty megabytes and a page request wants one of
 * them.
 */
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
/** 22 bytes of record plus the largest comment a u16 length can describe. */
const EOCD_SEARCH_BYTES = 22 + 0xffff;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const read = readSync(fd, buffer, filled, length - filled, position + filled);
    if (read === 0) break;
    filled += read;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}

function zipEntries(fd: number, size: number): ZipEntry[] {
  const tailLength = Math.min(size, EOCD_SEARCH_BYTES);
  const tail = readAt(fd, size - tailLength, tailLength);

  let eocd = -1;
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return [];

  const count = tail.readUInt16LE(eocd + 10);
  const directorySize = tail.readUInt32LE(eocd + 12);
  const directoryStart = tail.readUInt32LE(eocd + 16);
  const directory = readAt(fd, directoryStart, directorySize);

  const entries: ZipEntry[] = [];
  let cursor = 0;
  for (let index = 0; index < count && cursor + 46 <= directory.length; index += 1) {
    if (directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    entries.push({
      name: directory.toString('utf8', cursor + 46, cursor + 46 + nameLength),
      method: directory.readUInt16LE(cursor + 10),
      compressedSize: directory.readUInt32LE(cursor + 20),
      localOffset: directory.readUInt32LE(cursor + 42),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(fd: number, entry: ZipEntry): Buffer | null {
  const header = readAt(fd, entry.localOffset, 30);
  if (header.length < 30) return null;
  // The local header repeats the name and may carry different extra fields from
  // the central one, so its own lengths are the ones that locate the data.
  const dataStart =
    entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const stored = readAt(fd, dataStart, entry.compressedSize);
  if (stored.length !== entry.compressedSize) return null;
  if (entry.method === 0) return stored;
  if (entry.method !== 8) return null;
  try {
    return inflateRawSync(stored);
  } catch {
    return null;
  }
}

/** The images in a CBZ, in the order their zero-padded names sort. */
function cbzPages(file: string): string[] {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    return zipEntries(fd, statSync(file).size)
      .map((entry) => entry.name)
      .filter(isImageName)
      .sort();
  } finally {
    closeSync(fd);
  }
}

function readCbzPage(file: string, index: number): ImageBytes | null {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const entries = zipEntries(fd, statSync(file).size)
      .filter((entry) => isImageName(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    // Matched by position rather than by name: the archive is written from the
    // same zero-padded list this index counts, and a source that changed a page
    // extension between download and read should still find its page.
    const entry = entries[index];
    if (!entry) return null;
    const bytes = readZipEntry(fd, entry);
    return bytes ? { bytes, contentType: typeForFile(entry.name) } : null;
  } finally {
    closeSync(fd);
  }
}

// ------------------------------------------------------------ downloaded --

/**
 * Whichever finished form the download took, or null when there is none.
 *
 * The two forms are the account's own preference (`downloads.cbz`), and either
 * may be on disk from before it was changed, so both are looked for rather than
 * the current setting being trusted.
 */
interface Downloaded {
  count: number;
  read(index: number): ImageBytes | null;
}

function downloadedChapter(config: Config, place: ChapterPlace): Downloaded | null {
  const location: ChapterLocation = chapterLocation(config, {
    userId: place.userId,
    sourceId: place.sourceId,
    mangaTitle: place.mangaTitle,
    chapterId: place.id,
    chapterName: place.chapterName,
    scanlator: place.scanlator,
  });

  let folderPages: string[] = [];
  try {
    folderPages = readdirSync(location.dir).filter(isImageName).sort();
  } catch {
    // No folder form; the CBZ may still be there.
  }
  if (folderPages.length > 0) {
    return {
      count: folderPages.length,
      read: (index) => {
        const name = folderPages[index];
        return name ? readImageFile(join(location.dir, name)) : null;
      },
    };
  }

  const archived = cbzPages(location.cbz);
  if (archived.length > 0) {
    return { count: archived.length, read: (index) => readCbzPage(location.cbz, index) };
  }
  return null;
}

// -------------------------------------------------------------- http --

/**
 * The registry's own client, per source.
 *
 * Not a second one built here: the per-host queue, the cookie jar, the
 * Cloudflare clearance and the circuit breaker all live on the single client,
 * and a second would let the reader and a search hit the same site at the same
 * moment, each paying none of the other's spacing.
 */
async function fetchImage(source: Source | undefined, url: string, what: string): Promise<ImageBytes> {
  // A Referer, usually. Several of these sites serve a placeholder — or a 403 —
  // to an image request that does not look like it came from one of their pages.
  const headers = source?.imageHeaders?.(url);
  const http = sourceHttpFor({ sourceName: source?.name ?? 'That cover' });
  const response = await http.raw(url, headers ? { headers } : {});
  const contentType = response.headers.get('content-type') ?? '';
  const bytes = Buffer.from(await response.arrayBuffer());

  if (bytes.length === 0) throw new Error(`${what} came back empty.`);
  // An HTML body here is an error page wearing a 200, which is common enough on
  // scanlation hosts that storing it would poison the cache with a login form.
  if (contentType !== '' && !contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`${what} answered with ${contentType} rather than an image.`);
  }
  return { bytes, contentType };
}

// ------------------------------------------------------------ chapter row --

/** A chapter and the manga it hangs off, in the one query both are needed in. */
export interface ChapterPlace {
  id: number;
  userId: string;
  mangaId: number;
  chapterUrl: string;
  chapterName: string;
  scanlator: string | null;
  sourceOrder: number;
  chapterNumber: number;
  pageCount: number;
  isDownloaded: boolean;
  sourceId: string;
  mangaUrl: string;
  mangaTitle: string;
}

interface PlaceRow {
  id: number;
  user_id: string;
  manga_id: number;
  chapter_url: string;
  chapter_name: string;
  scanlator: string | null;
  source_order: number;
  chapter_number: number;
  page_count: number;
  is_downloaded: number;
  source_id: string;
  manga_url: string;
  manga_title: string;
}

const PLACE_SELECT = `
  SELECT c.id             AS id,
         c.user_id        AS user_id,
         c.manga_id       AS manga_id,
         c.url            AS chapter_url,
         c.name           AS chapter_name,
         c.scanlator      AS scanlator,
         c.source_order   AS source_order,
         c.chapter_number AS chapter_number,
         c.page_count     AS page_count,
         c.is_downloaded  AS is_downloaded,
         m.source_id      AS source_id,
         m.url            AS manga_url,
         m.title          AS manga_title
    FROM chapter c
    JOIN manga m ON m.id = c.manga_id AND m.user_id = c.user_id
`;

function toPlace(row: PlaceRow): ChapterPlace {
  return {
    id: row.id,
    userId: row.user_id,
    mangaId: row.manga_id,
    chapterUrl: row.chapter_url,
    chapterName: row.chapter_name,
    scanlator: row.scanlator,
    sourceOrder: row.source_order,
    chapterNumber: row.chapter_number,
    pageCount: row.page_count,
    isDownloaded: row.is_downloaded === 1,
    sourceId: row.source_id,
    mangaUrl: row.manga_url,
    mangaTitle: row.manga_title,
  };
}

export function locateChapter(db: Db, userId: string, chapterId: number): ChapterPlace | null {
  const row = db.get<PlaceRow>(`${PLACE_SELECT} WHERE c.id = ? AND c.user_id = ?`, chapterId, userId);
  return row ? toPlace(row) : null;
}

/** The reader's own coordinates: a manga and a position in its chapter list. */
export function locateBySourceOrder(
  db: Db,
  userId: string,
  mangaId: number,
  sourceOrder: number,
): ChapterPlace | null {
  const row = db.get<PlaceRow>(
    `${PLACE_SELECT} WHERE c.user_id = ? AND c.manga_id = ? AND c.source_order = ?`,
    userId,
    mangaId,
    sourceOrder,
  );
  return row ? toPlace(row) : null;
}

// -------------------------------------------------------------- page list --

function storedPages(db: Db, chapterId: number): PageRow[] {
  return db.all<PageRow>(
    'SELECT chapter_id, idx, url, image_url FROM page WHERE chapter_id = ? ORDER BY idx',
    chapterId,
  );
}

function writePages(db: Db, userId: string, chapterId: number, rows: PageRow[]): void {
  db.transaction(() => {
    db.run('DELETE FROM page WHERE chapter_id = ?', chapterId);
    for (const row of rows) {
      db.run(
        'INSERT INTO page (chapter_id, idx, url, image_url) VALUES (?, ?, ?, ?)',
        chapterId,
        row.idx,
        row.url,
        row.image_url,
      );
    }
    syncPageCount(db, userId, chapterId, rows.length);
  });
}

function syncPageCount(db: Db, userId: string, chapterId: number, count: number): void {
  db.run(
    'UPDATE chapter SET page_count = ? WHERE id = ? AND user_id = ? AND page_count <> ?',
    count,
    chapterId,
    userId,
    count,
  );
}

/**
 * The chapter's page list, asking the source only when there is no list yet.
 *
 * `image_url` is written straight away for the ordinary source, which hands out
 * image URLs; it is left null for the few that hand out a *page* URL and reveal
 * the image only on a second request. Null therefore means "not resolved yet",
 * which is exactly what the column was put in the schema for, and it is filled
 * the first time that page is read.
 */
export async function ensureChapterPages(
  deps: ReaderDeps,
  userId: string,
  chapterId: number,
): Promise<PageRow[]> {
  const { config, db } = deps;
  const existing = storedPages(db, chapterId);
  if (existing.length > 0) {
    // `pageCount` is what the reader draws its progress bar against, so it is
    // kept honest against the list rather than trusted from whenever it was set.
    syncPageCount(db, userId, chapterId, existing.length);
    return existing;
  }

  const place = locateChapter(db, userId, chapterId);
  if (!place) return [];

  // A chapter already on disk needs no network: the files are the list. This is
  // what makes a downloaded library readable when the source is unreachable, and
  // what makes it survive a database restored from a backup that carried the
  // chapters but not their pages.
  const downloaded = downloadedChapter(config, place);
  if (downloaded) {
    const rows = Array.from({ length: downloaded.count }, (_unused, index) => ({
      chapter_id: chapterId,
      idx: index,
      // Nothing remote to point at; the bytes are local by definition.
      url: '',
      image_url: '',
    }));
    writePages(db, userId, chapterId, rows);
    return rows;
  }

  const source = getSource(place.sourceId);
  if (!source) {
    throw new Error(
      `"${place.mangaTitle}" was added from a source (id ${place.sourceId}) this server no longer has.`,
    );
  }

  const pages = [...(await source.getPageList({ url: place.chapterUrl }))].sort(
    (left, right) => left.index - right.index,
  );
  const rows: PageRow[] = pages.map((page, index) => ({
    chapter_id: chapterId,
    // Renumbered rather than trusted: the reader indexes this list positionally,
    // and a source that skips a number would leave a hole nothing can fetch.
    idx: index,
    url: page.url,
    image_url: page.needsResolve ? null : page.url,
  }));

  writePages(db, userId, chapterId, rows);
  return rows;
}

// ------------------------------------------------------------ page images --

/**
 * The image behind a page, resolving it once for the sources that publish a page
 * URL first and writing the answer back so no later read pays for it.
 */
async function resolveImageUrl(db: Db, source: Source | undefined, page: PageRow): Promise<string | null> {
  if (page.image_url) return page.image_url;
  // The empty url is a downloaded chapter's page list: there is nothing remote
  // behind it, so a missing file is a missing page rather than a fetch.
  if (page.url === '') return null;
  if (!source?.resolveImageUrl) return page.url;

  const resolved = await source.resolveImageUrl({ index: page.idx, url: page.url, needsResolve: true });
  if (!resolved) return null;
  db.run(
    'UPDATE page SET image_url = ? WHERE chapter_id = ? AND idx = ?',
    resolved,
    page.chapter_id,
    page.idx,
  );
  return resolved;
}

/**
 * One page, from wherever it can be had.
 *
 * Null means "no such page", which the API layer turns into a 404: a page index
 * past the end of the chapter, and a chapter belonging to another account, are
 * the same answer as far as a caller is concerned.
 */
export async function readPage(
  deps: ReaderDeps,
  userId: string,
  mangaId: number,
  sourceOrder: number,
  index: number,
): Promise<ImageBytes | null> {
  const { config, db, log } = deps;
  const place = locateBySourceOrder(db, userId, mangaId, sourceOrder);
  if (!place) return null;

  const pages = await ensureChapterPages(deps, userId, place.id);
  if (!Number.isInteger(index) || index < 0 || index >= pages.length) return null;
  const page = pages[index];

  const downloaded = downloadedChapter(config, place);
  if (downloaded) {
    const bytes = downloaded.read(index);
    if (bytes) return bytes;
  }

  const cacheDirectory = chapterCacheDir(config, userId, place.id);
  const cached = findFile(cacheDirectory, pageStem(index));
  if (cached) {
    const bytes = readImageFile(cached);
    if (bytes) return bytes;
  }

  const source = getSource(place.sourceId);
  const imageUrl = await resolveImageUrl(db, source, page);
  if (!imageUrl) return null;

  const image = await fetchImage(source, imageUrl, `Page ${index + 1}`);
  writeAtomic(
    cacheDirectory,
    pageFileName(index, extensionFor(image.contentType, imageUrl)),
    image.bytes,
    log,
  );
  return image;
}

// -------------------------------------------------------------- thumbnails --

interface CoverRow {
  thumbnail_url: string | null;
  source_id: string;
}

/**
 * A manga's cover, cached on disk under the account that asked for it.
 *
 * The cover of an AniList shell comes from AniList's own CDN and has no source
 * behind it, so the fetch falls back to a bound client with no per-source
 * headers — which is all that host wants anyway.
 */
export async function readThumbnail(
  deps: ReaderDeps,
  userId: string,
  mangaId: number,
): Promise<ImageBytes | null> {
  const { config, db, log } = deps;
  const row = db.get<CoverRow>(
    'SELECT thumbnail_url, source_id FROM manga WHERE id = ? AND user_id = ?',
    mangaId,
    userId,
  );
  if (!row?.thumbnail_url) return null;

  const directory = thumbnailDir(config, userId);
  const stem = String(mangaId);
  const cached = findFile(directory, stem);
  if (cached) {
    const bytes = readImageFile(cached);
    if (bytes) return bytes;
  }

  const source = getSource(row.source_id);
  const image = await fetchImage(source, row.thumbnail_url, 'That cover');
  writeAtomic(
    directory,
    `${stem}.${extensionFor(image.contentType, row.thumbnail_url)}`,
    image.bytes,
    log,
  );
  return image;
}
