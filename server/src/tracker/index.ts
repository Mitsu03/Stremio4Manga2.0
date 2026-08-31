/**
 * What a tracker is, and which ones this server has.
 *
 * `anilist.ts` talks HTTP and knows AniList's vocabulary. This file says what
 * *any* tracker must be able to do, adapts each API module into that shape, and
 * keeps the registry the layers above look things up in. The API modules stay
 * as they were — pure clients that never see a user id or a database — because
 * the adapter is written here rather than in them.
 *
 * ## The two things that are not the same for every tracker
 *
 * **The handshake.** AniList uses implicit grant: the token arrives in the URL
 * fragment and there is nothing to exchange. MyAnimeList uses authorization
 * code with PKCE, which means a verifier held across the round trip and a POST
 * carrying a client secret. So the interface asks for `exchangeCallback`, which
 * is async and takes the verifier, rather than the synchronous parse AniList
 * alone would need; `authRequiresVerifier` tells the client which of the two it
 * is starting, since only the client can hold the verifier across a navigation.
 *
 * Both halves also take the `redirectUri` — where the browser comes back to.
 * AniList ignores it: its redirect is registered on the AniList app itself.
 * MyAnimeList sends it on the authorize request and must repeat it
 * byte-identically on the exchange, so it comes from one place rather than
 * being rebuilt twice.
 *
 * **Remote deletion.** `unbindTrack(deleteRemoteTrack: true)` can only do
 * anything on a tracker whose API offers it, so that is a property of the
 * tracker rather than a comparison against a constant.
 *
 * Ids are fixed per tracker and shared with the UI. They are not sequence
 * numbers: `track_record.tracker_id` and `tracker_credential.tracker_id` hold
 * them, so an id that moves rewrites history.
 */
import * as anilist from './anilist.js';
import { ANILIST_ICON, ANILIST_TRACKER_ID } from './anilist.js';
import * as myanimelist from './myanimelist.js';
import { MYANIMELIST_ICON, MYANIMELIST_TRACKER_ID } from './myanimelist.js';

/** One title as a tracker's search answers it — `TrackSearchType`, field for field. */
export interface TrackerSearch {
  remoteId: string;
  title: string;
  coverUrl: string;
  publishingStatus: string;
  publishingType: string;
  totalChapters: number;
  trackingUrl: string;
  summary: string;
}

/** One title's remote state, in our terms rather than any tracker's. */
export interface TrackerEntry {
  remoteId: string;
  title: string;
  coverUrl: string;
  totalChapters: number;
  trackingUrl: string;
  /** The reader's own progress, which is a chapter count, not a chapter number. */
  lastChapterRead: number;
  status: number;
  score: number;
  /** Epoch milliseconds, 0 when the tracker has no (or a partial) date. */
  startDate: number;
  finishDate: number;
  mangaStatus: string;
}

/** Who a token belongs to. */
export interface TrackerViewer {
  id: string;
  name: string;
  avatarUrl: string | null;
  scoreFormat: string | null;
}

export interface TrackerToken {
  token: string;
  expiresAt: number;
}

export interface Tracker {
  /** Stable, shared with the UI, and written into every row this tracker owns. */
  readonly id: number;
  readonly name: string;
  readonly icon: string;

  /**
   * Whether the client must generate a PKCE verifier, put it on the auth URL
   * and hand it back to `exchangeCallback`. False for an implicit grant, where
   * there is nothing to exchange and nothing to remember.
   */
  readonly authRequiresVerifier: boolean;

  /** Whether `unbindTrack(deleteRemoteTrack: true)` can reach the remote list. */
  readonly supportsRemoteDeletion: boolean;

  /**
   * Where to send the browser, or null when the installation has no client id
   * for this tracker. `redirectUri` is where the browser comes back to.
   */
  authUrl(redirectUri: string): string | null;

  /**
   * Turn the URL the browser came back to into a token. Null when the callback
   * carries nothing usable, which is a wrong-callback rather than a failure.
   */
  exchangeCallback(
    callbackUrl: string,
    codeVerifier: string | null,
    redirectUri: string,
  ): Promise<TrackerToken | null>;

  viewer(token: string): Promise<TrackerViewer>;
  search(token: string, query: string): Promise<TrackerSearch[]>;
  mediaById(token: string, remoteId: string): Promise<TrackerSearch | null>;
  findListEntry(token: string, remoteUser: string, remoteId: string): Promise<TrackerEntry | null>;
  updateProgress(token: string, remoteId: string, progress: number, status?: number): Promise<void>;
  deleteListEntry(token: string, remoteUser: string, remoteId: string): Promise<boolean>;

  statusToNumber(status: string | null | undefined): number;
  statusFromNumber(status: number): string | null;
}

const anilistTracker: Tracker = {
  id: ANILIST_TRACKER_ID,
  name: 'AniList',
  icon: ANILIST_ICON,
  // Implicit grant: the token is in the fragment the client posts here whole.
  authRequiresVerifier: false,
  supportsRemoteDeletion: true,

  // The redirect is registered on the AniList app itself, so it is not sent.
  authUrl: () => anilist.authUrl(),
  exchangeCallback: async (callbackUrl) => anilist.tokenFromCallback(callbackUrl),

  viewer: (token) => anilist.viewer(token),
  search: (token, query) => anilist.search(token, query),
  mediaById: (token, remoteId) => anilist.mediaById(token, remoteId),
  findListEntry: (token, remoteUser, remoteId) =>
    anilist.findListEntry(token, remoteUser, remoteId),
  updateProgress: (token, remoteId, progress, status) =>
    anilist.updateProgress(token, remoteId, progress, status),
  deleteListEntry: (token, remoteUser, remoteId) =>
    anilist.deleteListEntry(token, remoteUser, remoteId),

  statusToNumber: (status) => anilist.statusToNumber(status),
  statusFromNumber: (status) => anilist.statusFromNumber(status),
};

const myanimelistTracker: Tracker = {
  id: MYANIMELIST_TRACKER_ID,
  name: 'MyAnimeList',
  icon: MYANIMELIST_ICON,
  // Authorization code with PKCE: the verifier has to outlive a navigation,
  // and only the client is still there when the browser comes back.
  authRequiresVerifier: true,
  supportsRemoteDeletion: true,

  authUrl: (redirectUri) => myanimelist.authUrl(redirectUri),
  exchangeCallback: (callbackUrl, codeVerifier, redirectUri) =>
    myanimelist.exchangeCode(callbackUrl, codeVerifier, redirectUri),

  viewer: (token) => myanimelist.viewer(token),
  search: (token, query) => myanimelist.search(token, query),
  mediaById: (token, remoteId) => myanimelist.mediaById(token, remoteId),
  findListEntry: (token, remoteUser, remoteId) =>
    myanimelist.findListEntry(token, remoteUser, remoteId),
  updateProgress: (token, remoteId, progress, status) =>
    myanimelist.updateProgress(token, remoteId, progress, status),
  deleteListEntry: (token, remoteUser, remoteId) =>
    myanimelist.deleteListEntry(token, remoteUser, remoteId),

  statusToNumber: (status) => myanimelist.statusToNumber(status),
  statusFromNumber: (status) => myanimelist.statusFromNumber(status),
};

// AniList first because it is the one this server shipped with and the one
// `importAnilistLibrary` speaks to; the UI lists them in this order.
const REGISTRY: readonly Tracker[] = [anilistTracker, myanimelistTracker];

/** Every tracker this build knows, in the order the UI should list them. */
export function allTrackers(): readonly Tracker[] {
  return REGISTRY;
}

/** Null rather than a throw: `tracker(id:)` answers null for an unknown id. */
export function trackerById(id: number): Tracker | null {
  return REGISTRY.find((tracker) => tracker.id === id) ?? null;
}

/** The same lookup where an unknown id is a caller's mistake rather than a query. */
export function requireTracker(id: number): Tracker {
  const found = trackerById(id);
  if (!found) {
    const known = REGISTRY.map((tracker) => `${tracker.name} is ${tracker.id}`).join(', ');
    throw new Error(`No tracker with id ${id}; ${known}.`);
  }
  return found;
}
