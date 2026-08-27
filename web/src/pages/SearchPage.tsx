import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useClient, useMutation, useQuery } from 'urql'
import { Link, useSearchParams } from 'react-router-dom'
import { friendlyError } from '../utils/errors'
import { t } from '../utils/i18n'
import { knownAvailability, queueSourceRequest, verifyChapters } from '../utils/availability'
import { browsableSources, INITIAL_SOURCE_COUNT, preferredSourcePerName, prioritizedSources, recommendedSources, PREFERRED_LANG, PREFERRED_SOURCE } from '../utils/sources'
import type { SourceNode } from '../utils/sources'
import { readSourceSearchCache, usePatience, useSourceSearch } from '../utils/sourceSearch'
import {
  SAVED_SEARCHES_QUERY,
  SET_SAVED_SEARCHES_MUTATION,
  savedSearchesFromMeta,
  searchKey,
  withSearchRemoved,
  withSearchSaved,
} from '../utils/savedSearches'
import type { SavedSearch } from '../utils/savedSearches'
import {
  currentFilterValue,
  filterChanges,
  filterKey,
  hasSettableFilters,
  SOURCE_FILTERS_QUERY,
  withFilterValue,
} from '../utils/sourceFilters'
import type { FilterValue, FilterValues, SourceFilter, SourceFiltersResult, TriState } from '../utils/sourceFilters'
import { flag } from '../utils/settings'

const SOURCES_QUERY = `
  query Sources {
    sources {
      nodes { id name lang iconUrl supportsLatest }
    }
  }
`

const FETCH_SOURCE_MANGA_MUTATION = `
  mutation FetchSourceManga($source: LongString!, $type: FetchSourceMangaType!, $page: Int!, $query: String) {
    fetchSourceManga(input: { source: $source, type: $type, page: $page, query: $query }) {
      hasNextPage
      mangas { id title thumbnailUrl inLibrary chapters { totalCount } meta { key value } }
    }
  }
`

// The same call, with the source's own filters attached. Kept as a second document rather than an
// optional variable on the first: with nothing in the panel touched, the request that leaves the
// browser is the one that left it before the panel existed.
const FETCH_FILTERED_SOURCE_MANGA_MUTATION = `
  mutation FetchFilteredSourceManga($source: LongString!, $type: FetchSourceMangaType!, $page: Int!, $query: String, $filters: [FilterChangeInput!]) {
    fetchSourceManga(input: { source: $source, type: $type, page: $page, query: $query, filters: $filters }) {
      hasNextPage
      mangas { id title thumbnailUrl inLibrary chapters { totalCount } meta { key value } }
    }
  }
`

const IMPORT_ANILIST_LIBRARY_MUTATION = `
  mutation ImportAnilistLibrary { importAnilistLibrary(input: {}) { manga { id } } }
`

type BrowseType = 'POPULAR' | 'LATEST' | 'SEARCH'
type IconName = 'search' | 'spark' | 'clock' | 'refresh' | 'layers' | 'arrowDown' | 'arrowUp' | 'close' | 'pin' | 'pinned' | 'filters' | 'globe' | 'hourglass'

/** Where the answers to one all-sources search are kept, so coming back does not re-ask everybody. */
const GLOBAL_SEARCH_SLOT = 'discover'

/** How many of a saved search's results a shelf shows. A feed is a glance, not a results page. */
const FEED_SHELF_SIZE = 8

/** What counts as a full page of results once the unreadable ones have been taken out. */
const FULL_GRID = 20
/** How many extra pages one search may pull in to fill the grid, before it waits to be asked. */
const MAX_TOP_UP_PAGES = 3

interface FullSource extends SourceNode { supportsLatest: boolean }
interface SourceMangaNode {
  id: number
  title: string
  thumbnailUrl: string | null
  inLibrary: boolean
  // What decides whether the card is shown at all: chapters already in the database say the source
  // carries the title, and the meta marker says it was asked and had none.
  chapters: { totalCount: number }
  meta: Array<{ key: string; value: string }>
}
interface FetchSourceMangaResult { fetchSourceManga: { hasNextPage: boolean; mangas: SourceMangaNode[] } }

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
    spark: <><path d="M12 3 9.7 9.7 3 12l6.7 2.3L12 21l2.3-6.7L21 12l-6.7-2.3L12 3Z" /><path d="m5 4 .7 2.3L8 7l-2.3.7L5 10l-.7-2.3L2 7l2.3-.7L5 4Z" /></>,
    clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.5 2" /></>,
    hourglass: <><path d="M7 3h10M7 21h10" /><path d="M8 3v4l4 5 4-5V3" /><path d="M8 21v-4l4-5 4 5v4" /></>,
    refresh: <><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M18.5 11A7 7 0 0 0 6.1 7.3L4 11M5.5 13A7 7 0 0 0 17.9 16.7L20 13" /></>,
    layers: <><path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" /><path d="m4 12 8 4.5 8-4.5" /><path d="m4 16.5 8 4.5 8-4.5" /></>,
    arrowDown: <><path d="M12 4v15" /><path d="m6 13 6 6 6-6" /></>,
    arrowUp: <><path d="M12 20V5" /><path d="m6 11 6-6 6 6" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    // Sliders rather than a funnel: what the panel holds is a set of dials the source itself named,
    // not a sieve the app applies afterwards.
    filters: <><path d="M4 7h11M19 7h1M4 17h5M13 17h7" /><circle cx="17" cy="7" r="2" /><circle cx="11" cy="17" r="2" /></>,
    globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17" /><path d="M12 3.5a13 13 0 0 1 0 17a13 13 0 0 1 0-17Z" /></>,
    // A bookmark, empty or filled: the same shape either way, so saving and unsaving are one control
    // rather than two that look alike.
    pin: <path d="M6.5 3.75h11v16.5L12 15.9l-5.5 4.35V3.75Z" />,
    pinned: <path className="solid" d="M6.5 3.75h11v16.5L12 15.9l-5.5 4.35V3.75Z" />,
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>
}

function SourceMark({ source }: { source: FullSource }) {
  if (source.iconUrl) return <img src={source.iconUrl} alt="" />
  return <span aria-hidden="true">{source.name.slice(0, 1)}</span>
}

// Results already fetched this session, so walking away from Discover and back does not ask every
// source again. Module-level on purpose: the shelves are remounted on every visit, and a cache that
// dies with them would not be a cache.
const feedCache = new Map<string, SourceMangaNode[]>()

/** One saved search, as a shelf of what it finds today. */
function SavedSearchShelf({ search, installed, onOpen, onRemove }: {
  search: SavedSearch
  installed: boolean
  onOpen: (search: SavedSearch) => void
  onRemove: (search: SavedSearch) => void
}) {
  const [mangas, setMangas] = useState<SourceMangaNode[] | null>(() => feedCache.get(search.key) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [, fetchSourceManga] = useMutation<FetchSourceMangaResult>(FETCH_SOURCE_MANGA_MUTATION)
  const client = useClient()

  useEffect(() => {
    if (!installed || feedCache.has(search.key)) return
    let live = true
    setLoading(true)
    queueSourceRequest(() => fetchSourceManga({ source: search.sourceId, type: 'SEARCH', page: 1, query: search.query }), search.sourceId)
      .then((result) => {
        if (!live) return
        setLoading(false)
        if (result.error) {
          // Named rather than swallowed: a source behind Cloudflare is the normal failure here, and the
          // reader has to be able to tell "nothing new" from "could not ask".
          setError(friendlyError(result.error))
          return
        }
        // The same rule the results grid follows: a title this source has no chapters of is not
        // worth a card. The ones already known to be empty never appear; the unknowns are asked in
        // the background and leave the shelf as the answers come back.
        const answered = (result.data?.fetchSourceManga.mangas ?? []).filter((item) => knownAvailability(item) !== 'empty')
        const found = answered.slice(0, FEED_SHELF_SIZE)
        feedCache.set(search.key, found)
        setMangas(found)
        found
          .filter((item) => knownAvailability(item) === 'unknown')
          .forEach((item) => {
            void verifyChapters(client, item.id, () => !live, search.sourceId).then((has) => {
              if (has !== false || !live) return
              setMangas((current) => {
                const next = (current ?? []).filter((node) => node.id !== item.id)
                feedCache.set(search.key, next)
                return next
              })
            })
          })
      })
    return () => { live = false }
  }, [client, fetchSourceManga, installed, search.key, search.query, search.sourceId])

  return (
    <section className="shelf feed-shelf">
      <div className="shelf-heading">
        <h2>{search.query}</h2>
        <span>{search.sourceName}</span>
        {installed && (
          <button
            type="button"
            className="discover-icon-button small shelf-heading-action"
            onClick={() => onOpen(search)}
            aria-label={t('Run “{query}” on {source} again', { query: search.query, source: search.sourceName })}
            title={t('Open this search')}
          ><Icon name="search" /></button>
        )}
        <button
          type="button"
          className={`discover-icon-button small${installed ? '' : ' shelf-heading-action'}`}
          onClick={() => onRemove(search)}
          aria-label={t('Forget the saved search “{query}” on {source}', { query: search.query, source: search.sourceName })}
          title={t('Forget this search')}
        ><Icon name="close" /></button>
      </div>
      {!installed ? (
        <div className="state-panel compact"><p>{t('{source} is not installed on this server.', { source: search.sourceName })}</p></div>
      ) : error ? (
        <div className="notice error">{error}</div>
      ) : loading || mangas === null ? (
        <div className="state-panel compact"><p>{t('Asking {source}…', { source: search.sourceName })}</p></div>
      ) : mangas.length === 0 ? (
        <div className="state-panel compact"><p>{t('Nothing came back for this search today.')}</p></div>
      ) : (
        <div className="grid">
          {mangas.map((item) => (
            <Link key={item.id} to={`/manga/${item.id}?source=${encodeURIComponent(search.sourceId)}`} className="card">
              <div className="cover-wrap">
                {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <div className="cover-placeholder" />}
                {item.inLibrary && <span className="progress-chip">{t('In library')}</span>}
              </div>
              <div className="title">{item.title}</div>
            </Link>
          ))}
        </div>
      )}
    </section>
  )
}

const TRI_STATE_CYCLE: Record<TriState, TriState> = { IGNORE: 'INCLUDE', INCLUDE: 'EXCLUDE', EXCLUDE: 'IGNORE' }
const TRI_STATE_MARK: Record<TriState, string> = { IGNORE: '–', INCLUDE: '✓', EXCLUDE: '✕' }

function triStateLabel(state: TriState): string {
  if (state === 'INCLUDE') return t('included')
  if (state === 'EXCLUDE') return t('excluded')
  return t('ignored')
}

/**
 * One row of the filter panel.
 *
 * `path` is the filter's position in the list the source returned — every index counted, headers and
 * separators included — dotted with the child's index inside a group. It is passed down rather than
 * derived from what is drawn, because the server looks a change up by that index and a panel that
 * renumbered around the rows it chose not to draw would apply the wrong filter without saying so.
 *
 * Filter names come from the source and are shown as it wrote them; only the panel's own words are
 * translated.
 */
function FilterRow({ filter, path, values, onSet }: {
  filter: SourceFilter
  path: number[]
  values: FilterValues
  onSet: (path: number[], filter: SourceFilter, value: FilterValue) => void
}) {
  const current = currentFilterValue(values, path, filter)

  switch (filter.__typename) {
    case 'HeaderFilter':
      return <h3 className="source-filter-header">{filter.name}</h3>
    case 'SeparatorFilter':
      return <hr className="source-filter-separator" />
    case 'GroupFilter':
      return (
        <fieldset className="source-filter-group">
          <legend>{filter.name}</legend>
          {(filter.filters ?? []).map((child, index) => (
            <FilterRow key={filterKey([...path, index])} filter={child} path={[...path, index]} values={values} onSet={onSet} />
          ))}
        </fieldset>
      )
    case 'CheckBoxFilter': {
      const checked = current?.kind === 'checkBox' ? current.value : false
      return (
        <label className="source-filter-row check">
          <input type="checkbox" checked={checked} onChange={(event) => onSet(path, filter, { kind: 'checkBox', value: event.target.checked })} />
          <span>{filter.name}</span>
        </label>
      )
    }
    case 'TriStateFilter': {
      const state = current?.kind === 'triState' ? current.value : 'IGNORE'
      return (
        <button
          type="button"
          className={`source-filter-row tri ${state.toLowerCase()}`}
          onClick={() => onSet(path, filter, { kind: 'triState', value: TRI_STATE_CYCLE[state] })}
          aria-label={t('{name} — {state}', { name: filter.name, state: triStateLabel(state) })}
        >
          <span className="source-filter-mark" aria-hidden="true">{TRI_STATE_MARK[state]}</span>
          <span>{filter.name}</span>
        </button>
      )
    }
    case 'TextFilter': {
      const text = current?.kind === 'text' ? current.value : ''
      return (
        <label className="source-filter-row field">
          <span>{filter.name}</span>
          <input value={text} onChange={(event) => onSet(path, filter, { kind: 'text', value: event.target.value })} />
        </label>
      )
    }
    case 'SelectFilter': {
      const selected = current?.kind === 'select' ? current.value : 0
      return (
        <label className="source-filter-row field">
          <span>{filter.name}</span>
          <select value={selected} onChange={(event) => onSet(path, filter, { kind: 'select', value: Number(event.target.value) })}>
            {(filter.values ?? []).map((option, index) => <option key={`${index}:${option}`} value={index}>{option}</option>)}
          </select>
        </label>
      )
    }
    case 'SortFilter': {
      // A source that ships no sort preference still has to show something; nothing is sent until
      // one of the two halves is actually moved.
      const sort = current?.kind === 'sort' ? current.value : { index: 0, ascending: true }
      return (
        <div className="source-filter-row field sort">
          <label>
            <span>{filter.name}</span>
            <select value={sort.index} onChange={(event) => onSet(path, filter, { kind: 'sort', value: { index: Number(event.target.value), ascending: sort.ascending } })}>
              {(filter.values ?? []).map((option, index) => <option key={`${index}:${option}`} value={index}>{option}</option>)}
            </select>
          </label>
          <button
            type="button"
            className="discover-icon-button small"
            onClick={() => onSet(path, filter, { kind: 'sort', value: { index: sort.index, ascending: !sort.ascending } })}
            aria-label={sort.ascending ? t('Sorted from the smallest up — press to sort down') : t('Sorted from the largest down — press to sort up')}
            title={sort.ascending ? t('Ascending') : t('Descending')}
          ><Icon name={sort.ascending ? 'arrowUp' : 'arrowDown'} /></button>
        </div>
      )
    }
  }
}

// Open unless folded away, and on the account rather than in this browser ([[settings.ts]]).
const FEED_OPEN = flag('discover.feed-open', true)

export default function SearchPage() {
  const [{ data: sourcesData, fetching: loadingSources, error: sourcesError }] = useQuery<{ sources: { nodes: FullSource[] } }>({ query: SOURCES_QUERY, requestPolicy: 'cache-and-network' })
  const sources = useMemo(() => browsableSources(sourcesData?.sources.nodes ?? []) as FullSource[], [sourcesData])
  const sourceChoices = useMemo(() => preferredSourcePerName(sources) as FullSource[], [sources])

  // Discover is also where the manga detail page sends its genre chips, and it hands the tag over
  // in the url. Seeding the search from it — rather than only from the form — is what makes a chip
  // land on results instead of on whatever this source happens to be showing.
  const [searchParams] = useSearchParams()
  const requestedQuery = searchParams.get('q')?.trim() ?? ''

  const [sourceId, setSourceId] = useState('')
  const [mode, setMode] = useState<BrowseType>(requestedQuery ? 'SEARCH' : 'POPULAR')
  const [query, setQuery] = useState(requestedQuery)
  const [submittedQuery, setSubmittedQuery] = useState(requestedQuery)
  const [page, setPage] = useState(1)
  const [mangas, setMangas] = useState<SourceMangaNode[]>([])
  // Results the source turned out to have no chapters of. Kept apart from `mangas` so a card can be
  // taken away without the list it came in being rewritten under the reader.
  const [hidden, setHidden] = useState<Set<number>>(new Set())
  const [checking, setChecking] = useState(0)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const client = useClient()
  const [, fetchSourceManga] = useMutation<FetchSourceMangaResult>(FETCH_SOURCE_MANGA_MUTATION)
  const [, fetchFilteredSourceManga] = useMutation<FetchSourceMangaResult>(FETCH_FILTERED_SOURCE_MANGA_MUTATION)
  const [importResult, importLibrary] = useMutation<{ importAnilistLibrary: { manga: { id: number }[] } }>(IMPORT_ANILIST_LIBRARY_MUTATION)
  const [imported, setImported] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Saved searches, and the feed built from them.
  const [{ data: savedData }, refetchSaved] = useQuery<{ metas: { nodes: Array<{ key: string; value: string }> } }>({
    query: SAVED_SEARCHES_QUERY,
    requestPolicy: 'cache-and-network',
  })
  const [, persistSavedSearches] = useMutation(SET_SAVED_SEARCHES_MUTATION)
  const [savingSearch, setSavingSearch] = useState(false)
  const [savedError, setSavedError] = useState<string | null>(null)
  const [feedOpen, setFeedOpen] = FEED_OPEN.use()
  const saved = useMemo(() => savedSearchesFromMeta(savedData?.metas.nodes), [savedData])

  // What this source says it can be asked. Only ever for the source being browsed: `filters()` runs
  // the extension's own getFilterList, so asking all of them at once would be a dozen extension
  // calls for a panel nobody has opened.
  const [{ data: filtersData }] = useQuery<SourceFiltersResult>({
    query: SOURCE_FILTERS_QUERY,
    variables: { source: sourceId },
    pause: !sourceId,
    requestPolicy: 'cache-first',
  })
  // Checked against the source that is actually selected: an answer still arriving for the previous
  // one describes a different list, and its positions would mean different questions.
  const sourceFilters = useMemo(
    () => (filtersData?.source?.id === sourceId ? filtersData.source.filters : []),
    [filtersData, sourceId],
  )
  // `filterValues` is what the results on screen were fetched with; `filterDraft` is what the open
  // panel is being edited to. The draft is re-seeded every time the panel opens, so a panel that is
  // closed without applying leaves no trace and the collapsed count is never a lie.
  const [filterValues, setFilterValues] = useState<FilterValues>({})
  const [filterDraft, setFilterDraft] = useState<FilterValues>({})
  const [filtersOpen, setFiltersOpen] = useState(false)
  const appliedFilters = useMemo(() => filterChanges(filterValues), [filterValues])
  const filterCount = Object.keys(filterValues).length

  // Filters live next to the source, not next to the query: position 3 asks a different question in
  // the next catalogue's list, so switching source throws them away rather than misapplying them.
  useEffect(() => {
    setFilterValues({})
    setFilterDraft({})
    setFiltersOpen(false)
  }, [sourceId])

  const setFilterAt = useCallback((path: number[], filter: SourceFilter, value: FilterValue) => {
    setFilterDraft((current) => withFilterValue(current, path, filter, value))
  }, [])


  // The state above already carries the tag this page was opened with, so this only has to catch a
  // *later* one — a second chip arriving while Discover is still mounted. Tracking what was applied
  // keeps it from overwriting a search the user has since typed by hand.
  // Bumped whenever the source, mode or query changes, so answers to the previous page's questions
  // cannot take cards off the one now on screen.
  const verifying = useRef(0)
  // How many pages this search has pulled in on its own to make up for hidden results.
  const toppedUp = useRef(0)

  const appliedQuery = useRef(requestedQuery)
  useEffect(() => {
    if (!requestedQuery || appliedQuery.current === requestedQuery) return
    appliedQuery.current = requestedQuery
    setMode('SEARCH')
    setQuery(requestedQuery)
    setSubmittedQuery(requestedQuery)
  }, [requestedQuery])

  useEffect(() => {
    if (sourceId || sources.length === 0) return
    const preferred = sources.find((source) => source.name === PREFERRED_SOURCE && source.lang === PREFERRED_LANG)
      ?? sources.find((source) => source.name === PREFERRED_SOURCE)
      ?? sources[0]
    setSourceId(preferred.id)
  }, [sourceId, sources])

  const activeSource = sources.find((source) => source.id === sourceId)
  const visible = useMemo(() => mangas.filter((item) => !hidden.has(item.id)), [hidden, mangas])
  const effectiveMode: BrowseType = mode === 'LATEST' && activeSource && !activeSource.supportsLatest ? 'POPULAR' : mode

  // Asking every catalogue at once. One language variant per catalogue, recommended ones first — the
  // same batch the detail page's bind flow sweeps, for the same reason: MangaDex answers the same
  // question once, not once per language it is installed in.
  const [allSources, setAllSources] = useState(false)
  // One setting for the whole app; see usePatience.
  const [waitLonger, toggleWaitLonger] = usePatience()
  const globalBatch = useMemo(() => prioritizedSources(sourceChoices), [sourceChoices])
  /* Recommended catalogues first, the long tail after — the same two-stage shape the detail page's
     bind flow uses. Asking every installed catalogue in one go was fine when that meant six; with
     several hundred it means the reader watches a spinner for minutes before the first answer, and
     the answer they wanted was almost always in the first dozen. Falls back to the leading few when
     none of the recommended ones are installed, so the first stage is never empty. */
  const globalTop = useMemo(() => {
    const recommended = recommendedSources(globalBatch)
    return recommended.length > 0 ? recommended : globalBatch.slice(0, INITIAL_SOURCE_COUNT)
  }, [globalBatch])
  const globalRest = useMemo(() => {
    const first = new Set(globalTop.map((source) => source.id))
    return globalBatch.filter((source) => !first.has(source.id))
  }, [globalBatch, globalTop])
  const {
    outcomes: globalOutcomes,
    results: globalResults,
    finding: globalFinding,
    progress: globalProgress,
    cachedAt: globalCachedAt,
    runSearch: runGlobalSearch,
    applyCached: applyGlobalCache,
  } = useSourceSearch(GLOBAL_SEARCH_SLOT, submittedQuery, globalBatch, globalBatch)
  const showingAllSources = allSources && effectiveMode === 'SEARCH' && Boolean(submittedQuery)
  const sweptFor = useRef<string | null>(null)

  useEffect(() => {
    if (!showingAllSources || globalBatch.length === 0) return
    const key = `${globalBatch.map((source) => source.id).join(',')}:${submittedQuery}`
    if (sweptFor.current === key) return
    sweptFor.current = key

    const cached = readSourceSearchCache(GLOBAL_SEARCH_SLOT, submittedQuery, globalBatch)
    // The saved answer is only the answer if it covered the same catalogues; installing a source
    // since makes it a different question.
    if (cached && cached.sourceIds.length === globalBatch.length && cached.sourceIds.every((id) => globalBatch.some((source) => source.id === id))) {
      applyGlobalCache(cached)
      return
    }
    // Recommended first so there is something on screen in seconds, then the rest appended as they
    // answer. `append` is what makes the second stage add to the first rather than replace it, and
    // the scope only becomes 'all' once the tail has actually been asked.
    void runGlobalSearch(globalTop, false, globalRest.length === 0 ? 'all' : 'top', waitLonger).then(() => {
      if (sweptFor.current !== key || globalRest.length === 0) return
      return runGlobalSearch(globalRest, true, 'all', waitLonger)
    })
  }, [applyGlobalCache, globalBatch, globalRest, globalTop, runGlobalSearch, showingAllSources, submittedQuery, waitLonger])

  const globalQuiet = useMemo(() => globalOutcomes.filter((outcome) => !outcome.error && outcome.mangas.length === 0), [globalOutcomes])
  const globalBroken = useMemo(() => globalOutcomes.filter((outcome) => outcome.error), [globalOutcomes])

  /**
   * Takes away the results this source cannot serve.
   *
   * The cards are shown first and leave as the answers arrive. Holding the grid back until every
   * title had been asked would mean a Discover that shows nothing for several seconds on an API and
   * for half a minute on a scraper — and most of what it would be waiting for is already known.
   */
  const verify = useCallback((nodes: SourceMangaNode[]) => {
    const token = verifying.current
    const settled = nodes.filter((node) => knownAvailability(node) === 'empty').map((node) => node.id)
    if (settled.length > 0) setHidden((current) => new Set([...current, ...settled]))

    const unknown = nodes.filter((node) => knownAvailability(node) === 'unknown')
    if (unknown.length === 0) return
    setChecking((count) => count + unknown.length)
    unknown.forEach((node) => {
      void verifyChapters(client, node.id, () => verifying.current !== token, sourceId ?? undefined).then((has) => {
        if (verifying.current !== token) return
        if (has === false) setHidden((current) => new Set([...current, node.id]))
        setChecking((count) => count - 1)
      })
    })
  }, [client])

  const load = useCallback(
    async (nextPage: number, replace: boolean) => {
      if (!activeSource) return
      // A search across every catalogue is run by the sweep below, not one page at a time from here.
      if (allSources && effectiveMode === 'SEARCH') return
      // Filters alone are a search: "everything this source has under this tag" is a question worth
      // asking with the box empty. Without them an empty box is still nothing to ask.
      if (effectiveMode === 'SEARCH' && !submittedQuery && appliedFilters.length === 0) return
      setLoading(true)
      setLoadError(null)
      const variables = {
        source: activeSource.id,
        type: effectiveMode,
        page: nextPage,
        query: effectiveMode === 'SEARCH' ? submittedQuery : null,
      }
      // Only a search carries filters — the server ignores them on popular and latest.
      const result = effectiveMode === 'SEARCH' && appliedFilters.length > 0
        ? await fetchFilteredSourceManga({ ...variables, filters: appliedFilters })
        : await fetchSourceManga(variables)
      setLoading(false)
      if (result.error) { setLoadError(friendlyError(result.error)); return }
      const payload = result.data?.fetchSourceManga
      if (!payload) return
      setHasNextPage(payload.hasNextPage)
      setPage(nextPage)
      setMangas((current) => (replace ? payload.mangas : [...current, ...payload.mangas]))
      verify(payload.mangas)
    },
    [activeSource, allSources, appliedFilters, effectiveMode, submittedQuery, fetchFilteredSourceManga, fetchSourceManga, verify],
  )

  useEffect(() => {
    setMangas([])
    setHidden(new Set())
    setChecking(0)
    setHasNextPage(false)
    verifying.current += 1
    toppedUp.current = 0
    load(1, true)
  }, [load])

  // A page that loses half its cards would leave a short grid, so the next one is pulled in behind
  // it — "skip to the next" as asked for, bounded so a catalogue that is mostly unreadable cannot
  // walk the reader through the whole source one page at a time.
  useEffect(() => {
    if (loading || checking > 0 || !hasNextPage || toppedUp.current >= MAX_TOP_UP_PAGES) return
    if (mangas.length - hidden.size >= FULL_GRID) return
    toppedUp.current += 1
    void load(page + 1, false)
  }, [checking, hasNextPage, hidden.size, load, loading, mangas.length, page])

  const selectSource = (source: FullSource) => {
    setSourceId(source.id)
    setMode('POPULAR')
    setSubmittedQuery('')
    setPickerOpen(false)
  }

  const browse = (nextMode: Extract<BrowseType, 'POPULAR' | 'LATEST'>) => {
    setMode(nextMode)
    setSubmittedQuery('')
  }

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    setMode('SEARCH')
    setSubmittedQuery(query.trim())
  }

  const toggleFilters = () => {
    if (filtersOpen) { setFiltersOpen(false); return }
    setFilterDraft(filterValues)
    setFiltersOpen(true)
  }

  // Applying is what runs the search: a request per checkbox would ask the source a dozen questions
  // on the way to the one being assembled.
  const applyFilters = () => {
    setFilterValues(filterDraft)
    setFiltersOpen(false)
    setMode('SEARCH')
    setSubmittedQuery(query.trim())
  }

  // What is on screen right now, as a saved search would identify it. Only a submitted search counts:
  // "popular on this source" is not a search, and there would be nothing to re-run.
  const currentKey = activeSource && effectiveMode === 'SEARCH' && submittedQuery
    ? searchKey(activeSource.id, submittedQuery)
    : null
  const currentIsSaved = Boolean(currentKey && saved.some((item) => item.key === currentKey))

  const writeSaved = async (next: SavedSearch[]) => {
    setSavingSearch(true)
    setSavedError(null)
    const result = await persistSavedSearches({ value: JSON.stringify(next) })
    setSavingSearch(false)
    if (result.error) {
      setSavedError(friendlyError(result.error))
      return
    }
    // Re-read rather than trusting the write: the list lives on the server, and another browser may
    // have added to it since this one loaded.
    refetchSaved({ requestPolicy: 'network-only' })
  }

  const toggleSaved = () => {
    if (!activeSource || !currentKey) return
    if (currentIsSaved) {
      writeSaved(withSearchRemoved(saved, currentKey))
      return
    }
    writeSaved(withSearchSaved(saved, { sourceId: activeSource.id, sourceName: activeSource.name, query: submittedQuery }))
  }

  // A result is opened as a result *of this source*: the link carries the catalogue it was found in
  // so the detail page reads from it, rather than from whatever source the title happens to have been
  // bound to on some other day.
  const resultLink = (mangaId: number) =>
    activeSource ? `/manga/${mangaId}?source=${encodeURIComponent(activeSource.id)}` : `/manga/${mangaId}`

  // Running a saved search puts it back in the console, so what comes next — another page, a different
  // mode, saving it again — behaves exactly as if it had just been typed.
  const openSaved = (search: SavedSearch) => {
    setSourceId(search.sourceId)
    setMode('SEARCH')
    setQuery(search.query)
    setSubmittedQuery(search.query)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="discover-page">
      <header className="discover-header">
        <div><span className="eyebrow">{t('Manga sources')}</span><h1>{t('Discover')}</h1></div>
        <button
          type="button"
          className={`discover-icon-button discover-sync-button${importResult.fetching ? ' loading' : ''}`}
          disabled={importResult.fetching}
          onClick={async () => {
            setImported(null)
            const result = await importLibrary({})
            if (!result.error) setImported(result.data?.importAnilistLibrary.manga.length ?? 0)
          }}
          aria-label={importResult.fetching ? t('Syncing AniList library') : t('Sync AniList library')}
          title={importResult.fetching ? t('Syncing AniList library') : t('Sync AniList library')}
        ><Icon name="refresh" /></button>
      </header>

      {imported !== null && <div className="notice">{t('Synced {count} titles from AniList.', { count: imported })} <Link to="/">{t('Open your library')}</Link></div>}
      {importResult.error && <div className="notice error">{friendlyError(importResult.error)}</div>}
      {sourcesError && <div className="notice error">{friendlyError(sourcesError)}</div>}
      {loadingSources && <div className="state-panel compact"><p>{t('Loading sources…')}</p></div>}

      {activeSource && (
        <section className="discover-console" aria-label={t('Discover controls')}>
          <div className="discover-source">
            <div className="discover-source-mark"><SourceMark source={activeSource} /></div>
            <div className="discover-source-copy">
              <span className="eyebrow">{t('Browsing from')}</span>
              <strong>{activeSource.name}</strong>
              <small>{activeSource.lang}</small>
            </div>
            <button type="button" className="discover-icon-button" onClick={() => setPickerOpen((open) => !open)} aria-label={t('Choose a manga source')} aria-expanded={pickerOpen} title={t('Choose source')}>
              <Icon name={pickerOpen ? 'close' : 'layers'} />
            </button>
          </div>
          <div className="discover-modes" role="group" aria-label={t('Browse mode')}>
            <button type="button" className={effectiveMode === 'POPULAR' ? 'active' : ''} onClick={() => browse('POPULAR')} aria-label={t('Popular titles')} aria-pressed={effectiveMode === 'POPULAR'} title={t('Popular')}><Icon name="spark" /></button>
            {activeSource.supportsLatest && <button type="button" className={effectiveMode === 'LATEST' ? 'active' : ''} onClick={() => browse('LATEST')} aria-label={t('Latest releases')} aria-pressed={effectiveMode === 'LATEST'} title={t('Latest')}><Icon name="clock" /></button>}
            {/* Not a third way of browsing but a wider way of searching: popular and latest still come
                from the source in the pill, and only a typed search fans out. */}
            <button type="button" className={allSources ? 'active' : ''} onClick={() => setAllSources((on) => !on)} aria-label={allSources ? t('Search only the chosen source') : t('Search every installed source')} aria-pressed={allSources} title={t('Every source')}><Icon name="globe" /></button>
            {allSources && (
              <button type="button" className={waitLonger ? 'active' : ''} onClick={toggleWaitLonger} aria-label={waitLonger ? t('Stop waiting for slow sources') : t('Wait longer for slow sources')} aria-pressed={waitLonger} title={waitLonger ? t('Waiting for slow sources') : t('Skip slow sources')}><Icon name="hourglass" /></button>
            )}
          </div>

          {pickerOpen && (
            <div className="discover-source-picker" role="region" aria-label={t('Available manga sources')}>
              <p>{t('Choose a source')}</p>
              <div>
                {sourceChoices.map((source) => (
                  <button key={source.id} type="button" className={source.id === activeSource.id ? 'active' : ''} onClick={() => selectSource(source)} aria-label={`${source.name}, ${source.lang}`} aria-pressed={source.id === activeSource.id} title={`${source.name} · ${source.lang}`}>
                    <SourceMark source={source} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      <form className="search-box discover-search" onSubmit={submitSearch}>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('Search this source')} aria-label={t('Search source')} />
        <button className="discover-search-button" type="submit" aria-label={t('Search this source')} title={t('Search')}><Icon name="search" /></button>
        {/* A source that reports nothing settable gets no control at all — an empty panel is worse
            than none. The count rides on the button so a folded-away panel still says what is set. */}
        {hasSettableFilters(sourceFilters) && (
          <button
            type="button"
            className={`discover-icon-button discover-filter-button${filterCount > 0 ? ' active' : ''}`}
            onClick={toggleFilters}
            aria-expanded={filtersOpen}
            aria-label={filterCount > 0
              ? t('Filters on {source} — {count} set', { source: activeSource?.name ?? '', count: filterCount })
              : t('Filter what {source} is asked', { source: activeSource?.name ?? '' })}
            title={filterCount > 0 ? t('Filters ({count})', { count: filterCount }) : t('Filters')}
          >
            <Icon name="filters" />
            {filterCount > 0 && <span className="source-filter-count" aria-hidden="true">{filterCount}</span>}
          </button>
        )}
        {/* Only offered once there is a search to save: the button appears when one has been run, which
            is also the only moment it could mean anything. */}
        {currentKey && (
          <button
            type="button"
            className={`discover-search-button discover-save-search${currentIsSaved ? ' active' : ''}`}
            onClick={toggleSaved}
            disabled={savingSearch}
            aria-pressed={currentIsSaved}
            aria-label={currentIsSaved
              ? t('Forget the saved search “{query}”', { query: submittedQuery })
              : t('Save the search “{query}” on {source}', { query: submittedQuery, source: activeSource?.name ?? '' })}
            title={currentIsSaved ? t('Saved — press to forget') : t('Save this search')}
          ><Icon name={currentIsSaved ? 'pinned' : 'pin'} /></button>
        )}
      </form>

      {filtersOpen && (
        <section className="source-filter-panel" aria-label={t('What {source} can be asked', { source: activeSource?.name ?? '' })}>
          <div className="source-filter-rows">
            {/* Mapped over the list exactly as the source returned it, headers and separators
                included, so the index handed down is the one the server will look the change up by. */}
            {sourceFilters.map((filter, position) => (
              <FilterRow key={filterKey([position])} filter={filter} path={[position]} values={filterDraft} onSet={setFilterAt} />
            ))}
          </div>
          <div className="source-filter-actions">
            <button type="button" className="button quiet" onClick={() => setFilterDraft({})} disabled={Object.keys(filterDraft).length === 0}>{t('Clear filters')}</button>
            <button type="button" className="button primary" onClick={applyFilters}>{t('Apply filters')}</button>
          </div>
        </section>
      )}

      {savedError && <div className="notice error">{savedError}</div>}

      {/* Absent entirely until something has been saved — the same rule the library's grouping toggle
          follows. Collapsed, the shelves are unmounted and nothing is asked of any source: the feed is
          a screenful of requests, and it should only run when it is being looked at. */}
      {saved.length > 0 && (
        <section className="feed" aria-label={t('Saved searches')}>
          <div className="shelf-heading feed-heading">
            <h2>{t('Saved searches')}</h2>
            <span>{saved.length}</span>
            <button
              type="button"
              className="discover-icon-button small shelf-heading-action"
              onClick={() => setFeedOpen(!feedOpen)}
              aria-expanded={feedOpen}
              aria-label={feedOpen ? t('Hide the saved searches') : t('Show what the saved searches find')}
              title={feedOpen ? t('Hide') : t('Show')}
            ><Icon name={feedOpen ? 'close' : 'arrowDown'} /></button>
          </div>
          {feedOpen && saved.map((search) => (
            <SavedSearchShelf
              key={search.key}
              search={search}
              installed={sources.some((source) => source.id === search.sourceId)}
              onOpen={openSaved}
              onRemove={(entry) => writeSaved(withSearchRemoved(saved, entry.key))}
            />
          ))}
        </section>
      )}

      {showingAllSources ? (
        <section className="all-sources" aria-label={t('Results from every source')}>
          <div className="shelf-heading">
            <h2>{t('Results for “{query}”', { query: submittedQuery })}</h2>
            <span>{globalFinding && globalProgress
              ? t('{done} of {total} sources asked', { done: globalProgress.completed, total: globalProgress.total })
              : t('{found} answered · {empty} had nothing · {failed} could not be asked', { found: globalResults.length, empty: globalQuiet.length, failed: globalBroken.length })}</span>
            {globalCachedAt && !globalFinding && (
              <span className="badge cached source-cache-status" title={t('Saved {when}', { when: new Date(globalCachedAt).toLocaleString() })}>✓ {t('Saved search')}</span>
            )}
          </div>

          {/* One shelf per source that had something, in the feed's shape: a dozen wrapping grids
              would push each other off the screen long before the last source answered. */}
          {globalResults.map(({ source, mangas }) => (
            <section className="shelf feed-shelf" key={source.id}>
              <div className="shelf-heading">
                <h2>{source.name}</h2>
                <span>{source.lang} · {mangas.length}</span>
              </div>
              <div className="grid">
                {mangas.map((item) => (
                  <Link key={item.id} to={`/manga/${item.id}?source=${encodeURIComponent(source.id)}`} className="card">
                    <div className="cover-wrap">
                      {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <div className="cover-placeholder" />}
                    </div>
                    <div className="title">{item.title}</div>
                  </Link>
                ))}
              </div>
            </section>
          ))}

          {/* A source that fell over says so on its own line and nowhere else: one dead catalogue
              turning into a page-level error would be worse than not searching them all. */}
          {globalBroken.map(({ source, error }) => (
            <p className="all-sources-line failed" key={source.id}>{t('{source} could not be asked — {error}', { source: source.name, error: error ?? '' })}</p>
          ))}

          {globalQuiet.length > 0 && (
            <p className="all-sources-line">{t('Nothing on {names}.', { names: globalQuiet.map((outcome) => outcome.source.name).join(', ') })}</p>
          )}

          {globalFinding && <div className="state-panel compact"><p>{t('Asking {count} more sources…', { count: (globalProgress?.total ?? 0) - (globalProgress?.completed ?? 0) })}</p></div>}
          {!globalFinding && globalResults.length === 0 && globalOutcomes.length > 0 && (
            <div className="state-panel compact"><p>{t('None of your sources found this title.')}</p></div>
          )}
        </section>
      ) : (
        <>
        {loadError && <div className="notice error">{loadError}</div>}
        {effectiveMode === 'SEARCH' && (submittedQuery || appliedFilters.length > 0) && (
          <div className="shelf-heading">
            <h2>{submittedQuery
              ? t('Results for “{query}”', { query: submittedQuery })
              : t('Everything {source} lists under these filters', { source: activeSource?.name ?? '' })}</h2>
            <span>{visible.length}</span>
          </div>
        )}

        {!loading && checking === 0 && visible.length === 0 && !loadError && (
          <div className="state-panel compact"><p>{
            effectiveMode === 'SEARCH' && !submittedQuery && appliedFilters.length === 0
              ? t('Type a title to search this source.')
              : mangas.length > 0
                ? t('{source} lists these titles but has no chapters of any of them.', { source: activeSource?.name ?? '' })
                : t('Nothing to show here yet.')
          }</p></div>
        )}

        <div className="grid">
          {visible.map((item) => (
            <Link key={item.id} to={resultLink(item.id)} className="card">
              <div className="cover-wrap">
                {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <div className="cover-placeholder" />}
                {item.inLibrary && <span className="progress-chip">{t('In library')}</span>}
              </div>
              <div className="title">{item.title}</div>
            </Link>
          ))}
        </div>

        {loading && <div className="state-panel compact"><p>{t('Loading…')}</p></div>}
        {/* Said plainly, because cards leaving the grid on their own would otherwise look like a bug. */}
        {!loading && checking > 0 && (
          <div className="state-panel compact"><p>{t('Checking {count} titles for chapters…', { count: checking })}</p></div>
        )}
        {!loading && hasNextPage && (
          <div className="load-more">
            <button type="button" className="discover-icon-button load-more-button" onClick={() => load(page + 1, false)} aria-label={t('Load more titles')} title={t('Load more')}><Icon name="arrowDown" /></button>
          </div>
        )}
        </>
      )}

    </div>
  )
}
