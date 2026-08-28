# Stremio4Manga

A manga library and reader that several people share, served by one process
from one machine. Everyone signs in, everyone gets their own library, their own
reading progress and their own AniList account, and nothing is visible between
them.

```
  browser ──► Caddy (TLS) ──► node server/dist/main.js ──► stremio4manga.db
                                        │
                                        └──► the scanlation sites, politely
```

That is the whole diagram. One process, one port, one SQLite file with every
account in it.

## What this replaced, and why it matters to you

Version 1 was two repositories: a Node gateway in front of one Suwayomi JVM per
person, each with its own port, its own data directory and roughly 768 MB of
heap. Sources were Tachiyomi extensions — Android APKs downloaded from a
third-party index at runtime and loaded as dex, inside an embedded Chromium.

None of that exists now. If you are reading an old note, a shell script or a
half-remembered instruction, everything about instances, ports, `-Xmx`, KCEF,
`java.jar` or extension repositories is gone. There is no JVM to size, no port
range to reserve and no per-account directory to move.

## What you need

- **Node 22 or newer.** The database is `node:sqlite`, which does not exist
  before 22. Tested on 24.
- **No build tools.** There are no native modules; `npm ci` is a download.
- **A reverse proxy**, if this faces the internet. The server never terminates
  TLS. See [DEPLOY.md](DEPLOY.md).
- **FlareSolverr — optional**, external, and only needed for the two sources
  behind Cloudflare. Without it they fail with a message that says exactly that;
  everything else works.

## Installing on Linux

This is the primary target. `install.sh` creates a system account, installs into
`/opt/stremio4manga`, builds, writes the config, installs a systemd unit and
offers to create the first account.

```bash
git clone https://github.com/Mitsu03/Stremio4Manga2.0
cd Stremio4Manga2.0
sudo ./install.sh --origin https://manga.example.com
```

`./install.sh --help` lists the flags — a different prefix, a different data
directory, a different service account, FlareSolverr, and a fully
non-interactive mode for provisioning tools.

Afterwards:

```bash
systemctl status stremio4manga
journalctl -u stremio4manga -f
```

TLS is not installed for you. [DEPLOY.md](DEPLOY.md) covers Caddy, `trustProxy`,
backups and moving an existing library in.

## Installing on Windows

Windows is supported and is the secondary case: it runs from the checkout, with
a tray icon rather than a service.

```powershell
git clone https://github.com/Mitsu03/Stremio4Manga2.0
cd Stremio4Manga2.0
.\install.ps1
```

That checks Node, builds, writes `server\config.json`, creates the first account
and registers a scheduled task so the tray starts at logon. `Get-Help
.\install.ps1 -full` lists the parameters.

The tray icon sits by the clock:

| | |
|---|---|
| double click | opens the app |
| **Ver log** | opens the server log |
| **Ver contas** | lists the accounts |
| **Reiniciar** | restarts the server |
| **Sair** | stops it |

`deploy\windows\start-server.cmd` and `stop-server.cmd` do the same by hand.

**On Windows Server the logon trigger is wrong**: the tray lives in an
interactive session, so with nobody signed in there is neither tray nor server.
`install.ps1` prints the `ONSTART /RU SYSTEM` replacement at the end, along with
the reason you must set an explicit `dataDir` first. A real Linux server and
systemd are the better answer to the same problem.

## Accounts

There is no registration page, no first-run claim and no password recovery. An
account exists because somebody with a shell on the machine created one — which
makes the sign-in form the only thing an anonymous request can reach.

```bash
node server/dist/cli.js users add    <username>
node server/dist/cli.js users passwd <username>
node server/dist/cli.js users list
node server/dist/cli.js users remove <username> --yes
```

`server/bin/s4m.js` is a shim over the same commands, for an npm bin link.

The password is typed at a hidden prompt and hashed before the database is
touched, so it never reaches argv, `ps` or the shell history. There is
deliberately no flag that takes one; `--password-stdin` exists for provisioning
without a TTY.

Adding, changing and removing take effect immediately. The server is never
restarted for an account.

Full lifecycle — where the row lives, what changing a password does to open
sessions, what `remove` destroys — is in [ACCOUNTS.md](ACCOUNTS.md).

## Connecting AniList

AniList is per account, connected from **Settings** inside the app. Reading
progress syncs both ways once it is linked.

AniList OAuth applications are registered per *installation*, not per user: one
client id covers everyone on the server, and each person still signs in with
their own AniList account and gets their own token. The id identifies the
application, never a person.

A default id is compiled in — the one the Kotlin version used — so an upgrade of
an existing deployment keeps working. It is **not** enough for a deployment at a
new address. The redirect URL is registered on the AniList app rather than sent
with the request, so the built-in id only ever returns to the origin that app
was registered for; anywhere else AniList sends the browser somewhere that is
not your server, and the connection never completes. If AniList returns you to a
page that is not yours, or to nothing at all, that is this. Register your own:

1. Register an app at <https://anilist.co/settings/developer>.
2. Set its redirect URL to **`<publicOrigin>/handle/oauth/result`** — exactly
   the origin in `server/config.json`, with that path.
3. Start the server with `S4M_ANILIST_CLIENT_ID=<your id>` in the environment.
   On systemd that is one more `Environment=` line in the unit.

The client id is not a secret — the implicit grant puts it in a URL the browser
follows — but it is deployment configuration, which is why it comes from the
environment rather than from `config.json`.

With no id available at all, the Settings page draws a tracker that simply
cannot be connected yet, rather than failing the whole query.

## Sources

358 sites ship built in, across 13 languages. They come in two kinds.

**Six are written out by hand**, because each is its own thing:

| | | |
|---|---|---|
| MangaDex | `mangadex` | |
| ComicK | `comick` | needs FlareSolverr |
| Weeb Central | `weebcentral` | |
| Manga District | `mangadistrict` | |
| Asura Scans | `asurascans` | needs FlareSolverr |
| Rizz Fables | `rizzfables` | |

**The other 352 are data.** Most of the scanlation web is a handful of site
engines wearing different skins, so a site on a theme this build implements does
not need code — it needs a row. `server/sources.themed.json` holds them, and
`server/src/sources/themes/` holds the six engines they run on:

| engine | sites | what it is |
|---|---|---|
| Madara | 185 | WordPress, `wp-manga`. The largest single theme upstream. |
| MangaThemesia | 118 | WordPress, still widely called WPMangaStream. |
| Keyoapp | 15 | Tailwind front end; covers are CSS, pages are ids resolved against a CDN host printed in a script. |
| Iken | 12 | Not a scraper: a Next.js site over a JSON API on an `api.` sibling host. |
| MangaHub | 11 | Eleven front ends over one GraphQL API, keyed by an access cookie the site issues. |
| MangaCatalog | 11 | One franchise per host. The catalogue is a list the extension names, so browsing costs no request at all. |

A row is not just the site's address. Almost every install differs from its
theme somewhere — a renamed archive path, a moved status row, dates written in
Turkish — so each row also carries a `config` describing those differences,
read out of the upstream extension's own source by `tools/sync-keiyoushi.mjs`.
284 of the 352 need one. Leaving them out is what once made two thirds of these
sources return nothing at all; see the note on defaults below.

What a `config` carries depends on the engine, and the difference is
instructive: a Madara row moves selectors and a URL segment, because everything
about that theme is markup; a MangaHub row carries one word — the enum naming
which catalogue the shared API should answer from — and a MangaCatalog row
carries the site's entire list of titles, because on those sites the list is not
discoverable at all.

Several things here are different from version 1, and all of them are
deliberate:

- **Nothing is downloaded or loaded at runtime.** Version 1 fetched Android
  APKs from the keiyoushi repository and loaded dex behind an embedded browser.
  A source is now either a compiled-in module or a row of data, `import` is the
  only loader, and there is nothing to update while the server runs.
- **The catalogue is the server's own.** `server/catalog.json` and
  `server/sources.themed.json` are the index. "Installing" a source is one row
  in `source_state`, per account, so two people sharing a server do not have to
  share a taste in scanlation sites.
- **Adding a bespoke site means adding a file.** Write a module in
  `server/src/sources/sites/` exporting a `SourceDefinition` (see
  `server/src/sources/types.ts`), register it in
  `server/src/sources/registry.ts`, and add its entry to `server/catalog.json`.
- **Adding a themed site means adding a theme.** Implement the engine under
  `server/src/sources/themes/`, add its name to `SUPPORTED` in
  `tools/sync-keiyoushi.mjs`, add a case to the `switch` in
  `server/src/sources/registry.ts`, and re-run the script — every upstream
  extension on that theme arrives at once. 66 themes exist upstream and this
  build has six, so this is still where the remaining coverage is.

  Raw extension counts are the wrong way to choose the next one. `madaralegacy`
  is the largest theme left at 105 extensions but only 35 of them are English,
  and `zeistmanga` has 35 extensions of which *one* is; Keyoapp had 19 of which
  18 were. Count what the catalogue will actually offer, not what upstream ships.
- **Source ids are permanent.** Decimal strings, stored on every manga row and
  in saved searches. Never reuse or renumber one. A site that dies keeps its row
  and its id, marked `retired` with the reason, and is simply not built — 52 are
  in that state, and they cost nothing per search.

### Corrections, and why defaults are dangerous here

`server/sources.overrides.json` holds fixes checked against the live site and
merged over whatever upstream says. It exists because upstream is not always
current: a site moves its archive or its domain and its extension is not updated
for months, and a source that 404s on every request is worse than one nobody
offered. Twenty-one sites are corrected there, each carrying the date it was
checked — re-check before trusting an old entry.

One trap is worth naming, because it once cost this build two thirds of its
MangaThemesia sources. An upstream extension only declares what it *overrides*,
so reading a theme's defaults off a sample of extensions shows you precisely the
sites that disagree with the default. The most common override gets mistaken for
the default; every site relying on the real one then asks for a path that does
not exist, and they all fail identically — which reads as the integration being
broken rather than as one wrong constant. Take defaults from the theme, never
from its subclasses.

The server is polite to these sites on purpose: one request at a time per host,
spaced out with jitter, with a ceiling on concurrent hosts and a circuit
breaker. The constants are in `server/src/sources/http.ts` and they are
ban-avoidance limits, not performance tuning — see the note in
[DEPLOY.md](DEPLOY.md) before changing any of them.

## Where things live

| | |
|---|---|
| `server/config.json` | deployment settings. Hand-edited, read at boot. |
| `server/config.example.json` | the committed template. |
| data directory | everything written at runtime — see below. |

The data directory is `$XDG_DATA_HOME/stremio4manga` on Linux (default
`~/.local/share/stremio4manga`, and `/var/lib/stremio4manga` under the systemd
unit) and `%LOCALAPPDATA%\Stremio4Manga` on Windows. Override it with `dataDir`
in the config. It holds:

| | |
|---|---|
| `stremio4manga.db` | every account, session, library, chapter and read state |
| `downloads/` | chapters kept for offline reading |
| `backups/` | what the automated backup schedule writes |
| `cache/`, `thumbnails/` | rebuildable |
| `stremio4manga.log` | rotated at 5 MB, three generations kept |

The split is by nature: the config is a file a person reads to understand the
server, and that is a different job from state written on every request.

`S4M_CONFIG` overrides the config path if you need it somewhere else entirely.

## Building by hand

```bash
npm ci
npm run build          # server/dist (esbuild) and web/dist (tsc + vite)
npm start              # node server/dist/main.js
```

`npm ci` installs devDependencies on purpose — esbuild and vite are the build,
and both are devDependencies. Both bundles are self-contained afterwards, so
nothing under `node_modules` is needed to run; `install.sh` prunes it and the
server does not notice.

## When something is wrong

| | |
|---|---|
| `No config at ...` | Copy `server/config.example.json` to `server/config.json` and set `publicOrigin`. |
| `publicOrigin is required` | Same. It is not optional: every CSRF check compares against it. |
| `secureCookies is on but publicOrigin is http://` | Remove one of them. A `Secure` cookie is never sent over http, so sign-in would appear to work and every later request would be signed out. |
| `Port N is already in use` | Something else holds it. On Windows the tray names the process rather than killing it. |
| The app loads but sources fail | The site may be behind Cloudflare — the error says so. Configure `flaresolverr.url`. |
| Signed out right after `users passwd` | By design: changing a password revokes every open session. Sign in again. |
| Node exits immediately with no message | Almost always the config. Run `node server/dist/main.js` in a terminal and read it. |
