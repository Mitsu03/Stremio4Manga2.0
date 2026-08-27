export interface SourceNode {
  id: string
  name: string
  lang: string
  iconUrl?: string | null
  contentWarning?: 'SAFE' | 'MIXED' | 'NSFW'
}

/** A search hit as a source reports it, before anything is bound to it. */
export interface SourceMangaNode { id: number; title: string; thumbnailUrl: string | null }
export interface BulkSourceResult { source: string; error: string | null; mangas: SourceMangaNode[] }
export interface FetchSourceMangaBulkResult { fetchSourceMangaBulk: { results: BulkSourceResult[] } | null }

export const SOURCES_QUERY = `
  query Sources { sources { nodes { id name lang iconUrl contentWarning } } }
`

// One request fans out across several catalogues; the server searches them in parallel so we are
// not throttled by the browser's ~6-connections-per-host limit. It is shared because both the
// detail page's source picker and the library's mass migration ask sources the same question —
// "what do you have under this title?" — and neither owns the answer.
export const FETCH_SOURCE_MANGA_BULK_MUTATION = `
  mutation FetchSourceMangaBulk($sources: [LongString!]!, $page: Int!, $query: String) {
    fetchSourceMangaBulk(input: { sources: $sources, type: SEARCH, page: $page, query: $query }) {
      results {
        source
        error
        mangas { id title thumbnailUrl }
      }
    }
  }
`

export const PSEUDO_SOURCE_IDS = ['0', '1']
export const PREFERRED_SOURCE = 'MangaDex'
export const PREFERRED_LANG = 'en'

// Curated, high-coverage English catalogues, best first. The cross-source match search seeds with
// these so the common case stays fast; the long tail is only searched when the user asks for it.
// A source matches by normalized prefix, so "ComicK" also matches the installed "ComicK Fanmade".
export const RECOMMENDED_SOURCES = [
  'MangaDex',
  'ComicK',
  'Weeb Central',
  'Asura Scans',
  'Flame Comics',
  'Reaper Scans',
  'MangaFire',
  'MangaPark',
  'MangaBuddy',
  'Manganato',
  'Mangakakalot',
  'Manhuagui',
]

// Fallback cap for the up-front search when none of the recommended catalogues are installed.
export const INITIAL_SOURCE_COUNT = 12

const normalizeName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '')
const RECOMMENDED_NORMALIZED = RECOMMENDED_SOURCES.map(normalizeName)

// Position of the recommended catalogue this source's name starts with, or -1 if none.
function recommendedRank(name: string): number {
  const normalized = normalizeName(name)
  return RECOMMENDED_NORMALIZED.findIndex((token) => normalized.startsWith(token))
}

// Orders sources so recommended catalogues come first (in the order listed above), then everything
// else alphabetically — used for the full "search all" sweep.
export function prioritizedSources(sources: SourceNode[]): SourceNode[] {
  const rankOf = (name: string): number => {
    const rank = recommendedRank(name)
    return rank === -1 ? RECOMMENDED_NORMALIZED.length : rank
  }
  return [...sources].sort((a, b) => rankOf(a.name) - rankOf(b.name) || a.name.localeCompare(b.name))
}

// The recommended catalogues that are actually installed, best first — the "top sources" seed.
export function recommendedSources(sources: SourceNode[]): SourceNode[] {
  return prioritizedSources(sources.filter((source) => recommendedRank(source.name) !== -1))
}

export function browsableSources(sources: SourceNode[]): SourceNode[] {
  return sources.filter((source) => !PSEUDO_SOURCE_IDS.includes(source.id))
}

export function sourceNames(sources: SourceNode[]): string[] {
  return [...new Set(sources.map((source) => source.name))].sort((a, b) => {
    if (a === PREFERRED_SOURCE) return -1
    if (b === PREFERRED_SOURCE) return 1
    return a.localeCompare(b)
  })
}

export function langsFor(sources: SourceNode[], name: string): string[] {
  return [...new Set(sources.filter((source) => source.name === name).map((source) => source.lang))].sort((a, b) => {
    if (a === PREFERRED_LANG) return -1
    if (b === PREFERRED_LANG) return 1
    return a.localeCompare(b)
  })
}

export function resolveSource(sources: SourceNode[], name: string, lang: string): SourceNode | undefined {
  return sources.find((source) => source.name === name && source.lang === lang)
}

// Multi-source searches only need one language variant per catalogue. Prefer English so a
// catalogue such as MangaDex is searched once instead of issuing the same query dozens of times.
export function preferredSourcePerName(sources: SourceNode[]): SourceNode[] {
  const grouped = new Map<string, SourceNode[]>()
  sources.forEach((source) => grouped.set(source.name, [...(grouped.get(source.name) ?? []), source]))
  return [...grouped.values()]
    .map((variants) => variants.find((source) => source.lang === PREFERRED_LANG) ?? variants[0])
    .sort((a, b) => a.name.localeCompare(b.name))
}
