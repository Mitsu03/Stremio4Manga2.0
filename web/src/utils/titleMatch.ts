interface TitledItem { title: string }

/**
 * The form two titles are compared in: accents folded, punctuation and case discarded. Exported
 * because anything grouping titles into series has to agree with the scoring below on what "the
 * same title" means — a caller that normalised differently could group two rows the scorer would
 * separate, or the other way round.
 */
export function normalizeTitle(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function bigrams(value: string): string[] {
  if (value.length < 2) return value ? [value] : []
  return Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2))
}

function diceCoefficient(left: string, right: string): number {
  const leftPairs = bigrams(left.replaceAll(' ', ''))
  const rightPairs = bigrams(right.replaceAll(' ', ''))
  if (leftPairs.length === 0 || rightPairs.length === 0) return 0
  const remaining = [...rightPairs]
  let overlap = 0
  leftPairs.forEach((pair) => {
    const index = remaining.indexOf(pair)
    if (index < 0) return
    overlap += 1
    remaining.splice(index, 1)
  })
  return (2 * overlap) / (leftPairs.length + rightPairs.length)
}

function editSimilarity(left: string, right: string): number {
  if (!left || !right) return 0
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0]
    previous[0] = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex]
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
      previous[rightIndex] = Math.min(previous[rightIndex] + 1, previous[rightIndex - 1] + 1, diagonal + cost)
      diagonal = above
    }
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length)
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.split(' ').filter(Boolean))
  const rightTokens = new Set(right.split(' ').filter(Boolean))
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length
  return (2 * overlap) / (leftTokens.size + rightTokens.size)
}

export function titleSimilarity(query: string, candidate: string): number {
  const normalizedQuery = normalizeTitle(query)
  const normalizedCandidate = normalizeTitle(candidate)
  if (!normalizedQuery || !normalizedCandidate) return 0
  if (normalizedQuery === normalizedCandidate) return 1
  if (normalizedQuery.length <= 2) return 0

  const lengthRatio = Math.min(normalizedQuery.length, normalizedCandidate.length) / Math.max(normalizedQuery.length, normalizedCandidate.length)
  const dice = diceCoefficient(normalizedQuery, normalizedCandidate)
  const edit = editSimilarity(normalizedQuery, normalizedCandidate)
  const tokens = tokenSimilarity(normalizedQuery, normalizedCandidate)
  const containment = normalizedCandidate.includes(normalizedQuery) || normalizedQuery.includes(normalizedCandidate)
    ? 0.68 + 0.3 * lengthRatio
    : 0

  return Math.max(containment, edit * 0.55 + dice * 0.45, tokens * 0.78 + dice * 0.22)
}

export function sortByTitleSimilarity<T extends TitledItem>(query: string, items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index, score: titleSimilarity(query, item.title) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ item }) => item)
}

export function relevantTitleMatches<T extends TitledItem>(query: string, items: T[], limit = 5): T[] {
  const ranked = items
    .map((item, index) => ({ item, index, score: titleSimilarity(query, item.title) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
  const bestScore = ranked[0]?.score ?? 0
  return ranked
    .filter(({ score }) => score >= 0.56 && score >= bestScore - 0.16)
    .slice(0, limit)
    .map(({ item }) => item)
}
