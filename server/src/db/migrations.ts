/**
 * How an existing database catches up with a newer release.
 *
 * Until 2.0.0 there was no versioning: `openDb` ran schema.sql on every start
 * and every statement in it was `CREATE ... IF NOT EXISTS`, which is enough to
 * *add* a table but silently does nothing when an existing table needs a new
 * column. That is fine while the only way to upgrade is a human running the
 * installer and reading the output. It stops being fine the moment a server
 * updates itself, which is what this ladder exists for.
 *
 * ## The rule that keeps this honest
 *
 * A schema change goes in **two** places, always:
 *
 *   1. `schema.sql` — so a brand-new database is created correct in one step.
 *   2. a new entry below — so a database that already exists gets there too.
 *
 * Forgetting the second gives a server that works perfectly on a fresh install
 * and is missing a column on every machine that already had data. Forgetting
 * the first gives the reverse. Neither fails loudly on the machine doing the
 * release, which is exactly why the rule is written down here rather than
 * assumed.
 *
 * ## Writing an entry
 *
 * `to` is the version the database is at once the SQL has run — always one more
 * than the entry above it. The SQL runs inside a transaction with the version
 * stamp, so a migration that throws leaves the database exactly as it was.
 *
 *   { to: 2, sql: `ALTER TABLE manga ADD COLUMN last_read_at INTEGER;` },
 *
 * Migrations are forward-only. There is no `down`: a rollback restores the
 * previous *build*, and a build that predates a migration cannot open a
 * database that has run it — `openDb` refuses rather than guessing. Which is
 * why an update takes a database backup first; see docs/RELEASING.md.
 */

export interface Migration {
  /** The user_version the database carries once this has run. */
  to: number;
  /** Statements to bring a database from `to - 1` up to `to`. */
  sql: string;
}

/**
 * In order, oldest first. Empty is the correct state: 2.0.0's schema.sql is the
 * baseline, and nothing has changed since.
 */
export const MIGRATIONS: Migration[] = [];

/**
 * What schema.sql produces. Version 1 is 2.0.0's schema — the shape every
 * database in existence when versioning was introduced already has.
 */
export const SCHEMA_VERSION = 1 + MIGRATIONS.length;

// A migration list and a version number that disagree is the one mistake here
// that produces no symptom until somebody's data is involved: a gap means a
// database stops halfway and reports success, a duplicate means one of the two
// never runs. Checking at module load costs nothing and turns both into a crash
// on the developer's machine instead of a support thread.
MIGRATIONS.forEach((migration, index) => {
  const expected = index + 2;
  if (migration.to !== expected) {
    throw new Error(
      `Migration ${index} declares to: ${migration.to}, but migrations must be ` +
        `contiguous from 2 — it should be ${expected}.`,
    );
  }
});
