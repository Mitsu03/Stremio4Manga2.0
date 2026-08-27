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
client id covers everyone on the server. A default id is compiled in, so a fresh
deployment works with no configuration at all. To use your own:

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

Six sites ship built in:

| | | |
|---|---|---|
| MangaDex | `mangadex` | |
| ComicK | `comick` | needs FlareSolverr |
| Weeb Central | `weebcentral` | |
| Manga District | `mangadistrict` | |
| Asura Scans | `asurascans` | needs FlareSolverr |
| Rizz Fables | `rizzfables` | |

Three things about them are different from version 1, and all three are
deliberate:

- **They are native TypeScript, not extensions.** Each is a module in
  `server/src/sources/sites/` compiled into the bundle. Nothing is downloaded,
  nothing is loaded at runtime, there is no dex and no embedded browser.
- **The catalogue is the server's own.** `server/catalog.json` is the index —
  it replaces the keiyoushi APK repository the old server fetched. "Installing"
  a source is one row in `source_state`, and it is per account, so two people
  sharing a server do not have to share a taste in scanlation sites.
- **Adding a site means adding a file.** Write a module in
  `server/src/sources/sites/` that exports a `SourceDefinition` (see
  `server/src/sources/types.ts`), register it in
  `server/src/sources/registry.ts`, and add its entry to `server/catalog.json`.
  Source ids are decimal strings, stable forever — they are stored on every
  manga row and in saved searches, so never reuse or renumber one.

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
