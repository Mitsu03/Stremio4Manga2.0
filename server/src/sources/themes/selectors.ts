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
