/**
 * The request pipeline: authenticate, then either serve the app or hand the
 * request to the GraphQL/REST layer.
 *
 * Everything is same-origin. That is what makes this design cheap on the UI
 * side: the session cookie rides along on the GraphQL posts, on the REST
 * progress updates, and — the part no bearer token could have covered — on every
 * `<img>` that fetches a cover or a manga page.
 *
 * The only thing this server lets an anonymous request do is attempt a sign-in.
 * There is no registration, no first-run claim and no password recovery:
 * accounts exist because somebody with a shell on this machine created one,
 * which is the smallest surface this can have.
 */
import type { RequestListener } from 'node:http';

import type { AppDeps, Req, Res, Session } from '../types.js';
import { DUMMY_HASH, verifyPassword } from './crypto.js';
import { loginPage } from './pages.js';
import { LoginLimiter } from './ratelimit.js';
import { serveIndex, serveStatic } from './static.js';
import {
  COOKIE_NAME,
  SessionStore,
  clearedCookie,
  parseCookies,
  sessionCookie,
} from './sessions.js';

const LOGIN_PATH = '/gateway/login';
const MAX_BODY_BYTES = 64 * 1024;

/**
 * The sign-in page is entirely self-contained, so it can afford the strict
 * policy the app itself cannot: no external anything, and no framing.
 */
const PRE_AUTH_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; form-action 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'";

/** Methods that can change something, and so must be shown not to be a cross-site forgery. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface UserRow {
  username: string;
  display_name: string;
  password: string;
  password_changed_at: number;
}

function json(res: Res, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

async function readJsonBody(req: Req): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    // A sign-in body is a few hundred bytes. Anything larger is not a sign-in.
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * The address to rate-limit against.
 *
 * Behind a reverse proxy the socket address is the proxy for everybody, which
 * would turn a per-IP limiter into a global one — one person mistyping their
 * password would lock out the household. The rightmost forwarded entry is the
 * one the trusted proxy appended itself, so it is the only one an outside
 * client cannot write.
 */
export function clientIp(req: Req, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const parts = String(forwarded).split(',');
      const last = parts[parts.length - 1]?.trim();
      if (last) return last;
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** A same-origin check, used instead of CSRF tokens: nothing here is stateful enough to need them. */
export function sameOrigin(req: Req, publicOrigin: string): boolean {
  const origin = req.headers.origin;
  if (origin) return origin === publicOrigin;

  // Browsers omit Origin on same-origin GET/HEAD, which the caller has already
  // excluded. When they omit it on an unsafe method, Fetch Metadata still tells
  // us where the request came from.
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';

  // Neither header: not a browser we can vouch for. Refuse rather than assume.
  return false;
}

/** Whether this is a page load (which deserves the sign-in screen) or a fetch (which deserves a 401). */
export function isNavigation(req: Req): boolean {
  if (req.headers['sec-fetch-mode'] === 'navigate') return true;
  if (req.headers['sec-fetch-mode']) return false;
  return String(req.headers.accept ?? '').includes('text/html');
}

function securityHeaders(secure: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    // Nothing about a private library should be embeddable anywhere.
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  if (secure) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

/** Only ever redirect somewhere on this site: an open redirect on a sign-in page is how a convincing phishing link gets made. */
function safePath(candidate: string): string {
  return candidate.startsWith('/') && !candidate.startsWith('//') ? candidate : '/';
}

export function createApp(deps: AppDeps): RequestListener {
  const { config, db, log } = deps;
  const sessions = new SessionStore(db, config.session);
  const limiter = new LoginLimiter(config.login);
  const crossOrigin = {
    error: 'cross_origin',
    message: 'Refused: this request did not come from the app.',
  };

  // Expired rows and stale lockout buckets are cheap to leave lying around for a
  // minute and expensive to leave forever. unref'd so it never keeps the process
  // alive on its own during shutdown.
  setInterval(() => {
    try {
      sessions.sweep();
      limiter.sweep();
    } catch (error) {
      log.warn(`sweep failed: ${(error as Error).message}`);
    }
  }, 60_000).unref();

  const userByName = (username: string): UserRow | undefined =>
    db.get<UserRow>(
      'SELECT username, display_name, password, password_changed_at FROM users WHERE username = ?',
      username,
    );

  async function handleLogin(req: Req, res: Res): Promise<void> {
    if (!sameOrigin(req, config.publicOrigin)) return json(res, 403, crossOrigin);

    let body: Record<string, unknown>;
    try {
      body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: 'bad_request', message: 'Malformed sign-in request.' });
    }

    const username = String(body.username ?? '')
      .trim()
      .toLowerCase();
    const password = String(body.password ?? '');
    const ip = clientIp(req, config.trustProxy);
    // Two keys, two attacks: one address working through usernames, and many
    // addresses working on one account. Counting only the first would let the
    // second through unremarked.
    const keys = [`ip:${ip}`, `user:${username}`];

    const wait = limiter.retryAfter(keys);
    if (wait > 0) {
      return json(
        res,
        429,
        { error: 'rate_limited', retryAfterMs: wait },
        { 'Retry-After': String(Math.ceil(wait / 1000)) },
      );
    }

    // Read fresh rather than from a cache: an account added or removed from the
    // command line while the server runs takes effect on the next attempt, with
    // no restart.
    const user = userByName(username);
    // Hash even when the username is unknown, against the stored hash of a
    // password nobody has: a sign-in that fails fast is a sign-in that tells an
    // attacker the account does not exist.
    const ok = await verifyPassword(password, user ? user.password : DUMMY_HASH);

    if (!user || !ok) {
      limiter.recordFailure(keys);
      log.warn(`failed sign-in for "${username}" from ${ip}`);
      // One message for both cases, deliberately.
      return json(res, 401, { error: 'invalid_credentials', message: null });
    }

    limiter.recordSuccess(keys);
    const id = sessions.create(user.username);
    log.info(`signed in "${user.username}" from ${ip}`);

    return json(
      res,
      200,
      {
        username: user.username,
        displayName: user.display_name,
        redirect: safePath(String(body.redirect ?? '/')),
      },
      {
        'Set-Cookie': sessionCookie(id, {
          secure: config.secureCookies,
          maxAgeSeconds: Math.floor(config.session.idleMs / 1000),
        }),
      },
    );
  }

  async function handle(req: Req, res: Res): Promise<void> {
    for (const [name, value] of Object.entries(securityHeaders(config.secureCookies))) {
      res.setHeader(name, value);
    }

    const url = new URL(req.url ?? '/', config.publicOrigin);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[COOKIE_NAME];
    const live = sessions.touch(sessionId);

    let user = live ? userByName(live.username) : undefined;
    // A session issued before the account's password was last changed is no
    // longer trusted: this is what makes `s4m users passwd` genuinely sign out
    // the phone somebody left signed in, rather than only stopping the next
    // sign-in.
    if (live && user && user.password_changed_at > live.createdAt) {
      sessions.destroy(sessionId);
      user = undefined;
    }
    const username = user ? user.username : null;

    if (path === '/gateway/health') {
      return json(res, 200, {
        ok: true,
        users: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0,
        sessions: sessions.size,
      });
    }

    if (path === LOGIN_PATH) {
      if (method === 'POST') return handleLogin(req, res);
      if (method === 'GET' || method === 'HEAD') {
        if (username) {
          res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        const body = loginPage({ redirect: safePath(url.searchParams.get('redirect') ?? '/') });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(Buffer.byteLength(body)),
          'Cache-Control': 'no-store',
          'Content-Security-Policy': PRE_AUTH_CSP,
        });
        res.end(method === 'HEAD' ? undefined : body);
        return;
      }
      return json(res, 405, { error: 'method_not_allowed' });
    }

    if (path === '/gateway/logout') {
      if (method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      if (!sameOrigin(req, config.publicOrigin)) return json(res, 403, crossOrigin);
      sessions.destroy(sessionId);
      return json(
        res,
        200,
        { ok: true },
        { 'Set-Cookie': clearedCookie({ secure: config.secureCookies }) },
      );
    }

    if (path === '/gateway/me') {
      if (!user) return json(res, 401, { error: 'unauthenticated' });
      return json(res, 200, { username: user.username, displayName: user.display_name });
    }

    if (!username) {
      if (isNavigation(req)) {
        const target = `${LOGIN_PATH}?redirect=${encodeURIComponent(path + url.search)}`;
        res.writeHead(303, { Location: target, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      // A fetch or an image: answer in a way the app can act on. The UI turns
      // this into a trip back to the sign-in page rather than an empty library.
      // The cookie goes too, so a session killed by a password change does not
      // cost a database lookup on every following request.
      return json(
        res,
        401,
        { error: 'unauthenticated', message: 'Your session has ended. Sign in again.' },
        live ? { 'Set-Cookie': clearedCookie({ secure: config.secureCookies }) } : {},
      );
    }

    if (UNSAFE_METHODS.has(method) && !sameOrigin(req, config.publicOrigin)) {
      return json(res, 403, crossOrigin);
    }

    const session: Session = { username };

    if (path === '/api/graphql') {
      if (method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      return deps.graphql(req, res, session);
    }

    if (path === '/api/v1' || path.startsWith('/api/v1/')) {
      if (await deps.api(req, res, session, url)) return;
      return json(res, 404, { error: 'not_found' });
    }

    // Nothing else under /api exists; falling through would serve the app shell
    // to a fetch that expected JSON.
    if (path === '/api' || path.startsWith('/api/')) {
      return json(res, 404, { error: 'not_found' });
    }

    if (method !== 'GET' && method !== 'HEAD') {
      return json(res, 405, { error: 'method_not_allowed' });
    }

    if (serveStatic(req, res, config.uiDist, path)) return;
    // Every other path belongs to the client-side router: /manga/12, /settings,
    // /handle/oauth/result.
    return serveIndex(res, config.uiDist);
  }

  return (req, res) => {
    void handle(req, res).catch((error: unknown) => {
      log.error(`unhandled: ${(error as Error)?.stack ?? String(error)}`);
      if (!res.headersSent) json(res, 500, { error: 'internal', message: 'Something went wrong.' });
      else res.destroy();
    });
  };
}
