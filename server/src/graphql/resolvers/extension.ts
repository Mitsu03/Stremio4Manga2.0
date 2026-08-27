/**
 * Sources and "extensions": the two halves of the same list.
 *
 * The UI was written against a server that installed Tachiyomi APKs, so it draws
 * a Sources page (what I can read from) and an Extensions page (what I could
 * install). Nothing is downloaded here — a source is a compiled-in module — so
 * "installing" is one row in `source_state` and the extension list is
 * `server/catalog.json`, which stands in for the keiyoushi index.
 *
 * Three consequences the client has to keep working through:
 *   * `fetchExtensions` has nothing to fetch and must still succeed, or the page
 *     shows an error on every visit;
 *   * `updateExtension(update: true)` has no APK to replace, so it succeeds and
 *     does nothing rather than failing on a button the UI still renders;
 *   * `addExtensionStore` cannot add anything, and must not blow up the page.
 *
 * `Query.sources` also returns a source that does not exist: AniList, id 1. The
 * library can hold entries imported from an AniList account, those rows carry
 * source id 1, and without a matching `SourceType` every one of them renders
 * with a blank source. The client already knows ids 0 and 1 are pseudo-sources
 * (`web/src/utils/sources.ts`) and never asks them to search.
 */
import { GraphQLError } from 'graphql';
import type { GraphQLContext } from '../../types.js';
import type { ResolverGroup } from './index.js';
import catalog from '../../../catalog.json' with { type: 'json' };
import themed from '../../../sources.themed.json' with { type: 'json' };
import { ANILIST_ICON } from '../../tracker/anilist.js';
import { iconPath } from '../../sources/icons.js';
import {
  allDefinitions,
  definitionById,
  definitionByPkg,
  filtersFor,
  install,
  installedPkgNames,
  uninstall,
} from '../../sources/registry.js';
import type { SourceDefinition } from '../../sources/types.js';

/** The AniList pseudo-source. Id 1 is fixed by the client and by the schema. */
const ANILIST_SOURCE_ID = '1';

interface CatalogSource {
  id: string;
  name: string;
  lang: string;
}

interface CatalogExtension {
  pkgName: string;
  name: string;
  lang: string;
  versionName: string;
  contentWarning: string;
  sources: CatalogSource[];
}

/**
 * The catalogue as shipped, minus anything the registry cannot actually build.
 *
 * The two lists are generated from each other and committed together, so this
 * filter should never remove anything. It exists so that if they ever do drift,
 * the failure is a source missing from the list rather than an install button
 * that produces a source id nothing can resolve.
 */
const EXTENSIONS: CatalogExtension[] = [
  ...(catalog.extensions as CatalogExtension[]),
  // The themed sources describe themselves well enough to be catalogue entries
  // without being written out twice: one source each, named after the site.
  // Copying them into catalog.json would only create two files to keep in step.
  ...(
    themed.extensions as {
      pkgName: string;
      name: string;
      lang: string;
      versionName: string;
      contentWarning: string;
      id: string;
    }[]
  ).map((entry) => ({
    pkgName: entry.pkgName,
    name: entry.name,
    lang: entry.lang,
    versionName: entry.versionName,
    contentWarning: entry.contentWarning,
    sources: [{ id: entry.id, name: entry.name, lang: entry.lang }],
  })),
].filter((extension) => definitionByPkg(extension.pkgName) !== undefined);

const isNsfw = (warning: string): boolean => warning === 'NSFW';

/**
 * What a person calls the source. English is the overwhelming majority here and
 * "MangaDex (EN)" would be noise on every row; anything else earns its tag.
 */
const displayName = (name: string, lang: string): string =>
  lang === 'en' || lang === 'all' ? name : `${name} (${lang.toUpperCase()})`;

function toSource(definition: SourceDefinition) {
  return {
    id: definition.id,
    name: definition.name,
    lang: definition.lang,
    iconUrl: iconPath(definition.pkgName),
    // Every source here implements a latest listing; the field stays because
    // the client hides the "Latest" tab on the ones that do not.
    supportsLatest: true,
    contentWarning: definition.contentWarning,
    isNsfw: isNsfw(definition.contentWarning),
    displayName: displayName(definition.name, definition.lang),
  };
}

const anilistSource = () => ({
  id: ANILIST_SOURCE_ID,
  name: 'AniList',
  lang: 'all',
  iconUrl: ANILIST_ICON,
  supportsLatest: false,
  contentWarning: 'SAFE',
  isNsfw: false,
  displayName: 'AniList',
  // Nothing can be searched here, so the filter list is empty rather than
  // absent: the field is non-null in the schema.
  filters: [],
});

type OrderBy = 'PKG_NAME' | 'NAME' | 'LANG';
interface ExtensionOrder {
  by: OrderBy;
  byType?: 'ASC' | 'DESC' | null;
}

const ORDER_FIELD: Record<OrderBy, keyof CatalogExtension> = {
  PKG_NAME: 'pkgName',
  NAME: 'name',
  LANG: 'lang',
};

function sortExtensions(
  extensions: CatalogExtension[],
  order: ExtensionOrder[] | ExtensionOrder | null | undefined,
): CatalogExtension[] {
  // GraphQL input coercion means a single object is a valid list of one, and the
  // client sends both forms against this field.
  const orders = order === null || order === undefined ? [] : Array.isArray(order) ? order : [order];
  if (orders.length === 0) return extensions;

  return [...extensions].sort((left, right) => {
    for (const rule of orders) {
      const field = ORDER_FIELD[rule.by];
      if (!field) continue;
      const comparison = String(left[field]).localeCompare(String(right[field]), undefined, {
        sensitivity: 'base',
      });
      if (comparison !== 0) return rule.byType === 'DESC' ? -comparison : comparison;
    }
    return 0;
  });
}

function toExtension(extension: CatalogExtension, installed: boolean) {
  return {
    pkgName: extension.pkgName,
    name: extension.name,
    lang: extension.lang,
    versionName: extension.versionName,
    // Served by us, not linked at the site: see sources/icons.ts.
    iconUrl: iconPath(extension.pkgName),
    contentWarning: extension.contentWarning,
    isNsfw: isNsfw(extension.contentWarning),
    isInstalled: installed,
    // Nothing is downloaded, so nothing can be out of date, and a source that
    // stops working is replaced by editing this server rather than by an update.
    hasUpdate: false,
    isObsolete: false,
    source: {
      nodes: extension.sources.map((source) => ({
        id: source.id,
        name: source.name,
        lang: source.lang,
        iconUrl: iconPath(extension.pkgName),
        supportsLatest: true,
        contentWarning: extension.contentWarning,
        isNsfw: isNsfw(extension.contentWarning),
        displayName: displayName(source.name, source.lang),
      })),
      totalCount: extension.sources.length,
    },
  };
}

export const group: ResolverGroup = {
  Query: {
    sources: (_parent: unknown, _args: unknown, context: GraphQLContext) => {
      const installed = installedPkgNames(context.db, context.userId);
      const nodes: unknown[] = allDefinitions()
        .filter((definition) => installed.has(definition.pkgName))
        .map(toSource);
      // Last, so it never displaces a real source at the top of a picker.
      nodes.push(anilistSource());
      return { nodes, totalCount: nodes.length };
    },

    source: (_parent: unknown, args: { id: string }, _context: GraphQLContext) => {
      if (args.id === ANILIST_SOURCE_ID) return anilistSource();
      const definition = definitionById(args.id);
      // Not an error: the client asks about the source id stored on a manga row,
      // and that row may predate a source being removed from this build.
      if (!definition) return null;
      return { ...toSource(definition), filters: filtersFor(definition.id) };
    },

    extensions: (
      _parent: unknown,
      args: { order?: ExtensionOrder[] | ExtensionOrder | null },
      context: GraphQLContext,
    ) => {
      const installed = installedPkgNames(context.db, context.userId);
      const nodes = sortExtensions(EXTENSIONS, args.order).map((extension) =>
        toExtension(extension, installed.has(extension.pkgName)),
      );
      return { nodes, totalCount: nodes.length };
    },

    // Two, because there are two: the handful written here, and the ones taken
    // from keiyoushi's catalogue. Listing only "Built-in" credited this server
    // with 348 sources somebody else catalogued, and left the Sources page
    // unable to point anyone at where they actually come from.
    extensionStores: () => {
      const nodes = [
        { name: catalog.name, indexUrl: catalog.indexUrl },
        { name: themed.store.name, indexUrl: themed.store.indexUrl },
      ];
      return { nodes, totalCount: nodes.length };
    },
  },

  Mutation: {
    updateExtension: (
      _parent: unknown,
      args: {
        input: {
          id: string;
          patch: { install?: boolean | null; update?: boolean | null; uninstall?: boolean | null };
        };
      },
      context: GraphQLContext,
    ) => {
      const pkgName = args.input.id;
      const extension = EXTENSIONS.find((candidate) => candidate.pkgName === pkgName);
      if (!extension) throw new GraphQLError(`No extension named ${pkgName}.`);

      const patch = args.input.patch;
      if (patch.uninstall) uninstall(context.db, context.userId, pkgName);
      else if (patch.install) install(context.db, context.userId, pkgName);
      // `update` alone falls through: there is no package to replace, and the
      // honest answer to "update this" is the extension exactly as it was.

      return {
        extension: toExtension(
          extension,
          patch.uninstall ? false : patch.install ? true : installedPkgNames(context.db, context.userId).has(pkgName),
        ),
      };
    },

    fetchExtensions: (_parent: unknown, _args: unknown, context: GraphQLContext) => {
      // The client calls this to refresh the list from the remote index. There
      // is no remote index; answering with the current catalogue is both true
      // and what the page needs to re-render.
      const installed = installedPkgNames(context.db, context.userId);
      return {
        extensions: EXTENSIONS.map((extension) =>
          toExtension(extension, installed.has(extension.pkgName)),
        ),
      };
    },

    addExtensionStore: (
      _parent: unknown,
      args: { input: { indexUrl: string } },
      context: GraphQLContext,
    ) => {
      const indexUrl = args.input.indexUrl.trim();
      if (indexUrl === '') throw new GraphQLError('An extension store needs an index URL.');

      // Recorded so the attempt is not lost, and so a future build that learns
      // to read a remote index has the list. Nothing reads it today: the only
      // catalogue served is the built-in one. Refusing outright would break the
      // Sources page, which offers the field unconditionally.
      context.db.run(
        `INSERT INTO extension_store (user_id, name, index_url) VALUES (?, ?, ?)
         ON CONFLICT (user_id, index_url) DO UPDATE SET name = excluded.name`,
        context.userId,
        indexUrl,
        indexUrl,
      );
      return { extensionStore: { name: indexUrl, indexUrl } };
    },
  },

  types: {
    SourceType: {
      // Only resolved when asked for: building a source to read its filter list
      // is cheap, but `Query.sources` returns every installed one and the list
      // view never draws a filter.
      filters: (parent: { id: string }) =>
        parent.id === ANILIST_SOURCE_ID ? [] : filtersFor(parent.id),
    },
  },
};
