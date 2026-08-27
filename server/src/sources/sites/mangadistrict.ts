/**
 * Manga District — a stock Madara install, and the theme engine's test case.
 *
 * Two site-specific facts, both verified against the live site:
 *   * series live under `/series/`, not the theme default `/manga/` (an older
 *     `/read-scan/` path still resolves, which is why the URL stored on a manga
 *     row is whatever the listing linked to rather than a path this file
 *     rebuilds);
 *   * the chapter list is server-rendered, and this install's admin-ajax
 *     rejects `manga_get_chapters` outright — so the page is the only source
 *     for it and asking AJAX first would just waste a request per open.
 *
 * The catalogue is largely adult, hence NSFW rather than MIXED: the client hides
 * NSFW sources unless the reader turns them on, and getting that wrong is the
 * kind of thing that shows up on someone's shared screen.
 */
import type { SourceDefinition } from '../types.js';
import { createMadaraSource } from '../themes/madara.js';

export const definition: SourceDefinition = {
  pkgName: 'mangadistrict',
  name: 'Manga District',
  lang: 'en',
  id: '1000000000000000004',
  contentWarning: 'NSFW',
  versionName: '1.0.0',
  build: (deps) =>
    createMadaraSource(
      {
        id: '1000000000000000004',
        name: 'Manga District',
        lang: 'en',
        baseUrl: 'https://mangadistrict.com',
        contentWarning: 'NSFW',
        mangaPath: 'series',
        chapterSource: 'page',
      },
      deps,
    ),
};
