import { t } from './i18n'

export const ANILIST_TRACKER_ID = 2

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
