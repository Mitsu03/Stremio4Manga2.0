#!/usr/bin/env node
/**
 * Turn the keiyoushi extension catalogue into sources this server can run.
 *
 * Most keiyoushi extensions are not bespoke code. They declare a *theme* — one
 * shared engine — and point it at a domain, which is exactly the shape of
 * `sites/mangadistrict.ts` and `sites/rizzfables.ts` here. So for every theme
 * this build implements, an extension reduces to data: it goes in
 * `server/sources.themed.json` and costs a row rather than a file of code.
 *
 * It does *not* reduce to four values. That was the original belief here, and it
 * was wrong in a way that took a while to see: only 56 of the 302 extensions
 * this build covers override nothing at all. The rest rename a URL path, move a
 * selector, write dates in another language or extend a different base class,
 * and dropping all of that shipped sources that installed and then returned
 * nothing. So the identity fields come from the build file, and everything else
 * is read out of the extension's own Kotlin into a `config` object.
 *
 * Overridden *functions* are logic, not data, and cannot come across. They are
 * counted into `unportedOverrides` rather than ignored, so a source that is only
 * approximately right says so instead of looking exact.
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
const OVERRIDES = join(root, 'server', 'sources.overrides.json');

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
const SUPPORTED = new Set([
  'madara',
  // Upstream's older Madara library. Not a different engine: it declares the
  // same selector strings, and differs only in how the listing and the chapter
  // list are requested — both of which are already config here. See the note in
  // `registry.ts`, where the two share a branch.
  'madaralegacy',
  'mangathemesia',
  'iken',
  'keyoapp',
  'mangacatalog',
  'mangahub',
]);

/** The engine a theme runs on, for themes upstream ships under two names. */
const FAMILY = { madaralegacy: 'madara' };
const familyOf = (theme) => FAMILY[theme] ?? theme;

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
  // The build file says which theme a source is on; the Kotlin beside it says
  // how that source differs from the theme's defaults, and only 56 of 302 differ
  // in nothing at all. Both are needed. Icons and the rest of the ~200 MB are
  // not, so the extraction stays narrow.
  execFileSync(
    'tar',
    ['-xzf', tar, '-C', dir, '--wildcards', '*/src/*/*/build.gradle.kts', '--wildcards', '*.kt'],
    { stdio: 'inherit' },
  );
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

/** Every `.kt` under an extension directory, concatenated. */
function kotlinOf(dir) {
  const out = [];
  const walk = (path) => {
    for (const name of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, name.name);
      if (name.isDirectory()) walk(child);
      else if (name.name.endsWith('.kt')) out.push(readFileSync(child, 'utf8'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.join('\n');
}

/**
 * `override val x = "…"`, with Kotlin's own escaping undone.
 *
 * `[^"]*` is the obvious pattern and the wrong one: a CSS selector matching on
 * an attribute value contains escaped quotes — `a[href*=\"?genre=\"]` — and
 * stopping at the first of them yields a *truncated* selector, which is worse
 * than none. Cheerio throws on it, and the throw takes the whole source down
 * rather than one field. One site shipped that way before this was noticed.
 */
const str = (text, member) => {
  const raw = text.match(
    new RegExp(`override\\s+val\\s+${member}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`),
  )?.[1];
  return raw === undefined ? undefined : raw.replace(/\\(.)/g, '$1');
};
const bool = (text, member) => {
  const hit = text.match(new RegExp(`override\\s+val\\s+${member}\\s*=\\s*(true|false)\\b`))?.[1];
  return hit === undefined ? undefined : hit === 'true';
};
const int = (text, member) => {
  const hit = text.match(new RegExp(`override\\s+val\\s+${member}\\s*=\\s*(\\d+)\\b`))?.[1];
  return hit === undefined ? undefined : Number(hit);
};

/**
 * A selector an extension expresses as a one-line function rather than a value.
 *
 * Some themes declare `open fun popularMangaSelector(): String = "…"` where
 * others declare a `val`, and an override of the first kind is exactly as much
 * data as one of the second. Only a bare string literal is taken: a body that
 * calls something is code, and is counted as code below.
 */
const fnStr = (text, member) => {
  const raw = text.match(
    new RegExp(
      `override\\s+fun\\s+${member}\\s*\\([^)]*\\)\\s*(?::\\s*String\\s*)?=\\s*"((?:[^"\\\\]|\\\\.)*)"`,
    ),
  )?.[1];
  return raw === undefined ? undefined : raw.replace(/\\(.)/g, '$1');
};

/**
 * `listOf(Pair("Berserk", "$baseUrl/manga/berserk/"), …)` → the pairs.
 *
 * MangaCatalog sites are one franchise each, so this list *is* the catalogue.
 * Without it a site carrying side stories offers only its main title, and the
 * theme's own default — the site's name pointed at its root — is a series page
 * that does not exist.
 *
 * The `$baseUrl` prefix is dropped rather than resolved, because the engine
 * resolves a relative URL against whatever the row's `baseUrl` says: a domain
 * move then stays a one-line correction instead of a re-scrape.
 */
function sourceList(text) {
  const block = text.match(/override\s+val\s+sourceList\s*=\s*listOf\(([\s\S]*?)\n\s*\)/)?.[1];
  if (!block) return undefined;
  const series = [];
  for (const line of block.split('\n')) {
    // A commented-out entry is one upstream deliberately withdrew — Berserk's
    // motion comic, which is video and has no pages.
    if (/^\s*\/\//.test(line)) continue;
    const pair = line.match(/Pair\(\s*"([^"]*)"\s*,\s*"([^"]*)"/);
    if (!pair) continue;
    const url = pair[2].replace(/^\$baseUrl/, '');
    if (pair[1] !== '' && url !== '') series.push({ name: pair[1], url });
  }
  return series.length > 0 ? series : undefined;
}

/**
 * `rateLimit(3, 2.seconds)` and friends, reduced to the one number this server
 * has a place for. Bare `rateLimit(n)` is n per *minute* in the Tachiyomi
 * helper, which is the only reason the minute branch exists.
 */
function interval(text) {
  const call = text.match(/rateLimit\(\s*(\d+)\s*(?:,\s*(\d+)\s*\.\s*(seconds|minutes))?/);
  if (!call) return undefined;
  const permits = Number(call[1]);
  const period = call[2] ? Number(call[2]) * (call[3] === 'minutes' ? 60_000 : 1_000) : 60_000;
  return Math.round(period / Math.max(1, permits));
}

/** `DateTimeFormatter.ofPattern("d MMM yyyy", Locale("tr"))` → both halves. */
function dateFormat(text) {
  const pattern = text.match(
    /(?:chapterDateFormat|dateFormat)\s*=\s*(?:DateTimeFormatter\.ofPattern|SimpleDateFormat)\(\s*"([^"]+)"/,
  )?.[1];
  if (!pattern) return {};
  const tail = text.slice(text.indexOf(pattern) + pattern.length, text.indexOf(pattern) + 200);
  const named = tail.match(/Locale\.([A-Z_]+)/)?.[1];
  const tagged = tail.match(/Locale\(\s*"([\w-]+)"/)?.[1];
  const NAMED = { ROOT: 'en', US: 'en-US', ENGLISH: 'en', FRENCH: 'fr', FRANCE: 'fr-FR' };
  const locale = tagged ?? (named ? (NAMED[named] ?? 'en') : undefined);
  return { dateFormat: pattern, ...(locale ? { dateLocale: locale } : {}) };
}

/**
 * What a source changed about its theme.
 *
 * Only literal overrides are read. An override that is real code — a rewritten
 * `pageListParse`, an interceptor — cannot become a config field, so it is
 * counted and reported rather than guessed at; the source still ships, with the
 * literals it *did* declare, which is strictly better than ignoring all of them.
 */
function overrides(declared, dir) {
  // The name upstream writes and the engine it runs on are not always the same
  // word; everything below reasons about the engine.
  const theme = familyOf(declared);
  const text = kotlinOf(dir);
  if (text === '') return { config: {}, code: 0 };

  const base = text.match(/\bclass\s+\w+\s*(?:\([^)]*\))?\s*:\s*([A-Z]\w+)/)?.[1];
  const config = {};

  // Madara's archive path segment and MangaThemesia's series-URL prefix are
  // different members with different shapes — one bare, one slash-led — so they
  // are read separately and normalised here, not shared.
  // Madara's archive path segment and MangaThemesia's series-URL prefix are
  // different members with different shapes — one bare, one slash-led — so they
  // are read separately and normalised here, not shared. The other four themes
  // have no such member: their URLs are fixed by the engine.
  const path = theme === 'madara' ? str(text, 'mangaSubString') : str(text, 'mangaUrlDirectory');
  if ((theme === 'madara' || theme === 'mangathemesia') && path) {
    config.mangaPath = path.replace(/^\/+|\/+$/g, '');
  }

  if (theme === 'mangathemesia') {
    if (base === 'MangaThemesiaAlt') config.variant = 'alt';
    if (bool(text, 'hasProjectPage') === true) config.hasProjectPage = true;
    const page = str(text, 'pageSelector');
    if (page) config.pageSelector = page;
  } else if (theme === 'iken') {
    // Everything Iken varies is a number or a flag; there is no markup to move.
    const perPage = int(text, 'perPage');
    if (perPage) config.perPage = perPage;
    if (bool(text, 'sortPagesByFilename') === true) config.sortPagesByFilename = true;
    const api = str(text, 'apiUrl');
    if (api) config.apiUrl = api;
  } else if (theme === 'keyoapp') {
    // The featured row is what installs disagree about most, and half of them
    // express it as a function rather than as a value.
    const popular = str(text, 'popularMangaSelector') ?? fnStr(text, 'popularMangaSelector');
    if (popular) config.popularSelector = popular;
    const type = str(text, 'typeSelector');
    if (type) config.typeSelector = type;
    const altName = str(text, 'altNameSelector');
    if (altName) config.altNameSelector = altName;
  } else if (theme === 'mangahub') {
    // Not an override so much as the site's identity: the API is one catalogue
    // per front end, named by this enum, and the query is malformed without it.
    const catalogue = str(text, 'mangaSource');
    if (catalogue) config.mangaSource = catalogue;
  } else if (theme === 'mangacatalog') {
    const series = sourceList(text);
    if (series) config.series = series;
  } else if (theme === 'madara') {
    // The chapter list arrives one of five ways upstream; this build knows two
    // of them, and `page` is what `MadaraNoAjax`-style installs need.
    const mode = text.match(/chapterMode\s*=\s*ChapterMode\.(\w+)/)?.[1];
    const MODES = { MangaPage: 'page', AdminAjax: 'ajax', MangaAjax: 'manga-ajax' };
    if (MODES[mode]) config.chapterSource = MODES[mode];
    // `MangaAjaxPaginated` and `MangaAjaxQuery` have no engine yet. Carrying the
    // raw name is what lets the engine gain one later without a re-scrape, and
    // meanwhile the source falls back to probing, which is what it did before.
    else if (mode) config.chapterMode = mode;
    if (base === 'MadaraNoAjax') config.variant = 'noajax';

    // The older library spells the same two decisions differently, and 68 of
    // its 105 extensions declare the first while 59 declare the second — so
    // reading them is most of what makes those sources work rather than
    // fall back to probing every request.
    if (bool(text, 'useNewChapterEndpoint') === true) config.chapterSource = 'manga-ajax';
    const loadMore = text.match(/useLoadMoreRequest\s*=\s*LoadMoreStrategy\.(\w+)/)?.[1];
    // Only `Always` is a decision. `AutoDetect` and `Never` both mean "the
    // archive answers", which is this engine's default anyway.
    if (loadMore === 'Always') config.listingMode = 'load-more';

    const filter = bool(text, 'filterNonMangaItems');
    if (filter === false) config.filterNonMangaItems = false;
  }

  const selectors = {};
  const SELECTORS = {
    madara: {
      status: 'mangaDetailsSelectorStatus',
      title: 'mangaDetailsSelectorTitle',
      description: 'mangaDetailsSelectorDescription',
      thumbnail: 'mangaDetailsSelectorThumbnail',
      author: 'mangaDetailsSelectorAuthor',
      artist: 'mangaDetailsSelectorArtist',
      genre: 'mangaDetailsSelectorGenre',
      chapterList: 'chapterListSelector',
      chapterDate: 'chapterDateSelector',
      pageList: 'pageListParseSelector',
    },
    mangathemesia: {
      status: 'seriesStatusSelector',
      title: 'seriesTitleSelector',
      description: 'seriesDescriptionSelector',
      thumbnail: 'seriesThumbnailSelector',
      author: 'seriesAuthorSelector',
      artist: 'seriesArtistSelector',
      genre: 'seriesGenreSelector',
      details: 'seriesDetailsSelector',
      chapterList: 'chapterListSelector',
      searchItem: 'searchMangaSelector',
    },
    // Keyoapp names its members after the field rather than after the page, and
    // several installs replace the theme's label scan with a plain `div[alt=X]`.
    keyoapp: {
      status: 'statusSelector',
      author: 'authorSelector',
      artist: 'artistSelector',
      genre: 'genreSelector',
      description: 'descriptionSelector',
      chapterDate: 'dateSelector',
    },
    // The one MangaCatalog member that is a value; the rest of what these sites
    // change is written as functions, and is counted rather than carried.
    mangacatalog: { chapterList: 'chapterListSelector' },
    // Nothing to move: Iken parses JSON and MangaHub GraphQL, so neither has a
    // selector to override. Present so the loop below needs no special case.
    iken: {},
    mangahub: {},
  };
  for (const [field, member] of Object.entries(SELECTORS[theme] ?? {})) {
    // A theme that writes a selector as a one-line function is as much data as
    // one that writes it as a value; MangaCatalog does the former throughout.
    const found = str(text, member) ?? fnStr(text, member);
    if (found) selectors[field] = found;
  }
  if (Object.keys(selectors).length > 0) config.selectors = selectors;

  Object.assign(config, dateFormat(text));
  const ms = interval(text);
  if (ms) config.minIntervalMs = ms;

  // Overridden functions are logic, not data. Counting them is how the run can
  // say how much it could not carry across.
  const code = (text.match(/override\s+(?:suspend\s+)?fun\s+/g) ?? []).length;
  return { config, code };
}

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
  const { config, code } = overrides(theme, join(dirname(file), 'src'));

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
    ...(Object.keys(config).length > 0 ? { config } : {}),
    ...(code > 0 ? { unportedOverrides: code } : {}),
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

  // Corrections we have checked against the live site. Upstream is not always
  // current — a site moves its archive and the extension is not updated for
  // months — and a source that 404s on every request is worse than one nobody
  // offered. Applied last so re-running the script never loses them.
  const corrections = existsSync(OVERRIDES)
    ? (JSON.parse(readFileSync(OVERRIDES, 'utf8')).sources ?? {})
    : {};
  let corrected = 0;
  let retired = 0;
  for (const entry of out) {
    const fix = corrections[entry.pkgName];
    if (!fix) continue;
    if (fix.baseUrl) entry.baseUrl = fix.baseUrl.replace(/\/+$/, '');
    // A site can migrate between themes without its extension being updated,
    // and then it is not a selector that is wrong but the whole engine.
    if (fix.theme) entry.theme = fix.theme;
    if (fix.config) entry.config = { ...entry.config, ...fix.config };
    if (fix.retired) entry.retired = fix.retired;
    if (fix.retired) retired += 1;
    else corrected += 1;
  }
  const unknown = Object.keys(corrections).filter(
    (pkg) => !out.some((entry) => entry.pkgName === pkg),
  );

  out.sort((a, b) => a.name.localeCompare(b.name));

  say(`added ${added}, base URL changed ${moved}, kept ${dropped.length} no longer upstream`);
  for (const entry of dropped) say(`  kept (gone upstream): ${entry.pkgName}`);
  say(`corrected ${corrected}, retired ${retired} from sources.overrides.json`);
  // A correction whose source is gone is dead weight that reads as coverage.
  for (const pkg of unknown) say(`  override matches no source: ${pkg}`);
  say(`total ${out.length}, of which ${out.filter((e) => e.retired).length} retired`);

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
        // Where these came from, carried as data so the Sources page can say so
        // rather than crediting a "Built-in" catalogue for somebody else's work.
        store: {
          name: 'Keiyoushi',
          indexUrl: 'https://keiyoushi.github.io/extensions/',
        },
        extensions: out,
      },
      null,
      2,
    )}\n`,
  );
  say(`wrote ${OUT}`);
}

main();
