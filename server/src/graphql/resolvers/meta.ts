/**
 * Meta: client state the server stores and never interprets.
 *
 * Everything the UI would otherwise have put in `localStorage` lives here —
 * `stremio4manga.settings` (the whole preferences blob), `.saved-searches`,
 * `.anilist-last-sync` globally, and `.source-binding`, `.chapter-view`,
 * `.no-chapters`, `.reader-zoom`, `.continue-hidden` per manga. The server's only
 * jobs are to store the string it was given, hand back exactly that string, and
 * make sure one account can never read or write another's.
 *
 * `manga_meta` has no `user_id` of its own — its manga does — so every write goes
 * through an ownership check on `manga` first. Without it, a mangaId from another
 * account would be a working cross-tenant write.
 */
import { GraphQLError } from 'graphql';
import type { GraphQLContext } from '../../types.js';
import type { ResolverGroup } from './index.js';

interface GlobalMetaRow {
  key: string;
  value: string;
}

interface MangaMetaRow {
  mangaId: number;
  key: string;
  value: string;
}

function assertOwnedManga(context: GraphQLContext, mangaId: number): void {
  const owned = context.db.get<{ one: number }>(
    'SELECT 1 AS one FROM manga WHERE id = ? AND user_id = ?',
    mangaId,
    context.userId,
  );
  if (!owned) throw new GraphQLError(`No manga with id ${mangaId}.`);
}

function requireKey(key: unknown): string {
  if (typeof key !== 'string' || key === '') throw new GraphQLError('A meta key cannot be empty.');
  return key;
}

export const group: ResolverGroup = {
  Query: {
    metas: (
      _parent: unknown,
      args: { condition?: { key?: string | null; value?: string | null } | null },
      context: GraphQLContext,
    ) => {
      const clauses = ['user_id = ?'];
      const params: (string | number)[] = [context.userId];
      if (args.condition?.key != null) {
        clauses.push('key = ?');
        params.push(args.condition.key);
      }
      if (args.condition?.value != null) {
        clauses.push('value = ?');
        params.push(args.condition.value);
      }
      const nodes = context.db.all<GlobalMetaRow>(
        `SELECT key, value FROM global_meta WHERE ${clauses.join(' AND ')} ORDER BY key`,
        ...params,
      );
      return { nodes, totalCount: nodes.length };
    },
  },

  Mutation: {
    setGlobalMeta: (
      _parent: unknown,
      args: { input: { meta: { key: string; value: string } } },
      context: GraphQLContext,
    ) => {
      const key = requireKey(args.input.meta.key);
      const value = args.input.meta.value;
      context.db.run(
        `INSERT INTO global_meta (user_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
        context.userId,
        key,
        value,
      );
      return { meta: { key, value } };
    },

    setMangaMeta: (
      _parent: unknown,
      args: { input: { meta: { mangaId: number; key: string; value: string } } },
      context: GraphQLContext,
    ) => {
      const { mangaId, value } = args.input.meta;
      const key = requireKey(args.input.meta.key);
      assertOwnedManga(context, mangaId);
      context.db.run(
        `INSERT INTO manga_meta (manga_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT (manga_id, key) DO UPDATE SET value = excluded.value`,
        mangaId,
        key,
        value,
      );
      return { meta: { mangaId, key, value } };
    },

    deleteMangaMeta: (
      _parent: unknown,
      args: { input: { mangaId: number; key: string } },
      context: GraphQLContext,
    ) => {
      const { mangaId } = args.input;
      const key = requireKey(args.input.key);
      assertOwnedManga(context, mangaId);
      return context.db.transaction(() => {
        const existing = context.db.get<{ value: string }>(
          'SELECT value FROM manga_meta WHERE manga_id = ? AND key = ?',
          mangaId,
          key,
        );
        // Deleting something that was never set is how the client clears a
        // preference it has not written yet; that is a null payload, not an error.
        if (!existing) return { meta: null };
        context.db.run('DELETE FROM manga_meta WHERE manga_id = ? AND key = ?', mangaId, key);
        return { meta: { mangaId, key, value: existing.value } };
      });
    },
  },

  types: {
    // Only `meta` is claimed here; the library group owns the rest of MangaType.
    MangaType: {
      meta: (parent: { id: number }, _args: unknown, context: GraphQLContext): MangaMetaRow[] =>
        context.db.all<MangaMetaRow>(
          'SELECT manga_id AS mangaId, key, value FROM manga_meta WHERE manga_id = ? ORDER BY key',
          parent.id,
        ),
    },
  },
};
