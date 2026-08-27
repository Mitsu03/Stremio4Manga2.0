/**
 * Fetching page images, politely.
 *
 * The rule this file exists to keep is the one in `sources/http.ts`: **one
 * request at a time per hostname, spaced out**. A downloader is the single
 * worst offender against it — a chapter is forty images from one host, back to
 * back, and firing those in parallel is the difference between a reader and a
 * scraper. So the bytes go through the same client type every source uses,
 * which serialises per host and applies the retry, breaker and Cloudflare rules
 * for free, and pages are awaited one at a time.
 *
 * Two things are deliberately different from a source's own client:
 *
 *   * the interval floor is raised. Nobody is watching a download, so it can
 *     afford to look even less like a machine than a search does;
 *   * `imageHeaders()` comes from the source, because most sites 403 an image
 *     request without the Referer their own reader sends.
 *
 * The client itself comes from `sources/registry.ts` rather than being built
 * here. The per-host queue, the cookie jar, the Cloudflare clearance and the
 * circuit breaker all live on one client, so a second one would let a download
 * and a search hit the same site at the same moment, each paying none of the
 * other's spacing.
 */
import { MIN_INTERVAL_MS } from '../sources/http.js';
import { sourceHttpFor } from '../sources/registry.js';
import type { Config } from '../config.js';
import type { Source, SourceHttp, SourcePage } from '../sources/types.js';

/** Background work waits longer than a person who is watching a spinner. */
const DOWNLOAD_INTERVAL_MS = Math.max(2_000, MIN_INTERVAL_MS);
/** An image is bytes, not a page render; a slow one is a dead one. */
const IMAGE_TIMEOUT_MS = 60_000;

const bound = new Map<string, SourceHttp>();

/**
 * One view per source over the registry's single client, kept so the download
 * interval and timeout are not re-derived per page.
 */
function httpFor(_config: Config, sourceName: string): SourceHttp {
  let http = bound.get(sourceName);
  if (!http) {
    http = sourceHttpFor({
      sourceName,
      minIntervalMs: DOWNLOAD_INTERVAL_MS,
      timeoutMs: IMAGE_TIMEOUT_MS,
    });
    bound.set(sourceName, http);
  }
  return http;
}

/**
 * Content type to file extension.
 *
 * The URL's own extension is not trusted first: plenty of sites serve WebP from
 * a `.jpg` path, and a reader that opens by extension would show a broken page.
 */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
};

const FROM_URL = /\.(jpe?g|png|webp|gif|avif|bmp|tiff)(?:[?#]|$)/i;

function extensionFor(contentType: string | null, url: string): string {
  const mime = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const known = EXTENSIONS[mime];
  if (known) return known;
  const guess = FROM_URL.exec(url)?.[1]?.toLowerCase();
  if (guess) return guess === 'jpeg' ? 'jpg' : guess;
  // Every source here serves JPEG or WebP; an unlabelled body is far more
  // likely to be the former than to be undisplayable.
  return 'jpg';
}

export interface FetchedPage {
  bytes: Buffer;
  extension: string;
}

/**
 * One page: resolve the image URL if the source hands out page URLs, then take
 * the bytes.
 */
export async function fetchPage(
  config: Config,
  source: Source,
  page: SourcePage,
): Promise<FetchedPage> {
  const url =
    page.needsResolve && source.resolveImageUrl ? await source.resolveImageUrl(page) : page.url;

  const response = await httpFor(config, source.name).raw(url, {
    headers: source.imageHeaders?.(url),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error(`${url} answered with an empty image`);

  return { bytes, extension: extensionFor(response.headers.get('content-type'), url) };
}
