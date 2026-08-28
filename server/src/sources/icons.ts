/**
 * A picture for every source, and never a broken one.
 *
 * The old server had this for free: extensions arrived as packages with an icon
 * inside, and the catalogue cached one PNG per package. A compiled-in source has
 * no package and no icon, so `iconUrl` was null and the Sources page drew a row
 * of empty squares.
 *
 * Icons are served from this origin rather than linked straight at the site, for
 * the same reason covers are (`reader/pages.ts`): a page full of `<img>` tags
 * pointing at manga sites announces the reader to every one of them on a screen
 * where nothing has been opened yet, and some of those hosts refuse a request
 * that arrives without the Referer they expect.
 *
 * The fallback is the important part. A favicon is fetched once and cached, but
 * sites move them, block them, or are simply down — and an icon that 404s is
 * worse than the empty square it replaced, because the browser draws its own
 * broken-image mark instead. So a miss returns a generated monogram: same shape,
 * same size, deterministic colour, always 200.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import themed from '../../sources.themed.json' with { type: 'json' };
import { USER_AGENT } from './http.js';

/**
 * Where each source's icon is fetched from, keyed by pkgName.
 *
 * The six hand-written sources are listed here because their base URL lives
 * inside their module; the themed ones already carry theirs as data, so they
 * are folded in rather than repeated.
 */
const SITES: Record<string, string> = {
  mangadex: 'https://mangadex.org',
  comick: 'https://comick.io',
  weebcentral: 'https://weebcentral.com',
  mangadistrict: 'https://mangadistrict.com',
  asurascans: 'https://asuracomic.net',
  rizzfables: 'https://rizzfables.com',
  ...Object.fromEntries(
    (themed.extensions as { pkgName: string; baseUrl: string }[]).map((entry) => [
      entry.pkgName,
      entry.baseUrl,
    ]),
  ),
};

/**
 * Icons that are not on the site the source reads from.
 *
 * Only for the cases nothing automatic can reach. Asura serves its app shell
 * with a 200 for every path on `asuracomic.net` — including the two below and
 * the `href` of its own `<link rel="icon">` — so there is no request against
 * that host that finds an image. The file is on the domain it moved from, and
 * that is not something the site says anywhere a machine can read it.
 *
 * Keep this short. An entry here is a fact checked by hand on a date, so it
 * rots; prefer fixing the general path whenever the general path can work.
 */
const ICON_URLS: Record<string, string> = {
  // Checked 2026-08-28: 66 KB image/webp, where every asuracomic.net path
  // answers with 668 KB of text/html.
  asurascans: 'https://asurascans.com/images/logo.webp',
};

/**
 * In the order worth trying. `apple-touch-icon.png` first because it is a real
 * PNG at a usable size; `/favicon.ico` is often 16 pixels and sometimes an ICO
 * that a browser renders in a tab and refuses inside an `<img>`.
 *
 * Two, not four. Every extra candidate is another timeout to sit through for
 * every site that has none of them, and with hundreds of sources that arithmetic
 * is the difference between a warm cache in a minute and one in an hour.
 */
const CANDIDATES = ['/apple-touch-icon.png', '/favicon.ico'];

const MAX_BYTES = 512 * 1024;
/** Short: nothing waits on this, and a site that is slow to serve a favicon is
 * not going to become fast on the next try. */
const TIMEOUT_MS = 6_000;

/**
 * How many icons are fetched at once, in the background.
 *
 * Deliberately not the shared source client. That client allows four requests
 * in flight across the whole server, which is the right budget for reading
 * manga and precisely the wrong place to put several hundred favicons: they
 * would fill the queue for hours and every search would wait behind them. This
 * is one request per site, once, cached forever after — low enough volume to
 * run outside the limiter without being the kind of traffic it exists to
 * prevent.
 */
const WARM_CONCURRENCY = 2;

/** Cached in memory as well as on disk: this is hit once per row per page load. */
const memory = new Map<string, { body: Buffer; type: string }>();
/** A site with no usable icon is not asked again for the life of the process. */
const missing = new Set<string>();

/**
 * Where the UI asks for a source's icon. Relative on purpose: a deployment
 * behind a reverse proxy on a sub-path would break an absolute one.
 */
export const iconPath = (pkgName: string): string =>
  `/api/v1/extension/${encodeURIComponent(pkgName)}/icon`;

export interface SourceIcon {
  body: Buffer;
  type: string;
  /** False for the generated monogram, so the caller can cache it less eagerly. */
  real: boolean;
}

function cacheDir(cacheRoot: string): string {
  const dir = join(cacheRoot, 'icons');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function extensionFor(type: string): string {
  if (type.includes('svg')) return 'svg';
  if (type.includes('png')) return 'png';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('webp')) return 'webp';
  return 'ico';
}

function typeFor(name: string): string {
  if (name.endsWith('.svg')) return 'image/svg+xml';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  return 'image/x-icon';
}

function fromDisk(dir: string, pkgName: string): { body: Buffer; type: string } | undefined {
  for (const ext of ['png', 'svg', 'jpg', 'webp', 'ico']) {
    const file = join(dir, `${pkgName}.${ext}`);
    try {
      return { body: readFileSync(file), type: typeFor(file) };
    } catch {
      // Not this extension; try the next.
    }
  }
  return undefined;
}

/**
 * The monogram: the source's initial on a colour derived from its name, so the
 * same source is the same colour on every install without a palette to keep.
 */
export function monogram(name: string): SourceIcon {
  const letter = (name.trim()[0] ?? '?').toUpperCase().replace(/[<&>"]/g, '');
  const hue = createHash('sha256').update(name).digest()[0] * (360 / 256);
  const body = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">` +
      `<rect width="64" height="64" rx="14" fill="hsl(${hue.toFixed(0)} 45% 42%)"/>` +
      `<text x="32" y="33" fill="#fff" font-family="system-ui,-apple-system,sans-serif"` +
      ` font-size="34" font-weight="600" text-anchor="middle" dominant-baseline="central">` +
      `${letter}</text></svg>`,
    'utf8',
  );
  return { body, type: 'image/svg+xml', real: false };
}

/** pkgNames queued or in flight, so a site is never fetched twice at once. */
const warming = new Set<string>();
let active = 0;
const queue: (() => void)[] = [];

/** An image if the URL is one, and nothing otherwise. Never throws. */
async function tryImage(url: string): Promise<{ body: Buffer; type: string } | undefined> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!response.ok) return undefined;

    const type = response.headers.get('content-type') ?? '';
    // A site that answers every unknown path with its app shell would otherwise
    // cache an HTML document as this source's icon, permanently.
    if (!type.startsWith('image/')) return undefined;

    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return undefined;
    return { body, type };
  } catch {
    // Down, blocked, timed out. The caller has other things to try.
    return undefined;
  }
}

/**
 * The icon the page itself points at.
 *
 * The two fixed paths above are a guess, and a single-page app defeats it
 * completely: a Next.js site answers `/favicon.ico` with its own HTML shell and
 * a 200, so the guess never lands and the source keeps a monogram forever while
 * plainly having an icon. Asura Scans is exactly this, and it is not unusual —
 * the content-type guard is doing its job, there is simply nothing behind those
 * two paths to find.
 *
 * The document says where its icon is, so read it. `apple-touch-icon` is
 * preferred because it is a real PNG at a usable size where `rel="icon"` is
 * often a 16-pixel ICO; the list is sorted rather than filtered so a site
 * declaring only the latter still gets one.
 */
async function declaredIcon(site: string): Promise<{ body: Buffer; type: string } | undefined> {
  let html: string;
  try {
    const response = await fetch(`${site}/`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!response.ok) return undefined;
    // The declarations are in `<head>`; the rest can be a megabyte of catalogue.
    html = (await response.text()).slice(0, 200_000);
  } catch {
    return undefined;
  }

  const links = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((tag) => tag[0])
    .filter((tag) => /rel\s*=\s*["'][^"']*\bicon\b[^"']*["']/i.test(tag))
    .map((tag) => ({
      href: /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1],
      apple: /apple-touch-icon/i.test(tag),
    }))
    .filter((link): link is { href: string; apple: boolean } => link.href !== undefined)
    .sort((a, b) => Number(b.apple) - Number(a.apple));

  // Capped: a page may declare a dozen sizes, and each miss is another timeout.
  for (const { href } of links.slice(0, 4)) {
    let url: string;
    try {
      url = new URL(href, `${site}/`).toString();
    } catch {
      continue;
    }
    const found = await tryImage(url);
    if (found) return found;
  }
  return undefined;
}

async function fetchIcon(pkgName: string, dir: string): Promise<void> {
  const configured = SITES[pkgName];
  if (!configured) return;
  const site = configured.replace(/\/+$/, '');

  // A known-good URL, where one has had to be found by hand.
  let found = ICON_URLS[pkgName] ? await tryImage(ICON_URLS[pkgName]) : undefined;

  // Then the fixed paths: one request, no parsing, and correct for most of the
  // WordPress installs that make up the bulk of the catalogue.
  for (const path of CANDIDATES) {
    if (found) break;
    found = await tryImage(`${site}${path}`);
  }
  found ??= await declaredIcon(site);

  if (!found) {
    missing.add(pkgName);
    return;
  }

  memory.set(pkgName, found);
  try {
    writeFileSync(join(dir, `${pkgName}.${extensionFor(found.type)}`), found.body);
  } catch {
    // A read-only or full data directory costs a re-fetch next boot, which is
    // not a reason to lose the copy already in memory.
  }
}

/**
 * Run `job` when a warming slot frees up. Fire-and-forget by design.
 *
 * `catch` before `finally`, and not the other way round: nothing awaits this, so
 * a rejection escaping here is an unhandled rejection, and Node's default for
 * one of those is to end the process. An icon is not worth the server.
 */
function schedule(job: () => Promise<void>): void {
  const run = () => {
    active++;
    void job()
      .catch(() => undefined)
      .finally(() => {
        active--;
        queue.shift()?.();
      });
  };
  if (active < WARM_CONCURRENCY) run();
  else queue.push(run);
}

/**
 * The icon for a source: memory, then disk, then a monogram — and never the
 * network.
 *
 * This used to fetch the favicon inline, which was fine for six sources and
 * ruinous for several hundred: a cold icon cost up to 30 seconds, the Sources
 * page asks for one per row, and they queued through the four in-flight slots
 * the whole server shares with actual reading. The page took minutes and every
 * search waited behind a pile of favicons.
 *
 * So the request is answered immediately, from cache or with a monogram, and a
 * real icon is fetched in the background for the *next* load. The monogram
 * carries a short cache lifetime for exactly that reason.
 */
export function sourceIcon(pkgName: string, displayName: string, cacheRoot: string): SourceIcon {
  const held = memory.get(pkgName);
  if (held) return { ...held, real: true };

  const dir = cacheDir(cacheRoot);
  const stored = fromDisk(dir, pkgName);
  if (stored) {
    memory.set(pkgName, stored);
    return { ...stored, real: true };
  }

  if (SITES[pkgName] && !missing.has(pkgName) && !warming.has(pkgName)) {
    warming.add(pkgName);
    schedule(() => fetchIcon(pkgName, dir).finally(() => warming.delete(pkgName)));
  }

  return monogram(displayName);
}
