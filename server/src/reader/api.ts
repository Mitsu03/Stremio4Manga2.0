/**
 * The REST half of the API: everything an `<img>`, an `<a download>` or a
 * `navigator.sendBeacon`-shaped PATCH has to reach, which is everything GraphQL
 * cannot carry.
 *
 * Four of the five routes exist because the browser fetches them itself rather
 * than through the client's HTTP layer, so the only credential they can carry is
 * the session cookie — which is the whole argument for this server being
 * same-origin. By the time anything here runs the router has already established
 * the session; `session.username` is the account, and every query filters on it.
 *
 * Ownership failures are 404, never 403. Whether a manga id exists on another
 * account is not something this account is entitled to learn, and the reader
 * treats both the same way regardless.
 */
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

import catalog from '../../catalog.json' with { type: 'json' };
import { dataPaths } from '../config.js';
import type { Config } from '../config.js';
import type { Db } from '../db/open.js';
import type { ApiHandler, Logger, Req, Res, Session } from '../types.js';
import { readPage, readThumbnail, type ImageBytes, type ReaderDeps } from './pages.js';
import { recordProgress } from './progress.js';

/** A progress PATCH is two short fields; anything larger is not one. */
const MAX_FORM_BYTES = 4 * 1024;

/**
 * A day. Page images and covers never change behind their URL — a chapter's page
 * list is fixed once fetched, and a new cover is a new manga row — so the only
 * cost of caching them is disk in the reader's own browser. `private` because
 * every one of these is one person's library behind one person's cookie.
 */
const IMAGE_CACHE = 'private, max-age=86400';

const BACKUP_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.gz': 'application/gzip',
  '.zip': 'application/zip',
  '.proto': 'application/octet-stream',
  '.tachibk': 'application/octet-stream',
};

function sendJson(res: Res, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

const notFound = (res: Res): void => sendJson(res, 404, { error: 'not_found' });
const methodNotAllowed = (res: Res): void => sendJson(res, 405, { error: 'method_not_allowed' });

function sendImage(req: Req, res: Res, image: ImageBytes): void {
  res.writeHead(200, {
    'content-type': image.contentType || 'application/octet-stream',
    'content-length': String(image.bytes.length),
    'cache-control': IMAGE_CACHE,
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : image.bytes);
}

/** A whole number in a path segment, or null. */
function integerSegment(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,15}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readForm(req: Req): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_FORM_BYTES) throw new Error('body too large');
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Resolve a requested backup name against the directory's own listing.
 *
 * Deliberately not `join(directory, filename)` with a containment check
 * afterwards. Matching against what `readdir` actually returned means no string
 * the client sends is ever part of a path: `..`, an absolute path, a symlink
 * name and a percent-encoded separator all simply fail to equal any entry.
 */
function resolveBackup(directory: string, filename: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return null;
  }
  if (!entries.includes(filename)) return null;
  const file = join(directory, filename);
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

export function createApiHandler(deps: { config: Config; db: Db; log: Logger }): ApiHandler {
  const { config, db, log } = deps;
  const readerDeps: ReaderDeps = { config, db, log };
  const catalogBody = JSON.stringify(catalog);

  /**
   * A source that is down, challenged or slow is not this server failing, and
   * the reader retries the same URL with a `?retry=` counter when it sees one.
   * 502 says which side of the wall the problem is on.
   */
  function upstreamFailed(res: Res, what: string, error: unknown): void {
    log.warn(`${what}: ${(error as Error).message}`);
    sendJson(res, 502, { error: 'source_unavailable', message: (error as Error).message });
  }

  async function servePage(
    req: Req,
    res: Res,
    session: Session,
    mangaId: number,
    sourceOrder: number,
    index: number,
  ): Promise<void> {
    let image: ImageBytes | null;
    try {
      image = await readPage(readerDeps, session.username, mangaId, sourceOrder, index);
    } catch (error) {
      upstreamFailed(res, `page ${index} of manga ${mangaId} chapter ${sourceOrder}`, error);
      return;
    }
    if (!image) return notFound(res);
    sendImage(req, res, image);
  }

  async function serveThumbnail(
    req: Req,
    res: Res,
    session: Session,
    mangaId: number,
  ): Promise<void> {
    let image: ImageBytes | null;
    try {
      image = await readThumbnail(readerDeps, session.username, mangaId);
    } catch (error) {
      upstreamFailed(res, `cover of manga ${mangaId}`, error);
      return;
    }
    if (!image) return notFound(res);
    sendImage(req, res, image);
  }

  async function patchProgress(
    req: Req,
    res: Res,
    session: Session,
    mangaId: number,
    sourceOrder: number,
  ): Promise<void> {
    let form: URLSearchParams;
    try {
      form = await readForm(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }

    const rawPage = form.get('lastPageRead');
    const lastPageRead = rawPage === null ? undefined : Number(rawPage);
    if (lastPageRead !== undefined && !Number.isFinite(lastPageRead)) {
      return sendJson(res, 400, { error: 'bad_request', message: 'lastPageRead must be a number.' });
    }

    const known = recordProgress(readerDeps, session.username, mangaId, sourceOrder, {
      ...(lastPageRead === undefined ? {} : { lastPageRead }),
      read: form.get('read') === 'true',
    });
    if (!known) return notFound(res);
    sendJson(res, 200, { ok: true });
  }

  function serveBackup(req: Req, res: Res, session: Session, filename: string): void {
    const directory = join(dataPaths(config).backups, session.username);
    const file = resolveBackup(directory, filename);
    if (!file) return notFound(res);

    const size = statSync(file).size;
    res.writeHead(200, {
      'content-type': BACKUP_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(size),
      // The client downloads this through an anchor; without the disposition the
      // browser would try to render a backup archive as a page.
      'content-disposition': `attachment; filename="${filename.replace(/["\\]/g, '')}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  return async function handleApi(req, res, session, url): Promise<boolean> {
    // Only the path is matched. The reader appends `?retry=n` when it asks for a
    // page a second time, and any other query it grows must be ignored just as
    // quietly rather than turning into a 404 mid-chapter.
    const segments = url.pathname.split('/').filter((segment) => segment !== '');
    if (segments[0] !== 'api' || segments[1] !== 'v1') return false;

    const method = req.method ?? 'GET';
    const isRead = method === 'GET' || method === 'HEAD';

    if (segments[2] === 'extension' && segments[3] === 'catalog' && segments.length === 4) {
      if (!isRead) {
        methodNotAllowed(res);
        return true;
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(catalogBody)),
        'cache-control': 'private, no-cache',
      });
      res.end(method === 'HEAD' ? undefined : catalogBody);
      return true;
    }

    if (segments[2] === 'backup' && segments.length === 4) {
      if (!isRead) {
        methodNotAllowed(res);
        return true;
      }
      let filename: string;
      try {
        filename = decodeURIComponent(segments[3]);
      } catch {
        // An invalid escape is not something the client ever sends.
        notFound(res);
        return true;
      }
      serveBackup(req, res, session, filename);
      return true;
    }

    if (segments[2] !== 'manga') return false;

    const mangaId = integerSegment(segments[3]);
    if (mangaId === null) return false;

    if (segments[4] === 'thumbnail' && segments.length === 5) {
      if (!isRead) {
        methodNotAllowed(res);
        return true;
      }
      await serveThumbnail(req, res, session, mangaId);
      return true;
    }

    if (segments[4] !== 'chapter') return false;
    // The reader's own coordinate: position in the list the source returned,
    // not the chapter row's id.
    const sourceOrder = integerSegment(segments[5]);
    if (sourceOrder === null) return false;

    if (segments.length === 6) {
      if (method !== 'PATCH') {
        methodNotAllowed(res);
        return true;
      }
      await patchProgress(req, res, session, mangaId, sourceOrder);
      return true;
    }

    if (segments[6] === 'page' && segments.length === 8) {
      const index = integerSegment(segments[7]);
      if (index === null) return false;
      if (!isRead) {
        methodNotAllowed(res);
        return true;
      }
      await servePage(req, res, session, mangaId, sourceOrder, index);
      return true;
    }

    return false;
  };
}
