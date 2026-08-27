/**
 * Searches worth keeping: a source and a query, saved once and re-run for you.
 *
 * Held in **global meta** rather than `localStorage`, for the reason the AniList sync stamp is
 * ([[tracking.ts]]): a search saved on the desktop is one you want on the phone. It also means the
 * list is in every backup — `includeClientData` covers global meta, and a browser-only list is in no
 * backup at all.
 */

export const SAVED_SEARCHES_META_KEY = 'stremio4manga.saved-searches'

/** Enough for a reading habit, few enough that the feed does not spend a minute asking sources. */
export const SAVED_SEARCH_LIMIT = 12

export interface SavedSearch {
  /** `${sourceId}:${query}` — the identity of the search, so saving the same one twice is one entry. */
  key: string
  sourceId: string
  /** Kept alongside the id so a shelf can name its source before the source list has loaded. */
  sourceName: string
  query: string
  savedAt: number
}

export const SAVED_SEARCHES_QUERY = `
  query SavedSearches {
    metas(condition: { key: "${SAVED_SEARCHES_META_KEY}" }) {
      nodes { key value }
    }
  }
`

export const SET_SAVED_SEARCHES_MUTATION = `
  mutation SetSavedSearches($value: String!) {
    setGlobalMeta(input: { meta: { key: "${SAVED_SEARCHES_META_KEY}", value: $value } }) {
      meta { key value }
    }
  }
`

export function searchKey(sourceId: string, query: string): string {
  return `${sourceId}:${query.trim().toLowerCase()}`
}

/**
 * The list as stored, newest first.
 *
 * Anything unreadable is treated as an empty list rather than as an error: this is a convenience, and a
 * meta value someone has edited by hand must not be able to stop Discover from loading.
 */
export function savedSearchesFromMeta(nodes: Array<{ key: string; value: string }> | undefined): SavedSearch[] {
  const value = nodes?.find((node) => node.key === SAVED_SEARCHES_META_KEY)?.value
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is SavedSearch =>
        Boolean(entry)
        && typeof (entry as SavedSearch).sourceId === 'string'
        && typeof (entry as SavedSearch).query === 'string'
        && (entry as SavedSearch).query.trim().length > 0)
      .map((entry) => ({
        key: entry.key || searchKey(entry.sourceId, entry.query),
        sourceId: entry.sourceId,
        sourceName: entry.sourceName || entry.sourceId,
        query: entry.query,
        savedAt: Number.isFinite(entry.savedAt) ? entry.savedAt : 0,
      }))
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(0, SAVED_SEARCH_LIMIT)
  } catch {
    return []
  }
}

export function withSearchSaved(current: SavedSearch[], entry: Omit<SavedSearch, 'key' | 'savedAt'>): SavedSearch[] {
  const key = searchKey(entry.sourceId, entry.query)
  const saved: SavedSearch = { ...entry, query: entry.query.trim(), key, savedAt: Date.now() }
  return [saved, ...current.filter((item) => item.key !== key)].slice(0, SAVED_SEARCH_LIMIT)
}

export function withSearchRemoved(current: SavedSearch[], key: string): SavedSearch[] {
  return current.filter((item) => item.key !== key)
}
