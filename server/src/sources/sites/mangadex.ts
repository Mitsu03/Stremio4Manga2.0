/**
 * MangaDex — the one source here with a real, documented, stable API.
 *
 * Everything is a UUID and nothing is a web page, so `url` holds the API path
 * (`/manga/<uuid>`, `/chapter/<uuid>`) and `realUrl` holds the mangadex.org page
 * a person would open. That split matters: the stored `url` is what dedupes a
 * library row forever, and mangadex.org has changed its front-end routes before.
 *
 * Two API rules shape the code below:
 *   * `offset + limit` may not exceed 10 000 on /manga, so the listing stops
 *     paging there rather than 400-ing at the user;
 *   * a chapter feed is paged at 500 and a long series has more than that, so
 *     the feed is walked to the end — a partial chapter list would silently
 *     hide the newest chapters, which is the one failure nobody notices.
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

const API = 'https://api.mangadex.org';
const SITE = 'https://mangadex.org';
const COVERS = 'https://uploads.mangadex.org/covers';
const PAGE_SIZE = 20;
const MAX_OFFSET = 10_000;
const FEED_PAGE = 500;

interface LocalizedString {
  [language: string]: string | undefined;
}

interface Relationship {
  id: string;
  type: string;
  attributes?: { fileName?: string; name?: string };
}

interface MangaAttributes {
  title: LocalizedString;
  altTitles: LocalizedString[];
  description: LocalizedString;
  status: string | null;
  year: number | null;
  contentRating: string | null;
  tags: { attributes: { name: LocalizedString; group: string } }[];
}

interface MangaEntity {
  id: string;
  attributes: MangaAttributes;
  relationships: Relationship[];
}

interface ChapterAttributes {
  volume: string | null;
  chapter: string | null;
  title: string | null;
  translatedLanguage: string;
  externalUrl: string | null;
  publishAt: string;
  readableAt: string | null;
  pages: number;
}

interface ChapterEntity {
  id: string;
  attributes: ChapterAttributes;
  relationships: Relationship[];
}

interface Collection<T> {
  data: T[];
  limit: number;
  offset: number;
  total: number;
}

interface AtHome {
  baseUrl: string;
  chapter: { hash: string; data: string[]; dataSaver: string[] };
}

/** The `genre`-group tags, which is what a person means by "genre". */
const TAGS: { name: string; id: string }[] = [
  { name: 'Action', id: '391b0423-d847-456f-aff0-8b0cfc03066b' },
  { name: 'Adventure', id: '87cc87cd-a395-47af-b27a-93258283bbc6' },
  { name: "Boys' Love", id: '5920b825-4181-4a17-beeb-9918b0ff7a30' },
  { name: 'Comedy', id: '4d32cc48-9f00-4cca-9b5a-a839f0764984' },
  { name: 'Crime', id: '5ca48985-9a9d-4bd8-be29-80dc0303db72' },
  { name: 'Drama', id: 'b9af3a63-f058-46de-a9a0-e0c13906197a' },
  { name: 'Fantasy', id: 'cdc58593-87dd-415e-bbc0-2ec27bf404cc' },
  { name: "Girls' Love", id: 'a3c67850-4684-404e-9b7f-c69850ee5da6' },
  { name: 'Historical', id: '33771934-028e-4cb3-8744-691e866a923e' },
  { name: 'Horror', id: 'cdad7e68-1419-41dd-bdce-27753074a640' },
  { name: 'Isekai', id: 'ace04997-f6bd-436e-b261-779182193d3d' },
  { name: 'Magical Girls', id: '81c836c9-914a-4eca-981a-560dad663e73' },
  { name: 'Mecha', id: '50880a9d-5440-4732-9afb-8f457127e836' },
  { name: 'Medical', id: 'c8cbe35b-1b2b-4a3f-9c37-db84c4514856' },
  { name: 'Mystery', id: 'ee968100-4191-4968-93d3-f82d72be7e46' },
  { name: 'Philosophical', id: 'b1e97889-25b4-4258-b28b-cd7f4d28ea9b' },
  { name: 'Psychological', id: '3b60b75c-a2d7-4860-ab56-05f391bb889c' },
  { name: 'Romance', id: '423e2eae-a7a2-4a8b-ac03-a8351462d71d' },
  { name: 'Sci-Fi', id: '256c8bd9-4904-4360-bf4f-508a76d67183' },
  { name: 'Slice of Life', id: 'e5301a23-ebd9-49dd-a0cb-2add944c7fe9' },
  { name: 'Sports', id: '69964a64-2f90-4d33-beeb-f3ed2875eb4c' },
  { name: 'Superhero', id: '7064a261-a137-4d3a-8848-2d385de3a99c' },
  { name: 'Thriller', id: '07251805-a27e-4d59-b488-f0bfbec15168' },
  { name: 'Tragedy', id: 'f8f62932-27da-4fe4-8ee1-6779a8c5edba' },
  { name: 'Wuxia', id: 'acc803a4-c95a-4c22-86fc-eb6b582d82a2' },
];

const CONTENT_RATINGS = ['safe', 'suggestive', 'erotica', 'pornographic'];
const STATUSES = ['ongoing', 'completed', 'hiatus', 'cancelled'];
const DEMOGRAPHICS = ['shounen', 'shoujo', 'seinen', 'josei', 'none'];

/** Sort field per index of the sort filter's `values`. */
const SORT_KEYS = [
  'relevance',
  'latestUploadedChapter',
  'title',
  'rating',
  'followedCount',
  'year',
  'createdAt',
];

const STATUS_MAP: Record<string, MangaStatus> = {
  ongoing: 'ONGOING',
  completed: 'PUBLISHING_FINISHED',
  hiatus: 'ON_HIATUS',
  cancelled: 'CANCELLED',
};

/**
 * Every localised field is a map of language → text, and which languages are
 * present varies per title. English first, then the romanised Japanese key
 * MangaDex uses for most titles, then whatever is there — an empty title would
 * make the row unidentifiable in the library.
 */
function localized(value: LocalizedString | undefined, lang: string): string {
  if (!value) return '';
  return value[lang] ?? value.en ?? value['ja-ro'] ?? Object.values(value).find(Boolean) ?? '';
}

function coverUrl(manga: MangaEntity): string | null {
  const cover = manga.relationships.find((rel) => rel.type === 'cover_art');
  const file = cover?.attributes?.fileName;
  // The .512.jpg derivative is generated for every cover and is a tenth of the
  // original's bytes; the grid never shows anything bigger.
  return file ? `${COVERS}/${manga.id}/${file}.512.jpg` : null;
}

function toManga(entity: MangaEntity, lang: string): SourceManga {
  const authors = entity.relationships
    .filter((rel) => rel.type === 'author')
    .map((rel) => rel.attributes?.name)
    .filter((name): name is string => Boolean(name));
  const artists = entity.relationships
    .filter((rel) => rel.type === 'artist')
    .map((rel) => rel.attributes?.name)
    .filter((name): name is string => Boolean(name));

  return {
    url: `/manga/${entity.id}`,
    title: localized(entity.attributes.title, lang),
    thumbnailUrl: coverUrl(entity),
    author: authors.join(', ') || null,
    artist: artists.join(', ') || null,
    description: localized(entity.attributes.description, lang) || null,
    genre: entity.attributes.tags.map((tag) => localized(tag.attributes.name, lang)),
    status: STATUS_MAP[entity.attributes.status ?? ''] ?? 'UNKNOWN',
    realUrl: `${SITE}/title/${entity.id}`,
    initialized: true,
  };
}

function build(deps: SourceDeps): Source {
  const lang = 'en';
  const http = deps.http;

  const filters: FilterSpec[] = [
    {
      kind: 'sort',
      name: 'Sort',
      values: [
        'Best match',
        'Latest chapter',
        'Title',
        'Rating',
        'Follows',
        'Year',
        'Recently added',
      ],
      default: { index: 4, ascending: false },
    },
    { kind: 'separator', name: '' },
    {
      kind: 'group',
      name: 'Content rating',
      filters: [
        { kind: 'checkbox', name: 'Safe', default: true },
        { kind: 'checkbox', name: 'Suggestive', default: true },
        { kind: 'checkbox', name: 'Erotica', default: false },
        { kind: 'checkbox', name: 'Pornographic', default: false },
      ],
    },
    {
      kind: 'group',
      name: 'Publication status',
      filters: STATUSES.map((status) => ({
        kind: 'checkbox' as const,
        name: status[0].toUpperCase() + status.slice(1),
        default: false,
      })),
    },
    {
      kind: 'group',
      name: 'Demographic',
      filters: DEMOGRAPHICS.map((demographic) => ({
        kind: 'checkbox' as const,
        name: demographic[0].toUpperCase() + demographic.slice(1),
        default: false,
      })),
    },
    {
      kind: 'group',
      name: 'Tags',
      filters: TAGS.map((tag) => ({
        kind: 'tristate' as const,
        name: tag.name,
        default: 'IGNORE' as const,
      })),
    },
  ];

  function applyFilters(params: URLSearchParams, changes: FilterChange[], hasQuery: boolean): void {
    const ratings: string[] = [];
    let ratingsTouched = false;

    for (const change of changes) {
      const spec = filters[change.position];
      if (!spec) continue;

      if (spec.kind === 'sort' && change.sortState) {
        const key = SORT_KEYS[change.sortState.index] ?? 'followedCount';
        // `relevance` only exists while a title is being matched; asking for it
        // on a plain browse is a 400.
        if (key === 'relevance' && !hasQuery) params.set('order[followedCount]', 'desc');
        else params.set(`order[${key}]`, change.sortState.ascending ? 'asc' : 'desc');
        continue;
      }

      if (spec.kind !== 'group' || !change.groupChange) continue;
      const inner = spec.filters[change.groupChange.position];
      if (!inner) continue;

      if (spec.name === 'Content rating') {
        ratingsTouched = true;
        if (change.groupChange.checkBoxState) {
          ratings.push(CONTENT_RATINGS[change.groupChange.position]);
        }
      } else if (spec.name === 'Publication status' && change.groupChange.checkBoxState) {
        params.append('status[]', STATUSES[change.groupChange.position]);
      } else if (spec.name === 'Demographic' && change.groupChange.checkBoxState) {
        params.append('publicationDemographic[]', DEMOGRAPHICS[change.groupChange.position]);
      } else if (spec.name === 'Tags') {
        const tag = TAGS[change.groupChange.position];
        if (!tag) continue;
        if (change.groupChange.triState === 'INCLUDE') params.append('includedTags[]', tag.id);
        if (change.groupChange.triState === 'EXCLUDE') params.append('excludedTags[]', tag.id);
      }
    }

    if (ratingsTouched) {
      // An empty rating list means "no ratings at all" to the API and returns
      // nothing; the site's own default is the sane fallback.
      for (const rating of ratings.length > 0 ? ratings : ['safe', 'suggestive']) {
        params.append('contentRating[]', rating);
      }
    } else {
      params.append('contentRating[]', 'safe');
      params.append('contentRating[]', 'suggestive');
    }
  }

  function baseParams(page: number): URLSearchParams {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String((page - 1) * PAGE_SIZE));
    params.append('includes[]', 'cover_art');
    params.append('includes[]', 'author');
    params.append('includes[]', 'artist');
    params.append('availableTranslatedLanguage[]', lang);
    return params;
  }

  async function list(params: URLSearchParams): Promise<MangaPage<SourceManga>> {
    const offset = Number(params.get('offset') ?? 0);
    if (offset >= MAX_OFFSET) return { items: [], hasNextPage: false };
    const body = await http.json<Collection<MangaEntity>>(`${API}/manga?${params.toString()}`);
    return {
      items: body.data.map((entity) => toManga(entity, lang)),
      hasNextPage: body.offset + body.limit < Math.min(body.total, MAX_OFFSET),
    };
  }

  return {
    id: '1000000000000000001',
    name: 'MangaDex',
    lang,
    baseUrl: SITE,
    supportsLatest: true,
    contentWarning: 'MIXED',

    async getPopular(page) {
      const params = baseParams(page);
      params.set('order[followedCount]', 'desc');
      params.append('contentRating[]', 'safe');
      params.append('contentRating[]', 'suggestive');
      return list(params);
    },

    async getLatest(page) {
      const params = baseParams(page);
      params.set('order[latestUploadedChapter]', 'desc');
      params.append('contentRating[]', 'safe');
      params.append('contentRating[]', 'suggestive');
      return list(params);
    },

    async search(query, page, changes = []) {
      const params = baseParams(page);
      if (query) params.set('title', query);
      applyFilters(params, changes, Boolean(query));
      if (![...params.keys()].some((key) => key.startsWith('order['))) {
        params.set(query ? 'order[relevance]' : 'order[followedCount]', 'desc');
      }
      return list(params);
    },

    getFilters: () => filters,

    async getMangaDetails(manga) {
      const id = manga.url.replace(/^\/manga\//, '');
      const params = new URLSearchParams();
      params.append('includes[]', 'cover_art');
      params.append('includes[]', 'author');
      params.append('includes[]', 'artist');
      const body = await http.json<{ data: MangaEntity }>(
        `${API}/manga/${id}?${params.toString()}`,
      );
      return toManga(body.data, lang);
    },

    async getChapterList(manga) {
      const id = manga.url.replace(/^\/manga\//, '');
      const chapters: SourceChapter[] = [];

      let external = 0;
      for (let offset = 0; ; offset += FEED_PAGE) {
        const params = new URLSearchParams();
        params.set('limit', String(FEED_PAGE));
        params.set('offset', String(offset));
        params.append('translatedLanguage[]', lang);
        params.append('includes[]', 'scanlation_group');
        for (const rating of CONTENT_RATINGS) params.append('contentRating[]', rating);
        params.set('order[volume]', 'desc');
        params.set('order[chapter]', 'desc');

        const body = await http.json<Collection<ChapterEntity>>(
          `${API}/manga/${id}/feed?${params.toString()}`,
        );

        for (const entity of body.data) {
          const attributes = entity.attributes;
          // An "external" chapter lives on the publisher's own site and has no
          // pages here; listing it would give the reader an empty chapter.
          if (attributes.externalUrl) {
            external += 1;
            continue;
          }
          const number = Number.parseFloat(attributes.chapter ?? '');
          const label = attributes.chapter ? `Chapter ${attributes.chapter}` : 'Oneshot';
          const group = entity.relationships.find((rel) => rel.type === 'scanlation_group');
          chapters.push({
            url: `/chapter/${entity.id}`,
            name: attributes.title ? `${label} - ${attributes.title}` : label,
            chapterNumber: Number.isFinite(number) ? number : -1,
            scanlator: group?.attributes?.name ?? null,
            dateUpload: Date.parse(attributes.readableAt ?? attributes.publishAt) || 0,
            realUrl: `${SITE}/chapter/${entity.id}`,
          });
        }

        if (body.offset + body.limit >= body.total || body.data.length === 0) break;
      }

      if (chapters.length === 0) {
        // A licensed title (Dandadan, Jujutsu Kaisen…) has a full English feed
        // where every entry points at MANGA Plus or Viz. The distinction is
        // worth spelling out: the title is not missing, it is not readable here.
        throw new NoResultsError(
          external > 0
            ? 'MangaDex lists this title only as links to the official publisher, with no pages of its own.'
            : 'No chapters found',
        );
      }
      return chapters;
    },

    async getPageList(chapter) {
      const id = chapter.url.replace(/^\/chapter\//, '');
      // /at-home hands out a node URL that is only valid for a while, so this
      // has to be called per read rather than cached with the chapter row.
      const body = await http.json<AtHome>(`${API}/at-home/server/${id}`);
      const files = body.chapter.data.length > 0 ? body.chapter.data : body.chapter.dataSaver;
      const quality = body.chapter.data.length > 0 ? 'data' : 'data-saver';
      if (files.length === 0) throw new NoResultsError('No pages found');
      return files.map((file, index) => ({
        index,
        url: `${body.baseUrl}/${quality}/${body.chapter.hash}/${file}`,
      }));
    },

    imageHeaders: () => ({ Referer: `${SITE}/` }),
  };
}

export const definition: SourceDefinition = {
  pkgName: 'mangadex',
  name: 'MangaDex',
  lang: 'en',
  id: '1000000000000000001',
  contentWarning: 'MIXED',
  versionName: '1.0.0',
  build,
};
