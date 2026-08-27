/**
 * "MangaThemesia", the theme everyone still calls WPMangaStream.
 *
 * The other half of the WordPress scanlation world. Its tells are the `.bsx`
 * grid card, the `.tsinfo .imptdt` info rows (label and value in one div, told
 * apart only by the label text) and the `#chapterlist li` chapter list.
 *
 * The interesting part is the reader. MangaThemesia does not render the page
 * images into the HTML — it prints a `ts_reader.run({...})` call with the whole
 * chapter as JSON and lets JavaScript build the `<img>` tags. Extracting that
 * JSON is exact and cheap; the `<img>` fallback below is for the installs that
 * have been patched to server-render (RizzFables is one), and it must skip the
 * theme's own chrome images or every chapter would start with a logo.
 */
import { load, type CheerioAPI } from 'cheerio';
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
  parseChapterNumber,
  parseDate,
  parseStatus,
} from '../util.js';

export interface MangaThemesiaConfig {
  id: string;
  name: string;
  lang: string;
  baseUrl: string;
  contentWarning: 'SAFE' | 'MIXED' | 'NSFW';
  /** Path of the series archive: `series` in `https://site/series/slug`. */
  mangaPath?: string;
  /** Some installs rename the archive listing itself (`/manga/`, `/comics/`). */
  listPath?: string;
  /**
   * `query` — WordPress search on the site root, the theme's own behaviour.
   * `client` — the install has no server-side search: its archive answers `?s=`
   *   with the *whole* catalogue, which reads as "everything matched" and is
   *   worse than an error. Those installs ship the catalogue on one page and
   *   filter it in the browser, so this does the same here, over one request.
   */
  searchMode?: 'query' | 'client';
  usesCloudflare?: boolean;
  minIntervalMs?: number;
}

interface TsReaderChapter {
  sources?: { source?: string; images?: string[] }[];
}

/** `ts_reader.run(` … `);` — the argument is a single JSON object literal. */
function extractTsReader(html: string): string[] {
  const start = html.indexOf('ts_reader.run(');
  if (start < 0) return [];
  const open = html.indexOf('{', start);
  if (open < 0) return [];

  // Brace matching rather than a greedy regex: the JSON contains URLs with
  // braces in query strings often enough that `\{.*\}` grabs the rest of the
  // document, and a lazy match stops at the first nested object.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < html.length; i += 1) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(html.slice(open, i + 1)) as TsReaderChapter;
          // `sources` is a list of mirrors; the first is the one the theme
          // selects by default and the only one guaranteed to be populated.
          return parsed.sources?.[0]?.images ?? [];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

export function createMangaThemesiaSource(config: MangaThemesiaConfig, deps: SourceDeps): Source {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const mangaPath = config.mangaPath ?? 'series';
  const listPath = config.listPath ?? mangaPath;
  const searchMode = config.searchMode ?? 'query';
  const http = deps.http;

  const filters: FilterSpec[] = [
    {
      kind: 'select',
      name: 'Sort by',
      values: ['Default', 'A-Z', 'Z-A', 'Latest Update', 'Latest Added', 'Popular'],
      default: 0,
    },
    { kind: 'select', name: 'Status', values: ['All', 'Ongoing', 'Completed', 'Hiatus'], default: 0 },
    {
      kind: 'select',
      name: 'Type',
      values: ['All', 'Manga', 'Manhwa', 'Manhua', 'Comic'],
      default: 0,
    },
  ];

  const ORDER = ['', 'title', 'titlereverse', 'update', 'latest', 'popular'];
  const STATUS = ['', 'ongoing', 'completed', 'hiatus'];
  const TYPE = ['', 'manga', 'manhwa', 'manhua', 'comic'];

  function parseList(html: string): MangaPage<SourceManga> {
    const $ = load(html);
    const items: SourceManga[] = [];
    $('div.bsx, div.utao div.uta').each((_, element) => {
      const card = $(element);
      const link = card.find('a').first();
      const url = absoluteUrl(baseUrl, link.attr('href'));
      // The card's own `title` attribute is the clean title; the visible text
      // carries the chapter badge ("Chapter 12") glued onto it.
      const title = clean(link.attr('title') ?? card.find('div.tt, .luf h4').first().text());
      if (url === '' || title === '') return;
      const img = card.find('img').first();
      const raw = img.attr('data-src') ?? img.attr('data-lazy-src') ?? img.attr('src');
      items.push({ url, title, thumbnailUrl: raw ? absoluteUrl(baseUrl, raw) : null });
    });
    // `.bsx` sits inside `.bs` on some installs and replaces it on others, so
    // the same title can be matched twice; the series URL is the identity.
    const unique = new Map(items.map((item) => [item.url, item]));
    return {
      items: [...unique.values()],
      hasNextPage: $('a.r, div.pagination a.next, a.next.page-numbers').length > 0,
    };
  }

  function browseUrl(page: number, query: string, changes: FilterChange[]): string {
    const params = new URLSearchParams();
    if (page > 1) params.set('page', String(page));
    for (const change of changes) {
      const spec = filters[change.position];
      if (!spec || spec.kind !== 'select' || !change.selectState) continue;
      if (spec.name === 'Sort by') params.set('order', ORDER[change.selectState] ?? '');
      if (spec.name === 'Status') params.set('status', STATUS[change.selectState] ?? '');
      if (spec.name === 'Type') params.set('type', TYPE[change.selectState] ?? '');
    }
    if (query === '') return `${baseUrl}/${listPath}?${params.toString()}`;
    // Text search is WordPress's own, on the site root. The archive at
    // `/${listPath}` accepts `?s=` too but ignores it and answers with the full
    // catalogue, which is worse than an error: it looks like a search that
    // matched everything.
    params.set('s', query);
    return `${baseUrl}/?${params.toString()}`;
  }

  /** `<div class="imptdt">Status <i>ongoing</i></div>` — matched on the label. */
  function infoRow($: CheerioAPI, label: RegExp): string {
    return clean(
      $('div.tsinfo div.imptdt')
        .filter((_, element) => label.test($(element).text()))
        .first()
        .find('i, a')
        .first()
        .text(),
    );
  }

  return {
    id: config.id,
    name: config.name,
    lang: config.lang,
    baseUrl,
    supportsLatest: true,
    contentWarning: config.contentWarning,

    async getPopular(page) {
      return parseList(await http.text(`${baseUrl}/${listPath}?page=${page}&order=popular`));
    },
    async getLatest(page) {
      return parseList(await http.text(`${baseUrl}/${listPath}?page=${page}&order=update`));
    },
    async search(query, page, changes = []) {
      if (query !== '' && searchMode === 'client') {
        // One request, then filter. The archive is a single page on these
        // installs, so page 2 is always empty rather than a repeat of page 1.
        if (page > 1) return { items: [], hasNextPage: false };
        const all = parseList(await http.text(`${baseUrl}/${listPath}`));
        const needle = query.toLowerCase();
        return {
          items: all.items.filter((item) => item.title.toLowerCase().includes(needle)),
          hasNextPage: false,
        };
      }
      return parseList(await http.text(browseUrl(page, query, changes)));
    },

    getFilters: () => filters,

    async getMangaDetails(manga) {
      const html = await http.text(manga.url);
      const $ = load(html);
      const cover = $('div.thumb img, div.thumbook img').first();

      // Some installs (RizzFables) moved the synopsis into a `var description`
      // string and render it client-side, leaving the container holding only
      // that script — hence dropping scripts before reading the container, or
      // the "description" would be a line of JavaScript.
      // Read the raw document, not the DOM: the fallback below removes the very
      // script the synopsis is hiding in.
      const inlineDescription = /var\s+description\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(html)?.[1];
      const container = $('div.entry-content[itemprop=description], div.entry-content').first();
      container.find('script, style').remove();
      let description = clean(container.text());
      if (description === '' && inlineDescription) {
        try {
          description = clean(JSON.parse(`"${inlineDescription}"`) as string);
        } catch {
          // A synopsis with an unescaped quote is not worth failing the page for.
        }
      }

      return {
        url: manga.url,
        title: clean($('h1.entry-title').first().text()),
        thumbnailUrl: absoluteUrl(baseUrl, cover.attr('data-src') ?? cover.attr('src')) || null,
        author: infoRow($, /author|pengarang/i) || null,
        artist: infoRow($, /artist/i) || null,
        description: description || null,
        genre: $('span.mgen a, div.seriestugenre a')
          .map((_, element) => clean($(element).text()))
          .get()
          .filter((value) => value !== ''),
        status: parseStatus(infoRow($, /status/i)),
        realUrl: manga.url,
        initialized: true,
      };
    },

    async getChapterList(manga) {
      const $ = load(await http.text(manga.url));
      const chapters: SourceChapter[] = [];
      $('#chapterlist li, div.eplister li').each((_, element) => {
        const row = $(element);
        const link = row.find('a').first();
        const url = absoluteUrl(baseUrl, link.attr('href'));
        const name = clean(row.find('span.chapternum').text() || link.text());
        if (url === '' || name === '') return;
        // `data-num` is the theme's own numbering and beats parsing the label,
        // which is localised on non-English installs.
        const declared = Number.parseFloat(row.attr('data-num') ?? '');
        chapters.push({
          url,
          name,
          chapterNumber: Number.isFinite(declared) ? declared : parseChapterNumber(name),
          dateUpload: parseDate(row.find('span.chapterdate').text()),
          realUrl: url,
        });
      });
      const deduped = dedupeChapters(chapters);
      if (deduped.length === 0) throw new NoResultsError();
      return deduped;
    },

    async getPageList(chapter) {
      const html = await http.text(chapter.url);
      const fromReader = extractTsReader(html);
      if (fromReader.length > 0) {
        return fromReader.map((url, index) => ({ index, url: absoluteUrl(baseUrl, url) }));
      }

      const $ = load(html);
      const pages: SourcePage[] = [];
      $('div#readerarea img, div.rdminimal img, div.chapterbody img').each((_, element) => {
        const img = $(element);
        const raw = img.attr('data-src') ?? img.attr('data-lazy-src') ?? img.attr('src');
        if (!raw || raw.startsWith('data:')) return;
        const url = absoluteUrl(baseUrl, raw);
        // Avatars, logos and ad creatives sit in the same container on the
        // patched installs; page images always live under an uploads path.
        if (url === '' || /\/(assets|static|themes|avatar|logo)\//i.test(url)) return;
        pages.push({ index: pages.length, url });
      });
      if (pages.length === 0) throw new NoResultsError('No pages found');
      return pages;
    },

    imageHeaders: () => ({ Referer: `${baseUrl}/` }),
  };
}
