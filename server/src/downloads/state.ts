/**
 * Whether an account's downloader is running, and how a mutation tells the loop
 * to look again.
 *
 * `DownloaderState` is per account because that is what the UI shows — one
 * person pausing must not pause the other's queue — but it is *not* a column.
 * It is runtime state on purpose: a server that came back up and silently
 * resumed downloading for everyone who happened to be running when it went down
 * is a surprise, and the client already re-arms it, because
 * `enqueueChapterDownloads` never starts the downloader and every caller that
 * enqueues also calls `startDownloader`.
 *
 * Kept in its own module so the queue store and the worker can both read it
 * without importing each other.
 */

/** Accounts whose downloader is STARTED. Absence is STOPPED. */
const running = new Set<string>();

/** The worker's "look again now" callback, if a worker is running at all. */
let listener: (() => void) | undefined;

export type DownloaderState = 'STARTED' | 'STOPPED';

export function downloaderState(userId: string): DownloaderState {
  return running.has(userId) ? 'STARTED' : 'STOPPED';
}

/**
 * Turning it on nudges the loop rather than waiting out its idle sleep, so the
 * enqueue/start pair the client sends feels immediate instead of taking up to a
 * second to show anything.
 */
export function setDownloaderState(userId: string, started: boolean): void {
  if (started) {
    running.add(userId);
    nudge();
  } else {
    running.delete(userId);
  }
}

/** Ask the loop to wake early. A no-op when no worker is running. */
export function nudge(): void {
  listener?.();
}

/** The worker registers here; the returned function unregisters it. */
export function onNudge(callback: () => void): () => void {
  listener = callback;
  return () => {
    if (listener === callback) listener = undefined;
  };
}

/** Only for the worker's own shutdown: nobody is STARTED once it is gone. */
export function clearDownloaderStates(): void {
  running.clear();
}
