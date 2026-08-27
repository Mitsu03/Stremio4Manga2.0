/**
 * The downloader: one loop, every account.
 *
 * The server this replaces ran a downloader per JVM, so fairness was a
 * scheduling problem the operating system solved. Here there is one process, so
 * it is solved on purpose:
 *
 *   * **One loop.** It wakes, fills whatever download slots are free, and sleeps
 *     again. There is no timer per account and no busy-wait — an idle server
 *     does one `SELECT` a second and nothing else.
 *   * **Round-robin between accounts.** Slots are handed out walking the list of
 *     accounts-with-work in order, *starting after whoever was served last*, so
 *     a queue of six hundred chapters cannot starve the person who queued one.
 *   * **One chapter at a time per account**, and its pages strictly
 *     sequentially, through the shared HTTP client. Two accounts downloading
 *     from the same site still meet that site's per-host queue, so they take
 *     turns there rather than doubling the request rate.
 *
 * A chapter that fails does not stop anything: it goes to the back of the queue
 * for another try, and after `MAX_TRIES` it sits in ERROR with the reason, where
 * the UI can show it and the person can dequeue it.
 *
 * Nothing here writes to the database once `stop()` has been called, because
 * `main.ts` closes the database immediately afterwards and an in-flight fetch
 * can still be a second away from returning.
 */
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Config } from '../config.js';
import type { Db } from '../db/open.js';
import type { Logger } from '../types.js';
import { getSource } from '../sources/registry.js';
import type { Source } from '../sources/types.js';

import { fetchPage } from './images.js';
import { chapterLocation, pageFileName, type ChapterLocation } from './paths.js';
import { createCbzWriter } from './zip.js';
import {
  clearDownloaderStates,
  downloaderState,
  onNudge,
  setDownloaderState,
} from './state.js';
import {
  hasQueuedWork,
  nextQueued,
  queueRow,
  releaseInFlight,
  usersWithWork,
  type QueueRow,
} from './store.js';

/** How long the loop sleeps with nothing to do. The client polls at the same rate. */
const IDLE_MS = 1_000;
/**
 * Chapters in flight across the whole server. Three is enough that a second and
 * third account see immediate progress, and small enough that the shared HTTP
 * client's global ceiling is still what limits the traffic.
 */
const MAX_ACTIVE = 3;
/** Attempts per chapter before it stops being retried. */
const MAX_TRIES = 3;

/** Where the UI keeps its preferences; one JSON blob of strings per account. */
const SETTINGS_META_KEY = 'stremio4manga.settings';
/** `flag()` in the client encodes booleans as 'on'/'off'. */
const CBZ_PREFERENCE = 'downloads.cbz';

/**
 * Whether this account wants one `.cbz` per chapter instead of a folder.
 *
 * Read per chapter rather than cached: it is one indexed lookup against a table
 * the account has open anyway, and caching it would mean a preference change
 * only taking effect after a restart.
 */
function downloadAsCbz(db: Db, userId: string): boolean {
  const row = db.get<{ value: string }>(
    'SELECT value FROM global_meta WHERE user_id = ? AND key = ?',
    userId,
    SETTINGS_META_KEY,
  );
  if (!row) return false;
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object') return false;
    return (parsed as Record<string, unknown>)[CBZ_PREFERENCE] === 'on';
  } catch {
    // Hand-edited or written by a newer client. Absent means the default.
    return false;
  }
}

interface ChapterRow {
  id: number;
  manga_id: number;
  url: string;
  name: string;
  scanlator: string | null;
  source_id: string;
  manga_title: string;
  manga_url: string;
}

/** Why a chapter stopped short of being written. */
type Outcome = 'done' | 'paused' | 'failed';

export interface DownloadWorkerDeps {
  config: Config;
  db: Db;
  log: Logger;
}

export function startDownloadWorker(deps: DownloadWorkerDeps): () => void {
  const { config, db, log } = deps;

  let stopped = false;
  /** Accounts with a chapter in flight, one entry each. */
  const active = new Map<string, Promise<void>>();
  /** The last account handed a slot — where the next round-robin pass resumes. */
  let lastServed: string | undefined;
  /** Resolves the current sleep early. Replaced on every sleep. */
  let wake: (() => void) | undefined;

  // A row left DOWNLOADING belongs to a process that is no longer running: this
  // one is starting, and nothing else writes that state.
  releaseInFlight(db);

  const alive = (): boolean => !stopped;

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, ms);
      // The loop must never be the reason the process stays up.
      timer.unref();
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
    });
  }

  const unregister = onNudge(() => wake?.());

  // ------------------------------------------------------------ one chapter --

  /**
   * True while this chapter should keep going: the worker is running, the
   * account has not paused, and the row is still queued to *this* attempt.
   *
   * Checked between pages rather than only at the start, because pausing, and
   * dequeuing a chapter that is already downloading, are both things the UI lets
   * someone do mid-chapter.
   */
  function stillWanted(userId: string, row: QueueRow): boolean {
    if (!alive() || downloaderState(userId) !== 'STARTED') return false;
    return queueRow(db, row.id)?.state === 'DOWNLOADING';
  }

  function chapterOf(userId: string, chapterId: number): ChapterRow | undefined {
    return db.get<ChapterRow>(
      `SELECT c.id, c.manga_id, c.url, c.name, c.scanlator,
              m.source_id, m.title AS manga_title, m.url AS manga_url
       FROM chapter c JOIN manga m ON m.id = c.manga_id
       WHERE c.id = ? AND c.user_id = ?`,
      chapterId,
      userId,
    );
  }

  /**
   * Which page numbers already have a file in the partial folder.
   *
   * A paused or failed chapter keeps what it downloaded, so resuming asks the
   * site only for what is missing. Re-fetching thirty images somebody already
   * has is exactly the traffic the politeness rules exist to avoid.
   */
  async function alreadyOnDisk(directory: string): Promise<Set<string>> {
    try {
      const names = await readdir(directory);
      return new Set(
        // `NNN.jpg.part` is a write that did not finish, so it counts as absent.
        names.filter((name) => !name.endsWith('.part')).map((name) => name.split('.')[0]),
      );
    } catch {
      return new Set();
    }
  }

  /**
   * Turns the finished partial folder into whichever form the account asked for.
   *
   * Both forms are produced under a temporary name and moved into place, so an
   * interruption leaves either the old state or the new one — never a half
   * chapter that `is_downloaded` would then call complete. The other form is
   * removed on the way, which is what makes switching the preference tidy up
   * after itself.
   */
  async function finish(location: ChapterLocation, asCbz: boolean): Promise<void> {
    if (!asCbz) {
      await rm(location.cbz, { force: true });
      await rm(location.dir, { recursive: true, force: true });
      await rename(location.partial, location.dir);
      return;
    }

    const pending = `${location.cbz}.part`;
    await rm(pending, { force: true });
    const file = await open(pending, 'w');
    try {
      const writer = createCbzWriter(file);
      // Alphabetical is page order: the names are zero-padded for that reason.
      for (const name of (await readdir(location.partial)).sort()) {
        await writer.add(name, await readFile(join(location.partial, name)));
      }
      await writer.finish();
    } finally {
      await file.close();
    }

    await rm(location.dir, { recursive: true, force: true });
    await rename(pending, location.cbz);
    await rm(location.partial, { recursive: true, force: true });
  }

  async function downloadChapter(userId: string, row: QueueRow): Promise<Outcome> {
    const chapter = chapterOf(userId, row.chapter_id);
    if (!chapter) {
      // The chapter row is gone; the queue entry is meaningless. Not an error
      // worth showing anybody.
      db.run('DELETE FROM download_queue WHERE id = ?', row.id);
      return 'failed';
    }

    const source: Source | undefined = getSource(chapter.source_id);
    if (!source) {
      throw new Error(
        'That source is no longer part of this server, so its chapters cannot be downloaded.',
      );
    }

    const location = chapterLocation(config, {
      userId,
      sourceId: chapter.source_id,
      mangaTitle: chapter.manga_title,
      chapterId: chapter.id,
      chapterName: chapter.name,
      scanlator: chapter.scanlator,
    });

    const pages = await source.getPageList({ url: chapter.url });
    if (pages.length === 0) throw new Error('The source returned no pages for this chapter.');
    if (!stillWanted(userId, row)) return 'paused';

    await mkdir(location.partial, { recursive: true });
    const present = await alreadyOnDisk(location.partial);

    for (let index = 0; index < pages.length; index += 1) {
      if (!stillWanted(userId, row)) return 'paused';

      const number = String(index + 1).padStart(3, '0');
      if (!present.has(number)) {
        const { bytes, extension } = await fetchPage(config, source, pages[index]);
        // Written under a temporary name and moved, so a page interrupted
        // mid-write is not mistaken for one already on disk by the resume above.
        const target = join(location.partial, pageFileName(index, extension));
        const partial = `${target}.part`;
        await writeFile(partial, bytes);
        await rename(partial, target);
      }

      if (!alive()) return 'paused';
      db.run(
        "UPDATE download_queue SET progress = ? WHERE id = ? AND state = 'DOWNLOADING'",
        (index + 1) / pages.length,
        row.id,
      );
    }

    if (!stillWanted(userId, row)) return 'paused';
    await finish(location, downloadAsCbz(db, userId));
    if (!alive()) return 'paused';

    db.transaction(() => {
      db.run(
        'UPDATE chapter SET is_downloaded = 1, page_count = ? WHERE id = ? AND user_id = ?',
        pages.length,
        chapter.id,
        userId,
      );
      // The entry leaves the queue the moment the chapter is on disk. That is
      // the old server's contract and the UI reads a chapter *leaving* as the
      // signal that it finished.
      db.run('DELETE FROM download_queue WHERE id = ?', row.id);
    });
    return 'done';
  }

  /** Marks a failed attempt: another go at the back of the queue, or ERROR. */
  function recordFailure(userId: string, row: QueueRow, error: unknown): void {
    if (!alive()) return;
    const message = error instanceof Error ? error.message : String(error);
    // `row` is the claimed row, whose `tries` was already incremented when this
    // attempt began; counting again here would skip every other retry.
    const tries = row.tries;

    if (tries < MAX_TRIES) {
      // To the back, not back to the front: a chapter whose source is having a
      // bad minute must not hold up the forty behind it.
      db.transaction(() => {
        const tail = db.get<{ next: number }>(
          'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM download_queue WHERE user_id = ?',
          userId,
        );
        db.run(
          "UPDATE download_queue SET state = 'QUEUED', progress = 0, tries = ?, error = ?, position = ? WHERE id = ?",
          tries,
          message,
          tail?.next ?? row.position,
          row.id,
        );
      });
      log.warn(`Download of chapter ${row.chapter_id} failed (try ${tries}): ${message}`);
      return;
    }

    db.run(
      "UPDATE download_queue SET state = 'ERROR', progress = 0, tries = ?, error = ? WHERE id = ?",
      tries,
      message,
      row.id,
    );
    log.error(`Giving up on chapter ${row.chapter_id} after ${tries} tries: ${message}`);
  }

  /** One slot's worth of work. Never throws — the loop must survive anything. */
  async function runSlot(userId: string): Promise<void> {
    const row = nextQueued(db, userId);
    if (!row) {
      // The queue drained between the slot being handed out and this running.
      // Leaving the account STARTED would keep its client polling forever.
      setDownloaderState(userId, false);
      return;
    }

    db.run(
      "UPDATE download_queue SET state = 'DOWNLOADING', tries = ?, error = NULL WHERE id = ? AND state = 'QUEUED'",
      row.tries + 1,
      row.id,
    );
    const claimed: QueueRow = { ...row, state: 'DOWNLOADING', tries: row.tries + 1 };

    try {
      const outcome = await downloadChapter(userId, claimed);
      if (outcome === 'paused' && alive()) {
        // Pausing does not count as a try, and the row goes back where it was.
        // No `state = 'DOWNLOADING'` guard: `stopDownloader` has usually already
        // put the row back to QUEUED, and the try it consumed still has to be
        // handed back. The row id is this attempt's own, so nothing else can be
        // holding it — a dequeue in the meantime simply changes no rows.
        db.run(
          "UPDATE download_queue SET state = 'QUEUED', tries = ? WHERE id = ?",
          row.tries,
          row.id,
        );
      }
    } catch (error) {
      recordFailure(userId, claimed, error);
    }

    // The downloader turns itself off when there is nothing left, which is what
    // the client expects: it re-arms with `startDownloader` on the next enqueue.
    if (alive() && !hasQueuedWork(db, userId)) setDownloaderState(userId, false);
  }

  // -------------------------------------------------------------- the loop --

  function fillSlots(): void {
    if (active.size >= MAX_ACTIVE) return;
    const users = usersWithWork(db).filter((user) => downloaderState(user) === 'STARTED');
    if (users.length === 0) return;

    // Resume the rotation just past whoever went last. The list is sorted, so
    // "the next name after `lastServed`" is a stable place to start even when
    // accounts have joined or drained since.
    const previous = lastServed;
    let start = previous === undefined ? 0 : users.findIndex((user) => user > previous);
    if (start < 0) start = 0;

    for (let step = 0; step < users.length && active.size < MAX_ACTIVE; step += 1) {
      const user = users[(start + step) % users.length];
      if (active.has(user)) continue;
      lastServed = user;
      const task = runSlot(user)
        .catch((error: unknown) => {
          log.error(`Downloader slot for ${user} failed: ${(error as Error).message}`);
        })
        .finally(() => {
          active.delete(user);
          // A freed slot is worth filling now rather than at the next tick.
          wake?.();
        });
      active.set(user, task);
    }
  }

  void (async () => {
    while (alive()) {
      try {
        fillSlots();
      } catch (error) {
        log.error(`Downloader loop: ${(error as Error).message}`);
      }
      await sleep(IDLE_MS);
    }
  })();

  return () => {
    if (stopped) return;
    stopped = true;
    unregister();
    wake?.();
    // Nobody is running once the worker is gone, and the rows have to say so:
    // an in-flight chapter is left with its pages in `.part`, its queue entry
    // QUEUED, and nothing claiming to be downloading it.
    clearDownloaderStates();
    try {
      releaseInFlight(db);
    } catch (error) {
      // The database may already be closing. Nothing left to salvage, and the
      // next start normalises these rows anyway.
      log.warn(`Could not reset in-flight downloads: ${(error as Error).message}`);
    }
  };
}
