/**
 * The one database handle, and the only place that knows how to make one.
 *
 * node:sqlite is built into Node, which is what keeps this server free of native
 * modules: an install is `npm ci` and a `node dist/main.js`, with nothing to
 * compile on the target machine.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import schema from './schema.sql';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations.js';

export type Row = Record<string, unknown>;
export type Param = string | number | null | Uint8Array;

export interface Db {
  all<T = Row>(sql: string, ...params: Param[]): T[];
  get<T = Row>(sql: string, ...params: Param[]): T | undefined;
  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number };
  transaction<T>(work: () => T): T;
  close(): void;
  readonly raw: DatabaseSync;
}

/** SQLite has no boolean; every flag column is 0 or 1. */
export const bool = (value: boolean): number => (value ? 1 : 0);
export const fromBool = (value: unknown): boolean => value === 1 || value === true;

/**
 * Bring the database at `file` up to SCHEMA_VERSION, or refuse to touch it.
 *
 * SQLite's `user_version` is a single integer in the file header that belongs
 * to the application — no table to create, nothing to migrate before the
 * migrations can run, and it is already there in every database this has ever
 * written. Three cases, and the middle one is the reason this exists:
 *
 *   no tables          a fresh install: run schema.sql, stamp the current
 *                      version, done.
 *   tables, version 0  a database from 2.0.0 or earlier, made before there was
 *                      any versioning. Its shape *is* version 1, so stamp it as
 *                      such and let the ladder carry it the rest of the way.
 *   version n          apply everything above n, one transaction each.
 *
 * A version *above* SCHEMA_VERSION is the fourth case, and the only one that
 * refuses rather than repairs: the database has been through a migration this
 * build has never heard of, which happens when a server is rolled back to an
 * older release. Opening it anyway would mean a build reading columns that
 * moved out from under it, so it stops and says what to do instead.
 */
function applySchema(raw: DatabaseSync, file: string): void {
  const read = () =>
    Number((raw.prepare('PRAGMA user_version').get() as { user_version?: number })?.user_version ?? 0);

  let version = read();

  if (version > SCHEMA_VERSION) {
    throw new Error(
      `${file} was written by a newer version of Stremio4Manga (database ` +
        `version ${version}; this build understands ${SCHEMA_VERSION}). ` +
        'Migrations are forward-only, so a downgrade needs the database backup ' +
        'the update took before it ran — see docs/RELEASING.md.',
    );
  }

  if (version === 0) {
    const tables = raw
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .get() as { n: number };

    // Running schema.sql on the pre-versioning database too, not just the fresh
    // one: every statement in it is CREATE ... IF NOT EXISTS, so on an existing
    // database it is a no-op except for anything that was added to schema.sql
    // during 2.0.0's life and only ever appeared by this route. Skipping it here
    // would quietly drop that.
    raw.exec(schema);
    version = tables.n === 0 ? SCHEMA_VERSION : 1;
    raw.exec(`PRAGMA user_version = ${version}`);
  }

  for (const migration of MIGRATIONS) {
    if (migration.to <= version) continue;
    // One transaction per step, covering the SQL and the stamp together. A
    // migration that throws halfway therefore leaves the database on the
    // version it started at rather than on a number that describes neither
    // shape, and the next start retries it from a known state.
    raw.exec('BEGIN IMMEDIATE');
    try {
      raw.exec(migration.sql);
      raw.exec(`PRAGMA user_version = ${migration.to}`);
      raw.exec('COMMIT');
    } catch (error) {
      try {
        raw.exec('ROLLBACK');
      } catch {
        // Already gone; the migration's own error is the one worth reporting.
      }
      throw new Error(
        `Migrating ${file} to database version ${migration.to} failed: ` +
          `${(error as Error).message}. The database is unchanged, still at ` +
          `version ${version}.`,
      );
    }
    version = migration.to;
  }
}

export function openDb(file: string): Db {
  mkdirSync(dirname(file), { recursive: true });

  let raw: DatabaseSync;
  try {
    raw = new DatabaseSync(file);
  } catch (error) {
    // node:sqlite is flagged on some Node 22 builds. Saying so beats the bare
    // failure the constructor would otherwise produce at startup.
    throw new Error(
      `Could not open ${file}: ${(error as Error).message}. ` +
        'Node 22 or newer with node:sqlite available is required.',
    );
  }

  raw.exec('PRAGMA busy_timeout = 5000');
  applySchema(raw, file);

  let depth = 0;

  return {
    all<T = Row>(sql: string, ...params: Param[]): T[] {
      return raw.prepare(sql).all(...params) as T[];
    },
    get<T = Row>(sql: string, ...params: Param[]): T | undefined {
      return raw.prepare(sql).get(...params) as T | undefined;
    },
    run(sql: string, ...params: Param[]) {
      const result = raw.prepare(sql).run(...params);
      return {
        changes: Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    },
    /**
     * Nestable: only the outermost call opens and closes a transaction, so a
     * helper that needs atomicity can be called from inside a larger write
     * without the inner COMMIT publishing half of the outer one.
     */
    transaction<T>(work: () => T): T {
      if (depth > 0) return work();
      depth += 1;
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          // A failed rollback means the transaction is already gone; the
          // original error is the one worth reporting.
        }
        throw error;
      } finally {
        depth -= 1;
      }
    },
    close() {
      raw.close();
    },
    raw,
  };
}
