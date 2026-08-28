/**
 * The catalogue: which sources exist, which ones an account has switched on, and
 * the two translations the GraphQL layer needs in each direction.
 *
 * There is no dynamic loading here on purpose. The server this replaces
 * discovered sources by downloading APKs from a third-party index and loading
 * dex; a source is now a module in `sites/`, so the set is whatever was compiled
 * in, `import` is the only loader, and there is nothing to update at runtime.
 *
 * "Installing" therefore means one row in `source_state`. It is per account
 * because two people sharing a server should not have to share a taste in
 * scanlation sites, and because a NSFW source switched on by one of them must
 * not appear in the other's search.
 */
import type { Config } from '../config.js';
import type { Db } from '../db/open.js';
import { createHttpClient, type HttpClient } from './http.js';
import type {
  FilterChange,
  FilterSpec,
  Source,
  SourceDefinition,
  SourceDeps,
  SourceId,
} from './types.js';
import themed from '../../sources.themed.json' with { type: 'json' };
import { createMadaraSource } from './themes/madara.js';
import { createMangaThemesiaSource } from './themes/mangathemesia.js';
import { createIkenSource } from './themes/iken.js';
import { createKeyoappSource } from './themes/keyoapp.js';
import { createMangaCatalogSource } from './themes/mangacatalog.js';
import { createMangaHubSource } from './themes/mangahub.js';

interface ThemedEntry {
  pkgName: string;
  name: string;
  lang: string;
  theme: string;
  baseUrl: string;
  id: string;
  contentWarning: 'SAFE' | 'MIXED' | 'NSFW';
  versionName: string;
  /**
   * How this site differs from its theme's defaults, read off the extension's
   * own Kotlin by `tools/sync-keiyoushi.mjs`.
   *
   * Absent only for a site that overrides nothing — 30 of 315 upstream, which
   * is why leaving this out was never the harmless simplification it looked
   * like. The fields are a subset of each engine's own config type; a key the
   * engine does not know is ignored rather than rejected, so the generator can
   * carry a value across before the engine has a use for it.
   */
  config?: Record<string, unknown>;
  /**
   * How many *functions* the upstream extension overrode. Those are logic, not
   * data, so none of them came across; the count is kept so a source that is
   * only approximately right can say so instead of looking exact.
   */
  unportedOverrides?: number;
  /**
   * Why this site is gone, when it has been checked and found gone.
   *
   * The row stays — its id is on somebody's manga rows and must never be handed
   * to a second site — but the source is not built, so a dead host stops costing
   * a slot and a timeout in every sweep.
   */
  retired?: string;
}

import { definition as mangadex } from './sites/mangadex.js';
import { definition as comick } from './sites/comick.js';
import { definition as weebcentral } from './sites/weebcentral.js';
import { definition as mangadistrict } from './sites/mangadistrict.js';
import { definition as asurascans } from './sites/asurascans.js';
import { definition as rizzfables } from './sites/rizzfables.js';

/**
 * The themed sources, built from data rather than written out.
 *
 * Most of what the old server installed was not bespoke code: a keiyoushi
 * extension is very often one WordPress theme pointed at one domain, which is
 * why `sites/mangadistrict.ts` and `sites/rizzfables.ts` are twenty lines each
 * around an engine that does the work. `sources.themed.json` carries one row per
 * such site, so they cost data instead of a file of code.
 *
 * A row is not only the site's identity. Nearly every install differs from its
 * theme somewhere — a renamed URL path, a moved selector, dates in another
 * language — and each row carries those differences in `config`, spread into the
 * engine below. Leaving them out was not the harmless simplification it looked
 * like: it is what made two thirds of these sources return nothing.
 *
 * A theme this build does not have is skipped rather than guessed at: the entry
 * disappears from the catalogue, which is the honest outcome — better than a
 * source that installs and then fails on every search. A site checked and found
 * gone is `retired` for the same reason, and keeps its row so its id stays
 * reserved.
 */
const THEMED: SourceDefinition[] = (themed.extensions as ThemedEntry[]).flatMap((entry) => {
  // Checked and found gone. Keeping the row keeps the id reserved; building the
  // source would only spend a request per sweep to rediscover that.
  if (entry.retired !== undefined) return [];

  const shared = {
    id: entry.id,
    name: entry.name,
    lang: entry.lang,
    baseUrl: entry.baseUrl,
    contentWarning: entry.contentWarning,
    // Spread last so a site's own values win over the identity fields only if
    // they collide, which they cannot: the generator never emits those keys.
    ...entry.config,
  };
  // Adding an engine is three edits and no new concept: write it beside its
  // siblings under `themes/`, add its name to `SUPPORTED` in
  // `tools/sync-keiyoushi.mjs`, and add a case here. Every upstream extension on
  // that theme then arrives at once, which is the whole point of themed sources.
  // Written out rather than kept in a table because each engine takes its own
  // config type, and a table would have to erase all of them to one.
  let build: ((deps: SourceDeps) => Source) | undefined;
  switch (entry.theme) {
    // Upstream splits Madara across two libraries and names the older one
    // `madaralegacy`, which reads like a different engine and is not: every
    // selector the two declare — title, status, description, thumbnail, genre,
    // chapter row, chapter date, page list — is character-for-character the same
    // string, and the whole of the difference is in how the listing and the
    // chapter list are *requested*. Those are `listingMode` and `chapterSource`
    // here, and both already exist because the modern library needs them too.
    case 'madara':
    case 'madaralegacy':
      build = (deps) => createMadaraSource(shared, deps);
      break;
    case 'mangathemesia':
      build = (deps) => createMangaThemesiaSource(shared, deps);
      break;
    case 'iken':
      build = (deps) => createIkenSource(shared, deps);
      break;
    case 'keyoapp':
      build = (deps) => createKeyoappSource(shared, deps);
      break;
    case 'mangacatalog':
      build = (deps) => createMangaCatalogSource(shared, deps);
      break;
    case 'mangahub':
      build = (deps) => createMangaHubSource(shared, deps);
      break;
    default:
      build = undefined;
  }
  if (!build) return [];

  return [
    {
      pkgName: entry.pkgName,
      name: entry.name,
      lang: entry.lang,
      id: entry.id,
      contentWarning: entry.contentWarning,
      versionName: entry.versionName,
      build,
    },
  ];
});

const DEFINITIONS: SourceDefinition[] = [
  mangadex,
  comick,
  weebcentral,
  mangadistrict,
  asurascans,
  rizzfables,
  ...THEMED,
];

/**
 * Per-source floors, on top of the global one in `http.ts`.
 *
 * These can only ever make a source *slower*: the client clamps anything below
 * `MIN_INTERVAL_MS`. The two WordPress sites get extra room because a shared
 * host is where an aggressive reader is noticed first, and being noticed there
 * means the whole server's address stops being served.
 */
const INTERVAL_MS: Record<string, number> = {
  mangadistrict: 2_000,
  rizzfables: 2_000,
};

let client: HttpClient | undefined;
const instances = new Map<SourceId, Source>();

/**
 * Called once at boot with the real config. Without it the registry still works,
 * only with no Cloudflare solver — which is the same as an operator who has not
 * set one up, so there is no separate uninitialised state to handle.
 */
export function configureSources(config: Pick<Config, 'flaresolverr'>): void {
  client = createHttpClient(config);
  // Instances hold a client bound to the old settings; drop them so the new
  // solver is picked up rather than quietly ignored until restart.
  instances.clear();
}

function httpClient(): HttpClient {
  client ??= createHttpClient({ flaresolverr: { url: '', timeoutMs: 60_000 } });
  return client;
}

/**
 * A view of the one client for callers that are not a source instance — the
 * downloader, which fetches page images itself.
 *
 * It has to come from here rather than from a second `createHttpClient`: the
 * per-host queue, the cookie jar, the Cloudflare clearance and the circuit
 * breaker are all per-client, so a second client would mean a download and a
 * search hitting the same site at the same moment, each paying none of the
 * other's spacing. That is exactly how an IP gets banned.
 */
export function sourceHttpFor(options: {
  sourceName: string;
  minIntervalMs?: number;
  timeoutMs?: number;
}) {
  return httpClient().clientFor(options);
}

export function allDefinitions(): SourceDefinition[] {
  return DEFINITIONS;
}

export function definitionById(id: SourceId): SourceDefinition | undefined {
  return DEFINITIONS.find((definition) => definition.id === id);
}

export function definitionByPkg(pkgName: string): SourceDefinition | undefined {
  return DEFINITIONS.find((definition) => definition.pkgName === pkgName);
}

/**
 * Sources are stateless and cheap, but each one owns an HTTP client whose cookie
 * jar and rate limiter only work if there is exactly one of it, so they are
 * built once and kept.
 */
export function getSource(id: SourceId): Source | undefined {
  const cached = instances.get(id);
  if (cached) return cached;

  const definition = definitionById(id);
  if (!definition) return undefined;

  const source = definition.build({
    http: httpClient().clientFor({
      sourceName: definition.name,
      minIntervalMs: INTERVAL_MS[definition.pkgName],
    }),
  });
  instances.set(id, source);
  return source;
}

// ------------------------------------------------------------- per account --

interface StateRow {
  pkg_name: string;
}

export function installedPkgNames(db: Db, userId: string): Set<string> {
  const rows = db.all<StateRow>(
    'SELECT pkg_name FROM source_state WHERE user_id = ? AND installed = 1',
    userId,
  );
  return new Set(rows.map((row) => row.pkg_name));
}

export function installedFor(db: Db, userId: string): SourceDefinition[] {
  const installed = installedPkgNames(db, userId);
  return DEFINITIONS.filter((definition) => installed.has(definition.pkgName));
}

export function isInstalled(db: Db, userId: string, pkgName: string): boolean {
  return (
    db.get<StateRow>(
      'SELECT pkg_name FROM source_state WHERE user_id = ? AND pkg_name = ? AND installed = 1',
      userId,
      pkgName,
    ) !== undefined
  );
}

/**
 * Which languages a brand-new account starts with switched on.
 *
 * `all` is the language of the sources that are not in one language at all —
 * aggregators that serve every translation from the same catalogue — so it
 * belongs with `en` rather than with a language somebody would have to pick.
 *
 * The other twelve languages are not missing: the whole catalogue is on the
 * Sources page from the first sign-in, every row switchable (see the
 * `extensions` resolver, which never filters on install state). This decides
 * what is *already on*, not what exists.
 */
const SEEDED_LANGS = new Set(['en', 'all']);

/** The subset of the catalogue a new account is seeded with. */
const SEEDED = DEFINITIONS.filter((definition) => SEEDED_LANGS.has(definition.lang));

/**
 * Give a brand-new account the English and multi-language catalogue, already
 * installed.
 *
 * Version 1 did this too — its gateway installed a frozen list of 299 keiyoushi
 * packages the moment an account was created — and without it the Sources page,
 * Discover and every search open empty on a first sign-in, which reads as the
 * app being broken rather than as a choice waiting to be made.
 *
 * Seeding *everything* had the opposite failure: a search fanned out across all
 * 405 sources, most of them in languages the reader does not have, so the wait
 * and the shelves of nothing were paid for on every query. Turkish, Spanish,
 * Arabic and the rest stay one toggle away on the Sources page instead — which
 * is a choice worth making, unlike an empty install.
 *
 * The guard is "no rows at all", never "nothing installed". Uninstalling leaves
 * the row behind with `installed = 0` (see `uninstall`), so somebody who has
 * deliberately cleared their sources still has rows and is never re-seeded.
 * Only an account that has never been seeded has none, which is what makes this
 * safe to run over existing accounts at boot as well as at creation — including
 * accounts seeded with all 405 before this narrowed: they have rows, so nothing
 * here touches them.
 *
 * Returns how many were installed, so a caller can say so.
 */
export function seedDefaults(db: Db, userId: string): number {
  const seen = db.get<StateRow>(
    'SELECT pkg_name FROM source_state WHERE user_id = ? LIMIT 1',
    userId,
  );
  if (seen !== undefined) return 0;

  db.transaction(() => {
    for (const definition of SEEDED) install(db, userId, definition.pkgName);
  });
  return SEEDED.length;
}

/**
 * What it would take to bring an account back to the seed a new one gets.
 *
 * Seeding is one-shot by design — the guard in `seedDefaults` is "no rows at
 * all" — which is right for a server that must never override somebody's
 * choices at boot, and useless to the person who wants their own account moved
 * to a default that changed after they created it. This is that move, computed
 * rather than applied, because turning sources off is not something to do as a
 * side effect of asking what would happen.
 *
 * Both directions matter. An account seeded before the catalogue narrowed has
 * sources to switch *off*; an account that predates seeding entirely, or one
 * that cleared everything, has sources to switch on.
 */
export interface SeedDiff {
  install: string[];
  uninstall: string[];
}

export function diffAgainstSeed(db: Db, userId: string): SeedDiff {
  const installed = installedPkgNames(db, userId);
  const seeded = new Set(SEEDED.map((definition) => definition.pkgName));
  return {
    install: SEEDED.filter((definition) => !installed.has(definition.pkgName)).map(
      (definition) => definition.pkgName,
    ),
    uninstall: DEFINITIONS.filter(
      (definition) => !seeded.has(definition.pkgName) && installed.has(definition.pkgName),
    ).map((definition) => definition.pkgName),
  };
}

/**
 * One transaction, so an interrupted reseed leaves the account as it was rather
 * than half-way between two defaults.
 */
export function applySeedDiff(db: Db, userId: string, diff: SeedDiff): void {
  db.transaction(() => {
    for (const pkgName of diff.install) install(db, userId, pkgName);
    for (const pkgName of diff.uninstall) uninstall(db, userId, pkgName);
  });
}

export function install(db: Db, userId: string, pkgName: string): void {
  db.run(
    `INSERT INTO source_state (user_id, pkg_name, installed, installed_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(user_id, pkg_name) DO UPDATE SET installed = 1, installed_at = excluded.installed_at`,
    userId,
    pkgName,
    Date.now(),
  );
}

/**
 * Kept as a row with `installed = 0` rather than deleted: a library entry from
 * an uninstalled source still has to render, and the row is what says "this
 * person knows about this source" once they turn it back on.
 */
export function uninstall(db: Db, userId: string, pkgName: string): void {
  db.run(
    'UPDATE source_state SET installed = 0 WHERE user_id = ? AND pkg_name = ?',
    userId,
    pkgName,
  );
}

// -------------------------------------------------------- filter transport --

/**
 * What the GraphQL `Filter` union carries on the wire.
 *
 * The executor's `resolveType` switches on `kind` — the same discriminator
 * `FilterSpec` already uses — so this is a structural copy rather than a
 * mapping. It exists because the union's members are named types with fixed
 * field sets (`SortFilter.default` is nullable, `SelectFilter.default` is not),
 * and because a `FilterSpec` must never be handed to the executor by reference:
 * a resolver that mutated one would change the source's own filter list for
 * every later request.
 */
export interface GraphQLFilter {
  kind: FilterSpec['kind'];
  name: string;
  values?: string[];
  default?: number | string | boolean | { index: number; ascending: boolean } | null;
  filters?: GraphQLFilter[];
}

export function toGraphQLFilters(specs: FilterSpec[]): GraphQLFilter[] {
  return specs.map((spec): GraphQLFilter => {
    switch (spec.kind) {
      case 'header':
      case 'separator':
        return { kind: spec.kind, name: spec.name };
      case 'select':
        return { kind: 'select', name: spec.name, values: [...spec.values], default: spec.default };
      case 'text':
        return { kind: 'text', name: spec.name, default: spec.default };
      case 'checkbox':
        return { kind: 'checkbox', name: spec.name, default: spec.default };
      case 'tristate':
        return { kind: 'tristate', name: spec.name, default: spec.default };
      case 'sort':
        return {
          kind: 'sort',
          name: spec.name,
          values: [...spec.values],
          default: spec.default ? { ...spec.default } : null,
        };
      case 'group':
        return { kind: 'group', name: spec.name, filters: toGraphQLFilters(spec.filters) };
    }
  });
}

export function filtersFor(id: SourceId): GraphQLFilter[] {
  const source = getSource(id);
  return source ? toGraphQLFilters(source.getFilters()) : [];
}

/**
 * Drops changes that cannot mean anything, and keeps the rest exactly as sent.
 *
 * `position` indexes the list the source returned *including* its headers and
 * separators, because that is what the client indexes: it renders a subset but
 * numbers the whole. Rewriting positions here would therefore be wrong even
 * though it looks tidier — a source reads its own filter list by the same index.
 *
 * A change whose state field does not match the filter sitting at that position
 * is dropped rather than coerced: it means the client's cached filter list is
 * older than the source's, and applying it would silently search for something
 * nobody asked for.
 */
export function sanitizeFilterChanges(
  specs: FilterSpec[],
  changes: FilterChange[] | undefined,
): FilterChange[] {
  if (!changes || changes.length === 0) return [];
  const out: FilterChange[] = [];

  for (const change of changes) {
    const spec = specs[change.position];
    if (!spec) continue;

    if (spec.kind === 'group') {
      // `groupChange` descends exactly one level; the schema has no deeper form
      // and a group inside a group could never be addressed.
      const inner = change.groupChange;
      if (!inner) continue;
      const [kept] = sanitizeFilterChanges(spec.filters, [inner]);
      if (kept) out.push({ position: change.position, groupChange: kept });
      continue;
    }

    const matches =
      (spec.kind === 'select' && typeof change.selectState === 'number') ||
      (spec.kind === 'text' && typeof change.textState === 'string') ||
      (spec.kind === 'checkbox' && typeof change.checkBoxState === 'boolean') ||
      (spec.kind === 'tristate' && typeof change.triState === 'string') ||
      (spec.kind === 'sort' && typeof change.sortState?.index === 'number');
    if (matches) out.push(change);
  }

  return out;
}

/** Both halves in one call, for the resolvers that only ever need this. */
export function prepareFilters(id: SourceId, changes: FilterChange[] | undefined): FilterChange[] {
  const source = getSource(id);
  return source ? sanitizeFilterChanges(source.getFilters(), changes) : [];
}
