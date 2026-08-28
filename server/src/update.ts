/**
 * `s4m update` — replacing a running install with the latest release.
 *
 * The tree at /opt/stremio4manga is deliberately not writable by the account
 * that runs the server: install.sh chowns it to root and the unit runs as
 * `stremio4manga`, so a source parser that goes wrong cannot rewrite the server
 * it is running inside. This file is the one exception to that, and it is an
 * exception on purpose — it runs from a root shell or a systemd timer, never
 * from the server process, and there is no code path from an HTTP request to
 * anything below.
 *
 * What it moves is small: the release tarball carries the built output and
 * nothing else, so an update is a few megabytes and needs neither npm nor a
 * compiler on the target machine. What it does *not* move matters more —
 * config.json, the database, downloads and backups are all outside the payload
 * and are never touched.
 *
 * The order is chosen so that every step that can fail happens before anything
 * is replaced: fetch, verify the checksum, snapshot the database, and only then
 * swap directories. A failure before the swap leaves the install exactly as it
 * was; a failure after it is what `s4m rollback` is for.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { dataPaths, type Config } from './config.js';
import { openDb } from './db/open.js';
import { compareVersions, isDevBuild, VERSION } from './version.js';

/** Overridable so a fork, or a test against a scratch repo, does not need a rebuild. */
const REPO = process.env.S4M_UPDATE_REPO ?? 'Mitsu03/Stremio4Manga2.0';

/**
 * Everything the release tarball contains, relative to the install root.
 *
 * The same list appears in .github/workflows/release.yml, which is what creates
 * the tarball, and in the Containerfile's runtime stage, which copies the same
 * set for the same reason. Three copies in three languages is not ideal; the
 * MUST_EXIST check below at least turns a disagreement into a refusal rather
 * than a half-updated install.
 */
const PAYLOAD = [
  'server/dist',
  'server/bin',
  'server/catalog.json',
  'server/config.example.json',
  'web/dist',
];

/** Proof that an extraction produced a server and not an empty directory tree. */
const MUST_EXIST = ['server/dist/main.js', 'server/dist/cli.js', 'web/dist/index.html'];

export interface ReleaseInfo {
  version: string;
  tag: string;
  notesUrl: string;
  tarballUrl: string;
  checksumUrl: string;
}

export class UpdateError extends Error {}

async function githubJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      // GitHub rejects an API request with no User-Agent outright, and the
      // version header is what stops a future API change from silently
      // reshaping the response this parses.
      'user-agent': `stremio4manga/${VERSION}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });

  if (response.status === 404) {
    throw new UpdateError(
      `${REPO} has no published releases yet, so there is nothing to update to.`,
    );
  }
  if (response.status === 403 || response.status === 429) {
    // Unauthenticated API calls get 60 an hour per address. A server checking
    // once a day will never see this; a person debugging in a loop will.
    throw new UpdateError(
      'GitHub is rate-limiting this address. The limit is per hour and resets on ' +
        'its own; nothing has been changed.',
    );
  }
  if (!response.ok) {
    throw new UpdateError(`GitHub answered ${response.status} for ${url}.`);
  }

  return response.json();
}

/** What the newest published release is, and where its two files are. */
export async function latestRelease(): Promise<ReleaseInfo> {
  const release = (await githubJson(
    `https://api.github.com/repos/${REPO}/releases/latest`,
  )) as {
    tag_name?: string;
    html_url?: string;
    assets?: { name?: string; browser_download_url?: string }[];
  };

  const tag = release.tag_name ?? '';
  const version = tag.replace(/^v/, '');
  if (!version) throw new UpdateError('The latest release has no tag name.');

  const assets = release.assets ?? [];
  const find = (suffix: string) =>
    assets.find((asset) => asset.name?.endsWith(suffix))?.browser_download_url;

  const tarballUrl = find('.tar.gz');
  const checksumUrl = find('.tar.gz.sha256');

  // A release built by hand, or one whose workflow failed after creating the
  // release but before uploading the assets, looks identical to a good one in
  // the API until this point.
  if (!tarballUrl || !checksumUrl) {
    throw new UpdateError(
      `Release ${tag} is missing its tarball or its .sha256 file, so it cannot be ` +
        'verified. Check the release page before installing anything from it.',
    );
  }

  return { version, tag, notesUrl: release.html_url ?? '', tarballUrl, checksumUrl };
}

/** True when the published release is ahead of what is running. */
export const isNewer = (release: ReleaseInfo): boolean =>
  compareVersions(VERSION, release.version) < 0;

/** Refuses early rather than comparing against a version that was never built. */
export function assertComparable(): void {
  if (isDevBuild()) {
    throw new UpdateError(
      'This is a source checkout, not a release build, so there is no version to ' +
        'compare against. Update it with git.',
    );
  }
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { 'user-agent': `stremio4manga/${VERSION}` },
    redirect: 'follow',
  });
  if (!response.ok) throw new UpdateError(`Downloading ${url} answered ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * The checksum file is `sha256sum` output: the hash, two spaces, the filename.
 * Only the hash is used — the name in it is the one the workflow built, which
 * is not necessarily what the download was saved as.
 */
function verify(tarball: Buffer, checksumFile: string, expectedName: string): void {
  const expected = checksumFile.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const actual = createHash('sha256').update(tarball).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new UpdateError(`The .sha256 file for ${expectedName} is not a sha256 sum.`);
  }
  if (expected !== actual) {
    throw new UpdateError(
      `${expectedName} does not match its published checksum. Nothing has been ` +
        'installed. This is either a corrupted download or a tampered one; ' +
        'retrying is the right first response, and a second failure is not.',
    );
  }
}

/**
 * A consistent copy of the database, taken while the server may still be
 * writing to it.
 *
 * `VACUUM INTO` is what makes this safe to run against a live database: SQLite
 * takes the snapshot inside a read transaction, so the copy is the database as
 * of one moment rather than a file that changed under `cp`. It is also the
 * backup that matters most here — migrations are forward-only, so going back to
 * an older build after one has run needs this file.
 */
function snapshotDatabase(config: Config, label: string): string | undefined {
  const paths = dataPaths(config);
  if (!existsSync(paths.db)) return undefined;

  mkdirSync(paths.backups, { recursive: true });
  const target = join(paths.backups, `pre-update-${label}.db`);
  rmSync(target, { force: true });

  const db = openDb(paths.db);
  try {
    // The path goes into the statement as a quoted literal because VACUUM INTO
    // takes no parameters. Every component of it is ours — the data directory
    // from the config, and a label built from two version strings — so the
    // quote-doubling is belt and braces rather than the only defence.
    db.raw.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return target;
}

function untar(archive: string, into: string): void {
  const result = spawnSync('tar', ['-xzf', archive, '-C', into], { stdio: 'pipe' });
  if (result.error) {
    throw new UpdateError(
      `Could not run tar: ${result.error.message}. It is present by default on ` +
        'Linux and on Windows 10 1803 and newer.',
    );
  }
  if (result.status !== 0) {
    const detail = result.stderr?.toString().trim() || `exit ${result.status}`;
    throw new UpdateError(`tar failed to extract ${archive}: ${detail}`);
  }
}

export interface UpdateResult {
  from: string;
  to: string;
  databaseBackup?: string;
  previous: string;
}

/**
 * Install `release` over the tree at `installRoot`.
 *
 * The swap itself is a pair of renames per payload path — the live one out to
 * the backup, the staged one in to take its place — which is as close to atomic
 * as this gets without a symlinked-releases layout. The window in which a
 * request could see a half-swapped web/dist is milliseconds wide and closes on
 * the restart that follows, which is why the caller restarts rather than
 * leaving that to whoever reads the output.
 */
export async function installRelease(
  release: ReleaseInfo,
  installRoot: string,
  config: Config,
  report: (line: string) => void,
): Promise<UpdateResult> {
  const work = join(installRoot, '.updates');
  const staging = join(work, 'staging');
  const previous = join(work, 'previous');
  const name = `stremio4manga-${release.version}.tar.gz`;

  mkdirSync(work, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  report(`Downloading ${name}`);
  const [tarball, checksum] = await Promise.all([
    download(release.tarballUrl),
    download(release.checksumUrl).then((buffer) => buffer.toString('utf8')),
  ]);

  verify(tarball, checksum, name);
  report('Checksum verified');

  const archive = join(work, name);
  writeFileSync(archive, tarball);
  untar(archive, staging);
  rmSync(archive, { force: true });

  // Everything above this line can fail without consequence. This is the last
  // check before anything moves, and it is the one that catches a tarball built
  // with the wrong paths — which extracts cleanly and produces an install with
  // no server in it.
  for (const path of MUST_EXIST) {
    if (!existsSync(join(staging, path))) {
      rmSync(staging, { recursive: true, force: true });
      throw new UpdateError(
        `${name} does not contain ${path}, so it is not a complete release. ` +
          'Nothing has been changed.',
      );
    }
  }

  const databaseBackup = snapshotDatabase(config, `${VERSION}-to-${release.version}`);
  if (databaseBackup) report(`Database snapshot: ${databaseBackup}`);

  rmSync(previous, { recursive: true, force: true });
  mkdirSync(previous, { recursive: true });

  for (const path of PAYLOAD) {
    const live = join(installRoot, path);
    const staged = join(staging, path);
    const saved = join(previous, path);
    if (!existsSync(staged)) continue;

    mkdirSync(dirname(saved), { recursive: true });
    if (existsSync(live)) renameSync(live, saved);
    mkdirSync(dirname(live), { recursive: true });
    renameSync(staged, live);
    report(`Replaced ${path}`);
  }

  // What `s4m rollback` reads to know which build it is restoring, and the only
  // record that previous/ holds a build rather than leftovers.
  writeFileSync(join(previous, 'VERSION'), `${VERSION}\n`, 'utf8');
  rmSync(staging, { recursive: true, force: true });

  return { from: VERSION, to: release.version, databaseBackup, previous };
}

/** Put back whatever the last update replaced. */
export function rollback(installRoot: string, report: (line: string) => void): string {
  const previous = join(installRoot, '.updates', 'previous');
  const stamp = join(previous, 'VERSION');

  if (!existsSync(stamp)) {
    throw new UpdateError(
      `There is no previous build to go back to — ${previous} is empty or absent. ` +
        'Only the build replaced by the most recent `s4m update` is kept.',
    );
  }

  const version = readFileSync(stamp, 'utf8').trim();
  for (const path of PAYLOAD) {
    const saved = join(previous, path);
    const live = join(installRoot, path);
    if (!existsSync(saved)) continue;
    rmSync(live, { recursive: true, force: true });
    mkdirSync(dirname(live), { recursive: true });
    // Copied rather than moved, so a rollback interrupted halfway can simply be
    // run again. The tree is a few megabytes; the retry is worth the copy.
    cpSync(saved, live, { recursive: true });
    report(`Restored ${path}`);
  }

  return version;
}

/** `systemctl restart`, when the caller asked for it. */
export function restartService(unit: string): { ok: boolean; detail: string } {
  const result = spawnSync('systemctl', ['restart', unit], { stdio: 'pipe' });
  if (result.error) return { ok: false, detail: result.error.message };
  if (result.status !== 0) {
    return { ok: false, detail: result.stderr?.toString().trim() || `exit ${result.status}` };
  }
  return { ok: true, detail: '' };
}
