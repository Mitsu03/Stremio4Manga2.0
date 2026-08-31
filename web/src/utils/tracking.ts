import { t } from './i18n'

export const ANILIST_TRACKER_ID = 2
export const MYANIMELIST_TRACKER_ID = 1

/**
 * The order two links are compared in when nothing else separates them. It is the registry's own
 * order on the server, repeated here because the client has to break ties the same way twice in a
 * row — a helper that answered by array order would give a title one identity on the library page
 * and another on the statistics page, from the same data.
 */
const TRACKER_PREFERENCE = [ANILIST_TRACKER_ID, MYANIMELIST_TRACKER_ID]

/**
 * A tracker's name without asking the server for it. The name on `TrackerType` is the one to use
 * wherever a query is already in flight; this is for the places that have a record and no tracker —
 * the reader's "open on ..." link, which would otherwise fetch a whole tracker to render a word.
 */
export const TRACKER_NAMES: Record<number, string> = {
  [ANILIST_TRACKER_ID]: 'AniList',
  [MYANIMELIST_TRACKER_ID]: 'MyAnimeList',
}

function preferenceOf(trackerId: number): number {
  const index = TRACKER_PREFERENCE.indexOf(trackerId)
  return index === -1 ? TRACKER_PREFERENCE.length : index
}

interface Linked {
  trackerId: number
  lastChapterRead: number
}

/**
 * Which of a title's links is *the* progress, now that there can be more than one.
 *
 * Whichever tracker is furthest ahead. A reader who marks a chapter read here has it pushed to
 * every link, so the links agree in the ordinary case and this only decides after progress arrived
 * somewhere else — where "furthest ahead" is the answer that never walks a shelf backwards. Ties go
 * to `TRACKER_PREFERENCE`, so the answer does not depend on the order the server returned the rows.
 */
export function primaryRecord<T extends Linked>(records: readonly T[]): T | undefined {
  let best: T | undefined
  for (const record of records) {
    if (
      !best ||
      record.lastChapterRead > best.lastChapterRead ||
      (record.lastChapterRead === best.lastChapterRead &&
        preferenceOf(record.trackerId) < preferenceOf(best.trackerId))
    ) {
      best = record
    }
  }
  return best
}

/**
 * A stable key for "the same series", across the two library rows a series usually has.
 *
 * A remote id is only unique inside its own tracker — AniList 87443 and MyAnimeList 87443 are
 * different series — so the tracker id is part of the key. The link chosen is the first one in
 * `TRACKER_PREFERENCE` the row actually has, *not* the furthest ahead: identity has to be the same
 * answer for two rows whose progress differs, which is the whole reason it is being computed.
 */
export function trackIdentity(
  records: ReadonlyArray<{ trackerId: number; remoteId?: string }>,
): string | undefined {
  const ranked = [...records].sort((a, b) => preferenceOf(a.trackerId) - preferenceOf(b.trackerId))
  const found = ranked.find((record) => record.remoteId)
  return found?.remoteId ? `${found.trackerId}:${found.remoteId}` : undefined
}

/** The same key for one link rather than for a title — for counting distinct remote entries. */
export function trackKey(record: { trackerId: number; remoteId: string }): string {
  return `${record.trackerId}:${record.remoteId}`
}

/** AniList's list statuses, under the names the library shelves use. */
export const statusNames: Record<number, string> = {
  1: 'Reading',
  2: 'Completed',
  3: 'On Hold',
  4: 'Dropped',
  5: 'Planning',
  6: 'Rereading',
}

// When the library last pulled everyone's progress down from AniList. Kept in global meta rather
// than localStorage so the answer is the same on every browser that talks to this server — a sync
// run on the desktop is a sync as far as the phone is concerned.
export const LAST_SYNC_META_KEY = 'stremio4manga.anilist-last-sync'

export const LAST_SYNC_QUERY = `
  query LastAniListSync {
    metas(condition: { key: "${LAST_SYNC_META_KEY}" }) {
      nodes { key value }
    }
  }
`

export const SET_LAST_SYNC_MUTATION = `
  mutation SetLastAniListSync($stamp: String!) {
    setGlobalMeta(input: { meta: { key: "${LAST_SYNC_META_KEY}", value: $stamp } }) {
      meta { key value }
    }
  }
`

export function lastSyncFromMeta(nodes: Array<{ key: string; value: string }> | undefined): number | null {
  const value = Number(nodes?.find((node) => node.key === LAST_SYNC_META_KEY)?.value)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * "8 min ago" — coarse on purpose. The exact second a sync ran is never the question; whether it was
 * minutes or days ago is.
 */
export function formatSince(stamp: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - stamp) / 1000))
  if (seconds < 90) return t('just now')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('{count} min ago', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('{count} h ago', { count: hours })
  const days = Math.round(hours / 24)
  return t(days === 1 ? '{count} day ago' : '{count} days ago', { count: days })
}
