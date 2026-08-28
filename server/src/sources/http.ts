/**
 * The one HTTP client every source talks through.
 *
 * The server this replaces got politeness for free: each Tachiyomi extension
 * carried its own OkHttp interceptor chain, and the embedded Chromium kept the
 * cookies. Node's `fetch` has neither, so both live here — and centralising them
 * is the only way to guarantee the property the sites actually care about:
 * **one request at a time per hostname, spaced out, with a ceiling on how many
 * hosts we talk to at once**.
 *
 * Read the constants below before changing any of them. Every one exists to
 * keep this server's IP from being banned, which is a permanent, unappealable
 * failure — a slow search is always the better trade. Fan out over a scanlation
 * site with six parallel connections, or let FlareSolverr re-solve a challenge
 * in a loop, and the site stops answering this address for good.
 *
 * A source never gets this object directly. `clientFor()` hands it a `SourceHttp`
 * bound to that source's name, rate and headers, so a source cannot opt out of
 * the queue by accident.
 */
import { load } from 'cheerio';
import type { Config } from '../config.js';
import { CloudflareBlockedError, type SourceHttp, type SourceRequestInit } from './types.js';
import { createSolver, type Solver } from './flaresolverr.js';

// ------------------------------------------------------- politeness policy --
//
// These are ban-avoidance limits, not performance tuning. Lowering one makes
// this server look more like a scraper and less like a reader.

/**
 * Floor between two requests to a host that has shown it is behind Cloudflare.
 * ~0.8 requests a second.
 *
 * This is the number that must not be lowered. A host that has challenged us is
 * one watching for exactly this pattern, and being challenged again right after
 * a solve is how a solve turns into a block.
 */
const MIN_INTERVAL_MS = 1300;
/**
 * Floor for every other host.
 *
 * Applying the Cloudflare number everywhere cost far more than it bought: with
 * hundreds of installed sources a sweep spent nearly all its time waiting on
 * hosts that had never so much as rate-limited us. A quarter second is still an
 * interval — no host is ever asked two things at once, and the jitter below
 * still applies — but it is paced for a reader rather than for a challenge.
 */
const CALM_INTERVAL_MS = 250;
/** ±30% noise on that floor, so the traffic has no machine-perfect period. */
const INTERVAL_JITTER = 0.3;
/**
 * Requests in flight across *all* hosts.
 *
 * Four was chosen when a fan-out meant six catalogues. It now means several
 * hundred, and the protection that matters is per host — an interval each, a
 * breaker each — so a global ceiling this low mostly decides how long the reader
 * waits, not how hard any one site is hit.
 */
const MAX_IN_FLIGHT = 16;
/** Total tries per request, first attempt included. */
const MAX_ATTEMPTS = 3;
/**
 * True only while the smoke suite is replaying recorded HTTP.
 *
 * The spacing below exists so a site is never asked two things at once and
 * never at a machine-perfect period. In replay there is no site: every response
 * comes off the local disk, and a downloader that waits two seconds between
 * twenty pages turns a fifteen-second test into a minute of sleeping for
 * politeness nobody is owed.
 *
 * This is the whole of what the server knows about fixtures — the recording and
 * replaying itself is in `test/fixture-fetch.mjs`, loaded with `--import` from
 * outside, so no test code is in this bundle. Nothing but that suite sets these
 * variables, and recording deliberately does not take this branch: a real site
 * is on the other end then, and it gets the real intervals.
 */
const REPLAYING =
  process.env.S4M_FIXTURES !== undefined && process.env.S4M_FIXTURES_MODE === 'replay';
/** First backoff; doubles per attempt, jittered, capped. */
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
/**
 * Consecutive *soft* failures before a host is left alone entirely — a 503, a
 * reset mid-response, the kinds of thing that do come back.
 *
 * A host that cannot be reached at all does not get five chances: see
 * `unreachable` below.
 */
const BREAKER_FAILURES = 5;
const BREAKER_COOLDOWN_MS = 5 * 60_000;
/**
 * Per-request budget. Long enough for a slow WordPress, short enough to fail.
 *
 * Was 30s, which is not a budget so much as a promise to wait. A scanlation site
 * that has sent nothing in fifteen seconds is not about to; meanwhile every
 * sweep paid that in full for each host that had quietly disappeared, three
 * times over.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * A current desktop Chrome string. Several of the sites here 403 anything that
 * announces itself as a bot or ships no UA at all, and Cloudflare's managed
 * rules score a missing Accept-Language as automation.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

export interface SourceHttpOptions {
  /** Used in the error message when Cloudflare or the breaker wins. */
  sourceName: string;
  /** Milliseconds between two requests to the same host. Never below the floor. */
  minIntervalMs?: number;
  timeoutMs?: number;
  attempts?: number;
  /** Sent on every request — a Referer, an API key header, an Origin. */
  headers?: Record<string, string>;
}

/** What the registry holds: one shared jar and queue set, many bound clients. */
export interface HttpClient {
  clientFor(options: SourceHttpOptions): SourceHttp;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** ±`INTERVAL_JITTER` around `ms`, never negative. */
function jitter(ms: number): number {
  const spread = ms * INTERVAL_JITTER;
  return Math.max(0, ms - spread + Math.random() * spread * 2);
}

// ------------------------------------------------------------- cookie jar --

/**
 * Per-host, name → value, in memory only.
 *
 * Deliberately not a full RFC 6265 store: no domain matching, no paths, no
 * expiry. What it exists for is the session cookie a site hands out on the first
 * page and expects back on the second — and `cf_clearance`, which is the whole
 * point of caching anything here: a clearance cookie that is kept and reused is
 * a challenge that does not have to be solved again.
 *
 * A clearance is bound to the browser that earned it, so the User-Agent that
 * came back from the solver is stored beside it and sent with it. Sending the
 * cookie under a different UA invalidates it immediately and asks for a fresh
 * challenge, which is exactly the loop that gets an address banned.
 */
class CookieJar {
  private readonly byHost = new Map<string, Map<string, string>>();
  private readonly agents = new Map<string, string>();

  header(host: string): string | undefined {
    const jar = this.byHost.get(host);
    if (!jar || jar.size === 0) return undefined;
    return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  userAgent(host: string): string {
    return this.agents.get(host) ?? USER_AGENT;
  }

  bindUserAgent(host: string, userAgent: string): void {
    this.agents.set(host, userAgent);
  }

  store(host: string, setCookies: string[]): void {
    if (setCookies.length === 0) return;
    let jar = this.byHost.get(host);
    if (!jar) {
      jar = new Map();
      this.byHost.set(host, jar);
    }
    for (const raw of setCookies) {
      const pair = raw.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // An empty value is how a site deletes a cookie; keeping it would send
      // `name=` forever and some backends treat that as a corrupt session.
      if (value === '') jar.delete(name);
      else jar.set(name, value);
    }
  }

  put(host: string, name: string, value: string): void {
    this.store(host, [`${name}=${value}`]);
  }

  /**
   * One cookie's value, for the rare source that has to *read* what a site set
   * rather than just send it back.
   *
   * MangaHub is the case this exists for: the site hands out an `mhub_access`
   * cookie and its API — on a different host, so the jar would never send it —
   * wants that same value in an `x-mhub-access` header. Reading it here is the
   * alternative to letting a source parse `Set-Cookie` itself, which would mean
   * a second, unshared jar going stale beside this one.
   */
  value(host: string, name: string): string | undefined {
    return this.byHost.get(host)?.get(name);
  }
}

// ------------------------------------------------------- global concurrency --

/** FIFO permit counter. Fair on purpose: a starved host would retry forever. */
class Semaphore {
  private available: number;
  private readonly waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.available = permits;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.available += 1;
  }
}

// ------------------------------------------------------------ host queues --

/**
 * One promise chain per hostname. Every request appends itself to its host's
 * chain, so requests to different sites still overlap (up to the global
 * ceiling) while requests to the same site are strictly serial and never closer
 * together than the jittered interval.
 */
class HostQueues {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly lastStart = new Map<string, number>();

  run<T>(host: string, intervalMs: number, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(host) ?? Promise.resolve();
    const next = previous.then(async () => {
      const wait = (this.lastStart.get(host) ?? 0) + jitter(intervalMs) - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastStart.set(host, Date.now());
      return work();
    });
    // The tail must not reject, or every later request on this host would be
    // rejected with someone else's error before it ever ran.
    this.tails.set(
      host,
      next.catch(() => undefined),
    );
    return next;
  }
}

// -------------------------------------------------------- circuit breaker --

/**
 * Stops talking to a host that has failed repeatedly.
 *
 * A site that is down, or that has started refusing us, gets nothing further for
 * the cooldown — which is the difference between noticing an outage and adding
 * thousands of requests to it. Only hard failures count: a 404 is a perfectly
 * good answer, and tripping on one would take a source offline over a dead link.
 */
class Breaker {
  private readonly failures = new Map<string, number>();
  private readonly openUntil = new Map<string, number>();

  check(host: string, sourceName: string): void {
    const until = this.openUntil.get(host) ?? 0;
    if (until <= Date.now()) return;
    const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
    throw new Error(
      `${sourceName} is not responding (${host}). Not retrying for another ${minutes} minute${
        minutes === 1 ? '' : 's'
      }.`,
    );
  }

  succeeded(host: string): void {
    this.failures.delete(host);
    this.openUntil.delete(host);
  }

  failed(host: string): void {
    const count = (this.failures.get(host) ?? 0) + 1;
    this.failures.set(host, count);
    if (count >= BREAKER_FAILURES) {
      this.openUntil.set(host, Date.now() + BREAKER_COOLDOWN_MS);
      this.failures.delete(host);
    }
  }

  /**
   * A host that could not be reached at all, closed on the first failure.
   *
   * Five chances made sense when the failure might be transient. This one is
   * not: every sweep that follows would spend the whole timeout rediscovering
   * the same absence, for every source on that host, for as long as it is gone.
   */
  unreachable(host: string): void {
    this.openUntil.set(host, Date.now() + BREAKER_COOLDOWN_MS);
    this.failures.delete(host);
  }
}

/**
 * Whether a failure means "this host is not there", as opposed to "this went
 * wrong once".
 *
 * The distinction is worth its own function because retrying the two costs
 * opposite things. A 503 or a reset mid-response is worth another go. A name
 * that does not resolve, a refused connection, or a socket that never answered
 * cannot succeed on the second attempt for the same reason it failed on the
 * first — and with a 15s timeout, three attempts and backoff, insisting costs
 * the best part of a minute per dead host. One measured sweep of 24 sources took
 * 97s, of which 97s was a single host that no longer exists.
 */
function unreachable(error: unknown): boolean {
  const name = (error as Error)?.name;
  // AbortSignal.timeout rejects with TimeoutError; older shapes use AbortError.
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const code = (error as NodeJS.ErrnoException)?.code
    ?? ((error as { cause?: NodeJS.ErrnoException })?.cause?.code);
  return (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  );
}

// --------------------------------------------------------------- retrying --

/** Retried, and counted against the breaker. Anything else is a real answer. */
const RETRIABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * `Retry-After` is either a delay in seconds or an HTTP date, and both appear.
 * Whatever it says is obeyed exactly: it is the one place a site tells us how
 * to stay welcome, and shortening it is how a 429 becomes a block.
 */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function backoffMs(attempt: number): number {
  return jitter(Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS));
}

// --------------------------------------------------------- cloudflare tell --

/**
 * The three ways a challenge shows up, in the order they cost anything to check.
 * `cf-mitigated: challenge` is the modern, explicit one; the id-based markers
 * cover the interstitial that older zones still serve with a 503.
 */
function isChallenge(status: number, headers: Headers, body: string | undefined): boolean {
  if (status !== 403 && status !== 503) return false;
  if (headers.get('cf-mitigated') === 'challenge') return true;
  if (body === undefined) return false;
  return (
    body.includes('__cf_chl') ||
    body.includes('/cdn-cgi/challenge-platform') ||
    body.includes('cf-browser-verification') ||
    // Matched on the phrase rather than the whole tag: zones localise this title
    // and prepend to it ("Checking your browser before accessing. Just a
    // moment..."), and an exact match on the English form reports those as a
    // plain 403 — which reads as the site refusing us, rather than as a
    // challenge nobody tried to solve.
    /<title>[^<]*just a moment/i.test(body)
  );
}

/**
 * FlareSolverr answers with the rendered *page*, so a JSON endpoint comes back
 * wrapped in the browser's HTML view of it. Unwrapping the `<pre>` is how the
 * JSON gets back out; a body that never was HTML falls through unchanged.
 */
function unwrapSolvedBody(html: string): string {
  const trimmed = html.trimStart();
  if (!trimmed.startsWith('<')) return html;
  const $ = load(html);
  const pre = $('pre').first().text();
  return pre.trim() !== '' ? pre : html;
}

// ------------------------------------------------------------------ client --

export function createHttpClient(config: Pick<Config, 'flaresolverr'>): HttpClient {
  const jar = new CookieJar();
  const queues = new HostQueues();
  const breaker = new Breaker();
  /**
   * Hosts that have answered with a Cloudflare challenge at least once.
   *
   * Membership is what earns the slow interval. It is learned rather than
   * configured because a site turns Cloudflare on and off without telling
   * anybody, and a list in a config file is wrong the day after it is written.
   * Nothing removes a host once added: the cost of staying slow for a site that
   * has relaxed is a slower sweep, and the cost of the opposite is a block.
   */
  const challenged = new Set<string>();

  const inFlight = new Semaphore(MAX_IN_FLIGHT);
  const solver: Solver = createSolver(config.flaresolverr);

  async function once(
    url: string,
    init: SourceRequestInit,
    options: SourceHttpOptions,
    wantBody: boolean,
  ): Promise<{ response: Response; body?: string }> {
    const host = new URL(url).hostname;
    const headers: Record<string, string> = {
      // Whatever browser earned this host's clearance cookie, if any: the two
      // are only valid together.
      'User-Agent': jar.userAgent(host),
      'Accept-Language': 'en-US,en;q=0.9',
      ...options.headers,
      ...init.headers,
    };
    const cookies = jar.header(host);
    if (cookies) headers.Cookie = cookies;
    if (init.body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    await inFlight.acquire();
    try {
      const response = await fetch(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        redirect: 'follow',
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      jar.store(host, response.headers.getSetCookie());
      // Reading the body has to happen inside the permit, not after it: a slow
      // body held open is still a connection the site is counting.
      return { response, body: wantBody ? await response.text() : undefined };
    } finally {
      inFlight.release();
    }
  }

  function request(
    url: string,
    init: SourceRequestInit,
    options: SourceHttpOptions,
    wantBody: boolean,
  ): Promise<{ response: Response; body?: string }> {
    const host = new URL(url).hostname;
    // A source may still ask for a slower floor than its tier gives it; nothing
    // may ask for a faster one.
    const floor = challenged.has(host) ? MIN_INTERVAL_MS : CALM_INTERVAL_MS;
    const interval = REPLAYING ? 0 : Math.max(floor, options.minIntervalMs ?? 0);
    const attempts = Math.min(options.attempts ?? MAX_ATTEMPTS, MAX_ATTEMPTS);

    return queues.run(host, interval, async () => {
      breaker.check(host, options.sourceName);
      let lastError: unknown;
      /** Whether a clearance solve has already been spent on a non-GET here. */
      let solvedForPost = false;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        let result: { response: Response; body?: string };
        try {
          result = await once(url, init, options, wantBody);
        } catch (error) {
          lastError = error;
          // Not there at all: further attempts cannot succeed, and the next
          // sweep should not rediscover this the slow way either.
          if (unreachable(error)) {
            breaker.unreachable(host);
            break;
          }
          // TLS, a reset mid-response: worth one more go, and worth counting.
          breaker.failed(host);
          if (attempt === attempts) break;
          await sleep(backoffMs(attempt));
          continue;
        }

        const { response, body } = result;
        if (isChallenge(response.status, response.headers, body)) {
          // This host is behind Cloudflare, so every later request to it takes
          // the slow interval — including the ones already queued behind this.
          challenged.add(host);

          // A solve is a browser fetching a page, and a browser fetching a page
          // is a GET. Handing it a POST dropped the method and the body in
          // silence: the site answered "Cannot GET /graphql", which reads like a
          // broken endpoint rather than like the request having been rewritten
          // underneath us. Every POST this server makes — admin-ajax, the themed
          // chapter endpoints, GraphQL — was affected from the moment its host
          // started challenging.
          //
          // The solve is still the right move; what it earns is a `cf_clearance`
          // cookie in the jar. With that in hand the real request can go
          // straight out, so solve the *origin* — a GET, and the page a browser
          // would have visited anyway — and then send the original request once
          // more as itself. Once per call: a second challenge after clearance is
          // a refusal, not a race.
          if ((init.method ?? 'GET').toUpperCase() !== 'GET' && !solvedForPost) {
            solvedForPost = true;
            await solveOnce(new URL(url).origin, options);
            continue;
          }

          // Solving is a whole browser round-trip and the single most
          // ban-worthy thing this server does; never retry the plain request
          // first, and leave the loop either way.
          return { response, body: await solveOnce(url, options) };
        }
        if (response.ok || !RETRIABLE_STATUS.has(response.status)) {
          // A 404 or a 403 is an answer. Repeating it would be pure noise in
          // somebody's rate-limit bucket.
          breaker.succeeded(host);
          return result;
        }

        lastError = new Error(`${response.status} ${response.statusText} for ${url}`);
        breaker.failed(host);
        if (attempt === attempts) break;
        const after = retryAfterMs(response.headers.get('retry-after'));
        await sleep(after ?? backoffMs(attempt));
      }

      throw lastError instanceof Error ? lastError : new Error(`Request failed: ${url}`);
    });
  }

  /** See `solveOnce`: one solve at a time, one per host per cooldown. */
  let solveChain: Promise<unknown> = Promise.resolve();
  const lastSolveAt = new Map<string, number>();
  const solving = new Map<string, Promise<string>>();

  function solveOnce(url: string, options: SourceHttpOptions): Promise<string> {
    if (!solver.available) throw new CloudflareBlockedError(options.sourceName);
    const host = new URL(url).hostname;

    // Everyone who hit the same wall waits on the same solve. Two browsers
    // answering the same challenge is the fastest way to be flagged.
    const pending = solving.get(host);
    if (pending) return pending;

    const since = Date.now() - (lastSolveAt.get(host) ?? 0);
    if (since < solver.hostCooldownMs) {
      const minutes = Math.max(1, Math.ceil((solver.hostCooldownMs - since) / 60_000));
      throw new Error(
        `${options.sourceName} challenged us again right after a solve. ` +
          `Backing off for ${minutes} minute${minutes === 1 ? '' : 's'} rather than re-solving.`,
      );
    }

    // Serialised across every host as well: FlareSolverr drives one real
    // browser, and running solves concurrently is both slower and louder.
    const run = solveChain.then(async () => {
      lastSolveAt.set(host, Date.now());
      const solved = await solver.get(url, jar.userAgent(host));
      // The clearance cookie and the UA that earned it must travel together.
      jar.bindUserAgent(host, solved.userAgent);
      for (const cookie of solved.cookies) jar.put(host, cookie.name, cookie.value);
      return solved.html;
    });

    solving.set(host, run);
    // Both branches handled, so the bookkeeping promise can never surface as an
    // unhandled rejection; the caller holds the only one that can throw.
    run.then(
      () => solving.delete(host),
      () => solving.delete(host),
    );
    solveChain = run.catch(() => undefined);
    return run;
  }

  async function textOf(
    url: string,
    init: SourceRequestInit,
    options: SourceHttpOptions,
  ): Promise<string> {
    if (init.solveCloudflare) {
      // Asking for a solve is itself proof the host is behind Cloudflare, and it
      // is the only signal available before the first challenge is ever seen.
      challenged.add(new URL(url).hostname);
      return solveOnce(url, options);
    }
    const { response, body } = await request(url, init, options, true);
    if (!response.ok && !isChallenge(response.status, response.headers, body)) {
      throw new Error(`${response.status} ${response.statusText} for ${url}`);
    }
    return body ?? '';
  }

  return {
    clientFor(options: SourceHttpOptions): SourceHttp {
      return {
        text: (url, init = {}) => textOf(url, init, options),

        async json<T>(url: string, init: SourceRequestInit = {}) {
          const raw = await textOf(url, init, options);
          try {
            return JSON.parse(unwrapSolvedBody(raw)) as T;
          } catch {
            throw new Error(`${url} did not answer with JSON`);
          }
        },

        cookie(url, name) {
          try {
            return jar.value(new URL(url).hostname, name);
          } catch {
            return undefined;
          }
        },

        async raw(url, init = {}) {
          // No body read here: the caller wants the bytes, and a challenge on an
          // image request shows up as the header alone often enough to act on.
          // Page images go through the same per-host queue as everything else,
          // so a chapter downloads one image at a time, spaced out.
          const { response } = await request(url, init, options, false);
          if (isChallenge(response.status, response.headers, undefined)) {
            challenged.add(new URL(url).hostname);
            throw new CloudflareBlockedError(options.sourceName);
          }
          if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText} for ${url}`);
          }
          return response;
        },
      };
    },
  };
}

export { USER_AGENT, MIN_INTERVAL_MS, MAX_IN_FLIGHT };
