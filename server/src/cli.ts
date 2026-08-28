/**
 * `s4m` — the administrative side of the server.
 *
 * The only way an account comes into being. There is no registration page and
 * no first-run claim: creating an account is a decision made by somebody with a
 * shell on the machine, which is exactly what this file is.
 *
 * Passwords are typed at a hidden prompt and hashed here, so a plaintext
 * password never reaches the database, the shell history, or the process list.
 */
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { ConfigError, dataPaths, defaultConfigPath, loadConfig, type Config } from './config.js';
import { openDb, type Db } from './db/open.js';
import { hashPassword } from './http/crypto.js';
import { importTachibk } from './backup/tachibk.js';
import { seedDefaults } from './sources/registry.js';
import { VERSION } from './version.js';
import {
  assertComparable,
  installRelease,
  isNewer,
  latestRelease,
  restartService,
  rollback,
  UpdateError,
} from './update.js';

const MIN_PASSWORD_LENGTH = 10;

/**
 * Names the router and the cookie namespace already answer to. An account
 * called `api` would be confusing at best and a source of look-alike links at
 * worst.
 */
const RESERVED = new Set(['gateway', 'api', 'admin', 'root']);

interface Options {
  yes: boolean;
  passwordStdin: boolean;
  dryRun: boolean;
  check: boolean;
  restart: boolean;
}

interface UserRow {
  username: string;
  display_name: string;
  created_at: number;
}

function out(text = ''): void {
  process.stdout.write(`${text}\n`);
}

function fail(text: string): never {
  process.stderr.write(`${text}\n`);
  process.exit(1);
}

/** A prompt that does not echo. Without it the password lands in the terminal scrollback. */
function askSecret(question: string): Promise<string> {
  return new Promise((done) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    }) as Interface & { _writeToOutput: (chunk: string) => void };
    let silent = false;
    // readline writes the prompt through this hook too, so the muting has to
    // start after `question()` has pushed the prompt through it.
    rl._writeToOutput = (chunk: string) => {
      if (!silent) process.stdout.write(chunk);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      done(answer);
    });
    silent = true;
  });
}

/** Read the whole of stdin. Used by `--password-stdin`, so a script can set one up without a TTY. */
function readStdin(): Promise<string> {
  return new Promise((done, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      text += chunk;
    });
    process.stdin.on('end', () => done(text.replace(/\r?\n$/, '')));
    process.stdin.on('error', reject);
  });
}

async function readNewPassword(options: Options): Promise<string> {
  if (options.passwordStdin) {
    const password = await readStdin();
    if (password.length < MIN_PASSWORD_LENGTH) {
      fail(`Password too short — at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    return password;
  }
  for (;;) {
    const first = await askSecret('New password: ');
    if (first.length < MIN_PASSWORD_LENGTH) {
      out(
        `Too short — at least ${MIN_PASSWORD_LENGTH} characters. This server faces the internet.`,
      );
      continue;
    }
    const second = await askSecret('Repeat password: ');
    if (first !== second) {
      out('They do not match. Again.');
      continue;
    }
    return first;
  }
}

export function usernameProblem(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(name)) {
    return (
      `"${name}" will not do. Use 1-32 characters: lower-case letters, digits, ` +
      'dot, dash or underscore, starting with a letter or a digit.'
    );
  }
  if (RESERVED.has(name)) return `"${name}" is reserved by the server itself. Pick another.`;
  return null;
}

const here = dirname(fileURLToPath(import.meta.url));
// dist/ sits one level below the workspace root, which is where config.json lives.
const serverRoot = resolve(here, '..');
// One level above that is the install root — the directory a release tarball
// extracts over, holding both server/ and web/.
const installRoot = resolve(serverRoot, '..');

/** The unit `--restart` restarts. install.sh installs it under this name. */
const SERVICE_UNIT = process.env.S4M_SERVICE ?? 'stremio4manga';

function open(): Db {
  try {
    const config = loadConfig(defaultConfigPath(serverRoot));
    return openDb(dataPaths(config).db);
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    fail(String((error as Error)?.stack ?? error));
  }
}

function requireUser(db: Db, name: string): UserRow {
  const user = db.get<UserRow>(
    'SELECT username, display_name, created_at FROM users WHERE username = ?',
    name,
  );
  if (!user) fail(`No account "${name}".`);
  return user;
}

// ------------------------------------------------------------------ users --

async function add(positional: string[], options: Options): Promise<void> {
  const given = positional[0];
  if (!given) fail('Usage: s4m users add <username> [--password-stdin]');
  const name = given.toLowerCase();

  const problem = usernameProblem(name);
  if (problem) fail(problem);

  const db = open();
  if (db.get('SELECT 1 FROM users WHERE username = ?', name)) {
    fail(`"${name}" already exists. To change the password: s4m users passwd ${name}`);
  }

  // Hashed before anything is written, so a mistyped confirmation or a Ctrl-C at
  // the prompt leaves the database exactly as it was.
  const hash = await hashPassword(await readNewPassword(options));
  const now = Date.now();

  db.transaction(() => {
    db.run(
      'INSERT INTO users (username, display_name, password, password_changed_at, created_at)' +
        ' VALUES (?, ?, ?, ?, ?)',
      name,
      given,
      hash,
      now,
      now,
    );
  });

  // An account with no sources has an empty Sources page, an empty Discover and
  // a search that can reach nothing — which reads as a broken install rather
  // than an empty one. Version 1 seeded every new account for the same reason.
  const seeded = seedDefaults(db, name);

  out('');
  out(`Added "${name}". They can sign in now — no restart needed.`);
  if (seeded > 0) out(`${seeded} built-in sources are installed and ready to search.`);
}

async function passwd(positional: string[], options: Options): Promise<void> {
  const given = positional[0];
  if (!given) fail('Usage: s4m users passwd <username> [--password-stdin]');
  const name = given.toLowerCase();

  const db = open();
  requireUser(db, name);

  const hash = await hashPassword(await readNewPassword(options));

  db.transaction(() => {
    db.run(
      'UPDATE users SET password = ?, password_changed_at = ? WHERE username = ?',
      hash,
      Date.now(),
      name,
    );
    // Every session that account left signed in stops working, immediately.
    // Somebody changing a password often believes the old one was learned by
    // somebody else.
    db.run('DELETE FROM sessions WHERE username = ?', name);
  });

  out('');
  out(`Password changed for "${name}", and every device it left signed in has been signed out.`);
}

function remove(positional: string[], options: Options): void {
  const given = positional[0];
  if (!given) fail('Usage: s4m users remove <username> [--yes]');
  const name = given.toLowerCase();

  const db = open();
  requireUser(db, name);

  if (!options.yes) {
    out(`This removes "${name}" and everything in their library: entries, chapters,`);
    out('reading progress, categories, tracker links and download queue.');
    out('Downloaded page files are left on disk. Re-run with --yes to confirm.');
    return;
  }

  // Every domain table references users(username) ON DELETE CASCADE, so one
  // DELETE is the whole account — as long as foreign keys are on, which the
  // schema turns on at open.
  db.transaction(() => {
    db.run('DELETE FROM users WHERE username = ?', name);
  });
  out(`Removed "${name}".`);
}

function list(): void {
  const db = open();
  const users = db.all<UserRow>(
    'SELECT username, display_name, created_at FROM users ORDER BY username',
  );
  if (users.length === 0) {
    out('No accounts yet. Add one with: s4m users add <username>');
    return;
  }
  out('username'.padEnd(20) + 'display name'.padEnd(24) + 'created');
  for (const user of users) {
    out(
      user.username.padEnd(20) +
        user.display_name.padEnd(24) +
        new Date(user.created_at).toISOString().slice(0, 10),
    );
  }
}

// ----------------------------------------------------------------- update --

/**
 * Report a failure without calling `process.exit`.
 *
 * `fail` tears the process down where it stands, which is right for a command
 * that has only touched the database. It is wrong here: `fetch` leaves a socket
 * and its libuv handle alive for a moment after the response, and exiting on
 * top of one aborts the runtime on Windows with an assertion from async.c
 * instead of the message that was meant to be printed. Setting the code and
 * returning lets the loop drain and exits with 1 on its own.
 */
function reportFailure(text: string): void {
  process.stderr.write(`${text}
`);
  process.exitCode = 1;
}

/** The config, for the one command that needs it without opening the database. */
function config(): Config {
  try {
    return loadConfig(defaultConfigPath(serverRoot));
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    fail(String((error as Error)?.stack ?? error));
  }
}

/**
 * `s4m update` — install the latest release over this one.
 *
 * Three shapes, and the default is the cautious one: with no flags it reports
 * what is available and stops, because an update restarts the server and that
 * is not something to do as a side effect of asking a question. `--check` is
 * the same report with an exit code a script can branch on; `--yes` is the one
 * that actually installs.
 */
async function update(_positional: string[], options: Options): Promise<void> {
  try {
    assertComparable();
    const release = await latestRelease();

    out(`Installed: ${VERSION}`);
    out(`Latest:    ${release.version}${release.notesUrl ? `  ${release.notesUrl}` : ''}`);

    if (!isNewer(release)) {
      out('');
      out('Already up to date.');
      return;
    }

    if (options.check) {
      // 10 rather than 1: a script needs to tell "an update is waiting" apart
      // from "the check itself failed", and 1 is what every other failure here
      // exits with.
      out('');
      out('An update is available. Install it with: s4m update --yes');
      process.exitCode = 10;
      return;
    }

    if (!options.yes) {
      out('');
      out('This replaces the built server and UI in place and needs a restart to');
      out('take effect. config.json, the database and downloads are not touched,');
      out('and the build being replaced is kept for `s4m rollback`.');
      out('');
      out('Re-run with --yes to install, or --yes --restart to install and restart.');
      return;
    }

    out('');
    const result = await installRelease(release, installRoot, config(), out);
    out('');
    out(`Updated ${result.from} -> ${result.to}.`);

    if (!options.restart) {
      out(`Restart to load it: systemctl restart ${SERVICE_UNIT}`);
      return;
    }

    const restarted = restartService(SERVICE_UNIT);
    if (restarted.ok) {
      out(`Restarted ${SERVICE_UNIT}.`);
      return;
    }
    // Not a failure of the update — the new build is installed either way, so
    // say that plainly rather than leaving the impression it has to be redone.
    out('');
    out(`The update is installed, but restarting ${SERVICE_UNIT} failed: ${restarted.detail}`);
    out(`Restart it by hand, or run \`s4m rollback\` to go back to ${result.from}.`);
    process.exitCode = 1;
  } catch (error) {
    if (error instanceof UpdateError) {
      reportFailure(error.message);
      return;
    }
    throw error;
  }
}

/** `s4m rollback` — put back the build the last update replaced. */
function rollbackCommand(_positional: string[], options: Options): void {
  try {
    if (!options.yes) {
      out('This restores the build replaced by the last `s4m update`, and needs a');
      out('restart to take effect. If that update ran a database migration, the');
      out('older build will refuse to open the database until the pre-update');
      out('snapshot in the backups directory is restored too — see docs/RELEASING.md.');
      out('');
      out('Re-run with --yes to confirm.');
      return;
    }

    const version = rollback(installRoot, out);
    out('');
    out(`Rolled back to ${version}.`);
    out(`Restart to load it: systemctl restart ${SERVICE_UNIT}`);
  } catch (error) {
    if (error instanceof UpdateError) {
      reportFailure(error.message);
      return;
    }
    throw error;
  }
}

// --------------------------------------------------------------- dispatch --

interface Command {
  usage: string;
  run: (positional: string[], options: Options) => void | Promise<void>;
}

const USER_COMMANDS: Record<string, Command> = {
  add: { usage: 's4m users add <username> [--password-stdin]', run: add },
  passwd: { usage: 's4m users passwd <username> [--password-stdin]', run: passwd },
  remove: { usage: 's4m users remove <username> [--yes]', run: remove },
  list: { usage: 's4m users list', run: list },
};

function usersHelp(): void {
  out('Accounts:');
  for (const command of Object.values(USER_COMMANDS)) out(`  ${command.usage}`);
}

/**
 * The top level. Adding a command is adding an entry here — the argument
 * splitting, the config/database opening and the error reporting are already
 * done by the time `run` is called.
 */
/**
 * Bring a library over from the Java server this one replaces.
 *
 * The UI's own import box accepts a .tachibk too, so this exists for the case
 * the browser is the wrong tool: a server being stood up before anyone has an
 * account to sign in with, or a dozen accounts migrated in one sitting.
 */
async function importBackup(positional: string[], options: Options): Promise<void> {
  const [file, username] = positional;
  if (!file || !username) {
    fail('Usage: s4m import <file.tachibk> <username> [--dry-run]');
  }

  const db = open();
  try {
    const summary = await importTachibk(db, username, resolve(file), {
      dryRun: options.dryRun,
      onProgress: (done, total) => {
        // One line, rewritten: a title-per-line log of a 400-title backup is
        // not something anybody reads.
        process.stdout.write(`\r  ${done}/${total} titles`);
      },
    });
    out('');
    out(
      options.dryRun
        ? `Would import ${summary.manga} titles, ${summary.chapters} chapters.`
        : `Imported ${summary.manga} titles, ${summary.chapters} chapters, ` +
            `${summary.categories} categories, ${summary.tracks} tracking links, ` +
            `${summary.metas} settings.`,
    );

    // Each of these is something the reader notices afterwards, so none of them
    // is allowed to be silent.
    if (summary.unmatchedSources.length > 0) {
      out('');
      out('These sources have no equivalent here, so their titles cannot be read yet:');
      for (const source of summary.unmatchedSources) out(`  ${source.name || source.id}`);
      out('Their read progress was kept — bind each title to a source that is installed.');
    }
    if (summary.droppedBindings > 0) {
      out('');
      out(
        `${summary.droppedBindings} source bindings could not be carried over: the Suwayomi ` +
          'backup format stores them as row ids, which mean nothing in this database. ' +
          'Those titles keep their progress and need binding to a source again.',
      );
    }
    if (summary.otherTrackers.length > 0) {
      out('Tracking from services other than AniList was skipped.');
    }
  } finally {
    db.close();
  }
}

const COMMANDS: Record<string, Command> = {
  import: {
    usage: 's4m import <file.tachibk> <username> [--dry-run]',
    run: importBackup,
  },
  version: {
    usage: 's4m version',
    run: () => out(VERSION),
  },
  update: {
    usage: 's4m update [--check] [--yes] [--restart]',
    run: update,
  },
  rollback: {
    usage: 's4m rollback [--yes]',
    run: rollbackCommand,
  },
  users: {
    usage: 's4m users add|passwd|remove|list',
    run: (positional, options) => {
      const sub = positional[0];
      const command = sub ? USER_COMMANDS[sub] : undefined;
      if (!command) {
        usersHelp();
        if (sub) process.exitCode = 1;
        return;
      }
      return command.run(positional.slice(1), options);
    },
  },
};

/**
 * Split flags from positional arguments.
 *
 * Both have to come out of one pass, because the commands differ in whether
 * they take a name at all. Treating the word after the command as the name
 * regardless would read a flag as a username and then quietly drop it.
 */
function parseArgs(argv: string[]): { options: Options; positional: string[] } {
  const options: Options = {
    yes: false,
    passwordStdin: false,
    dryRun: false,
    check: false,
    restart: false,
  };
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--password-stdin') options.passwordStdin = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--restart') options.restart = true;
    // A password on the command line is a password in `ps` and in the shell
    // history, so there is deliberately no flag that takes one.
    else if (arg.startsWith('-')) fail(`Unknown option: ${arg}`);
    else positional.push(arg);
  }

  return { options, positional };
}

function help(): void {
  out(`Stremio4Manga ${VERSION} — server administration`);
  out('');
  usersHelp();
  out('');
  out('Releases:');
  out(`  ${COMMANDS.update.usage}`);
  out('  Installs the latest release over this one. Reports and stops without --yes.');
  out(`  ${COMMANDS.rollback.usage}`);
  out('  Restores the build the last update replaced.');
  out(`  ${COMMANDS.version.usage}`);
  out('');
  out('Migration:');
  out(`  ${COMMANDS.import.usage}`);
  out('  Reads a backup from the Suwayomi server this one replaces.');
  out('');
  out(`Config: ${defaultConfigPath(serverRoot)}`);
}

async function main(): Promise<void> {
  const [name, ...rest] = process.argv.slice(2);
  const command = name ? COMMANDS[name] : undefined;
  if (!command) {
    help();
    if (name) process.exitCode = 1;
    return;
  }
  const { options, positional } = parseArgs(rest);
  await command.run(positional, options);
}

try {
  await main();
} catch (error) {
  // A stack trace is the right answer for a bug, but a config problem is not a
  // bug and should not look like one.
  if (error instanceof ConfigError) fail(error.message);
  fail(String((error as Error)?.stack ?? error));
}
