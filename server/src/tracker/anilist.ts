/**
 * The AniList API, and nothing else.
 *
 * This module talks HTTP and knows AniList's vocabulary; it never touches the
 * database and never sees a user id. Everything above it (credentials.ts,
 * records.ts, the resolvers) works in our own terms — numeric statuses, epoch
 * milliseconds, LongString ids — so AniList's shape stops here.
 *
 * ## The client id
 *
 * AniList OAuth apps are registered per *installation*, not per user: one id
 * covers everyone on this server. It is not a secret — implicit grant puts it
 * in a URL the browser follows — but it is deployment configuration, so it is
 * read from the environment:
 *
 *     S4M_ANILIST_CLIENT_ID=12345
 *
 * `DEFAULT_CLIENT_ID` below is the id the Kotlin fork this replaces shipped
 * with, kept so an existing deployment keeps working without a new variable.
 * Register your own at https://anilist.co/settings/developer with the redirect
 * URL set to `<publicOrigin>/handle/oauth/result`.
 *
 * When neither is available `authUrl()` returns null rather than throwing: the
 * Settings page renders a tracker that simply cannot be connected yet, which is
 * a state it already handles, and a missing environment variable must not take
 * the whole GraphQL query down with it.
 */

/** Hard-coded in the UI (`web/src/utils/tracking.ts`), so hard-coded here. */
export const ANILIST_TRACKER_ID = 2;

/**
 * The pseudo-source imported titles live on. They are library shells: no
 * chapters, `url = 'anilist:<mediaId>'`, bound to a real source later through
 * the manga's own meta, which the server stores and never reads.
 */
export const ANILIST_SOURCE_ID = '1';

/** AniList's own mark, used as `TrackerType.icon`. Served by AniList's CDN. */
export const ANILIST_ICON = 'https://anilist.co/img/icons/android-chrome-192x192.png';

const API_URL = 'https://graphql.anilist.co';
const AUTHORIZE_URL = 'https://anilist.co/api/v2/oauth/authorize';

/** See the module comment: overridden by S4M_ANILIST_CLIENT_ID. */
const DEFAULT_CLIENT_ID = '17075';

/** AniList's implicit-grant tokens last a year; used when the URL omits it. */
const DEFAULT_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

const MAX_ATTEMPTS = 3;
/** What to wait when AniList 429s without saying how long. */
const FALLBACK_RETRY_SECONDS = 5;
/** A `Retry-After` longer than this is a ban, not a throttle; fail instead. */
const MAX_RETRY_SECONDS = 60;

// ------------------------------------------------------------------- types --

/** The six numbers `web/src/utils/tracking.ts` names, in AniList's order. */
export type StatusNumber = 1 | 2 | 3 | 4 | 5 | 6;

export interface AniListViewer {
  /** AniList's numeric account id, stored as text (it is a LongString on the wire). */
  id: string;
  name: string;
  avatarUrl: string | null;
  /** POINT_100, POINT_10, POINT_10_DECIMAL, POINT_5, POINT_3. */
  scoreFormat: string | null;
}

/** Exactly the fields `TrackSearchType` declares — all non-null in the schema. */
export interface AniListSearch {
  remoteId: string;
  title: string;
  coverUrl: string;
  publishingStatus: string;
  publishingType: string;
  totalChapters: number;
  trackingUrl: string;
  summary: string;
}

/** One title's remote state, in our terms rather than AniList's. */
export interface AniListEntry {
  remoteId: string;
  title: string;
  coverUrl: string;
  totalChapters: number;
  trackingUrl: string;
  /** The reader's own progress, which is a chapter count, not a chapter number. */
  lastChapterRead: number;
  status: number;
  score: number;
  /** Epoch milliseconds, 0 when AniList has no (or a partial) date. */
  startDate: number;
  finishDate: number;
  /** AniList's publication status, as a MangaStatus enum value. */
  mangaStatus: string;
}

export class AniListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AniListError';
  }
}

// ------------------------------------------------------------- client id --

/** The installation's client id, or null when it has been blanked out. */
export function clientId(): string | null {
  const configured = process.env.S4M_ANILIST_CLIENT_ID ?? DEFAULT_CLIENT_ID;
  const trimmed = configured.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Where to send the browser to start the implicit grant.
 *
 * No `state` and no `redirect_uri`: the client rewrites `state` to
 * `{"redirectUrl":…,"trackerId":2}` before navigating (SettingsPage's
 * `startAniListLogin`), and the redirect URL is fixed on the AniList app
 * itself. Anything appended here has to survive that rewrite, so nothing is.
 */
export function authUrl(id: string | null = clientId()): string | null {
  if (!id) return null;
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', id);
  url.searchParams.set('response_type', 'token');
  return url.toString();
}

/**
 * Pull the token out of the URL the browser came back to.
 *
 * Implicit grant puts it in the *fragment*, which never reaches a server on its
 * own — this works only because the client posts `window.location.href` whole
 * to `loginTrackerOAuth`. The query string is checked too: it costs one line
 * and covers a proxy or an AniList change that moves the parameters.
 */
export function tokenFromCallback(callbackUrl: string): { token: string; expiresAt: number } | null {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return null;
  }

  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  const token = fragment.get('access_token') ?? url.searchParams.get('access_token');
  if (!token) return null;

  const expiresIn = Number(fragment.get('expires_in') ?? url.searchParams.get('expires_in'));
  const lifetime =
    Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : DEFAULT_TOKEN_LIFETIME_MS;
  return { token, expiresAt: Date.now() + lifetime };
}

// -------------------------------------------------------------- statuses --

const STATUS_TO_NUMBER: Record<string, StatusNumber> = {
  CURRENT: 1,
  COMPLETED: 2,
  PAUSED: 3,
  DROPPED: 4,
  PLANNING: 5,
  REPEATING: 6,
};

const NUMBER_TO_STATUS: Record<number, string> = {
  1: 'CURRENT',
  2: 'COMPLETED',
  3: 'PAUSED',
  4: 'DROPPED',
  5: 'PLANNING',
  6: 'REPEATING',
};

/** `CURRENT` → 1. Unknown names become 0, which the UI shows as no shelf. */
export function statusToNumber(status: string | null | undefined): number {
  if (!status) return 0;
  return STATUS_TO_NUMBER[status] ?? 0;
}

/** 1 → `CURRENT`. Returns null for 0, so "unset" stays unset remotely. */
export function statusFromNumber(status: number): string | null {
  return NUMBER_TO_STATUS[status] ?? null;
}

/** AniList's publication status in the MangaStatus enum the schema declares. */
function mangaStatusFrom(status: string | null | undefined): string {
  switch (status) {
    case 'RELEASING':
      return 'ONGOING';
    case 'FINISHED':
      return 'PUBLISHING_FINISHED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'HIATUS':
      return 'ON_HIATUS';
    default:
      return 'UNKNOWN';
  }
}

/** `NOT_YET_RELEASED` → `Not yet released`, for the search list's two labels. */
function humanise(value: string | null | undefined): string {
  if (!value) return '';
  const words = value.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ------------------------------------------------------------- transport --

interface FuzzyDate {
  year: number | null;
  month: number | null;
  day: number | null;
}

/**
 * AniList dates are fuzzy: any of the three parts may be missing. A date with
 * no year is not a date, so it becomes 0 — the schema's "unset" for these.
 */
function fuzzyDateToMs(date: FuzzyDate | null | undefined): number {
  if (!date?.year) return 0;
  return Date.UTC(date.year, (date.month ?? 1) - 1, date.day ?? 1);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface GraphQLReply<T> {
  data?: T | null;
  errors?: Array<{ message?: string }>;
}

/**
 * One POST to AniList, retried only on rate limiting.
 *
 * AniList answers 429 with `Retry-After` in seconds and means it; hammering
 * through it earns a longer block. Other failures are not retried — a bad
 * token or a malformed query does not get better by being asked twice.
 */
async function request<T>(
  token: string | null,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  let lastMessage = 'AniList did not respond.';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      throw new AniListError(`Could not reach AniList: ${(error as Error).message}`);
    }

    if (response.status === 429) {
      const header = Number(response.headers.get('Retry-After'));
      const seconds = Number.isFinite(header) && header > 0 ? header : FALLBACK_RETRY_SECONDS;
      if (seconds > MAX_RETRY_SECONDS || attempt === MAX_ATTEMPTS) {
        throw new AniListError(`AniList is rate limiting this account (retry in ${seconds}s).`);
      }
      lastMessage = 'AniList is rate limiting this account.';
      await sleep(seconds * 1000);
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new AniListError('AniList rejected the access token; sign in again.');
    }

    let body: GraphQLReply<T>;
    try {
      body = (await response.json()) as GraphQLReply<T>;
    } catch {
      throw new AniListError(`AniList returned a non-JSON response (HTTP ${response.status}).`);
    }

    if (body.errors?.length) {
      throw new AniListError(body.errors[0]?.message ?? 'AniList returned an error.');
    }
    if (!response.ok || body.data === null || body.data === undefined) {
      throw new AniListError(`AniList returned HTTP ${response.status}.`);
    }
    return body.data;
  }

  throw new AniListError(lastMessage);
}

// ------------------------------------------------------------- fragments --

/**
 * One media selection reused by search, lookup and the list import, so the
 * three cannot drift into disagreeing about what a title is.
 */
const MEDIA_FIELDS = `
  id
  title { userPreferred romaji english native }
  coverImage { large medium }
  chapters
  status
  format
  siteUrl
  description(asHtml: false)
`;

interface MediaFields {
  id: number;
  title: {
    userPreferred: string | null;
    romaji: string | null;
    english: string | null;
    native: string | null;
  } | null;
  coverImage: { large: string | null; medium: string | null } | null;
  chapters: number | null;
  status: string | null;
  format: string | null;
  siteUrl: string | null;
  description: string | null;
}

/** AniList always has *a* title; which one is populated varies by series. */
function titleOf(media: MediaFields): string {
  const title = media.title;
  return (
    title?.userPreferred ?? title?.english ?? title?.romaji ?? title?.native ?? `AniList ${media.id}`
  );
}

function coverOf(media: MediaFields): string {
  return media.coverImage?.large ?? media.coverImage?.medium ?? '';
}

function trackingUrlOf(media: MediaFields): string {
  return media.siteUrl ?? `https://anilist.co/manga/${media.id}`;
}

/**
 * `description(asHtml: false)` still contains `<br>` and the odd `<i>`; the UI
 * renders the summary as text, so the tags would show up literally.
 */
function summaryOf(media: MediaFields): string {
  if (!media.description) return '';
  return media.description
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function searchFrom(media: MediaFields): AniListSearch {
  return {
    remoteId: String(media.id),
    title: titleOf(media),
    coverUrl: coverOf(media),
    publishingStatus: humanise(media.status),
    publishingType: humanise(media.format),
    totalChapters: media.chapters ?? 0,
    trackingUrl: trackingUrlOf(media),
    summary: summaryOf(media),
  };
}

interface ListEntryFields {
  progress: number | null;
  status: string | null;
  score: number | null;
  startedAt: FuzzyDate | null;
  completedAt: FuzzyDate | null;
  media: MediaFields | null;
}

const LIST_ENTRY_FIELDS = `
  progress
  status
  score
  startedAt { year month day }
  completedAt { year month day }
  media { ${MEDIA_FIELDS} }
`;

function entryFrom(entry: ListEntryFields, media: MediaFields): AniListEntry {
  return {
    remoteId: String(media.id),
    title: titleOf(media),
    coverUrl: coverOf(media),
    totalChapters: media.chapters ?? 0,
    trackingUrl: trackingUrlOf(media),
    lastChapterRead: entry.progress ?? 0,
    status: statusToNumber(entry.status),
    // `score` comes back in the account's own scoreFormat, which is why that
    // format is cached alongside the credentials rather than assumed here.
    score: entry.score ?? 0,
    startDate: fuzzyDateToMs(entry.startedAt),
    finishDate: fuzzyDateToMs(entry.completedAt),
    mangaStatus: mangaStatusFrom(media.status),
  };
}

/** A title AniList knows but the account has never listed. */
function unlistedEntryFrom(media: MediaFields): AniListEntry {
  return entryFrom(
    { progress: 0, status: null, score: 0, startedAt: null, completedAt: null, media },
    media,
  );
}

// ----------------------------------------------------------------- calls --

/** Who the token belongs to. Also the cheapest way to check a token is live. */
export async function viewer(token: string): Promise<AniListViewer> {
  const data = await request<{
    Viewer: {
      id: number;
      name: string;
      avatar: { large: string | null } | null;
      mediaListOptions: { scoreFormat: string | null } | null;
    } | null;
  }>(
    token,
    `query {
      Viewer {
        id
        name
        avatar { large }
        mediaListOptions { scoreFormat }
      }
    }`,
    {},
  );

  const found = data.Viewer;
  if (!found) throw new AniListError('AniList did not return an account for this token.');
  return {
    id: String(found.id),
    name: found.name,
    avatarUrl: found.avatar?.large ?? null,
    scoreFormat: found.mediaListOptions?.scoreFormat ?? null,
  };
}

/** Title search, for the "which series is this?" list on the detail page. */
export async function search(token: string, query: string): Promise<AniListSearch[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const data = await request<{ Page: { media: MediaFields[] | null } | null }>(
    token,
    `query ($query: String!) {
      Page(page: 1, perPage: 25) {
        media(type: MANGA, search: $query) { ${MEDIA_FIELDS} }
      }
    }`,
    { query: trimmed },
  );

  return (data.Page?.media ?? []).map(searchFrom);
}

/** One title by AniList id, without any of the account's own list state. */
export async function mediaById(token: string, mediaId: string): Promise<AniListSearch | null> {
  const id = Number(mediaId);
  if (!Number.isFinite(id)) return null;

  const data = await request<{ Media: MediaFields | null }>(
    token,
    `query ($id: Int!) { Media(id: $id, type: MANGA) { ${MEDIA_FIELDS} } }`,
    { id },
  );
  return data.Media ? searchFrom(data.Media) : null;
}

/**
 * One list entry, media included — what `bindTrack` and `fetchTrack` need.
 *
 * A title the account has never added is not an error worth propagating: it is
 * the normal state of a series the reader is only now binding, so the media is
 * fetched instead and returned with zero progress.
 */
export async function findListEntry(
  token: string,
  userId: string,
  mediaId: string,
): Promise<AniListEntry | null> {
  const id = Number(mediaId);
  const user = Number(userId);
  if (!Number.isFinite(id)) return null;

  if (Number.isFinite(user)) {
    try {
      const data = await request<{ MediaList: ListEntryFields | null }>(
        token,
        `query ($userId: Int!, $mediaId: Int!) {
          MediaList(userId: $userId, mediaId: $mediaId, type: MANGA) { ${LIST_ENTRY_FIELDS} }
        }`,
        { userId: user, mediaId: id },
      );
      const entry = data.MediaList;
      if (entry?.media) return entryFrom(entry, entry.media);
    } catch (error) {
      // AniList answers "Not Found" as a GraphQL error rather than a null, so
      // this is the ordinary not-on-the-list path, not a failure.
      if (!(error instanceof AniListError)) throw error;
    }
  }

  const data = await request<{ Media: MediaFields | null }>(
    token,
    `query ($id: Int!) { Media(id: $id, type: MANGA) { ${MEDIA_FIELDS} } }`,
    { id },
  );
  return data.Media ? unlistedEntryFrom(data.Media) : null;
}

/**
 * Every manga on the account, in one request.
 *
 * `MediaListCollection` is not paginated — it returns the whole collection cut
 * into lists (Reading, Completed, and any custom lists the account defines).
 * Custom lists repeat entries that are already on a status list, so the media
 * id decides: first occurrence wins and the rest are dropped.
 */
export async function userMangaList(token: string, userId: string): Promise<AniListEntry[]> {
  const user = Number(userId);
  if (!Number.isFinite(user)) return [];

  const data = await request<{
    MediaListCollection: { lists: Array<{ entries: ListEntryFields[] | null }> | null } | null;
  }>(
    token,
    `query ($userId: Int!) {
      MediaListCollection(userId: $userId, type: MANGA) {
        lists { entries { ${LIST_ENTRY_FIELDS} } }
      }
    }`,
    { userId: user },
  );

  const seen = new Set<string>();
  const entries: AniListEntry[] = [];
  for (const list of data.MediaListCollection?.lists ?? []) {
    for (const entry of list.entries ?? []) {
      if (!entry.media) continue;
      const mapped = entryFrom(entry, entry.media);
      if (seen.has(mapped.remoteId)) continue;
      seen.add(mapped.remoteId);
      entries.push(mapped);
    }
  }
  return entries;
}

/**
 * Push progress up. `status` is sent only when given, so a plain progress
 * report cannot silently move a title off the shelf the reader filed it on.
 */
export async function updateProgress(
  token: string,
  mediaId: string,
  progress: number,
  status?: number,
): Promise<void> {
  const id = Number(mediaId);
  if (!Number.isFinite(id)) throw new AniListError(`Not an AniList id: ${mediaId}`);

  const remoteStatus = status === undefined ? null : statusFromNumber(status);
  await request(
    token,
    `mutation ($mediaId: Int!, $progress: Int!, $status: MediaListStatus) {
      SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status) {
        id
      }
    }`,
    // Progress is a whole chapter count on AniList; a decimal chapter number
    // (12.5) rounds down to the last chapter actually finished.
    { mediaId: id, progress: Math.max(0, Math.floor(progress)), status: remoteStatus },
  );
}

/**
 * Remove the title from the account's list entirely.
 *
 * Only reached through `unbindTrack(deleteRemoteTrack: true)`, which the UI
 * never sends. `DeleteMediaListEntry` takes the *list entry* id rather than the
 * media id, so it costs a lookup first; a title that is not on the list is
 * already in the requested state and reports false rather than failing.
 */
export async function deleteListEntry(
  token: string,
  userId: string,
  mediaId: string,
): Promise<boolean> {
  const user = Number(userId);
  const id = Number(mediaId);
  if (!Number.isFinite(user) || !Number.isFinite(id)) return false;

  let entryId: number | null = null;
  try {
    const data = await request<{ MediaList: { id: number } | null }>(
      token,
      `query ($userId: Int!, $mediaId: Int!) {
        MediaList(userId: $userId, mediaId: $mediaId, type: MANGA) { id }
      }`,
      { userId: user, mediaId: id },
    );
    entryId = data.MediaList?.id ?? null;
  } catch (error) {
    // "Not Found" arrives as a GraphQL error, not a null.
    if (!(error instanceof AniListError)) throw error;
  }
  if (entryId === null) return false;

  await request(
    token,
    'mutation ($id: Int!) { DeleteMediaListEntry(id: $id) { deleted } }',
    { id: entryId },
  );
  return true;
}
