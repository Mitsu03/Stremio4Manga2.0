/**
 * The library: what a manga row looks like on the wire, how the client asks for
 * a set of them, and the three writes that change one.
 *
 * This group owns `MangaType`, but it is not the only place that produces a
 * manga-shaped object: `category.ts` returns them from `CategoryType.mangas`,
 * `track.ts` returns them from `importAnilistLibrary`, and `search.ts` returns
 * them from both browse mutations. Each has its own query and its own row
 * shape, so the fields that must never be got wrong are declared here as *field
 * resolvers* instead of being copied into each mapper. A field resolver wins
 * over whatever property the parent happens to carry, which is what makes one
 * definition hold for every producer.
 *
 * `thumbnailUrl` is why the rule exists. The cover has to be fetched with the
 * session cookie attached, so it must be a same-origin path this server serves;
 * the remote URL stored on the row would both leak the reader's library to the
 * source's CDN logs and, on the sources that require a Referer, simply fail to
 * load. `genre`, `status` and the booleans are here for the cheaper version of
 * the same reason: one spelling of "0 is false", applied everywhere.
 */
import { GraphQLError } from 'graphql';
import type { Db, Param } from '../../db/open.js';
import type { GraphQLContext } from '../../types.js';
import type { ResolverGroup } from './index.js';
import { ANILIST_ICON, ANILIST_SOURCE_ID } from '../../tracker/anilist.js';
import { definitionById, getSource } from '../../sources/registry.js';
import type { Source, SourceManga } from '../../sources/types.js';
import { chaptersForManga, fetchChaptersFor, listChapters, type Chapter } from './chapter.js';

// ------------------------------------------------------------------- rows --

export interface MangaRow {
  id: number;
  user_id: string;
  source_id: string;
  url: string;
  title: string;
  artist: string | null;
  author: string | null;
  description: string | null;
  genre: string | null;
  status: string;
  thumbnail_url: string | null;
  real_url: string | null;
  initialized: number;
  in_library: number;
  in_library_at: number;
  last_fetched_at: number;
  chapters_last_fetched_at: number;
}

/** Every column of `manga`, so a mapped row is never missing one a resolver reads. */
export const MANGA_COLUMNS =
  'id, user_id, source_id, url, title, artist, author, description, genre, status, ' +
  'thumbnail_url, real_url, initialized, in_library, in_library_at, last_fetched_at, ' +
  'chapters_last_fetched_at';

const MANGA_STATUSES = new Set([
  'UNKNOWN',
  'ONGOING',
  'COMPLETED',
  'LICENSED',
  'PUBLISHING_FINISHED',
  'CANCELLED',
  'ON_HIATUS',
]);

/**
 * A manga as `MangaType` sees it.
 *
 * The raw columns are kept alongside the camelCase fields on purpose: the field
 * resolvers below, and the ones `category.ts`, `meta.ts` and `track.ts` add, are
 * handed this same object, so whichever spelling one of them reads, the parent
 * has it.
 */
export interface Manga extends Omit<MangaRow, 'genre' | 'initialized'> {
  sourceId: string;
  thumbnailUrl: string | null;
  genre: string[];
  realUrl: string | null;
  inLibrary: boolean;
  inLibraryAt: string;
  initialized: boolean;
}

export function parseGenre(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((tag): tag is string => typeof tag === 'string');
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    // A malformed blob is not worth failing a library query over.
    return [];
  }
}

/** The one row → `MangaType` translation. Exported so no other group invents its own. */
export function mapManga(row: MangaRow): Manga {
  return {
    ...row,
    id: row.id,
    sourceId: String(row.source_id),
    url: row.url,
    title: row.title,
    // Overwritten by the field resolver below; kept here so a consumer that
    // reads the object directly still sees a same-origin path.
    thumbnailUrl: row.thumbnail_url ? thumbnailPath(row.id) : null,
    artist: row.artist,
    author: row.author,
    description: row.description,
    genre: parseGenre(row.genre),
    status: MANGA_STATUSES.has(row.status) ? row.status : 'UNKNOWN',
    realUrl: row.real_url,
    inLibrary: row.in_library === 1,
    inLibraryAt: String(row.in_library_at),
    initialized: row.initialized === 1,
  };
}

/** The cover route `reader/api.ts` serves and `tracker/records.ts` already assumes. */
export function thumbnailPath(mangaId: number): string {
  return `/api/v1/manga/${mangaId}/thumbnail`;
}

// ---------------------------------------------------------------- lookups --

export function mangaRowById(db: Db, userId: string, id: number): MangaRow | undefined {
  return db.get<MangaRow>(
    `SELECT ${MANGA_COLUMNS} FROM manga WHERE id = ? AND user_id = ?`,
    id,
    userId,
  );
}

/** One manga, or null. Another account's row is not found rather than refused. */
export function mangaById(db: Db, userId: string, id: number): Manga | null {
  const row = mangaRowById(db, userId, id);
  return row ? mapManga(row) : null;
}

export function requireMangaRow(db: Db, userId: string, id: number): MangaRow {
  const row = mangaRowById(db, userId, id);
  if (!row) throw new GraphQLError(`No manga with id ${id}.`);
  return row;
}

/**
 * The source a row was read from.
 *
 * AniList (id '1') is not a source: the library can hold shells imported from an
 * account there, and asking that pseudo-source for anything is a bug rather than
 * a slow request. Callers that need to read from the site check for it first.
 */
export function requireSource(sourceId: string, title: string): Source {
  if (sourceId === ANILIST_SOURCE_ID) {
    throw new GraphQLError(
      `"${title}" came from AniList, which holds no chapters. Bind it to a source first.`,
    );
  }
  const source = getSource(sourceId);
  if (!source) {
    throw new GraphQLError(
      `"${title}" was added from a source (id ${sourceId}) this server no longer has.`,
    );
  }
  return source;
}

export const isAnilistShell = (row: Pick<MangaRow, 'source_id'>): boolean =>
  row.source_id === ANILIST_SOURCE_ID;

// ------------------------------------------------------------ source view --

/**
 * `SourceType` for one id.
 *
 * A trimmed copy of what `extension.ts` builds for `Query.sources`; it is not
 * imported because that module owns the extension catalogue and this one only
 * needs the eight scalar fields. `SourceType.filters` is a field resolver over
 * there, so it is deliberately absent here and still answers.
 */
function sourceView(sourceId: string): Record<string, unknown> | null {
  if (sourceId === ANILIST_SOURCE_ID) {
    return {
      id: ANILIST_SOURCE_ID,
      name: 'AniList',
      lang: 'all',
      iconUrl: ANILIST_ICON,
      supportsLatest: false,
      contentWarning: 'SAFE',
      isNsfw: false,
      displayName: 'AniList',
    };
  }
  const definition = definitionById(sourceId);
  // Not an error: the row may predate a source being dropped from this build,
  // and the title still has to render.
  if (!definition) return null;
  const lang = definition.lang;
  return {
    id: definition.id,
    name: definition.name,
    lang,
    iconUrl: null,
    supportsLatest: true,
    contentWarning: definition.contentWarning,
    isNsfw: definition.contentWarning === 'NSFW',
    displayName: lang === 'en' || lang === 'all' ? definition.name : `${definition.name} (${lang.toUpperCase()})`,
  };
}

// ------------------------------------------------------------- query args --

interface MangaCondition {
  id?: number | null;
  inLibrary?: boolean | null;
  sourceId?: string | null;
}

export interface IntFilter {
  equalTo?: number | null;
  notEqualTo?: number | null;
  in?: number[] | null;
  notIn?: number[] | null;
  greaterThan?: number | null;
  lessThan?: number | null;
}

export interface LongFilter {
  equalTo?: string | null;
  notEqualTo?: string | null;
  in?: string[] | null;
  greaterThan?: string | null;
  lessThan?: string | null;
}

export interface BooleanFilter {
  equalTo?: boolean | null;
  notEqualTo?: boolean | null;
}

interface MangaFilter {
  id?: IntFilter | null;
  inLibrary?: BooleanFilter | null;
  sourceId?: LongFilter | null;
}

type MangaOrderBy = 'ID' | 'TITLE' | 'IN_LIBRARY_AT';

interface MangaOrder {
  by: MangaOrderBy;
  byType?: 'ASC' | 'DESC' | null;
}

interface MangasArgs {
  condition?: MangaCondition | null;
  filter?: MangaFilter | null;
  order?: MangaOrder[] | MangaOrder | null;
  first?: number | null;
}

const MANGA_ORDER_COLUMN: Record<MangaOrderBy, string> = {
  ID: 'id',
  TITLE: 'title COLLATE NOCASE',
  IN_LIBRARY_AT: 'in_library_at',
};

export const placeholders = (count: number): string =>
  Array.from({ length: count }, () => '?').join(', ');

/** A list argument that arrived as a single object — GraphQL coerces one into a list. */
export function asList<T>(value: T[] | T | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export const boolValue = (value: boolean): number => (value ? 1 : 0);

/** `IntFilterInput` over one integer column. */
export function intFilterClauses(
  column: string,
  filter: IntFilter | null | undefined,
  clauses: string[],
  params: Param[],
): void {
  if (!filter) return;
  if (filter.equalTo != null) {
    clauses.push(`${column} = ?`);
    params.push(filter.equalTo);
  }
  if (filter.notEqualTo != null) {
    clauses.push(`${column} <> ?`);
    params.push(filter.notEqualTo);
  }
  if (filter.in) {
    // An empty `in` matches nothing, which is what the client meant by sending
    // an empty list; `IN ()` is a syntax error, so it is spelled out.
    if (filter.in.length === 0) clauses.push('0 = 1');
    else {
      clauses.push(`${column} IN (${placeholders(filter.in.length)})`);
      params.push(...filter.in);
    }
  }
  if (filter.notIn && filter.notIn.length > 0) {
    clauses.push(`${column} NOT IN (${placeholders(filter.notIn.length)})`);
    params.push(...filter.notIn);
  }
  if (filter.greaterThan != null) {
    clauses.push(`${column} > ?`);
    params.push(filter.greaterThan);
  }
  if (filter.lessThan != null) {
    clauses.push(`${column} < ?`);
    params.push(filter.lessThan);
  }
}

export function booleanFilterClauses(
  column: string,
  filter: BooleanFilter | null | undefined,
  clauses: string[],
  params: Param[],
): void {
  if (!filter) return;
  if (filter.equalTo != null) {
    clauses.push(`${column} = ?`);
    params.push(boolValue(filter.equalTo));
  }
  if (filter.notEqualTo != null) {
    clauses.push(`${column} <> ?`);
    params.push(boolValue(filter.notEqualTo));
  }
}

/** `LongFilterInput` over `source_id`, which is TEXT: the values stay strings. */
function longTextFilterClauses(
  column: string,
  filter: LongFilter | null | undefined,
  clauses: string[],
  params: Param[],
): void {
  if (!filter) return;
  if (filter.equalTo != null) {
    clauses.push(`${column} = ?`);
    params.push(String(filter.equalTo));
  }
  if (filter.notEqualTo != null) {
    clauses.push(`${column} <> ?`);
    params.push(String(filter.notEqualTo));
  }
  if (filter.in) {
    if (filter.in.length === 0) clauses.push('0 = 1');
    else {
      clauses.push(`${column} IN (${placeholders(filter.in.length)})`);
      params.push(...filter.in.map(String));
    }
  }
  if (filter.greaterThan != null) {
    clauses.push(`CAST(${column} AS INTEGER) > ?`);
    params.push(Number(filter.greaterThan));
  }
  if (filter.lessThan != null) {
    clauses.push(`CAST(${column} AS INTEGER) < ?`);
    params.push(Number(filter.lessThan));
  }
}

/**
 * `LongFilterInput` over an INTEGER column — the epoch-millisecond stamps.
 *
 * The value arrives as a decimal string, and SQLite sorts every integer before
 * every string, so `last_read_at > '1700000000000'` is *always* false rather
 * than wrong-sometimes. Converting to a number here is what makes the
 * continue-reading shelf return anything at all.
 */
export function longIntFilterClauses(
  column: string,
  filter: LongFilter | null | undefined,
  clauses: string[],
  params: Param[],
): void {
  if (!filter) return;
  if (filter.equalTo != null) {
    clauses.push(`${column} = ?`);
    params.push(Number(filter.equalTo));
  }
  if (filter.notEqualTo != null) {
    clauses.push(`${column} <> ?`);
    params.push(Number(filter.notEqualTo));
  }
  if (filter.in) {
    if (filter.in.length === 0) clauses.push('0 = 1');
    else {
      clauses.push(`${column} IN (${placeholders(filter.in.length)})`);
      params.push(...filter.in.map(Number));
    }
  }
  if (filter.greaterThan != null) {
    clauses.push(`${column} > ?`);
    params.push(Number(filter.greaterThan));
  }
  if (filter.lessThan != null) {
    clauses.push(`${column} < ?`);
    params.push(Number(filter.lessThan));
  }
}

function orderClause(order: MangaOrder[] | MangaOrder | null | undefined): string {
  const rules = asList(order).filter((rule) => MANGA_ORDER_COLUMN[rule.by] !== undefined);
  if (rules.length === 0) {
    // What the library grid wants when it says nothing, and the same order
    // `category.ts` already lists a shelf in.
    return 'ORDER BY title COLLATE NOCASE, id';
  }
  const parts = rules.map(
    (rule) => `${MANGA_ORDER_COLUMN[rule.by]} ${rule.byType === 'DESC' ? 'DESC' : 'ASC'}`,
  );
  // `id` last so a page of equal titles cannot come back in a different order
  // on the next request.
  parts.push('id ASC');
  return `ORDER BY ${parts.join(', ')}`;
}

function listMangas(db: Db, userId: string, args: MangasArgs): { nodes: Manga[]; totalCount: number } {
  const clauses = ['user_id = ?'];
  const params: Param[] = [userId];

  const condition = args.condition;
  if (condition?.id != null) {
    clauses.push('id = ?');
    params.push(condition.id);
  }
  if (condition?.inLibrary != null) {
    clauses.push('in_library = ?');
    params.push(boolValue(condition.inLibrary));
  }
  if (condition?.sourceId != null) {
    clauses.push('source_id = ?');
    params.push(String(condition.sourceId));
  }

  // `filter: { id: { in: $ids } }` is how the UI asks for a batch of titles it
  // already knows the ids of, which is most of what it asks for.
  intFilterClauses('id', args.filter?.id, clauses, params);
  booleanFilterClauses('in_library', args.filter?.inLibrary, clauses, params);
  longTextFilterClauses('source_id', args.filter?.sourceId, clauses, params);

  const where = `WHERE ${clauses.join(' AND ')}`;
  const limit = args.first != null && args.first >= 0 ? `LIMIT ${Math.floor(args.first)}` : '';

  const rows = db.all<MangaRow>(
    `SELECT ${MANGA_COLUMNS} FROM manga ${where} ${orderClause(args.order)} ${limit}`,
    ...params,
  );

  // Only worth a second query when the page was cut short; otherwise the rows
  // in hand are the whole answer.
  const totalCount = limit
    ? (db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM manga ${where}`, ...params)?.n ?? rows.length)
    : rows.length;

  return { nodes: rows.map(mapManga), totalCount };
}

// ------------------------------------------------------------ field parents --

type MangaParent = Record<string, unknown>;

function idOf(parent: MangaParent): number | null {
  const id = parent.id;
  return typeof id === 'number' ? id : null;
}

function sourceIdOf(parent: MangaParent): string {
  const value = parent.sourceId ?? parent.source_id;
  return value == null ? '' : String(value);
}

function flagOf(parent: MangaParent, camel: string, snake: string): boolean {
  const value = camel in parent ? parent[camel] : parent[snake];
  return value === true || value === 1;
}

/**
 * Whether this row has a cover at all, without a query when the parent already
 * carries the column — which every mapper in this server makes sure it does.
 */
function hasCover(parent: MangaParent, id: number, context: GraphQLContext): boolean {
  const carried = 'thumbnail_url' in parent ? parent.thumbnail_url : parent.thumbnailUrl;
  if (carried !== undefined) return typeof carried === 'string' && carried !== '';
  const row = context.db.get<{ thumbnail_url: string | null }>(
    'SELECT thumbnail_url FROM manga WHERE id = ? AND user_id = ?',
    id,
    context.userId,
  );
  return typeof row?.thumbnail_url === 'string' && row.thumbnail_url !== '';
}

// -------------------------------------------------------------- mutations --

interface UpdateMangaArgs {
  input: { id: number; patch: { inLibrary?: boolean | null } };
}

interface UpdateMangasArgs {
  input: { ids: number[]; patch: { inLibrary?: boolean | null } };
}

interface FetchMangaAndChaptersArgs {
  input: { id: number; fetchManga?: boolean | null; fetchChapters?: boolean | null };
}

/**
 * Apply one library patch.
 *
 * `in_library_at` is stamped when a title *enters* the library and left alone
 * otherwise: re-asserting membership (a bulk add over titles already there) must
 * not reshuffle the "recently added" shelf, and removing a title must not lose
 * the date it was added, so that putting it back is not indistinguishable from
 * adding it for the first time. `tracker/records.ts` guards the same column the
 * same way on import.
 */
function applyLibraryPatch(
  db: Db,
  userId: string,
  id: number,
  inLibrary: boolean | null | undefined,
): void {
  if (inLibrary == null) return;
  if (inLibrary) {
    db.run(
      `UPDATE manga
          SET in_library = 1,
              in_library_at = CASE WHEN in_library = 1 AND in_library_at > 0
                                   THEN in_library_at ELSE ? END
        WHERE id = ? AND user_id = ?`,
      Date.now(),
      id,
      userId,
    );
    return;
  }
  db.run('UPDATE manga SET in_library = 0 WHERE id = ? AND user_id = ?', id, userId);
}

/** Everything a listing could not carry, written back onto the row. */
function applyDetails(db: Db, userId: string, row: MangaRow, details: SourceManga): void {
  const genre = details.genre && details.genre.length > 0 ? JSON.stringify(details.genre) : row.genre;
  const status = details.status && MANGA_STATUSES.has(details.status) ? details.status : row.status;
  db.run(
    `UPDATE manga
        SET title = ?, author = ?, artist = ?, description = ?, genre = ?, status = ?,
            real_url = ?, thumbnail_url = ?, initialized = 1, last_fetched_at = ?
      WHERE id = ? AND user_id = ?`,
    // A source that omits a field is saying nothing about it, not saying it is
    // empty; the row keeps what it had.
    details.title?.trim() ? details.title.trim() : row.title,
    details.author ?? row.author,
    details.artist ?? row.artist,
    details.description ?? row.description,
    genre,
    status,
    details.realUrl ?? row.real_url,
    details.thumbnailUrl ?? row.thumbnail_url,
    Date.now(),
    row.id,
    userId,
  );
}

export const group: ResolverGroup = {
  Query: {
    mangas: (_parent: unknown, args: MangasArgs, context: GraphQLContext) =>
      listMangas(context.db, context.userId, args),

    manga: (_parent: unknown, args: { id: number }, context: GraphQLContext) =>
      mangaById(context.db, context.userId, args.id),
  },

  Mutation: {
    updateManga: (_parent: unknown, args: UpdateMangaArgs, context: GraphQLContext) =>
      context.db.transaction(() => {
        const row = requireMangaRow(context.db, context.userId, args.input.id);
        applyLibraryPatch(context.db, context.userId, row.id, args.input.patch.inLibrary);
        return { manga: mapManga(requireMangaRow(context.db, context.userId, row.id)) };
      }),

    updateMangas: (_parent: unknown, args: UpdateMangasArgs, context: GraphQLContext) =>
      context.db.transaction(() => {
        const ids = [...new Set(args.input.ids)];
        // Every id is checked before anything is written: a partly-applied bulk
        // edit is worse than a refused one, because nothing says which half ran.
        const rows = ids.map((id) => requireMangaRow(context.db, context.userId, id));
        for (const row of rows) {
          applyLibraryPatch(context.db, context.userId, row.id, args.input.patch.inLibrary);
        }
        return {
          mangas: rows.map((row) => mapManga(requireMangaRow(context.db, context.userId, row.id))),
        };
      }),

    /**
     * The only call that asks a source about the manga itself.
     *
     * Everything else in this server learns about a title from a listing, which
     * carries a url, a name and a cover and nothing else — which is why a
     * database full of manga can have a null `realUrl` and a null description
     * until the detail page opens one.
     */
    fetchMangaAndChapters: async (
      _parent: unknown,
      args: FetchMangaAndChaptersArgs,
      context: GraphQLContext,
    ): Promise<{ manga: Manga; chapters: Chapter[] }> => {
      const row = requireMangaRow(context.db, context.userId, args.input.id);
      const wantManga = args.input.fetchManga !== false;
      const wantChapters = args.input.fetchChapters !== false;

      // An AniList shell has no site behind it. Answering with the row as it
      // stands is both true and what the detail page needs to keep rendering.
      if (isAnilistShell(row)) {
        return { manga: mapManga(row), chapters: [] };
      }

      if (wantManga) {
        const source = requireSource(row.source_id, row.title);
        const details = await source.getMangaDetails({ url: row.url });
        applyDetails(context.db, context.userId, row, details);
      }

      const chapters = wantChapters
        ? await fetchChaptersFor(context, row.id)
        : chaptersForManga(context.db, context.userId, row.id);

      return { manga: mapManga(requireMangaRow(context.db, context.userId, row.id)), chapters };
    },
  },

  types: {
    MangaType: {
      /**
       * Same-origin and server-relative, always.
       *
       * The cover is fetched by an `<img>`, so the only credential it can carry
       * is the session cookie, and a cookie only travels to this origin. Handing
       * the client `manga.thumbnail_url` would therefore be wrong twice over: it
       * would tell the source's CDN what this reader has in their library, and
       * on every source that requires a Referer it would not load at all.
       *
       * This is a field resolver rather than a line in `mapManga` because
       * `category.ts` and `track.ts` build their own manga objects from their
       * own queries. A resolver here overrides whatever they put on the parent,
       * so the remote URL cannot escape through them.
       */
      thumbnailUrl: (
        parent: MangaParent,
        _args: unknown,
        context: GraphQLContext,
      ): string | null => {
        const id = idOf(parent);
        if (id === null) return null;
        return hasCover(parent, id, context) ? thumbnailPath(id) : null;
      },

      source: (parent: MangaParent) => sourceView(sourceIdOf(parent)),

      sourceId: (parent: MangaParent): string => sourceIdOf(parent),

      genre: (parent: MangaParent): string[] => parseGenre(parent.genre),

      status: (parent: MangaParent): string => {
        const status = typeof parent.status === 'string' ? parent.status : 'UNKNOWN';
        return MANGA_STATUSES.has(status) ? status : 'UNKNOWN';
      },

      inLibrary: (parent: MangaParent): boolean => flagOf(parent, 'inLibrary', 'in_library'),

      initialized: (parent: MangaParent): boolean => flagOf(parent, 'initialized', 'initialized'),

      inLibraryAt: (parent: MangaParent): string => {
        const value = parent.inLibraryAt ?? parent.in_library_at;
        return String(value ?? 0);
      },

      /**
       * A title's chapters, scoped to it.
       *
       * The AniList pseudo-source has none by construction, and there is nothing
       * to ask it for; the query simply finds no rows, which is the right answer
       * rather than a special case.
       */
      chapters: (
        parent: MangaParent,
        args: Parameters<typeof listChapters>[2],
        context: GraphQLContext,
      ) => {
        const id = idOf(parent);
        if (id === null) return { nodes: [], totalCount: 0 };
        return listChapters(context.db, context.userId, args, id);
      },
    },
  },
};
