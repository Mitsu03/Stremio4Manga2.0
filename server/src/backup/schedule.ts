/**
 * The nightly backup: the one thing in the server that acts with nobody watching.
 *
 * The server this replaces ran the same job and never told anyone — a reader's
 * library had been snapshotted every night for weeks with no screen anywhere
 * saying so. What is here is deliberately the same behaviour with the state made
 * readable: `lastRun` is written to the account's settings, which is what the
 * Settings page's "last run 18 h ago" line is built from.
 *
 * The loop is a plain interval, five minutes apart, checking every account. That
 * is coarse on purpose. A backup is due at a time of day, not at an instant; a
 * job that wakes every second to discover it has nothing to do is a job that
 * keeps a laptop's CPU warm for no reason. The timer is `unref`ed so it can never
 * be the reason the process stays alive.
 *
 * Missing a slot is survivable. The rule is "enough time has passed *and* the
 * time of day has come round", so a server that was off at 02:00 takes its backup
 * at the next check after it comes back, rather than skipping the night.
 */
import { unlinkSync } from 'node:fs';

import type { Config } from '../config.js';
import type { Db } from '../db/open.js';
import type { Logger } from '../types.js';
import { readSettings, type Settings } from '../graphql/resolvers/settings.js';
import { createBackup, listBackups, type BackupFlags } from './create.js';

/**
 * Where the stamp lives. It is a row in the same table as the schedule itself,
 * but not a field of `SettingsType`: the client reads it through
 * `automatedBackups.lastRun` and must never be able to set it.
 */
export const LAST_RUN_KEY = 'lastAutomatedBackup';

/** Coarse on purpose — see the note above. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** The first check is late enough not to compete with the server starting up. */
const FIRST_CHECK_MS = 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface ScheduleDeps {
  config: Config;
  db: Db;
  log: Logger;
}

/** When the account's last automated backup finished, or 0. */
export function readLastRun(db: Db, userId: string): number {
  const row = db.get<{ value: string }>(
    'SELECT value FROM settings WHERE user_id = ? AND key = ?',
    userId,
    LAST_RUN_KEY,
  );
  if (!row) return 0;
  try {
    const parsed: unknown = JSON.parse(row.value);
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeLastRun(db: Db, userId: string, when: number): void {
  db.run(
    `INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
    userId,
    LAST_RUN_KEY,
    JSON.stringify(when),
  );
}

/** "HH:MM" as minutes past local midnight. Settings validation guarantees the shape. */
function slotMinutes(backupTime: string): number {
  const [hours, minutes] = backupTime.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Is a backup due for this account right now?
 *
 * `backupInterval` is a number of hours, and 0 switches the job off entirely.
 * Once enough of them have passed, an interval of a day or more waits for the
 * time of day as well, which is what stops a daily backup from drifting an hour
 * later every night. A shorter interval has no such anchor and simply runs.
 */
export function isDue(now: Date, lastRun: number, settings: Settings): boolean {
  if (settings.backupInterval <= 0) return false;

  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const atOrPastSlot = minutesNow >= slotMinutes(settings.backupTime);

  // Never run before: take the first one at the first slot that comes round,
  // rather than the moment the server happens to start.
  if (lastRun === 0) return atOrPastSlot;

  const elapsed = now.getTime() - lastRun;
  if (elapsed < settings.backupInterval * HOUR_MS) return false;
  return settings.backupInterval * HOUR_MS < DAY_MS || atOrPastSlot;
}

function flagsFrom(settings: Settings): BackupFlags {
  return {
    includeManga: settings.autoBackupIncludeManga,
    includeCategories: settings.autoBackupIncludeCategories,
    includeChapters: settings.autoBackupIncludeChapters,
    includeTracking: settings.autoBackupIncludeTracking,
    includeHistory: settings.autoBackupIncludeHistory,
    includeClientData: settings.autoBackupIncludeClientData,
    includeServerSettings: settings.autoBackupIncludeServerSettings,
  };
}

/**
 * Delete what has aged out. `backupTTL` of 0 keeps everything forever, and the
 * newest archive is never deleted whatever the TTL says — a reader who set the
 * TTL to one day and then did not open the app for a week should still have
 * something to restore from.
 */
function applyTtl(config: Config, userId: string, settings: Settings, log: Logger): void {
  if (settings.backupTTL <= 0) return;
  const cutoff = Date.now() - settings.backupTTL * DAY_MS;
  const files = listBackups(config, userId);

  for (const file of files.slice(1)) {
    if (file.createdAt >= cutoff) continue;
    try {
      unlinkSync(file.path);
    } catch (error) {
      log.warn(`Could not delete the expired backup ${file.filename}: ${(error as Error).message}`);
    }
  }
}

function runOnce(deps: ScheduleDeps, now = new Date()): void {
  const users = deps.db.all<{ username: string }>('SELECT username FROM users');

  for (const { username } of users) {
    let settings: Settings;
    try {
      settings = readSettings(deps.db, username);
    } catch (error) {
      deps.log.error(`Could not read backup settings for ${username}: ${(error as Error).message}`);
      continue;
    }

    if (!isDue(now, readLastRun(deps.db, username), settings)) continue;

    try {
      const created = createBackup(deps.db, deps.config, username, flagsFrom(settings));
      // Stamped after the file exists, so a crash mid-write leaves the slot still
      // due rather than recording a backup that was never finished.
      writeLastRun(deps.db, username, Date.now());
      deps.log.info(`Automated backup for ${username}: ${created.filename}`);
      applyTtl(deps.config, username, settings, deps.log);
    } catch (error) {
      // One account's failure must not stop the others', and a failed night is
      // not a reason to bring the server down.
      deps.log.error(`Automated backup for ${username} failed: ${(error as Error).message}`);
    }
  }
}

/** Start the job. The returned function stops it and is safe to call twice. */
export function startBackupSchedule(deps: ScheduleDeps): () => void {
  const check = (): void => {
    try {
      runOnce(deps);
    } catch (error) {
      deps.log.error(`The backup schedule failed: ${(error as Error).stack ?? String(error)}`);
    }
  };

  const first = setTimeout(check, FIRST_CHECK_MS);
  const repeat = setInterval(check, CHECK_INTERVAL_MS);
  // Neither may hold the process open: a server told to shut down should not wait
  // five minutes for a timer that had nothing to do.
  first.unref();
  repeat.unref();

  return () => {
    clearTimeout(first);
    clearInterval(repeat);
  };
}
