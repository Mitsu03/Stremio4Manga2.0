/**
 * The version this build is, available to code that runs from the bundle.
 *
 * package.json is the source of truth, but it is not next to dist/ in a
 * deployment — the release tarball carries the built output and nothing else —
 * so the value is substituted in at build time rather than read at startup.
 * build.js does the substituting; the fallback below is what `node --import
 * tsx src/cli.ts` and the type checker see, where no define has run.
 *
 * Everything that compares versions goes through here: `s4m update` asks what
 * it is running before asking GitHub what the latest is, and an answer of
 * "0.0.0-dev" is the honest way to say "this was not built, so there is
 * nothing to compare".
 */
declare const __S4M_VERSION__: string | undefined;

export const VERSION: string =
  typeof __S4M_VERSION__ === 'string' ? __S4M_VERSION__ : '0.0.0-dev';

/** True for a tree run straight from source, where an update check is meaningless. */
export const isDevBuild = (): boolean => VERSION === '0.0.0-dev';

/**
 * Compare two `major.minor.patch` strings.
 *
 * Returns a negative number when `a` is older than `b`, zero when they match.
 * Pre-release suffixes (`2.1.0-rc1`) sort *before* the release they lead to,
 * which is the SemVer rule and the one that matters here: a server on an rc
 * must see the final release as an upgrade, not as the same thing.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.replace(/^v/, '').split('-', 2);
    const parts = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { parts, pre };
  };
  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < 3; i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }

  // Same core. No suffix outranks any suffix; two suffixes compare as text,
  // which orders rc1 < rc2 and is as much as this needs to get right.
  if (left.pre === right.pre) return 0;
  if (left.pre === '') return 1;
  if (right.pre === '') return -1;
  return left.pre < right.pre ? -1 : 1;
}
