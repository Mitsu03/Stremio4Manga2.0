/**
 * "MangaHub", eleven front ends over one GraphQL API.
 *
 * The sites are skins. mangahub.io, mangakakalot.fun and nine others all ask
 * `api.mghcdn.com` the same questions and differ by a single enum — `m01`,
 * `mh01` — which is the whole of what `config.mangaSource` carries. Images come
 * off two more CDNs, and none of the four hosts is the site the reader visited.
 *
 * That split is the awkward part. The API refuses anything without an
 * `x-mhub-access` header, and the only place that value exists is an
 * `mhub_access` cookie the *site* sets when a chapter page is opened — a
 * different host, so the shared jar would never send it there. So the flow is:
 * open a chapter page to be given a key, read the key out of the jar, and put it
 * on the API request by hand. `SourceHttp.cookie` exists for this.
 *
 * Keys expire, and the API says so in a GraphQL error rather than in a status
 * code. Every call therefore goes through `ask`, which on an error mentioning
 * the key or a rate limit fetches a fresh one once and retries. Retrying more
 * than once is how an address gets itself banned here.
 */
import type {
  FilterChange,
  FilterSpec,
  MangaPage,
  MangaStatus,
  Source,
  SourceChapter,
  SourceDeps,
  SourceManga,
} from '../types.js';
import { NoResultsError } from '../types.js';
import { clean } from '../util.js';

export interface MangaHubConfig {
  id: string;
  name: string;
  lang: string;
  baseUrl: string;
  contentWarning: 'SAFE' | 'MIXED' | 'NSFW';
  /**
   * Which catalogue this front end serves, as the API's own enum: `m01` for
   * mangahub.io, `mh01` for onemanga.info, and so on. Required — the query is
   * malformed without it, and every extension upstream declares one.
   */
  mangaSource?: string;
  /** The GraphQL endpoint, if it ever moves off `api.mghcdn.com`. */
  apiUrl?: string;
}

interface GraphQLAnswer<T> {
  data?: T;
  errors?: { message?: string }[];
}

interface SearchRow {
  title: string;
  slug: string;
  image?: string | null;
}

interface ApiManga {
  title?: string | null;
  slug?: string | null;
  status?: string | null;
  image?: string | null;
  author?: string | null;
  artist?: string | null;
  genres?: string | null;
  description?: string | null;
  alternativeTitle?: string | null;
  chapters?: { number: number; title: string; date: string }[] | null;
}

const API_URL = 'https://api.mghcdn.com/graphql';
const IMAGE_CDN = 'https://imgx.mghcdn.com';
const THUMB_CDN = 'https://thumb.mghcdn.com';

/** The API's `mod` values, in the order the filter lists them. */
const ORDER = ['POPULAR', 'LATEST', 'ALPHABET', 'NEW', 'COMPLETED'];

/** A string going into a GraphQL literal, which is JSON's own escaping. */
const quote = (value: string): string => JSON.stringify(value).slice(1, -1);

/** `/manga/slug` or a full URL → `slug`. */
function slugOf(url: string): string {
  const path = url.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return path.slice(path.lastIndexOf('/') + 1);
}

export function createMangaHubSource(config: MangaHubConfig, deps: SourceDeps): Source {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const apiUrl = config.apiUrl ?? API_URL;
  const http = deps.http;
  // No sensible default exists: `x: ` with nothing after it is a syntax error at
  // the API, so a row that lost this field fails loudly on the first request
  // rather than returning an empty catalogue that looks like a dead site.
  const catalogue = config.mangaSource ?? '';

  const filters: FilterSpec[] = [
    {
      kind: 'select',
      name: 'Order',
      values: ['Popular', 'Updates', 'A-Z', 'New', 'Completed'],
      default: 0,
    },
  ];

  /**
   * Open a chapter page so the site hands out a fresh `mhub_access`.
   *
   * Upstream picks a random chapter of a series every install carries. The page
   * itself is thrown away — only the `Set-Cookie` it comes with matters — and it
   * is a chapter rather than the home page because that is where the key is
   * issued.
   */
  async function refreshKey(): Promise<void> {
    const url = `${baseUrl}/chapter/martial-peak/chapter-${1000 + Math.floor(Math.random() * 2000)}`;
    try {
      await http.text(url);
    } catch {
      // A 404 still carries the cookie, and `text` throws on one.
    }
  }

  const STALE = /rate\s*limit|api\s*key/i;
  const NO_KEY = 'no mhub_access cookie';

  /** One GraphQL query, with one key refresh if the API says the key is stale. */
  async function ask<T>(query: string): Promise<T> {
    if (catalogue === '') {
      throw new Error(`${config.name} has no mangaSource set; its catalogue cannot be queried`);
    }

    const send = async (): Promise<GraphQLAnswer<T>> => {
      const key = http.cookie(baseUrl, 'mhub_access');
      if (key === undefined || key === '') throw new Error(NO_KEY);
      return http.json<GraphQLAnswer<T>>(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-mhub-access': key,
          Referer: `${baseUrl}/`,
        },
        body: JSON.stringify({ query }),
      });
    };

    const unwrap = (answer: GraphQLAnswer<T>): T => {
      const failure = answer.errors?.[0]?.message;
      if (failure !== undefined && failure !== '') throw new Error(failure);
      if (answer.data === undefined) throw new NoResultsError('The API answered with no data');
      return answer.data;
    };

    try {
      return unwrap(await send());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Anything else is a real failure, and retrying it only doubles the load.
      if (!STALE.test(message) && message !== NO_KEY) throw error;
      await refreshKey();
      return unwrap(await send());
    }
  }

  function toManga(row: SearchRow): SourceManga {
    return {
      url: `${baseUrl}/manga/${row.slug}`,
      title: clean(row.title),
      thumbnailUrl: row.image ? `${THUMB_CDN}/${row.image}` : null,
    };
  }

  async function list(page: number, query: string, order: string): Promise<MangaPage<SourceManga>> {
    const offset = (page - 1) * 30;
    const data = await ask<{ search?: { rows?: SearchRow[] } }>(
      `{ search(x: ${catalogue}, q: "${quote(query)}", genre: "all", mod: ${order}, offset: ${offset}) { rows { title, slug, image } } }`,
    );
    const rows = data.search?.rows ?? [];
    // The API pages at thirty and publishes no total, so a full page is the only
    // evidence there is another one.
    return { items: rows.map(toManga), hasNextPage: rows.length === 30 };
  }

  function orderFrom(changes: FilterChange[]): string {
    for (const change of changes) {
      const spec = filters[change.position];
      if (spec?.kind === 'select' && spec.name === 'Order') {
        return ORDER[change.selectState ?? 0] ?? ORDER[0];
      }
    }
    return ORDER[0];
  }

  async function details(slug: string): Promise<ApiManga> {
    const data = await ask<{ manga?: ApiManga | null }>(
      `{ manga(x: ${catalogue}, slug: "${quote(slug)}") { title, slug, status, image, author, artist, genres, description, alternativeTitle, chapters { number, title, date } } }`,
    );
    const manga = data.manga;
    if (!manga) throw new NoResultsError(`No series at ${slug}`);
    return manga;
  }

  return {
    id: config.id,
    name: config.name,
    lang: config.lang,
    baseUrl,
    supportsLatest: true,
    contentWarning: config.contentWarning,

    getPopular: (page) => list(page, '', 'POPULAR'),
    getLatest: (page) => list(page, '', 'LATEST'),
    search: (query, page, changes = []) => list(page, query, orderFrom(changes)),

    getFilters: () => filters,

    async getMangaDetails(manga) {
      const slug = slugOf(manga.url);
      const data = await details(slug);

      const alternatives = (data.alternativeTitle ?? '')
        .split(';')
        .map((one) => clean(one))
        .filter((one) => one !== '');
      const description = [
        clean(data.description ?? ''),
        alternatives.length === 0
          ? ''
          : `Alternative Names:\n${alternatives.map((one) => `- ${one}`).join('\n')}`,
      ]
        .filter((part) => part !== '')
        .join('\n\n');

      const status: MangaStatus =
        data.status === 'ongoing'
          ? 'ONGOING'
          : data.status === 'completed'
            ? 'COMPLETED'
            : 'UNKNOWN';

      return {
        url: manga.url,
        title: clean(data.title ?? ''),
        thumbnailUrl: data.image ? `${THUMB_CDN}/${data.image}` : null,
        author: clean(data.author ?? '') || null,
        artist: clean(data.artist ?? '') || null,
        description: description || null,
        // One comma-separated string, which is how the API stores it.
        genre: (data.genres ?? '')
          .split(',')
          .map((one) => clean(one))
          .filter((one) => one !== ''),
        status,
        realUrl: manga.url,
        initialized: true,
      };
    },

    async getChapterList(manga) {
      const slug = slugOf(manga.url);
      const data = await details(slug);
      const chapters = data.chapters ?? [];
      if (chapters.length === 0) throw new NoResultsError();

      // The API lists oldest first; everything downstream here assumes newest.
      return chapters
        .map((chapter): SourceChapter => {
          const number = String(chapter.number).replace(/\.0$/, '');
          const title = clean(chapter.title);
          // The title already contains the number often enough that prefixing it
          // unconditionally produces "Chapter 12 - Chapter 12".
          const name =
            title === ''
              ? `Chapter ${number}`
              : title.includes(number)
                ? title
                : `Chapter ${number} - ${title}`;
          const url = `${baseUrl}/chapter/${slug}/chapter-${String(chapter.number)}`;
          return {
            url,
            name,
            chapterNumber: Number.isFinite(chapter.number) ? chapter.number : -1,
            dateUpload: chapter.date ? Date.parse(chapter.date) || 0 : 0,
            realUrl: url,
          };
        })
        .reverse();
    },

    async getPageList(chapter) {
      // `…/chapter/<series>/chapter-<number>` — both halves are needed, and the
      // number is a float on the sites that publish half chapters.
      const path = chapter.url.replace(/[?#].*$/, '').replace(/\/+$/, '');
      const parts = path.split('/');
      const number = Number.parseFloat((parts.at(-1) ?? '').replace(/^chapter-/, ''));
      const slug = parts.at(-2) ?? '';
      if (slug === '' || !Number.isFinite(number)) throw new NoResultsError('No pages found');

      const data = await ask<{ chapter?: { pages?: string } | null }>(
        `{ chapter(x: ${catalogue}, slug: "${quote(slug)}", number: ${number}) { pages, mangaID, number } }`,
      );
      // `pages` is a JSON *string* inside the JSON answer: a path prefix and the
      // filenames under it, which is why it is parsed a second time here.
      const raw = data.chapter?.pages;
      if (raw === undefined || raw === '') throw new NoResultsError('No pages found');

      let parsed: { p?: string; i?: string[] };
      try {
        parsed = JSON.parse(raw) as { p?: string; i?: string[] };
      } catch {
        throw new NoResultsError('No pages found');
      }
      const images = parsed.i ?? [];
      if (images.length === 0) throw new NoResultsError('No pages found');
      return images.map((image, index) => ({
        index,
        url: `${IMAGE_CDN}/${parsed.p ?? ''}${image}`,
      }));
    },

    imageHeaders: () => ({ Referer: `${baseUrl}/` }),
  };
}
