/**
 * The tracking half of the schema: `tracker`, `searchTracker`, the six track
 * mutations, `importAnilistLibrary`, and `MangaType.trackRecords`.
 *
 * There is exactly one tracker, AniList, and its id is 2 — hard-coded in the UI
 * (`web/src/utils/tracking.ts`) and therefore hard-coded here. `tracker(id:)`
 * answers null for anything else rather than inventing a second one.
 *
 * Every query filters on `user_id`. Two accounts on one server have separate
 * AniList connections, separate records and separate libraries; the only thing
 * they share is the client id, which is a property of the installation.
 */
import type { GraphQLContext } from '../../types.js';
import type { ResolverGroup } from './index.js';
import * as anilist from '../../tracker/anilist.js';
import { ANILIST_ICON, ANILIST_TRACKER_ID } from '../../tracker/anilist.js';
import {
  deleteCredential,
  isExpired,
  readCredential,
  requireCredential,
  saveCredential,
  saveProfile,
} from '../../tracker/credentials.js';
import * as records from '../../tracker/records.js';

interface TrackerUserView {
  name: string;
  avatarUrl: string | null;
}

interface TrackerView {
  id: number;
  name: string;
  icon: string;
  isLoggedIn: boolean;
  isTokenExpired: boolean;
  authUrl: string | null;
}

/**
 * The tracker as the schema describes it, minus `user`, which is a field
 * resolver below so that a query which does not ask for the profile never
 * waits on AniList.
 */
function trackerView(context: GraphQLContext): TrackerView {
  const credential = readCredential(context.db, context.userId, ANILIST_TRACKER_ID);
  const url = anilist.authUrl();
  return {
    id: ANILIST_TRACKER_ID,
    name: 'AniList',
    icon: ANILIST_ICON,
    // No client id means the connection cannot be made or remade, so the UI is
    // told it is not connected rather than being shown a button that 404s.
    isLoggedIn: url !== null && credential !== null && !isExpired(credential),
    isTokenExpired: isExpired(credential),
    authUrl: url,
  };
}

function trackerIdOf(parent: unknown): number {
  const id = (parent as { id?: unknown } | null)?.id;
  return typeof id === 'number' ? id : ANILIST_TRACKER_ID;
}

function mangaIdOf(parent: unknown): number | null {
  const id = (parent as { id?: unknown } | null)?.id;
  return typeof id === 'number' ? id : null;
}

// --------------------------------------------------------------- queries --

interface SearchTrackerArgs {
  input: { trackerId: number; query: string };
}

interface TrackerArgs {
  id: number;
}

// ------------------------------------------------------------- mutations --

interface LoginArgs {
  input: { trackerId: number; callbackUrl: string };
}

interface LogoutArgs {
  input: { trackerId: number };
}

interface BindTrackArgs {
  input: { mangaId: number; trackerId: number; remoteId: string };
}

interface BindTrackRecordArgs {
  input: { mangaId: number; trackRecordId: number };
}

interface UnbindArgs {
  input: { recordId: number; deleteRemoteTrack?: boolean | null };
}

interface FetchTrackArgs {
  input: { recordId: number };
}

function assertAniList(trackerId: number): void {
  if (trackerId !== ANILIST_TRACKER_ID) {
    throw new Error(`No tracker with id ${trackerId}; AniList is ${ANILIST_TRACKER_ID}.`);
  }
}

export const group: ResolverGroup = {
  Query: {
    tracker: (_parent: unknown, args: TrackerArgs, context: GraphQLContext) =>
      args.id === ANILIST_TRACKER_ID ? trackerView(context) : null,

    searchTracker: async (
      _parent: unknown,
      args: SearchTrackerArgs,
      context: GraphQLContext,
    ) => {
      assertAniList(args.input.trackerId);
      const credential = requireCredential(context.db, context.userId, args.input.trackerId);
      return { trackSearches: await anilist.search(credential.accessToken, args.input.query) };
    },
  },

  Mutation: {
    /**
     * The client hands over the whole callback URL because the token is in the
     * fragment, which never reaches a server by itself. It is verified against
     * AniList before it is stored: "connected" in the UI should mean the token
     * actually works, not that a URL parsed.
     */
    loginTrackerOAuth: async (_parent: unknown, args: LoginArgs, context: GraphQLContext) => {
      assertAniList(args.input.trackerId);

      const extracted = anilist.tokenFromCallback(args.input.callbackUrl);
      if (!extracted) {
        throw new Error('The AniList callback carried no access token.');
      }

      const profile = await anilist.viewer(extracted.token);
      context.db.transaction(() => {
        saveCredential(
          context.db,
          context.userId,
          args.input.trackerId,
          extracted.token,
          extracted.expiresAt,
        );
        saveProfile(context.db, context.userId, args.input.trackerId, {
          remoteUser: profile.id,
          displayName: profile.name,
          avatarUrl: profile.avatarUrl,
          scoreType: profile.scoreFormat,
        });
      });

      const tracker = trackerView(context);
      return { isLoggedIn: tracker.isLoggedIn, tracker };
    },

    logoutTracker: (_parent: unknown, args: LogoutArgs, context: GraphQLContext) => {
      assertAniList(args.input.trackerId);
      // The records stay: signing out is not "forget which series I read", and
      // signing back in should find the library exactly as it was left.
      deleteCredential(context.db, context.userId, args.input.trackerId);
      return { isLoggedIn: false, tracker: trackerView(context) };
    },

    bindTrack: async (_parent: unknown, args: BindTrackArgs, context: GraphQLContext) => {
      assertAniList(args.input.trackerId);
      const trackRecord = await records.bindByRemoteId(
        context.db,
        context.userId,
        args.input.mangaId,
        args.input.trackerId,
        String(args.input.remoteId),
      );
      return { trackRecord };
    },

    bindTrackRecord: (_parent: unknown, args: BindTrackRecordArgs, context: GraphQLContext) => ({
      trackRecord: records.bindExistingRecord(
        context.db,
        context.userId,
        args.input.mangaId,
        args.input.trackRecordId,
      ),
    }),

    /**
     * `deleteRemoteTrack` defaults to false, which is all the UI ever sends:
     * unbinding is a local decision about this library, and quietly editing
     * someone's AniList list because they rebound a source would be a
     * surprise they cannot undo from here.
     */
    unbindTrack: async (_parent: unknown, args: UnbindArgs, context: GraphQLContext) => ({
      trackRecord: await records.unbindRecord(
        context.db,
        context.userId,
        args.input.recordId,
        args.input.deleteRemoteTrack === true,
      ),
    }),

    fetchTrack: async (_parent: unknown, args: FetchTrackArgs, context: GraphQLContext) => ({
      trackRecord: await records.refreshRecord(context.db, context.userId, args.input.recordId),
    }),

    importAnilistLibrary: async (
      _parent: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => ({
      manga: await records.importLibrary(context.db, context.userId),
    }),
  },

  types: {
    TrackerType: {
      /**
       * Resolved from AniList the first time it is asked for and cached in the
       * credential row from then on.
       *
       * Null on any failure. The Settings page draws a banner from this and
       * falls back to the account's initial; taking the whole `tracker` query
       * down because AniList is having a minute would blank the page instead.
       */
      user: async (
        parent: unknown,
        _args: unknown,
        context: GraphQLContext,
      ): Promise<TrackerUserView | null> => {
        const trackerId = trackerIdOf(parent);
        const credential = readCredential(context.db, context.userId, trackerId);
        if (!credential || isExpired(credential)) return null;
        if (credential.displayName) {
          return { name: credential.displayName, avatarUrl: credential.avatarUrl };
        }

        try {
          const profile = await anilist.viewer(credential.accessToken);
          saveProfile(context.db, context.userId, trackerId, {
            remoteUser: profile.id,
            displayName: profile.name,
            avatarUrl: profile.avatarUrl,
            scoreType: profile.scoreFormat,
          });
          return { name: profile.name, avatarUrl: profile.avatarUrl };
        } catch {
          return null;
        }
      },
    },

    MangaType: {
      trackRecords: (parent: unknown, _args: unknown, context: GraphQLContext) => {
        const mangaId = mangaIdOf(parent);
        const nodes =
          mangaId === null ? [] : records.recordsForManga(context.db, context.userId, mangaId);
        return { nodes, totalCount: nodes.length };
      },
    },
  },
};
