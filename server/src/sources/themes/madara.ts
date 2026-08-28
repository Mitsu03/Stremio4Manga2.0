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
import { createDecipheriv, createHash } from 'node:crypto';
import { load, type CheerioAPI, type Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { firstIn, selector, widen, type ThemeSelectors } from './selectors.js';
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
  parseDateWith,
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
   *   `page`        — already in the series HTML (older installs, and any site
   *                   whose owner turned the AJAX loader off for SEO);
   *   `ajax`        — POST admin-ajax.php with the numeric post id;
   *   `manga-ajax`  — POST the series' own `/ajax/chapters/`, with neither a
   *                   post id nor a body. This is what most current installs
   *                   do — 107 of the 173 upstream extensions — and a site can
   *                   be on it while still exposing a post id, so the `auto`
   *                   probe below has to try it before giving up;
   *   `auto`        — read the page, then fall back to whichever AJAX form the
   *                   document gives us the means to call.
   */
  chapterSource?: 'page' | 'ajax' | 'manga-ajax' | 'auto';
  /** Genres offered as a filter. Empty means the source ships no genre filter. */
  genres?: MadaraGenre[];
  /** Extra headers, usually a Referer some installs demand on admin-ajax. */
  headers?: Record<string, string>;
  minIntervalMs?: number;
  /** Java date pattern the site writes chapter dates in, e.g. `dd/MM/yyyy`. */
  dateFormat?: string;
  /** BCP-47 tag for that pattern's month names, e.g. `tr`, `pt-BR`. */
  dateLocale?: string;
  /** Per-site markup differences, read off the extension's own Kotlin. */
  selectors?: ThemeSelectors;
  /**
   * Browse the archive unsorted.
   *
   * A couple of installs have a firewall rule on the sort parameter itself:
   * `/manga/` answers, `/manga/?m_orderby=views` is challenged. Losing the sort
   * order is the whole difference between the source working without a solver
   * and not working at all.
   */
  omitSort?: boolean;
  /**
   * How the listing is fetched.
   *   `archive`   — GET `/{mangaPath}/page/N/`, which is what most installs
   *                 serve and remains the default;
   *   `load-more` — POST the theme's own `madara_load_more` action. Some
   *                 installs redirect the archive path to the home page and
   *                 answer only this; upstream marks them
   *                 `LoadMoreStrategy.Always`.
   */
  listingMode?: 'archive' | 'load-more';
}

/** The card grid, shared by the listing, the latest page and search results. */
// Deliberately not tag-qualified. Madara child themes increasingly render the
// card as <article> rather than <div>, and `div.page-item-detail` cannot match
// those at all — the listing comes back empty on a site whose markup is
// otherwise exactly the theme's.
const CARD = '.page-item-detail, .c-tabs-item__content, .manga__item';

/**
 * Madara lazy-loads covers through several plugins, each with its own
 * attribute, and the `src` that is actually present is then a placeholder GIF.
 * Order matters: `data-src` is the real one when both exist.
 */
const IMAGE_ATTRS = ['data-src', 'data-lazy-src', 'data-cfsrc', 'data-original', 'srcset', 'src'];

/**
 * CryptoJS's OpenSSL key derivation: MD5(previous ‖ password ‖ salt), repeated
 * until there are enough bytes for a key and an IV.
 *
 * Not a choice anyone would make today. It is what `CryptoJS.AES.decrypt` does
 * with a passphrase, and the WordPress plugin below encrypts with exactly that,
 * so it is what has to be undone.
 */
function openSslKey(password: string, salt: Buffer): { key: Buffer; iv: Buffer } {
  const secret = Buffer.from(password, 'utf8');
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  while (derived.length < 48) {
    block = createHash('md5')
      .update(Buffer.concat([block, secret, salt]))
      .digest();
    derived = Buffer.concat([derived, block]);
  }
  return { key: derived.subarray(0, 32), iv: derived.subarray(32, 48) };
}

/**
 * The page list of a chapter behind the "chapter protector" plugin.
 *
 * Some Madara installs stop printing `<img>` into the reader and ship the image
 * URLs as an AES blob with the key sitting in the same script — which protects
 * nothing, and is presumably meant to defeat naive scrapers. Ignoring it costs
 * every chapter on those sites, and the sites are not rare: the one that led
 * here does not even declare the feature upstream.
 *
 * Returns undefined when the document is an ordinary one, which is the signal to
 * parse it the normal way.
 */
function protectedPages(document: CheerioAPI): string[] | undefined {
  const holder = document('#chapter-protector-data').first();
  if (holder.length === 0) return undefined;

  // The script is inline on most installs and a base64 data URL on the rest.
  const src = holder.attr('src') ?? '';
  const prefix = 'data:text/javascript;base64,';
  const script = src.startsWith(prefix)
    ? Buffer.from(src.slice(prefix.length), 'base64').toString('utf8')
    : holder.html() ?? '';

  const between = (after: string): string | undefined => {
    const start = script.indexOf(after);
    if (start === -1) return undefined;
    const from = start + after.length;
    const end = script.indexOf("';", from);
    return end === -1 ? undefined : script.slice(from, end);
  };

  const password = between("wpmangaprotectornonce='");
  const raw = between("chapter_data='");
  if (password === undefined || raw === undefined) return undefined;

  try {
    const data = JSON.parse(raw.replaceAll('\\/', '/')) as { ct?: string; s?: string };
    if (!data.ct || !data.s) return undefined;
    const { key, iv } = openSslKey(password, Buffer.from(data.s, 'hex'));
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const plain = Buffer.concat([
      decipher.update(Buffer.from(data.ct, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    // Doubly encoded: a JSON string whose content is itself a JSON array.
    const inner = JSON.parse(plain) as string;
    const urls = JSON.parse(inner) as unknown;
    if (!Array.isArray(urls)) return undefined;
    return urls.filter((url): url is string => typeof url === 'string' && url !== '');
  } catch {
    // A changed key, a changed shape, a padding error: fall back to reading the
    // document, which is a better answer than failing the chapter outright.
    return undefined;
  }
}

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

  // A site that renames its markup usually *adds* to the theme's rather than
  // replacing it, so listing and list-shaped selectors widen the default;
  // matching either is what survives an install changing its skin back.
  const sel = config.selectors ?? {};
  const CARDS = widen(sel.searchItem, CARD);
  // Ordered as a fallback chain, most specific first — see `firstIn`.
  const CARD_LINK = selector(sel.searchTitle, 'h3 a, h4 a, .post-title a, a');
  const TITLE_TEXT = sel.searchTitleText;
  const CHAPTER_ROW = widen(sel.chapterList, 'li.wp-manga-chapter');
  const PAGE_IMG = widen(
    sel.pageList,
    'div.reading-content img.wp-manga-chapter-img, div.reading-content div.page-break img',
  );
  // Details come out of one document, so a wrong selector costs a field rather
  // than the whole source; these replace, which is what an install that moved a
  // summary row actually means.
  const TITLE = selector(sel.title, 'div.post-title h1, div.post-title h3');
  const THUMB = selector(sel.thumbnail, 'div.summary_image');
  const DESC = selector(
    sel.description,
    'div.summary__content, div.description-summary div.summary__content',
  );
  const GENRE = selector(sel.genre, 'div.genres-content a');
  const AUTHOR = selector(sel.author, 'div.author-content a');
  const ARTIST = selector(sel.artist, 'div.artist-content a');
  const CHAPTER_DATE = selector(sel.chapterDate, '.chapter-release-date');

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
    $(CARDS).each((_, element) => {
      const card = $(element);
      const link = firstIn(card, CARD_LINK);
      if (link === undefined) return;
      const url = absoluteUrl(baseUrl, link.attr('href'));
      // The title text can live in a child of the link rather than in the link,
      // on skins that wrap the whole card in one anchor.
      const text =
        TITLE_TEXT === undefined ? undefined : clean(card.find(TITLE_TEXT).first().text());
      const title =
        text !== undefined && text !== '' ? text : clean(link.attr('title') ?? link.text());
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

  /**
   * The theme's own archive endpoint. It returns the same card markup the
   * archive page does, so the ordinary parse handles the response unchanged.
   *
   * It needs no nonce. A comment here long claimed it did, and that claim is
   * the only reason this went unimplemented — worth remembering, because a
   * sentence about someone else's system has no test that fails when it stops
   * being true, or when it was never true.
   *
   * `page` is zero-based here, unlike everywhere else in this theme.
   */
  async function listingViaLoadMore(page: number, metaKey: string): Promise<string> {
    return http.text(`${baseUrl}/wp-admin/admin-ajax.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${baseUrl}/`,
      },
      body: form({
        action: 'madara_load_more',
        page: page - 1,
        template: 'madara-core/content/content-archive',
        'vars[paged]': 1,
        'vars[template]': 'archive',
        'vars[posts_per_page]': 20,
        'vars[post_type]': 'wp-manga',
        'vars[post_status]': 'publish',
        'vars[manga_archives_item_layout]': 'big_thumbnail',
        'vars[orderby]': 'meta_value_num',
        'vars[meta_key]': metaKey,
        'vars[order]': 'desc',
      }),
    });
  }

  async function listing(page: number, orderBy: string): Promise<MangaPage<SourceManga>> {
    // The `/page/N/` form of the archive is the one most installs keep working.
    // A few redirect it to the home page and answer only the AJAX loader, which
    // is what `load-more` is for.
    if (config.listingMode === 'load-more') {
      return parseList(
        await listingViaLoadMore(page, orderBy === 'latest' ? '_latest_update' : '_wp_manga_views'),
      );
    }
    const path = page > 1 ? `${baseUrl}/${mangaPath}/page/${page}/` : `${baseUrl}/${mangaPath}/`;
    return parseList(
      await http.text(config.omitSort === true ? path : `${path}?m_orderby=${orderBy}`),
    );
  }

  /**
   * The series' own chapter endpoint. Takes no post id and no body — the slug in
   * the URL is the whole request — which is why it works on installs that have
   * stopped exposing a numeric post id at all.
   */
  async function chaptersFromMangaAjax(mangaUrl: string): Promise<string> {
    return http.text(`${mangaUrl.replace(/\/+$/, '')}/ajax/chapters/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: mangaUrl,
      },
      body: '',
    });
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
    $(CHAPTER_ROW).each((_, element) => {
      const row = $(element);
      const link = row.find('a').first();
      const url = absoluteUrl(baseUrl, link.attr('href'));
      const name = clean(link.text());
      if (url === '' || name === '') return;
      // The release date is a `title` attribute on the "N days ago" tag when the
      // site renders a relative date, and plain text otherwise.
      const dateCell = row.find(CHAPTER_DATE);
      const dateText = dateCell.find('a').attr('title') ?? dateCell.text();
      chapters.push({
        url,
        name,
        chapterNumber: parseChapterNumber(name),
        dateUpload: parseDateWith(dateText, config.dateFormat, config.dateLocale),
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

      const description = clean($(DESC).first().text());
      const genre = $(GENRE)
        .map((_, element) => clean($(element).text()))
        .get()
        .filter((value) => value !== '');

      return {
        url: manga.url,
        title: clean($(TITLE).first().text()),
        thumbnailUrl: imageFrom($(THUMB).first(), baseUrl),
        author: clean($(AUTHOR).first().text()) || null,
        artist: clean($(ARTIST).first().text()) || null,
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

      // The numeric post id is what admin-ajax keys on. It is exposed either as
      // the shortcode's data attribute or in the `manga_bookmark` script block.
      const postId =
        $('div[id^=manga-chapters-holder]').attr('data-id') ??
        $('.wp-manga-action-button[data-post]').attr('data-post') ??
        /"?post_id"?\s*[:=]\s*"?(\d+)/.exec(html)?.[1];

      const attempts = {
        page: async (): Promise<SourceChapter[]> => parseChapters($),
        'manga-ajax': async (): Promise<SourceChapter[]> =>
          parseChapters(load(await chaptersFromMangaAjax(manga.url))),
        ajax: async (): Promise<SourceChapter[]> =>
          postId === undefined ? [] : parseChapters(load(await chaptersFromAjax(postId))),
      };

      /**
       * `chapterSource` orders the attempts; it does not narrow them to one.
       *
       * A declared value is what the *extension* said, and extensions go stale:
       * three sites here declare the slug endpoint and answer 404 on it while
       * still rendering the list into the page. Treating the declaration as the
       * only thing to try made those sources with no chapters at all, when the
       * answer was already in the document. So it decides where to look first
       * and the rest stay as fallbacks — except `page`, which is the one mode
       * meaning "this install has no endpoint", and where trying the others
       * would be two requests spent to learn nothing.
       */
      const order: (keyof typeof attempts)[] =
        chapterSource === 'page'
          ? ['page']
          : chapterSource === 'manga-ajax'
            ? ['manga-ajax', 'page', 'ajax']
            : chapterSource === 'ajax'
              ? ['ajax', 'page', 'manga-ajax']
              : // `auto`: the page first, because it is already fetched. Then the
                // slug endpoint, because an install on that mode can still be
                // advertising a post id that admin-ajax will refuse.
                ['page', 'manga-ajax', 'ajax'];

      for (const attempt of order) {
        let chapters: SourceChapter[] = [];
        try {
          chapters = await attempts[attempt]();
        } catch {
          // A 404 or a 400 from one endpoint says that endpoint is not there,
          // which is a reason to try the next one rather than to fail the source.
          continue;
        }
        if (chapters.length > 0) return chapters;
      }
      throw new NoResultsError(`${config.name} did not expose a chapter list`);
    },

    async getPageList(chapter) {
      const $ = load(await http.text(chapter.url));

      // Checked before the markup, because an install with the protector prints
      // no reader images at all — the document parses cleanly to nothing.
      const encrypted = protectedPages($);
      if (encrypted !== undefined && encrypted.length > 0) {
        return encrypted.map((url, index) => ({ index, url: absoluteUrl(baseUrl, url) }));
      }

      const pages: SourcePage[] = [];
      $(PAGE_IMG).each((_, element) => {
        const img = $(element);
        for (const attr of IMAGE_ATTRS) {
          const raw = img.attr(attr);
          if (!raw || raw.startsWith('data:')) continue;
          const url = absoluteUrl(baseUrl, attr === 'srcset' ? raw.split(',')[0].trim() : raw);
          if (url === '') continue;
          pages.push({ index: pages.length, url });
          return;
        }
      });
      if (pages.length === 0) throw new NoResultsError('No pages found');
      return pages;
    },

    imageHeaders: () => ({ Referer: `${baseUrl}/`, ...config.headers }),
  };
}
