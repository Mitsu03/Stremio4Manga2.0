import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useClient, useMutation, useQuery } from 'urql'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { htmlToPlainText } from '../utils/html'
import { friendlyError } from '../utils/errors'
import { t } from '../utils/i18n'
import { SET_NO_CHAPTERS_MUTATION } from '../utils/availability'
import { normalizeTitle, relevantTitleMatches, sortByTitleSimilarity } from '../utils/titleMatch'
import {
  clearSourceBinding as clearLocalSourceBinding,
  chapterViewFromMeta,
  legacyChapterView,
  type ChapterView,
  getSourceBinding,
  DEFAULT_CHAPTER_VIEW,
  SET_CHAPTER_VIEW_MUTATION,
  setSourceBinding,
  sourceBindingFromMeta,
  DELETE_SOURCE_BINDING_MUTATION,
  SET_SOURCE_BINDING_MUTATION,
} from '../utils/bindings'
import type { ChapterFilter, ChapterOrder } from '../utils/bindings'
import { chapterTotalLabel, formatChapterNumber, formatUploadDate, hasFinishedPublishing } from '../utils/progress'
import {
  browsableSources,
  INITIAL_SOURCE_COUNT,
  preferredSourcePerName,
  PSEUDO_SOURCE_IDS,
  prioritizedSources,
  recommendedSources,
  SOURCES_QUERY,
} from '../utils/sources'
import type { SourceNode } from '../utils/sources'
import { readSourceSearchCache, useSourceSearch } from '../utils/sourceSearch'
import type { SearchScope } from '../utils/sourceSearch'
import {
  cleanupReassurance,
  DELETE_DOWNLOADS_MUTATION,
  DEQUEUE_DOWNLOADS_MUTATION,
  ENQUEUE_DOWNLOADS_MUTATION,
  START_DOWNLOADER_MUTATION,
  cleanupQuestion,
  describeDownload,
  queueByChapter,
  useDownloadQueue,
} from '../utils/downloads'

const MANGA_DETAIL_QUERY = `
  query MangaDetail($mangaId: Int!) {
    manga(id: $mangaId) {
      id title thumbnailUrl description author status inLibrary sourceId realUrl genre
      source { id name iconUrl }
      meta { key value }
      trackRecords {
        nodes { id mangaId trackerId remoteId title lastChapterRead totalChapters remoteUrl }
      }
    }
  }
`

const CHAPTERS_QUERY = `
  query MangaChapters($mangaId: Int!) {
    manga(id: $mangaId) {
      id
      meta { key value }
    }
    chapters(condition: { mangaId: $mangaId }, order: { by: SOURCE_ORDER }) {
      nodes { id name chapterNumber sourceOrder scanlator pageCount isRead isDownloaded isBookmarked uploadDate }
    }
  }
`

// The only call that fills in a manga's realUrl. The chapter fetch the page already makes runs
// `Manga.updateMangaAndChapters(mangaId, updateManga = false)` (ChapterMutation.kt:177), which is why
// every manga in the database has a null realUrl while every chapter has one: nothing had ever asked
// the source for the manga itself. fetchChapters is left false here — the chapter list is the
// ChapterList's business and re-fetching it from two places would be two requests for one list.
const FETCH_MANGA_DETAILS_MUTATION = `
  mutation FetchMangaDetails($mangaId: Int!) {
    fetchMangaAndChapters(input: { id: $mangaId, fetchManga: true, fetchChapters: false }) {
      manga { id realUrl }
    }
  }
`

const FETCH_CHAPTERS_MUTATION = `
  mutation FetchChapters($mangaId: Int!) {
    fetchChapters(input: { mangaId: $mangaId }) { chapters { id } }
  }
`

const FETCH_CHAPTER_PAGES_MUTATION = `
  mutation FetchChapterPages($chapterId: Int!) {
    fetchChapterPages(input: { chapterId: $chapterId }) {
      pages
      chapter { id pageCount }
    }
  }
`

// What the duplicate warning compares a new title against. Deliberately *not* wired into the page's
// own queries: this page is opened to read far more often than to add, and a library-wide query on
// every open would be paid by everyone to serve the one press that needs it. Fired from the heart
// button instead, where the cache does the rest — urql's document cache serves the repeat presses of
// a session, and any updateManga invalidates it, so the list cannot go stale behind an add.
const LIBRARY_TITLES_QUERY = `
  query LibraryTitles {
    mangas(condition: { inLibrary: true }) {
      nodes {
        id
        title
        thumbnailUrl
        meta { key value }
        trackRecords { nodes { trackerId remoteId lastChapterRead } }
      }
    }
  }
`

// Everything the warning says *about* a match lives on the manga it is read from rather than on the
// library row, which is usually an AniList-seeded stub with no source and no chapters. Asked only
// for the one or two entries a warning is actually about, and only once there is a warning.
const DUPLICATE_SOURCE_QUERY = `
  query DuplicateSources($ids: [Int!]!) {
    mangas(filter: { id: { in: $ids } }) {
      nodes {
        id
        source { name }
        chapters { nodes { chapterNumber isRead } }
        trackRecords { nodes { trackerId lastChapterRead } }
      }
    }
  }
`

const TOGGLE_LIBRARY_MUTATION = `
  mutation ToggleLibrary($mangaId: Int!, $inLibrary: Boolean!) {
    updateManga(input: { id: $mangaId, patch: { inLibrary: $inLibrary } }) { manga { id inLibrary } }
  }
`

// Marking chapters read this way deliberately leaves lastReadAt alone (the server only stamps it
// when lastPageRead is patched), so carrying progress over to a new source does not fabricate a
// dozen entries in the library's continue-reading shelf. It also does not touch the tracker, so it
// cannot push a lower progress back to AniList.
const UPDATE_CHAPTERS_READ_MUTATION = `
  mutation UpdateChaptersRead($ids: [Int!]!, $isRead: Boolean!) {
    updateChapters(input: { ids: $ids, patch: { isRead: $isRead } }) {
      chapters { id isRead }
    }
  }
`

// A mark on a chapter, and nothing else: `isBookmarked` is its own column, so marking a chapter
// leaves read state, progress and the tracker exactly where they were. Takes a list of ids rather
// than one, so the same call serves a row's own control and any future bulk action over a selection.
const UPDATE_CHAPTERS_BOOKMARK_MUTATION = `
  mutation UpdateChaptersBookmark($ids: [Int!]!, $isBookmarked: Boolean!) {
    updateChapters(input: { ids: $ids, patch: { isBookmarked: $isBookmarked } }) {
      chapters { id isBookmarked }
    }
  }
`

const ANILIST_TRACKER_QUERY = `
  query AniListTracker {
    tracker(id: 2) { id name icon isLoggedIn }
  }
`

const SEARCH_ANILIST_QUERY = `
  query SearchAniList($query: String!) {
    searchTracker(input: { trackerId: 2, query: $query }) {
      trackSearches { remoteId title coverUrl publishingStatus publishingType totalChapters trackingUrl }
    }
  }
`

const BIND_ANILIST_MUTATION = `
  mutation BindAniList($mangaId: Int!, $remoteId: LongString!) {
    bindTrack(input: { mangaId: $mangaId, trackerId: 2, remoteId: $remoteId }) {
      trackRecord { id mangaId trackerId remoteId title lastChapterRead totalChapters remoteUrl }
    }
  }
`

const BIND_ANILIST_RECORD_MUTATION = `
  mutation BindAniListRecord($mangaId: Int!, $trackRecordId: Int!) {
    bindTrackRecord(input: { mangaId: $mangaId, trackRecordId: $trackRecordId }) {
      trackRecord { id mangaId trackerId remoteId title lastChapterRead totalChapters remoteUrl }
    }
  }
`

const UNBIND_ANILIST_MUTATION = `
  mutation UnbindAniList($recordId: Int!) {
    unbindTrack(input: { recordId: $recordId, deleteRemoteTrack: false }) { trackRecord { id } }
  }
`

const FETCH_TRACK_MUTATION = `
  mutation FetchTrack($recordId: Int!) {
    fetchTrack(input: { recordId: $recordId }) {
      trackRecord { id mangaId trackerId remoteId title lastChapterRead totalChapters remoteUrl }
    }
  }
`

/** uploadDate is a GraphQL Long, so it arrives as a string of milliseconds — 0 when the source publishes no date. */
interface ChapterNode { id: number; name: string; chapterNumber: number; sourceOrder: number; scanlator: string | null; pageCount: number; isRead: boolean; isDownloaded: boolean; isBookmarked: boolean; uploadDate: string }
interface TrackRecord { id: number; mangaId: number; trackerId: number; remoteId: string; title: string; lastChapterRead: number; totalChapters: number; remoteUrl: string }
interface MangaDetail { id: number; title: string; thumbnailUrl: string | null; description: string | null; author: string | null; status: string; inLibrary: boolean; sourceId: string; realUrl: string | null; genre: string[]; source: { id: string; name: string; iconUrl: string | null } | null; meta: Array<{ key: string; value: string }>; trackRecords: { nodes: TrackRecord[] } }
interface FetchChapterPagesResult { fetchChapterPages: { pages: string[]; chapter: { id: number; pageCount: number } } | null }
/** A library row, with just enough of it to match a title and to describe the match afterwards. */
interface LibraryTitle {
  id: number
  title: string
  thumbnailUrl: string | null
  meta: Array<{ key: string; value: string }>
  trackRecords: { nodes: Array<{ trackerId: number; remoteId: string; lastChapterRead: number }> }
}
interface DuplicateSourceNode {
  id: number
  source: { name: string } | null
  chapters: { nodes: Array<{ chapterNumber: number; isRead: boolean }> }
  trackRecords: { nodes: Array<{ trackerId: number; lastChapterRead: number }> }
}
/** A library entry the title being added looks like, and the manga that entry is actually read from. */
interface DuplicateMatch { entry: LibraryTitle; readsFrom: number }
interface DuplicateSourceInfo { sourceName: string | null; unread: number }
interface AniListSearchResult { remoteId: string; title: string; coverUrl: string; publishingStatus: string; publishingType: string; totalChapters: number; trackingUrl: string }

const scanlatorOf = (chapter: ChapterNode): string => chapter.scanlator || 'Unknown'

// The manga a library row is read from: its bound source when it has one, itself when it does not.
// Same resolution the page makes for the title being viewed, meta first and the browser-only choice
// as a fallback.
function readingSourceOf(row: LibraryTitle): number {
  return sourceBindingFromMeta(row.meta) ?? getSourceBinding(row.id) ?? row.id
}

// One series holds several library rows — an AniList import and a source search each make their own
// — so the rows are collapsed into series before anything is compared, or adding a third copy of
// Sweet Home would warn about the same series twice over. Same identity `deduplicateLibrary` uses:
// the AniList id when a tracker has claimed the row, the normalised title when none has. The
// normaliser is the one `titleSimilarity` itself applies, so the grouping and the scoring cannot
// disagree about what one title is.
function librarySeries(rows: LibraryTitle[]): LibraryTitle[] {
  const series = new Map<string, LibraryTitle>()
  for (const row of rows) {
    const key = row.trackRecords.nodes.find((record) => record.trackerId === 2)?.remoteId || normalizeTitle(row.title)
    const found = series.get(key)
    // The bound row is the copy being read, so it is the one worth offering to open.
    if (!found || (readingSourceOf(row) !== row.id && readingSourceOf(found) === found.id)) series.set(key, row)
  }
  return [...series.values()]
}

// Lists the chapters of a given manga, fetching them from the source once if the DB has none.
// When a source returns several scanlator groups (duplicate chapter numbers), a filter lets the
// user pick one group; the choice is remembered per manga.
function ChapterList({ mangaId, anilistProgress = 0, anilistTotal = 0, finished = false, returnMangaId = mangaId, onEmpty, onLatestChapter, onLocalReadThrough }: { mangaId: number; anilistProgress?: number; anilistTotal?: number; finished?: boolean; returnMangaId?: number; onEmpty?: (empty: boolean) => void; onLatestChapter?: (latest: number) => void; onLocalReadThrough?: (readThrough: number) => void }) {
  const [{ data, fetching, error }, refetch] = useQuery<{ manga: { id: number; meta: Array<{ key: string; value: string }> } | null; chapters: { nodes: ChapterNode[] } }>({ query: CHAPTERS_QUERY, variables: { mangaId }, requestPolicy: 'cache-and-network' })
  const [chaptersResult, fetchChapters] = useMutation(FETCH_CHAPTERS_MUTATION)
  const [, setChapterView] = useMutation(SET_CHAPTER_VIEW_MUTATION)
  const [, fetchChapterPages] = useMutation<FetchChapterPagesResult>(FETCH_CHAPTER_PAGES_MUTATION)
  const attempted = useRef<number | null>(null)
  const chapters = useMemo(() => data?.chapters.nodes ?? [], [data])
  const { status: downloadStatus, queueKey, refresh: refreshQueue } = useDownloadQueue()
  const [, enqueueDownloads] = useMutation(ENQUEUE_DOWNLOADS_MUTATION)
  const [, dequeueDownloads] = useMutation(DEQUEUE_DOWNLOADS_MUTATION)
  const [, startDownloader] = useMutation(START_DOWNLOADER_MUTATION)
  const [, deleteDownloads] = useMutation(DELETE_DOWNLOADS_MUTATION)
  const [, updateChaptersBookmark] = useMutation(UPDATE_CHAPTERS_BOOKMARK_MUTATION)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [bookmarkError, setBookmarkError] = useState<string | null>(null)
  // Deleting several chapters' files at once asks first, the way removing titles from the library does.
  const [confirmingCleanup, setConfirmingCleanup] = useState(false)
  const queued = useMemo(() => queueByChapter(downloadStatus), [downloadStatus])
  const [loadedPageCounts, setLoadedPageCounts] = useState<Record<number, number>>({})
  const [pageCountProgress, setPageCountProgress] = useState<{ done: number; total: number } | null>(null)
  const [pageCountError, setPageCountError] = useState<string | null>(null)
  useEffect(() => {
    setLoadedPageCounts({})
    setPageCountProgress(null)
    setPageCountError(null)
  }, [mangaId])

  const scanlators = useMemo(() => {
    const counts = new Map<string, number>()
    for (const chapter of chapters) counts.set(scanlatorOf(chapter), (counts.get(scanlatorOf(chapter)) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [chapters])
  const hasMultiple = scanlators.length > 1

  // What the server holds for this title, as opposed to what is on screen: the picker falls back to
  // the busiest scanlation when the saved one is not among the ones this list actually has.
  const [savedScanlator, setSavedScanlator] = useState<string | null>(null)
  const [scanlator, setScanlatorState] = useState('')
  useEffect(() => {
    if (!hasMultiple) return
    if (savedScanlator !== null && (savedScanlator === '' || scanlators.some(([name]) => name === savedScanlator))) {
      setScanlatorState(savedScanlator)
    } else {
      setScanlatorState(scanlators[0][0])
    }
  }, [hasMultiple, scanlators, savedScanlator])

  const activeScanlator = scanlator && scanlators.some(([name]) => name === scanlator) ? scanlator : ''
  const visible = useMemo(
    () => activeScanlator ? chapters.filter((chapter) => scanlatorOf(chapter) === activeScanlator) : chapters,
    [activeScanlator, chapters],
  )
  const missingPageCounts = useMemo(
    () => visible.filter((chapter) => chapter.pageCount <= 0 && loadedPageCounts[chapter.id] === undefined),
    [loadedPageCounts, visible],
  )

  const [filter, setFilterState] = useState<ChapterFilter>(DEFAULT_CHAPTER_VIEW.filter)
  const [order, setOrderState] = useState<ChapterOrder>(DEFAULT_CHAPTER_VIEW.order)

  // Adopted once per title, when its meta arrives. Guarded by the id rather than by a "have we run"
  // flag, because the query refetches and a later answer must not undo a choice made since.
  const chapterViewAdoptedFor = useRef<number | null>(null)
  useEffect(() => {
    const meta = data?.manga?.meta
    if (!meta || chapterViewAdoptedFor.current === mangaId) return
    chapterViewAdoptedFor.current = mangaId
    const stored = chapterViewFromMeta(meta)
    // Only when the server has nothing: what this browser was holding before the settings moved, read
    // once and written up, so the choice reaches the reader's other devices instead of dying here.
    const carriedOver = stored ? null : legacyChapterView(mangaId)
    const view = stored ?? carriedOver ?? DEFAULT_CHAPTER_VIEW
    setFilterState(view.filter)
    setOrderState(view.order)
    setSavedScanlator(view.scanlator)
    if (carriedOver) void setChapterView({ mangaId, value: JSON.stringify(carriedOver) })
  }, [data, mangaId, setChapterView])

  const localReadThrough = useMemo(
    () => chapters.reduce((latest, chapter) => chapter.isRead ? Math.max(latest, chapter.chapterNumber) : latest, 0),
    [chapters],
  )
  const readThrough = Math.max(anilistProgress, localReadThrough)
  const hasProgress = anilistProgress > 0 || chapters.some((chapter) => chapter.isRead)
  const chapterStates = useMemo(
    () => visible.map((chapter) => ({ chapter, read: chapter.isRead || (readThrough > 0 && chapter.chapterNumber <= readThrough) })),
    [readThrough, visible],
  )
  const nextChapter = useMemo(
    () => [...chapterStates]
      .sort((a, b) => a.chapter.chapterNumber - b.chapter.chapterNumber || a.chapter.sourceOrder - b.chapter.sourceOrder)
      .find((item) => !item.read)?.chapter,
    [chapterStates],
  )
  const displayedChapters = useMemo(() => {
    // The marked position reads `isBookmarked` off the rows already loaded rather than asking the
    // server for `chapters(filter: { isBookmarked: ... })`: the page holds the whole list, and a
    // second query could only disagree with the one on screen.
    const filtered = chapterStates.filter((item) => {
      if (filter === 'all') return true
      if (filter === 'bookmarked') return item.chapter.isBookmarked
      return filter === 'read' ? item.read : !item.read
    })
    return filtered.sort((a, b) => order === 'asc'
      ? a.chapter.chapterNumber - b.chapter.chapterNumber || a.chapter.sourceOrder - b.chapter.sourceOrder
      : b.chapter.chapterNumber - a.chapter.chapterNumber || b.chapter.sourceOrder - a.chapter.sourceOrder)
  }, [chapterStates, filter, order])
  const pendingDownloads = useMemo(
    () => displayedChapters
      .filter(({ chapter }) => !chapter.isDownloaded && !queued.has(chapter.id))
      .map(({ chapter }) => chapter.id),
    [displayedChapters, queued],
  )
  // What the list itself marks read and still holds on disk. `read` rather than `chapter.isRead`, so
  // the action deletes exactly the rows wearing a Read marker — including the ones AniList accounts
  // for, which is what this list has always shown as read.
  const readDownloads = useMemo(
    () => displayedChapters
      .filter(({ chapter, read }) => read && chapter.isDownloaded)
      .map(({ chapter }) => chapter.id),
    [displayedChapters],
  )
  useEffect(() => { setConfirmingCleanup(false) }, [mangaId, filter])

  const readerPath = (chapter: ChapterNode): string => {
    const returnQuery = returnMangaId !== mangaId ? `?from=${returnMangaId}` : ''
    return `/manga/${mangaId}/chapter/${chapter.sourceOrder}${returnQuery}`
  }
  // One write for all three: they are one meta key, so changing the filter has to send the scanlator
  // and the order along with it or they would be dropped from the stored view.
  const writeChapterView = (changed: Partial<ChapterView>) => {
    const view: ChapterView = { scanlator: savedScanlator, filter, order, ...changed }
    void setChapterView({ mangaId, value: JSON.stringify(view) })
  }
  const saveFilter = (nextFilter: ChapterFilter) => {
    setFilterState(nextFilter)
    writeChapterView({ filter: nextFilter })
  }
  const cycleFilter = () => saveFilter(filter === 'all' ? 'unread' : filter === 'unread' ? 'read' : filter === 'read' ? 'bookmarked' : 'all')
  const saveOrder = (nextOrder: ChapterOrder) => {
    setOrderState(nextOrder)
    writeChapterView({ order: nextOrder })
  }
  const chooseScanlator = (next: string) => {
    setScanlatorState(next)
    setSavedScanlator(next)
    writeChapterView({ scanlator: next })
  }

  const refresh = useCallback(() => refetch({ requestPolicy: 'network-only' }), [refetch])
  const loadChapters = async () => {
    const result = await fetchChapters({ mangaId })
    if (!result.error) refresh()
  }
  const loadPageCounts = async () => {
    if (pageCountProgress || missingPageCounts.length === 0) return
    const pending = [...missingPageCounts]
    let cursor = 0
    let done = 0
    let failures = 0
    setPageCountError(null)
    setPageCountProgress({ done: 0, total: pending.length })

    const worker = async () => {
      while (cursor < pending.length) {
        const chapter = pending[cursor]
        cursor += 1
        const result = await fetchChapterPages({ chapterId: chapter.id })
        const payload = result.data?.fetchChapterPages
        if (result.error || !payload) failures += 1
        else {
          const count = payload.chapter.pageCount || payload.pages.length
          setLoadedPageCounts((current) => ({ ...current, [chapter.id]: count }))
        }
        done += 1
        setPageCountProgress({ done, total: pending.length })
      }
    }

    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker))
    setPageCountProgress(null)
    if (failures > 0) {
      setPageCountError(t(failures === 1
        ? '{count} chapter could not be counted.'
        : '{count} chapters could not be counted.', { count: failures }))
    }
    refresh()
  }

  // Enqueuing does not start the downloader: the chapter sits at QUEUED with the downloader STOPPED
  // until something starts it, and it stops itself again when the queue drains.
  const download = async (ids: number[]) => {
    if (ids.length === 0) return
    setDownloadError(null)
    const queuedResult = await enqueueDownloads({ ids })
    if (queuedResult.error) {
      setDownloadError(friendlyError(queuedResult.error))
      return
    }
    const started = await startDownloader({})
    if (started.error) setDownloadError(friendlyError(started.error))
    refreshQueue()
  }

  const cancelDownload = async (chapterId: number) => {
    setDownloadError(null)
    const result = await dequeueDownloads({ ids: [chapterId] })
    if (result.error) setDownloadError(friendlyError(result.error))
    refreshQueue()
  }

  const deleteDownload = async (chapterId: number) => {
    setDownloadError(null)
    const result = await deleteDownloads({ ids: [chapterId] })
    if (result.error) {
      setDownloadError(friendlyError(result.error))
      return
    }
    refresh()
  }

  const toggleBookmark = async (chapter: ChapterNode) => {
    setBookmarkError(null)
    const result = await updateChaptersBookmark({ ids: [chapter.id], isBookmarked: !chapter.isBookmarked })
    if (result.error) {
      setBookmarkError(friendlyError(result.error))
      return
    }
    refresh()
  }

  // Only the files go: `deleteDownloadedChapters` does not touch read state, so a cleaned-up chapter
  // stays read and can be downloaded again.
  const cleanupRead = async () => {
    setConfirmingCleanup(false)
    if (readDownloads.length === 0) return
    setDownloadError(null)
    const result = await deleteDownloads({ ids: readDownloads })
    if (result.error) {
      setDownloadError(friendlyError(result.error))
      return
    }
    refresh()
  }

  // A chapter leaves the queue the moment it is written, and only `isDownloaded` carries it from
  // there — so the rows are re-read whenever the queue's membership changes, not when it drains. A
  // chapter that finishes with eight others still queued has to flip its row then, not ten minutes
  // later.
  const seenQueue = useRef(queueKey)
  useEffect(() => {
    if (seenQueue.current === queueKey) return
    seenQueue.current = queueKey
    refresh()
  }, [queueKey, refresh])

  useEffect(() => {
    if (fetching || attempted.current === mangaId) return
    if (chapters.length === 0) {
      attempted.current = mangaId
      fetchChapters({ mangaId }).then((result) => { if (!result.error) refresh() })
    }
  }, [mangaId, fetching, chapters.length, fetchChapters, refresh])

  const busy = chaptersResult.fetching
  const settled = attempted.current === mangaId && !busy
  useEffect(() => { onEmpty?.(settled && chapters.length === 0) }, [settled, chapters.length, onEmpty])
  // The hero's tracking control sits above this list but needs the same numbering to fill in a
  // denominator AniList does not have. Report across every scanlator, not `visible`: the highest
  // chapter the source carries does not change with which scanlation you happen to be reading.
  const latestChapter = useMemo(
    () => chapters.reduce((latest, chapter) => Math.max(latest, chapter.chapterNumber), 0),
    [chapters],
  )
  useEffect(() => { onLatestChapter?.(latestChapter) }, [latestChapter, onLatestChapter])
  // Reported raw, without the AniList reconciliation: switching source hands this to the page so it
  // can carry the outgoing source's progress onto the incoming one.
  useEffect(() => { onLocalReadThrough?.(localReadThrough) }, [localReadThrough, onLocalReadThrough])
  // "Read through chapter 43" says nothing about how much is left, so pin it against the same
  // denominator the library chips use — "of 147?" while the series is still running. With neither
  // an AniList total nor chapters to count there is nothing to compare against, so say nothing.
  const total = chapterTotalLabel(anilistTotal, latestChapter, readThrough, finished)
  const readThroughSuffix = total.label === '?' ? '' : t(' of {total}', { total: total.label })

  if (error) return <div className="notice error">{friendlyError(error)}</div>

  return (
    <section className="chapters-panel">
      <div className="section-heading">
        <div><span className="eyebrow">{t('{shown} shown · {available} available', { shown: displayedChapters.length, available: visible.length })}</span><h2>{t('Chapters')}</h2></div>
        <div className="chapter-controls">
          {hasMultiple && (
            <label className="source-select">
              <span className="eyebrow">{t('Scanlator')}</span>
              <select value={activeScanlator} onChange={(event) => chooseScanlator(event.target.value)}>
                <option value="">{t('All scanlators ({count})', { count: chapters.length })}</option>
                {scanlators.map(([name, count]) => <option key={name} value={name}>{name} ({count})</option>)}
              </select>
            </label>
          )}
          <button
            className={`button quiet chapter-icon-button chapter-filter-button filter-${filter}`}
            type="button"
            onClick={cycleFilter}
            aria-label={t('{state}. Change chapter filter', {
              state: filter === 'all'
                ? t('Showing all chapters')
                : filter === 'unread'
                  ? t('Showing unread chapters only')
                  : filter === 'read' ? t('Showing read chapters only') : t('Showing bookmarked chapters only'),
            })}
            title={filter === 'all'
              ? t('All chapters')
              : filter === 'unread' ? t('Unread only') : filter === 'read' ? t('Read only') : t('Bookmarked only')}
          >
            {filter === 'all' ? (
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h11M8 12h11M8 18h11" /><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" /></svg>
            ) : filter === 'unread' ? (
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h11M8 12h11M8 18h7" /><circle cx="4.5" cy="6" r="1.5" /><circle cx="4.5" cy="12" r="1.5" /><circle cx="4.5" cy="18" r="1.5" /></svg>
            ) : filter === 'read' ? (
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h10M9 12h10M9 18h10" /><path d="m3.5 6 1.25 1.25L7 5M3.5 12l1.25 1.25L7 11M3.5 18l1.25 1.25L7 17" /></svg>
            ) : (
              // Lines on the left, the mark on the right — the sort button's composition, so the
              // fourth stop is read as the same control filtering by a different thing.
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h9M4 12h7M4 18h5" /><path className="ribbon" d="M16.5 3.75h4.5v9.5l-2.25-2-2.25 2Z" /></svg>
            )}
          </button>
          <button
            className="button quiet chapter-icon-button sort-order-button"
            type="button"
            onClick={() => saveOrder(order === 'asc' ? 'desc' : 'asc')}
            aria-label={order === 'asc' ? t('Oldest chapters first. Switch to newest first') : t('Newest chapters first. Switch to oldest first')}
            title={order === 'asc' ? t('Oldest first') : t('Newest first')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h8M4 12h6M4 18h4" />
              {order === 'asc'
                ? <path d="M18 5v14M15 16l3 3 3-3" />
                : <path d="M18 19V5M15 8l3-3 3 3" />}
            </svg>
          </button>
          <button
            className={`button quiet chapter-icon-button refresh-chapters-button${busy ? ' loading' : ''}`}
            type="button"
            disabled={busy}
            onClick={loadChapters}
            aria-label={busy ? t('Refreshing chapters') : t('Refresh chapters from source')}
            title={busy ? t('Refreshing…') : t('Refresh chapters')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M19.25 8.25V4.5m0 0H15.5m3.75 0-2.7 2.7A7.25 7.25 0 1 0 19 14.75" />
            </svg>
          </button>
          {/* Everything the filter is showing that is not already here. With the filter on unread,
              that is "download what I have not read", which is what this is usually for. */}
          {pendingDownloads.length > 0 && (
            <button
              className="button quiet chapter-icon-button chapter-download-all"
              type="button"
              onClick={() => download(pendingDownloads)}
              aria-label={t(pendingDownloads.length === 1
                ? 'Download the {count} shown chapter that is not on this device'
                : 'Download the {count} shown chapters that are not on this device', { count: pendingDownloads.length })}
              title={t('Download {count} shown', { count: pendingDownloads.length })}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3v10m0 0 3.5-3.5M12 13 8.5 9.5" />
                <path d="M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15" />
              </svg>
            </button>
          )}
          {/* The other half of the download-all button: what has been read and is still taking up
              room. Scoped to the filter the same way, so "read only" plus this is the whole chore. */}
          {readDownloads.length > 0 && (
            <button
              className={`button quiet chapter-icon-button chapter-cleanup-read${confirmingCleanup ? ' armed' : ''}`}
              type="button"
              onClick={() => setConfirmingCleanup((armed) => !armed)}
              aria-label={t(readDownloads.length === 1
                ? 'Delete the {count} shown chapter that is read and on this device'
                : 'Delete the {count} shown chapters that are read and on this device', { count: readDownloads.length })}
              aria-expanded={confirmingCleanup}
              title={t(readDownloads.length === 1
                ? 'Delete {count} read download'
                : 'Delete {count} read downloads', { count: readDownloads.length })}
            >
              {/* The bin and the tick of the Downloads screen's own cleanup action, so the two
                  surfaces that delete read downloads carry the same mark. */}
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3.5 9h9" />
                <path d="M6.5 9V7h3v2" />
                <path d="M5 9v10.5a1.5 1.5 0 0 0 1.5 1.5h3a1.5 1.5 0 0 0 1.5-1.5V9" />
                <path d="m14.5 7.5 2.25 2.25L21 5" />
              </svg>
            </button>
          )}
          {(missingPageCounts.length > 0 || pageCountProgress) && (
            <button
              className={`button quiet page-count-button${pageCountProgress ? ' loading' : ''}`}
              type="button"
              disabled={busy || pageCountProgress !== null}
              onClick={loadPageCounts}
              aria-label={pageCountProgress
                ? t('Counting pages: {done} of {total} chapters', { done: pageCountProgress.done, total: pageCountProgress.total })
                : t('Load page counts for all chapters')}
              title={pageCountProgress
                ? t('Counting {done}/{total}', { done: pageCountProgress.done, total: pageCountProgress.total })
                : t('Load page counts')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 3.75h8.5L19.25 7.5v11.75a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.75a1 1 0 0 1 1-1Z" />
                <path d="M15.25 4v3.75H19M9.25 11h6.5M9.25 14h6.5M9.25 17h4" />
                <path className="page-stack" d="M4.25 6.5v12.75a2.75 2.75 0 0 0 2.75 2.75h9" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {chaptersResult.error && chapters.length > 0 && <div className="notice error">{friendlyError(chaptersResult.error)}</div>}
      {pageCountError && <div className="notice error">{pageCountError}</div>}
      {downloadError && <div className="notice error">{downloadError}</div>}
      {bookmarkError && <div className="notice error">{bookmarkError}</div>}
      {confirmingCleanup && readDownloads.length > 0 && (
        <div className="notice cleanup-notice">
          <span>{cleanupQuestion(readDownloads.length)} {cleanupReassurance()}</span>
          <button type="button" className="button danger" onClick={cleanupRead}>{t('Delete')}</button>
          <button type="button" className="button quiet" onClick={() => setConfirmingCleanup(false)}>{t('Keep')}</button>
        </div>
      )}
      {visible.length > 0 && (
        <div className={`continue-card${nextChapter ? '' : ' caught-up'}`}>
          <div>
            <span className="eyebrow">{nextChapter ? t('Next up') : t('Reading progress')}</span>
            <strong>{nextChapter?.name ?? t('You are caught up on this scanlator')}</strong>
            <small>{hasProgress
              ? t('Read through chapter {chapter}{suffix}', { chapter: formatChapterNumber(readThrough), suffix: readThroughSuffix })
              : t('Start from the first available chapter')}</small>
          </div>
          {nextChapter && <Link className="button primary continue-button" to={readerPath(nextChapter)}>{hasProgress ? t('Continue reading') : t('Start reading')} <span aria-hidden="true">→</span></Link>}
        </div>
      )}
      {displayedChapters.length ? (
        <ol className="chapter-list">
          {displayedChapters.map(({ chapter, read }) => {
            const inQueue = queued.get(chapter.id)
            const published = formatUploadDate(chapter.uploadDate)
            return (
              <li key={chapter.id} className={read ? 'read' : ''}>
                <Link to={readerPath(chapter)}>
                  <span>
                    {chapter.name}{!activeScanlator && chapter.scanlator ? ` · ${chapter.scanlator}` : ''}
                    {published && <time className="chapter-date" dateTime={published.iso} title={t('Published {when}', { when: published.full })}>{published.label}</time>}
                  </span>
                  <small className="chapter-meta">
                    {read && <span className="read-marker">{t('Read')}</span>}
                    <span>{(loadedPageCounts[chapter.id] ?? chapter.pageCount) > 0
                      ? t('{count} pages', { count: loadedPageCounts[chapter.id] ?? chapter.pageCount })
                      : pageCountProgress ? t('Counting…') : t('Not counted')}</span>
                  </small>
                </Link>
                {/* A sibling of the link, never a child: a button inside an anchor is neither valid
                    markup nor separately clickable — the same arrangement the continue-reading
                    cards use for their hide chip. */}
                {/* Nothing on the row says whether it is marked except this button's own fill, so
                    the state has to be in the label rather than only in the colour. */}
                <button
                  type="button"
                  className={`chapter-bookmark-button${chapter.isBookmarked ? ' marked' : ''}`}
                  onClick={() => toggleBookmark(chapter)}
                  aria-label={chapter.isBookmarked
                    ? t('{chapter} is marked to come back to — clear the mark', { chapter: chapter.name })
                    : t('Mark {chapter} to come back to', { chapter: chapter.name })}
                  title={chapter.isBookmarked ? t('Marked · click to clear') : t('Mark to come back to')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6.75 4.5h10.5v15l-5.25-4.5-5.25 4.5Z" />
                  </svg>
                </button>
                {inQueue ? (
                  <button
                    type="button"
                    className={`chapter-download-button queued${inQueue.state === 'ERROR' ? ' failed' : ''}`}
                    onClick={() => cancelDownload(chapter.id)}
                    aria-label={t('{state} — take {chapter} out of the download queue', { state: describeDownload(inQueue), chapter: chapter.name })}
                    title={t('{state} · click to cancel', { state: describeDownload(inQueue) })}
                  >
                    {inQueue.state === 'DOWNLOADING'
                      ? <span className="download-percent">{Math.round(inQueue.progress * 100)}</span>
                      : (
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <circle cx="12" cy="12" r="7.5" />
                          <path d="M12 8v4l2.5 1.5" />
                        </svg>
                      )}
                  </button>
                ) : chapter.isDownloaded ? (
                  <button
                    type="button"
                    className="chapter-download-button downloaded"
                    onClick={() => deleteDownload(chapter.id)}
                    aria-label={t('{chapter} is on this device — delete the download', { chapter: chapter.name })}
                    title={t('On this device · click to delete')}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4.5 14v4.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V14" />
                      <path d="m8.5 8.5 2.5 2.5L16 5.5" />
                    </svg>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="chapter-download-button"
                    onClick={() => download([chapter.id])}
                    aria-label={t('Download {chapter}', { chapter: chapter.name })}
                    title={t('Download')}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 4v9m0 0 3.5-3.5M12 13 8.5 9.5" />
                      <path d="M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15" />
                    </svg>
                  </button>
                )}
              </li>
            )
          })}
        </ol>
      ) : (
        <div className="state-panel compact"><p>{busy
          ? t('Loading chapters from the source…')
          : visible.length
            ? filter === 'bookmarked'
              ? t('No bookmarked chapters.')
              : t(filter === 'read' ? 'No read chapters match this filter.' : 'No unread chapters match this filter.')
            : t('No chapters on this source yet.')}</p></div>
      )}
    </section>
  )
}

function AniListTrackingControl({
  mangaId,
  title,
  activeRecord,
  inheritedRecord,
  loadingManga = false,
  latestChapter = 0,
  finished = false,
  onChanged,
}: {
  mangaId: number
  title: string
  activeRecord?: TrackRecord
  inheritedRecord?: TrackRecord
  loadingManga?: boolean
  latestChapter?: number
  finished?: boolean
  onChanged: () => Promise<void>
}) {
  const client = useClient()
  const [{ data: trackerData, fetching: trackerFetching, error: trackerError }] = useQuery<{ tracker: { icon: string; isLoggedIn: boolean } }>({ query: ANILIST_TRACKER_QUERY })
  const [bindResult, bindAniList] = useMutation(BIND_ANILIST_MUTATION)
  const [bindRecordResult, bindAniListRecord] = useMutation(BIND_ANILIST_RECORD_MUTATION)
  const [unbindResult, unbindAniList] = useMutation(UNBIND_ANILIST_MUTATION)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [searchText, setSearchText] = useState(title)
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<AniListSearchResult[]>([])
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    setPickerOpen(false)
    setSearchText(title)
    setSearchResults([])
    setActionError(null)
  }, [mangaId, title])

  const runSearch = async (query: string) => {
    const trimmed = query.trim()
    if (!trimmed) return
    setSearching(true)
    setActionError(null)
    const result = await client.query<{ searchTracker: { trackSearches: AniListSearchResult[] } }>(
      SEARCH_ANILIST_QUERY,
      { query: trimmed },
      { requestPolicy: 'network-only' },
    ).toPromise()
    setSearching(false)
    if (result.error) {
      setActionError(friendlyError(result.error))
      setSearchResults([])
      return
    }
    setSearchResults((result.data?.searchTracker.trackSearches ?? []).slice(0, 8))
  }

  const enableTracking = async () => {
    setActionError(null)
    if (inheritedRecord) {
      const result = await bindAniListRecord({ mangaId, trackRecordId: inheritedRecord.id })
      if (result.error) setActionError(friendlyError(result.error))
      else await onChanged()
      return
    }
    setPickerOpen(true)
    if (searchResults.length === 0) await runSearch(searchText)
  }

  const chooseMatch = async (match: AniListSearchResult) => {
    setActionError(null)
    const result = await bindAniList({ mangaId, remoteId: match.remoteId })
    if (result.error) setActionError(friendlyError(result.error))
    else {
      setPickerOpen(false)
      await onChanged()
    }
  }

  const disableTracking = async () => {
    if (!activeRecord) return
    setActionError(null)
    const result = await unbindAniList({ recordId: activeRecord.id })
    if (result.error) setActionError(friendlyError(result.error))
    else await onChanged()
  }

  const busy = loadingManga || trackerFetching || bindResult.fetching || bindRecordResult.fetching || unbindResult.fetching
  const isLoggedIn = trackerData?.tracker.isLoggedIn === true
  const total = activeRecord && chapterTotalLabel(activeRecord.totalChapters, latestChapter, activeRecord.lastChapterRead, finished)
  const progress = activeRecord ? `${Math.floor(activeRecord.lastChapterRead)} / ${total ? total.label : '?'}` : null
  const controlLabel = activeRecord
    ? t('AniList tracking is on for {title}, chapter {progress}. Turn it off', { title: activeRecord.title, progress: progress ?? '' })
    : t('AniList tracking is off. Turn it on')

  return (
    <div className="anilist-tracking-control">
      {trackerError || (!isLoggedIn && !trackerFetching) ? (
        <Link className="button anilist-tracking-button" to="/settings" aria-label={t('Connect AniList in settings')} title={t('Connect AniList')}>
          {trackerData?.tracker.icon ? <img src={trackerData.tracker.icon} alt="" /> : <span>AL</span>}
        </Link>
      ) : (
        <button
          type="button"
          className={`button anilist-tracking-button${activeRecord ? ' active' : ''}${busy ? ' loading' : ''}`}
          disabled={busy}
          aria-pressed={Boolean(activeRecord)}
          aria-label={controlLabel}
          title={activeRecord ? t('AniList: tracking {progress}', { progress: progress ?? '' }) : t('AniList: tracking off')}
          onClick={activeRecord ? disableTracking : enableTracking}
        >
          {trackerData?.tracker.icon ? <img src={trackerData.tracker.icon} alt="" /> : <span>AL</span>}
          <i className="tracking-status-dot" aria-hidden="true" />
        </button>
      )}

      {pickerOpen && !activeRecord && (
        <div className="anilist-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPickerOpen(false) }}>
          <section className="anilist-modal" role="dialog" aria-modal="true" aria-labelledby={`anilist-title-${mangaId}`}>
            <header className="anilist-modal-header">
              <div className="anilist-modal-mark" aria-hidden="true">
                {trackerData?.tracker.icon ? <img src={trackerData.tracker.icon} alt="" /> : <span>AL</span>}
              </div>
              <div>
                <span className="eyebrow">{t('AniList tracking')}</span>
                <h2 id={`anilist-title-${mangaId}`}>{t('Choose the matching manga')}</h2>
                <p>{t('Progress will update after you finish the last page of a chapter.')}</p>
              </div>
              <button type="button" className="anilist-modal-close" aria-label={t('Close AniList matching')} title={t('Close')} onClick={() => setPickerOpen(false)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </header>
            <div className="anilist-picker">
              <form className="anilist-search" onSubmit={(event) => { event.preventDefault(); runSearch(searchText) }}>
                <label htmlFor={`anilist-search-${mangaId}`}>
                  <span className="eyebrow">{t('Search title')}</span>
                  <input id={`anilist-search-${mangaId}`} value={searchText} onChange={(event) => setSearchText(event.target.value)} autoFocus />
                </label>
                <button type="submit" className="button quiet" disabled={searching}>{searching ? t('Searching…') : t('Search')}</button>
              </form>
              {searching && <p className="muted">{t('Searching AniList…')}</p>}
              {!searching && searchResults.length === 0 && !actionError && <p className="muted">{t('No AniList matches found. Try another title.')}</p>}
              <div className="anilist-match-grid">
                {searchResults.map((match) => (
                  <button className="anilist-match" type="button" key={match.remoteId} disabled={bindResult.fetching} onClick={() => chooseMatch(match)}>
                    {match.coverUrl ? <img src={match.coverUrl} alt="" loading="lazy" /> : <div className="cover-placeholder" />}
                    <span>
                      <strong>{match.title}</strong>
                      <small>{match.publishingType.replaceAll('_', ' ').toLowerCase()} · {match.publishingStatus.replaceAll('_', ' ').toLowerCase()}{match.totalChapters > 0 ? ` · ${t('{count} chapters', { count: match.totalChapters })}` : ''}</small>
                    </span>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                  </button>
                ))}
              </div>
              {actionError && <div className="inline-error anilist-tracking-error">{actionError}</div>}
            </div>
          </section>
        </div>
      )}
      {actionError && !pickerOpen && <span className="inline-error tracking-control-error">{actionError}</span>}
    </div>
  )
}

// Search installed catalogues and only display catalogues that found a match. The top sources are
// searched up front (fast); a button then sweeps the long tail on demand.
function FindOnSource({ mangaId, title, eyebrow, onPick, onCancel, onUseOwnSource }: {
  mangaId: number
  title: string
  eyebrow: string
  onPick: (mangaId: number) => void
  // Only offered when the picker was opened deliberately: leaving it must not strand the user.
  onCancel?: () => void
  // Reverts to the chapters of the title's own catalogue, when it has any.
  onUseOwnSource?: { name: string; onUse: () => void }
}) {
  const [{ data: sourcesData }] = useQuery<{ sources: { nodes: SourceNode[] } }>({ query: SOURCES_QUERY, requestPolicy: 'cache-and-network' })
  const sources = useMemo(() => browsableSources(sourcesData?.sources.nodes ?? []), [sourcesData])
  const searchSources = useMemo(() => prioritizedSources(preferredSourcePerName(sources)), [sources])
  // Seed with the installed recommended catalogues; if none are installed, fall back to the first
  // few prioritized sources so the up-front search is never empty.
  const topSources = useMemo(() => {
    const recommended = recommendedSources(searchSources)
    return recommended.length > 0 ? recommended : searchSources.slice(0, INITIAL_SOURCE_COUNT)
  }, [searchSources])
  const restSources = useMemo(() => {
    const topIds = new Set(topSources.map((source) => source.id))
    return searchSources.filter((source) => !topIds.has(source.id))
  }, [searchSources, topSources])
  const {
    results: sourceResults,
    finding,
    error: findError,
    progress: searchProgress,
    cachedAt,
    searchedAll,
    runSearch,
    applyCached,
  } = useSourceSearch(String(mangaId), title, searchSources, topSources)

  const [showLooseMatches, setShowLooseMatches] = useState(false)
  const searched = useRef<string | null>(null)

  // Loose matches are asked for one search at a time, so a fresh sweep goes back to showing only
  // the titles that actually look like this one.
  const startSearch = useCallback((batch: SourceNode[], append: boolean, scope: SearchScope) => {
    if (batch.length > 0 && !append) setShowLooseMatches(false)
    return runSearch(batch, append, scope)
  }, [runSearch])

  useEffect(() => {
    if (searchSources.length === 0) return
    const key = `${searchSources.map((source) => source.id).join(',')}:${title}`
    if (searched.current === key) return
    searched.current = key

    const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')
    const cached = readSourceSearchCache(String(mangaId), title, searchSources)
    const matchesScope = cached && (
      (cached.scope === 'all' && sameSet(cached.sourceIds, searchSources.map((source) => source.id)))
      || (cached.scope === 'top' && sameSet(cached.sourceIds, topSources.map((source) => source.id)))
    )
    if (cached && matchesScope) {
      applyCached(cached)
      return
    }
    startSearch(topSources, false, 'top')
  }, [applyCached, mangaId, searchSources, startSearch, title, topSources])

  const results = useMemo(() => sourceResults
    .map(({ source, mangas }) => ({
      source,
      mangas: showLooseMatches
        ? sortByTitleSimilarity(title, mangas).slice(0, 10)
        : relevantTitleMatches(title, mangas),
    }))
    .filter(({ mangas }) => mangas.length > 0), [showLooseMatches, sourceResults, title])
  const hiddenMatchCount = useMemo(() => {
    const visibleIds = new Set(results.flatMap(({ source, mangas }) => mangas.map((manga) => `${source.id}:${manga.id}`)))
    return sourceResults.reduce((count, { source, mangas }) => count + mangas.filter((manga) => !visibleIds.has(`${source.id}:${manga.id}`)).length, 0)
  }, [results, sourceResults])

  return (
    <section className="pipeline-panel">
      <div className="section-heading">
        <div><span className="eyebrow">{eyebrow}</span><h2>{t('Matches across your sources')}</h2></div>
        <div className="source-picker-controls">
          {onUseOwnSource && <button type="button" className="button quiet" onClick={onUseOwnSource.onUse}>{t('Use {source}', { source: onUseOwnSource.name })}</button>}
          {!finding && <button type="button" className="button quiet" onClick={() => startSearch(searchedAll ? searchSources : topSources, false, searchedAll ? 'all' : 'top')}>{t('Search again')}</button>}
          {onCancel && (
            <button type="button" className="button quiet source-picker-close" onClick={onCancel} aria-label={t('Keep the current source')} title={t('Keep the current source')}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          )}
        </div>
      </div>
      <p className="muted">
        {searchedAll
          ? t('Searched every catalogue. Sources without results are left out, and your choice is remembered.')
          : t('Searched your top {count} sources first — the fastest catalogues. Your choice is remembered.', { count: topSources.length })}
        {cachedAt && <span className="badge cached source-cache-status" title={t('Saved {when}', { when: new Date(cachedAt).toLocaleString() })}>✓ {t('Saved search')}</span>}
      </p>
      {!finding && !searchedAll && restSources.length > 0 && (
        <button type="button" className="button search-all-sources" onClick={() => startSearch(restSources, true, 'all')}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
          <span>{t('Search all {count} sources', { count: searchSources.length })} <small>{t('(+{count} more)', { count: restSources.length })}</small></span>
        </button>
      )}
      {finding && searchProgress && (
        <div className="source-search-progress" aria-live="polite">
          <div>
            <strong>{t('{count} sources remaining', { count: searchProgress.total - searchProgress.completed })}</strong>
            <span>{t('{done} of {total} searched · {found} with matches', { done: searchProgress.completed, total: searchProgress.total, found: searchProgress.found })}{searchProgress.failed > 0 ? t(' · {count} failed', { count: searchProgress.failed }) : ''}</span>
          </div>
          <div
            className="source-search-progress-track"
            role="progressbar"
            aria-label={t('Searching sources for {title}', { title })}
            aria-valuemin={0}
            aria-valuemax={searchProgress.total}
            aria-valuenow={searchProgress.completed}
          >
            <i style={{ width: `${searchProgress.total ? (searchProgress.completed / searchProgress.total) * 100 : 0}%` }} />
          </div>
        </div>
      )}
      {findError && <div className="notice error">{findError}</div>}
      {!finding && results.length === 0 && !findError && <p className="muted">{searchedAll ? t('None of your sources found this title.') : t('None of your top sources matched — try searching all sources.')}</p>}
      <div className="source-result-groups">
        {results.map(({ source, mangas }) => (
          <div className="source-result-group" key={source.id}>
            <div className="shelf-heading">
              <h3>{source.name}</h3>
              {source.contentWarning !== undefined && source.contentWarning !== 'SAFE' && <span className="nsfw-tag" title={t('{rating} content source', { rating: source.contentWarning.toLowerCase() })}>NSFW</span>}
              <span>{source.lang} · {mangas.length}</span>
            </div>
            <div className="search-results">
              {mangas.map((result) => (
                <button className="result-row" key={`${source.id}:${result.id}`} type="button" onClick={() => onPick(result.id)}>
                  {result.thumbnailUrl ? <img src={result.thumbnailUrl} alt="" loading="lazy" /> : <div className="cover-placeholder" />}
                  <div className="result-copy"><h2>{result.title}</h2></div>
                  <span className="button primary">{t('Use this')}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {!finding && hiddenMatchCount > 0 && (
        <button type="button" className="button quiet loose-match-toggle" onClick={() => setShowLooseMatches((current) => !current)}>
          {showLooseMatches ? t('Hide loose matches') : t('Show {count} lower-confidence matches', { count: hiddenMatchCount })}
        </button>
      )}
    </section>
  )
}

// A source change that silently rewrote read state would be worse than one that loses it, so the
// carry-over reports what it did and stays undoable until the user leaves the page.
interface CarryOver { mangaId: number; ids: number[]; fromSource: string }

export default function MangaDetailPage() {
  const { mangaId } = useParams()
  const id = Number(mangaId)
  const client = useClient()
  const [searchParams, setSearchParams] = useSearchParams()
  // Discover marks the result it sent here with the catalogue it was found in.
  const openedFromSourceId = searchParams.get('source')
  const [boundId, setBoundId] = useState<number | null>(() => getSourceBinding(id))
  // What honouring that marker came to: the source the title was moved off (undoable, since this is
  // the one source change the user did not ask for), or nothing to move to because the searched
  // catalogue turned out to carry no chapters of it.
  const [searchedSource, setSearchedSource] = useState<{ kind: 'moved'; from: number } | { kind: 'empty' } | null>(null)
  const [ownEmpty, setOwnEmpty] = useState(false)
  const [latestChapter, setLatestChapter] = useState(0)
  const [localReadThrough, setLocalReadThrough] = useState(0)
  const [pendingCarry, setPendingCarry] = useState<{ mangaId: number; readThrough: number; fromSource: string } | null>(null)
  const [carried, setCarried] = useState<CarryOver | null>(null)
  const [carrying, setCarrying] = useState(false)
  const [carryError, setCarryError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  // null while there is nothing to warn about; the dialog is open for as long as it holds matches.
  const [duplicates, setDuplicates] = useState<DuplicateMatch[] | null>(null)
  const [duplicateSources, setDuplicateSources] = useState<Map<number, DuplicateSourceInfo>>(new Map())
  const [checkingDuplicates, setCheckingDuplicates] = useState(false)
  const [{ data, fetching, error }, refetchDetail] = useQuery<{ manga: MangaDetail }>({ query: MANGA_DETAIL_QUERY, variables: { mangaId: id } })
  const [{ data: boundData, fetching: boundFetching }, refetchBound] = useQuery<{ manga: MangaDetail }>({ query: MANGA_DETAIL_QUERY, variables: { mangaId: boundId ?? 0 }, pause: boundId === null })
  const [libraryResult, toggleLibrary] = useMutation(TOGGLE_LIBRARY_MUTATION)
  const [saveSourceBindingResult, saveSourceBinding] = useMutation(SET_SOURCE_BINDING_MUTATION)
  const [deleteSourceBindingResult, deleteSourceBinding] = useMutation(DELETE_SOURCE_BINDING_MUTATION)
  const [, bindAniListRecord] = useMutation(BIND_ANILIST_RECORD_MUTATION)
  const [, fetchTrack] = useMutation(FETCH_TRACK_MUTATION)
  const [, updateChaptersRead] = useMutation(UPDATE_CHAPTERS_READ_MUTATION)
  const [, fetchMangaDetails] = useMutation(FETCH_MANGA_DETAILS_MUTATION)
  const [, fetchChapters] = useMutation<{ fetchChapters: { chapters: { id: number }[] } | null }>(FETCH_CHAPTERS_MUTATION)
  const [, markNoChapters] = useMutation(SET_NO_CHAPTERS_MUTATION)
  const refreshedBoundRef = useRef<number | null>(null)
  // Which manga the source page has already been asked for, so a source that cannot answer is asked
  // once rather than on every render.
  const requestedRealUrl = useRef<number | null>(null)
  // Which title the Discover marker has already been honoured for, so the switch happens once per
  // arrival rather than on every render the marker survives.
  const switchedToSearchedSource = useRef<number | null>(null)
  // Which title has already been written off on its own catalogue, so the note is made once.
  const markedEmpty = useRef<number | null>(null)

  useEffect(() => {
    setBoundId(getSourceBinding(id))
    setOwnEmpty(false)
    setPicking(false)
    setLocalReadThrough(0)
    setPendingCarry(null)
    setCarried(null)
    setCarryError(null)
    setSearchedSource(null)
    switchedToSearchedSource.current = null
    // Opening the existing entry from the warning changes the id under a mounted page, and the
    // dialog has to go with it rather than hang over the title it just sent the user to.
    setDuplicates(null)
    setDuplicateSources(new Map())
  }, [id])

  // Server metadata makes the chosen catalogue available to every browser and survives
  // local-storage cleanup. Existing browser-only choices are retained as a fallback.
  useEffect(() => {
    const persisted = data?.manga ? sourceBindingFromMeta(data.manga.meta) : null
    if (persisted !== null) setBoundId(persisted)
    else if (data?.manga) {
      const fallback = getSourceBinding(id)
      setBoundId(fallback)
      if (fallback !== null) void saveSourceBinding({ mangaId: id, boundMangaId: String(fallback) })
    }
  }, [data?.manga, id, saveSourceBinding])

  // A title opened from Discover is read from the catalogue it was found in. The reader has just
  // asked *this* source for *this* title, and the row they clicked is that source's own copy — so a
  // binding made another day, pointing somewhere else, is not what they picked. Dropping it is the
  // same source change the picker makes, persisted the same way, and undoable from the notice for as
  // long as the page stays open.
  useEffect(() => {
    if (!openedFromSourceId || !data?.manga || switchedToSearchedSource.current === id) return
    // Only ever the searched source's own copy: a mismatch means the marker outlived the navigation
    // it was written for, and rebinding on a stale url is worse than ignoring it.
    if (data.manga.sourceId !== openedFromSourceId) return
    switchedToSearchedSource.current = id
    const bound = sourceBindingFromMeta(data.manga.meta) ?? getSourceBinding(id)
    if (bound === null) return

    // Consumed here rather than after the switch: whatever this arrival decides, it decides once, and
    // a reload — or a reload after an undo — must not put the title through it a second time.
    const next = new URLSearchParams(searchParams)
    next.delete('source')
    setSearchParams(next, { replace: true })

    void (async () => {
      // A catalogue listing a title does not mean it carries chapters of it: MangaDex lists Sweet Home
      // and has none. Trading a binding that reads for one that shows "no readable source" would be a
      // worse answer than ignoring the click, so the catalogue is asked before anything is unbound.
      const existing = await client
        .query<{ chapters: { nodes: ChapterNode[] } }>(CHAPTERS_QUERY, { mangaId: id }, { requestPolicy: 'network-only' })
        .toPromise()
      let count = existing.data?.chapters.nodes.length ?? 0
      if (count === 0) {
        const fetched = await fetchChapters({ mangaId: id })
        // A source with nothing for this title answers "No chapters found" as an error, not an empty list.
        count = fetched.error ? 0 : fetched.data?.fetchChapters?.chapters.length ?? 0
      }
      if (count === 0) {
        setSearchedSource({ kind: 'empty' })
        return
      }
      const result = await deleteSourceBinding({ mangaId: id })
      // The error surfaces on the source card, and the binding is left exactly as it was.
      if (result.error) return
      clearLocalSourceBinding(id)
      setBoundId(null)
      setSearchedSource({ kind: 'moved', from: bound })
      refetchDetail({ requestPolicy: 'network-only' })
    })()
  }, [client, data?.manga, deleteSourceBinding, fetchChapters, id, openedFromSourceId, refetchDetail, searchParams, setSearchParams])

  // Discover hides the titles a source cannot serve, and it learns from here as well: a title opened
  // on a catalogue that turns out to have nothing is exactly the answer the browse check would have
  // got, and writing it down means the card is gone before the next reader taps it. Only for a real
  // catalogue — a library stub sits on the pseudo source, which was never going to have chapters.
  useEffect(() => {
    if (!ownEmpty || boundId !== null || !data?.manga || markedEmpty.current === id) return
    if (PSEUDO_SOURCE_IDS.includes(data.manga.sourceId)) return
    markedEmpty.current = id
    void markNoChapters({ mangaId: id, value: String(Date.now()) })
  }, [boundId, data?.manga, id, markNoChapters, ownEmpty])

  // Read progress lives on the manga the user actually reads (the bound source), so the
  // AniList record must live there too. Two things have to happen for read chapters to
  // show as read on a source:
  //   1. The library entry's record must be carried onto the bound source — otherwise
  //      finishing a chapter fires asyncTrackChapter for a manga with no track record and
  //      never syncs back to AniList.
  //   2. That record must be refreshed from AniList once per source, because a freshly
  //      bound record inherits the (frozen) library-entry progress; without the refresh a
  //      newly picked source shows every chapter as unread even though AniList knows better.
  useEffect(() => {
    if (boundId === null || boundFetching || !boundData?.manga) return
    const original = data?.manga?.trackRecords.nodes.find((record) => record.trackerId === 2)
    const bound = boundData.manga.trackRecords.nodes.find((record) => record.trackerId === 2)

    if (original && !bound) {
      refreshedBoundRef.current = boundId
      bindAniListRecord({ mangaId: boundId, trackRecordId: original.id }).then(async (result) => {
        const boundRecordId = result.data?.bindTrackRecord?.trackRecord?.id as number | undefined
        if (boundRecordId) await fetchTrack({ recordId: boundRecordId })
        refetchBound({ requestPolicy: 'network-only' })
      })
      return
    }

    if (bound && refreshedBoundRef.current !== boundId) {
      refreshedBoundRef.current = boundId
      fetchTrack({ recordId: bound.id }).then((result) => {
        if (!result.error) refetchBound({ requestPolicy: 'network-only' })
      })
    }
  }, [boundId, boundFetching, data, boundData, bindAniListRecord, fetchTrack, refetchBound])

  // Runs once the incoming source has its chapters (latestChapter is reported by the new list, and
  // bindTo zeroes it precisely so this cannot fire against the outgoing source's numbering).
  useEffect(() => {
    if (!pendingCarry || boundId !== pendingCarry.mangaId || latestChapter <= 0) return
    const { mangaId: target, readThrough, fromSource } = pendingCarry
    setPendingCarry(null)
    setCarrying(true)
    void (async () => {
      const result = await client
        .query<{ chapters: { nodes: ChapterNode[] } }>(CHAPTERS_QUERY, { mangaId: target }, { requestPolicy: 'network-only' })
        .toPromise()
      if (result.error) {
        setCarrying(false)
        setCarryError(friendlyError(result.error))
        return
      }
      // Chapters the source could not number come back as -1, and every one of those is "at or
      // below" any read-through — they must not be swept up as read.
      const ids = (result.data?.chapters.nodes ?? [])
        .filter((chapter) => !chapter.isRead && chapter.chapterNumber > 0 && chapter.chapterNumber <= readThrough)
        .map((chapter) => chapter.id)
      if (ids.length === 0) {
        setCarrying(false)
        return
      }
      const update = await updateChaptersRead({ ids, isRead: true })
      setCarrying(false)
      if (update.error) setCarryError(friendlyError(update.error))
      else setCarried({ mangaId: target, ids, fromSource })
    })()
  }, [pendingCarry, boundId, latestChapter, client, updateChaptersRead])

  // Ask the source for the manga itself, once, when its page url is still unknown. Nothing else in
  // the app ever does — the chapter fetch explicitly passes `updateManga = false` — so without this
  // realUrl is null for every title and there is never anything to share.
  //
  // It asks about the manga actually being read: the bound source, or the entry itself when there is
  // no binding. A library entry is usually an AniList-seeded stub sitting on a source that has no
  // page for it, while the bound source is the one that does.
  useEffect(() => {
    if (!data?.manga) return
    // The binding is read straight from the freshly loaded meta rather than from boundId, which
    // catches up an effect later: that one render with a stale binding is enough to fire a request at
    // the library entry's own source before the real one is known.
    const bound = sourceBindingFromMeta(data.manga.meta) ?? getSourceBinding(id)
    // An unbound library entry is an AniList-seeded stub sitting on the legacy TorBox source, which
    // has no page for it — asking would spend a request to learn nothing. Everything else is either a
    // bound source or a title opened from Discover, and both are real source entries.
    if (bound === null && data.manga.inLibrary) return
    const target = bound ?? id
    const active = target === id ? data.manga : boundData?.manga
    if (!active || active.id !== target || active.realUrl || requestedRealUrl.current === target) return
    requestedRealUrl.current = target
    void fetchMangaDetails({ mangaId: target }).then((result) => {
      if (result.error) return
      if (target === id) refetchDetail({ requestPolicy: 'network-only' })
      else refetchBound({ requestPolicy: 'network-only' })
    })
  }, [boundData, data, fetchMangaDetails, id, refetchBound, refetchDetail])

  // Fills in what each match is read from and how much of it is waiting, after the dialog is already
  // on screen: the warning is worth showing the moment it is known, and a second round trip is not
  // worth making the user wait for. Unread is counted the way the library counts it — distinct
  // chapter numbers above the read-through, since a source carrying several scanlations of one
  // chapter would otherwise inflate it — and read-through takes the best of the entry's tracker, the
  // reading copy's tracker and its own read flags, because any of the three can be the one that knows.
  useEffect(() => {
    if (!duplicates || duplicates.length === 0) return
    let cancelled = false
    const progressOf = (entry: LibraryTitle) => entry.trackRecords.nodes.find((record) => record.trackerId === 2)?.lastChapterRead ?? 0
    void client
      .query<{ mangas: { nodes: DuplicateSourceNode[] } }>(
        DUPLICATE_SOURCE_QUERY,
        { ids: [...new Set(duplicates.map((match) => match.readsFrom))] },
        { requestPolicy: 'cache-and-network' },
      )
      .toPromise()
      .then((result) => {
        if (cancelled || !result.data) return
        const described = new Map<number, DuplicateSourceInfo>()
        for (const node of result.data.mangas.nodes) {
          const entry = duplicates.find((match) => match.readsFrom === node.id)?.entry
          const readThrough = Math.max(
            entry ? progressOf(entry) : 0,
            node.trackRecords.nodes.find((record) => record.trackerId === 2)?.lastChapterRead ?? 0,
            node.chapters.nodes.reduce((latest, chapter) => chapter.isRead ? Math.max(latest, chapter.chapterNumber) : latest, 0),
          )
          const numbers = [...new Set(node.chapters.nodes.map((chapter) => chapter.chapterNumber))]
          described.set(node.id, {
            sourceName: node.source?.name ?? null,
            unread: numbers.filter((number) => number > readThrough).length,
          })
        }
        setDuplicateSources(described)
      })
    return () => { cancelled = true }
  }, [duplicates, client])

  if (!Number.isInteger(id)) return <div className="state-panel error"><p>{t('Invalid manga id.')}</p></div>
  if (fetching) return <div className="state-panel"><p>{t('Opening manga…')}</p></div>
  if (error) return <div className="state-panel error"><h2>{t('Manga unavailable')}</h2><p>{friendlyError(error)}</p></div>
  if (!data?.manga) return null

  const manga = data.manga
  const originalAniListRecord = manga.trackRecords.nodes.find((record) => record.trackerId === 2)
  const boundAniListRecord = boundData?.manga?.trackRecords.nodes.find((record) => record.trackerId === 2)
  const activeAniListRecord = boundId ? boundAniListRecord : originalAniListRecord
  const inheritedAniListRecord = boundId && originalAniListRecord ? originalAniListRecord : undefined
  const anilistProgress = Math.max(originalAniListRecord?.lastChapterRead ?? 0, boundAniListRecord?.lastChapterRead ?? 0)
  const anilistTotal = activeAniListRecord?.totalChapters ?? 0
  const finishedPublishing = hasFinishedPublishing(manga.status, boundData?.manga?.status)
  const refresh = () => refetchDetail({ requestPolicy: 'network-only' })
  const refreshTracking = async () => {
    refetchDetail({ requestPolicy: 'network-only' })
    if (boundId) refetchBound({ requestPolicy: 'network-only' })
  }
  const unbind = async () => {
    const result = await deleteSourceBinding({ mangaId: id })
    if (!result.error) {
      clearLocalSourceBinding(id)
      setBoundId(null)
      setOwnEmpty(false)
      setPicking(false)
    }
  }

  // The way back from the automatic switch above, without going through the picker to find a source
  // the title was already on.
  const restorePreviousSource = async () => {
    if (searchedSource?.kind !== 'moved') return
    const previous = searchedSource.from
    const result = await saveSourceBinding({ mangaId: id, boundMangaId: String(previous) })
    if (result.error) return
    setSourceBinding(id, previous)
    setBoundId(previous)
    setSearchedSource(null)
    refetchDetail({ requestPolicy: 'network-only' })
  }

  const bindTo = async (picked: number) => {
    // Picking the title's own entry is a request to read from its own catalogue again.
    if (picked === id) {
      await unbind()
      return
    }
    // Take the outgoing source's read-through before switching. AniList is folded in so a title
    // whose chapters were never flagged read locally still carries its real progress across.
    const readThrough = Math.max(anilistProgress, localReadThrough)
    const fromSource = activeSourceName ?? t('the previous source')
    setSourceBinding(id, picked)
    setBoundId(picked)
    setPicking(false)
    setLatestChapter(0)
    setLocalReadThrough(0)
    setCarried(null)
    setCarryError(null)
    await saveSourceBinding({ mangaId: id, boundMangaId: String(picked) })
    if (readThrough > 0) setPendingCarry({ mangaId: picked, readThrough, fromSource })
  }

  const setInLibrary = async (inLibrary: boolean) => {
    const result = await toggleLibrary({ mangaId: id, inLibrary })
    if (!result.error) refresh()
  }

  // Only the way in asks. Removing a title is undoing something the user did on purpose, and a
  // confirmation there would be a dialog in front of every mistaken tap of the heart.
  const addToLibrary = async () => {
    setCheckingDuplicates(true)
    const result = await client
      .query<{ mangas: { nodes: LibraryTitle[] } }>(LIBRARY_TITLES_QUERY, {}, { requestPolicy: 'cache-first' })
      .toPromise()
    setCheckingDuplicates(false)
    // A library that will not load is no reason to refuse the add: the warning is a courtesy, and
    // without it the heart does exactly what it has always done.
    const rows = result.data?.mangas.nodes.filter((row) => row.id !== id) ?? []
    // The same threshold the source picker trusts to decide which matches are worth showing at all.
    // A false positive here interrupts every add, which is worse than the duplicate it prevents, so
    // this is not the place for a second, laxer number.
    const matches = relevantTitleMatches(manga.title, librarySeries(rows))
    if (matches.length === 0) {
      await setInLibrary(true)
      return
    }
    setDuplicates(matches.map((entry) => ({ entry, readsFrom: readingSourceOf(entry) })))
  }

  const undoCarry = async () => {
    if (!carried) return
    setCarrying(true)
    setCarryError(null)
    const result = await updateChaptersRead({ ids: carried.ids, isRead: false })
    setCarrying(false)
    if (result.error) setCarryError(friendlyError(result.error))
    else setCarried(null)
  }

  const ownSourceName = manga.source?.name
  // The bound source's page, mirroring activeSourceName below: it is the copy that came from a
  // source and therefore the one with a page to link to.
  const shareUrl = (boundId ? boundData?.manga?.realUrl : manga.realUrl) || null
  const canShare = typeof navigator.share === 'function'
  const activeSourceName = boundId ? boundData?.manga?.source?.name : ownSourceName
  const activeSourceIcon = boundId ? boundData?.manga?.source?.iconUrl : manga.source?.iconUrl
  // The bound copy is the one a source filled in, so its tags win — but three of the seven bound
  // sources in this library report none at all, and an entry added from a source before it was
  // rebound still carries a list that is true about the same series, so that one stands in when the
  // bound copy has nothing. Nothing is drawn until the bound copy has arrived: falling back while it
  // loads would show the entry's tags and swap them for the source's a moment later.
  // Sources also repeat themselves (Manga District lists Ms. Mystic under "Manhwa" twice), hence the Set.
  const boundGenres = boundId ? boundData?.manga?.genre : undefined
  const genres = boundId !== null && boundGenres === undefined
    ? []
    : [...new Set(boundGenres?.length ? boundGenres : manga.genre)]
  // The picker stands in for the chapter list: on demand from the source card, or automatically
  // when the title has no chapters of its own to fall back to.
  const showPicker = picking || (!boundId && ownEmpty)
  // Why the picker is standing in for a chapter list. A title opened from Discover has a real
  // catalogue of its own that simply carries nothing — naming it is the difference between the app
  // explaining itself and the app looking like it ignored the source the reader chose. A library stub
  // sits on the pseudo source instead, and has no catalogue worth naming.
  const emptyOwnCatalogue = ownSourceName && !PSEUDO_SOURCE_IDS.includes(manga.sourceId)
    ? t('{source} has no chapters for this title', { source: ownSourceName })
    : t('No readable source')
  // An orphan title's own catalogue is a dead end, so its name is not worth showing.
  const showSourceCard = boundId !== null || !ownEmpty

  return (
    <div className="detail-page">
      <section className="manga-hero">
        {manga.thumbnailUrl ? <img src={manga.thumbnailUrl} alt="" /> : <div className="cover-placeholder" />}
        <div>
          <span className="eyebrow">{manga.author || t('Source title')}{manga.status && manga.status !== 'UNKNOWN' ? ` · ${t(manga.status.toLowerCase())}` : ''}</span>
          <h1>{manga.title}</h1>
          {manga.description && <p className="summary">{htmlToPlainText(manga.description)}</p>}
          {/* Nothing at all when the source reports no tags: plenty report none, and an empty row
              of chips reads as something that failed to load. */}
          {genres.length > 0 && (
            <ul className="genre-chips" aria-label={t('Genres')}>
              {genres.map((genre) => (
                <li key={genre}>
                  {/* A plain search, not a tag filter: sources disagree on whether a tag is even a
                      searchable term, and the search Discover already runs is the one thing they
                      all answer. */}
                  <Link className="genre-chip" to={`/search?q=${encodeURIComponent(genre)}`}>{genre}</Link>
                </li>
              ))}
            </ul>
          )}
          <div className="hero-actions">
            <button
              type="button"
              className={`button library-heart-button${manga.inLibrary ? ' in-library' : ''}${libraryResult.fetching || checkingDuplicates ? ' loading' : ''}`}
              disabled={libraryResult.fetching || checkingDuplicates}
              aria-pressed={manga.inLibrary}
              aria-label={manga.inLibrary ? t('Remove from library') : t('Add to library')}
              title={manga.inLibrary ? t('Remove from library') : t('Add to library')}
              onClick={() => manga.inLibrary ? setInLibrary(false) : addToLibrary()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z" />
              </svg>
            </button>
            {/* Absent rather than disabled when there is nothing to share or no way to share it:
                realUrl stays null on a source with no page for the title, and navigator.share is
                missing on insecure contexts and most desktop Firefox. */}
            {canShare && shareUrl && (
              <button
                type="button"
                className="button share-source-button"
                aria-label={t('Share {title}', { title: manga.title })}
                title={t('Share the source page')}
                onClick={async () => {
                  try {
                    await navigator.share({ title: manga.title, url: shareUrl })
                  } catch {
                    // Dismissing the sheet rejects with AbortError. That is a normal outcome, not an
                    // error the page should report.
                  }
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="18" cy="5" r="2.6" /><circle cx="6" cy="12" r="2.6" /><circle cx="18" cy="19" r="2.6" />
                  <path d="m8.4 10.8 7.2-4.2M8.4 13.2l7.2 4.2" />
                </svg>
              </button>
            )}
            <AniListTrackingControl
              mangaId={boundId ?? id}
              title={manga.title}
              activeRecord={activeAniListRecord}
              inheritedRecord={inheritedAniListRecord}
              loadingManga={Boolean(boundId && boundFetching)}
              latestChapter={latestChapter}
              finished={finishedPublishing}
              onChanged={refreshTracking}
            />
            {libraryResult.error && <span className="inline-error">{friendlyError(libraryResult.error)}</span>}
          </div>
        </div>
      </section>

      {/* Real choices, so real words: this is the one control on the page that is not an icon,
          because "open the one you have" and "add a second copy anyway" cannot be drawn. */}
      {duplicates && (
        <div className="duplicate-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDuplicates(null) }}>
          <section className="duplicate-modal" role="dialog" aria-modal="true" aria-labelledby={`duplicate-title-${id}`}>
            <header className="duplicate-modal-header">
              <span className="eyebrow">{t('Already in your library')}</span>
              <h2 id={`duplicate-title-${id}`}>{duplicates.length === 1 ? t('You have this series already') : t('You may have this series already')}</h2>
              <p>{t('Adding “{title}” leaves two entries for one series, and only the library display collapses them.', { title: manga.title })}</p>
            </header>
            <ul className="duplicate-list">
              {duplicates.map(({ entry, readsFrom }) => {
                const described = duplicateSources.get(readsFrom)
                return (
                  <li key={entry.id}>
                    {entry.thumbnailUrl ? <img src={entry.thumbnailUrl} alt="" loading="lazy" /> : <div className="cover-placeholder" />}
                    <div>
                      <strong>{entry.title}</strong>
                      {described && (
                        <small>
                          {described.sourceName ? t('Reads from {source}', { source: described.sourceName }) : t('No source bound')}
                          {described.unread > 0 ? t(' · {count} unread', { count: described.unread }) : t(' · nothing unread')}
                        </small>
                      )}
                    </div>
                    <Link className="button quiet" to={`/manga/${entry.id}`} onClick={() => setDuplicates(null)}>{t('Open it instead')}</Link>
                  </li>
                )
              })}
            </ul>
            <div className="duplicate-actions">
              <button type="button" className="button quiet" onClick={() => setDuplicates(null)}>{t('Cancel')}</button>
              <button
                type="button"
                className="button primary"
                onClick={async () => {
                  setDuplicates(null)
                  await setInLibrary(true)
                }}
              >{t('Add anyway')}</button>
            </div>
          </section>
        </div>
      )}

      {showSourceCard && (
        <aside className="reading-source-card" aria-label={t('Chapter source: {source}', { source: activeSourceName ?? t('source') })}>
          <div className="reading-source-icon">
            {activeSourceIcon
              ? <img src={activeSourceIcon} alt="" />
              : (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 4.5h5.25A2.75 2.75 0 0 1 13 7.25V20a2.75 2.75 0 0 0-2.75-2.75H5V4.5Zm14 0h-3.25A2.75 2.75 0 0 0 13 7.25V20a2.75 2.75 0 0 1 2.75-2.75H19V4.5Z" />
                  </svg>
                )}
          </div>
          <div className="reading-source-copy">
            <span className="eyebrow">{t('Chapter source')}</span>
            <strong>{activeSourceName ?? t('Selected source')}</strong>
            <small>{t('Chapter updates, pages and page counts are loaded from this catalogue.')}</small>
            {saveSourceBindingResult.error && <small className="inline-error">{t('Could not save this source: {error}', { error: friendlyError(saveSourceBindingResult.error) })}</small>}
            {deleteSourceBindingResult.error && <small className="inline-error">{t('Could not clear the saved source: {error}', { error: friendlyError(deleteSourceBindingResult.error) })}</small>}
          </div>
          <button
            type="button"
            className="button quiet source-change-button"
            disabled={showPicker || deleteSourceBindingResult.fetching}
            onClick={() => setPicking(true)}
            aria-label={t('Change chapter source')}
            title={t('Change chapter source')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h13M14 4l3 3-3 3M20 17H7M10 14l-3 3 3 3" />
            </svg>
            <span>{t('Change')}</span>
          </button>
        </aside>
      )}

      {searchedSource && (
        <div className="notice carry-notice">
          <span>
            {searchedSource.kind === 'moved'
              ? t('Now reading from {source} — the source you searched.', { source: ownSourceName ?? t('this result’s own catalogue') })
              : t('{source} has no chapters for this title, so it is still read from {bound}.', {
                source: ownSourceName ?? t('The source you searched'),
                bound: activeSourceName ?? t('the source it was bound to'),
              })}
          </span>
          {searchedSource.kind === 'moved' && (
            <button
              type="button"
              className="button quiet carry-undo-button"
              disabled={saveSourceBindingResult.fetching}
              onClick={restorePreviousSource}
              aria-label={t('Go back to the source this title was bound to')}
              title={t('Undo')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 9h11a4.5 4.5 0 0 1 0 9h-6" />
                <path d="m8 5-4 4 4 4" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="button quiet carry-dismiss-button"
            onClick={() => setSearchedSource(null)}
            aria-label={t('Dismiss')}
            title={t('Dismiss')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      )}

      {(carrying || carried || carryError) && (
        <div className={`notice carry-notice${carryError ? ' error' : ''}`}>
          <span>
            {carrying
              ? t('Carrying your progress over to the new source…')
              : carryError
                ? t('Could not carry your progress over: {error}', { error: carryError })
                : t(carried?.ids.length === 1
                  ? 'Marked {count} chapter read, carried over from {source}.'
                  : 'Marked {count} chapters read, carried over from {source}.', { count: carried?.ids.length ?? 0, source: carried?.fromSource ?? '' })}
          </span>
          {carried && !carrying && (
            <button
              type="button"
              className="button quiet carry-undo-button"
              onClick={undoCarry}
              aria-label={t('Undo marking {count} chapters read', { count: carried.ids.length })}
              title={t('Undo')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 9h11a4.5 4.5 0 0 1 0 9h-6" />
                <path d="m8 5-4 4 4 4" />
              </svg>
            </button>
          )}
          {!carrying && (
            <button
              type="button"
              className="button quiet carry-dismiss-button"
              onClick={() => { setCarried(null); setCarryError(null) }}
              aria-label={t('Dismiss')}
              title={t('Dismiss')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          )}
        </div>
      )}

      {showPicker ? (
        <FindOnSource
          mangaId={id}
          title={manga.title}
          eyebrow={picking ? t('Change source') : emptyOwnCatalogue}
          onPick={bindTo}
          onCancel={picking ? () => setPicking(false) : undefined}
          onUseOwnSource={picking && boundId !== null && !ownEmpty && ownSourceName ? { name: ownSourceName, onUse: unbind } : undefined}
        />
      ) : boundId ? (
        <ChapterList mangaId={boundId} anilistProgress={anilistProgress} anilistTotal={anilistTotal} finished={finishedPublishing} returnMangaId={id} onLatestChapter={setLatestChapter} onLocalReadThrough={setLocalReadThrough} />
      ) : (
        <ChapterList mangaId={id} anilistProgress={anilistProgress} anilistTotal={anilistTotal} finished={finishedPublishing} onEmpty={setOwnEmpty} onLatestChapter={setLatestChapter} onLocalReadThrough={setLocalReadThrough} />
      )}
    </div>
  )
}
