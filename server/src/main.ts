/**
 * One process, one port, one database, every account.
 *
 * The deployment this replaces ran a Node gateway in front of one JVM per
 * person — 768 MB of heap each, a port each, and no idle shutdown by default.
 * Everything below is the same set of features with the tenancy moved into the
 * schema instead of into the process table.
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

import { ConfigError, dataPaths, defaultConfigPath, loadConfig } from './config.js';
import { openDb } from './db/open.js';
import { createLogger } from './http/log.js';
import { createApp } from './http/app.js';
import { createGraphQLHandler } from './graphql/execute.js';
import { createApiHandler } from './reader/api.js';
import { startDownloadWorker } from './downloads/worker.js';
import { startBackupSchedule } from './backup/schedule.js';
import { configureSources, seedDefaults } from './sources/registry.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/ sits one level below the workspace root, which is where config.json lives.
const serverRoot = resolve(here, '..');

async function main(): Promise<void> {
  const config = loadConfig(defaultConfigPath(serverRoot));
  const paths = dataPaths(config);
  for (const dir of [paths.downloads, paths.backups, paths.cache, paths.thumbnails]) {
    mkdirSync(dir, { recursive: true });
  }

  const log = createLogger(config.logging);
  const db = openDb(paths.db);

  // The sources share one HTTP client, and its rate limits and Cloudflare
  // solver come from the config — so this has to happen before anything can
  // reach a source, not lazily on the first request.
  configureSources(config);

  // Accounts made before there was any seeding still open on an empty Sources
  // page. `seedDefaults` only touches an account with no source rows at all —
  // uninstalling leaves the row behind — so this cannot undo somebody's
  // deliberate choice, and it is a no-op on every boot after the first.
  for (const row of db.all<{ username: string }>('SELECT username FROM users')) {
    const seeded = seedDefaults(db, row.username);
    if (seeded > 0) log.info(`installed ${seeded} built-in sources for "${row.username}"`);
  }

  const graphql = createGraphQLHandler({ config, db, log });
  const api = createApiHandler({ config, db, log });

  const app = createApp({ config, db, log, graphql, api });
  const server = createServer(app);

  // A failed bind arrives as an unhandled 'error' event, which exits with no
  // reason given — precisely when someone is replacing a server they started by
  // hand and the old one still holds the port.
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      log.error(`Port ${config.listen.port} is already in use. Stop the other server first.`);
    } else {
      log.error(`HTTP server failed: ${error.message}`);
    }
    process.exit(1);
  });

  const stopDownloads = startDownloadWorker({ config, db, log });
  const stopBackups = startBackupSchedule({ config, db, log });

  server.listen(config.listen.port, config.listen.host, () => {
    log.info(
      `Listening on http://${config.listen.host}:${config.listen.port} (${config.publicOrigin})`,
    );
  });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    log.info(`${signal} — shutting down.`);
    stopDownloads();
    stopBackups();
    server.close(() => {
      db.close();
      log.close();
      process.exit(0);
    });
    // A reader mid-chapter holds a socket open; do not wait on it forever.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(signal, () => shutdown(signal));
  }
  process.on('uncaughtException', (error) => {
    log.error(`Uncaught: ${error.stack ?? error.message}`);
    shutdown('uncaughtException');
  });

  /**
   * A rejected promise nobody awaited must not take the server with it.
   *
   * Node's default is to turn one into an uncaught exception, which here means a
   * shutdown — so a single source misbehaving in a background task could end a
   * reading session for everybody on the server. Every such task in this process
   * is one request to one site; none of them is worth the process.
   *
   * Logged in full rather than swallowed: this is how the next one gets found.
   */
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    log.error(`Unhandled rejection (continuing): ${error}`);
  });

  // Whatever ends this process says so on the way out. An exit with no line in
  // the log at all is the one failure that cannot be investigated afterwards.
  process.on('exit', (code) => {
    if (code !== 0) log.error(`Exiting with code ${code}.`);
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
