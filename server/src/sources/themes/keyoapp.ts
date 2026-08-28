/**
 * "Keyoapp", the Tailwind-era scanlation theme.
 *
 * Where Madara and MangaThemesia are WordPress with semantic class names,
 * Keyoapp is a utility-class front end: there is no `.post-title`, only
 * `div.grid > h1`, and the fields on a series page are told apart by the label
 * sitting beside them rather than by anything in the markup. Three consequences
 * shape this file:
 *
 * - **Covers are CSS, not `<img>`.** The thumbnail is a `background-image` in a
 *   `style` attribute, so it is pulled out with a regex rather than read off an
 *   attribute. The theme serves whatever size is asked for, hence the `w=480`.
 * - **Labelled fields need a scan, not a selector.** Upstream writes
 *   `div:has(span:containsOwn(Author)) ~ div`, and `:containsOwn` is a Jsoup
 *   extension Cheerio does not implement. The label scan below is the same idea
 *   in code; a site that overrides the selector with a plain one — several use
 *   `div[alt=Author]` — skips the scan entirely.
 * - **Pages are ids, not URLs.** The reader prints `<img uid="…">` and builds
 *   the real URL in JavaScript from a CDN host that appears once, in a script.
 *   Both halves are needed; the older installs that still print full URLs are
 *   the fallback rather than the main path.
 */
import { load, type CheerioAPI } from 'cheerio';
import type {
  FilterSpec,
  MangaStatus,
  Source,
  SourceChapter,
  SourceDeps,
  SourceManga,
  SourcePage,
} from '../types.js';
import { NoResultsError } from '../types.js';
import { absoluteUrl, clean, dedupeChapters, parseChapterNumber, parseDate } from '../util.js';
import { firstIn, selector, widen, type ThemeSelectors } from './selectors.js';

export interface KeyoappConfig {
  id: string;
  name: string;
  lang: string;
  baseUrl: string;
  contentWarning: 'SAFE' | 'MIXED' | 'NSFW';
  /** Per-site markup differences, read off the extension's own Kotlin. */
  selectors?: ThemeSelectors;
  /**
   * The home page's featured row. Installs disagree about this more than about
   * anything else — a carousel on one, a grid on another — and it is the only
   * listing the theme has besides `/latest/`.
   */
  popularSelector?: string;
  /** The "Type" row on a series page, when it is not the labelled default. */
  typeSelector?: string;
  /** Alternative titles, appended to the synopsis. */
  altNameSelector?: string;
  usesCloudflare?: boolean;
}

/** `background-image: url('https://…')` → the URL, at a width we ask for. */
function backgroundImage(style: string | undefined, base: string): string | null {
  const found = /url\(['"]?([^'")]+)/.exec(style ?? '');
  if (!found) return null;
  const url = absoluteUrl(base, found[1]);
  if (url === '') return null;
  try {
    // Keyoapp resizes on demand and defaults to the full-size original, which is
    // several hundred kilobytes for a thumbnail in a grid.
    const parsed = new URL(url);
    parsed.searchParams.set('w', '480');
    return parsed.toString();
  } catch {
    return url;
  }
}

export function createKeyoappSource(config: KeyoappConfig, deps: SourceDeps): Source {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const http = deps.http;
  const sel = config.selectors ?? {};

  // The featured row is labelled by a heading beside it, and the three words
  // below are the ones installs actually use.
  const POPULAR = selector(
    config.popularSelector ?? sel.searchItem,
    ['Popular', 'Popularie', 'Trending']
      .map((word) => `div:contains(${word}) + div .group.overflow-hidden.grid`)
      .join(', '),
  );
  const LATEST = widen(sel.searchItem, 'div.grid > div.group');
  const SEARCH_ITEM = widen(sel.searchItem, '#searched_series_page > button');

  const TITLE = selector(sel.title, 'div.grid > h1');
  const THUMB = selector(sel.thumbnail, 'div[class*=photoURL]');
  const DESC = selector(sel.description, '#expand_content p');
  const GENRE = selector(sel.genre, "div.grid:has(>h1) > div > a:not([title='Status'])");
  const CHAPTER_ROW = widen(sel.chapterList, '#chapters > a');
  const PAGE_IMG = widen(sel.pageList, '#pages > img');

  /**
   * A labelled field on the series page.
   *
   * `override` wins when the site declares one, because those are plain
   * selectors (`div[alt=Author]`) and mean "the label scan does not apply here".
   */
  function labelled($: CheerioAPI, label: RegExp, override: string | undefined): string {
    if (override !== undefined && override.trim() !== '') {
      return clean($(override).first().text());
    }
    // `div:has(span:containsOwn(X)) ~ div` in Jsoup: find the div whose own span
    // carries the label, then take the sibling div that follows it.
    let value = '';
    $('div:has(> span)').each((_, element) => {
      if (value !== '') return;
      const row = $(element);
      if (!label.test(clean(row.children('span').first().text()))) return;
      value = clean(row.nextAll('div').first().text());
    });
    return value;
  }

  function parseCards(html: string, cardSelector: string): SourceManga[] {
    const $ = load(html);
    const items: SourceManga[] = [];
    $(cardSelector).each((_, element) => {
      const card = $(element);
      const link = firstIn(card, 'a[href]');
      if (link === undefined) return;
      const url = absoluteUrl(baseUrl, link.attr('href'));
      // The card's `title` attribute is the clean title; its text carries the
      // latest-chapter badge glued onto the end.
      const title = clean(link.attr('title') ?? '') || clean(link.text());
      if (url === '' || title === '') return;
      // The styled element is sometimes the card itself and sometimes inside it.
      const own = card.filter('[style*=background-image]').first();
      const cover = own.length > 0 ? own : card.find('[style*=background-image]').first();
      items.push({ url, title, thumbnailUrl: backgroundImage(cover.attr('style'), baseUrl) });
    });
    // A carousel repeats its slides to loop, so the same series arrives several
    // times; the series URL is the identity.
    const unique = new Map(items.map((item) => [item.url, item]));
    return [...unique.values()];
  }

  return {
    id: config.id,
    name: config.name,
    lang: config.lang,
    baseUrl,
    supportsLatest: true,
    contentWarning: config.contentWarning,

    async getPopular(page) {
      // The featured row is on the home page and is not paged.
      if (page > 1) return { items: [], hasNextPage: false };
      const items = parseCards(await http.text(`${baseUrl}/`), POPULAR);
      // An install that dropped the featured row entirely — or renamed it past
      // all three headings — has a home page that parses to nothing, and an
      // empty Popular tab reads as a dead source. The full catalogue is a worse
      // answer than a curated one and a much better answer than none, which is
      // what upstream does for the one site that removed the row.
      if (items.length > 0) return { items, hasNextPage: false };
      return {
        items: parseCards(await http.text(`${baseUrl}/series/`), SEARCH_ITEM),
        hasNextPage: false,
      };
    },
    async getLatest(page) {
      if (page > 1) return { items: [], hasNextPage: false };
      return {
        items: parseCards(await http.text(`${baseUrl}/latest/`), LATEST),
        hasNextPage: false,
      };
    },
    async search(query, page) {
      if (page > 1) return { items: [], hasNextPage: false };
      // `/series/` answers with the whole catalogue whatever `q` says — the
      // theme filters it in the browser — so the filtering happens here too.
      // Sending `q` anyway keeps the request identical to the site's own.
      const url = `${baseUrl}/series/?q=${encodeURIComponent(query)}`;
      const items = parseCards(await http.text(url), SEARCH_ITEM);
      const needle = query.trim().toLowerCase();
      return {
        items:
          needle === '' ? items : items.filter((item) => item.title.toLowerCase().includes(needle)),
        hasNextPage: false,
      };
    },

    getFilters: (): FilterSpec[] => [],

    async getMangaDetails(manga) {
      const $ = load(await http.text(manga.url));

      const type = labelled($, /type/i, config.typeSelector);
      const genre = [
        ...(type === '' ? [] : [type.charAt(0).toUpperCase() + type.slice(1)]),
        ...$(GENRE)
          .map((_, element) => clean($(element).text()))
          .get(),
      ].filter((one, index, all) => one !== '' && all.indexOf(one) === index);

      const synopsis = clean($(DESC).first().text());
      const altNames = $(
        config.altNameSelector ?? 'div.font-medium:contains(Alternative titles) ~ div span',
      )
        .map((_, element) => clean($(element).text()))
        .get()
        .filter((one) => one !== '' && one !== 'No alternative titles.');
      const description = [
        synopsis,
        altNames.length === 0
          ? ''
          : `Alternative Names:\n${altNames.map((one) => `- ${one}`).join('\n')}`,
      ]
        .filter((part) => part !== '')
        .join('\n\n');

      // The theme's own vocabulary rather than the shared one: "dropped" here
      // means cancelled, "paused" means hiatus.
      const state = labelled($, /status/i, sel.status).toLowerCase();
      const status: MangaStatus = state.includes('ongoing')
        ? 'ONGOING'
        : state.includes('completed')
          ? 'COMPLETED'
          : state.includes('dropped')
            ? 'CANCELLED'
            : state.includes('paused')
              ? 'ON_HIATUS'
              : 'UNKNOWN';

      return {
        url: manga.url,
        title: clean($(TITLE).first().text()),
        thumbnailUrl: backgroundImage($(THUMB).first().attr('style'), baseUrl),
        author: labelled($, /author/i, sel.author) || null,
        artist: labelled($, /artist/i, sel.artist) || null,
        description: description || null,
        genre,
        status,
        realUrl: manga.url,
        initialized: true,
      };
    },

    async getChapterList(manga) {
      const $ = load(await http.text(manga.url));
      const chapters: SourceChapter[] = [];
      $(CHAPTER_ROW).each((_, element) => {
        const row = $(element);
        // Upstream expresses both of these as Jsoup `:not(:has(…))` selectors,
        // one of them with `:matches()`, which Cheerio has no equivalent for.
        // Announced-but-unreleased chapters 404 when opened and paid ones serve
        // a paywall; both read as a broken source rather than as a listing.
        if (/upcoming/i.test(row.find('.text-sm span').text())) return;
        if (row.find('img[alt*=Coin]').length > 0) return;

        const href = row.is('a') ? row.attr('href') : row.find('a[href]').first().attr('href');
        const url = absoluteUrl(baseUrl, href);
        const name = clean(row.find('.text-sm').first().text());
        if (url === '' || name === '') return;
        chapters.push({
          url,
          name,
          chapterNumber: parseChapterNumber(name),
          // English throughout, absolute ("Jan 5, 2026") or relative; both are
          // what `parseDate` already reads.
          dateUpload: parseDate(row.find('.text-xs').first().text()),
          realUrl: url,
        });
      });
      const deduped = dedupeChapters(chapters);
      if (deduped.length === 0) throw new NoResultsError();
      return deduped;
    },

    async getPageList(chapter) {
      const html = await http.text(chapter.url);
      const $ = load(html);

      // The reader builds each image URL from one CDN host printed in a script,
      // and the host is interpolated, so the `${…}` has to come back out.
      const host = /realUrl\s*=\s*`[^`]+\/\/([^/`]+)/.exec(html)?.[1]?.replace(/\$\{[^}]*\}/g, '');

      const uids = $(PAGE_IMG)
        .map((_, element) => clean($(element).attr('uid') ?? ''))
        .get()
        .filter((uid) => uid !== '');
      if (uids.length > 0) {
        if (host === undefined || host === '') throw new NoResultsError('No page host found');
        return uids.map((uid, index) => ({ index, url: `https://${host}/uploads/${uid}` }));
      }

      // Older installs still print the image itself.
      const pages: SourcePage[] = [];
      $(PAGE_IMG).each((_, element) => {
        const img = $(element);
        const raw = img.attr('data-lazy-src') ?? img.attr('data-src') ?? img.attr('src');
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
