/**
 * The native backup format: a ZIP archive holding one `backup.json`.
 *
 * A ZIP rather than a bare `.json.gz` because the file is something a person
 * downloads, keeps for a year and opens by double-clicking to see whether it is
 * really their library in there. Every operating system opens a ZIP; almost none
 * of them open a gzip stream. The archive holds exactly one entry today, but the
 * container leaves room for the covers or the read pages later without the file
 * extension having to change meaning.
 *
 * The reader and the writer are here rather than in a dependency because `node:zlib`
 * already does the only hard part. A ZIP is a sequence of local headers, a central
 * directory that repeats them, and a twenty-two byte trailer; the format is small
 * enough to write correctly and stable enough that it will never need to change
 * again. Only the two methods that matter are supported — stored and deflate.
 *
 * The JSON inside carries `version: 1`. Reading validates it: a file whose version
 * is unknown is refused with a sentence a person can act on rather than being
 * half-restored by a server that guessed at the shape.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { Settings } from '../graphql/resolvers/settings.js';

/** Bumped only when an older server could no longer read what a newer one writes. */
export const BACKUP_VERSION = 1;

/** The single entry every archive holds, and the one a reader looks for. */
export const BACKUP_ENTRY = 'backup.json';

/** Identifies our own archives; a file that says otherwise is not one of ours. */
export const BACKUP_APP = 'stremio4manga';

// ------------------------------------------------------------------- errors --

/** A file that is not a backup, or is one this server cannot read. */
export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

// ---------------------------------------------------------------------- zip --

interface ZipEntry {
  name: string;
  data: Buffer;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const STORED = 0;
const DEFLATED = 8;

/**
 * The standard CRC-32, built once. ZIP stores it per entry and a reader that
 * skips it cannot tell a truncated archive from a complete one.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = -1;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

/** MS-DOS packed date and time. Nothing reads them but every unzipper shows them. */
function dosStamp(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear());
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

/**
 * Build an archive. Entries are deflated unless deflating made them bigger, which
 * is what "stored" is for and what an already-compressed entry would hit.
 */
export function writeZip(entries: ZipEntry[], when = new Date()): Buffer {
  const { time, date } = dosStamp(when);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const stored = deflated.length >= entry.data.length;
    const payload = stored ? entry.data : deflated;
    const method = stored ? STORED : DEFLATED;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0, which is what deflate wants
    local.writeUInt16LE(0, 6); // no flags: sizes are known before writing
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, payload);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, end]);
}

/** Where the end-of-central-directory record starts, or -1. */
function findEndRecord(bytes: Buffer): number {
  // The record is 22 bytes plus a comment of at most 65535, so it cannot start
  // earlier than that from the end. Scanning backwards finds the real one first
  // even when the payload happens to contain the signature.
  const earliest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let index = bytes.length - 22; index >= earliest; index -= 1) {
    if (bytes.readUInt32LE(index) === EOCD_SIGNATURE) return index;
  }
  return -1;
}

/** Read an archive into `name -> bytes`. Throws BackupFormatError on anything malformed. */
export function readZip(bytes: Buffer): Map<string, Buffer> {
  if (bytes.length < 22) throw new BackupFormatError('That file is too small to be a backup.');

  const end = findEndRecord(bytes);
  if (end < 0) {
    throw new BackupFormatError('That file is not a ZIP archive, so it is not a backup.');
  }

  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new BackupFormatError('The backup archive has a damaged directory.');
    }
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;

    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new BackupFormatError(`The backup archive has no data for "${name}".`);
    }
    // The local header repeats the name and extra lengths and they may differ
    // from the directory's, so the payload offset has to come from here.
    const dataStart =
      localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    const payload = bytes.subarray(dataStart, dataStart + compressedSize);
    if (payload.length !== compressedSize) {
      throw new BackupFormatError('The backup archive is truncated.');
    }

    let data: Buffer;
    if (method === STORED) data = Buffer.from(payload);
    else if (method === DEFLATED) {
      try {
        data = inflateRawSync(payload);
      } catch {
        throw new BackupFormatError(`"${name}" inside the backup could not be decompressed.`);
      }
    } else {
      throw new BackupFormatError(`"${name}" uses an unsupported compression method.`);
    }

    if (data.length !== size || crc32(data) !== crc) {
      throw new BackupFormatError('The backup archive is corrupt — its checksum does not match.');
    }
    entries.set(name, data);
  }

  return entries;
}

// ----------------------------------------------------------------- document --

export interface BackupChapterEntry {
  url: string;
  name: string;
  scanlator: string | null;
  chapterNumber: number;
  /** 1-based position in the list the source returned; the reader route carries it. */
  sourceOrder: number;
  dateUpload: number;
  realUrl: string | null;
  isRead: boolean;
  isBookmarked: boolean;
  lastPageRead: number;
  /** Epoch ms; only the reader stamps it, so it is the "history" half of a backup. */
  lastReadAt: number;
  pageCount: number;
}

export interface BackupTrackEntry {
  trackerId: number;
  remoteId: string;
  title: string;
  lastChapterRead: number;
  totalChapters: number;
  status: number;
  score: number;
  remoteUrl: string | null;
  startDate: number;
  finishDate: number;
}

export interface BackupMangaEntry {
  /**
   * The row id on the server that wrote the archive. Never restored as an id —
   * it exists so references *between* entries survive the trip, specifically the
   * `stremio4manga.source-binding` meta, whose value is another entry's id.
   */
  id: number;
  sourceId: string;
  url: string;
  title: string;
  artist: string | null;
  author: string | null;
  description: string | null;
  genre: string[];
  status: string;
  thumbnailUrl: string | null;
  realUrl: string | null;
  initialized: boolean;
  inLibrary: boolean;
  inLibraryAt: number;
  /** Category ids as the exporting server numbered them; resolved by name on restore. */
  categories: number[];
  chapters: BackupChapterEntry[];
  tracking: BackupTrackEntry[];
  meta: Record<string, string>;
}

export interface BackupCategoryEntry {
  id: number;
  name: string;
  order: number;
}

/** Only so a restore can name a source it does not have, rather than show a number. */
export interface BackupSourceEntry {
  id: string;
  name: string;
}

export interface BackupDocument {
  version: number;
  app: string;
  createdAt: number;
  sources: BackupSourceEntry[];
  categories: BackupCategoryEntry[];
  manga: BackupMangaEntry[];
  globalMeta: Record<string, string>;
  settings: Partial<Settings> | null;
  /**
   * Trackers the archive referred to whose records could not be carried over.
   * Only a converted `.tachibk` sets it — our own export has nothing to drop —
   * and it exists so that validation can still name them, since by the time the
   * document is built their records are gone.
   */
  unsupportedTrackers?: number[];
}

// ---------------------------------------------------------------- coercions --

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asInteger(value: unknown, fallback = 0): number {
  const parsed = asNumber(value, fallback);
  return Number.isInteger(parsed) ? parsed : Math.trunc(parsed);
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A meta map, dropping anything that is not a string pair — the table cannot hold one. */
function asMeta(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function chapterFrom(value: unknown): BackupChapterEntry | null {
  if (!isRecord(value) || typeof value.url !== 'string' || value.url === '') return null;
  return {
    url: value.url,
    name: asString(value.name, value.url),
    scanlator: asNullableString(value.scanlator),
    chapterNumber: asNumber(value.chapterNumber, -1),
    sourceOrder: asInteger(value.sourceOrder, 0),
    dateUpload: asInteger(value.dateUpload, 0),
    realUrl: asNullableString(value.realUrl),
    isRead: asBoolean(value.isRead),
    isBookmarked: asBoolean(value.isBookmarked),
    lastPageRead: asInteger(value.lastPageRead, 0),
    lastReadAt: asInteger(value.lastReadAt, 0),
    pageCount: asInteger(value.pageCount, -1),
  };
}

function trackFrom(value: unknown): BackupTrackEntry | null {
  if (!isRecord(value)) return null;
  const trackerId = asInteger(value.trackerId, 0);
  const remoteId = typeof value.remoteId === 'string' ? value.remoteId : String(value.remoteId ?? '');
  if (trackerId <= 0 || remoteId === '') return null;
  return {
    trackerId,
    remoteId,
    title: asString(value.title),
    lastChapterRead: asNumber(value.lastChapterRead, 0),
    totalChapters: asInteger(value.totalChapters, 0),
    status: asInteger(value.status, 0),
    score: asNumber(value.score, 0),
    remoteUrl: asNullableString(value.remoteUrl),
    startDate: asInteger(value.startDate, 0),
    finishDate: asInteger(value.finishDate, 0),
  };
}

function mangaFrom(value: unknown): BackupMangaEntry | null {
  if (!isRecord(value)) return null;
  const sourceId = typeof value.sourceId === 'string' ? value.sourceId : String(value.sourceId ?? '');
  const url = asString(value.url);
  // Without both of these the entry has no identity and could only ever be
  // inserted again on every restore, so it is dropped rather than duplicated.
  if (sourceId === '' || url === '') return null;

  return {
    id: asInteger(value.id, 0),
    sourceId,
    url,
    title: asString(value.title, url),
    artist: asNullableString(value.artist),
    author: asNullableString(value.author),
    description: asNullableString(value.description),
    genre: asArray(value.genre).filter((item): item is string => typeof item === 'string'),
    status: asString(value.status, 'UNKNOWN'),
    thumbnailUrl: asNullableString(value.thumbnailUrl),
    realUrl: asNullableString(value.realUrl),
    initialized: asBoolean(value.initialized),
    inLibrary: value.inLibrary === undefined ? true : asBoolean(value.inLibrary),
    inLibraryAt: asInteger(value.inLibraryAt, 0),
    categories: asArray(value.categories)
      .map((item) => asInteger(item, -1))
      .filter((item) => item >= 0),
    chapters: asArray(value.chapters)
      .map(chapterFrom)
      .filter((item): item is BackupChapterEntry => item !== null),
    tracking: asArray(value.tracking)
      .map(trackFrom)
      .filter((item): item is BackupTrackEntry => item !== null),
    meta: asMeta(value.meta),
  };
}

function categoryFrom(value: unknown): BackupCategoryEntry | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name).trim();
  if (name === '') return null;
  return { id: asInteger(value.id, 0), name, order: asInteger(value.order, 0) };
}

function sourceFrom(value: unknown): BackupSourceEntry | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id : String(value.id ?? '');
  if (id === '') return null;
  return { id, name: asString(value.name, id) };
}

/**
 * Turn parsed JSON into a document, refusing what cannot be one and repairing
 * what can. Anything missing takes a defensible default: a backup written by an
 * older build should restore what it does carry rather than fail whole.
 */
export function parseDocument(value: unknown): BackupDocument {
  if (!isRecord(value)) throw new BackupFormatError('The backup does not contain a JSON object.');

  const version = asInteger(value.version, 0);
  if (version === 0) {
    throw new BackupFormatError('The backup does not say which format it is in.');
  }
  if (version > BACKUP_VERSION) {
    throw new BackupFormatError(
      `That backup is in format ${version}; this server reads up to ${BACKUP_VERSION}. Update the server first.`,
    );
  }

  const app = asString(value.app, BACKUP_APP);
  if (app !== BACKUP_APP) {
    throw new BackupFormatError(`That backup was written by "${app}", not by Stremio4Manga.`);
  }

  return {
    version,
    app,
    createdAt: asInteger(value.createdAt, 0),
    sources: asArray(value.sources)
      .map(sourceFrom)
      .filter((item): item is BackupSourceEntry => item !== null),
    categories: asArray(value.categories)
      .map(categoryFrom)
      .filter((item): item is BackupCategoryEntry => item !== null),
    manga: asArray(value.manga)
      .map(mangaFrom)
      .filter((item): item is BackupMangaEntry => item !== null),
    globalMeta: asMeta(value.globalMeta),
    settings: isRecord(value.settings) ? (value.settings as Partial<Settings>) : null,
    unsupportedTrackers: asArray(value.unsupportedTrackers)
      .map((item) => asInteger(item, 0))
      .filter((item) => item > 0),
  };
}

/** The archive bytes for a document. */
export function writeBackupZip(document: BackupDocument, when = new Date()): Buffer {
  // Two-space JSON: the file is meant to be openable, and the difference costs
  // almost nothing once deflate has seen the repetition.
  const json = Buffer.from(JSON.stringify(document, null, 2), 'utf8');
  return writeZip([{ name: BACKUP_ENTRY, data: json }], when);
}

/** The document inside an archive. */
export function readBackupZip(bytes: Buffer): BackupDocument {
  const entry = readZip(bytes).get(BACKUP_ENTRY);
  if (!entry) {
    throw new BackupFormatError(`That archive holds no ${BACKUP_ENTRY}, so it is not a backup.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.toString('utf8'));
  } catch {
    throw new BackupFormatError(`The ${BACKUP_ENTRY} inside the backup is not valid JSON.`);
  }
  return parseDocument(parsed);
}

/** `PK\x03\x04` — a local file header, which is how every ZIP starts. */
export function looksLikeZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === LOCAL_SIGNATURE;
}

/** The gzip magic. A `.tachibk` is gzip around protobuf and starts with it. */
export function looksLikeGzip(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}
