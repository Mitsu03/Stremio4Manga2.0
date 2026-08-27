/**
 * Asking a batch of catalogues the same question at once, and reporting back while it happens.
 *
 * Lifted out of the manga detail page so the machinery — chunking, the run-id guard against a stale
 * sweep overwriting a newer one, per-source progress, the saved answers — is one implementation
 * rather than one per page that needs it. It is a hook rather than a plain function because a sweep
 * of a dozen catalogues has to show its work: the caller wants results as they land, not a promise
 * that resolves once at the end.
 *
 * Every source that was asked comes back as an outcome, including the ones that had nothing and the
 * ones that fell over. The detail page only wants the shelves with hits in them; a search across
 * every catalogue also has to be able to say who answered and who did not.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { useMutation } from 'urql'
import { friendlyError } from './errors'
import { sortByTitleSimilarity } from './titleMatch'
import { FETCH_SOURCE_MANGA_BULK_MUTATION } from './sources'
import type { FetchSourceMangaBulkResult, SourceMangaNode, SourceNode } from './sources'

export interface SourceSearchResult { source: SourceNode; mangas: SourceMangaNode[] }
/** One source's answer: what it found, or why it could not be asked. */
export interface SourceSearchOutcome extends SourceSearchResult { error: string | null }
export interface SourceSearchProgress { completed: number; total: number; found: number; failed: number }
/** How much of the installed catalogue the results on hand cover. */
export type SearchScope = 'top' | 'all'

interface CachedSourceSearch {
  version: 3
  title: string
  scope: SearchScope
  sourceIds: string[]
  savedAt: number
  failed: number
  outcomes: Array<{ sourceId: string; mangas: SourceMangaNode[]; error: string | null }>
}

/** A cache entry that has been read back and re-attached to the sources it names. */
export interface StoredSourceSearch {
  outcomes: SourceSearchOutcome[]
  savedAt: number
  failed: number
  scope: SearchScope
  sourceIds: string[]
}

/**
 * One slot per thing that gets searched: a manga's own id for the detail page's bind flow, a fixed
 * name for Discover's sweep across every catalogue. Discover reuses its one slot rather than keeping
 * a slot per query, so a session of searching cannot fill the browser's storage; the entry records
 * the query it answered, and a different one simply misses.
 */
const sourceSearchCacheKey = (slot: string): string => `stremio4manga.source-search.v1.${slot}`
// Sources are searched in chunks: one GraphQL request per chunk, each fanned out in parallel on
// the server. A smaller chunk means more progress updates but more requests; the browser can run
// several chunk requests at once, and the server parallelises within each chunk.
const SOURCE_SEARCH_CHUNK_SIZE = 6

function isSourceMangaNode(value: unknown): value is SourceMangaNode {
  if (!value || typeof value !== 'object') return false
  const manga = value as Partial<SourceMangaNode>
  return typeof manga.id === 'number'
    && typeof manga.title === 'string'
    && (typeof manga.thumbnailUrl === 'string' || manga.thumbnailUrl === null)
}

export function readSourceSearchCache(slot: string, title: string, allSources: SourceNode[]): StoredSourceSearch | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(sourceSearchCacheKey(slot)) ?? 'null')
    if (!parsed || typeof parsed !== 'object') return null
    const cached = parsed as Partial<CachedSourceSearch>
    if (cached.version !== 3 || cached.title !== title || !Array.isArray(cached.sourceIds) || !Array.isArray(cached.outcomes)) return null
    if (cached.scope !== 'top' && cached.scope !== 'all') return null
    if (typeof cached.savedAt !== 'number' || typeof cached.failed !== 'number') return null

    const sourcesById = new Map(allSources.map((source) => [source.id, source]))
    const outcomes: SourceSearchOutcome[] = []
    for (const entry of cached.outcomes) {
      if (!entry || typeof entry !== 'object') return null
      const source = sourcesById.get(entry.sourceId)
      if (!source || !Array.isArray(entry.mangas) || !entry.mangas.every(isSourceMangaNode)) return null
      outcomes.push({ source, mangas: entry.mangas, error: typeof entry.error === 'string' ? entry.error : null })
    }
    return { outcomes, savedAt: cached.savedAt, failed: cached.failed, scope: cached.scope, sourceIds: cached.sourceIds }
  } catch {
    return null
  }
}

export function writeSourceSearchCache(slot: string, title: string, scope: SearchScope, searchedSources: SourceNode[], outcomes: SourceSearchOutcome[], failed: number): number | null {
  const savedAt = Date.now()
  const cached: CachedSourceSearch = {
    version: 3,
    title,
    scope,
    sourceIds: searchedSources.map((source) => source.id),
    savedAt,
    failed,
    outcomes: outcomes.map(({ source, mangas, error }) => ({
      sourceId: source.id,
      error,
      mangas: sortByTitleSimilarity(title, mangas).slice(0, 10),
    })),
  }
  try {
    localStorage.setItem(sourceSearchCacheKey(slot), JSON.stringify(cached))
    return savedAt
  } catch {
    return null
  }
}

export interface SourceSearch {
  /** Every source that was asked, in name order — hits, empties and failures alike. */
  outcomes: SourceSearchOutcome[]
  /** Just the ones that came back with something. */
  results: SourceSearchResult[]
  finding: boolean
  error: string | null
  progress: SourceSearchProgress | null
  cachedAt: number | null
  searchedAll: boolean
  /**
   * Searches `batch` in server-side chunks. `append` keeps earlier results (the long-tail sweep);
   * `scope` records how much of the catalogue the accumulated results now cover, for the cache.
   */
  runSearch: (batch: SourceNode[], append: boolean, scope: SearchScope) => Promise<void>
  /** Puts a saved answer back on screen without asking anybody anything. */
  applyCached: (cached: StoredSourceSearch) => void
}

/**
 * `slot` names the cache entry and `title` is the query; `searchSources` and `topSources` are the
 * two batches a completed sweep can have covered, and are what the cache records as its scope.
 */
export function useSourceSearch(slot: string, title: string, searchSources: SourceNode[], topSources: SourceNode[]): SourceSearch {
  const [, fetchSourceMangaBulk] = useMutation<FetchSourceMangaBulkResult>(FETCH_SOURCE_MANGA_BULK_MUTATION)
  const [outcomes, setOutcomes] = useState<SourceSearchOutcome[]>([])
  const [finding, setFinding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<SourceSearchProgress | null>(null)
  const [cachedAt, setCachedAt] = useState<number | null>(null)
  const [searchedAll, setSearchedAll] = useState(false)
  const searchRun = useRef(0)
  // Mirrors outcomes/failed synchronously so the cache can be written from the final tally
  // even when a run appends to earlier results (the "search all" sweep).
  const outcomesRef = useRef<SourceSearchOutcome[]>([])
  const failedRef = useRef(0)

  const record = useCallback((outcome: SourceSearchOutcome) => {
    outcomesRef.current = [...outcomesRef.current, outcome].sort((a, b) => a.source.name.localeCompare(b.source.name))
    setOutcomes(outcomesRef.current)
  }, [])

  const runSearch = useCallback(async (batch: SourceNode[], append: boolean, scope: SearchScope) => {
    if (batch.length === 0) return
    const runId = ++searchRun.current
    setFinding(true)
    setError(null)
    if (!append) {
      outcomesRef.current = []
      failedRef.current = 0
      setOutcomes([])
    }
    setProgress({ completed: 0, total: batch.length, found: 0, failed: 0 })
    setCachedAt(null)

    const sourcesById = new Map(batch.map((source) => [source.id, source]))
    const chunks: SourceNode[][] = []
    for (let i = 0; i < batch.length; i += SOURCE_SEARCH_CHUNK_SIZE) {
      chunks.push(batch.slice(i, i + SOURCE_SEARCH_CHUNK_SIZE))
    }

    let successful = 0
    let firstError: string | null = null

    await Promise.all(chunks.map(async (chunk) => {
      const result = await fetchSourceMangaBulk({ sources: chunk.map((source) => source.id), page: 1, query: title })
      if (searchRun.current !== runId) return

      // A transport-level failure sinks the whole chunk; count every source in it as failed.
      if (result.error) {
        const message = friendlyError(result.error)
        firstError ??= message
        failedRef.current += chunk.length
        chunk.forEach((source) => record({ source, mangas: [], error: message }))
        setProgress((current) => current ? { ...current, completed: current.completed + chunk.length, failed: current.failed + chunk.length } : current)
        return
      }

      const entries = result.data?.fetchSourceMangaBulk?.results ?? []
      let chunkFound = 0
      let chunkFailed = 0
      for (const entry of entries) {
        const source = sourcesById.get(entry.source)
        if (!source) continue
        if (entry.error) {
          firstError ??= entry.error
          chunkFailed += 1
          record({ source, mangas: [], error: entry.error })
          continue
        }
        successful += 1
        record({ source, mangas: sortByTitleSimilarity(title, entry.mangas).slice(0, 10), error: null })
        if (entry.mangas.length > 0) chunkFound += 1
      }
      failedRef.current += chunkFailed
      setProgress((current) => current ? {
        ...current,
        completed: current.completed + entries.length,
        found: current.found + chunkFound,
        failed: current.failed + chunkFailed,
      } : current)
    }))

    if (searchRun.current !== runId) return
    setFinding(false)
    setSearchedAll(scope === 'all')
    // An error is only worth showing when nothing came back at all: a long-tail sweep where every
    // remaining catalogue fails must not wipe out the hits the first batch already found.
    const anyHits = outcomesRef.current.some((outcome) => !outcome.error && outcome.mangas.length > 0)
    if (!anyHits && successful === 0 && firstError) setError(firstError)
    else {
      const searchedSources = scope === 'all' ? searchSources : topSources
      setCachedAt(writeSourceSearchCache(slot, title, scope, searchedSources, outcomesRef.current, failedRef.current))
    }
  }, [slot, searchSources, topSources, title, fetchSourceMangaBulk, record])

  const applyCached = useCallback((cached: StoredSourceSearch) => {
    // Bumped so a sweep still in flight from a previous title cannot land on top of the saved answer.
    searchRun.current += 1
    outcomesRef.current = cached.outcomes
    failedRef.current = cached.failed
    setOutcomes(cached.outcomes)
    setProgress({
      completed: cached.sourceIds.length,
      total: cached.sourceIds.length,
      found: cached.outcomes.filter((outcome) => !outcome.error && outcome.mangas.length > 0).length,
      failed: cached.failed,
    })
    setCachedAt(cached.savedAt)
    setSearchedAll(cached.scope === 'all')
    setFinding(false)
    setError(null)
  }, [])

  const results = useMemo(
    () => outcomes.filter((outcome) => !outcome.error && outcome.mangas.length > 0),
    [outcomes],
  )

  return { outcomes, results, finding, error, progress, cachedAt, searchedAll, runSearch, applyCached }
}
