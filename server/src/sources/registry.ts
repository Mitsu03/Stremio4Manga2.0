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

interface ThemedEntry {
  pkgName: string;
  name: string;
  lang: string;
  theme: string;
  baseUrl: string;
  id: string;
  contentWarning: 'SAFE' | 'MIXED' | 'NSFW';
  versionName: string;
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
 * around an engine that does the work. `sources.themed.json` carries the same
 * four values for every such site a v1 install had, so they cost a row of data
 * instead of a file of code.
 *
 * A theme this build does not have is skipped rather than guessed at: the entry
 * disappears from the catalogue, which is the honest outcome — better than a
 * source that installs and then fails on every search.
 */
const THEMED: SourceDefinition[] = (themed.extensions as ThemedEntry[]).flatMap((entry) => {
  const shared = {
    id: entry.id,
    name: entry.name,
    lang: entry.lang,
    baseUrl: entry.baseUrl,
    contentWarning: entry.contentWarning,
  };
  const build =
    entry.theme === 'madara'
      ? (deps: SourceDeps) => createMadaraSource(shared, deps)
      : entry.theme === 'mangathemesia'
        ? (deps: SourceDeps) => createMangaThemesiaSource(shared, deps)
        : undefined;
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
 * Give a brand-new account the built-in catalogue, already installed.
 *
 * Version 1 did this too — its gateway installed a frozen list of 299 keiyoushi
 * packages the moment an account was created — and without it the Sources page,
 * Discover and every search open empty on a first sign-in, which reads as the
 * app being broken rather than as a choice waiting to be made.
 *
 * The guard is "no rows at all", never "nothing installed". Uninstalling leaves
 * the row behind with `installed = 0` (see `uninstall`), so somebody who has
 * deliberately cleared their sources still has rows and is never re-seeded.
 * Only an account that has never been seeded has none, which is what makes this
 * safe to run over existing accounts at boot as well as at creation.
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
    for (const definition of DEFINITIONS) install(db, userId, definition.pkgName);
  });
  return DEFINITIONS.length;
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
  db.run('UPDATE source_state SET installed = 0 WHERE user_id = ? AND pkg_name = ?', userId, pkgName);
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
export function prepareFilters(
  id: SourceId,
  changes: FilterChange[] | undefined,
): FilterChange[] {
  const source = getSource(id);
  return source ? sanitizeFilterChanges(source.getFilters(), changes) : [];
}
