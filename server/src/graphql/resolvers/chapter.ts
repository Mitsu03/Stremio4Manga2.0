/**
 * Chapters: the list a source publishes, the state a reader accumulates on top
 * of it, and the three calls that move either.
 *
 * Two rules run through the whole file and neither is negotiable.
 *
 * **A re-fetch must not lose read state.** `fetchChapters` is called every time
 * a title is opened, by the library's update sweep, and by the availability
 * check on every browse result. It is an upsert keyed on `(manga_id, url)` — the
 * pair the table already enforces as UNIQUE — and it writes only the columns the
 * source is authoritative for. `is_read`, `last_page_read`, `last_read_at`,
 * `is_bookmarked` and `is_downloaded` are never in an UPDATE here.
 *
 * **`updateChapters` never stamps `last_read_at` and never reports progress.**
 * See the mutation itself; it is the single most consequential line in this
 * group.
 */
import { GraphQLError } from 'graphql';
import type { Db, Param } from '../../db/open.js';
import type { GraphQLContext } from '../../types.js';
import type { ResolverGroup } from './index.js';
import { dedupeChapters } from '../../sources/util.js';
import { ensureChapterPages } from '../../reader/pages.js';
import {
  asList,
  boolValue,
  booleanFilterClauses,
  intFilterClauses,
  isAnilistShell,
  longIntFilterClauses,
  mapManga,
  mangaRowById,
  placeholders,
  requireMangaRow,
  requireSource,
  type BooleanFilter,
  type IntFilter,
  type LongFilter,
  type Manga,
} from './library.js';

// ------------------------------------------------------------------- rows --

export interface ChapterRow {
  id: number;
  user_id: string;
  manga_id: number;
  url: string;
  name: string;
  scanlator: string | null;
  chapter_number: number;
  source_order: number;
  date_upload: number;
  real_url: string | null;
  is_read: number;
  is_bookmarked: number;
  last_page_read: number;
  last_read_at: number;
  page_count: number;
  is_downloaded: number;
  fetched_at: number;
}

export const CHAPTER_COLUMNS =
  'id, user_id, manga_id, url, name, scanlator, chapter_number, source_order, date_upload, ' +
  'real_url, is_read, is_bookmarked, last_page_read, last_read_at, page_count, is_downloaded, ' +
  'fetched_at';

/**
 * A chapter as `ChapterType` sees it.
 *
 * As with `Manga`, the raw columns stay on the object: the field resolvers below
 * and anything else handed a chapter (the download group's queue entries, for
 * one) may read either spelling.
 */
export interface Chapter extends ChapterRow {
  mangaId: number;
  chapterNumber: number;
  sourceOrder: number;
  uploadDate: string;
  realUrl: string | null;
  isRead: boolean;
  isBookmarked: boolean;
  isDownloaded: boolean;
  lastPageRead: number;
  lastReadAt: string;
  pageCount: number;
  fetchedAt: string;
}

/** The one row → `ChapterType` translation. */
export function mapChapter(row: ChapterRow): Chapter {
  return {
    ...row,
    id: row.id,
    mangaId: row.manga_id,
    url: row.url,
    name: row.name,
    scanlator: row.scanlator,
    chapterNumber: row.chapter_number,
    sourceOrder: row.source_order,
    // Epoch milliseconds as a decimal string: the LongString scalar, and what
    // the client parses back with Number().
    uploadDate: String(row.date_upload),
    realUrl: row.real_url,
    isRead: row.is_read === 1,
    isBookmarked: row.is_bookmarked === 1,
    isDownloaded: row.is_downloaded === 1,
    lastPageRead: row.last_page_read,
    lastReadAt: String(row.last_read_at),
    pageCount: row.page_count,
    fetchedAt: String(row.fetched_at),
  };
}

// ---------------------------------------------------------------- lookups --

/**
 * One chapter, scoped to its owner.
 *
 * `chapter.user_id` is checked rather than the manga's, because both carry it
 * and the chapter's is the one already in hand — but they can never disagree:
 * a chapter is only ever written alongside a manga owned by the same account.
 */
export function chapterRowById(db: Db, userId: string, id: number): ChapterRow | undefined {
  return db.get<ChapterRow>(
    `SELECT ${CHAPTER_COLUMNS} FROM chapter WHERE id = ? AND user_id = ?`,
    id,
    userId,
  );
}

export function requireChapterRow(db: Db, userId: string, id: number): ChapterRow {
  const row = chapterRowById(db, userId, id);
  if (!row) throw new GraphQLError(`No chapter with id ${id}.`);
  return row;
}

/** A manga's chapters in the order the source published them. */
export function chaptersForManga(db: Db, userId: string, mangaId: number): Chapter[] {
  return db
    .all<ChapterRow>(
      `SELECT ${CHAPTER_COLUMNS} FROM chapter
        WHERE user_id = ? AND manga_id = ?
        ORDER BY source_order, id`,
      userId,
      mangaId,
    )
    .map(mapChapter);
}

// ------------------------------------------------------------- query args --

interface ChapterCondition {
  id?: number | null;
  mangaId?: number | null;
  isRead?: boolean | null;
  isDownloaded?: boolean | null;
  isBookmarked?: boolean | null;
}

interface ChapterFilter {
  id?: IntFilter | null;
  mangaId?: IntFilter | null;
  isRead?: BooleanFilter | null;
  isDownloaded?: BooleanFilter | null;
  isBookmarked?: BooleanFilter | null;
  lastReadAt?: LongFilter | null;
}

type ChapterOrderBy =
  | 'ID'
  | 'SOURCE_ORDER'
  | 'CHAPTER_NUMBER'
  | 'UPLOAD_DATE'
  | 'LAST_READ_AT'
  | 'FETCHED_AT';

interface ChapterOrder {
  by: ChapterOrderBy;
  byType?: 'ASC' | 'DESC' | null;
}

export interface ChaptersArgs {
  condition?: ChapterCondition | null;
  filter?: ChapterFilter | null;
  order?: ChapterOrder[] | ChapterOrder | null;
  first?: number | null;
}

const CHAPTER_ORDER_COLUMN: Record<ChapterOrderBy, string> = {
  ID: 'id',
  SOURCE_ORDER: 'source_order',
  CHAPTER_NUMBER: 'chapter_number',
  UPLOAD_DATE: 'date_upload',
  LAST_READ_AT: 'last_read_at',
  FETCHED_AT: 'fetched_at',
};

function orderClause(order: ChapterOrder[] | ChapterOrder | null | undefined): string {
  // `order: { by: SOURCE_ORDER }` and `order: [{ by: LAST_READ_AT, byType: DESC }]`
  // are both valid against this field: GraphQL coerces a single object into a
  // list, and the client sends both forms.
  const rules = asList(order).filter((rule) => CHAPTER_ORDER_COLUMN[rule.by] !== undefined);
  if (rules.length === 0) {
    // The chapter list of one title, and the downloaded-chapters list grouped by
    // the title it belongs to — the two shapes asked for without an order.
    return 'ORDER BY manga_id ASC, source_order ASC';
  }
  const parts = rules.map(
    (rule) => `${CHAPTER_ORDER_COLUMN[rule.by]} ${rule.byType === 'DESC' ? 'DESC' : 'ASC'}`,
  );
  parts.push('id ASC');
  return `ORDER BY ${parts.join(', ')}`;
}

/**
 * The one chapter query, behind both `Query.chapters` and `MangaType.chapters`.
 *
 * `mangaId` is the parent's own id when this runs as a field resolver: it is
 * ANDed with whatever the arguments say rather than replacing it, so a title can
 * never be asked for another title's chapters.
 */
export function listChapters(
  db: Db,
  userId: string,
  args: ChaptersArgs | null | undefined,
  mangaId?: number,
): { nodes: Chapter[]; totalCount: number } {
  const clauses = ['user_id = ?'];
  const params: Param[] = [userId];

  if (mangaId !== undefined) {
    clauses.push('manga_id = ?');
    params.push(mangaId);
  }

  const condition = args?.condition;
  if (condition?.id != null) {
    clauses.push('id = ?');
    params.push(condition.id);
  }
  if (condition?.mangaId != null) {
    clauses.push('manga_id = ?');
    params.push(condition.mangaId);
  }
  for (const [key, column] of [
    ['isRead', 'is_read'],
    ['isDownloaded', 'is_downloaded'],
    ['isBookmarked', 'is_bookmarked'],
  ] as const) {
    const value = condition?.[key];
    if (value != null) {
      clauses.push(`${column} = ?`);
      params.push(boolValue(value));
    }
  }

  intFilterClauses('id', args?.filter?.id, clauses, params);
  intFilterClauses('manga_id', args?.filter?.mangaId, clauses, params);
  booleanFilterClauses('is_read', args?.filter?.isRead, clauses, params);
  booleanFilterClauses('is_downloaded', args?.filter?.isDownloaded, clauses, params);
  booleanFilterClauses('is_bookmarked', args?.filter?.isBookmarked, clauses, params);
  longIntFilterClauses('last_read_at', args?.filter?.lastReadAt, clauses, params);

  const where = `WHERE ${clauses.join(' AND ')}`;
  const first = args?.first;
  const limit = first != null && first >= 0 ? `LIMIT ${Math.floor(first)}` : '';

  const rows = db.all<ChapterRow>(
    `SELECT ${CHAPTER_COLUMNS} FROM chapter ${where} ${orderClause(args?.order)} ${limit}`,
    ...params,
  );
  const totalCount = limit
    ? (db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM chapter ${where}`, ...params)?.n ??
      rows.length)
    : rows.length;

  return { nodes: rows.map(mapChapter), totalCount };
}

// ------------------------------------------------------------ chapter sync --

/**
 * Ask the source for the chapter list and reconcile it with what is stored.
 *
 * The reconciliation is the whole point, and it has three parts.
 *
 * *Identity is the url.* `UNIQUE (manga_id, url)` is what lets a chapter keep
 * its read state across a re-fetch even when the source renames it, renumbers it
 * or moves it in the list.
 *
 * *`source_order` is rewritten every time.* It is a position, not an identity:
 * the reader's own route carries it (`/manga/:id/chapter/:sourceOrder`), so it
 * has to mean "where this chapter sits in the list the source just returned".
 *
 * *A chapter that vanished is moved out of the way, not deleted.* Sources drop
 * chapters temporarily — a re-upload, a bad scrape, a DMCA that is reversed —
 * and deleting the row would throw away read state and a downloaded file over a
 * hiccup. Leaving its old `source_order` would be worse: two chapters would
 * answer to one reader URL. So the survivors take 1..n and the missing ones are
 * renumbered after them, keeping their relative order and their identity.
 */
export async function fetchChaptersFor(
  context: GraphQLContext,
  mangaId: number,
): Promise<Chapter[]> {
  const { db, userId } = context;
  const manga = requireMangaRow(db, userId, mangaId);

  // Never ask the AniList pseudo-source: an imported shell is a title, not a
  // place chapters can be read from. It is bound to a real source separately.
  if (isAnilistShell(manga)) return [];

  const source = requireSource(manga.source_id, manga.title);
  const fetched = dedupeChapters(await source.getChapterList({ url: manga.url }));
  const now = Date.now();

  return db.transaction(() => {
    const existing = db.all<ChapterRow>(
      `SELECT ${CHAPTER_COLUMNS} FROM chapter WHERE user_id = ? AND manga_id = ? ORDER BY source_order, id`,
      userId,
      mangaId,
    );
    const byUrl = new Map(existing.map((row) => [row.url, row]));
    const seen = new Set<string>();

    fetched.forEach((chapter, index) => {
      const sourceOrder = index + 1;
      seen.add(chapter.url);
      const prior = byUrl.get(chapter.url);

      if (prior) {
        // Only what the source is authoritative for. Read state, bookmarks and
        // the downloaded flag are this reader's, not the site's.
        db.run(
          `UPDATE chapter
              SET name = ?, scanlator = ?, chapter_number = ?, source_order = ?,
                  date_upload = ?, real_url = ?, fetched_at = ?
            WHERE id = ? AND user_id = ?`,
          chapter.name,
          chapter.scanlator ?? null,
          chapter.chapterNumber,
          sourceOrder,
          chapter.dateUpload,
          chapter.realUrl ?? null,
          now,
          prior.id,
          userId,
        );
        return;
      }

      db.run(
        `INSERT INTO chapter
           (user_id, manga_id, url, name, scanlator, chapter_number, source_order,
            date_upload, real_url, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        userId,
        mangaId,
        chapter.url,
        chapter.name,
        chapter.scanlator ?? null,
        chapter.chapterNumber,
        sourceOrder,
        chapter.dateUpload,
        chapter.realUrl ?? null,
        now,
      );
    });

    let tail = fetched.length;
    for (const row of existing) {
      if (seen.has(row.url)) continue;
      tail += 1;
      if (row.source_order === tail) continue;
      db.run(
        'UPDATE chapter SET source_order = ? WHERE id = ? AND user_id = ?',
        tail,
        row.id,
        userId,
      );
    }

    db.run(
      'UPDATE manga SET chapters_last_fetched_at = ? WHERE id = ? AND user_id = ?',
      now,
      mangaId,
      userId,
    );

    return chaptersForManga(db, userId, mangaId);
  });
}

// -------------------------------------------------------------- mutations --

interface UpdateChaptersArgs {
  input: {
    ids: number[];
    patch: { isRead?: boolean | null; isBookmarked?: boolean | null; lastPageRead?: number | null };
  };
}

export const group: ResolverGroup = {
  Query: {
    chapters: (_parent: unknown, args: ChaptersArgs, context: GraphQLContext) =>
      listChapters(context.db, context.userId, args),

    chapter: (_parent: unknown, args: { id: number }, context: GraphQLContext) => {
      const row = chapterRowById(context.db, context.userId, args.id);
      return row ? mapChapter(row) : null;
    },
  },

  Mutation: {
    fetchChapters: async (
      _parent: unknown,
      args: { input: { mangaId: number } },
      context: GraphQLContext,
    ) => ({ chapters: await fetchChaptersFor(context, args.input.mangaId) }),

    /**
     * Resolve a chapter's pages and hand back same-origin paths for them.
     *
     * The paths are `/api/v1/manga/:mangaId/chapter/:sourceOrder/page/:n`, used
     * directly as `<img src>`: an image tag can only carry the session cookie,
     * and only to this origin, so the reader never sees the source's own URLs.
     * They are built from `sourceOrder` rather than the row id because that is
     * what the reader's routes carry throughout.
     */
    fetchChapterPages: async (
      _parent: unknown,
      args: { input: { chapterId: number } },
      context: GraphQLContext,
    ) => {
      const chapter = requireChapterRow(context.db, context.userId, args.input.chapterId);
      const pages = await ensureChapterPages(context, context.userId, chapter.id);
      return {
        pages: pages.map(
          (_page, index) =>
            `/api/v1/manga/${chapter.manga_id}/chapter/${chapter.source_order}/page/${index}`,
        ),
        chapter: mapChapter(requireChapterRow(context.db, context.userId, chapter.id)),
      };
    },

    /**
     * Read state, bookmarks and page position, set explicitly.
     *
     * **This never stamps `last_read_at` and never reports to the tracker.**
     * Both are the reader's business (`reader/progress.ts`), and both would be
     * actively wrong here: `last_read_at` is what the continue-reading shelf
     * sorts on, so a "mark everything read" over a backlog would fill the shelf
     * with a dozen titles nobody just read, and pushing those chapters at
     * AniList would move remote progress on the strength of a bulk edit. The
     * mutation is also how the library's AniList refresh *clears* `isRead` to
     * follow a rollback, which must not travel back as a lower number.
     *
     * Only the columns the patch names are written, for the same reason: this
     * call says what it says and nothing more.
     */
    updateChapters: (_parent: unknown, args: UpdateChaptersArgs, context: GraphQLContext) =>
      context.db.transaction(() => {
        const ids = [...new Set(args.input.ids)];
        const patch = args.input.patch;

        const assignments: string[] = [];
        const params: Param[] = [];
        if (patch.isRead != null) {
          assignments.push('is_read = ?');
          params.push(boolValue(patch.isRead));
        }
        if (patch.isBookmarked != null) {
          assignments.push('is_bookmarked = ?');
          params.push(boolValue(patch.isBookmarked));
        }
        if (patch.lastPageRead != null) {
          assignments.push('last_page_read = ?');
          params.push(Math.max(0, Math.floor(patch.lastPageRead)));
        }

        // Checked before anything is written: a half-applied bulk edit leaves
        // nothing saying which half ran.
        const rows = ids.map((id) => requireChapterRow(context.db, context.userId, id));

        if (assignments.length > 0 && rows.length > 0) {
          context.db.run(
            `UPDATE chapter SET ${assignments.join(', ')}
              WHERE user_id = ? AND id IN (${placeholders(rows.length)})`,
            ...params,
            context.userId,
            ...rows.map((row) => row.id),
          );
        }

        return {
          chapters: rows.map((row) =>
            mapChapter(requireChapterRow(context.db, context.userId, row.id)),
          ),
        };
      }),
  },

  types: {
    ChapterType: {
      manga: (parent: Record<string, unknown>, _args: unknown, context: GraphQLContext): Manga => {
        const mangaId = mangaIdOf(parent);
        const row = mangaId === null ? undefined : mangaRowById(context.db, context.userId, mangaId);
        // Non-null in the schema, and it genuinely cannot be missing: the row is
        // a foreign key with ON DELETE CASCADE behind it.
        if (!row) throw new GraphQLError('This chapter has no manga.');
        return mapManga(row);
      },

      mangaId: (parent: Record<string, unknown>): number => mangaIdOf(parent) ?? 0,

      chapterNumber: (parent: Record<string, unknown>): number =>
        numberOf(parent.chapterNumber ?? parent.chapter_number, -1),

      sourceOrder: (parent: Record<string, unknown>): number =>
        numberOf(parent.sourceOrder ?? parent.source_order, 0),

      // The three LongString stamps. Epoch milliseconds, as decimal strings.
      uploadDate: (parent: Record<string, unknown>): string =>
        String(numberOf(parent.uploadDate ?? parent.date_upload, 0)),

      lastReadAt: (parent: Record<string, unknown>): string =>
        String(numberOf(parent.lastReadAt ?? parent.last_read_at, 0)),

      fetchedAt: (parent: Record<string, unknown>): string =>
        String(numberOf(parent.fetchedAt ?? parent.fetched_at, 0)),
    },
  },
};

function mangaIdOf(parent: Record<string, unknown>): number | null {
  const value = parent.mangaId ?? parent.manga_id;
  return typeof value === 'number' ? value : null;
}

function numberOf(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
