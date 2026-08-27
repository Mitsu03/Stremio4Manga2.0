/**
 * Browsing a source: popular, latest, search, and the same three across several
 * sources at once.
 *
 * Every result is written to `manga` before it is returned. That is not a cache
 * — it is what gives a search hit an identity. `MangaType.id` is a local row id,
 * the detail page is `/manga/:id`, the reader's routes are built from it, and
 * `setMangaMeta` needs something to hang the source binding off. A source result
 * with no row would be a card that cannot be opened.
 *
 * The write is an upsert keyed on `(user_id, source_id, url)` — the pair the
 * table enforces — so browsing the same page twice finds the same title rather
 * than doubling it, and a title already in the library keeps everything it has:
 * a listing carries a name and a cover and nothing else, and it must not erase
 * the description, the author or the `initialized` flag that a previous
 * `fetchMangaAndChapters` filled in.
 */
import { GraphQLError } from 'graphql';
import type { Db } from '../../db/open.js';
import type { GraphQLContext } from '../../types.js';
import type { ResolverGroup } from './index.js';
import { getSource, prepareFilters } from '../../sources/registry.js';
import { MAX_IN_FLIGHT } from '../../sources/http.js';
import {
  CloudflareBlockedError,
  NoResultsError,
  type FilterChange,
  type MangaPage,
  type Source,
  type SourceManga,
} from '../../sources/types.js';
import { MANGA_COLUMNS, mapManga, type Manga, type MangaRow } from './library.js';

type BrowseType = 'POPULAR' | 'LATEST' | 'SEARCH';

interface FetchSourceMangaArgs {
  input: {
    source: string;
    type: BrowseType;
    page: number;
    query?: string | null;
    filters?: FilterChange[] | null;
  };
}

interface FetchSourceMangaBulkArgs {
  input: { sources: string[]; type: BrowseType; page: number; query?: string | null };
}

// ------------------------------------------------------------------ upsert --

/**
 * Store one listing entry and hand back the row it became.
 *
 * `COALESCE` everywhere a listing may be silent: a source that does not publish
 * an author on its grid is saying nothing about the author, not saying there
 * isn't one. `initialized` only ever rises for the same reason — a listing can
 * never un-know what a detail fetch learned.
 */
function upsertSourceManga(
  db: Db,
  userId: string,
  sourceId: string,
  item: SourceManga,
): MangaRow | undefined {
  const url = item.url.trim();
  const title = item.title.trim();
  // A result with no url has no identity and could never be opened; a result
  // with no title would render as an empty card.
  if (url === '' || title === '') return undefined;

  db.run(
    `INSERT INTO manga
       (user_id, source_id, url, title, artist, author, description, genre, status,
        thumbnail_url, real_url, initialized, in_library, in_library_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
     ON CONFLICT (user_id, source_id, url) DO UPDATE SET
       title         = excluded.title,
       artist        = COALESCE(excluded.artist, manga.artist),
       author        = COALESCE(excluded.author, manga.author),
       description   = COALESCE(excluded.description, manga.description),
       genre         = COALESCE(excluded.genre, manga.genre),
       status        = CASE WHEN excluded.status = 'UNKNOWN' THEN manga.status ELSE excluded.status END,
       thumbnail_url = COALESCE(excluded.thumbnail_url, manga.thumbnail_url),
       real_url      = COALESCE(excluded.real_url, manga.real_url),
       initialized   = MAX(manga.initialized, excluded.initialized)`,
    userId,
    sourceId,
    url,
    title,
    item.artist ?? null,
    item.author ?? null,
    item.description ?? null,
    item.genre && item.genre.length > 0 ? JSON.stringify(item.genre) : null,
    item.status ?? 'UNKNOWN',
    item.thumbnailUrl ?? null,
    item.realUrl ?? null,
    item.initialized ? 1 : 0,
  );

  return db.get<MangaRow>(
    `SELECT ${MANGA_COLUMNS} FROM manga WHERE user_id = ? AND source_id = ? AND url = ?`,
    userId,
    sourceId,
    url,
  );
}

/** One transaction for the whole page: a half-written grid is nobody's answer. */
function storePage(db: Db, userId: string, sourceId: string, items: SourceManga[]): Manga[] {
  return db.transaction(() => {
    const stored: Manga[] = [];
    for (const item of items) {
      const row = upsertSourceManga(db, userId, sourceId, item);
      if (row) stored.push(mapManga(row));
    }
    return stored;
  });
}

// ------------------------------------------------------------------ browse --

async function browse(
  source: Source,
  type: BrowseType,
  page: number,
  query: string,
  filters: FilterChange[],
): Promise<MangaPage<SourceManga>> {
  switch (type) {
    case 'POPULAR':
      return source.getPopular(page);
    case 'LATEST':
      return source.getLatest(page);
    case 'SEARCH':
      // Filters reach search and nothing else — the same rule Tachiyomi's
      // sources were written to, and what the client already assumes when it
      // sends them only on the search tab. An empty query with filters set is a
      // real question ("everything under this tag"), so it is not refused.
      return source.search(query, page, filters);
  }
}

function requireSource(sourceId: string): Source {
  const source = getSource(sourceId);
  if (!source) throw new GraphQLError(`No source with id ${sourceId}.`);
  return source;
}

/** Page numbers are 1-based everywhere; a 0 would fetch the same page twice. */
const pageNumber = (page: number): number => (Number.isInteger(page) && page > 0 ? page : 1);

/**
 * What to tell the reader about a source that did not answer.
 *
 * The two named errors already say something a person can act on — configure a
 * solver, or try another catalogue — so their own message is used. Anything else
 * is a network or parse failure whose message is still more useful than a
 * generic one, but which may be empty.
 */
function readableError(sourceName: string, error: unknown): string {
  if (error instanceof CloudflareBlockedError) return error.message;
  if (error instanceof NoResultsError) return `${sourceName} has nothing under that title.`;
  const message = error instanceof Error ? error.message : String(error);
  return message === '' ? `${sourceName} did not answer.` : message;
}

/**
 * Run `work` over the sources a few at a time.
 *
 * The shared HTTP client already caps requests in flight and serialises per
 * host, so firing all of them at once would not actually be faster — it would
 * only queue thirty pending fetches, each holding its abort timer, behind four
 * permits. Matching the client's own ceiling keeps the queue as short as the
 * work that can actually run.
 */
async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const runners = Array.from({ length: Math.min(MAX_IN_FLIGHT, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export const group: ResolverGroup = {
  Mutation: {
    fetchSourceManga: async (
      _parent: unknown,
      args: FetchSourceMangaArgs,
      context: GraphQLContext,
    ) => {
      const sourceId = String(args.input.source);
      const source = requireSource(sourceId);
      const filters =
        args.input.type === 'SEARCH'
          ? prepareFilters(sourceId, args.input.filters ?? undefined)
          : [];

      let result: MangaPage<SourceManga>;
      try {
        result = await browse(
          source,
          args.input.type,
          pageNumber(args.input.page),
          args.input.query ?? '',
          filters,
        );
      } catch (error) {
        // "Answered, but with nothing" is an empty grid, not a failure: the
        // client already draws "no results" for it, and an error banner over a
        // search that simply found nothing reads as the server being broken.
        if (error instanceof NoResultsError) return { hasNextPage: false, mangas: [] };
        throw error;
      }

      return {
        hasNextPage: result.hasNextPage,
        mangas: storePage(context.db, context.userId, sourceId, result.items),
      };
    },

    /**
     * The same question put to several catalogues at once.
     *
     * A source that fails must not fail the others: the client fans out over
     * every source a person reads from, and one site behind a challenge would
     * otherwise blank the whole page. The error is therefore per source, and the
     * mutation itself always succeeds.
     */
    fetchSourceMangaBulk: async (
      _parent: unknown,
      args: FetchSourceMangaBulkArgs,
      context: GraphQLContext,
    ) => {
      const ids = [...new Set(args.input.sources.map(String))];
      const page = pageNumber(args.input.page);
      const query = args.input.query ?? '';

      const results = await inBatches(ids, async (sourceId) => {
        const source = getSource(sourceId);
        if (!source) {
          return {
            source: sourceId,
            error: `No source with id ${sourceId}.`,
            mangas: [] as Manga[],
          };
        }
        try {
          const answer = await browse(source, args.input.type, page, query, []);
          return {
            source: sourceId,
            error: null,
            mangas: storePage(context.db, context.userId, sourceId, answer.items),
          };
        } catch (error) {
          context.log.warn(`bulk search on ${source.name} failed: ${String(error)}`);
          return { source: sourceId, error: readableError(source.name, error), mangas: [] as Manga[] };
        }
      });

      return { results };
    },
  },
};
