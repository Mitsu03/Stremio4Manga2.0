/**
 * Where a downloaded chapter lives, and how a title becomes a folder name.
 *
 * The layout is deliberately readable from a file manager:
 *
 *   <dataDir>/downloads/<userId>/<sourceName>/<mangaTitle>/<scanlator_chapterName>/001.jpg
 *
 * — because the thing people do with downloads is copy them onto a tablet, and a
 * tree of opaque ids cannot be copied selectively. Nothing in the database
 * stores these paths: they are derived from the rows every time, so renaming a
 * manga row and re-deriving is the only way a stale path can appear, and the
 * delete helper below re-derives from the same function the writer used.
 *
 * Sanitising is written for the stricter of the two platforms, always. A share
 * mounted from Windows onto a Linux server, or a library rsynced the other way,
 * fails on whichever end is strict — so `?`, `:`, `*`, `"`, `<`, `>`, `|`,
 * control characters, trailing dots and trailing spaces all go regardless of
 * where the server happens to run.
 */
import { join } from 'node:path';
import { rm, readdir, rmdir } from 'node:fs/promises';

import type { Config } from '../config.js';
import { dataPaths } from '../config.js';
import { definitionById } from '../sources/registry.js';

/** Windows refuses these outright; Linux does not care, so the strict rule wins. */
const ILLEGAL = /[<>:"/\\|?*]/g;
/** Reserved device names, with or without an extension, case-insensitively. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/**
 * Per component, not per path. Long enough for any real chapter title, short
 * enough that source + title + chapter still clears Windows' 260-character path
 * limit under a deep data directory.
 */
const MAX_COMPONENT = 80;

/** Anything below a space, plus DEL: illegal on Windows, unprintable anywhere. */
function printable(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f;
}

/**
 * One path component, safe everywhere. `fallback` covers the cases that
 * sanitise to nothing at all — a title that is entirely punctuation, an empty
 * scanlator — because a folder called "" is not a folder.
 */
export function safeComponent(raw: string, fallback: string): string {
  let name = [...raw.normalize('NFC')]
    .filter(printable)
    .join('')
    .replace(ILLEGAL, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length > MAX_COMPONENT) name = name.slice(0, MAX_COMPONENT);
  // Windows silently drops trailing dots and spaces, which would make the path
  // written differ from the path deleted later.
  name = name.replace(/[. ]+$/, '');
  if (name === '') return fallback;
  // A leading underscore is enough: "CON" is reserved, "_CON" is not.
  return RESERVED.test(name) ? `_${name}` : name;
}

/** What the rows say about one chapter, in the shape the layout needs. */
export interface ChapterPathParts {
  userId: string;
  sourceId: string;
  mangaTitle: string;
  chapterId: number;
  chapterName: string;
  scanlator: string | null;
}

export interface ChapterLocation {
  /** `<...>/<mangaTitle>` — pruned when its last chapter is deleted. */
  mangaDir: string;
  /** The finished folder form. */
  dir: string;
  /** The finished single-file form. */
  cbz: string;
  /**
   * Where pages are written before either of the above exists. Kept between
   * attempts on purpose: a paused or failed chapter resumes from the pages it
   * already has instead of asking the site for them a second time.
   */
  partial: string;
}

/**
 * The source's display name, not its numeric id: the id is a number nobody can
 * read, and the name is what the UI calls the source everywhere else. A source
 * that has since been removed from the catalogue still has to resolve to
 * *something* stable, or its downloads would become undeletable.
 */
function sourceFolder(sourceId: string): string {
  return safeComponent(definitionById(sourceId)?.name ?? `source-${sourceId}`, 'source');
}

export function chapterLocation(config: Config, parts: ChapterPathParts): ChapterLocation {
  const root = dataPaths(config).downloads;
  const mangaDir = join(
    root,
    safeComponent(parts.userId, 'user'),
    sourceFolder(parts.sourceId),
    safeComponent(parts.mangaTitle, `manga-${parts.chapterId}`),
  );
  // Scanlator first, because two groups releasing the same chapter number are
  // the collision this name exists to avoid.
  const label = parts.scanlator
    ? `${parts.scanlator}_${parts.chapterName}`
    : parts.chapterName;
  const dir = join(mangaDir, safeComponent(label, `chapter-${parts.chapterId}`));
  return { mangaDir, dir, cbz: `${dir}.cbz`, partial: `${dir}.part` };
}

/** `001.jpg`. Zero-padded so a plain alphabetical sort is page order. */
export function pageFileName(index: number, extension: string): string {
  return `${String(index + 1).padStart(3, '0')}.${extension}`;
}

/**
 * Removes both finished forms of a chapter, plus anything a stopped download
 * left behind, and then the manga folder if that was the last chapter in it.
 *
 * Missing paths are not an error: the point of the call is that they are gone
 * afterwards, and a download deleted by hand should not fail the mutation.
 */
export async function removeChapterFiles(location: ChapterLocation): Promise<void> {
  await rm(location.dir, { recursive: true, force: true });
  await rm(location.partial, { recursive: true, force: true });
  await rm(location.cbz, { force: true });
  try {
    // rmdir without `recursive` fails on a non-empty directory, which is
    // exactly the test wanted here: prune only when nothing is left.
    if ((await readdir(location.mangaDir)).length === 0) await rmdir(location.mangaDir);
  } catch {
    // Already gone, or still holding other chapters. Neither is a problem.
  }
}
