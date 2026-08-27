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

import { sourceHttpFor } from './registry.js';

/** Where each source's icon is fetched from. Keyed by pkgName. */
const SITES: Record<string, string> = {
  mangadex: 'https://mangadex.org',
  comick: 'https://comick.io',
  weebcentral: 'https://weebcentral.com',
  mangadistrict: 'https://mangadistrict.com',
  asurascans: 'https://asuracomic.net',
  rizzfables: 'https://rizzfables.com',
};

/**
 * In the order worth trying. `apple-touch-icon.png` first because it is a real
 * PNG at a usable size; `/favicon.ico` is often 16 pixels and sometimes an ICO
 * that a browser renders in a tab and refuses inside an `<img>`.
 */
const CANDIDATES = ['/apple-touch-icon.png', '/favicon.svg', '/favicon.png', '/favicon.ico'];

const MAX_BYTES = 512 * 1024;
/** A source site being slow must not hold the Sources page open. */
const TIMEOUT_MS = 8_000;

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

/**
 * The icon for a source: memory, then disk, then the site, then a monogram.
 *
 * Never throws and never returns nothing. The caller is an `<img>` tag, which
 * has no better idea than a broken-image mark.
 */
export async function sourceIcon(
  pkgName: string,
  displayName: string,
  cacheRoot: string,
): Promise<SourceIcon> {
  const held = memory.get(pkgName);
  if (held) return { ...held, real: true };

  const dir = cacheDir(cacheRoot);
  const stored = fromDisk(dir, pkgName);
  if (stored) {
    memory.set(pkgName, stored);
    return { ...stored, real: true };
  }

  const site = SITES[pkgName];
  if (!site || missing.has(pkgName)) return monogram(displayName);

  const http = sourceHttpFor({ sourceName: `${displayName} icon`, timeoutMs: TIMEOUT_MS });
  for (const path of CANDIDATES) {
    try {
      const response = await http.raw(`${site}${path}`);
      if (!response.ok) continue;

      const type = response.headers.get('content-type') ?? '';
      // A site that answers every unknown path with its app shell would
      // otherwise cache an HTML document as this source's icon, permanently.
      if (!type.startsWith('image/')) continue;

      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength === 0 || body.byteLength > MAX_BYTES) continue;

      const found = { body, type };
      memory.set(pkgName, found);
      try {
        writeFileSync(join(dir, `${pkgName}.${extensionFor(type)}`), body);
      } catch {
        // A read-only or full data directory costs a re-fetch next boot, which
        // is not a reason to fail the request in hand.
      }
      return { ...found, real: true };
    } catch {
      // Down, blocked, timed out: try the next path, then give up quietly.
    }
  }

  missing.add(pkgName);
  return monogram(displayName);
}
