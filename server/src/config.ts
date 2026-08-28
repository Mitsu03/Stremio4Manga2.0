/**
 * Deployment settings, hand-edited, read once at boot.
 *
 * Everything that used to describe *instances* is gone: there is no java.jar, no
 * port range, no per-account data directory, because there is one process now.
 * What is left is the front door (origin, listen address, proxy trust), the two
 * rate/session policies, where data lives, and the optional Cloudflare solver.
 *
 * Relative paths resolve against the config file's own directory, so a config
 * can be moved with its data and keep working.
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Config {
  /** Where the app is reached from, e.g. https://manga.example.com. Required. */
  publicOrigin: string;
  listen: { host: string; port: number };
  /**
   * On behind Caddy/nginx, off with nothing in front — X-Forwarded-For is
   * spoofable otherwise, and the rate limiter would bucket a whole household as
   * one client the other way round.
   */
  trustProxy: boolean;
  secureCookies: boolean;
  /** Root for the database, downloads, backups and the page cache. */
  dataDir: string;
  /** The built UI. */
  uiDist: string;
  session: { idleMs: number; absoluteMs: number };
  login: { maxFailures: number; windowMs: number; lockoutMs: number };
  flaresolverr: { url: string; timeoutMs: number };
  /**
   * Where a source's icon may be looked up when the site itself yields none.
   *
   * `none` is the default and keeps the promise the icon code is built on: the
   * only host ever contacted for a source's icon is that source's own site.
   * `google` adds a last resort for the sites that block us outright — about a
   * fifth of the catalogue sits behind Cloudflare and refuses even a favicon —
   * at the cost of telling Google which manga domains this server catalogues.
   * One request per site, once, then cached; a reader's browser is never
   * involved either way. Off unless an operator turns it on deliberately.
   */
  icons: { fallback: 'none' | 'google' };
  logging: { file: string; maxBytes: number; keep: number };
}

const DAY = 24 * 60 * 60 * 1000;

function defaultDataDir(): string {
  if (platform() === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(local, 'Stremio4Manga');
  }
  const xdg = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(xdg, 'stremio4manga');
}

export function defaultConfigPath(root: string): string {
  return process.env.S4M_CONFIG ?? join(root, 'config.json');
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${where} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function loadConfig(path: string): Config {
  let raw: Record<string, unknown>;
  try {
    raw = asRecord(JSON.parse(readFileSync(path, 'utf8')), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(
        `No config at ${path}. Copy config.example.json next to it and set publicOrigin.`,
      );
    }
    throw new ConfigError(`Could not read ${path}: ${(error as Error).message}`);
  }

  const base = dirname(resolve(path));
  const from = (value: unknown, fallback: string): string => {
    const candidate = typeof value === 'string' && value ? value : fallback;
    return isAbsolute(candidate) ? candidate : resolve(base, candidate);
  };

  if (typeof raw.publicOrigin !== 'string' || !raw.publicOrigin) {
    throw new ConfigError('publicOrigin is required, e.g. "https://manga.example.com".');
  }
  let origin: string;
  try {
    origin = new URL(raw.publicOrigin).origin;
  } catch {
    throw new ConfigError(`publicOrigin is not a URL: ${String(raw.publicOrigin)}`);
  }

  const listen = asRecord(raw.listen ?? {}, 'listen');
  const session = asRecord(raw.session ?? {}, 'session');
  const login = asRecord(raw.login ?? {}, 'login');
  const solver = asRecord(raw.flaresolverr ?? {}, 'flaresolverr');
  const logging = asRecord(raw.logging ?? {}, 'logging');
  const icons = asRecord(raw.icons ?? {}, 'icons');

  const secureCookies =
    typeof raw.secureCookies === 'boolean' ? raw.secureCookies : origin.startsWith('https://');
  if (secureCookies && origin.startsWith('http://')) {
    // A Secure cookie is never sent over http, so the sign-in would appear to
    // succeed and every following request would be signed out.
    throw new ConfigError('secureCookies is on but publicOrigin is http://. Remove one of them.');
  }

  const dataDir = from(raw.dataDir, defaultDataDir());

  return {
    publicOrigin: origin,
    listen: {
      host: typeof listen.host === 'string' ? listen.host : '127.0.0.1',
      port: typeof listen.port === 'number' ? listen.port : 8080,
    },
    trustProxy: typeof raw.trustProxy === 'boolean' ? raw.trustProxy : true,
    secureCookies,
    dataDir,
    uiDist: from(raw.uiDist, resolve(base, '../web/dist')),
    session: {
      idleMs: typeof session.idleMs === 'number' ? session.idleMs : 7 * DAY,
      absoluteMs: typeof session.absoluteMs === 'number' ? session.absoluteMs : 30 * DAY,
    },
    login: {
      maxFailures: typeof login.maxFailures === 'number' ? login.maxFailures : 8,
      windowMs: typeof login.windowMs === 'number' ? login.windowMs : 15 * 60 * 1000,
      lockoutMs: typeof login.lockoutMs === 'number' ? login.lockoutMs : 15 * 60 * 1000,
    },
    flaresolverr: {
      url: typeof solver.url === 'string' ? solver.url : '',
      timeoutMs: typeof solver.timeoutMs === 'number' ? solver.timeoutMs : 60_000,
    },
    icons: {
      fallback: icons.fallback === 'google' ? 'google' : 'none',
    },
    logging: {
      file: from(logging.file, join(dataDir, 'stremio4manga.log')),
      maxBytes: typeof logging.maxBytes === 'number' ? logging.maxBytes : 5 * 1024 * 1024,
      keep: typeof logging.keep === 'number' ? logging.keep : 3,
    },
  };
}

/** Sub-directories of dataDir, in one place so nothing invents its own. */
export function dataPaths(config: Config) {
  return {
    db: join(config.dataDir, 'stremio4manga.db'),
    downloads: join(config.dataDir, 'downloads'),
    backups: join(config.dataDir, 'backups'),
    cache: join(config.dataDir, 'cache'),
    thumbnails: join(config.dataDir, 'thumbnails'),
  };
}
