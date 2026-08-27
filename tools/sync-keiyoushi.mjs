#!/usr/bin/env node
/**
 * Turn the keiyoushi extension catalogue into sources this server can run.
 *
 * Most keiyoushi extensions are not bespoke code. They declare a *theme* — one
 * shared engine — and point it at a domain, which is exactly the shape of
 * `sites/mangadistrict.ts` and `sites/rizzfables.ts` here. So for every theme
 * this build implements, an extension reduces to four values we already accept:
 * name, language, base URL, content warning. Those go in
 * `server/sources.themed.json` and cost a row of data rather than a file of
 * code.
 *
 * Everything needed is in the extension's own `build.gradle.kts`:
 *
 *     keiyoushi {
 *         name = "AllPornComics.co"
 *         contentWarning = ContentWarning.NSFW
 *         theme = "madara"
 *         source { lang = "all"; baseUrl = "https://allporncomics.co" }
 *     }
 *
 * which is why this reads the source repository rather than the published
 * index: `index.json` on the `repo` branch carries the name, language and base
 * URL, but not the theme — and the theme is the one field that decides whether
 * we can run the source at all.
 *
 *   node tools/sync-keiyoushi.mjs [--repo <dir>] [--dry-run]
 *
 * With no `--repo`, the source tree is downloaded to a temporary directory.
 *
 * ## Ids are permanent
 *
 * A source id is written onto every manga row and into saved searches, so an id
 * that moves orphans a library. This script therefore only ever *appends*: an
 * entry already in `sources.themed.json` keeps its id whatever happens to the
 * ordering, and a source that disappears from keiyoushi keeps its row too —
 * removing it would free the id for reuse, and reuse is the one thing that must
 * never happen. Dropped sources are reported, not deleted.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'server', 'sources.themed.json');
const CATALOG = join(root, 'server', 'catalog.json');

/**
 * The themes `src/sources/themes/` implements. Anything else is skipped: a
 * source that installs and then fails on every search is worse than one that
 * was never offered, because only the second is honest about what this build
 * can do.
 *
 * `madaralegacy` is deliberately absent. It is a different engine despite the
 * name, and assuming our Madara covers it is how 106 broken sources ship at
 * once.
 */
const SUPPORTED = new Set(['madara', 'mangathemesia']);

const TARBALL = 'https://codeload.github.com/keiyoushi/extensions-source/tar.gz/refs/heads/main';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const repoFlag = args.indexOf('--repo');
let repoDir = repoFlag === -1 ? null : args[repoFlag + 1];

const say = (message) => process.stdout.write(`${message}\n`);

function download() {
  const dir = mkdtempSync(join(tmpdir(), 'keiyoushi-'));
  const tar = join(dir, 'src.tar.gz');
  say(`downloading ${TARBALL}`);
  execFileSync('curl', ['-sL', '--fail', '-m', '900', TARBALL, '-o', tar], { stdio: 'inherit' });
  // Only the build files: the full tree is ~200 MB of Kotlin and icons, none of
  // which is read here.
  execFileSync('tar', ['-xzf', tar, '-C', dir, '--wildcards', '*/src/*/*/build.gradle.kts'], {
    stdio: 'inherit',
  });
  const extracted = readdirSync(dir).find((name) => name.startsWith('extensions-source'));
  if (!extracted) throw new Error('the tarball did not contain an extensions-source directory');
  return join(dir, extracted);
}

/** Every `src/<lang>/<dir>/build.gradle.kts` in the tree. */
function buildFiles(tree) {
  const src = join(tree, 'src');
  if (!existsSync(src)) throw new Error(`no src/ directory under ${tree}`);
  const found = [];
  for (const lang of readdirSync(src)) {
    for (const name of readdirSync(join(src, lang))) {
      const file = join(src, lang, name, 'build.gradle.kts');
      if (existsSync(file)) found.push({ lang, dir: name, file });
    }
  }
  return found;
}

const value = (text, key) => text.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`))?.[1];

/**
 * The build file is Kotlin, not data, so this reads the declarations it needs
 * and ignores the rest. Anything with a computed name or URL simply does not
 * match and is skipped — better than half-parsing a build script.
 */
function parse({ lang, dir, file }) {
  const text = readFileSync(file, 'utf8');
  const theme = value(text, 'theme');
  if (!theme || !SUPPORTED.has(theme)) return null;

  const name = value(text, 'name');
  const baseUrl = value(text, 'baseUrl');
  if (!name || !baseUrl || !baseUrl.startsWith('http')) return null;

  const warning = text.match(/ContentWarning\.([A-Z]+)/)?.[1];

  return {
    pkgName: `${lang}.${dir}`,
    name,
    // The declared language wins over the directory when they disagree, which
    // happens for a single-language source filed under `all`.
    lang: value(text, 'lang') ?? lang,
    theme,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    contentWarning: warning === 'NSFW' ? 'NSFW' : warning === 'SAFE' ? 'SAFE' : 'MIXED',
    versionName: '1.0.0',
  };
}

function main() {
  if (!repoDir) repoDir = download();
  const tree = existsSync(join(repoDir, 'src'))
    ? repoDir
    : join(repoDir, readdirSync(repoDir).find((n) => n.startsWith('extensions-source')) ?? '');

  const files = buildFiles(tree);
  const parsed = files.map(parse).filter(Boolean);
  say(`${files.length} extensions, ${parsed.length} on a theme this build implements`);

  const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { extensions: [] };
  const byPkg = new Map(existing.extensions.map((entry) => [entry.pkgName, entry]));

  // Ids continue past every id ever handed out, including those belonging to a
  // source since dropped, so a number is never given to a second site.
  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
  const known = [
    ...catalog.extensions.flatMap((e) => e.sources.map((s) => BigInt(s.id))),
    ...existing.extensions.map((e) => BigInt(e.id)),
  ];
  let nextId = known.reduce((high, id) => (id > high ? id : high), 0n) + 1n;

  let added = 0;
  let moved = 0;
  const out = [];
  for (const entry of parsed) {
    const before = byPkg.get(entry.pkgName);
    if (before) {
      // Keep the id; take everything else from upstream, since a moved domain
      // is the most common reason a source stops working.
      if (before.baseUrl !== entry.baseUrl) moved++;
      out.push({ ...entry, id: before.id });
      byPkg.delete(entry.pkgName);
    } else {
      out.push({ ...entry, id: String(nextId++) });
      added++;
    }
  }

  // Whatever upstream no longer has keeps its row and its id.
  const dropped = [...byPkg.values()];
  out.push(...dropped);
  out.sort((a, b) => a.name.localeCompare(b.name));

  say(`added ${added}, base URL changed ${moved}, kept ${dropped.length} no longer upstream`);
  for (const entry of dropped) say(`  kept (gone upstream): ${entry.pkgName}`);
  say(`total ${out.length}`);

  if (dryRun) {
    say('--dry-run: nothing written');
    return;
  }

  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        $comment:
          'Generated by tools/sync-keiyoushi.mjs. One row per keiyoushi extension whose theme this build implements; the engines are in src/sources/themes. Ids are permanent — they are stored on every manga row — so this file is only ever appended to, and a source dropped upstream keeps its row rather than freeing its id for reuse. Do not hand-edit: re-run the script.',
        extensions: out,
      },
      null,
      2,
    )}\n`,
  );
  say(`wrote ${OUT}`);
}

main();
