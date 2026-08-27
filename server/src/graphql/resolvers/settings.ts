/**
 * Server-side settings: the automated-backup schedule and what it includes.
 *
 * This is the small half of "settings" — everything a *person* tweaks (theme,
 * reader layout, language) is client state and lives in global meta. What is here
 * is the handful of values the server itself acts on while nobody is looking, so
 * the backup scheduler can read them without a browser in the loop.
 *
 * One row per key, value as JSON, defaults supplied when a row is missing. That
 * keeps a new setting from needing a migration: an account that has never opened
 * the settings page has no rows at all and still reads a complete `SettingsType`.
 */
import { GraphQLError } from 'graphql';
import type { Db } from '../../db/open.js';
import type { GraphQLContext } from '../../types.js';
import type { ResolverGroup } from './index.js';

export interface Settings {
  backupInterval: number;
  backupTime: string;
  backupTTL: number;
  autoBackupIncludeManga: boolean;
  autoBackupIncludeCategories: boolean;
  autoBackupIncludeChapters: boolean;
  autoBackupIncludeTracking: boolean;
  autoBackupIncludeHistory: boolean;
  autoBackupIncludeClientData: boolean;
  autoBackupIncludeServerSettings: boolean;
}

/**
 * `backupInterval: 0` means the schedule is off, which is the only safe default:
 * a server that starts writing archives on its own the moment it boots is a
 * surprise. Every include is on except the server's own settings, which restoring
 * would silently rewrite the schedule the person is looking at.
 */
export const DEFAULT_SETTINGS: Settings = {
  backupInterval: 0,
  backupTime: '02:00',
  backupTTL: 14,
  autoBackupIncludeManga: true,
  autoBackupIncludeCategories: true,
  autoBackupIncludeChapters: true,
  autoBackupIncludeTracking: true,
  autoBackupIncludeHistory: true,
  autoBackupIncludeClientData: true,
  autoBackupIncludeServerSettings: false,
};

type SettingKey = keyof Settings;

const KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A stored value only counts if it still has the shape the field promises. */
function coerce(key: SettingKey, raw: string): Settings[SettingKey] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const fallback = DEFAULT_SETTINGS[key];
  if (typeof fallback === 'boolean') return typeof parsed === 'boolean' ? parsed : undefined;
  if (typeof fallback === 'number') {
    return typeof parsed === 'number' && Number.isInteger(parsed) && parsed >= 0
      ? parsed
      : undefined;
  }
  return typeof parsed === 'string' && TIME.test(parsed) ? parsed : undefined;
}

/**
 * The account's settings, defaults filled in. Exported because the backup
 * scheduler reads the same values from outside any request.
 */
export function readSettings(db: Db, userId: string): Settings {
  const rows = db.all<{ key: string; value: string }>(
    'SELECT key, value FROM settings WHERE user_id = ?',
    userId,
  );
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of KEYS) {
    const raw = stored.get(key);
    if (raw === undefined) continue;
    const value = coerce(key, raw);
    // A value that no longer fits reads as the default rather than failing the
    // whole query; the next write replaces it.
    if (value !== undefined) (settings as Record<string, unknown>)[key] = value;
  }
  return settings;
}

function validate(key: SettingKey, value: unknown): string | number | boolean {
  const fallback = DEFAULT_SETTINGS[key];
  if (typeof fallback === 'boolean') {
    if (typeof value !== 'boolean') throw new GraphQLError(`${key} must be true or false.`);
    return value;
  }
  if (typeof fallback === 'number') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new GraphQLError(`${key} must be a whole number of days, zero or more.`);
    }
    if (value > 3650) throw new GraphQLError(`${key} is unreasonably large.`);
    return value;
  }
  if (typeof value !== 'string' || !TIME.test(value)) {
    throw new GraphQLError('backupTime must be a 24-hour time, "HH:MM".');
  }
  return value;
}

export const group: ResolverGroup = {
  Query: {
    settings: (_parent: unknown, _args: unknown, context: GraphQLContext): Settings =>
      readSettings(context.db, context.userId),
  },

  Mutation: {
    setSettings: (
      _parent: unknown,
      args: { input: { settings: Partial<Record<SettingKey, unknown>> } },
      context: GraphQLContext,
    ) => {
      const patch = args.input.settings ?? {};
      const writes: [SettingKey, string][] = [];
      for (const key of KEYS) {
        // Absent and null both mean "leave this one alone": the client sends a
        // patch of the two or three fields the page it is on can change.
        const given = patch[key];
        if (given === undefined || given === null) continue;
        writes.push([key, JSON.stringify(validate(key, given))]);
      }

      return context.db.transaction(() => {
        for (const [key, value] of writes) {
          context.db.run(
            `INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
             ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
            context.userId,
            key,
            value,
          );
        }
        return { settings: readSettings(context.db, context.userId) };
      });
    },
  },
};
