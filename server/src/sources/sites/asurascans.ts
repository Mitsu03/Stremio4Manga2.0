/**
 * Asura Scans.
 *
 * Every Tachiyomi-lineage extension still calls this a MangaThemesia site. It is
 * not, and has not been for a while: asuracomic.net is an Astro app whose data
 * comes from `api.asurascans.com`, and the HTML it serves is islands of
 * pre-serialised props, not a WordPress theme. Scraping it as MangaThemesia
 * would return nothing at all — silently — so this talks to the API the site
 * itself uses, which was mapped against the live host:
 *
 *   GET /api/series?offset=&search=        → { data: [...], meta: { total, has_more } }
 *   GET /api/series/{slug}                 → { series: {...} }
 *   GET /api/series/{slug}/chapters        → { data: [...] }
 *   GET /api/series/{slug}/chapters/{slug} → { data: { chapter: { pages } } }
 *
 * The site sits behind Cloudflare, so `usesCloudflare` stays set even though the
 * API host answered plain requests while this was written — the flag costs
 * nothing until a challenge actually arrives.
 */
import type {
  FilterSpec,
  MangaPage,
  Source,
  SourceDeps,
  SourceDefinition,
  SourceManga,
} from '../types.js';
import { NoResultsError } from '../types.js';
import { parseStatus } from '../util.js';

const API = 'https://api.asurascans.com/api';
/**
 * What one request off `/api/series` answers with, and the step between pages.
 *
 * The endpoint reports `per_page: 20` and holds to it. It is a constant here
 * rather than read back off the answer because the offset has to be known
 * before the request that would report it.
 */
const PAGE_SIZE = 20;
const SITE = 'https://asuracomic.net';

interface SeriesSummary {
  id: number;
  slug: string;
  title: string;
  cover?: string | null;
  cover_url?: string | null;
  description?: string | null;
  status?: string | null;
  type?: string | null;
  author?: string | null;
  artist?: string | null;
  genres?: { name: string }[];
  public_url?: string | null;
}

interface SeriesList {
  data: SeriesSummary[] | null;
  meta?: { total: number; per_page: number; has_more: boolean };
}

interface ChapterSummary {
  id: number;
  number: number;
  title?: string | null;
  slug: string;
  published_at?: string | null;
  is_premium?: boolean;
}

const toManga = (series: SeriesSummary): SourceManga => ({
  url: `/series/${series.slug}`,
  title: series.title,
  thumbnailUrl: series.cover ?? series.cover_url ?? null,
});

function build(deps: SourceDeps): Source {
  const http = deps.http;

  const filters: FilterSpec[] = [
    {
      kind: 'select',
      name: 'Status',
      values: ['All', 'Ongoing', 'Hiatus', 'Completed', 'Dropped', 'Season End', 'Coming Soon'],
      default: 0,
    },
    { kind: 'select', name: 'Type', values: ['All', 'Manga', 'Manhwa', 'Manhua'], default: 0 },
    {
      kind: 'select',
      name: 'Order',
      values: ['Default', 'Latest updated', 'Popularity', 'Rating', 'Title'],
      default: 0,
    },
  ];

  const STATUS = ['', 'ongoing', 'hiatus', 'completed', 'dropped', 'season end', 'coming soon'];
  const TYPE = ['', 'manga', 'manhwa', 'manhua'];
  const ORDER = ['', 'update', 'bookmarks', 'rating', 'title'];

  /**
   * One page of the catalogue.
   *
   * `page` is not a parameter this API has: it accepts one and ignores it, and
   * answers every request with the first twenty series. Paging is by `offset`,
   * which is what the site's own app sends. Asking for `page=2` therefore
   * returned page one again, and the grid filled with the titles already on it.
   *
   * `total` is what says whether there is more, and it is checked before
   * `has_more` because the API drops `has_more` from the last page rather than
   * setting it false — treating a missing flag as "maybe" is what would add an
   * empty page to the end of every listing.
   */
  async function list(page: number, params: URLSearchParams): Promise<MangaPage<SourceManga>> {
    const offset = Math.max(0, page - 1) * PAGE_SIZE;
    params.set('offset', String(offset));
    const body = await http.json<SeriesList>(`${API}/series?${params.toString()}`);
    const data = body.data ?? [];
    const total = body.meta?.total;
    return {
      items: data.map(toManga),
      hasNextPage:
        typeof total === 'number'
          ? offset + data.length < total
          : (body.meta?.has_more ?? data.length > 0),
    };
  }

  return {
    id: '1000000000000000005',
    name: 'Asura Scans',
    lang: 'en',
    baseUrl: SITE,
    supportsLatest: true,
    contentWarning: 'SAFE',

    getPopular: (page) => list(page, new URLSearchParams({ order: 'bookmarks' })),
    getLatest: (page) => list(page, new URLSearchParams({ order: 'update' })),

    async search(query, page, changes = []) {
      const params = new URLSearchParams();
      if (query) params.set('search', query);
      for (const change of changes) {
        const spec = filters[change.position];
        if (!spec || spec.kind !== 'select' || !change.selectState) continue;
        if (spec.name === 'Status') params.set('status', STATUS[change.selectState] ?? '');
        if (spec.name === 'Type') params.set('type', TYPE[change.selectState] ?? '');
        if (spec.name === 'Order') params.set('order', ORDER[change.selectState] ?? '');
      }
      return list(page, params);
    },

    getFilters: () => filters,

    async getMangaDetails(manga) {
      const slug = manga.url.replace(/^\/series\//, '');
      const body = await http.json<{ series: SeriesSummary }>(`${API}/series/${slug}`);
      const series = body.series;
      return {
        url: `/series/${series.slug}`,
        title: series.title,
        thumbnailUrl: series.cover ?? null,
        author: series.author ?? null,
        artist: series.artist ?? null,
        description: series.description ?? null,
        genre: series.genres?.map((genre) => genre.name) ?? [],
        status: parseStatus(series.status),
        realUrl: series.public_url ? `${SITE}${series.public_url}` : `${SITE}/series/${series.slug}`,
        initialized: true,
      };
    },

    async getChapterList(manga) {
      const slug = manga.url.replace(/^\/series\//, '');
      const body = await http.json<{ data: ChapterSummary[] | null }>(
        `${API}/series/${slug}/chapters`,
      );
      const data = body.data ?? [];
      if (data.length === 0) throw new NoResultsError();
      return data.map((chapter) => ({
        // The chapter's own slug is a UUID for older uploads and `chapter-N` for
        // newer ones; both are what the pages endpoint keys on.
        url: `/series/${slug}/chapters/${chapter.slug}`,
        name: chapter.title ? `Chapter ${chapter.number} - ${chapter.title}` : `Chapter ${chapter.number}`,
        chapterNumber: chapter.number,
        dateUpload: chapter.published_at ? (Date.parse(chapter.published_at) || 0) : 0,
        realUrl: `${SITE}/series/${slug}/chapter/${chapter.number}`,
      }));
    },

    async getPageList(chapter) {
      const body = await http.json<{
        data: { access_gate?: string; chapter: { pages?: { url: string }[] } };
      }>(`${API}${chapter.url}`);
      const pages = body.data.chapter.pages ?? [];
      if (pages.length === 0) {
        // Early-access chapters answer 200 with an empty page list and an
        // `access_gate`; saying so beats an empty reader.
        throw new NoResultsError(
          body.data.access_gate
            ? 'This chapter is in early access on Asura Scans'
            : 'No pages found',
        );
      }
      return pages.map((page, index) => ({ index, url: page.url }));
    },

    imageHeaders: () => ({ Referer: `${SITE}/` }),
  };
}

export const definition: SourceDefinition = {
  pkgName: 'asurascans',
  name: 'Asura Scans',
  lang: 'en',
  id: '1000000000000000005',
  contentWarning: 'SAFE',
  usesCloudflare: true,
  versionName: '1.0.0',
  build,
};
