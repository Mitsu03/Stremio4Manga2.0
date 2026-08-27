/**
 * ComicK — a JSON API, half of which sits behind a Cloudflare managed challenge.
 *
 * Verified against the live host while this was written: `/v1.0/search` and
 * `/top` answer a plain request, while `/comic/*` and `/chapter/*` return
 * `cf-mitigated: challenge`. That split is why browsing works with no solver
 * configured and opening a title does not — the shared client turns the
 * challenge into `CloudflareBlockedError`, so the UI says what to configure
 * instead of showing an empty chapter list.
 *
 * The domain has moved twice (comick.fun → comick.io → comick.dev) while the
 * paths stayed identical; only the constants below change when it moves again.
 */
import type {
  FilterChange,
  FilterSpec,
  MangaPage,
  MangaStatus,
  Source,
  SourceChapter,
  SourceDeps,
  SourceDefinition,
  SourceManga,
} from '../types.js';
import { NoResultsError } from '../types.js';
import { parseChapterNumber } from '../util.js';

const API = 'https://api.comick.dev';
const SITE = 'https://comick.io';
const IMAGES = 'https://meo.comick.pictures';
const PAGE_SIZE = 30;

interface Cover {
  b2key?: string | null;
}

interface SearchItem {
  hid: string;
  slug: string;
  title: string;
  desc?: string | null;
  status?: number | null;
  content_rating?: string | null;
  md_covers?: Cover[];
}

interface ComicDetail {
  comic: {
    hid: string;
    slug: string;
    title: string;
    desc?: string | null;
    status?: number | null;
    country?: string | null;
    md_covers?: Cover[];
    md_comic_md_genres?: { md_genres?: { name?: string } }[];
  };
  authors?: { name: string }[];
  artists?: { name: string }[];
}

interface ChapterItem {
  hid: string;
  chap?: string | null;
  vol?: string | null;
  title?: string | null;
  lang?: string | null;
  created_at?: string | null;
  group_name?: string[] | null;
}

interface ChapterPage {
  chapter: { hid: string; md_images?: { b2key?: string | null }[] };
}

/** ComicK's numeric status, which is not the same order as anyone else's. */
const STATUS_MAP: Record<number, MangaStatus> = {
  1: 'ONGOING',
  2: 'COMPLETED',
  3: 'CANCELLED',
  4: 'ON_HIATUS',
};

const cover = (covers: Cover[] | undefined): string | null => {
  const key = covers?.find((candidate) => candidate.b2key)?.b2key;
  return key ? `${IMAGES}/${key}` : null;
};

function build(deps: SourceDeps): Source {
  const lang = 'en';
  const http = deps.http;

  const filters: FilterSpec[] = [
    {
      kind: 'select',
      name: 'Sort by',
      values: ['Most follows', 'Most views', 'Highest rating', 'Recently uploaded'],
      default: 0,
    },
    {
      kind: 'select',
      name: 'Type',
      values: ['All', 'Manga', 'Manhwa', 'Manhua'],
      default: 0,
    },
    { kind: 'checkbox', name: 'Include mature content', default: false },
  ];

  const SORTS = ['follow', 'view', 'rating', 'uploaded'];
  const TYPES = ['', 'jp', 'kr', 'cn'];

  function searchUrl(query: string, page: number, changes: FilterChange[]): string {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(PAGE_SIZE));
    params.set('tachiyomi', 'true');
    if (query) params.set('q', query);

    let sort = query ? '' : 'follow';
    let mature = false;
    for (const change of changes) {
      const spec = filters[change.position];
      if (!spec) continue;
      if (spec.kind === 'select' && spec.name === 'Sort by' && change.selectState !== undefined) {
        sort = SORTS[change.selectState] ?? 'follow';
      }
      if (spec.kind === 'select' && spec.name === 'Type' && change.selectState) {
        params.set('country', TYPES[change.selectState] ?? '');
      }
      if (spec.kind === 'checkbox' && spec.name === 'Include mature content') {
        mature = change.checkBoxState === true;
      }
    }
    if (sort) params.set('sort', sort);
    // Without this the API answers with everything, adult titles included, and
    // the client has no per-source rating filter of its own to hide them.
    params.set('accept_mature_content', String(mature));
    return `${API}/v1.0/search?${params.toString()}`;
  }

  async function list(url: string): Promise<MangaPage<SourceManga>> {
    const items = await http.json<SearchItem[]>(url);
    return {
      items: items.map((item) => ({
        url: `/comic/${item.slug}`,
        title: item.title,
        thumbnailUrl: cover(item.md_covers),
      })),
      // The API reports no total; a short page is the only end-of-list signal.
      hasNextPage: items.length >= PAGE_SIZE,
    };
  }

  return {
    id: '1000000000000000002',
    name: 'ComicK',
    lang,
    baseUrl: SITE,
    supportsLatest: true,
    contentWarning: 'MIXED',

    getPopular: (page) => list(searchUrl('', page, [])),
    getLatest: (page) =>
      list(
        `${API}/v1.0/search?page=${page}&limit=${PAGE_SIZE}&sort=uploaded&accept_mature_content=false`,
      ),
    search: (query, page, changes = []) => list(searchUrl(query, page, changes)),

    getFilters: () => filters,

    async getMangaDetails(manga) {
      const slug = manga.url.replace(/^\/comic\//, '');
      const body = await http.json<ComicDetail>(`${API}/comic/${slug}/`);
      const comic = body.comic;
      return {
        url: `/comic/${comic.slug}`,
        title: comic.title,
        thumbnailUrl: cover(comic.md_covers),
        author: body.authors?.map((author) => author.name).join(', ') || null,
        artist: body.artists?.map((artist) => artist.name).join(', ') || null,
        description: comic.desc ?? null,
        genre:
          comic.md_comic_md_genres
            ?.map((entry) => entry.md_genres?.name)
            .filter((name): name is string => Boolean(name)) ?? [],
        status: STATUS_MAP[comic.status ?? 0] ?? 'UNKNOWN',
        realUrl: `${SITE}/comic/${comic.slug}`,
        initialized: true,
      };
    },

    async getChapterList(manga) {
      const slug = manga.url.replace(/^\/comic\//, '');
      // Chapters key on the comic's hid, not its slug, and only the detail call
      // knows the hid — the extra request is unavoidable.
      const detail = await http.json<ComicDetail>(`${API}/comic/${slug}/`);
      const hid = detail.comic.hid;
      const chapters: SourceChapter[] = [];

      for (let page = 1; page <= 50; page += 1) {
        const body = await http.json<{ chapters: ChapterItem[]; total?: number }>(
          `${API}/comic/${hid}/chapters?lang=${lang}&page=${page}&limit=100`,
        );
        if (body.chapters.length === 0) break;
        for (const item of body.chapters) {
          const label = item.chap ? `Chapter ${item.chap}` : (item.title ?? 'Oneshot');
          chapters.push({
            url: `/chapter/${item.hid}`,
            name: item.title && item.chap ? `${label} - ${item.title}` : label,
            chapterNumber: item.chap ? Number.parseFloat(item.chap) : parseChapterNumber(label),
            scanlator: item.group_name?.join(', ') || null,
            dateUpload: item.created_at ? (Date.parse(item.created_at) || 0) : 0,
            realUrl: `${SITE}/comic/${slug}/${item.hid}`,
          });
        }
        if (body.total !== undefined && chapters.length >= body.total) break;
        if (body.chapters.length < 100) break;
      }

      if (chapters.length === 0) throw new NoResultsError();
      return chapters;
    },

    async getPageList(chapter) {
      const hid = chapter.url.replace(/^\/chapter\//, '');
      const body = await http.json<ChapterPage>(`${API}/chapter/${hid}/`);
      const pages = (body.chapter.md_images ?? [])
        .map((image) => image.b2key)
        .filter((key): key is string => Boolean(key))
        .map((key, index) => ({ index, url: `${IMAGES}/${key}` }));
      if (pages.length === 0) throw new NoResultsError('No pages found');
      return pages;
    },

    imageHeaders: () => ({ Referer: `${SITE}/` }),
  };
}

export const definition: SourceDefinition = {
  pkgName: 'comick',
  name: 'ComicK',
  lang: 'en',
  id: '1000000000000000002',
  contentWarning: 'MIXED',
  // Only /comic and /chapter are challenged, but the flag is per source and the
  // parts that matter for reading are exactly the challenged ones.
  usesCloudflare: true,
  versionName: '1.0.0',
  build,
};
