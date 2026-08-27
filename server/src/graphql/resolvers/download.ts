/**
 * The download queue as the UI drives it.
 *
 * Every mutation answers with the whole `DownloadStatus`, which is what makes
 * the screen correct without a subscription: the client has no transport for
 * `DownloadUpdate`, so it polls `downloadStatus` once a second while anything is
 * running and otherwise trusts the payload of whatever it just sent.
 *
 * Two behaviours here are older than this server and are reproduced on purpose,
 * because the UI is built on them and cannot be changed:
 *
 *   * **`enqueueChapterDownloads` does not start the downloader.** Chapters land
 *     at QUEUED with the downloader STOPPED, and the client always sends
 *     `startDownloader` next. Starting one here would work, and would then
 *     diverge the moment somebody enqueued without wanting to start.
 *   * **A finished chapter leaves the queue**, so the only lasting record of it
 *     is `chapter.is_downloaded`. The Downloads screen asks a second query for
 *     what is on disk for exactly that reason.
 */
import { GraphQLError } from 'graphql';

import type { GraphQLContext } from '../../types.js';
import type { ResolverGroup } from './index.js';
import {
  clear,
  dequeue,
  deleteDownloaded,
  enqueue,
  hasPendingWork,
  pause,
  reorder,
  status,
} from '../../downloads/store.js';
import { setDownloaderState } from '../../downloads/state.js';

interface IdsInput {
  input: { ids?: number[] | null };
}

interface ReorderInput {
  input: { chapterId: number; to: number };
}

/** Ids arrive from the client; a non-integer one indexes nothing and is a bug. */
function requireIds(raw: number[] | null | undefined, field: string): number[] {
  const list = raw ?? [];
  if (list.some((id) => !Number.isInteger(id))) {
    throw new GraphQLError(`${field} must be a list of chapter ids.`);
  }
  return list;
}

export const group: ResolverGroup = {
  Query: {
    downloadStatus: (_parent: unknown, _args: unknown, context: GraphQLContext) =>
      status(context.db, context.userId),
  },

  Mutation: {
    enqueueChapterDownloads: (_parent: unknown, args: IdsInput, context: GraphQLContext) => {
      enqueue(context.db, context.userId, requireIds(args.input.ids, 'ids'));
      return { downloadStatus: status(context.db, context.userId) };
    },

    dequeueChapterDownloads: (_parent: unknown, args: IdsInput, context: GraphQLContext) => {
      dequeue(context.db, context.userId, requireIds(args.input.ids, 'ids'));
      // Removing the chapter that was downloading empties the queue as far as
      // the worker is concerned; leaving the downloader STARTED would keep the
      // client polling a queue with nothing in it.
      if (!hasPendingWork(context.db, context.userId)) {
        setDownloaderState(context.userId, false);
      }
      return { downloadStatus: status(context.db, context.userId) };
    },

    /**
     * Arms the worker for this account. Nothing is started for an account with
     * an empty queue: the state the UI shows would then say STARTED forever,
     * and it polls for as long as it does.
     */
    startDownloader: (_parent: unknown, _args: unknown, context: GraphQLContext) => {
      setDownloaderState(context.userId, hasPendingWork(context.db, context.userId));
      return { downloadStatus: status(context.db, context.userId) };
    },

    /**
     * Pausing returns the chapter in flight to QUEUED rather than leaving it
     * DOWNLOADING — the worker steps away at the next page boundary, and the row
     * must not describe work nobody is doing in the meantime. Its pages stay on
     * disk, so resuming picks up where it stopped instead of asking the site for
     * them again.
     */
    stopDownloader: (_parent: unknown, _args: unknown, context: GraphQLContext) => {
      setDownloaderState(context.userId, false);
      pause(context.db, context.userId);
      return { downloadStatus: status(context.db, context.userId) };
    },

    /** Empties the queue. What is already on disk is not a queue entry. */
    clearDownloader: (_parent: unknown, _args: unknown, context: GraphQLContext) => {
      setDownloaderState(context.userId, false);
      clear(context.db, context.userId);
      return { downloadStatus: status(context.db, context.userId) };
    },

    reorderChapterDownload: (_parent: unknown, args: ReorderInput, context: GraphQLContext) => {
      const { chapterId, to } = args.input;
      if (!Number.isInteger(chapterId) || !Number.isInteger(to)) {
        throw new GraphQLError('chapterId and to must be whole numbers.');
      }
      reorder(context.db, context.userId, chapterId, to);
      return { downloadStatus: status(context.db, context.userId) };
    },

    deleteDownloadedChapters: async (
      _parent: unknown,
      args: IdsInput,
      context: GraphQLContext,
    ) => {
      const chapters = await deleteDownloaded(
        context.db,
        context.config,
        context.userId,
        requireIds(args.input.ids, 'ids'),
      );
      return { chapters };
    },
  },
};
