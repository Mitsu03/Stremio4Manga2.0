/**
 * "Madara" — WordPress plus the *Madara – WP Manga Theme* plugin.
 *
 * One paid WordPress theme is, by a wide margin, the single most common way a
 * scanlation site is built, which is why one parameterised engine covers dozens
 * of sites that look nothing alike. The markup below is the plugin's own, not
 * any one site's: `.page-item-detail` cards, `.post-content_item` rows keyed by
 * their `<h5>` heading, `li.wp-manga-chapter` chapter rows, and
 * `.reading-content img.wp-manga-chapter-img` pages.
 *
 * The three things sites actually differ on are parameters here:
 *   * the slug in front of a series URL (`/manga/`, `/series/`, `/read-scan/`…),
 *     which the theme's owner renames freely;
 *   * whether the chapter list is server-rendered or fetched over admin-ajax
 *     after load — newer plugin versions moved it, older ones did not;
 *   * lazy-loaded covers, which hide the real URL in one of half a dozen
 *     `data-*` attributes.
 */
import { load, type CheerioAPI, type Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type {
  FilterChange,
  FilterSpec,
  MangaPage,
  Source,
  SourceChapter,
  SourceDeps,
  SourceManga,
  SourcePage,
} from '../types.js';
import { NoResultsError } from '../types.js';
import {
  absoluteUrl,
  clean,
  dedupeChapters,
  form,
  parseChapterNumber,
  parseDate,
  parseStatus,
} from '../util.js';

export interface MadaraGenre {
  /** What the UI shows. */
  name: string;
  /** The slug the site expects in `genre[]`. */
  value: string;
}

export interface MadaraConfig {
  id: string;
  name: string;
  lang: string;
  baseUrl: string;
  contentWarning: 'SAFE' | 'MIXED' | 'NSFW';
  /** Path segment of a series page: `manga` in `https://site/manga/slug/`. */
  mangaPath?: string;
  /**
   * How the chapter list arrives.
   *   `page`  — already in the series HTML (older installs, and any site whose
   *             owner turned the AJAX loader off for SEO);
   *   `ajax`  — POST admin-ajax.php with the numeric post id;
   *   `auto`  — read the page, and only fall back to AJAX if it held nothing.
   */
  chapterSource?: 'page' | 'ajax' | 'auto';
  /** Genres offered as a filter. Empty means the source ships no genre filter. */
  genres?: MadaraGenre[];
  /** Extra headers, usually a Referer some installs demand on admin-ajax. */
  headers?: Record<string, string>;
  minIntervalMs?: number;
}

/** The card grid, shared by the listing, the latest page and search results. */
const CARD = 'div.page-item-detail, div.c-tabs-item__content, div.manga__item';

/**
 * Madara lazy-loads covers through several plugins, each with its own
 * attribute, and the `src` that is actually present is then a placeholder GIF.
 * Order matters: `data-src` is the real one when both exist.
 */
const IMAGE_ATTRS = ['data-src', 'data-lazy-src', 'data-cfsrc', 'data-original', 'srcset', 'src'];

function imageFrom(element: Cheerio<AnyNode>, base: string): string | null {
  const img = element.find('img').first();
  for (const attr of IMAGE_ATTRS) {
    const raw = img.attr(attr);
    if (!raw) continue;
    // A srcset is "url w, url w"; the first entry is the smallest and always
    // present, and a cover thumbnail is all this is used for.
    const url = attr === 'srcset' ? raw.split(',')[0].trim().split(' ')[0] : raw.trim();
    if (url && !url.startsWith('data:')) return absoluteUrl(base, url);
  }
  return null;
}

export function createMadaraSource(config: MadaraConfig, deps: SourceDeps): Source {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const mangaPath = config.mangaPath ?? 'manga';
  const chapterSource = config.chapterSource ?? 'auto';
  const genres = config.genres ?? [];
  const http = deps.http;

  const filters: FilterSpec[] = [
    { kind: 'header', name: 'Filters do nothing when a text query is set' },
    {
      kind: 'select',
      name: 'Order by',
      values: ['Relevance', 'Latest', 'A-Z', 'Rating', 'Trending', 'Most Views', 'New'],
      default: 0,
    },
    {
      kind: 'select',
      name: 'Status',
      values: ['Any', 'Ongoing', 'Completed', 'Canceled', 'On Hold'],
      default: 0,
    },
    { kind: 'checkbox', name: 'Adult content only', default: false },
    ...(genres.length > 0
      ? ([
          {
            kind: 'group',
            name: 'Genres',
            filters: genres.map((genre) => ({
              kind: 'checkbox' as const,
              name: genre.name,
              default: false,
            })),
          },
        ] as FilterSpec[])
      : []),
  ];

  const ORDER_VALUES = ['', 'latest', 'alphabet', 'rating', 'trending', 'views', 'new-manga'];
  const STATUS_VALUES = ['', 'on-going', 'end', 'canceled', 'on-hold'];

  function listUrl(page: number, query: string, changes: FilterChange[]): string {
    const params = new URLSearchParams();
    params.set('s', query);
    params.set('post_type', 'wp-manga');

    for (const change of changes) {
      const spec = filters[change.position];
      if (!spec) continue;
      if (spec.kind === 'select' && spec.name === 'Order by' && change.selectState) {
        params.set('m_orderby', ORDER_VALUES[change.selectState] ?? '');
      }
      if (spec.kind === 'select' && spec.name === 'Status' && change.selectState) {
        params.append('status[]', STATUS_VALUES[change.selectState] ?? '');
      }
      if (spec.kind === 'checkbox' && spec.name === 'Adult content only' && change.checkBoxState) {
        params.set('adult', '1');
      }
      if (spec.kind === 'group' && change.groupChange) {
        const inner = spec.filters[change.groupChange.position];
        if (inner && change.groupChange.checkBoxState) {
          const genre = genres.find((candidate) => candidate.name === inner.name);
          if (genre) params.append('genre[]', genre.value);
        }
      }
    }

    // Madara paginates search with /page/N/ in the path, not a query parameter.
    const prefix = page > 1 ? `${baseUrl}/page/${page}/` : `${baseUrl}/`;
    return `${prefix}?${params.toString()}`;
  }

  function parseList(html: string): MangaPage<SourceManga> {
    const $ = load(html);
    const items: SourceManga[] = [];
    $(CARD).each((_, element) => {
      const card = $(element);
      const link = card.find('h3 a, h4 a, .post-title a, a').first();
      const url = absoluteUrl(baseUrl, link.attr('href'));
      const title = clean(link.attr('title') ?? link.text());
      if (url === '' || title === '') return;
      items.push({ url, title, thumbnailUrl: imageFrom(card, baseUrl) });
    });

    // Madara marks the end of a listing by dropping the pager entirely; a full
    // page of results with no pager still means "no more", so the count alone
    // cannot be trusted. WP-PageNavi is the usual pager and labels its forward
    // links `larger`/`last` rather than `next`, which is what the theme's own
    // CSS calls them — matching only `.next` finds nothing on a live install.
    const hasNextPage =
      $(
        '.wp-pagenavi a.larger, .wp-pagenavi a.last, .wp-pagenavi .nextpostslink, ' +
          '.nav-previous a, a.next.page-numbers',
      ).length > 0;
    return { items, hasNextPage };
  }

  async function listing(page: number, orderBy: string): Promise<MangaPage<SourceManga>> {
    // The `/page/N/` form of the archive is the one every install keeps working;
    // the AJAX loader the theme uses in the browser needs a nonce we do not have.
    const path = page > 1 ? `${baseUrl}/${mangaPath}/page/${page}/` : `${baseUrl}/${mangaPath}/`;
    return parseList(await http.text(`${path}?m_orderby=${orderBy}`));
  }

  async function chaptersFromAjax(postId: string): Promise<string> {
    return http.text(`${baseUrl}/wp-admin/admin-ajax.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${baseUrl}/`,
      },
      body: form({ action: 'manga_get_chapters', manga: postId }),
    });
  }

  function parseChapters($: CheerioAPI): SourceChapter[] {
    const chapters: SourceChapter[] = [];
    $('li.wp-manga-chapter').each((_, element) => {
      const row = $(element);
      const link = row.find('a').first();
      const url = absoluteUrl(baseUrl, link.attr('href'));
      const name = clean(link.text());
      if (url === '' || name === '') return;
      // The release date is a `title` attribute on the "N days ago" tag when the
      // site renders a relative date, and plain text otherwise.
      const dateCell = row.find('.chapter-release-date');
      const dateText = dateCell.find('a').attr('title') ?? dateCell.text();
      chapters.push({
        url,
        name,
        chapterNumber: parseChapterNumber(name),
        dateUpload: parseDate(dateText),
        realUrl: url,
      });
    });
    return dedupeChapters(chapters);
  }

  return {
    id: config.id,
    name: config.name,
    lang: config.lang,
    baseUrl,
    supportsLatest: true,
    contentWarning: config.contentWarning,

    getPopular: (page) => listing(page, 'views'),
    getLatest: (page) => listing(page, 'latest'),

    async search(query, page, changes = []) {
      return parseList(await http.text(listUrl(page, query, changes)));
    },

    getFilters: () => filters,

    async getMangaDetails(manga) {
      const $ = load(await http.text(manga.url));

      const description = clean(
        $('div.summary__content, div.description-summary div.summary__content').first().text(),
      );
      const genre = $('div.genres-content a')
        .map((_, element) => clean($(element).text()))
        .get()
        .filter((value) => value !== '');

      return {
        url: manga.url,
        title: clean($('div.post-title h1, div.post-title h3').first().text()),
        thumbnailUrl: imageFrom($('div.summary_image').first(), baseUrl),
        author: clean($('div.author-content a').first().text()) || null,
        artist: clean($('div.artist-content a').first().text()) || null,
        description: description || null,
        genre,
        // The status row is identified by its heading, not by a class: Madara
        // renders every summary row with the same markup and only the `<h5>`
        // tells them apart, and the row order differs between installs.
        status: parseStatus(
          $('div.post-status div.post-content_item, div.post-content_item')
            .filter((_, element) => /status/i.test($(element).find('h5').text()))
            .find('div.summary-content')
            .first()
            .text(),
        ),
        realUrl: manga.url,
        initialized: true,
      };
    },

    async getChapterList(manga) {
      const html = await http.text(manga.url);
      const $ = load(html);

      if (chapterSource !== 'ajax') {
        const inPage = parseChapters($);
        if (inPage.length > 0 || chapterSource === 'page') {
          if (inPage.length === 0) throw new NoResultsError();
          return inPage;
        }
      }

      // The numeric post id is what admin-ajax keys on. It is exposed either as
      // the shortcode's data attribute or in the `manga_bookmark` script block.
      const postId =
        $('div[id^=manga-chapters-holder]').attr('data-id') ??
        $('.wp-manga-action-button[data-post]').attr('data-post') ??
        /"?post_id"?\s*[:=]\s*"?(\d+)/.exec(html)?.[1];
      if (!postId) throw new NoResultsError(`${config.name} did not expose a chapter list`);

      const chapters = parseChapters(load(await chaptersFromAjax(postId)));
      if (chapters.length === 0) throw new NoResultsError();
      return chapters;
    },

    async getPageList(chapter) {
      const $ = load(await http.text(chapter.url));
      const pages: SourcePage[] = [];
      $('div.reading-content img.wp-manga-chapter-img, div.reading-content div.page-break img').each(
        (_, element) => {
          const img = $(element);
          for (const attr of IMAGE_ATTRS) {
            const raw = img.attr(attr);
            if (!raw || raw.startsWith('data:')) continue;
            const url = absoluteUrl(baseUrl, attr === 'srcset' ? raw.split(',')[0].trim() : raw);
            if (url === '') continue;
            pages.push({ index: pages.length, url });
            return;
          }
        },
      );
      if (pages.length === 0) throw new NoResultsError('No pages found');
      return pages;
    },

    imageHeaders: () => ({ Referer: `${baseUrl}/`, ...config.headers }),
  };
}
