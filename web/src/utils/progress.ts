/**
 * When the source published a chapter, in the reader's own locale — "13 Nov 2025, 14:00".
 *
 * Null when the source reports no date: plenty of scrapers leave uploadDate at 0, and "1 Jan 1970"
 * next to every chapter is worse than nothing there at all.
 */
export function formatUploadDate(uploadDate: string): { label: string; iso: string; full: string } | null {
  const milliseconds = Number(uploadDate)
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null
  const date = new Date(milliseconds)
  if (Number.isNaN(date.getTime())) return null
  return {
    label: `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`,
    iso: date.toISOString(),
    full: date.toLocaleString(),
  }
}

// Publishing statuses that mean the run is over, so the highest chapter a source carries really is
// the last one. Anything else (ongoing, hiatus, unknown) can still grow.
const FINISHED_PUBLISHING = ['COMPLETED', 'PUBLISHING_FINISHED', 'CANCELLED']

export const formatChapterNumber = (chapterNumber: number): string =>
  Number.isInteger(chapterNumber) ? String(chapterNumber) : String(Number(chapterNumber.toFixed(3)))

// A library entry keeps the publishing status AniList imported; the source entry a search created
// usually sits at UNKNOWN, so only fall back to the source when the library entry knows nothing.
export function hasFinishedPublishing(status: string, sourceStatus?: string): boolean {
  if (FINISHED_PUBLISHING.includes(status)) return true
  return status === 'UNKNOWN' && sourceStatus !== undefined && FINISHED_PUBLISHING.includes(sourceStatus)
}

// AniList only publishes a chapter total once a series has finished, so everything still running
// used to render a bare "?" as the denominator. Fall back to the highest chapter the bound source
// has seen and flag it as provisional, so the chip reads "12 / 45?" instead of "12 / ?".
// AniList progress can run ahead of what the source has indexed, so clamp to `read` rather than
// render a nonsense "35 / 33?" — callers still report what is actually available in their tooltip.
export function chapterTotalLabel(
  totalChapters: number,
  latestChapter: number,
  read: number,
  finished: boolean,
): { label: string; provisional: boolean } {
  if (totalChapters > 0) return { label: String(totalChapters), provisional: false }
  if (latestChapter <= 0) return { label: '?', provisional: false }
  const latest = formatChapterNumber(Math.max(latestChapter, read))
  return finished ? { label: latest, provisional: false } : { label: `${latest}?`, provisional: true }
}
