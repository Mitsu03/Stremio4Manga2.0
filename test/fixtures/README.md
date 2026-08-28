# Recorded HTTP, so the reader and the downloader are tested in CI

`http/` holds what MangaDex answered, once, on the day it was recorded. With it,
`npm run test:replay` runs the whole smoke suite — including the 22 checks that
search, fetch a chapter list, resolve pages, serve a cover, store reading
progress and download a chapter to disk — without reaching a single site.

## Why they exist

Those 22 checks used to run only when somebody typed `npm test` by hand. They
were kept out of CI on purpose: they reach a real manga site, and a site that is
down for its own reasons must not be able to fail somebody's pull request. The
cost of that was silent — the entire reader and downloader path was exercised by
nothing automated, so a bug in page resolution or in the download queue could
reach a release with four green workflows behind it.

Recording splits the question in two:

| question | answered by | where |
|---|---|---|
| does the reader do the right thing with a response? | `npm run test:replay` | CI, every PR |
| do the sites still answer that way? | `npm test` | by hand, deliberately |

The second half cannot be automated without taking somebody else's uptime as a
dependency. It is still worth running before a tag.

## Re-recording

```bash
npm run test:record
```

Runs the suite against the real sites and overwrites `http/` with what came
back. It needs the internet and takes a couple of minutes. Do it when a check
starts failing with `No fixture for GET …`, which is what a request the
recording does not have looks like — a new call, a changed search term, or a
source whose URLs moved.

Commit the result. The recordings are part of the repository so a fresh clone,
and a runner with no reason to trust the internet, can both run `test:replay`.

## What is in a recording

One file per request, named for the SHA-256 of `METHOD url`, holding the status,
the response headers as recorded, and the body.

- **JSON bodies are stored as JSON**, not base64, so a recording can be read and
  a change to one can be reviewed. The body is re-serialised on replay, so it is
  not byte-identical; nothing depends on that, because every caller parses it.
- **Image bodies are replaced with a 1×1 transparent PNG**, and the original
  size is kept in `imageReplacedWithPixel`. The checks that read them assert
  that the bytes are not empty and that the file extension came from the
  `content-type` header rather than the URL — both hold on 67 bytes, and the
  alternative is committing several megabytes of somebody else's artwork to a
  public repository to prove a file was written.
- **Headers are kept as recorded**, images included: `content-type` is what the
  downloader derives the extension from, so replacing the bytes must not replace
  the label on them.

`../fixture-fetch.mjs` is the whole mechanism. It is loaded with `node --import`
in front of the server, so nothing in `server/src` imports it and the runtime
image carries no test code. The only thing the server itself knows about any of
this is one line in `sources/http.ts` that drops the per-host interval to zero
while replaying — there is no host on the other end to be polite to, and twenty
pages spaced two seconds apart would turn a four-second test into a minute of
sleeping.

In replay the network is never touched: the real `fetch` is captured but only
called when recording, and a request with no recording throws by name rather
than returning nothing.

## Provenance

The responses come from [MangaDex](https://mangadex.org)'s public API, searched
for one title, and are here only so this repository can test its own reader.
