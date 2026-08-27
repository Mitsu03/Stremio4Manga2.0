/**
 * The small, boring things every source needs and none of them should re-invent.
 *
 * Chapter numbering and upload dates are the two places where sources disagree
 * most and where the client is least forgiving: the reader orders on
 * `chapterNumber`, and "unknown" has to be -1 rather than 0, because 0 is a real
 * chapter number on a good third of the catalogue (prologues, chapter 0).
 */
import type { MangaStatus, SourceChapter } from './types.js';

/** Resolves a possibly-relative href the way a browser on `base` would. */
export function absoluteUrl(base: string, href: string | undefined): string {
  if (!href) return '';
  try {
    return new URL(href.trim(), base).toString();
  } catch {
    return '';
  }
}

/** Collapses the whitespace an HTML block always has around its text. */
export function clean(text: string | undefined | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Pulls the chapter number out of a human title.
 *
 * Tries the labelled forms first ("Chapter 12.5", "Ch. 12") because a bare
 * leading number is far more often a volume or a year than the chapter, and only
 * then falls back to the first decimal in the string. Returns -1 rather than
 * guessing, which is what the schema means by "no number".
 */
export function parseChapterNumber(name: string): number {
  const labelled = /(?:chapter|chap|ch|episode|ep|cap[íi]tulo)\s*\.?\s*(\d+(?:[.,]\d+)?)/i.exec(
    name,
  );
  const candidate = labelled ?? /(\d+(?:[.,]\d+)?)/.exec(name);
  if (!candidate) return -1;
  const value = Number.parseFloat(candidate[1].replace(',', '.'));
  return Number.isFinite(value) ? value : -1;
}

const RELATIVE_UNITS: Record<string, number> = {
  second: 1000,
  sec: 1000,
  minute: 60_000,
  min: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
};

/**
 * Dates on scanlation sites are either an absolute string or "3 days ago", and
 * both forms turn up on the same page (recent chapters relative, old ones not).
 * Anything unrecognised becomes 0, which the schema defines as "no date" — a
 * wrong date is worse than none, since the library sorts updates on it.
 */
export function parseDate(text: string | undefined | null): number {
  const value = clean(text);
  if (value === '') return 0;

  const relative = /(\d+)\s*(second|sec|minute|min|hour|day|week|month|year)s?\s*ago/i.exec(value);
  if (relative) {
    const unit = RELATIVE_UNITS[relative[2].toLowerCase()];
    if (unit) return Date.now() - Number(relative[1]) * unit;
  }
  if (/^(just now|today)$/i.test(value)) return Date.now();
  if (/^yesterday$/i.test(value)) return Date.now() - RELATIVE_UNITS.day;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

const STATUS_WORDS: [RegExp, MangaStatus][] = [
  [/hiatus|on hold|paused/i, 'ON_HIATUS'],
  [/cancel|dropped|abandon/i, 'CANCELLED'],
  [/complet|finish|end|tamat/i, 'COMPLETED'],
  [/licens/i, 'LICENSED'],
  [/ongoing|releasing|publishing|serial|berjalan/i, 'ONGOING'],
];

export function parseStatus(text: string | undefined | null): MangaStatus {
  const value = clean(text);
  for (const [pattern, status] of STATUS_WORDS) {
    if (pattern.test(value)) return status;
  }
  return 'UNKNOWN';
}

/**
 * Sources are allowed to hand back the same chapter twice — a "latest" block
 * repeated inside the full list, a mirror of the same upload — and the chapter
 * table keys on (manga, url), so a duplicate would fail the insert rather than
 * being ignored. First occurrence wins, since sources list newest first.
 */
export function dedupeChapters(chapters: SourceChapter[]): SourceChapter[] {
  const seen = new Set<string>();
  const out: SourceChapter[] = [];
  for (const chapter of chapters) {
    if (chapter.url === '' || seen.has(chapter.url)) continue;
    seen.add(chapter.url);
    out.push(chapter);
  }
  return out;
}

/** Builds a form body without pulling in a URLSearchParams dance every time. */
export function form(fields: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}
