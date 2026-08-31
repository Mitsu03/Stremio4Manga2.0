/**
 * Which source manga a library entry is read from.
 *
 * The choice is persisted server-side in the entry's meta, so it follows the reader across
 * browsers; the localStorage helpers below are the older, browser-only store, kept as a fallback
 * for bindings made before the meta existed. Both the detail page (one title at a time) and the
 * library (a whole selection at once) write it, so the document and the key live here.
 */
export const SOURCE_BINDING_META_KEY = 'stremio4manga.source-binding'

export const SET_SOURCE_BINDING_MUTATION = `
  mutation SetSourceBinding($mangaId: Int!, $boundMangaId: String!) {
    setMangaMeta(input: { meta: { mangaId: $mangaId, key: "${SOURCE_BINDING_META_KEY}", value: $boundMangaId } }) {
      meta { key value mangaId }
    }
  }
`

// Removing the meta is how a title goes back to reading its own catalogue: there is no "bound to
// myself" state, and writing the entry's own id as its binding would make one.
export const DELETE_SOURCE_BINDING_MUTATION = `
  mutation DeleteSourceBinding($mangaId: Int!) {
    deleteMangaMeta(input: { mangaId: $mangaId, key: "${SOURCE_BINDING_META_KEY}" }) {
      meta { key }
    }
  }
`

/** The bound source in a manga's meta, or null when the entry reads from its own catalogue. */
export function sourceBindingFromMeta(meta: Array<{ key: string; value: string }>): number | null {
  const value = meta.find((entry) => entry.key === SOURCE_BINDING_META_KEY)?.value
  const mangaId = Number(value)
  return Number.isInteger(mangaId) && mangaId > 0 ? mangaId : null
}

/**
 * A line the reader writes to themselves about a title.
 *
 * On the manga the *page* is showing, which is the library entry when the page was opened from the
 * library - deliberately not the rule tracking follows, where a TrackRecord lives on the bound
 * source manga. A note is the reader's rather than the catalogue's, so rebinding a title to another
 * source must not orphan what they wrote about it.
 */
export const MANGA_NOTE_META_KEY = 'stremio4manga.note'

export const SET_MANGA_NOTE_MUTATION = `
  mutation SetMangaNote($mangaId: Int!, $value: String!) {
    setMangaMeta(input: { meta: { mangaId: $mangaId, key: "${MANGA_NOTE_META_KEY}", value: $value } }) {
      meta { key value mangaId }
    }
  }
`

// Clearing a note deletes the row, the same rule the binding above follows: there is no empty-note
// state worth telling apart from an absent one, and inventing one would leave a key behind on every
// title the reader ever thought about annotating.
export const DELETE_MANGA_NOTE_MUTATION = `
  mutation DeleteMangaNote($mangaId: Int!) {
    deleteMangaMeta(input: { mangaId: $mangaId, key: "${MANGA_NOTE_META_KEY}" }) {
      meta { key }
    }
  }
`

/** The note in a manga's meta, or null when there is none. Whitespace alone counts as none. */
export function noteFromMeta(meta: Array<{ key: string; value: string }>): string | null {
  const value = meta.find((entry) => entry.key === MANGA_NOTE_META_KEY)?.value
  return value !== undefined && value.trim() !== '' ? value : null
}

export type ChapterFilter = 'all' | 'unread' | 'read' | 'bookmarked'
export type ChapterOrder = 'asc' | 'desc'

/** Anything the stored view does not recognise means "show everything" rather than nothing. */
function storedFilter(value: unknown): ChapterFilter {
  return value === 'unread' || value === 'read' || value === 'bookmarked' ? value : 'all'
}

/**
 * How one title's chapter list is shown: which scanlation, which chapters, which way up.
 *
 * All three in one meta key, because they are one answer to one question and a reader who sets them
 * on the desktop means them on the phone. `scanlator` is null when no choice has been made and empty
 * when the choice was "all of them" — the two are different, and collapsing them would make the
 * picker forget an explicit "show me everything" every time the list changed.
 */
export const CHAPTER_VIEW_META_KEY = 'stremio4manga.chapter-view'

export interface ChapterView {
  scanlator: string | null
  filter: ChapterFilter
  order: ChapterOrder
}

export const DEFAULT_CHAPTER_VIEW: ChapterView = { scanlator: null, filter: 'all', order: 'asc' }

export const SET_CHAPTER_VIEW_MUTATION = `
  mutation SetChapterView($mangaId: Int!, $value: String!) {
    setMangaMeta(input: { meta: { mangaId: $mangaId, key: "${CHAPTER_VIEW_META_KEY}", value: $value } }) {
      meta { key value mangaId }
    }
  }
`

export function chapterViewFromMeta(meta: Array<{ key: string; value: string }>): ChapterView | null {
  const raw = meta.find((entry) => entry.key === CHAPTER_VIEW_META_KEY)?.value
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ChapterView>
    return {
      scanlator: typeof parsed.scanlator === 'string' ? parsed.scanlator : null,
      filter: storedFilter(parsed.filter),
      order: parsed.order === 'desc' ? 'desc' : 'asc',
    }
  } catch {
    return null
  }
}

// The browser-only stores these three used to live in. Nothing writes them any more; they are read
// once per title, the first time it is opened without a chapter view in its meta, and what they had
// to say is written to the server there — see MangaDetailPage. Migrating the whole map up front would
// be one mutation per manga in the library, for settings most of which will never be looked at again.
const BINDING_KEY = 'stremio4manga:source-binding'
const SCANLATOR_KEY = 'stremio4manga:scanlator'
const CHAPTER_PREFERENCES_KEY = 'stremio4manga:chapter-preferences'

function readAll<T>(key: string): Record<string, T> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}')
    return typeof parsed === 'object' && parsed ? parsed : {}
  } catch {
    return {}
  }
}

function write<T>(key: string, all: Record<string, T>): void {
  localStorage.setItem(key, JSON.stringify(all))
}

export function getSourceBinding(mangaId: number): number | null {
  const value = readAll<number>(BINDING_KEY)[String(mangaId)]
  return typeof value === 'number' ? value : null
}

export function setSourceBinding(mangaId: number, boundMangaId: number): void {
  const all = readAll<number>(BINDING_KEY)
  all[String(mangaId)] = boundMangaId
  write(BINDING_KEY, all)
}

export function clearSourceBinding(mangaId: number): void {
  const all = readAll<number>(BINDING_KEY)
  delete all[String(mangaId)]
  write(BINDING_KEY, all)
}

/** What this browser used to hold for a title, for the one read that carries it up to the server. */
export function legacyChapterView(mangaId: number): ChapterView | null {
  const scanlator = readAll<string>(SCANLATOR_KEY)[String(mangaId)]
  const preferences = readAll<Partial<ChapterView>>(CHAPTER_PREFERENCES_KEY)[String(mangaId)]
  if (typeof scanlator !== 'string' && !preferences) return null
  return {
    scanlator: typeof scanlator === 'string' ? scanlator : null,
    filter: preferences?.filter === 'read' || preferences?.filter === 'unread' ? preferences.filter : 'all',
    order: preferences?.order === 'desc' ? 'desc' : 'asc',
  }
}
