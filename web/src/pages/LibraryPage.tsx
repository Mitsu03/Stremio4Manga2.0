import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from 'urql'
import { Link } from 'react-router-dom'
import { friendlyError } from '../utils/errors'
import { t } from '../utils/i18n'
import { CATEGORIES_QUERY, FILE_MANGAS_MUTATION, sortedCategories } from '../utils/categories'
import type { CategoriesResult } from '../utils/categories'
import {
  clearSourceBinding,
  getSourceBinding,
  setSourceBinding,
  sourceBindingFromMeta,
  DELETE_SOURCE_BINDING_MUTATION,
  SET_SOURCE_BINDING_MUTATION,
} from '../utils/bindings'
import { chapterTotalLabel, formatChapterNumber, formatUploadDate, hasFinishedPublishing } from '../utils/progress'
import { relevantTitleMatches, sortByTitleSimilarity } from '../utils/titleMatch'
import {
  browsableSources,
  FETCH_SOURCE_MANGA_BULK_MUTATION,
  preferredSourcePerName,
  prioritizedSources,
  SOURCES_QUERY,
} from '../utils/sources'
import type { FetchSourceMangaBulkResult, SourceMangaNode, SourceNode } from '../utils/sources'
import { ANILIST_TRACKER_ID, SET_LAST_SYNC_MUTATION, statusNames } from '../utils/tracking'
import { choice, preference, structured } from '../utils/settings'

const LIBRARY_QUERY = `
  query Library {
    mangas(condition: { inLibrary: true }) {
      nodes {
        id
        title
        author
        genre
        thumbnailUrl
        status
        inLibraryAt
        source { id name iconUrl }
        chapters { totalCount }
        meta {
          key
          value
        }
        categories { nodes { id } }
        trackRecords {
          nodes {
            id
            trackerId
            remoteId
            status
            lastChapterRead
            totalChapters
          }
        }
      }
    }
  }
`

// Chapters live on the bound source manga, not on the library entry, so once a title is bound we
// pull that manga's chapter numbers. We deliberately do NOT use the server's unreadCount or
// chapters.totalCount: both count rows, and a source that carries several scanlations of the same
// chapter inflates them badly (Frieren: 316 rows for 152 distinct chapter numbers). Counting
// distinct numbers instead keeps the unread badge and the progress chip telling the same story.
// isRead plus the source's own AniList progress reconcile read-through the way MangaDetailPage
// does; status decides whether the chip's denominator is provisional.
//
// lastReadAt rides along for the "last read" sort order: the reader stamps it on every chapter it
// opens, so the newest stamp across a source's chapters is when the series was last picked up.
const BOUND_UNREAD_QUERY = `
  query BoundUnread($ids: [Int!]!) {
    mangas(filter: { id: { in: $ids } }) {
      nodes {
        id
        status
        source { id name iconUrl }
        chapters { nodes { id chapterNumber isRead lastReadAt } }
        trackRecords { nodes { id trackerId lastChapterRead } }
      }
    }
  }
`

// The reader already stamps lastReadAt on every chapter it opens (it PATCHes lastPageRead, and
// `read=true` on the final page), so "what was I reading?" is answerable without any new server
// state — nothing in the UI had ever read the column back. Newest first, and over-fetched because
// several chapters of the same title collapse into a single card.
const RECENT_READS_QUERY = `
  query RecentReads($since: LongString!) {
    chapters(filter: { lastReadAt: { greaterThan: $since } }, order: [{ by: LAST_READ_AT, byType: DESC }], first: 60) {
      nodes {
        id
        name
        sourceOrder
        lastPageRead
        lastReadAt
        pageCount
        isRead
        mangaId
        manga { id title thumbnailUrl meta { key value } trackRecords { nodes { trackerId remoteId } } }
      }
    }
  }
`

// Once a chapter is finished the card should offer the next one, which means knowing the whole
// chapter list of those few titles. Read-through is reconciled against AniList exactly as the
// covers and MangaDetailPage do it, so a source whose chapters were never marked read locally does
// not send the user back to chapter 1. The same list gives the shelf's progress bar its
// denominator, and status says whether that denominator can still grow.
const RECENT_STATE_QUERY = `
  query RecentState($ids: [Int!]!) {
    mangas(filter: { id: { in: $ids } }) {
      nodes {
        id
        title
        status
        chapters { nodes { id name chapterNumber sourceOrder isRead } }
        trackRecords { nodes { trackerId remoteId lastChapterRead } }
      }
    }
  }
`

// Hiding a title from the shelf stores the moment it was hidden, not a boolean, so the card comes
// back on its own the next time a chapter is read — "not now" needs no second interaction, and
// there is no un-hide screen to go looking for. It lives in the manga's meta like the source
// binding, so the choice follows the reader across browsers instead of sitting in one localStorage.
const CONTINUE_HIDDEN_META_KEY = 'stremio4manga.continue-hidden'

const HIDE_FROM_CONTINUE_MUTATION = `
  mutation HideFromContinue($mangaId: Int!, $stamp: String!) {
    setMangaMeta(input: { meta: { mangaId: $mangaId, key: "${CONTINUE_HIDDEN_META_KEY}", value: $stamp } }) {
      meta { key value mangaId }
    }
  }
`

const UNHIDE_FROM_CONTINUE_MUTATION = `
  mutation UnhideFromContinue($mangaId: Int!) {
    deleteMangaMeta(input: { mangaId: $mangaId, key: "${CONTINUE_HIDDEN_META_KEY}" }) {
      meta { key }
    }
  }
`

// Asking a source whether it has published anything new is the same call the detail page makes when
// it opens a title (MangaDetailPage's FETCH_CHAPTERS_MUTATION); it returns the chapter list the
// source now reports, which is what lets the sweep below count what arrived without a second query.
//
// A migration needs the same list one step further on — which of the incoming source's chapters sit
// at or below the read-through being carried over — so the numbers and the read flags ride along
// and the rebind needs no follow-up query of its own.
//
// The name, the date, the scanlator and the reader's own index ride along too, so the sweep can name
// what it found instead of only counting it. Same request either way: this call already returns the
// source's whole chapter list, and the extra fields cost a wider selection, not a second round trip.
const FETCH_CHAPTERS_MUTATION = `
  mutation FetchChapters($mangaId: Int!) {
    fetchChapters(input: { mangaId: $mangaId }) {
      chapters { id name chapterNumber sourceOrder scanlator uploadDate isRead }
    }
  }
`

const FETCH_TRACK_MUTATION = `
  mutation FetchTrack($recordId: Int!) {
    fetchTrack(input: { recordId: $recordId }) {
      trackRecord { id lastChapterRead totalChapters }
    }
  }
`

const REMOVE_FROM_LIBRARY_MUTATION = `
  mutation RemoveFromLibrary($ids: [Int!]!) {
    updateMangas(input: { ids: $ids, patch: { inLibrary: false } }) { mangas { id inLibrary } }
  }
`

// Read state lives on the bound source's chapters, so catching a title up means patching those and
// not the library entry. Only isRead is patched, which leaves lastReadAt alone: catching up on a
// backlog should not push a dozen titles into the continue-reading shelf as if they were just read.
const MARK_CHAPTERS_READ_MUTATION = `
  mutation MarkChaptersRead($ids: [Int!]!) {
    updateChapters(input: { ids: $ids, patch: { isRead: true } }) { chapters { id isRead } }
  }
`

// The other direction, used by the AniList refresh to follow a rollback. Clearing isRead cannot
// push a lower number back to the tracker: the server only ever reports progress upwards
// (`if (chapterNumber > lastChapterRead)` in Track.trackChapterForTracker), so the remote is left
// exactly as AniList has it.
const UNMARK_CHAPTERS_READ_MUTATION = `
  mutation UnmarkChaptersRead($ids: [Int!]!) {
    updateChapters(input: { ids: $ids, patch: { isRead: false } }) { chapters { id isRead } }
  }
`

interface TrackRecord {
  id: number
  trackerId: number
  remoteId: string
  status: number
  lastChapterRead: number
  totalChapters: number
}

/**
 * The AniList id of a series, which is the only identity every row agrees on. Titles are not: the
 * same series indexed by two sources comes back as "Ms. Mystic" on one and "MISS MYSTIC" on the
 * other, and no amount of normalising makes those equal. Both rows carry AniList 87443.
 */
function anilistId(records: Array<{ trackerId: number; remoteId?: string }>): string | undefined {
  return records.find((record) => record.trackerId === ANILIST_TRACKER_ID)?.remoteId || undefined
}

interface LibrarySource { id: string; name: string; iconUrl: string | null }

interface LibraryManga {
  id: number
  title: string
  /** Whoever the source credits, which is the other name a title gets looked for by. */
  author: string | null
  /** The source's own tags, in the source's own words — never translated, only counted and matched. */
  genre: string[]
  thumbnailUrl: string | null
  status: string
  /** When the title was added, as the LongString epoch the schema returns — a string, not a number. */
  inLibraryAt: string
  source: LibrarySource | null
  chapters: { totalCount: number }
  meta: Array<{ key: string; value: string }>
  categories: { nodes: Array<{ id: number }> }
  trackRecords: { nodes: TrackRecord[] }
}

/** One shelf on the library page, whichever thing the shelves are currently made of. */
interface Shelf {
  key: string
  label: string
  items: LibraryManga[]
}

interface LibraryQueryResult {
  mangas: { nodes: LibraryManga[] }
}

const statusOrder = ['Reading', 'Rereading', 'Planning', 'On Hold', 'Dropped', 'Other'] as const
const COMPLETED_STATUS = 2
type ShelfStatus = typeof statusOrder[number]

function isShelfStatus(value: unknown): value is ShelfStatus {
  return typeof value === 'string' && statusOrder.some((status) => status === value)
}

type Grouping = 'status' | 'category'

// All four shelf settings live on the account rather than in this browser ([[settings.ts]]).
const GROUPING = choice<Grouping>('library.grouping', 'status', ['status', 'category'])

// The category shelves store what is **hidden**, not what is shown, unlike the status shelves above:
// their list grows, and a stored allow-list would leave every newly created category invisible until
// someone thought to click it.
const HIDDEN_SHELVES = structured<string[]>('library.category-hidden', [], (parsed) =>
  (Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : null))
type SortOrder = 'title' | 'added' | 'unread' | 'lastRead'
type SortDirection = 'asc' | 'desc'
interface LibrarySort { order: SortOrder; direction: SortDirection }

// Every order but title reads better with its largest value first — the newest addition, the biggest
// backlog, the series read most recently — so picking one starts it that way and a second press on
// the order already chosen is what flips it.
const SORT_ORDERS: Array<{ order: SortOrder; label: string; ends: Record<SortDirection, string>; natural: SortDirection }> = [
  { order: 'title', label: 'Title', ends: { asc: 'A–Z', desc: 'Z–A' }, natural: 'asc' },
  { order: 'added', label: 'Date added', ends: { asc: 'Oldest first', desc: 'Newest first' }, natural: 'desc' },
  { order: 'unread', label: 'Unread', ends: { asc: 'Fewest first', desc: 'Most first' }, natural: 'desc' },
  { order: 'lastRead', label: 'Last read', ends: { asc: 'Least recent', desc: 'Most recent' }, natural: 'desc' },
]

// Title ascending is the default because the order the shelves had until now was not an order at
// all: LIBRARY_QUERY's rows through deduplicateLibrary, which is stable but arbitrary.
const DEFAULT_SORT: LibrarySort = { order: 'title', direction: 'asc' }

const SORT = structured<LibrarySort>('library.sort', DEFAULT_SORT, (parsed) => {
  if (!parsed || typeof parsed !== 'object') return null
  const { order, direction } = parsed as Partial<LibrarySort>
  if (!SORT_ORDERS.some((option) => option.order === order)) return null
  return { order: order as SortOrder, direction: direction === 'desc' ? 'desc' : 'asc' }
})

// Two shapes have been written under this name: a single status, or "All", from when the shelves were
// a single-select, and the list of statuses it became. The obsolete one is not converted, only
// understood — a reader who never touches the filter should not have their setting rewritten by an
// upgrade.
const SHELF_FILTERS = preference<ShelfStatus[]>(
  'library.shelf',
  [...statusOrder],
  (raw) => shelfFiltersFrom(raw),
  (value) => JSON.stringify(value),
)

function shelfFiltersFrom(raw: string): ShelfStatus[] | null {
  if (raw === 'All') return [...statusOrder]
  if (isShelfStatus(raw)) return [raw]
  try {
    return reviveShelfFilters(JSON.parse(raw))
  } catch {
    return null
  }
}

function reviveShelfFilters(parsed: unknown): ShelfStatus[] | null {
  if (isShelfStatus(parsed)) return [parsed]
  if (Array.isArray(parsed)) return parsed.filter(isShelfStatus)
  return null
}

interface BoundChapter { id: number; chapterNumber: number; isRead: boolean; lastReadAt: string }

/** A chapter exactly as the sweep's `fetchChapters` returns it. `uploadDate` is a Long, so a string. */
interface FetchedChapter {
  id: number
  name: string
  chapterNumber: number
  sourceOrder: number
  scanlator: string | null
  uploadDate: string
  isRead: boolean
}

/** One line of the sweep's answer: a chapter it found, and the title and cover it belongs to. */
interface FoundChapter {
  chapter: FetchedChapter
  /** The bound source the chapter is on — where the reader opens it. */
  mangaId: number
  /** The library entry behind that source, so Back lands on the same catalogue the chapter came from. */
  entryId: number
  title: string
  thumbnailUrl: string | null
}

interface BoundState {
  /** Distinct chapter numbers the source carries, ascending — duplicate scanlations collapsed. */
  chapterNumbers: number[]
  /** Every chapter row, kept whole so a batch action can patch the unread ones by id. */
  chapters: BoundChapter[]
  latestChapter: number
  /** Highest chapter the DB has flagged read; AniList may still know about more. */
  localReadThrough: number
  /** Newest lastReadAt across the source's chapters, as an epoch; 0 when none was ever opened. */
  lastReadAt: number
  progress: number
  /**
   * The catalogue the chapters come from: what the cards badge, and what a migration names when it
   * says which source it is moving away from.
   */
  source: LibrarySource | null
  sourceStatus: string
}

/** One line of the migration's confirm list: a title, the match found for it, and whether to move it. */
interface MigrateMatch {
  entryId: number
  title: string
  /** The catalogue the title reads from today, or null when nothing is bound yet. */
  fromSource: string | null
  /** The destination's best hit, or null when it returned nothing — that row can only be skipped. */
  match: SourceMangaNode | null
  /** Whether the hit cleared the same similarity bar the detail page's picker trusts. */
  confident: boolean
  chosen: boolean
  /** Why the destination could not answer for this title, when it could not. */
  error?: string
}

function titleKey(title: string): string {
  return title.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

// What the search box compares against. Punctuation is left alone, unlike titleKey — this is a
// substring test, not an identity, and collapsing "Re:Zero" to "re zero" would stop it answering to
// "re:z". The marks are what has to go: the shelves mix Portuguese titles with romanised Japanese,
// so "Sōma" and "São" have to be reachable by someone typing "soma" and "sao" on a plain keyboard.
function searchKey(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()
}

// Titles are also known by their initials, and no amount of folding makes "sao" a substring of
// "Sword Art Online: Progressive". Prefix-matched rather than contained, so the three letters have
// to start the title's own initials instead of turning up somewhere inside a long one.
function titleInitials(title: string): string {
  return searchKey(title).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((word) => word[0]).join('')
}

function anilistRecord(item: LibraryManga): TrackRecord | undefined {
  return item.trackRecords.nodes.find((record) => record.trackerId === ANILIST_TRACKER_ID)
}

// The bound source is persisted server-side in the manga's meta (shared across browsers), with the
// browser-only localStorage choice kept as a fallback — mirroring MangaDetailPage's resolution.
function boundSourceId(item: LibraryManga): number | null {
  return sourceBindingFromMeta(item.meta) ?? getSourceBinding(item.id)
}

// Between a tracked and an untracked copy of a series, the tracked one wins so the card lands on
// the right shelf instead of under Other; between two tracked copies, the one that knows the most
// about the series does — bound to a source over unbound, then read the furthest, with the lowest
// id settling anything left so the choice cannot wander between renders.
function preferredEntry(a: LibraryManga, b: LibraryManga): LibraryManga {
  const score = (item: LibraryManga) => [
    anilistRecord(item) ? 1 : 0,
    boundSourceId(item) !== null ? 1 : 0,
    anilistRecord(item)?.lastChapterRead ?? 0,
    -item.id,
  ]
  const [left, right] = [score(a), score(b)]
  const decided = left.findIndex((value, index) => value !== right[index])
  return decided >= 0 && right[decided] > left[decided] ? b : a
}

// A source search and an AniList import can each create their own row for one series, and both rows
// end up tracked — "Sweet Home" imported from AniList and "Sweet Home" added from a source are two
// library entries carrying AniList 100954 between them. Only one of them is a card.
//
// The AniList id is the identity that survives all of this; the title only stands in when no tracker
// has claimed the row, and rows a tracker has claimed teach their id to the untracked copies of the
// same title. Grouping by id rather than by title is also what keeps the two distinct AniList
// entries both titled "Burn the Witch" on separate cards, where they belong.
function deduplicateLibrary(items: LibraryManga[]): LibraryManga[] {
  const remoteByTitle = new Map<string, string>()
  for (const item of items) {
    const remoteId = anilistId(item.trackRecords.nodes)
    if (remoteId) remoteByTitle.set(titleKey(item.title), remoteId)
  }
  const seriesKey = (item: LibraryManga) =>
    anilistId(item.trackRecords.nodes) ?? remoteByTitle.get(titleKey(item.title)) ?? titleKey(item.title)
  const series = new Map<string, LibraryManga>()
  for (const item of items) {
    const key = seriesKey(item)
    const found = series.get(key)
    series.set(key, found ? preferredEntry(found, item) : item)
  }
  return [...series.values()]
}

interface RecentChapter {
  id: number
  name: string
  sourceOrder: number
  lastPageRead: number
  lastReadAt: string
  pageCount: number
  isRead: boolean
  mangaId: number
  manga: {
    id: number
    title: string
    thumbnailUrl: string | null
    meta: Array<{ key: string; value: string }>
    trackRecords: { nodes: Array<{ trackerId: number; remoteId: string }> }
  }
}

/** A series' cards collapsed into one: the chapter to resume, plus every source row behind it. */
interface RecentSeries {
  key: string
  chapter: RecentChapter
  /** Every source row of this series, so hiding it cannot be undone by a duplicate taking its slot. */
  mangaIds: number[]
  /** When the series was last hidden, as an epoch stamp; 0 when it never was. */
  hiddenAt: number
}

interface NextChapter {
  id: number
  name: string
  chapterNumber: number
  sourceOrder: number
  isRead: boolean
}

interface RecentStateResult {
  mangas: { nodes: Array<{ id: number; title: string; status: string; chapters: { nodes: NextChapter[] }; trackRecords: { nodes: Array<{ trackerId: number; remoteId: string; lastChapterRead: number }> } }> }
}

/** What a continue-reading card needs from the library entry behind the source it is reading. */
interface BoundEntry {
  entryId: number
  /** The manga the entry is actually read from: its bound source, or itself when nothing is bound. */
  boundMangaId: number
  status: string
  lastChapterRead: number
  totalChapters: number
  /** Highest chapter the entry's bound source carries — 0 when nothing is bound yet. */
  latestChapter: number
  sourceStatus?: string
  remoteId?: string
}

/** Per-source reading state: where to resume, and how far through the series that is. */
interface RecentState {
  next: NextChapter | null
  readThrough: number
  latestChapter: number
  sourceStatus: string
  /** False for a library entry with nothing bound: there is no catalogue behind it to resume from. */
  hasChapters: boolean
  /** Chapters left to read, counted exactly as the shelf covers count them. Null when unknowable. */
  unread: number | null
}

const RECENT_LIMIT = 8

/**
 * Chapters still to read, counted the way the shelf covers count them so both surfaces agree on the
 * same title: distinct chapter numbers above the read-through, never rows, or a source carrying six
 * scanlations of one chapter would report six chapters left.
 *
 * A source with no chapters of its own falls back to AniList's total minus what it has read, which
 * is the only thing there is to go on — and null when AniList does not know the total either.
 */
function unreadCount(chapters: NextChapter[], readThrough: number, entry: BoundEntry | undefined): number | null {
  if (chapters.length > 0) {
    const numbers = new Set(chapters.filter((chapter) => chapter.chapterNumber > readThrough).map((chapter) => chapter.chapterNumber))
    return numbers.size
  }
  const total = entry?.totalChapters ?? 0
  return total > 0 ? Math.max(0, total - Math.floor(readThrough)) : null
}

// Chapters hang off the bound source manga, not off the library entry, so a card has to be told
// which library entry a source manga belongs to before it can send the reader's Back button
// somewhere sensible — and before it can borrow AniList's progress and chapter total for the bar.
//
// Reading history, though, sits on whichever source the chapter was opened from, which is not
// always the one currently bound: try a title on three sources and the copy holding the history can
// be one the binding has since moved off. That copy carries no track record, so resolving the entry
// by bound id alone leaves the card reporting "1 of 32" for a series AniList knows is finished.
// Falling back to the title — already the shelf's way of collapsing those duplicate rows — finds
// the entry anyway.
function ContinueReadingShelf({ libraryByBound, libraryByRemote, libraryByTitle, selecting }: {
  libraryByBound: Map<number, BoundEntry>
  libraryByRemote: Map<string, BoundEntry>
  libraryByTitle: Map<string, BoundEntry>
  selecting: boolean
}) {
  const [{ data }, refetchRecent] = useQuery<{ chapters: { nodes: RecentChapter[] } }>({
    query: RECENT_READS_QUERY,
    variables: { since: '0' },
    requestPolicy: 'cache-and-network',
  })
  const [, hideFromContinue] = useMutation(HIDE_FROM_CONTINUE_MUTATION)
  const [, unhideFromContinue] = useMutation(UNHIDE_FROM_CONTINUE_MUTATION)
  // Hidden series are dropped optimistically: the meta write is a round trip per source row, and
  // the card should leave under the finger, not a moment later.
  const [justHidden, setJustHidden] = useState<RecentSeries[]>([])
  // Undo has to override the stamp the server still holds until the delete round-trips, or the card
  // would sit out the trip and reappear a moment later — long enough to read as a failed undo.
  const [justRestored, setJustRestored] = useState<string[]>([])
  const [noticeDismissed, setNoticeDismissed] = useState(false)
  const chipRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const undoRef = useRef<HTMLButtonElement | null>(null)
  // The series key to focus after the next commit; `undefined` means "nothing left, use Undo",
  // `null` means no handoff is pending at all.
  const pendingFocus = useRef<string | null | undefined>(null)

  // Trying a title on several sources leaves one manga row per source, and all of them carry read
  // chapters, so the cards have to be grouped by series or the grid shows the same one six times.
  // Neither key alone does it: titles differ between sources ("Ms. Mystic" / "MISS MYSTIC"), and
  // the AniList id only exists on rows a tracker has claimed. So the claimed rows teach the rest —
  // once any copy titled "MISS MYSTIC" is known to be AniList 87443, the untracked copy of that
  // title is too, and it lands on the same card as "Ms. Mystic".
  const remoteByTitle = useMemo(() => {
    const map = new Map<string, string>()
    for (const chapter of data?.chapters.nodes ?? []) {
      const remoteId = anilistId(chapter.manga.trackRecords.nodes)
      if (remoteId) map.set(titleKey(chapter.manga.title), remoteId)
    }
    for (const [key, entry] of libraryByTitle) if (entry.remoteId) map.set(key, entry.remoteId)
    return map
  }, [data, libraryByTitle])

  const remoteFor = (title: string, records: Array<{ trackerId: number; remoteId?: string }>) =>
    anilistId(records) ?? remoteByTitle.get(titleKey(title))
  const seriesKey = (title: string, records: Array<{ trackerId: number; remoteId?: string }>) =>
    remoteFor(title, records) ?? titleKey(title)

  // The query is ordered newest first, so the first chapter seen for a series is the one to resume,
  // and every later row of the same series joins it instead of claiming a card of its own.
  const series = useMemo(() => {
    const perSeries = new Map<string, RecentSeries>()
    for (const chapter of data?.chapters.nodes ?? []) {
      const key = seriesKey(chapter.manga.title, chapter.manga.trackRecords.nodes)
      const hiddenAt = Number(chapter.manga.meta.find((entry) => entry.key === CONTINUE_HIDDEN_META_KEY)?.value ?? 0)
      const found = perSeries.get(key)
      if (found) {
        if (!found.mangaIds.includes(chapter.mangaId)) found.mangaIds.push(chapter.mangaId)
        found.hiddenAt = Math.max(found.hiddenAt, hiddenAt)
      } else {
        perSeries.set(key, { key, chapter, mangaIds: [chapter.mangaId], hiddenAt })
      }
    }
    // A series stays hidden only until it is read again: the stamp is compared against the newest
    // read in the group, so opening a chapter brings the card back without any un-hide step.
    return [...perSeries.values()]
      .filter((entry) => justRestored.includes(entry.key)
        || !(entry.hiddenAt > 0 && entry.hiddenAt >= Number(entry.chapter.lastReadAt)))
      .filter((entry) => !justHidden.some((hidden) => hidden.key === entry.key))
      .slice(0, RECENT_LIMIT)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, remoteByTitle, justHidden, justRestored])

  const recent = useMemo(() => series.map((entry) => entry.chapter), [series])

  // Bound id is exact, AniList id is reliable across sources, title is the last resort.
  const entryFor = (mangaId: number, title: string, remoteId?: string) =>
    libraryByBound.get(mangaId)
      ?? (remoteId ? libraryByRemote.get(remoteId) : undefined)
      ?? libraryByTitle.get(titleKey(title))

  // A card resumes on the source the series is *read* from — the one its detail page and the shelf
  // covers use — which is not always the row holding the newest history. Trying a title on several
  // sources leaves reading history on every copy, and the binding may since have moved off the one
  // that was read last; resuming there while Back went to the series' page opened a chapter from one
  // catalogue and, a click later, showed a page reading from another, so the source looked like it
  // had reset itself. Going through the bound source keeps both ends of the trip on one catalogue,
  // exactly as opening the title from its shelf does.
  const cards = useMemo(() => series.map((item) => {
    const { title, trackRecords } = item.chapter.manga
    const entry = entryFor(item.chapter.mangaId, title, remoteFor(title, trackRecords.nodes))
    return { item, entry, readingMangaId: entry?.boundMangaId ?? item.chapter.mangaId }
  }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [series, libraryByBound, libraryByRemote, libraryByTitle, remoteByTitle])
  // Both ends are asked for: the source the card means to open, and the one the chapter was read
  // from, which it falls back to when the first turns out to have no catalogue behind it.
  const ids = useMemo(
    () => [...new Set(cards.flatMap((card) => [card.readingMangaId, card.item.chapter.mangaId]))].sort((a, b) => a - b),
    [cards],
  )
  const [{ data: stateData }] = useQuery<RecentStateResult>({
    query: RECENT_STATE_QUERY,
    variables: { ids },
    pause: ids.length === 0,
  })

  const stateByManga = useMemo(() => {
    const map = new Map<number, RecentState>()
    for (const node of stateData?.mangas.nodes ?? []) {
      const entry = entryFor(node.id, node.title, remoteFor(node.title, node.trackRecords.nodes))
      const progress = node.trackRecords.nodes.find((record) => record.trackerId === ANILIST_TRACKER_ID)?.lastChapterRead ?? 0
      const localReadThrough = node.chapters.nodes.reduce((latest, chapter) => chapter.isRead ? Math.max(latest, chapter.chapterNumber) : latest, 0)
      // The library entry's own AniList record counts too: it is where progress lands once a title
      // has been read on the bound source, and this copy may never have seen any of it.
      const readThrough = Math.max(progress, localReadThrough, entry?.lastChapterRead ?? 0)
      const next = [...node.chapters.nodes]
        .sort((a, b) => a.chapterNumber - b.chapterNumber || a.sourceOrder - b.sourceOrder)
        .find((chapter) => !chapter.isRead && !(readThrough > 0 && chapter.chapterNumber <= readThrough))
      map.set(node.id, {
        next: next ?? null,
        readThrough,
        // The bound source is the one the rest of the app reads from, so it sets what "everything"
        // means; this copy only raises the bar if it happens to carry more.
        latestChapter: Math.max(
          node.chapters.nodes.reduce((latest, chapter) => Math.max(latest, chapter.chapterNumber), 0),
          entry?.latestChapter ?? 0,
        ),
        sourceStatus: entry?.sourceStatus ?? node.status,
        hasChapters: node.chapters.nodes.length > 0,
        unread: unreadCount(node.chapters.nodes, readThrough, entry),
      })
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateData, libraryByBound, libraryByRemote, libraryByTitle, remoteByTitle])

  // Deleting an item from a collection should leave focus inside the collection, so it lands on the
  // chip of whichever card slides into the vacated slot — clearing two stray duplicates in a row
  // then needs no journey back down the grid. Undo catches focus only when nothing is left.
  // The handoff waits for the commit that mounts the target chip; a rAF fires too early and lands
  // on a ref React has not filled in yet.
  useEffect(() => {
    const key = pendingFocus.current
    if (key === null) return
    if (key === undefined) {
      pendingFocus.current = null
      undoRef.current?.focus()
      return
    }
    const chip = chipRefs.current.get(key)
    // The card may not be back yet; keep the request pending and take the next commit instead.
    if (!chip) return
    pendingFocus.current = null
    chip.focus()
  })

  const hideSeries = async (entry: RecentSeries, index: number) => {
    const remaining = series.filter((candidate) => candidate.key !== entry.key)
    pendingFocus.current = (remaining[index] ?? remaining[remaining.length - 1])?.key
    setJustHidden((hidden) => [...hidden, entry])
    setJustRestored((restored) => restored.filter((key) => key !== entry.key))
    setNoticeDismissed(false)
    // Every source row of the series is stamped, not just the one holding the newest read: leaving
    // the others unstamped would let a duplicate row take the freed slot on the next fetch.
    await Promise.all(entry.mangaIds.map((mangaId) => hideFromContinue({ mangaId, stamp: entry.chapter.lastReadAt })))
    refetchRecent({ requestPolicy: 'network-only' })
  }

  // Focus follows the restored card, whose chip announces "Hide {title} from Continue reading" —
  // confirmation of the undo without a second live message.
  const undoHiding = async () => {
    const restoring = justHidden
    pendingFocus.current = restoring[0]?.key
    setJustRestored(restoring.map((entry) => entry.key))
    setJustHidden([])
    await Promise.all(restoring.flatMap((entry) => entry.mangaIds.map((mangaId) => unhideFromContinue({ mangaId }))))
    refetchRecent({ requestPolicy: 'network-only' })
  }

  const notice = justHidden.length > 0 && !noticeDismissed ? justHidden : null
  if (recent.length === 0 && !notice) return null

  return (
    <section className="shelf recent-shelf" data-selecting={selecting}>
      <div className="recent-heading">
        <div>
          <span className="eyebrow">{t('Pick up where you left off')}</span>
          <h2>{t('Continue reading')}</h2>
        </div>
        <span>{t('{count} in progress', { count: recent.length })}</span>
      </div>
      {/* Always mounted so consecutive hides each announce; display:none would silence it. */}
      <div className="recent-undo-live" role="status" aria-live="polite">
        {notice && (
          <div className="notice carry-notice recent-undo">
            <span>
              {notice.length === 1
                ? t('{title} is hidden from Continue reading. It comes back when you read it again.', { title: notice[0].chapter.manga.title })
                : t('{count} titles are hidden from Continue reading. They come back when you read them again.', { count: notice.length })}
            </span>
            <button
              type="button"
              ref={undoRef}
              className="button quiet"
              onClick={undoHiding}
              title={t('Undo')}
              aria-label={notice.length === 1
                ? t('Undo hiding {title}', { title: notice[0].chapter.manga.title })
                : t('Undo hiding {count} titles', { count: notice.length })}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 9h11a4.5 4.5 0 0 1 0 9h-6" />
                <path d="m8 5-4 4 4 4" />
              </svg>
            </button>
            <button
              type="button"
              className="button quiet"
              onClick={() => setNoticeDismissed(true)}
              title={t('Dismiss')}
              aria-label={t('Dismiss')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        )}
      </div>
      <div className="recent-grid">
        {cards.map(({ item, entry, readingMangaId }, index) => {
          const chapter = item.chapter
          // A library entry with nothing bound has no chapters of its own, so there is nothing to
          // resume from there; that card keeps to the source the series was actually read on rather
          // than dropping the reader on a detail page with no catalogue behind it.
          const bound = stateByManga.get(readingMangaId)
          const sourceId = bound?.hasChapters ? readingMangaId : chapter.mangaId
          const state = bound?.hasChapters ? bound : stateByManga.get(chapter.mangaId)
          // An unfinished chapter is picked up where it was left, but only on the source it was left
          // on: on any other catalogue that page number means nothing, so the card hands over to the
          // next unread chapter there instead. A finished chapter always hands over, and a title with
          // nothing left goes to its detail page rather than reopening the last chapter as if it
          // were new.
          const inPlace = sourceId === chapter.mangaId && !chapter.isRead
          const resume = inPlace ? chapter : state?.next ?? null
          const entryId = entry?.entryId ?? chapter.mangaId
          // Back has to land on a page that reads from the same catalogue as the chapter just
          // opened, or the source looks like it reset itself on the way out. The library entry
          // qualifies only when this is the source it is bound to; otherwise the reader is left on
          // that source's own page.
          const returnQuery = entry && entry.entryId !== sourceId && entry.boundMangaId === sourceId ? `?from=${entry.entryId}` : ''
          const target = resume ? `/manga/${sourceId}/chapter/${resume.sourceOrder}${returnQuery}` : `/manga/${entryId}`

          // The bar measures the whole series, not the open chapter: read-through over the chapter
          // total, reconciled and labelled exactly as the library covers' progress chip does, so
          // both read "43 / 147" for the same title. The chapter in hand contributes its page
          // fraction so the bar still creeps forward while reading.
          const readThrough = Math.max(state?.readThrough ?? 0, entry?.lastChapterRead ?? 0)
          const read = Math.floor(readThrough)
          const latestChapter = state?.latestChapter ?? 0
          const finished = hasFinishedPublishing(entry?.status ?? 'UNKNOWN', state?.sourceStatus)
          const total = chapterTotalLabel(entry?.totalChapters ?? 0, latestChapter, readThrough, finished)
          const totalChapters = entry?.totalChapters && entry.totalChapters > 0
            ? entry.totalChapters
            : Math.max(latestChapter, read)
          const pagesRead = inPlace && chapter.pageCount > 0 ? (chapter.lastPageRead + 1) / chapter.pageCount : 0
          // Caught up means the read-through covers every chapter there is, not merely every
          // chapter this copy of the source happens to carry: an outdated copy that stops at 20
          // would otherwise report a series with 40 out as finished.
          const caughtUp = resume === null && latestChapter > 0 && readThrough >= latestChapter
          const unread = state?.unread ?? null
          // A full bar is reserved for being caught up, so a series whose read-through already
          // covers the known total but still has a stray chapter left stops just short of the end.
          const fraction = caughtUp
            ? 1
            : totalChapters > 0
              ? Math.min(0.97, (read + pagesRead) / totalChapters)
              : pagesRead

          // The cover carries the title and the bar; chapter name and page count would crowd it, so
          // they move to the link's tooltip rather than being dropped.
          const overall = total.label === '?' ? '' : t(' · chapter {read} of {total}', { read, total: total.label })
          const hint = (inPlace && chapter.pageCount > 0
            ? t('{chapter} · page {page} of {pages}', { chapter: chapter.name, page: chapter.lastPageRead + 1, pages: chapter.pageCount })
            : resume
              ? t('Next up: {chapter}', { chapter: resume.name })
              : caughtUp
                ? t('Nothing left to read')
                : t('Nothing unread on this source')) + overall
          // The hide chip is a sibling of the link, never a child: a click on it cannot reach the
          // link and a click meant for the link cannot reach it, without either invalid markup or a
          // stopPropagation that would only paper over the overlap.
          return (
            <div key={chapter.id} className="recent-cell">
              <Link to={target} className="recent-item" title={hint}>
                {chapter.manga.thumbnailUrl
                  ? <img src={chapter.manga.thumbnailUrl} alt="" loading="lazy" />
                  : <div className="cover-placeholder" />}
                {/* The shelf covers' unread badge, on the left because the hide chip owns the right
                    corner here. Suppressed once caught up: the bar already says so in colour, and a
                    stale count beside a full bar reads as a contradiction. */}
                {!caughtUp && unread !== null && unread > 0 && (
                  <span
                    className="unread-chip recent-unread"
                    title={t('{count} unread', { count: unread })}
                    aria-label={t(unread === 1 ? '{count} unread chapter' : '{count} unread chapters', { count: unread })}
                  >{unread}</span>
                )}
                <div className="recent-copy">
                  <strong>{chapter.manga.title}</strong>
                  <div className={`recent-progress${caughtUp ? ' caught-up' : ''}`} aria-hidden="true">
                    <i style={{ width: `${fraction * 100}%` }} />
                  </div>
                </div>
              </Link>
              <button
                type="button"
                ref={(node) => { chipRefs.current.set(item.key, node) }}
                className="recent-dismiss"
                onClick={() => hideSeries(item, index)}
                title={t('Hide from Continue reading')}
                aria-label={t('Hide {title} from Continue reading', { title: chapter.manga.title })}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export default function LibraryPage() {
  const [selectedShelves, setSelectedShelves] = SHELF_FILTERS.use()
  const [hiddenShelves, setHiddenShelves] = HIDDEN_SHELVES.use()
  const [groupingPreference, setGroupingPreference] = GROUPING.use()
  const [sort, setSort] = SORT.use()
  const [sortOpen, setSortOpen] = useState(false)
  // Plain state, not a preference like the sort order and the shelf visibility beside it. Those
  // describe how someone likes their library; a search term describes what they are doing this
  // minute, and finding it still in force a week later on another device would read as titles having
  // disappeared rather than as a filter still applied.
  const [search, setSearch] = useState('')
  const [genreFilters, setGenreFilters] = useState<string[]>([])
  const sortRef = useRef<HTMLDivElement | null>(null)
  const sortTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [{ data, fetching, error }, refetchLibrary] = useQuery<LibraryQueryResult>({ query: LIBRARY_QUERY })
  // Kept fresh across a visit to Settings, where the categories themselves are managed.
  const [{ data: categoryData }, refetchCategories] = useQuery<CategoriesResult>({
    query: CATEGORIES_QUERY,
    requestPolicy: 'cache-and-network',
  })
  const [, fileMangas] = useMutation(FILE_MANGAS_MUTATION)
  const categories = useMemo(() => sortedCategories(categoryData), [categoryData])
  // Grouping by something that no longer exists is not a state the page can be in: deleting the last
  // category drops the library back to its AniList shelves without touching the stored preference.
  const grouping: Grouping = categories.length > 0 ? groupingPreference : 'status'
  const [, fetchTrack] = useMutation(FETCH_TRACK_MUTATION)
  const [, setLastSync] = useMutation(SET_LAST_SYNC_MUTATION)
  const [, fetchChapters] = useMutation<{ fetchChapters: { chapters: FetchedChapter[] } | null }>(FETCH_CHAPTERS_MUTATION)
  const [, fetchSourceMangaBulk] = useMutation<FetchSourceMangaBulkResult>(FETCH_SOURCE_MANGA_BULK_MUTATION)
  const [, saveSourceBinding] = useMutation(SET_SOURCE_BINDING_MUTATION)
  const [, dropSourceBinding] = useMutation(DELETE_SOURCE_BINDING_MUTATION)
  const [, removeFromLibrary] = useMutation(REMOVE_FROM_LIBRARY_MUTATION)
  const [, markChaptersRead] = useMutation(MARK_CHAPTERS_READ_MUTATION)
  const [, unmarkChaptersRead] = useMutation(UNMARK_CHAPTERS_READ_MUTATION)
  const [syncState, setSyncState] = useState<{ done: number; total: number } | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  // Says which titles the refresh rolled back, since clearing read flags is not something a sync
  // should do silently.
  const [syncNotice, setSyncNotice] = useState<string | null>(null)
  // The chapter sweep counts its own progress rather than reading a server job's, for the reason
  // spelled out on checkForNewChapters.
  const [updateState, setUpdateState] = useState<{ done: number; total: number } | null>(null)
  const [updateNotice, setUpdateNotice] = useState<string | null>(null)
  // What the last sweep found, and nothing older. In memory only: this is the answer to a button
  // just pressed, and a list that survived a reload would have to say what "new" still means hours
  // later — a question Mihon answers with a history table, and there is nothing here that needs one.
  const [foundChapters, setFoundChapters] = useState<FoundChapter[]>([])
  // Whether that notice reports a source it could not reach, which only decides how it is styled —
  // the text itself is one line either way.
  const [updateError, setUpdateError] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  // Removal takes titles off the shelves in one go, so it asks first rather than relying on an undo
  // that the user would have to notice.
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  // The batch bar's second face: pick a category, then add the selection to it or take it out.
  const [filing, setFiling] = useState(false)
  const [filingCategory, setFilingCategory] = useState<number | null>(null)
  // Its third: pick a destination catalogue, search it for every selected title, then confirm the
  // matches. Nothing is rebound before that list has been looked at.
  const [migrating, setMigrating] = useState(false)
  const [migrateSourceId, setMigrateSourceId] = useState<string | null>(null)
  const [migrateMatches, setMigrateMatches] = useState<MigrateMatch[] | null>(null)
  const [migrateState, setMigrateState] = useState<{ done: number; total: number } | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchNotice, setBatchNotice] = useState<string | null>(null)
  const [batchError, setBatchError] = useState<string | null>(null)

  // Only asked for once selection mode is on: a destination catalogue is of no use to a library
  // nobody is acting on, and most visits to this page never migrate anything.
  const [{ data: sourcesData }] = useQuery<{ sources: { nodes: SourceNode[] } }>({
    query: SOURCES_QUERY,
    requestPolicy: 'cache-and-network',
    pause: !selecting,
  })
  // One language variant per catalogue, best catalogues first — the same list the detail page's
  // picker searches, so "Change source…" offers what "Find on source" would have found.
  const migrateSources = useMemo(
    () => prioritizedSources(preferredSourcePerName(browsableSources(sourcesData?.sources.nodes ?? []))),
    [sourcesData],
  )
  const migrateTarget = migrateSources.find((source) => source.id === migrateSourceId) ?? null

  // The sort menu is the one thing on this page that covers the shelves, so it closes the way a menu
  // is expected to: a press anywhere else, or Escape. Without both it would sit there over the grid
  // until something else was clicked twice.
  useEffect(() => {
    if (!sortOpen) return
    const dismiss = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return
        // Escape hands the toolbar its place back. Without it focus falls to the body and the next
        // Tab restarts from the top of the page, which is how a keyboard user loses the library.
        sortTriggerRef.current?.focus()
      }
      if (event.type === 'pointerdown' && sortRef.current?.contains(event.target as Node)) return
      setSortOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', dismiss)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', dismiss)
    }
  }, [sortOpen])

  // Map each library entry to its bound source manga, then fetch those sources' real unread counts.
  const boundByManga = useMemo(() => {
    const map = new Map<number, number>()
    for (const item of data?.mangas.nodes ?? []) {
      const bound = boundSourceId(item)
      if (bound !== null) map.set(item.id, bound)
    }
    return map
  }, [data])
  const boundIds = useMemo(() => [...new Set(boundByManga.values())].sort((a, b) => a - b), [boundByManga])
  // A batch action is handed ids, not rows, so it needs the row back to read a title or a binding.
  const entryById = useMemo(() => new Map((data?.mangas.nodes ?? []).map((item) => [item.id, item])), [data])
  // The same sources, minus the ones behind a series AniList has marked Completed: a finished series
  // cannot publish anything, so asking its source is a request spent on a list that cannot grow.
  //
  // This is a second list rather than a narrower boundIds because boundIds is also the variable list
  // for BOUND_UNREAD_QUERY below, and that query feeds every card's unread chip and the
  // continue-reading shelf. Narrowing it would stop counting the titles it stopped sweeping.
  //
  // A source shared by a completed entry and an unfinished one stays in: one of the two can still grow.
  const sweepIds = useMemo(() => {
    const ids = new Set<number>()
    for (const item of data?.mangas.nodes ?? []) {
      if (anilistRecord(item)?.status === COMPLETED_STATUS) continue
      const bound = boundByManga.get(item.id)
      if (bound !== undefined) ids.add(bound)
    }
    return [...ids].sort((a, b) => a - b)
  }, [data, boundByManga])
  const [{ data: unreadData }, refetchUnread] = useQuery<{
    mangas: { nodes: Array<{ id: number; status: string; source: LibrarySource | null; chapters: { nodes: BoundChapter[] }; trackRecords: { nodes: Array<{ id: number; trackerId: number; lastChapterRead: number }> } }> }
  }>({
    query: BOUND_UNREAD_QUERY,
    variables: { ids: boundIds },
    pause: boundIds.length === 0,
  })
  const unreadByBound = useMemo(() => {
    const map = new Map<number, BoundState>()
    for (const node of unreadData?.mangas.nodes ?? []) {
      const progress = node.trackRecords.nodes.find((record) => record.trackerId === ANILIST_TRACKER_ID)?.lastChapterRead ?? 0
      const chapterNumbers = [...new Set(node.chapters.nodes.map((chapter) => chapter.chapterNumber))].sort((a, b) => a - b)
      map.set(node.id, {
        chapterNumbers,
        chapters: node.chapters.nodes,
        latestChapter: chapterNumbers.at(-1) ?? 0,
        localReadThrough: node.chapters.nodes.reduce((latest, chapter) => chapter.isRead ? Math.max(latest, chapter.chapterNumber) : latest, 0),
        lastReadAt: node.chapters.nodes.reduce((latest, chapter) => Math.max(latest, Number(chapter.lastReadAt) || 0), 0),
        progress,
        source: node.source,
        sourceStatus: node.status,
      })
    }
    return map
  }, [unreadData])

  // Reading history arrives keyed by the source manga, so the continue-reading cards need the
  // binding read the other way round to find the library entry behind each one — and with it the
  // AniList record that knows the real read-through, the chapter total and the publishing status.
  // Read-through takes the best of the entry's own record and the bound source's, exactly as the
  // shelf counters do: whichever was synced last is the one that knows.
  const boundEntryFor = (item: LibraryManga): BoundEntry => {
    const record = anilistRecord(item)
    const bound = unreadByBound.get(boundByManga.get(item.id) ?? -1)
    return {
      entryId: item.id,
      // An entry with no binding reads its own chapters, so it is its own reading source.
      boundMangaId: boundByManga.get(item.id) ?? item.id,
      status: item.status,
      lastChapterRead: Math.max(record?.lastChapterRead ?? 0, bound?.progress ?? 0, bound?.localReadThrough ?? 0),
      totalChapters: record?.totalChapters ?? 0,
      latestChapter: bound?.latestChapter ?? 0,
      sourceStatus: bound?.sourceStatus,
      remoteId: record?.remoteId || undefined,
    }
  }
  const libraryByBound = useMemo(() => {
    const map = new Map<number, BoundEntry>()
    for (const item of data?.mangas.nodes ?? []) {
      const bound = boundByManga.get(item.id)
      if (bound !== undefined) map.set(bound, boundEntryFor(item))
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, boundByManga, unreadByBound])
  // The same entries keyed by identity that survives a change of source, for cards whose history
  // sits on a source the binding has since moved off. Duplicates keep the entry that knows the
  // most, mirroring deduplicateLibrary.
  const keyedEntries = <K,>(keyOf: (item: LibraryManga) => K | undefined) => {
    const map = new Map<K, BoundEntry>()
    for (const item of data?.mangas.nodes ?? []) {
      const key = keyOf(item)
      if (key === undefined) continue
      const entry = boundEntryFor(item)
      const existing = map.get(key)
      if (!existing || entry.lastChapterRead > existing.lastChapterRead) map.set(key, entry)
    }
    return map
  }
  const libraryByRemote = useMemo(
    () => keyedEntries((item) => anilistId(item.trackRecords.nodes)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, boundByManga, unreadByBound],
  )
  const libraryByTitle = useMemo(
    () => keyedEntries((item) => titleKey(item.title)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, boundByManga, unreadByBound],
  )

  // AniList is the record of truth for how far a title has been read, so a refresh has to be able to
  // move progress *down* as well as up: rolling a series back on AniList to re-read from there left
  // the local isRead flags standing, and read-through is the highest of the two, so the shelf moved
  // while the continue-reading card stayed finished.
  //
  // Only chapters *above* the tracker's number are cleared, and only for bound sources whose AniList
  // record actually reports progress. A record sitting at 0 means AniList knows nothing about the
  // title — the tracker was just linked, or the title is on Planning — and treating that as
  // authoritative would throw away real reading with no signal behind it.
  const rollBackToTracker = async (syncedProgress: Map<number, number>) => {
    const titleByBound = new Map<number, string>()
    for (const item of data?.mangas.nodes ?? []) {
      const bound = boundByManga.get(item.id)
      if (bound !== undefined && !titleByBound.has(bound)) titleByBound.set(bound, item.title)
    }
    const rolledBack: Array<{ title: string; progress: number }> = []
    const pending: Array<Promise<unknown>> = []
    for (const node of unreadData?.mangas.nodes ?? []) {
      const record = node.trackRecords.nodes.find((entry) => entry.trackerId === ANILIST_TRACKER_ID)
      if (!record) continue
      const progress = syncedProgress.get(record.id) ?? record.lastChapterRead
      if (!(progress > 0)) continue
      const stale = node.chapters.nodes.filter((chapter) => chapter.isRead && chapter.chapterNumber > progress)
      if (stale.length === 0) continue
      pending.push(unmarkChaptersRead({ ids: stale.map((chapter) => chapter.id) }))
      rolledBack.push({ title: titleByBound.get(node.id) ?? `Manga ${node.id}`, progress })
    }
    await Promise.all(pending)
    return rolledBack
  }

  // Read progress is pushed to AniList from the bound-source track record, not from the
  // library entry's own record, so the shelf counters drift out of date. Pull every AniList
  // record back down from the remote so the library reflects the real progress.
  //
  // The bound sources are refreshed alongside the entries, and they are the ones that matter most:
  // a bound source is not itself in the library, so a sync that only walked `inLibrary` rows left
  // the very record progress is pushed from — the one the continue-reading cards read back — stuck
  // at whatever it last pushed. Rolling a title back on AniList then changed the shelf but not the
  // card, and no amount of syncing or re-importing could shift it.
  const refreshFromAniList = async () => {
    if (syncState) return
    const recordIds = [...new Set(
      [
        ...(data?.mangas.nodes ?? []).flatMap((item) => item.trackRecords.nodes),
        ...(unreadData?.mangas.nodes ?? []).flatMap((node) => node.trackRecords.nodes),
      ]
        .filter((record) => record.trackerId === ANILIST_TRACKER_ID)
        .map((record) => record.id),
    )]
    if (recordIds.length === 0) return
    setSyncError(null)
    setSyncNotice(null)
    setSyncState({ done: 0, total: recordIds.length })
    let failed = 0
    const syncedProgress = new Map<number, number>()
    for (const [index, recordId] of recordIds.entries()) {
      // Treat the record as refreshed when the mutation returns it. urql's document cache can
      // surface a spurious `error` alongside a perfectly good payload, so trusting `error`
      // here reported every title as failed even though they all synced.
      const result = await fetchTrack({ recordId })
      const record = result.data?.fetchTrack?.trackRecord
      if (!record) failed += 1
      else syncedProgress.set(record.id, record.lastChapterRead)
      setSyncState({ done: index + 1, total: recordIds.length })
    }
    const rolledBack = await rollBackToTracker(syncedProgress)
    // Stamped even when some titles failed: the library did talk to AniList, and Settings answers
    // "when did this last run", not "when did it last run perfectly".
    await setLastSync({ stamp: String(Date.now()) })
    // Both ends have to come back down: the entries feed the shelves, the bound sources feed the
    // continue-reading cards, and refreshing only the first is what made a synced title still read
    // as finished.
    await Promise.all([
      refetchLibrary({ requestPolicy: 'network-only' }),
      refetchUnread({ requestPolicy: 'network-only' }),
    ])
    setSyncState(null)
    if (rolledBack.length === 1) {
      setSyncNotice(t('{title} rolled back to chapter {chapter} to match AniList.', {
        title: rolledBack[0].title,
        chapter: formatChapterNumber(rolledBack[0].progress),
      }))
    } else if (rolledBack.length > 1) {
      setSyncNotice(t('{count} titles rolled back to match AniList: {titles}.', {
        count: rolledBack.length,
        titles: rolledBack.map((item) => item.title).join(', '),
      }))
    }
    if (failed > 0) setSyncError(t('{failed} of {total} titles did not sync. Try again.', { failed, total: recordIds.length }))
  }

  // Asks every source the library reads from whether it has published anything new.
  //
  // The server has its own library updater (updateLibrary / globalUpdateInterval) and it is useless
  // to us: it builds its queue from the library's categories, and both branches of
  // CategoryManga.getCategoryMangaList filter on `inLibrary eq true`. Our library entries are
  // AniList-seeded stubs sitting on the legacy TorBox source, while the mangas that actually hold
  // chapters are the bound sources — deliberately *not* in the library, so they can never enter that
  // queue. A server-side update would ask TorBox for every stub's chapter list and never touch a
  // source we read from. So the sweep runs here, over exactly the mangas whose chapters the shelves
  // already count, and there is no server-side automatic equivalent to offer.
  //
  // Entries with no bound source are skipped rather than swept: their unread number comes from
  // AniList (total − read), not from a source, and refreshing that is what the AniList button does.
  // Completed series are skipped for a different reason — see sweepIds — and both are accounted for
  // in the notice, so a smaller total reads as deliberate rather than as titles having gone missing.
  const checkForNewChapters = async () => {
    if (updateState || sweepIds.length === 0) return
    setUpdateError(false)
    setUpdateNotice(null)
    // The list is what this sweep finds, not a running history, so the previous answer goes before
    // the new one is looked for rather than being left on screen describing an older pass.
    setFoundChapters([])
    setUpdateState({ done: 0, total: sweepIds.length })
    // Which chapters each source already had, by id — a set difference, not a subtraction of two
    // counts. Counting answers *how many* and can never answer *which*, and it answers the first one
    // wrongly the moment a source drops one chapter and publishes two. Ids, not distinct chapter
    // numbers: a new scanlation of a chapter we already have is still something the source published.
    const before = new Map(sweepIds.map((id) =>
      [id, new Set((unreadByBound.get(id)?.chapters ?? []).map((chapter) => chapter.id))] as const))
    const entries = deduplicateLibrary(data?.mangas.nodes ?? [])
    // The whole entry rather than its title alone: the found list needs its cover, and its id for
    // the way back out of the reader.
    const entryByBound = new Map(entries.flatMap((item) => {
      const bound = boundSourceId(item)
      return bound === null ? [] : [[bound, item] as const]
    }))
    let added = 0
    let grownTitles = 0
    const found: FoundChapter[] = []
    const unchecked: string[] = []
    for (const [index, mangaId] of sweepIds.entries()) {
      // One source at a time. A sweep is never urgent, and firing a dozen chapter-list requests at
      // once is how a source starts rate-limiting or blocking us.
      const result = await fetchChapters({ mangaId })
      const chapters = result.data?.fetchChapters?.chapters
      // Sources fail here routinely and for reasons nothing in the app can fix: one behind Cloudflare
      // with no FlareSolverr running, one that has gone down, or one that now lists nothing at all
      // (the server raises "No chapters found" rather than returning an empty list). The wording
      // stays neutral across all three, and names the titles so the shelf that did not move has a
      // reason next to it.
      const entry = entryByBound.get(mangaId)
      if (!chapters) unchecked.push(entry?.title ?? `Manga ${mangaId}`)
      else {
        const known = before.get(mangaId)
        const fresh = chapters.filter((chapter) => !known?.has(chapter.id))
        if (fresh.length > 0) {
          // The count the notice prints is the length of the very list below it, so the line and the
          // shelf can never disagree about what the pass turned up.
          added += fresh.length
          grownTitles += 1
          for (const chapter of fresh) {
            found.push({
              chapter,
              mangaId,
              entryId: entry?.id ?? mangaId,
              title: entry?.title ?? `Manga ${mangaId}`,
              thumbnailUrl: entry?.thumbnailUrl ?? null,
            })
          }
        }
      }
      setUpdateState({ done: index + 1, total: sweepIds.length })
    }
    // Only the bound sources are refetched: the sweep writes chapters, and nothing about the library
    // entries themselves changed.
    await refetchUnread({ requestPolicy: 'network-only' })
    setUpdateState(null)
    // Newest first across every source, not source by source: the reader asked what is new, and one
    // catalogue answering slowly is no reason for its chapters to sit above another's. Sources that
    // publish no date at all report 0 and fall to the end, where the chapter number orders them.
    setFoundChapters([...found].sort((a, b) =>
      (Number(b.chapter.uploadDate) || 0) - (Number(a.chapter.uploadDate) || 0)
      || b.chapter.chapterNumber - a.chapter.chapterNumber))
    // One line rather than a separate error, because a partial failure is the normal outcome here
    // and the count of what *was* found is exactly what gets lost by hiding it behind an error.
    const unbound = entries.filter((item) => boundSourceId(item) === null).length
    // Counted off the two lists rather than off the entries, so the number always explains exactly
    // how the sweep's total came to be smaller than the set of sources the library reads from.
    const skipped = boundIds.length - sweepIds.length
    const notes = [
      added > 0
        ? t(added === 1 ? '{count} new chapter across {titles}' : '{count} new chapters across {titles}', {
          count: added,
          titles: t(grownTitles === 1 ? '{count} title' : '{count} titles', { count: grownTitles }),
        })
        : t('No new chapters'),
      unchecked.length > 0
        ? t(unchecked.length === 1 ? '{count} source could not be checked ({names})' : '{count} sources could not be checked ({names})', {
          count: unchecked.length,
          names: unchecked.join(', '),
        })
        : null,
      skipped > 0 ? t('{count} completed, not checked', { count: skipped }) : null,
      unbound > 0 ? t('{count} without a bound source', { count: unbound }) : null,
    ].filter((note) => note !== null)
    setUpdateNotice(t('{notes}.', { notes: notes.join(' · ') }))
    setUpdateError(unchecked.length > 0)
  }

  const leaveSelection = () => {
    setSelecting(false)
    setSelected(new Set())
    setConfirmingRemove(false)
    setFiling(false)
    setMigrating(false)
    setMigrateMatches(null)
  }

  const toggleSelected = (mangaId: number) => {
    setConfirmingRemove(false)
    // A confirm list is about the titles that were selected when it was searched for; changing the
    // selection under it would leave rows for titles no longer picked and none for those just added.
    setMigrateMatches(null)
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(mangaId)) next.delete(mangaId)
      else next.add(mangaId)
      return next
    })
  }

  const removeSelected = async () => {
    const ids = [...selected]
    if (ids.length === 0 || batchRunning) return
    setBatchRunning(true)
    setBatchError(null)
    setBatchNotice(null)
    const result = await removeFromLibrary({ ids })
    setBatchRunning(false)
    if (result.error) {
      setBatchError(friendlyError(result.error))
      setConfirmingRemove(false)
      return
    }
    await refetchLibrary({ requestPolicy: 'network-only' })
    setBatchNotice(t(ids.length === 1 ? 'Removed {count} title from your library.' : 'Removed {count} titles from your library.', { count: ids.length }))
    leaveSelection()
  }

  // Filing is one call for the whole selection — unlike catching up, which has to walk each title's
  // bound source, this is a single mutation the server applies to every id.
  const fileSelected = async (action: 'add' | 'remove') => {
    const ids = [...selected]
    const categoryId = filingCategory
    if (ids.length === 0 || categoryId === null || batchRunning) return
    setBatchRunning(true)
    setBatchError(null)
    setBatchNotice(null)
    const result = await fileMangas({
      ids,
      add: action === 'add' ? [categoryId] : null,
      remove: action === 'remove' ? [categoryId] : null,
    })
    setBatchRunning(false)
    if (result.error) {
      setBatchError(friendlyError(result.error))
      return
    }
    await Promise.all([
      refetchLibrary({ requestPolicy: 'network-only' }),
      // The counts on the Settings rows come from this query, and one of them just changed.
      refetchCategories({ requestPolicy: 'network-only' }),
    ])
    const name = categories.find((category) => category.id === categoryId)?.name ?? t('that category')
    const count = t(ids.length === 1 ? '{count} title' : '{count} titles', { count: ids.length })
    setBatchNotice(action === 'add'
      ? t('Filed {what} into {name}.', { what: count, name })
      : t('Took {what} out of {name}.', { what: count, name }))
    leaveSelection()
  }

  // One request per title rather than one for everything: a source that returns nothing readable
  // should cost that title alone, exactly as the AniList refresh above reports per record.
  const markSelectedCaughtUp = async () => {
    const ids = [...selected]
    if (ids.length === 0 || batchRunning) return
    setBatchRunning(true)
    setBatchError(null)
    setBatchNotice(null)
    let caughtUp = 0
    let alreadyRead = 0
    let unbound = 0
    let failed = 0
    for (const entryId of ids) {
      const bound = boundByManga.get(entryId)
      const state = bound === undefined ? undefined : unreadByBound.get(bound)
      if (!state) {
        unbound += 1
        continue
      }
      // Chapters the source could not number come back as -1; they are not "behind" anything and
      // are left alone, the same rule the source switch uses.
      const chapterIds = state.chapters.filter((chapter) => !chapter.isRead && chapter.chapterNumber > 0).map((chapter) => chapter.id)
      if (chapterIds.length === 0) {
        alreadyRead += 1
        continue
      }
      const result = await markChaptersRead({ ids: chapterIds })
      if (result.error) failed += 1
      else caughtUp += 1
    }
    await refetchUnread({ requestPolicy: 'network-only' })
    setBatchRunning(false)
    const notes = [
      caughtUp > 0 ? t('{count} caught up', { count: caughtUp }) : null,
      alreadyRead > 0 ? t('{count} already read', { count: alreadyRead }) : null,
      unbound > 0 ? t('{count} without a chapter source', { count: unbound }) : null,
    ].filter((note) => note !== null)
    if (notes.length > 0) setBatchNotice(t('{notes}.', { notes: notes.join(' · ') }))
    if (failed > 0) {
      setBatchError(t(failed === 1
        ? '{count} title could not be marked read. Try again.'
        : '{count} titles could not be marked read. Try again.', { count: failed }))
    }
    leaveSelection()
  }

  // Asks the destination catalogue what it has under each selected title, and proposes the best
  // answer. Nothing is bound here: a search that rebound as it went would be a batch with no way
  // back, and the sources disagree often enough — "Ms. Mystic" / "MISS MYSTIC" — that the matches
  // have to be looked at before they are taken.
  const findMigrationMatches = async () => {
    const ids = [...selected]
    if (ids.length === 0 || !migrateTarget || batchRunning) return
    setBatchRunning(true)
    setBatchError(null)
    setBatchNotice(null)
    setMigrateMatches(null)
    setMigrateState({ done: 0, total: ids.length })
    const found: MigrateMatch[] = []
    for (const [index, entryId] of ids.entries()) {
      const item = entryById.get(entryId)
      const title = item?.title ?? `Manga ${entryId}`
      // One title at a time, for the sweep's reason: a dozen searches fired at one catalogue at once
      // is how it starts rate-limiting us, and this is never the urgent kind of work.
      const result = await fetchSourceMangaBulk({ sources: [migrateTarget.id], page: 1, query: title })
      const answer = result.data?.fetchSourceMangaBulk?.results?.[0]
      const mangas = answer?.mangas ?? []
      // The same ranking and the same threshold the detail page's picker trusts: relevantTitleMatches
      // sorts identically, so a non-empty result means the top hit cleared the bar. Below it the row
      // still shows what was found — it just starts unticked, because that is the one the reader has
      // to actually look at.
      const match = sortByTitleSimilarity(title, mangas)[0] ?? null
      const confident = relevantTitleMatches(title, mangas).length > 0
      found.push({
        entryId,
        title,
        fromSource: unreadByBound.get(boundByManga.get(entryId) ?? -1)?.source?.name ?? null,
        match,
        confident,
        chosen: match !== null && confident,
        error: result.error ? friendlyError(result.error) : answer?.error ?? undefined,
      })
      setMigrateState({ done: index + 1, total: ids.length })
    }
    setMigrateState(null)
    setBatchRunning(false)
    setMigrateMatches(found)
  }

  const toggleMigrateRow = (entryId: number) => {
    setMigrateMatches((rows) => rows?.map((row) => row.entryId === entryId ? { ...row, chosen: !row.chosen } : row) ?? null)
  }

  // Rebinds the ticked rows one at a time, carrying read progress across exactly as a single rebind
  // on the detail page does: everything the outgoing source had read through is marked read on the
  // incoming one. A source that will not answer for one title costs that title alone.
  const migrateSelected = async () => {
    const rows = (migrateMatches ?? []).filter((row) => row.chosen && row.match)
    if (rows.length === 0 || !migrateTarget || batchRunning) return
    setBatchRunning(true)
    setBatchError(null)
    setBatchNotice(null)
    setMigrateState({ done: 0, total: rows.length })
    let moved = 0
    let carried = 0
    let unchanged = 0
    const failed: string[] = []
    /** Rebound, but the new source would not list its chapters — so no counts and no carry-over. */
    const unlisted: string[] = []
    for (const [index, row] of rows.entries()) {
      const match = row.match
      if (!match) continue
      if (boundByManga.get(row.entryId) === match.id) {
        unchanged += 1
        setMigrateState({ done: index + 1, total: rows.length })
        continue
      }
      // Taken before the binding moves: once it has, this entry's read-through would be read off a
      // catalogue that has never been opened. AniList is folded in the same way the detail page
      // folds it, so a title whose chapters were never flagged read locally still carries.
      const item = entryById.get(row.entryId)
      const readThrough = item ? boundEntryFor(item).lastChapterRead : 0
      // A title added straight from Discover *is* a row on some catalogue, so the destination can
      // answer with the entry itself. Reading from your own catalogue is what having no binding
      // means — writing your own id as your binding would invent a state the rest of the app has
      // never had to understand.
      const saved = match.id === row.entryId
        ? await dropSourceBinding({ mangaId: row.entryId })
        : await saveSourceBinding({ mangaId: row.entryId, boundMangaId: String(match.id) })
      if (saved.error) {
        failed.push(row.title)
        setMigrateState({ done: index + 1, total: rows.length })
        continue
      }
      // The browser-only fallback is kept in step with the meta, the way the detail page's rebind
      // does, so a browser that saw the old binding does not go on offering it.
      if (match.id === row.entryId) clearSourceBinding(row.entryId)
      else setSourceBinding(row.entryId, match.id)
      moved += 1
      // The same call the sweep makes, and it runs whether or not there is progress to carry: the
      // incoming source's chapters are what every card counts unread against, and a title rebound
      // to a catalogue nobody has asked for a chapter list yet sits on the shelf with no chip and
      // no total until it is opened. When there *is* a read-through, the same answer says which of
      // those chapters sit at or below it.
      const fetched = await fetchChapters({ mangaId: match.id })
      const chapters = fetched.data?.fetchChapters?.chapters
      if (!chapters) unlisted.push(row.title)
      else if (readThrough > 0) {
        // Chapters the source could not number come back as -1, and every one of those is "at or
        // below" any read-through — they must not be swept up as read.
        const chapterIds = chapters
          .filter((chapter) => !chapter.isRead && chapter.chapterNumber > 0 && chapter.chapterNumber <= readThrough)
          .map((chapter) => chapter.id)
        if (chapterIds.length > 0) {
          const marked = await markChaptersRead({ ids: chapterIds })
          if (marked.error) unlisted.push(row.title)
          else carried += chapterIds.length
        }
      }
      setMigrateState({ done: index + 1, total: rows.length })
    }
    await Promise.all([
      refetchLibrary({ requestPolicy: 'network-only' }),
      refetchUnread({ requestPolicy: 'network-only' }),
    ])
    setMigrateState(null)
    setBatchRunning(false)
    const notes = [
      moved > 0
        ? t(moved === 1 ? 'Moved {count} title to {source}' : 'Moved {count} titles to {source}', { count: moved, source: migrateTarget.name })
        : t('Nothing moved'),
      carried > 0
        ? t(carried === 1 ? '{count} chapter marked read' : '{count} chapters marked read', { count: carried })
        : null,
      unlisted.length > 0 ? t('no chapter list yet for {names}', { names: unlisted.join(', ') }) : null,
      unchanged > 0 ? t('{count} already there', { count: unchanged }) : null,
      failed.length > 0 ? t('{count} could not be moved ({names})', { count: failed.length, names: failed.join(', ') }) : null,
    ].filter((note) => note !== null)
    // One line rather than a notice plus an error, for the sweep's reason: a partial failure is a
    // normal outcome across a dozen titles, and the count of what *did* move is exactly what gets
    // lost by hiding the summary behind an error.
    setBatchNotice(t('{notes}.', { notes: notes.join(' · ') }))
    leaveSelection()
  }

  // The number on the cover, and the key the unread order sorts by. One derivation for both, so a
  // shelf sorted by unread cannot disagree with the chips it is showing.
  const unreadFor = (item: LibraryManga): number | null => {
    const progress = anilistRecord(item)
    const bound = unreadByBound.get(boundByManga.get(item.id) ?? -1)
    // Prefer the bound source, but reconcile its chapters with AniList progress the same way the
    // detail page does: a chapter counts as read if the DB flagged it OR it sits at/below the
    // AniList read-through, so a source whose chapters were never marked read does not report
    // every chapter as unread.
    if (bound) {
      const readThrough = Math.max(progress?.lastChapterRead ?? 0, bound.progress, bound.localReadThrough)
      return bound.chapterNumbers.filter((chapterNumber) => chapterNumber > readThrough).length
    }
    // Titles not bound to a source yet fall back to AniList (total − read).
    return progress && progress.totalChapters > 0
      ? Math.max(0, progress.totalChapters - Math.floor(progress.lastChapterRead))
      : null
  }

  // Every order but title sorts on a number, and a title with nothing to report counts as 0 rather
  // than being left out: a sort that dropped the titles with no source behind them would be a
  // filter wearing a sort's clothes.
  const sortValue = (item: LibraryManga): number => {
    switch (sort.order) {
      case 'added': return Number(item.inLibraryAt) || 0
      case 'unread': return unreadFor(item) ?? 0
      case 'lastRead': return unreadByBound.get(boundByManga.get(item.id) ?? -1)?.lastReadAt ?? 0
      default: return 0
    }
  }

  // Ties break on the title, so every order is total. Without it a shelf sorted by unread would fall
  // back to the order the rows happened to arrive in, which is the arbitrary order this replaces.
  const sortLibrary = (items: LibraryManga[]): LibraryManga[] => {
    const direction = sort.direction === 'asc' ? 1 : -1
    return [...items].sort((a, b) => {
      const primary = sort.order === 'title' ? a.title.localeCompare(b.title) : sortValue(a) - sortValue(b)
      return primary !== 0 ? primary * direction : a.title.localeCompare(b.title)
    })
  }

  if (fetching) return <div className="state-panel"><p>{t('Loading your shelves…')}</p></div>
  if (error) return <div className="state-panel error"><h2>{t('Library unavailable')}</h2><p>{friendlyError(error)}</p></div>

  // Sorted once, before the shelves are cut out of it: filtering and grouping both keep their input
  // order, so one sort covers the status shelves and the category shelves alike.
  const manga = sortLibrary(deduplicateLibrary(data?.mangas.nodes ?? [])
    .filter((item) => anilistRecord(item)?.status !== COMPLETED_STATUS))
  const groups = manga.reduce<Record<string, LibraryManga[]>>((result, item) => {
    const anilist = anilistRecord(item)
    const label = anilist ? statusNames[anilist.status] ?? 'Other' : 'Other'
    ;(result[label] ??= []).push(item)
    return result
  }, {})
  // Membership is read off the card's own entry. A series can have several library rows, and
  // deduplicateLibrary has already picked the one that knows the most about it — that is the row the
  // cover stands for and the row a batch action files.
  const shelves: Shelf[] = grouping === 'category'
    ? [
      ...categories.map((category) => ({
        key: `category-${category.id}`,
        label: category.name,
        items: manga.filter((item) => item.categories.nodes.some((node) => node.id === category.id)),
      })),
      { key: 'category-default', label: 'Default', items: manga.filter((item) => item.categories.nodes.length === 0) },
    ]
    : statusOrder.map((status) => ({ key: status, label: status, items: groups[status] ?? [] }))
  const availableShelves = shelves.filter((shelf) => shelf.items.length > 0)
  const shelfVisible = (key: string) => grouping === 'category'
    ? !hiddenShelves.includes(key)
    : isShelfStatus(key) && selectedShelves.includes(key)
  // The chips are the genres the library actually carries, commonest first — a shelf of a few
  // hundred titles has more of them than fit on a line, and the ones almost nothing is tagged with
  // are the ones worth scrolling for. A title tagged "Action" twice by its source still counts once.
  const genreCounts = new Map<string, number>()
  for (const item of manga) {
    for (const genre of new Set(item.genre)) genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1)
  }
  const genres = [...genreCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([genre]) => genre)

  const needle = searchKey(search.trim())
  const filtering = needle !== '' || genreFilters.length > 0
  // Every chosen chip has to hold, not just one of them: each tap is meant to narrow what is left,
  // and a union would widen it instead.
  const matchesFilter = (item: LibraryManga) =>
    genreFilters.every((genre) => item.genre.includes(genre))
    && (needle === ''
      || searchKey(item.title).includes(needle)
      || titleInitials(item.title).startsWith(needle)
      || (item.author !== null && searchKey(item.author).includes(needle)))

  // Shelf visibility says which shelves are on the page and the filter says which of their titles
  // are, both reading the one sorted list rather than each deriving its own. A shelf the filter
  // empties leaves with its titles: a heading over nothing is not an answer to a search.
  const visibleShelves = availableShelves
    .filter((shelf) => shelfVisible(shelf.key))
    .map((shelf) => filtering ? { ...shelf, items: shelf.items.filter(matchesFilter) } : shelf)
    .filter((shelf) => shelf.items.length > 0)
  const visibleCount = visibleShelves.reduce((count, shelf) => count + shelf.items.length, 0)

  const clearFilter = () => {
    setSearch('')
    setGenreFilters([])
  }
  const toggleGenre = (genre: string) => {
    setGenreFilters((chosen) => chosen.includes(genre) ? chosen.filter((name) => name !== genre) : [...chosen, genre])
  }

  const toggleShelf = (key: string) => {
    if (grouping === 'category') {
      const next = hiddenShelves.includes(key) ? hiddenShelves.filter((hidden) => hidden !== key) : [...hiddenShelves, key]
      setHiddenShelves(next)
      return
    }
    if (!isShelfStatus(key)) return
    const next = selectedShelves.includes(key)
      ? selectedShelves.filter((status) => status !== key)
      : statusOrder.filter((candidate) => [...selectedShelves, key].includes(candidate))
    setSelectedShelves(next)
  }

  const chooseGrouping = setGroupingPreference

  // Picking the order already in force is what reverses it — the second press of the plan — while
  // picking a different one starts it at the end that order is normally read from.
  const chooseSort = (order: SortOrder) => {
    const natural = SORT_ORDERS.find((option) => option.order === order)?.natural ?? 'asc'
    const next: LibrarySort = sort.order === order
      ? { order, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
      : { order, direction: natural }
    setSort(next)
  }
  const activeSort = SORT_ORDERS.find((option) => option.order === sort.order) ?? SORT_ORDERS[0]
  const sortSummary = `${t(activeSort.label)} · ${t(activeSort.ends[sort.direction])}`

  if (manga.length === 0) {
    return (
      <section className="state-panel empty">
        <span className="eyebrow">{t('Your first shelf')}</span>
        <h1>{t('Your library is empty.')}</h1>
        <p>{t('Head to Discover, pick a source, and add titles to start reading.')}</p>
        <Link className="button primary" to="/search">{t('Discover manga')}</Link>
      </section>
    )
  }

  return (
    <div className="library-page">
      <header className="library-header">
        <div className="library-titlebar">
          <div><span className="eyebrow">{t('AniList library')}</span><h1>{t('Your shelves')}</h1></div>
          <div className="library-toolbar">
            {/* The one control here that is not a glyph, because there is nothing for a glyph to
                stand in for: the field's content *is* the message. Its readout is the count beside
                it, which already switches to "shown / total" the moment anything is hidden. */}
            <div className="library-search">
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="6.5" />
                <path d="m16 16 4.5 4.5" />
              </svg>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('Find a title')}
                aria-label={t('Find a title by name or author')}
              />
              {search !== '' && (
                <button
                  type="button"
                  className="library-search-clear"
                  onClick={() => setSearch('')}
                  aria-label={t('Clear the search')}
                  title={t('Clear the search')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              )}
            </div>
            <span className="library-count">{visibleCount === manga.length ? t('{count} titles', { count: manga.length }) : `${visibleCount} / ${manga.length}`}</span>
            {/* The trigger is icon-only like its neighbours, but the orders themselves are named:
                four of them cannot be four presses of one button, and a list of real choices reads
                as words. The menu deliberately stays open after a choice — the second press on the
                order already in force is what reverses it, and that gesture has to be reachable
                without reopening the menu to be found at all.

                It is a disclosure, not a `role="menu"`: that role promises roving tabindex, arrow
                keys and typeahead, and one that does not keep the promise is worse than none. A
                group of buttons is reached with Tab, which is what these already are. */}
            <div
              className="library-sort"
              ref={sortRef}
              // Tabbing off the last order leaves the menu behind otherwise. The relatedTarget guard
              // keeps it open when the whole window loses focus, which is not the user leaving it.
              onBlur={(event) => {
                if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setSortOpen(false)
              }}
            >
              <button
                type="button"
                ref={sortTriggerRef}
                className={`library-sync-button library-select-button${sortOpen ? ' active' : ''}`}
                onClick={() => setSortOpen((open) => !open)}
                aria-expanded={sortOpen}
                aria-label={t('Sort titles, currently {order}, {end}', { order: t(activeSort.label), end: t(activeSort.ends[sort.direction]) })}
                title={t('Sorted by {summary}', { summary: sortSummary })}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7h10M4 12h7M4 17h4" />
                  {/* The arrow reports the direction rather than decorating the button: it is the
                      only place the reversal shows up in the toolbar once the menu is closed. */}
                  <path d={sort.direction === 'desc' ? 'M17.5 5v14m0 0 3-3m-3 3-3-3' : 'M17.5 19V5m0 0 3 3m-3-3-3 3'} />
                </svg>
              </button>
              {sortOpen && (
                <div className="library-sort-menu" role="group" aria-label={t('Sort titles')}>
                  {SORT_ORDERS.map((option) => {
                    const active = option.order === sort.order
                    const flipped = sort.direction === 'asc' ? 'desc' : 'asc'
                    // Only the chosen row states a direction. Four rows each showing one would read
                    // as four facts about the library instead of one fact and three offers — and a
                    // screen reader, which has no highlight to go by, would hear every one of them
                    // as the order currently in force.
                    return (
                      <button
                        type="button"
                        key={option.order}
                        className={`library-sort-option${active ? ' active' : ''}${active && sort.direction === 'asc' ? ' ascending' : ''}`}
                        aria-pressed={active}
                        aria-label={active
                          ? t('Sorted by {order}, {end}. Press again to reverse to {other}', {
                            order: t(option.label),
                            end: t(option.ends[sort.direction]),
                            other: t(option.ends[flipped]),
                          })
                          : t('Sort by {order}, {end}', { order: t(option.label), end: t(option.ends[option.natural]) })}
                        title={active
                          ? t('Reverse to {end}', { end: t(option.ends[flipped]) })
                          : t('Sort {end}', { end: t(option.ends[option.natural]).toLocaleLowerCase() })}
                        onClick={() => chooseSort(option.order)}
                      >
                        <span>{t(option.label)}</span>
                        {active && (
                          <small>
                            {t(option.ends[sort.direction])}
                            <svg viewBox="0 0 24 24" aria-hidden="true" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 4v16m0 0 5-5m-5 5-5-5" />
                            </svg>
                          </small>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
              {/* The grid reorders behind the menu with nothing else to announce it. */}
              <span className="visually-hidden" role="status">{t('Sorted by {summary}', { summary: sortSummary })}</span>
            </div>
            {/* Absent until there is a category to group by, which is also why it can be a single
                toggle rather than a picker: there are only ever two ways to arrange the shelves. */}
            {categories.length > 0 && (
              <button
                type="button"
                className={`library-sync-button library-select-button${grouping === 'category' ? ' active' : ''}`}
                onClick={() => chooseGrouping(grouping === 'category' ? 'status' : 'category')}
                aria-pressed={grouping === 'category'}
                aria-label={grouping === 'category' ? t('Group shelves by AniList status') : t('Group shelves by category')}
                title={grouping === 'category' ? t('Grouped by category') : t('Grouped by AniList status')}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4.6 12.6 12 5.2h6.8V12l-7.4 7.4a1.6 1.6 0 0 1-2.3 0l-4.5-4.5a1.6 1.6 0 0 1 0-2.3Z" />
                  <path d="M15.5 8.5h.01" />
                </svg>
              </button>
            )}
            <button
              type="button"
              className={`library-sync-button library-select-button${selecting ? ' active' : ''}`}
              onClick={() => { if (selecting) leaveSelection(); else { setSelecting(true); setBatchNotice(null); setBatchError(null) } }}
              disabled={batchRunning}
              aria-pressed={selecting}
              aria-label={selecting ? t('Leave selection mode') : t('Select several titles')}
              title={selecting ? t('Cancel selection') : t('Select titles')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4.5 5.5h9M4.5 12h9M4.5 18.5h9" />
                <path d="m17 5 1.6 1.6L22 3.2M17 18l1.6 1.6L22 16.2" />
              </svg>
            </button>
            {/* Held until the bound sources' chapters are in: "new" is measured against that count,
                and sweeping before it arrives would measure against zero and report every chapter
                the library already has as new. */}
            <button
              type="button"
              className={`library-sync-button${updateState ? ' loading' : ''}`}
              onClick={checkForNewChapters}
              disabled={updateState !== null || sweepIds.length === 0 || !unreadData}
              aria-label={updateState
                ? t('Checking source {done} of {total} for new chapters', { done: updateState.done, total: updateState.total })
                : t('Check sources for new chapters')}
              title={updateState ? t('Checking {done}/{total}', { done: updateState.done, total: updateState.total }) : t('Check for new chapters')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 17.5a4.5 4.5 0 0 1-.7-8.95 6 6 0 0 1 11.55 1.5A3.75 3.75 0 0 1 17.4 17.5" />
                <path d="M12 11v8m0 0 2.6-2.6M12 19l-2.6-2.6" />
              </svg>
            </button>
            <button
              type="button"
              className={`library-sync-button${syncState ? ' loading' : ''}`}
              onClick={refreshFromAniList}
              disabled={syncState !== null}
              aria-label={syncState
                ? t('Syncing {done} of {total} from AniList', { done: syncState.done, total: syncState.total })
                : t('Refresh progress from AniList')}
              title={syncState ? t('Syncing {done}/{total}', { done: syncState.done, total: syncState.total }) : t('Refresh from AniList')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 4v5h-5" />
                <path d="M3 20v-5h5" />
                <path d="M19 9a8 8 0 0 0-14-3L3 9M21 15l-2 3a8 8 0 0 1-14-3" />
              </svg>
            </button>
          </div>
        </div>
        <div className="library-filterbar" role="group" aria-label={t('Filter shelves')}>
          {availableShelves.map((shelf) => {
            const active = shelfVisible(shelf.key)
            return (
              <button
                type="button"
                key={shelf.key}
                className={`library-filter-tab${active ? ' active' : ''}`}
                aria-pressed={active}
                onClick={() => toggleShelf(shelf.key)}
              >
                {t(shelf.label)} <small>{shelf.items.length}</small>
              </button>
            )
          })}
          {syncError && <span className="inline-error library-sync-error">{syncError}</span>}
        </div>
        {/* One row that scrolls sideways rather than a block that wraps: a few hundred titles carry
            more genres than fit across the page, and letting them wrap would push the shelves off
            the bottom of it. The names are the source's own words, so they are not translated —
            only counted, ordered and matched. */}
        {genres.length > 0 && (
          <div className="library-genres" role="group" aria-label={t('Filter by genre')}>
            {genres.map((genre) => {
              const active = genreFilters.includes(genre)
              return (
                <button
                  type="button"
                  key={genre}
                  className={`library-genre-chip${active ? ' active' : ''}`}
                  aria-pressed={active}
                  onClick={() => toggleGenre(genre)}
                  title={active ? t('Stop filtering by {genre}', { genre }) : t('Show only titles tagged {genre}', { genre })}
                >
                  {genre}
                </button>
              )
            })}
          </div>
        )}
      </header>
      {(batchNotice || batchError || syncNotice || updateNotice) && !selecting && (
        <div className={`notice library-batch-notice${batchError || (updateNotice && updateError) ? ' error' : ''}`}>
          {batchError ?? batchNotice ?? updateNotice ?? syncNotice}
        </div>
      )}
      {/* The same card the continue-reading shelf is made of, because this is the same object: a
          chapter, its cover, and a way straight into it. A shape of its own would have said these
          were a different kind of thing. */}
      {foundChapters.length > 0 && (
        <section className="shelf recent-shelf found-shelf">
          <div className="recent-heading">
            <div>
              <span className="eyebrow">{t('Found by the last check')}</span>
              <h2>{t('New chapters')}</h2>
            </div>
            <span>{t(foundChapters.length === 1 ? '{count} chapter' : '{count} chapters', { count: foundChapters.length })}</span>
          </div>
          <div className="recent-grid">
            {foundChapters.map((found) => {
              const { chapter } = found
              const published = formatUploadDate(chapter.uploadDate)
              // Back belongs on the library entry only when the chapter came off the source that
              // entry reads from — which, here, it always did: the sweep only ever asks bound
              // sources. An entry that is its own source needs no detour.
              const target = `/manga/${found.mangaId}/chapter/${chapter.sourceOrder}${found.entryId === found.mangaId ? '' : `?from=${found.entryId}`}`
              // The card carries title, chapter and date; the scanlation behind it is what tells two
              // otherwise identical rows apart, so it goes in the tooltip rather than being dropped.
              const hint = chapter.scanlator
                ? t('{title} · {chapter} · {scanlator}', { title: found.title, chapter: chapter.name, scanlator: chapter.scanlator })
                : t('{title} · {chapter}', { title: found.title, chapter: chapter.name })
              return (
                <div key={`${found.mangaId}-${chapter.id}`} className="recent-cell">
                  <Link to={target} className="recent-item" title={hint}>
                    {found.thumbnailUrl
                      ? <img src={found.thumbnailUrl} alt="" loading="lazy" />
                      : <div className="cover-placeholder" />}
                    <div className="recent-copy">
                      <strong>{found.title}</strong>
                      <small>{chapter.name}</small>
                      {published && <time dateTime={published.iso} title={published.full}>{published.label}</time>}
                    </div>
                  </Link>
                </div>
              )
            })}
          </div>
        </section>
      )}
      {selecting && (
        <div className="library-batch-bar" role="group" aria-label={t('Actions for the selected titles')}>
          <span className="library-batch-count">{t('{count} selected', { count: selected.size })}</span>
          {confirmingRemove ? (
            <>
              <span className="library-batch-question">{t(selected.size === 1
                ? 'Remove {count} title from your library?'
                : 'Remove {count} titles from your library?', { count: selected.size })}</span>
              <button type="button" className="button danger" onClick={removeSelected} disabled={batchRunning}>{t('Remove')}</button>
              <button type="button" className="button quiet" onClick={() => setConfirmingRemove(false)} disabled={batchRunning}>{t('Keep them')}</button>
            </>
          ) : filing ? (
            <>
              <select
                className="library-batch-select"
                value={filingCategory ?? ''}
                onChange={(event) => setFilingCategory(Number(event.target.value))}
                aria-label={t('Category to file into')}
                disabled={batchRunning}
              >
                {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
              <button type="button" className="button quiet" onClick={() => fileSelected('add')} disabled={selected.size === 0 || batchRunning}>
                {batchRunning ? t('Working…') : t('Add')}
              </button>
              <button type="button" className="button quiet" onClick={() => fileSelected('remove')} disabled={selected.size === 0 || batchRunning}>
                {t('Take out')}
              </button>
              <button type="button" className="button quiet" onClick={() => setFiling(false)} disabled={batchRunning}>{t('Back')}</button>
            </>
          ) : migrating ? (
            <>
              <select
                className="library-batch-select"
                value={migrateSourceId ?? ''}
                onChange={(event) => { setMigrateSourceId(event.target.value); setMigrateMatches(null) }}
                aria-label={t('Source to move to')}
                disabled={batchRunning}
              >
                {migrateSources.map((source) => <option key={source.id} value={source.id}>{source.name} · {source.lang}</option>)}
              </select>
              <button
                type="button"
                className="button quiet"
                onClick={findMigrationMatches}
                disabled={selected.size === 0 || batchRunning || !migrateTarget}
              >
                {migrateState && !migrateMatches
                  ? t('Searching {done}/{total}…', { done: migrateState.done, total: migrateState.total })
                  : t('Find matches')}
              </button>
              <button type="button" className="button quiet" onClick={() => { setMigrating(false); setMigrateMatches(null) }} disabled={batchRunning}>{t('Back')}</button>
            </>
          ) : (
            <>
              <button type="button" className="button quiet" onClick={markSelectedCaughtUp} disabled={selected.size === 0 || batchRunning}>
                {batchRunning ? t('Working…') : t('Mark caught up')}
              </button>
              {categories.length > 0 && (
                <button
                  type="button"
                  className="button quiet"
                  onClick={() => { setFiling(true); setFilingCategory(filingCategory ?? categories[0].id) }}
                  disabled={selected.size === 0 || batchRunning}
                >
                  {t('File into…')}
                </button>
              )}
              <button
                type="button"
                className="button quiet"
                onClick={() => { setMigrating(true); setMigrateSourceId(migrateSourceId ?? migrateSources[0]?.id ?? null) }}
                disabled={selected.size === 0 || batchRunning || migrateSources.length === 0}
              >
                {t('Change source…')}
              </button>
              <button type="button" className="button quiet" onClick={() => setConfirmingRemove(true)} disabled={selected.size === 0 || batchRunning}>
                {t('Remove from library')}
              </button>
            </>
          )}
          <button
            type="button"
            className="button quiet library-batch-close"
            onClick={leaveSelection}
            disabled={batchRunning}
            aria-label={t('Leave selection mode')}
            title={t('Cancel')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      )}
      {/* The one place on this page that is prose rather than icons: these are real choices about
          real titles, and a row of glyphs cannot say "this is the match it found, and it is not a
          confident one". */}
      {selecting && migrating && migrateMatches && migrateTarget && (
        <div className="library-migrate-panel">
          <p>{t('The best match {source} has for each title. Ticked titles will read from it instead, and everything read on the old source is marked read on the new one.', { source: migrateTarget.name })}</p>
          <ul>
            {migrateMatches.map((row) => (
              <li key={row.entryId} className={row.match ? '' : 'library-migrate-empty'}>
                <label>
                  <input
                    type="checkbox"
                    checked={row.chosen}
                    disabled={!row.match || batchRunning}
                    onChange={() => toggleMigrateRow(row.entryId)}
                  />
                  <span className="library-migrate-title">
                    {row.title}
                    <small>{row.fromSource ?? t('no source yet')}</small>
                  </span>
                </label>
                <span className="library-migrate-match">
                  {row.match
                    ? <><strong>{row.match.title}</strong>{!row.confident && <small className="library-migrate-loose">{t('check this one')}</small>}</>
                    : <em>{row.error ?? t('Nothing found here')}</em>}
                </span>
              </li>
            ))}
          </ul>
          <div className="library-migrate-actions">
            <button
              type="button"
              className="button primary"
              onClick={migrateSelected}
              disabled={batchRunning || migrateMatches.every((row) => !row.chosen || !row.match)}
            >
              {migrateState
                ? t('Moving {done}/{total}…', { done: migrateState.done, total: migrateState.total })
                : t('Move {count} to {source}', { count: migrateMatches.filter((row) => row.chosen && row.match).length, source: migrateTarget.name })}
            </button>
            <button type="button" className="button quiet" onClick={() => setMigrateMatches(null)} disabled={batchRunning}>{t('Cancel')}</button>
          </div>
        </div>
      )}
      <ContinueReadingShelf
        libraryByBound={libraryByBound}
        libraryByRemote={libraryByRemote}
        libraryByTitle={libraryByTitle}
        selecting={selecting}
      />
      {visibleShelves.map((shelf) => (
        <section className="shelf" key={shelf.key}>
          <div className="shelf-heading"><h2>{t(shelf.label)}</h2><span>{shelf.items.length}</span></div>
          <div className="grid">
            {shelf.items.map((item) => {
              const progress = anilistRecord(item)
              const bound = unreadByBound.get(boundByManga.get(item.id) ?? -1)
              const unread = unreadFor(item)
              const checked = selected.has(item.id)
              // The same source the detail page names: the bound catalogue when there is one,
              // otherwise the entry's own — and only when that own catalogue actually carries
              // chapters, since an orphan's source is a dead end not worth badging.
              const source = bound?.source ?? (item.chapters.totalCount > 0 ? item.source : null)
              const cover = (
                <>
                  <div className="cover-wrap">
                    {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" /> : <div className="cover-placeholder" />}
                    {selecting && (
                      <span className="select-marker" aria-hidden="true">
                        {checked && (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m5 12.5 4.5 4.5L19 7.5" />
                          </svg>
                        )}
                      </span>
                    )}
                    {unread !== null && unread > 0 && (
                      <span
                        className="unread-chip"
                        title={t('{count} unread', { count: unread })}
                        aria-label={t(unread === 1 ? '{count} unread chapter' : '{count} unread chapters', { count: unread })}
                      >{unread}</span>
                    )}
                    {progress && (() => {
                      const latestChapter = bound?.latestChapter ?? 0
                      const total = chapterTotalLabel(progress.totalChapters, latestChapter, progress.lastChapterRead, hasFinishedPublishing(item.status, bound?.sourceStatus))
                      const read = Math.floor(progress.lastChapterRead)
                      return (
                        <span
                          className="progress-chip"
                          title={total.provisional
                            ? t('{read} read · {available} available (series still running)', { read, available: formatChapterNumber(latestChapter) })
                            : undefined}
                        >
                          {read} / {total.label}
                        </span>
                      )
                    })()}
                  </div>
                  <div className="title">{item.title}</div>
                  {/* Under the title rather than over the cover: the bottom of the cover is already
                      taken by the progress chip, and a source name squeezed beside it truncates to
                      "Weeb …", which tells the reader nothing. */}
                  {source && (
                    <div className="card-source" title={t('Chapters from {source}', { source: source.name })}>
                      {source.iconUrl && <img src={source.iconUrl} alt="" loading="lazy" />}
                      <span>{source.name}</span>
                    </div>
                  )}
                </>
              )
              // In selection mode the cover stops being a way into the title and becomes the
              // checkbox itself, so it must not navigate away mid-selection.
              return selecting ? (
                <button
                  key={item.id}
                  type="button"
                  className={`card card-selectable${checked ? ' selected' : ''}`}
                  aria-pressed={checked}
                  aria-label={checked ? t('Deselect {title}', { title: item.title }) : t('Select {title}', { title: item.title })}
                  onClick={() => toggleSelected(item.id)}
                >
                  {cover}
                </button>
              ) : (
                <Link key={item.id} to={`/manga/${item.id}`} className="card">{cover}</Link>
              )
            })}
          </div>
        </section>
      ))}
      {/* A shelf emptied by a filter is not a shelf with nothing on it, and the old sentence read as
          the library having lost its titles. Name whichever filter did it and offer the way back,
          so the fix is in the same place as the news. */}
      {visibleCount === 0 && (filtering ? (
        <div className="state-panel compact">
          <p>
            {needle !== '' && genreFilters.length > 0
              ? t('No title tagged {genres} matches “{query}”.', { genres: genreFilters.join(', '), query: search.trim() })
              : needle !== ''
                ? t('No title matches “{query}”.', { query: search.trim() })
                : t('No title is tagged {genres}.', { genres: genreFilters.join(', ') })}
          </p>
          <button type="button" className="button quiet" onClick={clearFilter}>{t('Clear the filter')}</button>
        </div>
      ) : (
        <div className="state-panel compact"><p>{t('There are no titles on this shelf.')}</p></div>
      ))}
    </div>
  )
}
