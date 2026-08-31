/**
 * The MyAnimeList API, and nothing else.
 *
 * Like `anilist.ts`, this module talks HTTP and knows MyAnimeList's vocabulary;
 * it never touches the database and never sees a user id. `index.ts` adapts it
 * into the `Tracker` shape the rest of the server works in.
 *
 * ## The handshake is not AniList's
 *
 * AniList uses implicit grant: the token arrives in the URL fragment and there
 * is nothing to exchange. MyAnimeList uses authorization code with PKCE, and
 * three things follow from that.
 *
 * **A verifier has to survive a navigation.** The browser leaves this app for
 * myanimelist.net and comes back to a fresh page, so the verifier is generated
 * and held by the client (`web/src/utils/oauth.ts`) and handed back with the
 * callback. MyAnimeList supports only `code_challenge_method=plain`, so the
 * challenge *is* the verifier — which is why the client can put it on the auth
 * URL itself without hashing anything.
 *
 * **The exchange carries a secret**, so it happens here rather than in the
 * browser. Both halves are deployment configuration:
 *
 *     S4M_MYANIMELIST_CLIENT_ID=...
 *     S4M_MYANIMELIST_CLIENT_SECRET=...
 *
 * There is no default id, unlike AniList's. A MyAnimeList app carries one
 * registered redirect URL, so an id shipped in the source could only ever work
 * for the single origin it was registered against; `authUrl()` returns null
 * when either variable is missing, which the Settings page already draws as a
 * tracker that cannot be connected yet.
 *
 * **`redirect_uri` is sent rather than registered-and-implied.** It has to be
 * byte-identical on the authorize request and on the exchange, so both take it
 * from the same place: the server's own `publicOrigin`.
 *
 * ## Statuses
 *
 * MyAnimeList has five where we have six: there is no "rereading" status, only
 * an `is_rereading` flag on the reading one. Sending our 6 therefore sends
 * `reading` with the flag set, and reading it back gives 6 again — the shelf
 * survives the round trip even though the vocabularies do not match.
 */

const API_URL = 'https://api.myanimelist.net/v2';
const AUTHORIZE_URL = 'https://myanimelist.net/v1/oauth2/authorize';
const TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';

/** The id Tachiyomi handed MyAnimeList, kept because backups carry it. */
export const MYANIMELIST_TRACKER_ID = 1;

export const MYANIMELIST_ICON = 'https://cdn.myanimelist.net/img/sp/icon/apple-touch-icon-256.png';

/** MyAnimeList answers a shorter query with a 400 rather than an empty page. */
const MIN_QUERY_LENGTH = 3;

/** Used only when the token response omits `expires_in`, which it should not. */
const DEFAULT_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

const MEDIA_FIELDS = 'id,title,main_picture,synopsis,num_chapters,status,media_type';
const LIST_FIELDS = `${MEDIA_FIELDS},my_list_status{status,score,num_chapters_read,is_rereading,start_date,finish_date}`;

export class MyAnimeListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MyAnimeListError';
  }
}

// ------------------------------------------------------------ credentials --

function trimmedEnv(name: string): string | null {
  const value = (process.env[name] ?? '').trim();
  return value === '' ? null : value;
}

export function clientId(): string | null {
  return trimmedEnv('S4M_MYANIMELIST_CLIENT_ID');
}

export function clientSecret(): string | null {
  return trimmedEnv('S4M_MYANIMELIST_CLIENT_SECRET');
}

/**
 * Where to send the browser. `code_challenge` is deliberately absent: only the
 * client can hold the verifier across the navigation, so it appends both the
 * challenge and its own `state`, exactly as it already does for AniList.
 */
export function authUrl(redirectUri: string): string | null {
  const id = clientId();
  if (!id || !clientSecret()) return null;

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', id);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge_method', 'plain');
  return url.toString();
}

/**
 * Trade the code for a token.
 *
 * Null rather than a throw when the callback carries no code at all: that is a
 * callback meant for somebody else, not a failed exchange. A code that is
 * present and rejected does throw, because the reader pressed Connect and is
 * owed the reason.
 */
export async function exchangeCode(
  callbackUrl: string,
  codeVerifier: string | null,
  redirectUri: string,
): Promise<{ token: string; expiresAt: number } | null> {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return null;
  }

  const code = url.searchParams.get('code');
  if (!code) return null;

  const id = clientId();
  const secret = clientSecret();
  if (!id || !secret) {
    throw new MyAnimeListError('This server has no MyAnimeList client id and secret configured.');
  }
  if (!codeVerifier) {
    throw new MyAnimeListError('The MyAnimeList callback arrived without its PKCE verifier.');
  }

  const body = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new MyAnimeListError(`MyAnimeList refused the token exchange (${response.status}).`);
  }

  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!payload.access_token) {
    throw new MyAnimeListError('MyAnimeList returned no access token.');
  }

  const lifetime =
    typeof payload.expires_in === 'number' && payload.expires_in > 0
      ? payload.expires_in * 1000
      : DEFAULT_TOKEN_LIFETIME_MS;
  return { token: payload.access_token, expiresAt: Date.now() + lifetime };
}

// --------------------------------------------------------------- statuses --

/**
 * Our numbers are AniList's, and MyAnimeList has one fewer. 6 (rereading) is
 * `reading` with `is_rereading` set, which is the only shape it has for it.
 */
const STATUS_TO_REMOTE: Record<number, string> = {
  1: 'reading',
  2: 'completed',
  3: 'on_hold',
  4: 'dropped',
  5: 'plan_to_read',
  6: 'reading',
};

const REMOTE_TO_STATUS: Record<string, number> = {
  reading: 1,
  completed: 2,
  on_hold: 3,
  dropped: 4,
  plan_to_read: 5,
};

/** `reading` → 1. Unknown names become 0, which the UI shows as no shelf. */
export function statusToNumber(status: string | null | undefined): number {
  if (!status) return 0;
  return REMOTE_TO_STATUS[status] ?? 0;
}

/** 1 → `reading`. Returns null for 0, so "unset" stays unset remotely. */
export function statusFromNumber(status: number): string | null {
  return STATUS_TO_REMOTE[status] ?? null;
}

/** MyAnimeList's publication status in the MangaStatus enum the schema declares. */
function mangaStatusFrom(status: string | null | undefined): string {
  switch (status) {
    case 'currently_publishing':
      return 'ONGOING';
    case 'finished':
      return 'PUBLISHING_FINISHED';
    case 'discontinued':
      return 'CANCELLED';
    case 'on_hiatus':
      return 'ON_HIATUS';
    case 'not_yet_published':
      return 'ONGOING';
    default:
      return 'UNKNOWN';
  }
}

/** `light_novel` → `LIGHT_NOVEL`; the schema takes a free string here. */
function publishingTypeFrom(mediaType: string | null | undefined): string {
  return mediaType ? mediaType.toUpperCase() : 'MANGA';
}

/** MyAnimeList dates are `YYYY-MM-DD`; anything else is "no date", which is 0. */
function epochFrom(date: string | null | undefined): number {
  if (!date) return 0;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ------------------------------------------------------------------ calls --

interface MangaNode {
  id: number;
  title: string;
  main_picture?: { medium?: string; large?: string } | null;
  synopsis?: string | null;
  num_chapters?: number | null;
  status?: string | null;
  media_type?: string | null;
  my_list_status?: {
    status?: string | null;
    score?: number | null;
    num_chapters_read?: number | null;
    is_rereading?: boolean | null;
    start_date?: string | null;
    finish_date?: string | null;
  } | null;
}

async function request<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new MyAnimeListError(`MyAnimeList answered ${response.status} for ${path}.`);
  }
  return (await response.json()) as T;
}

/** 404 is left to the caller: for a list entry it means "already not there". */
async function write(
  token: string,
  path: string,
  method: string,
  body?: URLSearchParams,
): Promise<Response> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body?.toString(),
  });
  if (!response.ok && response.status !== 404) {
    throw new MyAnimeListError(`MyAnimeList answered ${response.status} for ${path}.`);
  }
  return response;
}

function coverOf(node: MangaNode): string {
  return node.main_picture?.large ?? node.main_picture?.medium ?? '';
}

function trackingUrl(id: number | string): string {
  return `https://myanimelist.net/manga/${id}`;
}

function searchFrom(node: MangaNode) {
  return {
    remoteId: String(node.id),
    title: node.title,
    coverUrl: coverOf(node),
    publishingStatus: mangaStatusFrom(node.status),
    publishingType: publishingTypeFrom(node.media_type),
    totalChapters: node.num_chapters ?? 0,
    trackingUrl: trackingUrl(node.id),
    summary: node.synopsis ?? '',
  };
}

function entryFrom(node: MangaNode) {
  const listStatus = node.my_list_status ?? null;
  const remoteStatus = statusToNumber(listStatus?.status);
  return {
    remoteId: String(node.id),
    title: node.title,
    coverUrl: coverOf(node),
    totalChapters: node.num_chapters ?? 0,
    trackingUrl: trackingUrl(node.id),
    lastChapterRead: listStatus?.num_chapters_read ?? 0,
    // Rereading is a flag here and a status for us; reading plus the flag is 6.
    status: remoteStatus === 1 && listStatus?.is_rereading === true ? 6 : remoteStatus,
    score: listStatus?.score ?? 0,
    startDate: epochFrom(listStatus?.start_date),
    finishDate: epochFrom(listStatus?.finish_date),
    mangaStatus: mangaStatusFrom(node.status),
  };
}

/** Who the token belongs to. Also the cheapest way to check a token is live. */
export async function viewer(token: string) {
  const me = await request<{ id: number; name: string; picture?: string | null }>(
    token,
    '/users/@me?fields=id,name,picture',
  );
  return {
    id: String(me.id),
    name: me.name,
    avatarUrl: me.picture ?? null,
    // MyAnimeList scores manga out of ten and offers no other format.
    scoreFormat: 'POINT_10',
  };
}

/** Title search, for the "which series is this?" list on the detail page. */
export async function search(token: string, query: string) {
  const trimmed = query.trim();
  // Two characters is a 400, not an empty page, so it is answered here as the
  // empty result the caller is really asking for.
  if (trimmed.length < MIN_QUERY_LENGTH) return [];

  const data = await request<{ data?: Array<{ node: MangaNode }> }>(
    token,
    `/manga?q=${encodeURIComponent(trimmed)}&limit=25&fields=${encodeURIComponent(MEDIA_FIELDS)}`,
  );
  return (data.data ?? []).map((item) => searchFrom(item.node));
}

/** One title by MyAnimeList id, without any of the account's own list state. */
export async function mediaById(token: string, remoteId: string) {
  const id = Number(remoteId);
  if (!Number.isFinite(id)) return null;
  try {
    const node = await request<MangaNode>(
      token,
      `/manga/${id}?fields=${encodeURIComponent(MEDIA_FIELDS)}`,
    );
    return searchFrom(node);
  } catch (error) {
    if (error instanceof MyAnimeListError) return null;
    throw error;
  }
}

/**
 * One list entry, media included.
 *
 * `_remoteUser` is unused and stays in the signature because the interface
 * declares it: MyAnimeList answers `my_list_status` for whoever the token
 * belongs to, so there is no user id to pass. AniList needs one.
 *
 * A title the account has never added comes back without `my_list_status`,
 * which `entryFrom` already reads as zero progress — the normal state of a
 * series the reader is only now binding, not an error.
 */
export async function findListEntry(token: string, _remoteUser: string, remoteId: string) {
  const id = Number(remoteId);
  if (!Number.isFinite(id)) return null;
  try {
    const node = await request<MangaNode>(
      token,
      `/manga/${id}?fields=${encodeURIComponent(LIST_FIELDS)}`,
    );
    return entryFrom(node);
  } catch (error) {
    if (error instanceof MyAnimeListError) return null;
    throw error;
  }
}

/**
 * Push progress up. `status` is sent only when given, so a plain progress
 * report cannot silently move a title off the shelf the reader filed it on —
 * and `is_rereading` moves only alongside a status, for the same reason.
 */
export async function updateProgress(
  token: string,
  remoteId: string,
  progress: number,
  status?: number,
): Promise<void> {
  const id = Number(remoteId);
  if (!Number.isFinite(id)) throw new MyAnimeListError(`Not a MyAnimeList id: ${remoteId}`);

  const body = new URLSearchParams({
    // Progress is a whole chapter count; a decimal chapter number (12.5) rounds
    // down to the last chapter actually finished.
    num_chapters_read: String(Math.max(0, Math.floor(progress))),
  });
  if (status !== undefined) {
    const remote = statusFromNumber(status);
    if (remote) {
      body.set('status', remote);
      body.set('is_rereading', status === 6 ? 'true' : 'false');
    }
  }

  await write(token, `/manga/${id}/my_list_status`, 'PATCH', body);
}

/**
 * Remove the title from the account's list entirely.
 *
 * Only reached through `unbindTrack(deleteRemoteTrack: true)`, which the UI
 * never sends. A 404 means the title was not on the list, which is already the
 * requested state, so it reports false rather than failing.
 */
export async function deleteListEntry(
  token: string,
  _remoteUser: string,
  remoteId: string,
): Promise<boolean> {
  const id = Number(remoteId);
  if (!Number.isFinite(id)) return false;
  const response = await write(token, `/manga/${id}/my_list_status`, 'DELETE');
  return response.ok;
}
