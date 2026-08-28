#!/usr/bin/env node
/**
 * The end-to-end check: a real server, a real database, two real accounts.
 *
 * Written in Node rather than as a shell script for one reason — it has to run
 * unchanged on a Windows workstation and inside a Linux container, and `curl`,
 * `jq` and a POSIX shell are only reliably present on one of those. Node is
 * present by definition: it is the thing being tested.
 *
 * Everything happens in a temporary directory that is removed at the end, so a
 * run leaves nothing behind and never touches a real deployment's data.
 *
 *   node test/smoke.mjs              full run, including live sources
 *   node test/smoke.mjs --offline    skip the checks that need the internet
 *
 * Exits non-zero on the first failed assertion, naming what was expected.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const serverDir = join(repo, 'server');
const dist = join(serverDir, 'dist');

const OFFLINE = process.argv.includes('--offline');
const PORT = Number(process.env.SMOKE_PORT ?? 8099);
const ORIGIN = `http://127.0.0.1:${PORT}`;

// A source that answers has to be one whose chapters are not licensed away.
// Frieren is on MangaDex but every chapter is a link to the publisher, so the
// search below walks its results until one has chapters of its own — see the
// licensed-title branch in sources/sites/mangadex.ts.
const MANGADEX_ID = '1000000000000000001';
const SEARCH_TERM = 'Frieren';

let passed = 0;
const failures = [];
let workDir;
let server;

const log = (text) => process.stdout.write(`${text}\n`);

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  log(`\n${title}`);
}

// ------------------------------------------------------------------ server --

function cli(args, input) {
  return spawnSync(process.execPath, [join(dist, 'cli.js'), ...args], {
    env: { ...process.env, S4M_CONFIG: join(workDir, 'config.json') },
    input,
    encoding: 'utf8',
  });
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/gateway/health`);
      if (response.ok) return await response.json();
    } catch {
      // Not listening yet. The loop's deadline is the only timeout that matters.
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Server did not answer on ${ORIGIN} within ${timeoutMs}ms`);
}

/** A cookie jar of exactly the size this needs: one cookie, per account. */
function jar() {
  let cookie = '';
  return {
    capture(response) {
      const header = response.headers.getSetCookie?.() ?? [];
      for (const entry of header) {
        const value = entry.split(';')[0];
        if (value.startsWith('s4m_session=')) cookie = value;
      }
    },
    get header() {
      return cookie;
    },
  };
}

async function api(session, path, init = {}) {
  const response = await fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      Origin: ORIGIN,
      ...(session.header ? { Cookie: session.header } : {}),
      ...init.headers,
    },
    redirect: 'manual',
  });
  session.capture(response);
  return response;
}

async function gql(session, query, variables) {
  const response = await api(session, '/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  return response.json();
}

async function login(username, password) {
  const session = jar();
  const response = await api(session, '/gateway/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`Sign-in failed for ${username}: ${response.status}`);
  return session;
}

// ------------------------------------------------------------------- setup --

function setup() {
  if (!existsSync(join(dist, 'main.js')) || !existsSync(join(dist, 'cli.js'))) {
    throw new Error('server/dist is missing. Run `npm run build` first.');
  }

  workDir = mkdtempSync(join(tmpdir(), 's4m-smoke-'));
  writeFileSync(
    join(workDir, 'config.json'),
    JSON.stringify(
      {
        publicOrigin: ORIGIN,
        listen: { host: '127.0.0.1', port: PORT },
        trustProxy: false,
        dataDir: join(workDir, 'data'),
        uiDist: join(repo, 'web', 'dist'),
      },
      null,
      2,
    ),
  );

  for (const account of ['smoke-a', 'smoke-b']) {
    const result = cli(
      ['users', 'add', account, '--password-stdin', '--yes'],
      `${account}-password\n`,
    );
    if (result.status !== 0) {
      throw new Error(`Could not create ${account}: ${result.stderr || result.stdout}`);
    }
  }

  server = spawn(process.execPath, [join(dist, 'main.js')], {
    env: { ...process.env, S4M_CONFIG: join(workDir, 'config.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
}

function teardown() {
  if (server && !server.killed) server.kill();
  if (workDir) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Windows can hold the database file briefly after the process exits; a
      // leftover temp directory is not worth failing a passing run over.
    }
  }
}

// ------------------------------------------------------------------ checks --

/**
 * The generated source catalogue, checked before a server is even started.
 *
 * `sources.themed.json` is written by a script that reads somebody else's
 * repository, so a bad upstream parse arrives here as data rather than as a
 * crash — and the failure it causes is silent: sources that install and then
 * answer nothing. These are the invariants that were actually violated the last
 * time that happened, which is the only reason each one is here.
 */
function checkCatalogueData() {
  section('Generated source catalogue');
  const themed = JSON.parse(readFileSync(join(serverDir, 'sources.themed.json'), 'utf8')).extensions;

  check('the themed catalogue is not empty', themed.length > 0, `${themed.length} rows`);

  // Ids are written onto manga rows, so a duplicate silently repoints a library.
  const ids = themed.map((entry) => entry.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  check('every source id is unique', duplicates.length === 0, duplicates.join(', '));

  const incomplete = themed.filter((entry) => !entry.id || !entry.pkgName || !entry.baseUrl);
  check(
    'every row has an id, a package name and a base URL',
    incomplete.length === 0,
    incomplete.map((entry) => entry.pkgName ?? '(nameless)').join(', '),
  );

  // A retired row keeps its id reserved but has to say why, or nobody can tell a
  // deliberate retirement from a row that lost its fields.
  const mute = themed.filter((entry) => 'retired' in entry && !entry.retired);
  check(
    'every retired source gives a reason',
    mute.length === 0,
    mute.map((entry) => entry.pkgName).join(', '),
  );

  // A config key no engine reads yet is carried on purpose — it is how a value
  // survives until an engine gains a use for it — but a *misspelt* key is
  // indistinguishable from that unless the intended set is written down.
  const KNOWN = new Set([
    'mangaPath',
    'listPath',
    'searchMode',
    'variant',
    'chapterSource',
    'chapterMode',
    'filterNonMangaItems',
    'hasProjectPage',
    'pageSelector',
    'selectors',
    'dateFormat',
    'dateLocale',
    'minIntervalMs',
    'omitSort',
    'listingMode',
    'genres',
    'headers',
    'usesCloudflare',
  ]);
  const strange = [
    ...new Set(
      themed.flatMap((entry) => Object.keys(entry.config ?? {})).filter((key) => !KNOWN.has(key)),
    ),
  ];
  check(
    'every config key is one the generator meant to emit',
    strange.length === 0,
    strange.join(', '),
  );

  // If nothing carries an archive path, the generator has stopped reading the
  // Kotlin and every site that renames its archive is back to a 404 per request
  // — which is the failure this data was added to fix, and it looks like
  // success from everywhere else.
  const withPath = themed.filter((entry) => entry.config?.mangaPath).length;
  check('sites that rename their archive carry a path', withPath > 0, `${withPath} rows`);
}

async function run() {
  checkCatalogueData();
  setup();

  section('Server and accounts');
  const health = await waitForHealth();
  check(
    'health reports both accounts',
    health.ok === true && health.users === 2,
    JSON.stringify(health),
  );

  const anon = jar();
  const unauth = await api(anon, '/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{__typename}' }),
  });
  check('GraphQL refuses an unauthenticated request', unauth.status === 401, `got ${unauth.status}`);

  const wrong = await api(jar(), '/gateway/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'smoke-a', password: 'not-the-password' }),
  });
  check('a wrong password is refused', wrong.status === 401, `got ${wrong.status}`);

  const a = await login('smoke-a', 'smoke-a-password');
  const b = await login('smoke-b', 'smoke-b-password');
  const me = await (await api(a, '/gateway/me')).json();
  check('the session identifies the account', me.username === 'smoke-a', JSON.stringify(me));

  const noOrigin = await fetch(`${ORIGIN}/gateway/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'smoke-a', password: 'smoke-a-password' }),
  });
  check(
    'a request with neither Origin nor Sec-Fetch-Site is refused',
    noOrigin.status === 403,
    `got ${noOrigin.status}`,
  );

  section('Catalogue, categories, settings, tracker');
  const extensions = await gql(
    a,
    '{extensions(order:[{by:NAME}]){nodes{pkgName name isInstalled source{totalCount}}} extensionStores{nodes{name indexUrl}}}',
  );
  const catalogue = extensions.data?.extensions?.nodes ?? [];
  check('the built-in catalogue lists sources', catalogue.length > 0, `${catalogue.length} entries`);
  // The opposite of what this asserted before the catalogue was seeded: an
  // account that can reach nothing looks, on screen, exactly like an account
  // whose server is broken.
  check(
    'the whole catalogue is installed on a new account',
    catalogue.length > 0 && catalogue.every((entry) => entry.isInstalled),
    catalogue
      .filter((entry) => !entry.isInstalled)
      .map((entry) => entry.pkgName)
      .join(', ') || `${catalogue.length} installed`,
  );
  // Two stores, and which two matters: the sources are largely catalogued by
  // keiyoushi, and a page that credits only "Built-in" cannot tell anyone where
  // they came from.
  const stores = extensions.data?.extensionStores?.nodes ?? [];
  check(
    'both extension stores are listed, keiyoushi named among them',
    stores.length === 2 && stores.some((store) => /keiyoushi/i.test(store.indexUrl)),
    JSON.stringify(stores),
  );

  const categories = await gql(a, '{categories{nodes{id name default mangas{totalCount}}}}');
  const nodes = categories.data?.categories?.nodes ?? [];
  check(
    'Default exists as a virtual category',
    nodes.length === 1 && nodes[0].id === 0 && nodes[0].default === true,
    JSON.stringify(nodes),
  );

  const settings = await gql(a, '{settings{backupInterval backupTime backupTTL autoBackupIncludeManga}}');
  check(
    'settings come back with defaults',
    settings.data?.settings?.backupTime === '02:00',
    JSON.stringify(settings.data),
  );

  const tracker = await gql(a, '{tracker(id:2){id name isLoggedIn authUrl}}');
  check(
    'the AniList tracker is present and signed out',
    tracker.data?.tracker?.name === 'AniList' && tracker.data.tracker.isLoggedIn === false,
  );

  section('Meta round-trip');
  const value = JSON.stringify({ theme: 'dark' });
  await gql(
    a,
    'mutation($v:String!){setGlobalMeta(input:{meta:{key:"stremio4manga.settings",value:$v}}){meta{key}}}',
    { v: value },
  );
  const readBack = await gql(a, '{metas(condition:{key:"stremio4manga.settings"}){nodes{key value}}}');
  check('global meta survives a round-trip', readBack.data?.metas?.nodes?.[0]?.value === value);

  const bMeta = await gql(b, '{metas(condition:{key:"stremio4manga.settings"}){nodes{key value}}}');
  check('the other account cannot see it', (bMeta.data?.metas?.nodes ?? []).length === 0);

  section('Category rules');
  const created = await gql(a, 'mutation{createCategory(input:{name:"Reading"}){category{id name}}}');
  const categoryId = created.data?.createCategory?.category?.id;
  check(
    'a category can be created',
    Number.isInteger(categoryId) && categoryId > 0,
    JSON.stringify(created),
  );

  const intoDefault = await gql(
    a,
    'mutation{updateMangasCategories(input:{ids:[],patch:{addToCategories:[0]}}){mangas{id}}}',
  );
  check(
    'filing into Default is refused rather than ignored',
    Array.isArray(intoDefault.errors) && intoDefault.errors.length > 0,
  );

  await gql(a, `mutation{deleteCategory(input:{categoryId:${categoryId}}){category{id}}}`);

  if (OFFLINE) {
    section('Live sources — skipped (--offline)');
  } else {
    await liveChecks(a, b);
  }

  section('Backups');
  const backup = await gql(a, 'mutation{createBackup(input:{}){url}}');
  const url = backup.data?.createBackup?.url;
  check(
    'a backup is created and its url is relative',
    typeof url === 'string' && url.startsWith('/api/v1/backup/'),
    String(url),
  );

  const download = await api(a, url);
  const bytes = Buffer.from(await download.arrayBuffer());
  check(
    'the backup downloads',
    download.status === 200 && bytes.length > 0,
    `${download.status}, ${bytes.length} bytes`,
  );

  const traversal = await api(a, '/api/v1/backup/..%2F..%2Fstremio4manga.db');
  check('path traversal on the backup route is refused', traversal.status === 404, `got ${traversal.status}`);

  const form = new FormData();
  form.append(
    'operations',
    JSON.stringify({
      query:
        'query ValidateBackup($backup: Upload!){validateBackup(input:{backup:$backup}){missingSources{id name} missingTrackers{name}}}',
      variables: { backup: null },
    }),
  );
  form.append('map', JSON.stringify({ 0: ['variables.backup'] }));
  form.append('0', new Blob([bytes]), 'backup.zip');
  const validated = await (await api(a, '/api/graphql', { method: 'POST', body: form })).json();
  check(
    'the multipart upload path works',
    validated.data?.validateBackup !== undefined,
    JSON.stringify(validated).slice(0, 200),
  );

  section('Password changes end sessions');
  const changed = cli(['users', 'passwd', 'smoke-b', '--password-stdin'], 'smoke-b-new-password\n');
  check('the password is changed from the CLI', changed.status === 0, changed.stderr);
  const afterChange = await api(b, '/gateway/me');
  check('the old session is refused afterwards', afterChange.status === 401, `got ${afterChange.status}`);
}

/** The half that needs the internet, and says so when the internet is what failed. */
async function liveChecks(a, b) {
  section('Live source: install, search, read');
  const installed = await gql(
    a,
    'mutation{updateExtension(input:{id:"mangadex",patch:{install:true}}){extension{pkgName isInstalled}}}',
  );
  check('a source can be installed', installed.data?.updateExtension?.extension?.isInstalled === true);

  const sources = await gql(a, '{sources{nodes{id name}}}');
  const ids = (sources.data?.sources?.nodes ?? []).map((source) => source.id);
  check('the installed source is listed', ids.includes(MANGADEX_ID), ids.join(','));
  check('the AniList pseudo-source is listed', ids.includes('1'));

  const bSources = await gql(b, '{sources{nodes{id name}}}');
  check(
    'the other account did not get the source',
    !(bSources.data?.sources?.nodes ?? []).map((source) => source.id).includes(MANGADEX_ID),
  );

  const search = await gql(
    a,
    'mutation($s:LongString!,$q:String){fetchSourceManga(input:{source:$s,type:SEARCH,page:1,query:$q}){hasNextPage mangas{id title thumbnailUrl}}}',
    { s: MANGADEX_ID, q: SEARCH_TERM },
  );
  const results = search.data?.fetchSourceManga?.mangas ?? [];
  if (results.length === 0) {
    check(
      'the source answered a search',
      false,
      `no results (network? ${JSON.stringify(search).slice(0, 200)})`,
    );
    return;
  }
  check('the source answered a search', true, `${results.length} results`);
  check(
    'covers are served same-origin, not from the remote host',
    results.every((manga) => manga.thumbnailUrl?.startsWith('/api/v1/manga/')),
    results[0]?.thumbnailUrl,
  );

  // Not every title on a catalogue has chapters here: a licensed one lists only
  // links to the publisher. Walk the results until one does, rather than
  // asserting on a title whose availability is somebody else's decision.
  let readable;
  for (const manga of results.slice(0, 6)) {
    const fetched = await gql(
      a,
      `mutation{fetchChapters(input:{mangaId:${manga.id}}){chapters{id name sourceOrder}}}`,
    );
    const chapters = fetched.data?.fetchChapters?.chapters ?? [];
    if (chapters.length > 0) {
      readable = { manga, chapter: chapters[0] };
      break;
    }
  }
  if (!readable) {
    check('at least one result has chapters', false, 'every title checked was licensed away or empty');
    return;
  }
  check('a chapter list can be fetched', true, readable.manga.title);

  const paged = await gql(
    a,
    `mutation{fetchChapterPages(input:{chapterId:${readable.chapter.id}}){pages chapter{id pageCount}}}`,
  );
  const pages = paged.data?.fetchChapterPages?.pages ?? [];
  check('pages resolve to same-origin urls', pages.length > 0 && pages[0].startsWith('/api/v1/manga/'), pages[0]);

  const image = await api(a, pages[0]);
  check(
    'a page image is served',
    image.status === 200 && (image.headers.get('content-type') ?? '').startsWith('image/'),
    `${image.status} ${image.headers.get('content-type')}`,
  );

  const retried = await api(a, `${pages[0]}?retry=1`);
  check('an unknown ?retry= parameter is tolerated', retried.status === 200, `got ${retried.status}`);

  const thumbnail = await api(a, `/api/v1/manga/${readable.manga.id}/thumbnail`);
  check('the cover is served', thumbnail.status === 200, `got ${thumbnail.status}`);

  const foreign = await api(b, pages[0]);
  check('another account cannot read the page', foreign.status === 404, `got ${foreign.status}`);

  section('Reading progress');
  const mangaId = readable.manga.id;
  const order = readable.chapter.sourceOrder;
  const patch = async (body) =>
    api(a, `/api/v1/manga/${mangaId}/chapter/${order}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

  const progressed = await patch('lastPageRead=1');
  check('progress is accepted', progressed.status === 200, `got ${progressed.status}`);

  const state = await gql(a, `{chapters(condition:{mangaId:${mangaId}}){nodes{id lastPageRead lastReadAt isRead}}}`);
  const chapterRow = (state.data?.chapters?.nodes ?? []).find((row) => row.id === readable.chapter.id);
  check('lastPageRead is stored', chapterRow?.lastPageRead === 1, JSON.stringify(chapterRow));
  check('lastReadAt is stamped by the reader', Number(chapterRow?.lastReadAt) > 0, chapterRow?.lastReadAt);

  // The whole continue-reading shelf rests on this query, and on lastReadAt
  // being compared as a number: LongString arrives as a decimal string, and
  // SQLite sorts every integer before every string, so a textual comparison
  // here is always false and the shelf silently comes back empty.
  const shelf = await gql(
    a,
    'query($since:LongString!){chapters(filter:{lastReadAt:{greaterThan:$since}},order:[{by:LAST_READ_AT,byType:DESC}],first:60){nodes{id lastReadAt manga{id title}}}}',
    { since: '0' },
  );
  check(
    'the continue-reading shelf finds it',
    (shelf.data?.chapters?.nodes ?? []).length > 0,
    JSON.stringify(shelf).slice(0, 200),
  );

  const stamp = chapterRow?.lastReadAt;
  await gql(
    a,
    `mutation{updateChapters(input:{ids:[${readable.chapter.id}],patch:{isRead:true}}){chapters{id isRead}}}`,
  );
  const afterMark = await gql(a, `{chapters(condition:{mangaId:${mangaId}}){nodes{id isRead lastReadAt}}}`);
  const marked = (afterMark.data?.chapters?.nodes ?? []).find((row) => row.id === readable.chapter.id);
  check('marking read does not stamp lastReadAt', marked?.lastReadAt === stamp, `${stamp} -> ${marked?.lastReadAt}`);
  check('marking read does set isRead', marked?.isRead === true);

  section('Downloads');
  const enqueued = await gql(
    a,
    `mutation{enqueueChapterDownloads(input:{ids:[${readable.chapter.id}]}){downloadStatus{state queue{position state}}}}`,
  );
  check(
    'enqueue does not start the downloader',
    enqueued.data?.enqueueChapterDownloads?.downloadStatus?.state === 'STOPPED',
    JSON.stringify(enqueued.data),
  );

  await gql(a, 'mutation{startDownloader(input:{}){downloadStatus{state}}}');
  const deadline = Date.now() + 120_000;
  let downloaded = false;
  while (Date.now() < deadline) {
    const onDisk = await gql(a, '{chapters(filter:{isDownloaded:{equalTo:true}}){totalCount}}');
    if ((onDisk.data?.chapters?.totalCount ?? 0) > 0) {
      downloaded = true;
      break;
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
  check('the chapter downloads and leaves the queue', downloaded);
  if (downloaded) {
    const files = countFiles(join(workDir, 'data', 'downloads'));
    check('page files are on disk', files > 0, `${files} files`);
  }
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return total;
}

// -------------------------------------------------------------------- main --

log(`Stremio4Manga smoke test${OFFLINE ? ' (offline)' : ''}`);
log(`Node ${process.version} on ${process.platform}`);

try {
  await run();
} catch (error) {
  failures.push(`threw: ${error.message}`);
  log(`\n  FAIL ${error.message}`);
} finally {
  teardown();
}

log('');
if (failures.length === 0) {
  log(`All ${passed} checks passed.`);
  process.exit(0);
}
log(`${passed} passed, ${failures.length} failed:`);
for (const failure of failures) log(`  - ${failure}`);
process.exit(1);
