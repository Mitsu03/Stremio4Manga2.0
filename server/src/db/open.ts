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
  raw.exec(schema);

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
