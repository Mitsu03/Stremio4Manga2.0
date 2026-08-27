/**
 * Whether a source actually carries chapters of a title it lists.
 *
 * A scraper only lists what it hosts, so everything it returns is readable. A catalogue does not:
 * MangaDex ranks *series* by follows, and a series whose chapters were taken down at the publisher's
 * request keeps its page — cover, synopsis, tags — with nothing behind it. Half of MangaDex's first
 * page of popular titles is like that (Solo Leveling, Slime, Frieren, One-Punch Man, Nagatoro), and
 * the only way to tell from the outside is to ask for the chapters.
 *
 * The source's own filters do not answer it. MangaDex offers "Has available chapters", but it is
 * ignored on the popular and latest lists (filters reach only search), and on search it still
 * returns One-Punch Man, because availability is counted across every language while the installed
 * source is English. Its "Show unavailable chapters" preference makes no difference either: there is
 * no chapter record at all, available or not.
 *
 * So each title is asked once, and the answer is kept:
 *   - chapters in the database        → carries chapters, nothing to ask
 *   - the meta marker below, recent   → asked before and came back empty
 *   - neither                         → ask, and record what came back
 */
import type { Client } from 'urql'

export const NO_CHAPTERS_META_KEY = 'stremio4manga.no-chapters'

/** How long an empty answer is trusted. A source can pick a title up again; a week is soon enough. */
export const NO_CHAPTERS_TTL = 7 * 24 * 60 * 60 * 1000

export const FETCH_CHAPTERS_MUTATION = `
  mutation FetchChapters($mangaId: Int!) {
    fetchChapters(input: { mangaId: $mangaId }) { chapters { id } }
  }
`

export const SET_NO_CHAPTERS_MUTATION = `
  mutation SetNoChapters($mangaId: Int!, $value: String!) {
    setMangaMeta(input: { meta: { mangaId: $mangaId, key: "${NO_CHAPTERS_META_KEY}", value: $value } }) {
      meta { key }
    }
  }
`

export const CLEAR_NO_CHAPTERS_MUTATION = `
  mutation ClearNoChapters($mangaId: Int!) {
    deleteMangaMeta(input: { mangaId: $mangaId, key: "${NO_CHAPTERS_META_KEY}" }) { meta { key } }
  }
`

/** The three fields a browse result needs for its verdict to be readable without another request. */
export interface AvailabilityFields {
  id: number
  chapters: { totalCount: number }
  meta: Array<{ key: string; value: string }>
}

export type Availability = 'has-chapters' | 'empty' | 'unknown'

export function knownAvailability(node: AvailabilityFields, now: number = Date.now()): Availability {
  if (node.chapters.totalCount > 0) return 'has-chapters'
  const marked = Number(node.meta.find((entry) => entry.key === NO_CHAPTERS_META_KEY)?.value)
  if (Number.isFinite(marked) && marked > 0 && now - marked < NO_CHAPTERS_TTL) return 'empty'
  return 'unknown'
}

/**
 * Source requests, one at a time **per source**.
 *
 * Section 8's sweep established what happens when a source is asked several things at once: it
 * starts refusing. Checking a page of results is twenty questions to one source, so they queue.
 *
 * They used to queue in a single global lane, which meant a question for MangaDex waited behind a
 * question for a WordPress scraper that had nothing to do with it. Survivable with six sources,
 * ruinous with several hundred: returning to the library sets off dozens of availability checks,
 * and the shelves took as long as their sum.
 *
 * A lane per source keeps the property that matters — no source is ever hit in parallel — and drops
 * the one that was never intended, that unrelated sources block each other. Nothing more is needed
 * here: the browser caps its own connections, and the server enforces the real politeness policy
 * (a minimum gap per host, a ceiling on requests in flight) where it cannot be bypassed.
 */
const lanes = new Map<string, Promise<unknown>>()

export function queueSourceRequest<T>(task: () => Promise<T>, key = 'shared'): Promise<T> {
  const lane = lanes.get(key) ?? Promise.resolve()
  const run = lane.then(task, task)
  const settled = run.catch(() => undefined)
  lanes.set(key, settled)
  // Drop the lane once it drains, unless something queued behind this task in the meantime —
  // otherwise the map keeps one dead entry per source for the life of the tab.
  void settled.then(() => {
    if (lanes.get(key) === settled) lanes.delete(key)
  })
  return run
}

/**
 * Asks the source for a title's chapters and records the answer. True when it has any.
 *
 * The empty answer is the one worth writing down — a source with nothing for a title says so with an
 * error ("No chapters found"), not with an empty list, and either way the title is not worth showing
 * again. A title that *does* answer needs nothing written: its chapters are now in the database,
 * which is the verdict.
 */
export async function verifyChapters(
  client: Client,
  mangaId: number,
  // Checked inside the queue rather than before it: a page of results is twenty questions deep, and
  // by the time the last one is asked the reader may be looking at another source entirely.
  abandoned?: () => boolean,
  // Which source this title belongs to, so the check queues behind that source's other questions
  // and not behind every other source's.
  sourceKey?: string,
): Promise<boolean | null> {
  const result = await queueSourceRequest(async () => {
    if (abandoned?.()) return null
    return client
      .mutation<{ fetchChapters: { chapters: Array<{ id: number }> } | null }>(FETCH_CHAPTERS_MUTATION, { mangaId })
      .toPromise()
  }, sourceKey)
  if (result === null) return null
  const found = (result.data?.fetchChapters?.chapters.length ?? 0) > 0
  if (found) {
    // Only reached when a stale marker expired and the title was asked again, so the old answer has
    // to go with it.
    void client.mutation(CLEAR_NO_CHAPTERS_MUTATION, { mangaId }).toPromise()
    return true
  }
  void client.mutation(SET_NO_CHAPTERS_MUTATION, { mangaId, value: String(Date.now()) }).toPromise()
  return false
}
