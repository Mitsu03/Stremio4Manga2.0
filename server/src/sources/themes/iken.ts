/**
 * "Iken", the one themed engine here that is not a scraper.
 *
 * Iken sites are a Next.js front end over a JSON API on a sibling host: the site
 * at `https://example.org` answers questions at `https://api.example.org/api/…`.
 * Nothing is parsed out of markup, which makes this the sturdiest of the themed
 * engines — a skin change costs nothing — and the most brittle in one specific
 * way, since the API is versioned by nobody and a renamed field is silent.
 *
 * Two things about the shape are worth knowing before reading further:
 *
 * - **An id is not derivable from a slug.** Chapters are fetched by numeric id
 *   and series by slug, and the listing hands back both. So the ids ride in the
 *   URL fragment — `…/series/slug#123` — which keeps `SourceManga.url` a real
 *   page a human can open while still carrying what the API needs. A fragment is
 *   never sent to a server, so this costs nothing on the wire.
 * - **Locked chapters are listed, not hidden.** The API returns paid and
 *   time-gated chapters with a flag. Upstream hides them behind a preference;
 *   here they are dropped, because a chapter that appears in the list and then
 *   fails to open reads as a broken source rather than as a paywall.
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
  SourcePage,
} from '../types.js';
import { NoResultsError } from '../types.js';
import { clean } from '../util.js';

export interface IkenConfig {
  id: string;
  name: string;
  lang: string;
  baseUrl: string;
  contentWarning: 'SAFE' | 'MIXED' | 'NSFW';
  /** Where the API lives, when it is not `api.` in front of the site's host. */
  apiUrl?: string;
  /** Rows per listing request; a few installs raise the theme's 18. */
  perPage?: number;
  /**
   * Order pages by the number in their filename rather than by the `order`
   * field. Two installs upload with `order` unset on every image, where sorting
   * on it silently keeps whatever order the API happened to return.
   */
  sortPagesByFilename?: boolean;
}

interface IkenGenre {
  id: number;
  name: string;
}

interface IkenChapter {
  id: number;
  slug: string;
  number: number | string;
  title?: string | null;
  createdAt?: string | null;
  isLocked?: boolean;
  isTimeLocked?: boolean;
  price?: number;
  chapterPurchased?: boolean;
  createdBy?: { name?: string | null } | null;
}

interface IkenManga {
  id: number;
  slug: string;
  postTitle: string;
  postContent?: string | null;
  isNovel?: boolean;
  featuredImage?: string | null;
  alternativeTitles?: string | null;
  author?: string | null;
  artist?: string | null;
  seriesType?: string | null;
  seriesStatus?: string | null;
  genres?: IkenGenre[];
  chapters?: IkenChapter[];
}

interface IkenSearchResponse {
  posts?: IkenManga[];
  totalCount?: number;
}

interface IkenPostResponse {
  totalChapterCount?: number | null;
  post: IkenManga;
}

interface IkenChaptersResponse {
  post?: { chapters?: IkenChapter[] };
}

interface IkenPageResponse {
  chapter?: {
    images?: { url: string; order?: number | null }[];
    isPermanentlyLocked?: boolean;
    isLockedByCoins?: boolean;
    isShortLinkLocked?: boolean;
  };
}

const STATUS: Record<string, MangaStatus> = {
  ONGOING: 'ONGOING',
  COMING_SOON: 'ONGOING',
  MASS_RELEASED: 'ONGOING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  DROPPED: 'CANCELLED',
};

const TYPE_NAMES: Record<string, string> = {
  MANGA: 'Manga',
  MANHUA: 'Manhua',
  MANHWA: 'Manhwa',
};

/** `…/series/slug#123` → `{ slug, id }`. The id is absent on a hand-typed URL. */
function splitRef(url: string): { slug: string; id: string } {
  const hash = url.lastIndexOf('#');
  const withoutHash = hash === -1 ? url : url.slice(0, hash);
  const id = hash === -1 ? '' : url.slice(hash + 1);
  const path = withoutHash.replace(/\/+$/, '');
  return { slug: path.slice(path.lastIndexOf('/') + 1), id };
}

/** HTML in a JSON field: the synopsis arrives as markup often enough to matter. */
function stripTags(html: string): string {
  return clean(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' '));
}

export function createIkenSource(config: IkenConfig, deps: SourceDeps): Source {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  // The theme's own rule, and right for every install upstream: the API is the
  // site's host with `api.` in front of it.
  const apiUrl = (config.apiUrl ?? baseUrl.replace(/^https:\/\//, 'https://api.')).replace(
    /\/+$/,
    '',
  );
  const perPage = config.perPage ?? 18;
  const http = deps.http;

  const filters: FilterSpec[] = [
    {
      kind: 'select',
      name: 'Status',
      values: [
        'All',
        'Ongoing',
        'Completed',
        'Cancelled',
        'Dropped',
        'Coming soon',
        'Mass release',
      ],
      default: 0,
    },
    {
      kind: 'select',
      name: 'Type',
      values: ['All', 'Manga', 'Manhua', 'Manhwa', 'Russian', 'Spanish'],
      default: 0,
    },
    {
      kind: 'select',
      name: 'Sort by',
      values: ['Last chapter', 'Views', 'Date added', 'Chapter count', 'A-Z'],
      default: 0,
    },
    { kind: 'select', name: 'Order', values: ['Descending', 'Ascending'], default: 0 },
  ];

  // Upstream fetches the genre list from `/api/genres` and adds it as a filter
  // group. `getFilters` here is synchronous by contract, so the genres are left
  // out rather than fetched on a timer nobody asked for — the four selects above
  // are the whole of what the API otherwise sorts and filters on.
  const STATUS_VALUES = [
    '',
    'ONGOING',
    'COMPLETED',
    'CANCELLED',
    'DROPPED',
    'COMING_SOON',
    'MASS_RELEASED',
  ];
  const TYPE_VALUES = ['', 'MANGA', 'MANHUA', 'MANHWA', 'RUSSIAN', 'SPANISH'];
  const SORT_VALUES = [
    'lastChapterAddedAt',
    'totalViews',
    'createdAt',
    'chaptersCount',
    'postTitle',
  ];
  const DIRECTION_VALUES = ['desc', 'asc'];

  function toManga(post: IkenManga): SourceManga {
    const genre = [
      ...(post.seriesType && TYPE_NAMES[post.seriesType] ? [TYPE_NAMES[post.seriesType]] : []),
      ...(post.genres ?? []).map((one) => clean(one.name)),
    ].filter((one, index, all) => one !== '' && all.indexOf(one) === index);

    const synopsis = stripTags(post.postContent ?? '');
    const alternatives = clean(post.alternativeTitles ?? '');
    const description = [synopsis, alternatives && `Alternative Names: ${alternatives}`]
      .filter((part) => part !== '')
      .join('\n\n');

    return {
      url: `${baseUrl}/series/${post.slug}#${post.id}`,
      title: clean(post.postTitle),
      thumbnailUrl: post.featuredImage || null,
      author: clean(post.author ?? '') || null,
      artist: clean(post.artist ?? '') || null,
      description: description || null,
      genre,
      status: STATUS[post.seriesStatus ?? ''] ?? 'UNKNOWN',
      realUrl: `${baseUrl}/series/${post.slug}`,
    };
  }

  async function query(
    page: number,
    search: string,
    changes: FilterChange[],
  ): Promise<MangaPage<SourceManga>> {
    const params = new URLSearchParams({
      page: String(page),
      perPage: String(perPage),
      searchTerm: search.trim(),
    });
    // Popular and latest are this same request with a different `orderBy`, which
    // is why both go through here rather than having endpoints of their own.
    for (const change of changes) {
      const spec = filters[change.position];
      const chosen = change.selectState ?? 0;
      if (!spec || spec.kind !== 'select') continue;
      if (spec.name === 'Status' && STATUS_VALUES[chosen]) {
        params.set('seriesStatus', STATUS_VALUES[chosen]);
      }
      if (spec.name === 'Type' && TYPE_VALUES[chosen]) {
        params.set('seriesType', TYPE_VALUES[chosen]);
      }
      if (spec.name === 'Sort by') params.set('orderBy', SORT_VALUES[chosen] ?? SORT_VALUES[0]);
      if (spec.name === 'Order') {
        params.set('orderDirection', DIRECTION_VALUES[chosen] ?? DIRECTION_VALUES[0]);
      }
    }
    if (!params.has('orderBy')) params.set('orderBy', SORT_VALUES[0]);

    const data = await http.json<IkenSearchResponse>(`${apiUrl}/api/query?${params.toString()}`);
    const posts = data.posts ?? [];
    return {
      // Iken hosts novels alongside comics on the same API. They have no page
      // images at all, so listing one offers a title that cannot be opened.
      items: posts.filter((post) => post.isNovel !== true).map(toManga),
      hasNextPage: (data.totalCount ?? 0) > page * perPage,
    };
  }

  function isLocked(chapter: IkenChapter): boolean {
    return (
      chapter.isLocked === true ||
      chapter.isTimeLocked === true ||
      (chapter.chapterPurchased === false && (chapter.price ?? 0) !== 0)
    );
  }

  function toChapter(chapter: IkenChapter, seriesSlug: string): SourceChapter {
    const number = Number.parseFloat(String(chapter.number));
    const title = clean(chapter.title ?? '');
    return {
      url: `${baseUrl}/series/${seriesSlug}/${chapter.slug}#${chapter.id}`,
      name: `Chapter ${String(chapter.number)}${title === '' ? '' : ` - ${title}`}`,
      chapterNumber: Number.isFinite(number) ? number : -1,
      scanlator: clean(chapter.createdBy?.name ?? '') || null,
      dateUpload: chapter.createdAt ? Date.parse(chapter.createdAt) || 0 : 0,
      realUrl: `${baseUrl}/series/${seriesSlug}/${chapter.slug}`,
    };
  }

  return {
    id: config.id,
    name: config.name,
    lang: config.lang,
    baseUrl,
    supportsLatest: true,
    contentWarning: config.contentWarning,

    // Position 2 is "Sort by"; state 1 is "Views", which is what this theme
    // means by popular.
    getPopular: (page) => query(page, '', [{ position: 2, selectState: 1 }]),
    getLatest: (page) => query(page, '', []),
    search: (search, page, changes = []) => query(page, search, changes),

    getFilters: () => filters,

    async getMangaDetails(manga) {
      const { slug } = splitRef(manga.url);
      const data = await http.json<IkenPostResponse>(
        `${apiUrl}/api/post?postSlug=${encodeURIComponent(slug)}`,
      );
      return { ...toManga(data.post), initialized: true };
    },

    async getChapterList(manga) {
      const { slug, id } = splitRef(manga.url);
      const data = await http.json<IkenPostResponse>(
        `${apiUrl}/api/post?postSlug=${encodeURIComponent(slug)}`,
      );
      let chapters = data.post.chapters ?? [];

      // `/api/post` embeds only a first slice of the chapter list on the larger
      // series, and says so by publishing a `totalChapterCount` bigger than what
      // it embedded. The dedicated endpoint has the rest, and needs the numeric
      // id — which is why the id rides in the URL fragment.
      const total = data.totalChapterCount ?? 0;
      const postId = id || String(data.post.id);
      if (total > chapters.length && postId !== '') {
        try {
          const rest = await http.json<IkenChaptersResponse>(
            `${apiUrl}/api/chapters?postId=${encodeURIComponent(postId)}`,
          );
          const full = rest.post?.chapters ?? [];
          // Only take it if it really is more: an install without the endpoint
          // answers with an empty list rather than with an error.
          if (full.length > chapters.length) chapters = full;
        } catch {
          // The embedded slice is a worse answer than the full list and a much
          // better one than none.
        }
      }

      const visible = chapters
        .filter((chapter) => !isLocked(chapter))
        .map((chapter) => toChapter(chapter, data.post.slug || slug))
        .reverse();
      if (visible.length === 0) throw new NoResultsError();
      return visible;
    },

    async getPageList(chapter) {
      const { id } = splitRef(chapter.url);
      if (id === '') throw new NoResultsError('No pages found');
      const data = await http.json<IkenPageResponse>(
        `${apiUrl}/api/chapter?chapterId=${encodeURIComponent(id)}`,
      );
      const page = data.chapter;
      if (!page) throw new NoResultsError('No pages found');
      if (page.isShortLinkLocked === true) throw new NoResultsError('Chapter locked (short link)');
      if (page.isLockedByCoins === true) throw new NoResultsError('Chapter locked (coins required)');
      if (page.isPermanentlyLocked === true) throw new NoResultsError('Chapter permanently locked');

      const images = [...(page.images ?? [])];
      if (config.sortPagesByFilename) {
        // The filename is the only ordering these installs publish: `order` is
        // present but unset on every image, and sorting on it leaves whatever
        // order the API happened to answer with.
        const numberOf = (url: string): number => {
          const name = url.slice(url.lastIndexOf('/') + 1);
          const found = /\d+/.exec(name);
          return found ? Number(found[0]) : Number.MAX_SAFE_INTEGER;
        };
        images.sort((a, b) => numberOf(a.url) - numberOf(b.url));
      } else {
        images.sort(
          (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER),
        );
      }

      const pages: SourcePage[] = images
        .filter((image) => typeof image.url === 'string' && image.url !== '')
        // Spaces in an image path are common here and the API does not escape them.
        .map((image, index) => ({ index, url: image.url.replaceAll(' ', '%20') }));
      if (pages.length === 0) throw new NoResultsError('No pages found');
      return pages;
    },

    imageHeaders: () => ({ Referer: `${baseUrl}/` }),
  };
}
