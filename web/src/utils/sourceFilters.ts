/**
 * The questions a source knows how to answer, and how to send back the answers.
 *
 * `Filter` is a GraphQL union of eight shapes, so every field has to be asked for inside its own
 * inline fragment. The three `default` fields are aliased apart because a union selection still has
 * to satisfy the response-shape rule: `default` is an Int on a select, a String on a text field and
 * a Boolean on a checkbox, and three fields of different types cannot share one response key.
 *
 * Going the other way, `FilterChange` is deliberately *not* polymorphic — the sealed version is
 * commented out on the server. One flat input carries whichever state field belongs to the filter
 * at `position`, and the server picks the field it needs from the filter it finds there.
 */
export type SourceFilterKind =
  | 'HeaderFilter'
  | 'SeparatorFilter'
  | 'SelectFilter'
  | 'TextFilter'
  | 'CheckBoxFilter'
  | 'TriStateFilter'
  | 'SortFilter'
  | 'GroupFilter'

export type TriState = 'IGNORE' | 'INCLUDE' | 'EXCLUDE'
export interface SortSelection { index: number; ascending: boolean }

export interface SourceFilter {
  __typename: SourceFilterKind
  name: string
  /** Select and sort: the options, in the order their index means. */
  values?: string[]
  selectDefault?: number
  textDefault?: string
  checkBoxDefault?: boolean
  triStateDefault?: TriState
  /** Null when the source ships no sort preference of its own. */
  sortDefault?: SortSelection | null
  /** Group children, which carry positions of their own inside the group. */
  filters?: SourceFilter[]
}

export interface SourceFiltersResult { source: { id: string; filters: SourceFilter[] } | null }

const FILTER_FIELDS = `
  fragment FilterFields on Filter {
    __typename
    ... on HeaderFilter { name }
    ... on SeparatorFilter { name }
    ... on SelectFilter { name values selectDefault: default }
    ... on TextFilter { name textDefault: default }
    ... on CheckBoxFilter { name checkBoxDefault: default }
    ... on TriStateFilter { name triStateDefault: default }
    ... on SortFilter { name values sortDefault: default { index ascending } }
    ... on GroupFilter { name }
  }
`

// Groups nest `Filter` inside themselves, and a GraphQL query cannot recurse forever. One level is
// all the depth there is to have: the server's group branch only knows how to apply a checkbox, a
// tri-state, a text field or a select inside a group, so a group inside a group could never be sent.
export const SOURCE_FILTERS_QUERY = `
  query SourceFilters($source: LongString!) {
    source(id: $source) {
      id
      filters {
        ...FilterFields
        ... on GroupFilter { filters { ...FilterFields } }
      }
    }
  }
  ${FILTER_FIELDS}
`

export type FilterValue =
  | { kind: 'select'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'checkBox'; value: boolean }
  | { kind: 'triState'; value: TriState }
  | { kind: 'sort'; value: SortSelection }

/**
 * The filters the reader has actually moved, keyed by their path through the source's list.
 *
 * The key is the **index in the list the source returned** — headers and separators counted — dotted
 * with the child's index when the filter sits inside a group. `updateFilterList` looks a change up by
 * `filterList[change.position]`, so a panel that renumbered around the headers it chose not to draw
 * would silently apply a different filter than the one that was pressed.
 */
export type FilterValues = Record<string, FilterValue>

export const filterKey = (path: number[]): string => path.join('.')

export interface FilterChange {
  position: number
  selectState?: number
  textState?: string
  checkBoxState?: boolean
  triState?: TriState
  sortState?: SortSelection
  groupChange?: FilterChange
}

function stateOf(value: FilterValue): Omit<FilterChange, 'position'> {
  switch (value.kind) {
    case 'select': return { selectState: value.value }
    case 'text': return { textState: value.value }
    case 'checkBox': return { checkBoxState: value.value }
    case 'triState': return { triState: value.value }
    case 'sort': return { sortState: value.value }
  }
}

/**
 * What the mutation sends. Only touched filters appear: an untouched one is absent rather than sent
 * at its default, so a search with nothing in the panel is the search that was always sent — and so
 * a sort filter the source ships with no selection is never handed a state it never had.
 */
export function filterChanges(values: FilterValues): FilterChange[] {
  return Object.entries(values)
    .map(([key, value]) => {
      const path = key.split('.').map(Number)
      let change: FilterChange = { position: path[path.length - 1], ...stateOf(value) }
      for (let depth = path.length - 2; depth >= 0; depth -= 1) {
        change = { position: path[depth], groupChange: change }
      }
      return change
    })
    .sort((a, b) => a.position - b.position)
}

/** What the source says this filter is set to before anybody touches it, if it is settable at all. */
export function defaultFilterValue(filter: SourceFilter): FilterValue | null {
  switch (filter.__typename) {
    case 'SelectFilter': return { kind: 'select', value: filter.selectDefault ?? 0 }
    case 'TextFilter': return { kind: 'text', value: filter.textDefault ?? '' }
    case 'CheckBoxFilter': return { kind: 'checkBox', value: filter.checkBoxDefault ?? false }
    case 'TriStateFilter': return { kind: 'triState', value: filter.triStateDefault ?? 'IGNORE' }
    // A source with no sort preference of its own has no default to fall back to, so any choice
    // counts as a change.
    case 'SortFilter': return filter.sortDefault ? { kind: 'sort', value: filter.sortDefault } : null
    default: return null
  }
}

export function sameFilterValue(a: FilterValue, b: FilterValue): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'sort' && b.kind === 'sort') return a.value.index === b.value.index && a.value.ascending === b.value.ascending
  return a.value === b.value
}

/** Sets one filter, or takes it back out of the list when it has been put back where it started. */
export function withFilterValue(values: FilterValues, path: number[], filter: SourceFilter, value: FilterValue): FilterValues {
  const key = filterKey(path)
  const fallback = defaultFilterValue(filter)
  const next = { ...values }
  if (fallback && sameFilterValue(fallback, value)) delete next[key]
  else next[key] = value
  return next
}

export function currentFilterValue(values: FilterValues, path: number[], filter: SourceFilter): FilterValue | null {
  return values[filterKey(path)] ?? defaultFilterValue(filter)
}

/** Whether this source has anything worth opening a panel for. */
export function hasSettableFilters(filters: SourceFilter[] | undefined): boolean {
  return (filters ?? []).some((filter) => filter.__typename !== 'HeaderFilter' && filter.__typename !== 'SeparatorFilter')
}
