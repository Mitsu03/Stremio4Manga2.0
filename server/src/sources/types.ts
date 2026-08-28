/**
 * What a source is, and the only thing the rest of the server knows about one.
 *
 * The server this replaces ran Tachiyomi extension APKs: dex2jar, a child-first
 * classloader per jar, and a 547 MB embedded Chromium behind it. None of that
 * can exist in Node, so sources are written here instead — mostly as thin
 * definitions on top of a shared theme (Madara, MangaThemesia, …), because the
 * long tail of manga sites is a handful of site engines wearing different skins.
 *
 * The method names deliberately mirror the Tachiyomi contract. Every call site
 * in this repo was ported from one that called the Kotlin equivalent, so keeping
 * the shape means the porting is mechanical and the behaviour comparable.
 */

/** A source id is a Long on the wire; we keep it a string everywhere. */
export type SourceId = string;

export type MangaStatus =
  | 'UNKNOWN'
  | 'ONGOING'
  | 'COMPLETED'
  | 'LICENSED'
  | 'PUBLISHING_FINISHED'
  | 'CANCELLED'
  | 'ON_HIATUS';

export interface SourceManga {
  /** Stable per source. Stored as the manga row's `url` and used to dedupe. */
  url: string;
  title: string;
  thumbnailUrl?: string | null;
  author?: string | null;
  artist?: string | null;
  description?: string | null;
  genre?: string[];
  status?: MangaStatus;
  /** The page a human would open. Filled by getMangaDetails, not by listings. */
  realUrl?: string | null;
  /** True once getMangaDetails has filled the fields above. */
  initialized?: boolean;
}

export interface SourceChapter {
  url: string;
  name: string;
  /** -1 when the source publishes no number and none can be parsed from the name. */
  chapterNumber: number;
  scanlator?: string | null;
  /** Epoch milliseconds; 0 when the source publishes no date. */
  dateUpload: number;
  realUrl?: string | null;
}

export interface SourcePage {
  index: number;
  /**
   * Either the image itself, or a page URL that has to be opened to find it.
   * When it is the latter, set `needsResolve` and implement `resolveImageUrl`.
   */
  url: string;
  needsResolve?: boolean;
}

export interface MangaPage<T> {
  items: T[];
  hasNextPage: boolean;
}

// ------------------------------------------------------------------ filters --

export type TriState = 'IGNORE' | 'INCLUDE' | 'EXCLUDE';

export interface SortSelection {
  index: number;
  ascending: boolean;
}

export type FilterSpec =
  | { kind: 'header'; name: string }
  | { kind: 'separator'; name: string }
  | { kind: 'select'; name: string; values: string[]; default: number }
  | { kind: 'text'; name: string; default: string }
  | { kind: 'checkbox'; name: string; default: boolean }
  | { kind: 'tristate'; name: string; default: TriState }
  | { kind: 'sort'; name: string; values: string[]; default: SortSelection | null }
  | { kind: 'group'; name: string; filters: FilterSpec[] };

/**
 * Flat on purpose, matching what the client sends: one change carries whichever
 * state field belongs to the filter sitting at `position` in the source's own
 * list — headers and separators counted, since the client indexes the list the
 * source returned rather than the subset it chose to draw.
 */
export interface FilterChange {
  position: number;
  selectState?: number;
  textState?: string;
  checkBoxState?: boolean;
  triState?: TriState;
  sortState?: SortSelection;
  groupChange?: FilterChange;
}

// ------------------------------------------------------------------ source --

export interface Source {
  readonly id: SourceId;
  readonly name: string;
  readonly lang: string;
  readonly baseUrl: string;
  readonly supportsLatest: boolean;
  readonly contentWarning: 'SAFE' | 'MIXED' | 'NSFW';

  getPopular(page: number): Promise<MangaPage<SourceManga>>;
  getLatest(page: number): Promise<MangaPage<SourceManga>>;
  search(query: string, page: number, filters?: FilterChange[]): Promise<MangaPage<SourceManga>>;

  getFilters(): FilterSpec[];

  /** Fills in everything a listing could not carry. */
  getMangaDetails(manga: Pick<SourceManga, 'url'>): Promise<SourceManga>;
  getChapterList(manga: Pick<SourceManga, 'url'>): Promise<SourceChapter[]>;
  getPageList(chapter: Pick<SourceChapter, 'url'>): Promise<SourcePage[]>;

  /** Only for sources whose page list hands out page URLs rather than images. */
  resolveImageUrl?(page: SourcePage): Promise<string>;

  /**
   * Headers an image request needs — a Referer, usually. Separate from fetching
   * the bytes because downloads and the reader both need them and neither wants
   * the source's own retry policy applied twice.
   */
  imageHeaders?(imageUrl: string): Record<string, string>;
}

export interface SourceRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Route through FlareSolverr even if the response does not look challenged. */
  solveCloudflare?: boolean;
}

export interface SourceHttp {
  text(url: string, init?: SourceRequestInit): Promise<string>;
  json<T>(url: string, init?: SourceRequestInit): Promise<T>;
  /** The raw response, for image bytes. */
  raw(url: string, init?: SourceRequestInit): Promise<Response>;
  /**
   * A cookie the shared jar holds for `url`'s host, by name.
   *
   * Reading a cookie is not something a scraper normally needs — the jar sends
   * them back on its own. It is here for the one source whose API lives on a
   * different host from the site that authenticates it, and therefore has to
   * move the value across by hand.
   */
  cookie(url: string, name: string): string | undefined;
}

export interface SourceDeps {
  /** The shared client: cookie jar, per-host rate limit, retry, FlareSolverr. */
  http: SourceHttp;
}

/**
 * What a site file exports. `build` receives the shared HTTP client so a source
 * cannot open its own connections outside the rate limiter.
 */
export interface SourceDefinition {
  /** Slug; doubles as the "extension" pkgName the UI installs and uninstalls. */
  pkgName: string;
  /** Display name. Must match what people know the site as — the UI ranks on it. */
  name: string;
  lang: string;
  /**
   * Numeric id as a string, stable forever: it is stored on every manga row and
   * carried in the client's saved searches and source bindings. Never reuse one.
   */
  id: SourceId;
  contentWarning: 'SAFE' | 'MIXED' | 'NSFW';
  /** Set when the site sits behind Cloudflare and needs FlareSolverr. */
  usesCloudflare?: boolean;
  versionName: string;
  build(deps: SourceDeps): Source;
}

/** Thrown when a source needs FlareSolverr and none is configured. */
export class CloudflareBlockedError extends Error {
  constructor(sourceName: string) {
    super(
      `${sourceName} is behind Cloudflare. Configure flaresolverr.url in the server config to read from it.`,
    );
    this.name = 'CloudflareBlockedError';
  }
}

/** Thrown when a source answers, but with nothing. Distinct from a failure. */
export class NoResultsError extends Error {
  constructor(message = 'No chapters found') {
    super(message);
    this.name = 'NoResultsError';
  }
}
