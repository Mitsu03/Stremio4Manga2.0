/**
 * Reading a backup back in: what it would need, and then doing it.
 *
 * Two halves the UI uses in order. `validateBackup` opens the archive and says
 * what it references that this server has not got — sources that are not
 * compiled in, trackers that are not this server's tracker — so that the
 * confirmation can name them before anything is written. `restoreBackup` then
 * starts the work and returns immediately with an id the client polls.
 *
 * **Restoring is asynchronous and the progress lives in this process's memory.**
 * A restart mid-restore loses the status, not the work: everything already
 * written stays written, and because the whole thing is idempotent by natural
 * key, running the same archive again finishes the job rather than duplicating
 * the half that landed. The client polls until `SUCCESS` or `FAILURE` and a
 * status it has never heard of comes back null, which it treats as finished.
 *
 * Both entry points accept either format. A `.zip` is one of ours; a `.tachibk`
 * or `.proto.gz` is the Suwayomi server this replaces, and being able to drop one
 * straight into the import box is the whole point of the migration.
 */
import { randomUUID } from 'node:crypto';

import type { Db } from '../db/open.js';
import type { UploadedFile } from '../graphql/multipart.js';
import { definitionById } from '../sources/registry.js';
import { ANILIST_SOURCE_ID, ANILIST_TRACKER_ID } from '../tracker/anilist.js';
import { applyDocument, type ApplyPhase } from './apply.js';
import { BackupFormatError, looksLikeGzip, looksLikeZip, readBackupZip } from './format.js';
import type { BackupDocument } from './format.js';
import { readTachibk } from './tachibk.js';

export type BackupRestoreState =
  | 'IDLE'
  | 'SUCCESS'
  | 'FAILURE'
  | 'RESTORING_CATEGORIES'
  | 'RESTORING_MANGA'
  | 'RESTORING_META'
  | 'RESTORING_SETTINGS';

export interface BackupRestoreStatus {
  state: BackupRestoreState;
  totalManga: number;
  mangaProgress: number;
}

export interface RestorePayload {
  id: string;
  status: BackupRestoreStatus;
}

export interface ValidateBackupResult {
  missingSources: { id: string; name: string }[];
  missingTrackers: { name: string }[];
}

/**
 * The tracker ids Tachiyomi handed out, so a backup that mentions one can name
 * it instead of showing a number. Only AniList exists here.
 */
const TRACKER_NAMES: Record<number, string> = {
  1: 'MyAnimeList',
  2: 'AniList',
  3: 'Kitsu',
  4: 'Shikimori',
  5: 'Bangumi',
  6: 'Komga',
  7: 'MangaUpdates',
  8: 'Kavita',
  9: 'Suwayomi',
};

// -------------------------------------------------------------------- input --

function bytesOf(file: UploadedFile | Buffer): Buffer {
  return Buffer.isBuffer(file) ? file : Buffer.from(file.bytes);
}

/** Whichever of the two formats this is, as the one document shape. */
export function readBackup(file: UploadedFile | Buffer): BackupDocument {
  const bytes = bytesOf(file);
  if (looksLikeZip(bytes)) return readBackupZip(bytes);
  if (looksLikeGzip(bytes)) return readTachibk(bytes).document;
  throw new BackupFormatError(
    'That is not a backup. Expected a .zip written by this server, or a .tachibk from the old one.',
  );
}

// ----------------------------------------------------------------- validate --

/**
 * What the archive references that this server has not got.
 *
 * A missing source is not a reason to refuse the restore — the entries come in
 * anyway and the UI draws them as "source not installed" — but it is a reason to
 * say so first, because a reader whose library came back unreadable deserves to
 * have been told which sites it was read from.
 *
 * A tracker counts as missing when this server has no such tracker *or* when the
 * account is not signed in to it, which is the same question from the reader's
 * side: either way, nothing will sync.
 */
export function validateBackup(
  db: Db,
  userId: string,
  file: UploadedFile | Buffer,
): ValidateBackupResult {
  const document = readBackup(file);

  const names = new Map(document.sources.map((source) => [source.id, source.name]));
  const missingSources: { id: string; name: string }[] = [];
  const seen = new Set<string>();

  for (const entry of document.manga) {
    if (seen.has(entry.sourceId)) continue;
    seen.add(entry.sourceId);
    if (entry.sourceId === ANILIST_SOURCE_ID) continue;
    if (definitionById(entry.sourceId)) continue;
    missingSources.push({
      id: entry.sourceId,
      name: names.get(entry.sourceId) ?? `Source ${entry.sourceId}`,
    });
  }

  const trackers = new Set<number>(document.unsupportedTrackers ?? []);
  for (const entry of document.manga) {
    for (const track of entry.tracking) trackers.add(track.trackerId);
  }

  const signedIn =
    db.get('SELECT 1 FROM tracker_credential WHERE user_id = ? AND tracker_id = ?', userId, ANILIST_TRACKER_ID) !==
    undefined;

  const missingTrackers: { name: string }[] = [];
  for (const trackerId of trackers) {
    if (trackerId === ANILIST_TRACKER_ID && signedIn) continue;
    missingTrackers.push({ name: TRACKER_NAMES[trackerId] ?? `Tracker ${trackerId}` });
  }
  missingTrackers.sort((left, right) => left.name.localeCompare(right.name));
  missingSources.sort((left, right) => left.name.localeCompare(right.name));

  return { missingSources, missingTrackers };
}

// ------------------------------------------------------------------ restore --

interface RestoreRecord extends BackupRestoreStatus {
  userId: string;
  /** When it reached a terminal state, for the pruning below. */
  finishedAt: number;
}

const restores = new Map<string, RestoreRecord>();

/** How long a finished restore stays queryable. The client polls every second. */
const KEEP_FINISHED_MS = 30 * 60 * 1000;

/**
 * Drop finished restores that nobody is polling any more.
 *
 * Called on every write rather than on a timer: the map only grows when somebody
 * restores something, so there is nothing to sweep between restores and no reason
 * to hold a timer open for it.
 */
function prune(): void {
  const now = Date.now();
  for (const [id, record] of restores) {
    if (record.finishedAt !== 0 && now - record.finishedAt > KEEP_FINISHED_MS) restores.delete(id);
  }
}

const PHASE_STATE: Record<ApplyPhase, BackupRestoreState> = {
  categories: 'RESTORING_CATEGORIES',
  manga: 'RESTORING_MANGA',
  meta: 'RESTORING_META',
  settings: 'RESTORING_SETTINGS',
};

/** The state of a restore, to the account that started it and to nobody else. */
export function restoreStatus(userId: string, id: string): BackupRestoreStatus | null {
  const record = restores.get(id);
  if (!record || record.userId !== userId) return null;
  return {
    state: record.state,
    totalManga: record.totalManga,
    mangaProgress: record.mangaProgress,
  };
}

function isRunning(userId: string): boolean {
  for (const record of restores.values()) {
    if (record.userId === userId && record.finishedAt === 0) return true;
  }
  return false;
}

/**
 * Start restoring, and answer before any of it has happened.
 *
 * The archive is parsed *before* returning, so a file that is not a backup fails
 * the mutation itself rather than becoming a restore that reports FAILURE a
 * second later with nothing to say about why.
 */
export function restoreBackup(
  db: Db,
  userId: string,
  file: UploadedFile | Buffer,
  onError?: (message: string) => void,
): RestorePayload {
  prune();
  if (isRunning(userId)) {
    throw new Error('A restore is already running for this account. Wait for it to finish.');
  }

  const document = readBackup(file);
  const id = randomUUID();
  const record: RestoreRecord = {
    userId,
    state: 'RESTORING_CATEGORIES',
    totalManga: document.manga.length,
    mangaProgress: 0,
    finishedAt: 0,
  };
  restores.set(id, record);

  // Deliberately not awaited: the mutation answers now and the client polls.
  void applyDocument(db, userId, document, {
    onPhase: (phase) => {
      record.state = PHASE_STATE[phase];
    },
    onProgress: (done, total) => {
      record.mangaProgress = done;
      record.totalManga = total;
    },
  }).then(
    () => {
      record.state = 'SUCCESS';
      record.mangaProgress = record.totalManga;
      record.finishedAt = Date.now();
    },
    (error: unknown) => {
      record.state = 'FAILURE';
      record.finishedAt = Date.now();
      // The client is only told FAILURE; the reason belongs in the server log,
      // where it can name the row that broke without leaking the schema.
      onError?.(`Restore ${id} for ${userId} failed: ${(error as Error).message}`);
    },
  );

  return {
    id,
    status: { state: record.state, totalManga: record.totalManga, mangaProgress: 0 },
  };
}
