/**
 * The library as six numbers.
 *
 * Everything here counts what the shelves count, with the shelves' own rules: a series is one title
 * however many rows carry it, and a chapter is one chapter however many scanlations published it.
 * A stats pane that disagreed with the badges on the library page would make one of the two look
 * broken, and there would be no way to tell which.
 *
 * The two queries below are byte-for-byte the documents `LibraryPage` runs. urql keys its cache on
 * the document text, so an identical string is the same request: opening the pane after visiting
 * the library costs nothing, and the two screens are answering out of one response. They are copied
 * rather than imported because `LibraryPage` keeps them private and is being edited elsewhere;
 * whichever of the two is touched, the other has to be touched with it.
 */
import { getSourceBinding, sourceBindingFromMeta } from './bindings'
import { primaryRecord, trackIdentity } from './tracking'

export const LIBRARY_QUERY = `
  query Library {
    mangas(condition: { inLibrary: true }) {
      nodes {
        id
        title
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

export const BOUND_UNREAD_QUERY = `
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

// The one line on the pane that counts rows, and it counts them on purpose: two scanlations of one
// chapter downloaded are two files taking up two files' worth of space. Everywhere else a duplicate
// scanlation is the same chapter twice; on disk it is not.
export const DOWNLOADED_CHAPTERS_QUERY = `
  query DownloadedChapters {
    chapters(filter: { isDownloaded: { equalTo: true } }) { totalCount }
  }
`

interface StatsTrackRecord {
  trackerId: number
  remoteId: string
  status: number
  lastChapterRead: number
  totalChapters: number
}

/** A library row, narrowed to the fields a count reads. */
export interface StatsManga {
  id: number
  title: string
  meta: Array<{ key: string; value: string }>
  trackRecords: { nodes: StatsTrackRecord[] }
}

/** A bound source manga, narrowed the same way. */
export interface StatsBoundManga {
  id: number
  chapters: { nodes: Array<{ chapterNumber: number; isRead: boolean }> }
  trackRecords: { nodes: Array<{ trackerId: number; lastChapterRead: number }> }
}

export interface LibraryStatsResult { mangas: { nodes: StatsManga[] } }
export interface BoundStatsResult { mangas: { nodes: StatsBoundManga[] } }
export interface DownloadedChaptersResult { chapters: { totalCount: number } }

export interface LibraryTotals {
  titles: number
  completed: number
  chaptersRead: number
  chaptersTotal: number
}

const COMPLETED_STATUS = 2

function trackedRecord(item: StatsManga): StatsTrackRecord | undefined {
  return primaryRecord(item.trackRecords.nodes)
}

function trackedId(records: Array<{ trackerId: number; remoteId: string }>): string | undefined {
  return trackIdentity(records)
}

function boundSourceId(item: StatsManga): number | null {
  return sourceBindingFromMeta(item.meta) ?? getSourceBinding(item.id)
}

function titleKey(title: string): string {
  return title.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

// One series, one title, however many rows the library holds for it — an AniList import and a copy
// added from a source are two rows and one story. The winner is the row that knows the most about
// it, because that is the row the shelves draw a card for and the row whose binding the chapter
// counts follow.
function deduplicate(items: StatsManga[]): StatsManga[] {
  const remoteByTitle = new Map<string, string>()
  for (const item of items) {
    const remoteId = trackedId(item.trackRecords.nodes)
    if (remoteId) remoteByTitle.set(titleKey(item.title), remoteId)
  }
  const seriesKey = (item: StatsManga) =>
    trackedId(item.trackRecords.nodes) ?? remoteByTitle.get(titleKey(item.title)) ?? titleKey(item.title)
  const score = (item: StatsManga) => [
    trackedRecord(item) ? 1 : 0,
    boundSourceId(item) !== null ? 1 : 0,
    trackedRecord(item)?.lastChapterRead ?? 0,
    -item.id,
  ]
  const series = new Map<string, StatsManga>()
  for (const item of items) {
    const key = seriesKey(item)
    const found = series.get(key)
    if (!found) {
      series.set(key, item)
      continue
    }
    const [left, right] = [score(found), score(item)]
    const decided = left.findIndex((value, index) => value !== right[index])
    series.set(key, decided >= 0 && right[decided] > left[decided] ? item : found)
  }
  return [...series.values()]
}

/** The bound sources behind a library, which is what `BOUND_UNREAD_QUERY` wants for its `ids`. */
export function boundSourceIds(items: StatsManga[]): number[] {
  const ids = new Set<number>()
  for (const item of items) {
    const bound = boundSourceId(item)
    if (bound !== null) ids.add(bound)
  }
  return [...ids].sort((a, b) => a - b)
}

/**
 * Titles, completed titles, and chapters read against chapters that exist.
 *
 * The chapter numbers are distinct per bound source, never `chapters.totalCount`: a source carrying
 * six scanlations of chapter 12 has one chapter 12, and counting rows would report Frieren as 316
 * chapters where the library card says 152. Read-through is reconciled against AniList the way
 * every other screen does it — a chapter counts as read when the database flagged it *or* when it
 * sits at or below what AniList knows — so a source whose chapters were never marked read locally
 * does not report a fully-read series as untouched.
 */
export function countLibrary(entries: StatsManga[], boundNodes: StatsBoundManga[]): LibraryTotals {
  const bound = new Map(boundNodes.map((node) => {
    const numbers = [...new Set(node.chapters.nodes.map((chapter) => chapter.chapterNumber))]
    return [node.id, {
      numbers,
      progress: primaryRecord(node.trackRecords.nodes)?.lastChapterRead ?? 0,
      localReadThrough: node.chapters.nodes.reduce((latest, chapter) => chapter.isRead ? Math.max(latest, chapter.chapterNumber) : latest, 0),
    }]
  }))

  const titles = deduplicate(entries)
  let completed = 0
  let chaptersRead = 0
  let chaptersTotal = 0
  for (const item of titles) {
    const record = trackedRecord(item)
    if (record?.status === COMPLETED_STATUS) completed += 1

    const state = bound.get(boundSourceId(item) ?? -1)
    if (state) {
      const readThrough = Math.max(record?.lastChapterRead ?? 0, state.progress, state.localReadThrough)
      chaptersTotal += state.numbers.length
      chaptersRead += state.numbers.filter((chapterNumber) => chapterNumber <= readThrough).length
      continue
    }
    // No source behind the title yet, so AniList is the only one counting — the same fallback the
    // unread chip makes, and a title neither bound nor tracked contributes nothing rather than a
    // zero that would drag the total down.
    if (record && record.totalChapters > 0) {
      chaptersTotal += record.totalChapters
      chaptersRead += Math.min(record.totalChapters, Math.floor(record.lastChapterRead))
    }
  }
  return { titles: titles.length, completed, chaptersRead, chaptersTotal }
}

/**
 * The mean of the scores AniList actually holds.
 *
 * `TrackRecordType.score` is a non-null `Double`, so a record nobody ever scored reads as 0 and is
 * indistinguishable from a record scored zero — except that AniList has no zero on any of its
 * scales. Averaging the zeros in would report a library with two scored titles out of forty as
 * scoring almost nothing, so they are left out, and the pane says how many titles the mean is over.
 */
export function meanScore(scores: number[]): { mean: number; scored: number } {
  const given = scores.filter((score) => score > 0)
  if (given.length === 0) return { mean: 0, scored: 0 }
  return { mean: given.reduce((total, score) => total + score, 0) / given.length, scored: given.length }
}
