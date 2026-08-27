/**
 * The backup half of the API: export, validate, restore, and the nightly copies.
 *
 * Seven fields, and only two shapes of work behind them. The three that take a
 * *file* get it as an `Upload`, already turned into bytes by the multipart
 * parser. The three that take a *filename* name something the server already
 * holds, and every one of those resolves the name **against the listing of the
 * directory** rather than by joining it onto a path. That is the whole defence
 * against `../../database.mv.db`: a name that is not in the listing simply does
 * not match, so there is no path to sanitise and no sanitiser to get wrong.
 *
 * `createBackup` answers with a *relative* url. The client opens it with an
 * `<a download>` against its own origin, which is why an absolute one would be
 * wrong even when it worked — it would stop working the moment the server was
 * reached through a different name.
 */
import { GraphQLError } from 'graphql';
import { readFileSync } from 'node:fs';

import type { GraphQLContext } from '../../types.js';
import type { ResolverGroup } from './index.js';
import type { UploadedFile } from '../multipart.js';
import {
  createBackup,
  findBackup,
  listBackups,
  type BackupFlags,
} from '../../backup/create.js';
import { BackupFormatError } from '../../backup/format.js';
import {
  restoreBackup,
  restoreStatus,
  validateBackup,
  type RestorePayload,
  type ValidateBackupResult,
} from '../../backup/restore.js';
import { readLastRun } from '../../backup/schedule.js';

/**
 * A malformed archive is the reader's mistake, not the server's, and the message
 * is written to be shown. Everything else keeps its own wording.
 */
function asGraphQLError(error: unknown): GraphQLError {
  if (error instanceof BackupFormatError) return new GraphQLError(error.message);
  if (error instanceof GraphQLError) return error;
  return new GraphQLError((error as Error).message);
}

/** The stored backup a client named, or an error that does not confirm the name exists. */
function storedBackup(context: GraphQLContext, filename: unknown): string {
  if (typeof filename !== 'string' || filename === '') {
    throw new GraphQLError('Name the backup to use.');
  }
  const found = findBackup(context.config, context.userId, filename);
  if (!found) throw new GraphQLError(`There is no automated backup called "${filename}".`);
  return found.path;
}

export const group: ResolverGroup = {
  Query: {
    validateBackup: (
      _parent: unknown,
      args: { input: { backup: UploadedFile } },
      context: GraphQLContext,
    ): ValidateBackupResult => {
      try {
        return validateBackup(context.db, context.userId, args.input.backup);
      } catch (error) {
        throw asGraphQLError(error);
      }
    },

    restoreStatus: (_parent: unknown, args: { id: string }, context: GraphQLContext) =>
      restoreStatus(context.userId, args.id),

    automatedBackups: (_parent: unknown, _args: unknown, context: GraphQLContext) => {
      const lastRun = readLastRun(context.db, context.userId);
      return {
        // Null rather than 0: "never" is a different answer from "at the epoch",
        // and the card reads one as "no automatic backup yet".
        lastRun: lastRun > 0 ? String(lastRun) : null,
        files: listBackups(context.config, context.userId).map((file) => ({
          filename: file.filename,
          sizeBytes: String(file.sizeBytes),
          createdAt: String(Math.trunc(file.createdAt)),
        })),
      };
    },

    validateAutomatedBackup: (
      _parent: unknown,
      args: { filename: string },
      context: GraphQLContext,
    ): ValidateBackupResult => {
      const path = storedBackup(context, args.filename);
      try {
        return validateBackup(context.db, context.userId, readFileSync(path));
      } catch (error) {
        throw asGraphQLError(error);
      }
    },
  },

  Mutation: {
    createBackup: (
      _parent: unknown,
      args: { input?: Partial<Record<keyof BackupFlags, boolean | null>> | null },
      context: GraphQLContext,
    ) => {
      try {
        const created = createBackup(
          context.db,
          context.config,
          context.userId,
          args.input ?? undefined,
        );
        return { url: created.url };
      } catch (error) {
        context.log.error(`Backup for ${context.userId} failed: ${(error as Error).message}`);
        throw asGraphQLError(error);
      }
    },

    restoreBackup: (
      _parent: unknown,
      args: { input: { backup: UploadedFile } },
      context: GraphQLContext,
    ): RestorePayload => {
      try {
        return restoreBackup(context.db, context.userId, args.input.backup, (message) =>
          context.log.error(message),
        );
      } catch (error) {
        throw asGraphQLError(error);
      }
    },

    restoreAutomatedBackup: (
      _parent: unknown,
      args: { input: { filename: string } },
      context: GraphQLContext,
    ): RestorePayload => {
      const path = storedBackup(context, args.input.filename);
      try {
        return restoreBackup(context.db, context.userId, readFileSync(path), (message) =>
          context.log.error(message),
        );
      } catch (error) {
        throw asGraphQLError(error);
      }
    },
  },
};
