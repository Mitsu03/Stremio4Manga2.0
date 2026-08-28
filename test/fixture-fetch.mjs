/**
 * Records and replays the server's outbound HTTP, so the half of the smoke
 * suite that reads and downloads can run without the internet.
 *
 * Twenty-two checks — search, the chapter list, page resolution, the cover, the
 * cross-account 404, reading progress, and the downloader writing files to disk
 * — used to run only when somebody typed `npm test` by hand, because they reach
 * a real manga site and a site down for its own reasons must not be able to fail
 * a pull request. That left the whole reader and downloader path unexercised by
 * anything automated.
 *
 * Recording once and replaying afterwards splits that in two. What the reader
 * does with a response is deterministic and belongs in CI; whether the site
 * still answers that way is not, and stays a manual run. This file is the first
 * half.
 *
 * Loaded with `node --import`, so it patches `globalThis.fetch` before the
 * server starts and nothing in `server/src` knows it exists. That is the point:
 * the runtime image carries no test code, and the only thing the server itself
 * has for this is the one interval line in `sources/http.ts`, which is spacing,
 * not plumbing.
 *
 *   S4M_FIXTURES        directory of recordings — required, or this is a no-op
 *   S4M_FIXTURES_MODE   `record` (call the network and save) or `replay`
 *
 * A recording is keyed on `METHOD url`, so the same URL asked twice replays the
 * same answer. That is a simplification and a deliberate one: a suite whose
 * result depends on how many times it asked is not a suite anybody can read.
 *
 * JSON bodies are stored as JSON rather than as base64, so a recording can be
 * read and a change to one can be reviewed. It costs byte-exactness — the body
 * is re-serialised on replay — which nothing here depends on, because every
 * caller parses it.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.env.S4M_FIXTURES;
const MODE = process.env.S4M_FIXTURES_MODE ?? 'replay';

/**
 * A 1×1 transparent PNG, which is what every recorded image body is replaced
 * with.
 *
 * A chapter is twenty images of a few hundred kilobytes each, and the checks
 * that read them assert two things: that the bytes are not empty, and that the
 * extension came from the `content-type` header rather than the URL. Both hold
 * on 67 bytes, and the alternative is several megabytes of somebody else's
 * artwork committed to a public repository to prove a file was written.
 */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

if (DIR) {
  const real = globalThis.fetch;
  mkdirSync(DIR, { recursive: true });

  const pathFor = (method, url) =>
    join(DIR, `${createHash('sha256').update(`${method} ${url}`).digest('hex').slice(0, 32)}.json`);

  const isJson = (type) => /^application\/(\w+\+)?json/.test(type);

  /** Rebuild a Response from a recording, set-cookie by set-cookie. */
  const revive = (saved) => {
    const headers = new Headers();
    for (const [name, value] of saved.headers) headers.append(name, value);
    const body =
      saved.json !== undefined
        ? Buffer.from(JSON.stringify(saved.json))
        : Buffer.from(saved.body, 'base64');
    return new Response(body, {
      status: saved.status,
      statusText: saved.statusText,
      headers,
    });
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    const file = pathFor(method, url);

    if (MODE === 'replay') {
      if (!existsSync(file)) {
        // Named, because the useful question is always "which request", and the
        // answer is otherwise a source that simply returns nothing.
        throw new Error(
          `No fixture for ${method} ${url}\n` +
            `Re-record with: npm run test:record  (see test/fixtures/README.md)`,
        );
      }
      return revive(JSON.parse(readFileSync(file, 'utf8')));
    }

    const response = await real(input, init);
    const type = response.headers.get('content-type') ?? '';
    const body = Buffer.from(await response.clone().arrayBuffer());

    // Headers are kept as recorded, images included: `content-type` is what the
    // downloader derives the file extension from, so replacing the bytes must
    // not replace the label on them.
    const headers = [...response.headers].filter(([name]) => name !== 'set-cookie');
    for (const cookie of response.headers.getSetCookie()) headers.push(['set-cookie', cookie]);

    const saved = {
      method,
      url,
      status: response.status,
      statusText: response.statusText,
      headers,
      ...(type.startsWith('image/')
        ? { body: PIXEL.toString('base64'), imageReplacedWithPixel: body.length }
        : isJson(type)
          ? { json: JSON.parse(body.toString('utf8')) }
          : { body: body.toString('base64') }),
    };
    writeFileSync(file, `${JSON.stringify(saved, null, 1)}\n`);

    return revive(saved);
  };
}
