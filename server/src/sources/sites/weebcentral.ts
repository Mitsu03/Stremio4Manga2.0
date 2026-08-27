/**
 * Weeb Central — server-rendered HTML with htmx, which is unusually good news.
 *
 * Because every interactive part of the site is an htmx fragment, the fragments
 * are the API: `/search/data` returns just the result cards, a series' chapter
 * list has its own URL, and so do a chapter's images. There is no JSON to parse
 * and no JavaScript to run, only three small documents.
 *
 * The markup has no ids and no semantic class names — it is Tailwind, so the
 * classes describe spacing, not meaning. Selectors here therefore hang off
 * structure and off the label text of each `<li>`, which is the only stable
 * thing on the page.
 */
import { load, type CheerioAPI } from 'cheerio';
import type {
  FilterChange,
  FilterSpec,
  MangaPage,
  Source,
  SourceChapter,
  SourceDeps,
  SourceDefinition,
  SourceManga,
} from '../types.js';
import { NoResultsError } from '../types.js';
import { absoluteUrl, clean, dedupeChapters, parseChapterNumber, parseStatus } from '../util.js';

const SITE = 'https://weebcentral.com';
const PAGE_SIZE = 32;

const SORTS = ['Best Match', 'Alphabet', 'Popularity', 'Subscribers', 'Recently Added', 'Latest Updates'];
const TYPES = ['', 'Manga', 'Manhwa', 'Manhua', 'OEL'];
const STATUSES = ['', 'Ongoing', 'Complete', 'Hiatus', 'Canceled'];

/** The `<li>` rows on a series page are told apart only by their `<strong>`. */
function labelled($: CheerioAPI, label: RegExp) {
  return $('li')
    .filter((_, element) => label.test($(element).find('strong').first().text()))
    .first();
}

function build(deps: SourceDeps): Source {
  const http = deps.http;

  const filters: FilterSpec[] = [
    { kind: 'select', name: 'Sort by', values: SORTS, default: 0 },
    { kind: 'select', name: 'Order', values: ['Descending', 'Ascending'], default: 0 },
    { kind: 'select', name: 'Type', values: ['Any', ...TYPES.slice(1)], default: 0 },
    { kind: 'select', name: 'Status', values: ['Any', ...STATUSES.slice(1)], default: 0 },
    { kind: 'select', name: 'Official translation', values: ['Any', 'Yes', 'No'], default: 0 },
  ];

  function dataUrl(query: string, page: number, changes: FilterChange[]): string {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String((page - 1) * PAGE_SIZE));
    // "Full Display" is the only mode whose cards carry a cover image; the
    // minimal one is text and would leave the grid blank.
    params.set('display_mode', 'Full Display');
    params.set('sort', query ? 'Best Match' : 'Popularity');
    params.set('order', 'Descending');
    params.set('official', 'Any');
    if (query) params.set('text', query);

    for (const change of changes) {
      const spec = filters[change.position];
      if (!spec || spec.kind !== 'select' || change.selectState === undefined) continue;
      if (spec.name === 'Sort by') params.set('sort', SORTS[change.selectState] ?? 'Popularity');
      if (spec.name === 'Order') {
        params.set('order', change.selectState === 1 ? 'Ascending' : 'Descending');
      }
      if (spec.name === 'Type' && change.selectState) {
        params.append('included_type', TYPES[change.selectState] ?? '');
      }
      if (spec.name === 'Status' && change.selectState) {
        params.append('included_status', STATUSES[change.selectState] ?? '');
      }
      if (spec.name === 'Official translation' && change.selectState) {
        params.set('official', change.selectState === 1 ? 'True' : 'False');
      }
    }
    return `${SITE}/search/data?${params.toString()}`;
  }

  async function list(url: string): Promise<MangaPage<SourceManga>> {
    const $ = load(await http.text(url));
    const items: SourceManga[] = [];
    $('article').each((_, element) => {
      const card = $(element);
      // A card links to its series two or three times — cover, mobile overlay,
      // title — and only the title link has text. Minimal Display has no cover
      // at all and puts the title in an `<h2>`, so take the first link that
      // carries text and fall back to the heading.
      const links = card.find('a[href*="/series/"]');
      const href = links.first().attr('href');
      if (!href) return;
      // The title anchor is the one styled as a link; the cover anchor wraps
      // the image and, on an official release, an "Official" corner ribbon
      // whose text would otherwise be glued to the front of the title.
      let title = clean(links.filter('.link').first().text());
      if (title === '') title = clean(links.first().attr('data-tip') ?? '');
      if (title === '') title = clean(card.find('h2').first().text());
      // Last resort: the cover's alt is "<title> cover".
      if (title === '') {
        title = clean(card.find('img').first().attr('alt') ?? '').replace(/ cover$/i, '');
      }
      if (title === '') return;
      const srcset = card.find('picture source').first().attr('srcset');
      const src = card.find('img').first().attr('src');
      items.push({
        url: absoluteUrl(SITE, href),
        title,
        thumbnailUrl: absoluteUrl(SITE, srcset?.split(' ')[0] ?? src) || null,
      });
    });
    // Duplicates are possible because a card can be rendered twice for the two
    // breakpoints; the series URL is the identity.
    const unique = new Map(items.map((item) => [item.url, item]));
    return { items: [...unique.values()], hasNextPage: unique.size >= PAGE_SIZE };
  }

  return {
    id: '1000000000000000003',
    name: 'Weeb Central',
    lang: 'en',
    baseUrl: SITE,
    supportsLatest: true,
    contentWarning: 'SAFE',

    getPopular: (page) => list(dataUrl('', page, [])),
    getLatest: (page) =>
      list(
        `${SITE}/search/data?limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}` +
          '&sort=Latest%20Updates&order=Descending&official=Any&display_mode=Full%20Display',
      ),
    search: (query, page, changes = []) => list(dataUrl(query, page, changes)),

    getFilters: () => filters,

    async getMangaDetails(manga) {
      const $ = load(await http.text(manga.url));
      return {
        url: manga.url,
        title: clean($('h1').first().text()),
        thumbnailUrl: $('meta[property="og:image"]').attr('content') ?? null,
        author: labelled($, /author/i)
          .find('a')
          .map((_, element) => clean($(element).text()))
          .get()
          .join(', ') || null,
        artist: null,
        description: clean(labelled($, /description/i).find('p').text()) || null,
        genre: labelled($, /tag/i)
          .find('a')
          .map((_, element) => clean($(element).text()))
          .get(),
        status: parseStatus(labelled($, /^status/i).find('a').first().text()),
        realUrl: manga.url,
        initialized: true,
      };
    },

    async getChapterList(manga) {
      // The series page ships only the newest few chapters and a "Show All"
      // button; the button's hx-get is this URL, which returns all of them.
      const seriesId = /\/series\/([^/]+)/.exec(manga.url)?.[1];
      if (!seriesId) throw new NoResultsError('Not a Weeb Central series URL');
      const $ = load(await http.text(`${SITE}/series/${seriesId}/full-chapter-list`));

      const chapters: SourceChapter[] = [];
      $('a[href*="/chapters/"]').each((_, element) => {
        const link = $(element);
        const name = clean(link.find('span.grow span').first().text() || link.text());
        const url = absoluteUrl(SITE, link.attr('href'));
        if (url === '' || name === '') return;
        // The date lives in an Alpine expression on the wrapping div, which is
        // the only place it appears: checkNewChapter('<ISO timestamp>').
        const alpine = link.parent().attr('x-data') ?? '';
        const iso = /checkNewChapter\('([^']+)'\)/.exec(alpine)?.[1];
        chapters.push({
          url,
          name,
          chapterNumber: parseChapterNumber(name),
          dateUpload: iso ? (Date.parse(iso) || 0) : 0,
          realUrl: url,
        });
      });

      const deduped = dedupeChapters(chapters);
      if (deduped.length === 0) throw new NoResultsError();
      return deduped;
    },

    async getPageList(chapter) {
      const chapterId = /\/chapters\/([^/?]+)/.exec(chapter.url)?.[1];
      if (!chapterId) throw new NoResultsError('Not a Weeb Central chapter URL');
      const $ = load(
        await http.text(
          `${SITE}/chapters/${chapterId}/images?is_prev=False&current_page=1&reading_style=long_strip`,
        ),
      );
      const pages = $('section img')
        .map((_, element) => $(element).attr('src') ?? '')
        .get()
        .filter((url) => url !== '' && !url.startsWith('data:'))
        .map((url, index) => ({ index, url: absoluteUrl(SITE, url) }));
      if (pages.length === 0) throw new NoResultsError('No pages found');
      return pages;
    },

    // Images are served from a separate CDN host that checks the referrer.
    imageHeaders: () => ({ Referer: `${SITE}/` }),
  };
}

export const definition: SourceDefinition = {
  pkgName: 'weebcentral',
  name: 'Weeb Central',
  lang: 'en',
  id: '1000000000000000003',
  contentWarning: 'SAFE',
  versionName: '1.0.0',
  build,
};
