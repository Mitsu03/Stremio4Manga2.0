/**
 * RizzFables — the MangaThemesia engine's test case.
 *
 * This install has been patched away from the theme's stock reader: there is no
 * `ts_reader.run(...)` on a chapter page, the images are server-rendered into
 * `#readerarea` instead. That is exactly the fallback path in the theme file,
 * and it is the reason the fallback exists at all — the "MangaThemesia always
 * uses ts_reader" assumption is a few years out of date.
 *
 * Series URLs carry an opaque numeric prefix (`/series/r2311170-a-bad-person`),
 * so nothing here may rebuild a URL from a title; the listing's href is stored
 * as-is and reused.
 *
 * Search is `client` for the same reason: `/series?s=`, `/series?title=` and
 * `/?s=` were all tried against the live site and every one of them answers with
 * the complete catalogue. The site's own search box is a JavaScript filter over
 * the page it is already on, and the catalogue is under a hundred titles on a
 * single page, so filtering here matches what a reader sees on the site.
 */
import type { SourceDefinition } from '../types.js';
import { createMangaThemesiaSource } from '../themes/mangathemesia.js';

export const definition: SourceDefinition = {
  pkgName: 'rizzfables',
  name: 'RizzFables',
  lang: 'en',
  id: '1000000000000000006',
  contentWarning: 'SAFE',
  versionName: '1.0.0',
  build: (deps) =>
    createMangaThemesiaSource(
      {
        id: '1000000000000000006',
        name: 'RizzFables',
        lang: 'en',
        baseUrl: 'https://rizzfables.com',
        contentWarning: 'SAFE',
        mangaPath: 'series',
        searchMode: 'client',
      },
      deps,
    ),
};
