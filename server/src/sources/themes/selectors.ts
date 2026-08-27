import type { Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';

/**
 * Per-site selector overrides for the themed engines.
 *
 * A theme is one site engine wearing many skins, and the skin is usually the
 * part that differs: an install renames a CSS class, moves the status row, or
 * swaps the card markup, and the theme's default selector then matches nothing.
 * Upstream handles this by letting each extension override a named selector, so
 * `tools/sync-keiyoushi.mjs` reads those overrides and they arrive here.
 *
 * Every field is optional and every use site falls back to the theme default,
 * so a site that overrides nothing costs nothing. The names are this server's,
 * not upstream's: the two themes call the same idea different things
 * (`mangaDetailsSelectorStatus` against `seriesStatusSelector`) and the
 * generator already maps both onto these.
 */
export interface ThemeSelectors {
  /** The card in a listing or a search result. */
  searchItem?: string;
  /** The link carrying the title, inside a card. */
  searchTitle?: string;
  /**
   * Where the title *text* is, when it is not the text of the link.
   *
   * Several skins wrap the whole card in one anchor and put the title in a
   * child, so the href and the words come from different elements.
   */
  searchTitleText?: string;
  /** The container the details fields are read from. */
  details?: string;
  title?: string;
  author?: string;
  artist?: string;
  status?: string;
  description?: string;
  thumbnail?: string;
  genre?: string;
  /** A chapter row in the chapter list. */
  chapterList?: string;
  /** The release date inside a chapter row. */
  chapterDate?: string;
  /** The page images in a chapter. */
  pageList?: string;
}

/**
 * `override ?? fallback`, but treating an empty string as absent.
 *
 * A selector that came across empty is a parse that went wrong upstream, and
 * handing `''` to Cheerio throws rather than matching nothing — which would
 * turn one bad row into a source that cannot be built at all.
 */
export function selector(override: string | undefined, fallback: string): string {
  const trimmed = override?.trim();
  return trimmed === undefined || trimmed === '' ? fallback : trimmed;
}

/**
 * A selector that should *widen* the default rather than replace it.
 *
 * Upstream's overrides are written against one install, but the default was
 * written against many, and for a listing card the two are usually both true:
 * the site added a class, it did not stop using the theme's markup. Matching
 * either is what keeps a site working when it changes its skin back.
 */
export function widen(override: string | undefined, fallback: string): string {
  const trimmed = override?.trim();
  return trimmed === undefined || trimmed === '' ? fallback : `${trimmed}, ${fallback}`;
}

/**
 * The first alternative of a comma-separated selector that matches — in the
 * order written, not in document order.
 *
 * A selector list is a set, so `find('h3 a, .post-title a, a').first()` returns
 * whichever match comes *first in the document*, and the bare `a` fallback
 * therefore wins on every card whose thumbnail link precedes its title. Those
 * cards yield an href with no title text and are dropped, so an install laid
 * out that way returns an empty listing while looking perfectly well-formed —
 * one site went from thirty cards to zero items this way.
 *
 * Written as a fallback chain, which is what the list was always meant to be:
 * try the specific thing, and only then the general one.
 */
export function firstIn(
  card: Cheerio<AnyNode>,
  list: string,
): ReturnType<Cheerio<AnyNode>['find']> | undefined {
  for (const one of list.split(',')) {
    const trimmed = one.trim();
    if (trimmed === '') continue;
    const found = card.find(trimmed).first();
    if (found.length > 0) return found;
  }
  return undefined;
}
