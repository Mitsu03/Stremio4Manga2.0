/**
 * Categories: the shelves a reader names, and what is filed on them.
 *
 * "Default" (id 0) is not a row. It is every library entry filed nowhere else,
 * derived on read, and it is what makes the library complete without forcing
 * anyone to invent a category before they can add a title. It always sits at the
 * head of the list with `order: 0`, which is why a real category's order starts
 * at 1 and `updateCategoryOrder` never accepts a position below it.
 *
 * Two rules the old server got wrong and this one does not:
 *
 *   * `addToCategories: [0]` is refused. The Java server made it a no-op, so
 *     filing something into Default looked like an action that had simply
 *     failed. An id that cannot be a target should say so.
 *   * Deleting a category never removes a title from the library. Only the
 *     `category_manga` rows go; the manga keeps `in_library` and reappears under
 *     Default, which is where an unfiled title belongs.
 */
import { GraphQLError } from 'graphql';
import type { Db } from '../../db/open.js';
import type { GraphQLContext } from '../../types.js';
import type { ResolverGroup } from './index.js';

/** The virtual category. Never stored, never a write target. */
export const DEFAULT_CATEGORY_ID = 0;

interface CategoryRow {
  id: number;
  name: string;
  ord: number;
}

interface Category {
  id: number;
  name: string;
  order: number;
  default: boolean;
}

interface MangaRow {
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
}

const MANGA_STATUSES = new Set([
  'UNKNOWN',
  'ONGOING',
  'COMPLETED',
  'LICENSED',
  'PUBLISHING_FINISHED',
  'CANCELLED',
  'ON_HIATUS',
]);

function parseGenre(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * A manga row as MangaType sees it.
 *
 * The raw columns are kept alongside the camelCase fields on purpose: the library
 * group owns the rest of MangaType and its field resolvers (`chapters`, `source`,
 * `trackRecords`) are handed this same object, so whichever spelling they read
 * from, the parent has it.
 */
function toManga(row: MangaRow): Record<string, unknown> {
  return {
    ...row,
    id: row.id,
    sourceId: String(row.source_id),
    url: row.url,
    title: row.title,
    thumbnailUrl: row.thumbnail_url,
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

const MANGA_COLUMNS =
  'id, user_id, source_id, url, title, artist, author, description, genre, status, ' +
  'thumbnail_url, real_url, initialized, in_library, in_library_at';

function defaultCategory(): Category {
  return { id: DEFAULT_CATEGORY_ID, name: 'Default', order: 0, default: true };
}

function toCategory(row: CategoryRow): Category {
  return { id: row.id, name: row.name, order: row.ord, default: false };
}

/** Real categories only, in the order they are kept. */
function listCategories(db: Db, userId: string): CategoryRow[] {
  return db.all<CategoryRow>(
    'SELECT id, name, ord FROM category WHERE user_id = ? ORDER BY ord, id',
    userId,
  );
}

function requireCategory(db: Db, userId: string, id: number): CategoryRow {
  if (id === DEFAULT_CATEGORY_ID) {
    throw new GraphQLError('Default is not a real category and cannot be changed.');
  }
  const row = db.get<CategoryRow>(
    'SELECT id, name, ord FROM category WHERE id = ? AND user_id = ?',
    id,
    userId,
  );
  if (!row) throw new GraphQLError(`No category with id ${id}.`);
  return row;
}

function requireName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed === '') throw new GraphQLError('A category needs a name.');
  if (trimmed.length > 64) throw new GraphQLError('A category name is at most 64 characters.');
  return trimmed;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** Every id must exist and belong to the caller, or the whole write is refused. */
function ownedMangaIds(context: GraphQLContext, ids: number[]): number[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = context.db.all<{ id: number }>(
    `SELECT id FROM manga WHERE user_id = ? AND id IN (${placeholders(unique.length)})`,
    context.userId,
    ...unique,
  );
  if (rows.length !== unique.length) {
    const found = new Set(rows.map((row) => row.id));
    const missing = unique.filter((id) => !found.has(id));
    throw new GraphQLError(`No manga with id ${missing.join(', ')}.`);
  }
  return unique;
}

function ownedCategoryIds(context: GraphQLContext, ids: number[], what: string): number[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = context.db.all<{ id: number }>(
    `SELECT id FROM category WHERE user_id = ? AND id IN (${placeholders(unique.length)})`,
    context.userId,
    ...unique,
  );
  if (rows.length !== unique.length) {
    const found = new Set(rows.map((row) => row.id));
    const missing = unique.filter((id) => !found.has(id));
    throw new GraphQLError(`${what} names no category with id ${missing.join(', ')}.`);
  }
  return unique;
}

/** Rewrite `ord` as 1..n over the given order, leaving 0 free for Default. */
function renumber(db: Db, userId: string, ordered: CategoryRow[]): Category[] {
  ordered.forEach((row, index) => {
    const order = index + 1;
    if (row.ord !== order) {
      db.run('UPDATE category SET ord = ? WHERE id = ? AND user_id = ?', order, row.id, userId);
    }
    row.ord = order;
  });
  return ordered.map(toCategory);
}

export const group: ResolverGroup = {
  Query: {
    categories: (_parent: unknown, _args: unknown, context: GraphQLContext) => {
      const nodes = [
        defaultCategory(),
        ...listCategories(context.db, context.userId).map(toCategory),
      ];
      return { nodes, totalCount: nodes.length };
    },

    category: (_parent: unknown, args: { id: number }, context: GraphQLContext) => {
      if (args.id === DEFAULT_CATEGORY_ID) return defaultCategory();
      const row = context.db.get<CategoryRow>(
        'SELECT id, name, ord FROM category WHERE id = ? AND user_id = ?',
        args.id,
        context.userId,
      );
      return row ? toCategory(row) : null;
    },
  },

  Mutation: {
    createCategory: (
      _parent: unknown,
      args: { input: { name: string } },
      context: GraphQLContext,
    ) => {
      const name = requireName(args.input.name);
      return context.db.transaction(() => {
        const next = context.db.get<{ ord: number }>(
          'SELECT COALESCE(MAX(ord), 0) + 1 AS ord FROM category WHERE user_id = ?',
          context.userId,
        );
        // Default holds 0, so the first real category lands on 1.
        const ord = Math.max(1, next?.ord ?? 1);
        const { lastInsertRowid } = context.db.run(
          'INSERT INTO category (user_id, name, ord) VALUES (?, ?, ?)',
          context.userId,
          name,
          ord,
        );
        return { category: { id: lastInsertRowid, name, order: ord, default: false } };
      });
    },

    updateCategory: (
      _parent: unknown,
      args: { input: { id: number; patch: { name?: string | null } } },
      context: GraphQLContext,
    ) => {
      const existing = requireCategory(context.db, context.userId, args.input.id);
      if (args.input.patch.name == null) return { category: toCategory(existing) };
      const name = requireName(args.input.patch.name);
      context.db.run(
        'UPDATE category SET name = ? WHERE id = ? AND user_id = ?',
        name,
        existing.id,
        context.userId,
      );
      return { category: { id: existing.id, name, order: existing.ord, default: false } };
    },

    deleteCategory: (
      _parent: unknown,
      args: { input: { categoryId: number } },
      context: GraphQLContext,
    ) => {
      if (args.input.categoryId === DEFAULT_CATEGORY_ID) {
        throw new GraphQLError('Default is not a real category and cannot be deleted.');
      }
      return context.db.transaction(() => {
        const existing = context.db.get<CategoryRow>(
          'SELECT id, name, ord FROM category WHERE id = ? AND user_id = ?',
          args.input.categoryId,
          context.userId,
        );
        if (!existing) return { category: null };
        // Only the memberships. The titles stay in the library and fall back to
        // Default; ON DELETE CASCADE would do this, but saying it here means the
        // guarantee does not depend on a PRAGMA holding.
        context.db.run('DELETE FROM category_manga WHERE category_id = ?', existing.id);
        context.db.run(
          'DELETE FROM category WHERE id = ? AND user_id = ?',
          existing.id,
          context.userId,
        );
        renumber(context.db, context.userId, listCategories(context.db, context.userId));
        return { category: toCategory(existing) };
      });
    },

    updateCategoryOrder: (
      _parent: unknown,
      args: { input: { id: number; position: number } },
      context: GraphQLContext,
    ) => {
      const { id, position } = args.input;
      if (id === DEFAULT_CATEGORY_ID) {
        throw new GraphQLError('Default always comes first and cannot be moved.');
      }
      return context.db.transaction(() => {
        const ordered = listCategories(context.db, context.userId);
        const from = ordered.findIndex((row) => row.id === id);
        if (from < 0) throw new GraphQLError(`No category with id ${id}.`);

        // `position` is 1-based, because Default occupies 0.
        const to = Math.min(Math.max(position, 1), ordered.length) - 1;
        const [moved] = ordered.splice(from, 1);
        ordered.splice(to, 0, moved);

        // The whole list comes back renumbered: a move shifts its neighbours, and
        // the client re-reads rather than guessing which ones.
        return { categories: [defaultCategory(), ...renumber(context.db, context.userId, ordered)] };
      });
    },

    updateMangasCategories: (
      _parent: unknown,
      args: {
        input: {
          ids: number[];
          patch: {
            addToCategories?: number[] | null;
            removeFromCategories?: number[] | null;
            clearCategories?: boolean | null;
          };
        };
      },
      context: GraphQLContext,
    ) => {
      const { ids, patch } = args.input;
      const add = patch.addToCategories ?? [];
      const remove = patch.removeFromCategories ?? [];

      if (add.includes(DEFAULT_CATEGORY_ID)) {
        throw new GraphQLError(
          'Default is where unfiled titles already are; it cannot be added to. ' +
            'Remove a title from its categories instead.',
        );
      }

      return context.db.transaction(() => {
        const mangaIds = ownedMangaIds(context, ids);
        const addIds = ownedCategoryIds(context, add, 'addToCategories');
        // Default in `removeFromCategories` is meaningless rather than wrong: a
        // title is in Default precisely when it is in nothing else.
        const removeIds = ownedCategoryIds(
          context,
          remove.filter((categoryId) => categoryId !== DEFAULT_CATEGORY_ID),
          'removeFromCategories',
        );

        if (mangaIds.length > 0) {
          const list = placeholders(mangaIds.length);

          if (patch.clearCategories) {
            context.db.run(`DELETE FROM category_manga WHERE manga_id IN (${list})`, ...mangaIds);
          }
          for (const categoryId of removeIds) {
            context.db.run(
              `DELETE FROM category_manga WHERE category_id = ? AND manga_id IN (${list})`,
              categoryId,
              ...mangaIds,
            );
          }
          for (const categoryId of addIds) {
            for (const mangaId of mangaIds) {
              context.db.run(
                'INSERT OR IGNORE INTO category_manga (category_id, manga_id) VALUES (?, ?)',
                categoryId,
                mangaId,
              );
            }
          }
        }

        const mangas = mangaIds.map((mangaId) =>
          toManga(
            context.db.get<MangaRow>(
              `SELECT ${MANGA_COLUMNS} FROM manga WHERE id = ? AND user_id = ?`,
              mangaId,
              context.userId,
            ) as MangaRow,
          ),
        );
        return { mangas };
      });
    },
  },

  types: {
    CategoryType: {
      mangas: (parent: Category, _args: unknown, context: GraphQLContext) => {
        const rows =
          parent.id === DEFAULT_CATEGORY_ID
            ? // Everything in the library filed nowhere else — the definition of
              // Default, computed rather than stored.
              context.db.all<MangaRow>(
                `SELECT ${MANGA_COLUMNS} FROM manga m
                 WHERE m.user_id = ? AND m.in_library = 1
                   AND NOT EXISTS (SELECT 1 FROM category_manga cm WHERE cm.manga_id = m.id)
                 ORDER BY m.title COLLATE NOCASE, m.id`,
                context.userId,
              )
            : context.db.all<MangaRow>(
                `SELECT ${MANGA_COLUMNS.split(', ')
                  .map((column) => `m.${column}`)
                  .join(', ')} FROM manga m
                 JOIN category_manga cm ON cm.manga_id = m.id
                 WHERE cm.category_id = ? AND m.user_id = ? AND m.in_library = 1
                 ORDER BY m.title COLLATE NOCASE, m.id`,
                parent.id,
                context.userId,
              );
        return { nodes: rows.map(toManga), totalCount: rows.length };
      },
    },

    MangaType: {
      categories: (parent: { id: number }, _args: unknown, context: GraphQLContext) => {
        // Id 0 is never stored, so it can never appear here.
        const rows = context.db.all<CategoryRow>(
          `SELECT c.id, c.name, c.ord FROM category c
           JOIN category_manga cm ON cm.category_id = c.id
           WHERE cm.manga_id = ? AND c.user_id = ?
           ORDER BY c.ord, c.id`,
          parent.id,
          context.userId,
        );
        const nodes = rows.map(toCategory);
        return { nodes, totalCount: nodes.length };
      },
    },
  },
};
