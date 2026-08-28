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

/**
 * Month name → 1-based number for a locale, both the full and the short form.
 *
 * Built from `Intl` rather than a table, because the table would be sixty
 * languages long and wrong the first time a site changed locale. Lowercased and
 * stripped of the trailing dot that short forms carry in several languages.
 */
const monthNames = new Map<string, Map<string, number>>();
function monthsFor(locale: string): Map<string, number> {
  const cached = monthNames.get(locale);
  if (cached) return cached;

  const table = new Map<string, number>();
  for (const width of ['long', 'short'] as const) {
    let format: Intl.DateTimeFormat;
    try {
      format = new Intl.DateTimeFormat(locale, {
        month: width,
        timeZone: 'UTC',
      });
    } catch {
      // An unknown tag is a bad row upstream, not a reason to fail the source.
      continue;
    }
    for (let month = 0; month < 12; month += 1) {
      const name = format
        .format(Date.UTC(2020, month, 15))
        .toLowerCase()
        .replace(/\.$/, '')
        .trim();
      // Several locales render months as digits, which would match anything.
      if (name !== '' && !/^\d+$/.test(name)) table.set(name, month + 1);
    }
  }
  monthNames.set(locale, table);
  return table;
}

/**
 * A chapter date read the way the site writes it.
 *
 * `Date.parse` understands English and ISO and nothing else, so a Turkish or
 * Thai month name silently became 0 — "no date" — on every chapter of the 147
 * sources that declare a non-English locale. Two things are needed and both
 * come from the extension: the locale, to know the month names, and the
 * pattern, to settle `03/04/2024`, which is two different days depending on
 * whether the site writes `dd/MM` or `MM/dd` and cannot be told from the value.
 *
 * Falls back to `parseDate` whenever the pattern does not fit, so a wrong
 * format degrades to the previous behaviour rather than to a wrong date.
 */
export function parseDateWith(
  text: string | undefined | null,
  pattern: string | undefined,
  locale: string | undefined,
): number {
  const value = clean(text);
  if (value === '') return 0;
  if (pattern === undefined || pattern === '') return parseDate(value);

  // Relative dates ignore the pattern: a site writes those in words whatever
  // its absolute format is.
  if (/\d+\s*\w+\s*ago/i.test(value) || /^(just now|today|yesterday)$/i.test(value)) {
    return parseDate(value);
  }

  const lower = value.toLowerCase();

  // A month written as a word. Longest name first, so "march" cannot win over a
  // locale whose shorter month name is a prefix of it.
  const named = [...monthsFor(locale ?? 'en')].sort((a, b) => b[0].length - a[0].length);
  for (const [name, month] of named) {
    if (name.length < 3 || !lower.includes(name)) continue;
    const numbers = [...lower.replace(name, ' ').matchAll(/\d+/g)].map((m) => Number(m[0]));
    const year = numbers.find((n) => n > 31);
    const day = numbers.find((n) => n <= 31);
    if (year === undefined || day === undefined) continue;
    return Date.UTC(year, month - 1, day);
  }

  // All-numeric: the pattern says which field is which.
  const numbers = [...value.matchAll(/\d+/g)].map((m) => Number(m[0]));
  const order = [...pattern.matchAll(/([dMy])\1*/g)].map((m) => m[1]);
  if (numbers.length >= 3 && order.length >= 3) {
    const at = (field: string): number | undefined => {
      const index = order.indexOf(field);
      return index === -1 ? undefined : numbers[index];
    };
    const day = at('d');
    const month = at('M');
    const year = at('y');
    if (
      day !== undefined &&
      month !== undefined &&
      year !== undefined &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31
    ) {
      return Date.UTC(year < 100 ? 2000 + year : year, month - 1, day);
    }
  }

  return parseDate(value);
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
