/**
 * "MangaCatalog", the theme behind the single-franchise reader sites.
 *
 * Every other engine here points at a site with a catalogue. This one points at
 * a site that *is* one series — readberserk.com, readonepiece.com — so there is
 * no listing to page through and no search to run: the catalogue is a handful of
 * titles the extension names, and both browsing and searching are done over that
 * list without a request.
 *
 * The list is data and arrives per site in `config.series`. Upstream defaults it
 * to a single entry, the site's own name pointed at its root, which is right for
 * the sites that really do carry one series and wrong for the ones that carry a
 * main title plus its side stories — so the generator reads the extension's own
 * `sourceList`, and those arrive as several titles from one host.
 *
 * `supportsLatest` is false because the theme has no updates feed at all. Saying
 * so is better than answering an empty page: the client hides the tab instead of
 * drawing one that never fills.
 */
import { load } from 'cheerio';
import type {
  FilterSpec,
  MangaPage,
  Source,
  SourceChapter,
  SourceDeps,
  SourceManga,
  SourcePage,
} from '../types.js';
import { NoResultsError } from '../types.js';
import { absoluteUrl, clean, dedupeChapters, parseChapterNumber, parseDate } from '../util.js';
import { firstIn, selector, widen, type ThemeSelectors } from './selectors.js';

export interface MangaCatalogConfig {
  id: string;
  name: string;
  lang: string;
  baseUrl: string;
  contentWarning: 'SAFE' | 'MIXED' | 'NSFW';
  /**
   * The titles this host carries, read off the extension's own `sourceList`.
   *
   * A relative `url` is resolved against `baseUrl`, because upstream writes them
   * as `"$baseUrl/manga/berserk/"` and the generator keeps the path rather than
   * baking in a domain the site will eventually move off.
   */
  series?: { name: string; url: string }[];
  /** Per-site markup differences, read off the extension's own Kotlin. */
  selectors?: ThemeSelectors;
}

export function createMangaCatalogSource(config: MangaCatalogConfig, deps: SourceDeps): Source {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const http = deps.http;

  // Upstream's own default, and the right answer for the sites that carry one
  // title: the source's name pointed at the site root.
  const declared = (config.series ?? [{ name: config.name, url: baseUrl }])
    .map((entry) => ({ name: clean(entry.name), url: absoluteUrl(baseUrl, entry.url) }))
    .filter((entry) => entry.name !== '' && entry.url !== '');
  // Upstream's own `distinctBy { it.second }`, and it is load-bearing: two of
  // these lists name the same series twice under different labels, and the URL
  // is the manga row's key — a repeat is a duplicate insert, not a duplicate
  // card. First label wins, since these lists read main title first.
  const seen = new Set<string>();
  const series = declared.filter((entry) => !seen.has(entry.url) && seen.add(entry.url));

  const sel = config.selectors ?? {};
  const TITLE = selector(sel.title, 'div.container > h1');
  const DETAILS = selector(sel.details, 'div.bg-bg-secondary > div.px-6 > div.flex-col');
  const THUMB = selector(sel.thumbnail, 'div.flex > img');
  const CHAPTER_ROW = selector(sel.chapterList, 'div.w-full > div.bg-bg-secondary > div.grid');
  // Ordered as a fallback chain — see `firstIn`. The theme's own markup first,
  // then any link in the row, which is what the installs that rewrote their
  // chapter table use (`a.btn-primary` on one of them). Those rewrites are
  // functions upstream and cannot come across as data, so widening here is what
  // keeps the source working instead of listing chapters that open nothing.
  const CHAPTER_LINK = '.col-span-4 > a, a.btn-primary, a[href]';
  // `img[data-src]` is upstream's default and is now the *older* of the two:
  // these sites server-render the reader and lazy-load nothing, so the page
  // images arrive with a plain `src` under `.js-page`. Matching only the old
  // form is an empty chapter on every site that has been updated.
  const PAGE_IMG = widen(
    sel.pageList,
    'div.js-pages-container img.js-page, div.pages img.pages__img, img[data-src]',
  );

  const listing: MangaPage<SourceManga> = {
    items: series.map((entry) => ({ url: entry.url, title: entry.name })),
    hasNextPage: false,
  };

  return {
    id: config.id,
    name: config.name,
    lang: config.lang,
    baseUrl,
    // No updates feed exists on this theme; see the note at the top.
    supportsLatest: false,
    contentWarning: config.contentWarning,

    // The whole catalogue fits on one page, so page 2 is empty rather than a
    // repeat of page 1 — a repeat is what makes a client page forever.
    getPopular: async (page) => (page > 1 ? { items: [], hasNextPage: false } : listing),
    getLatest: async () => ({ items: [], hasNextPage: false }),
    async search(query, page) {
      if (page > 1) return { items: [], hasNextPage: false };
      if (query === '') return listing;
      const needle = query.toLowerCase();
      return {
        items: listing.items.filter((item) => item.title.toLowerCase().includes(needle)),
        hasNextPage: false,
      };
    },

    getFilters: (): FilterSpec[] => [],

    async getMangaDetails(manga) {
      const $ = load(await http.text(manga.url));
      // One block holds every field, labelled in its own text; the synopsis is
      // whatever follows the "Description" label, and the whole block when the
      // site does not label it.
      const info = clean($(DETAILS).text());
      const marker = info.indexOf('Description');
      const description = marker === -1 ? info : clean(info.slice(marker + 'Description'.length));
      const cover = $(THUMB).first();

      return {
        url: manga.url,
        title: clean($(TITLE).first().text()) || clean(manga.url),
        thumbnailUrl: absoluteUrl(baseUrl, cover.attr('data-src') ?? cover.attr('src')) || null,
        description: description || null,
        genre: [],
        status: 'UNKNOWN',
        realUrl: manga.url,
        initialized: true,
      };
    },

    async getChapterList(manga) {
      const $ = load(await http.text(manga.url));
      const chapters: SourceChapter[] = [];
      $(CHAPTER_ROW).each((_, element) => {
        const row = $(element);
        const link = firstIn(row, CHAPTER_LINK);
        if (link === undefined) return;
        const url = absoluteUrl(baseUrl, link.attr('href'));
        // The row carries the chapter title and a subtitle in separate cells;
        // upstream joins them, and the subtitle is often the only thing telling
        // two chapters of the same number apart. A rewritten table puts the
        // title in the first cell and leaves the link's own text a button label,
        // hence falling back to the cell.
        const head = clean(link.text()) || clean(row.children().first().text());
        const tail = clean(row.find('.text-xs:not(a)').text());
        const name = tail === '' ? head : `${head} - ${tail}`;
        if (url === '' || name === '') return;
        chapters.push({
          url,
          name,
          chapterNumber: parseChapterNumber(name),
          // The theme prints no date of its own; a site that adds one puts it in
          // the same cell as the subtitle, which is why this reads `tail`.
          dateUpload: parseDate(tail),
          realUrl: url,
        });
      });
      const deduped = dedupeChapters(chapters);
      if (deduped.length === 0) throw new NoResultsError();
      return deduped;
    },

    async getPageList(chapter) {
      const $ = load(await http.text(chapter.url));
      const pages: SourcePage[] = [];
      $(PAGE_IMG).each((_, element) => {
        const img = $(element);
        const raw = img.attr('data-src') ?? img.attr('src');
        if (!raw || raw.startsWith('data:')) return;
        const url = absoluteUrl(baseUrl, raw);
        if (url !== '') pages.push({ index: pages.length, url });
      });
      if (pages.length === 0) throw new NoResultsError('No pages found');
      return pages;
    },

    imageHeaders: () => ({ Referer: `${baseUrl}/` }),
  };
}
