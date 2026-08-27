/**
 * The escape hatch for Cloudflare, and the only remaining reason this server
 * ever needs a browser.
 *
 * The Java server carried a 547 MB embedded Chromium so an extension could solve
 * an interstitial in-process. Here that job is delegated to a FlareSolverr
 * container the operator may or may not run: when `flaresolverr.url` is empty
 * this module reports itself unavailable and the caller raises
 * `CloudflareBlockedError`, which the UI renders as "configure a solver" rather
 * than as a broken source.
 *
 * Only `request.get` is used. FlareSolverr's session API would keep a browser
 * tab alive between calls, which is faster but leaks a tab per source whenever
 * anything throws; a fresh solve costs seconds and only happens when a site has
 * already decided to challenge us.
 *
 * Nothing here decides *when* to solve. `http.ts` owns that, and the rules are
 * the ban-avoidance ones: the clearance cookie and the browser UA that earned it
 * are cached together and reused until a request carrying them is challenged
 * again, only one solve runs at a time across the whole server, and a host that
 * was just solved is refused rather than solved again inside `HOST_COOLDOWN_MS`.
 */

export interface SolvedCookie {
  name: string;
  value: string;
}

export interface SolvedPage {
  html: string;
  cookies: SolvedCookie[];
  /** What the solver's browser sent, so later plain requests can match it. */
  userAgent: string;
}

export interface Solver {
  readonly available: boolean;
  /**
   * How long a host must be left alone after a solve before another one is
   * allowed. The caller enforces it; it lives here because it is a property of
   * how expensive and how conspicuous a solve is, not of any one source.
   */
  readonly hostCooldownMs: number;
  get(url: string, userAgent: string): Promise<SolvedPage>;
}

interface FlareSolverrResponse {
  status: string;
  message?: string;
  solution?: {
    url: string;
    status: number;
    response: string;
    userAgent: string;
    cookies: { name: string; value: string }[];
  };
}

export interface SolverConfig {
  url: string;
  timeoutMs: number;
}

/**
 * Minimum gap between two solves for the same host.
 *
 * A solve is a real browser answering a real challenge, and repeating that
 * quickly is the single most reliable way to turn "challenged" into "banned".
 * Fifteen minutes is longer than any legitimate reading session needs and short
 * enough that a clearance which genuinely expired can be renewed. Do not lower
 * it to make a source feel faster — the failure it prevents is permanent.
 */
const HOST_COOLDOWN_MS = 15 * 60_000;

/**
 * FlareSolverr's API is `POST /v1`; its root answers a readiness banner on GET
 * and 405 on POST. Every example anybody copies — this project's own installer
 * help included — writes the URL as `http://127.0.0.1:8191`, so requiring the
 * suffix means the documented value produces "FlareSolverr answered 405" on
 * every challenged source, which reads as the solver being broken rather than
 * as one missing path segment.
 *
 * Both spellings are therefore accepted, and a URL that already names a version
 * is left alone.
 */
function apiEndpoint(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed === '' || /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export function createSolver(config: SolverConfig): Solver {
  const endpoint = apiEndpoint(config.url);
  if (endpoint === '') {
    return {
      available: false,
      hostCooldownMs: HOST_COOLDOWN_MS,
      get() {
        return Promise.reject(new Error('FlareSolverr is not configured'));
      },
    };
  }

  return {
    available: true,
    hostCooldownMs: HOST_COOLDOWN_MS,
    async get(url: string, userAgent: string): Promise<SolvedPage> {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cmd: 'request.get',
          url,
          maxTimeout: config.timeoutMs,
        }),
        // The solver drives a real browser through the challenge, so it is
        // slower than the page it is fetching; give it its own budget plus
        // slack for starting the browser at all.
        signal: AbortSignal.timeout(config.timeoutMs + 15_000),
      });

      if (!response.ok) {
        throw new Error(`FlareSolverr answered ${response.status} for ${url}`);
      }

      const body = (await response.json()) as FlareSolverrResponse;
      if (body.status !== 'ok' || !body.solution) {
        throw new Error(`FlareSolverr could not solve ${url}: ${body.message ?? body.status}`);
      }

      return {
        html: body.solution.response,
        cookies: body.solution.cookies.map(({ name, value }) => ({ name, value })),
        // FlareSolverr's browser has its own UA and the clearance cookie is
        // bound to it; sending a different one afterwards invalidates it.
        userAgent: body.solution.userAgent || userAgent,
      };
    },
  };
}
