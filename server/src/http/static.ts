/**
 * Serving the built UI.
 *
 * One copy of the app for everybody, behind the one place that decides whether
 * a request is allowed to see it.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

import type { Req, Res } from '../types.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Resolve a URL path to a file inside the dist directory, or null.
 *
 * The containment check is the point: `normalize` collapses `..` segments, and
 * comparing the result against the root catches anything that climbed out —
 * including the percent-encoded spellings a browser would happily send.
 */
export function resolveWithin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // An invalid escape (`%zz`, a lone `%`) is not something the app ever sends.
    return null;
  }
  if (decoded.includes('\0')) return null;

  const base = normalize(root);
  const candidate = normalize(join(base, decoded));
  if (candidate !== base && !candidate.startsWith(base + sep)) return null;
  return candidate;
}

/** Vite writes content hashes into asset filenames, which is what makes them safe to cache forever. */
function isFingerprinted(file: string): boolean {
  return /[.-][0-9a-zA-Z_-]{8,}\.(js|mjs|css|woff2?|png|jpe?g|svg|webp|avif)$/.test(file);
}

export function serveStatic(req: Req, res: Res, root: string, urlPath: string): boolean {
  const file = resolveWithin(root, urlPath);
  if (!file || !existsSync(file)) return false;

  const stats = statSync(file);
  if (!stats.isFile()) return false;

  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(stats.size),
    // Nothing served from here is public: it is one person's app shell, behind
    // their session. Shared caches must not keep a copy.
    'Cache-Control': isFingerprinted(file)
      ? 'private, max-age=31536000, immutable'
      : 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return true;
}

/** The SPA fallback: every path the client-side router owns lands here. */
export function serveIndex(res: Res, root: string, status = 200): void {
  const index = join(root, 'index.html');
  if (!existsSync(index)) {
    // Said in words rather than as an empty 404, because this is what a fresh
    // checkout looks like before `npm run build` in web/.
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      'The UI has not been built. Run "npm run build" in web/, or point uiDist somewhere else.\n',
    );
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  const stream = createReadStream(index);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
