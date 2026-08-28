# Putting Stremio4Manga on a server

The server itself is one Node process. Everything hard about a deployment is
around it: keeping it running without a terminal open, terminating TLS in front
of it, getting `trustProxy` the right way round, backing up the one file that
matters, and moving a library that already exists onto a machine where it does
not.

Accounts are a separate subject — [ACCOUNTS.md](ACCOUNTS.md) covers their whole
lifetime. If you have not installed anything yet, start at
[README.md](README.md).

## Running it without a terminal

`node server/dist/main.js` is fine for a shell you are watching. It is the wrong
way to run a server: the process dies with the window, and nothing brings it
back.

### Linux, with systemd

`sudo ./install.sh --origin https://manga.example.com` does all of this. What
follows is what it did, so that editing it later is not archaeology.

```bash
useradd --system --home-dir /var/lib/stremio4manga --no-create-home \
        --shell /usr/sbin/nologin stremio4manga
install -o stremio4manga -g stremio4manga -m 750 -d /var/lib/stremio4manga
cp deploy/stremio4manga.service /etc/systemd/system/
# adjust User=, WorkingDirectory=, ExecStart=, Environment= and ReadWritePaths=
systemctl daemon-reload
systemctl enable --now stremio4manga
```

Five things in `deploy/stremio4manga.service` are load-bearing:

- **`HOME` and `XDG_DATA_HOME` are set explicitly.** systemd sets neither, and
  the data directory derives from both: with no `dataDir` in the config the
  server falls back to `$XDG_DATA_HOME/stremio4manga`, and `$XDG_DATA_HOME`
  itself falls back to `$HOME/.local/share`. A unit without these two lines
  writes the database to wherever the process believes `$HOME` is — usually
  `/`, where it fails on the first write rather than at start. The installer
  also writes an explicit `dataDir`, so these are the safety net, not the
  mechanism.

- **`ProtectSystem=strict` makes the whole filesystem read-only** except
  `ReadWritePaths=`. That is the data directory and nothing else — the install
  tree is deliberately not writable, since nothing in it is written at runtime.
  Anything else the deployment writes (a `logging.file` pointed elsewhere, a
  `dataDir` on another disk) has to be added there, or it fails on first write
  rather than at start.

- **The `node` path is absolute.** systemd's `PATH` is
  `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin`, not a login shell's, and
  emphatically not whatever nvm or fnm put in front of it.

- **`TimeoutStopSec=120` is generous on purpose.** On `SIGTERM` the process
  stops the download worker and the backup schedule, waits for open sockets and
  then closes SQLite. A reader mid-chapter holds a socket; a download in flight
  holds a write transaction.

- **There is no `KillMode`, and there should not be.** Version 1 ran a JVM per
  account as a child process and needed the whole control group taken down
  together. This is a single process with no children, so the default
  (`KillMode=control-group`) is already exactly right. Adding the line back out
  of habit can only make shutdown worse.

```bash
systemctl status stremio4manga
journalctl -u stremio4manga -f
```

### Windows

`.\install.ps1` builds, configures and registers a scheduled task that starts
the tray at logon. The tray owns the node process: it restarts it, stops it on
**Sair**, and — the part worth knowing — it will take over a port that is
already held **only** if the holder is a `node.exe` running this server's own
`main.js`, matched by full path. Anything else and it refuses and names what it
found.

That refusal is not politeness. A failed bind reaches Node as an unhandled
`error` event, so without the check the symptom is "it exited" with nothing
said; and killing whatever holds 8080 is how somebody else's server disappears
without anyone ever learning it was there.

**On Windows Server, `ONLOGON` is the wrong trigger** — the tray lives in an
interactive session, so with nobody signed in there is no tray and no server.
Use `ONSTART` with `/RU SYSTEM` from an elevated prompt, and set an explicit
`dataDir` first: as SYSTEM, `%LOCALAPPDATA%` is
`C:\Windows\System32\config\systemprofile\AppData\Local`, which is not where
anybody looks for a library. `install.ps1` prints the exact command at the end.

If the machine is meant to be a server, Linux and systemd are the better answer
to the same problem.

### In a container

The `Containerfile` is a two-stage build: Node and the built output, no JVM, no
Chromium, no native module to compile. The runtime stage runs as an unprivileged
`s4m` user and keeps everything under `/data`.

```bash
podman build -t stremio4manga .
podman volume create s4m-data
podman run -d --name stremio4manga -p 127.0.0.1:8080:8080 \
  -v s4m-data:/data -v ./config.json:/app/server/config.json:ro stremio4manga
podman exec -it stremio4manga node server/bin/s4m.js users add alice
```

Two keys differ from every other deployment, and both follow from the container
being a network and filesystem namespace of its own:

| | |
|---|---|
| `listen.host` | **`0.0.0.0`**, not `127.0.0.1`. Inside the container the loopback reaches only the container; a server bound to it publishes a port nothing answers on. What keeps this off the LAN is the `127.0.0.1:` in `-p 127.0.0.1:8080:8080` — the host is where that decision now lives. |
| `dataDir` | `/data`, matching the volume. The image sets `XDG_DATA_HOME=/data`, so leaving it out lands in `/data/stremio4manga` — on the volume either way, but a container's data path is worth writing down rather than deriving. |

Set `uiDist` to `/app/web/dist` as well: it defaults to a path relative to the
config file, which is only right in a source checkout.

The volume is the deployment. The container is disposable — `podman rm` it,
rebuild, recreate against the same volume, and the library is still there.
`test/podman-validate.sh` (or `npm run test:podman`) proves exactly that, along
with the sign-in, a GraphQL call and the non-root user, against a throwaway
container on port 18080. It runs rootless, and 18080 is deliberate: a real
deployment on 8080 on the same machine is left alone.

## The config a public server needs

Start from `server/config.example.json`. **Do not copy a working local config** —
it carries a laptop's answers to questions a server answers differently.

Three keys have to be right:

| | |
|---|---|
| `publicOrigin` | The URL people actually type, e.g. `https://manga.example.com`. Every CSRF check compares against it, and its scheme is what makes the session cookie `Secure`. **Required** — the server refuses to start without it. |
| `listen.port` | What the reverse proxy forwards to. Default 8080. |
| `listen.host` | Leave it on `127.0.0.1`. Binding to `0.0.0.0` puts a plain-HTTP sign-in form on the LAN. A container is the one exception — see [In a container](#in-a-container). |

And two that are best left out entirely:

| | |
|---|---|
| `secureCookies` | Derived from the scheme of `publicOrigin`. Written down, it stops tracking it — and an `https` origin with a pinned `false` serves a session cookie without `Secure`, silently. The server does refuse the other mistake outright: `secureCookies` on with an `http://` origin is a startup error, because a `Secure` cookie is never sent over http and the sign-in would appear to succeed while every following request arrived signed out. |
| `dataDir` | Only worth setting when it must not be the default. The installer sets it because systemd's environment makes the default hard to predict; on Windows the default is already right. |

The rule for both: the code owns the value, so delete the key rather than
restate it. A setting written to match its default is indistinguishable from a
deliberate override, and only one of the two is still right after the
environment changes. `server/src/config.ts` is the complete list of keys and
their defaults.

`S4M_CONFIG` overrides the config path entirely, for a deployment that keeps its
configuration somewhere else.

## TLS

The server speaks plain HTTP and binds to loopback. It never terminates TLS and
has no way of knowing it is behind any. Put Caddy in front —
`deploy/Caddyfile.example` is a complete configuration, certificate included:

```caddyfile
manga.example.com {
	reverse_proxy 127.0.0.1:8080 {
		transport http {
			response_header_timeout 5m
			read_timeout 5m
		}
	}
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	encode gzip
}
```

The 5-minute timeouts are not padding. The server is deliberately slow with
sources (see the rate limits below), so a search fanned out across hundreds of
catalogues, or a chapter off a shared WordPress host, routinely outlives Caddy's
defaults. Without
them the browser gets a 502 while the server is still perfectly well waiting —
and the user learns to hammer reload, which is exactly the traffic that gets the
server's address banned.

`Strict-Transport-Security` is set by Caddy because the server cannot set it: it
sees `http://` on loopback and would be lying.

## trustProxy

This is the one setting where there is no safe default, only a correct one and a
broken one, and which is which depends on something the server cannot observe.

| in front of the server | `trustProxy` | what goes wrong otherwise |
|---|---|---|
| Caddy, nginx, anything that rewrites `X-Forwarded-For` | **true** | The login limiter sees every request coming from `127.0.0.1` and buckets the whole internet as one client. Eight failed attempts by anyone lock out everybody. |
| nothing — loopback, LAN, a plain port forward | **false** | `X-Forwarded-For` is a header the client writes. An attacker sends a different one on every attempt, never fills a bucket, and the lockout is decoration. |

The limiter matters because it is what stands between a weak password and an
account: eight failures in fifteen minutes buys a fifteen-minute lockout, which
is what makes an online guessing attack pointless. The scrypt hash defends the
database if it is stolen; the limiter defends the login form while it is not.

Both installers derive the value from `publicOrigin` when you do not say — a
loopback host means nothing is in front — print which they chose, and take
`--proxy` / `--no-proxy` (`-Proxy` / `-NoProxy`) to be told.

## FlareSolverr

Optional, external, and off by default — but it is worth more than that
description used to suggest. Two of the six hand-written sources (Asura Scans
and ComicK) sit behind Cloudflare, and so do at least 78 of the 399 themed ones:
63 measured across Madara and MangaThemesia, six of the fifteen Keyoapp installs,
and nine of the twenty-three English sites on the older Madara library. That last
figure is a floor rather than a count — only the English subset of those was
measured — so a fifth of the catalogue is the conservative reading. Without a
solver they fail with a message naming the source and saying exactly what to
configure; nothing else is affected.

It is worth knowing what running one actually buys, because "a fifth of the
catalogue" undersells it. Measured on the fifteen Keyoapp sites, end to end:
nine of fifteen worked without a solver and **fourteen of fifteen with one**.
The six that were failing were not degraded, they were unreachable, and every
one of them came back.

Adding browser-like request headers does not substitute for it. That was
measured across all 63 challenged hosts — the current headers and a full
`Sec-Fetch-*` browser set returned identical status codes on every one. These
are real challenges, not a user-agent check.

A handful are Cloudflare *firewall* denials rather than challenges, and a solver
does not clear those either; they are marked `retired` in
`server/sources.overrides.json` with that as the reason, so nobody investigates
them twice.

```json
"flaresolverr": { "url": "http://127.0.0.1:8191", "timeoutMs": 60000 }
```

Run it wherever you like — it is a separate service and this server only makes
HTTP requests to it. Keep it on loopback or an internal network: anything that
can reach it can use it as a general-purpose browser.

## Source icons, and the one thing that leaves this machine

A source's icon is fetched once, from the site itself, and cached. Nothing about
that involves a reader's browser: the page asks this server, and this server
serves the bytes it already has.

The sites behind Cloudflare are the problem. A challenge covers every path,
including the favicon, so around thirty sources have no icon this server can
reach — and a solver does not help, because the *asset* stays blocked even once
the HTML is readable.

```json
"icons": { "fallback": "google" }
```

Off by default, and deliberately opt-in rather than a sensible default: turning
it on means telling Google which manga domains this server catalogues. It is one
request per site, once, cached forever after, and it recovers most of the
blocked icons. Leave it at `"none"` if that trade is not one you want to make;
sources without an icon show a lettered placeholder and work identically.

### Why the rate limits exist

Read `server/src/sources/http.ts` before changing any constant in it. Those
numbers are ban-avoidance limits, not performance tuning:

| | |
|---|---|
| 250 ms between two requests to the same host, ±30% jitter | The floor for a host that has never challenged us. Jittered so the period is never machine-perfect. |
| ~1.3 s once a host *has* challenged, ±30% jitter | Roughly 0.8 requests a second. A host that runs a bot check has told us what it thinks of automated traffic, and the pace changes for good — including for the requests already queued behind the one that was challenged. |
| 16 requests in flight across *all* hosts | A multi-source search fans out over every enabled catalogue at once; without a ceiling that is a burst. |
| 3 attempts, backoff from 2 s, capped at 30 s | Retrying faster is what a scraper does. |
| 5 consecutive failures, then 5 minutes of silence | A host that is angry is left alone rather than hammered. |
| Manga District and Rizz Fables get 2 s instead of 1.3 s | Both are shared WordPress hosts, where an aggressive reader is noticed first. |

Lowering any of them makes this server look more like a scraper and less like a
reader. The failure mode is not a slow page: it is the site refusing this
machine's address, permanently and unappealably, for every account on it. A slow
search is always the better trade — and letting FlareSolverr re-solve a
challenge in a loop is the fastest way there is to earn the ban.

## Backups

Two things, different in kind.

**The database.** `stremio4manga.db` in the data directory is every account,
session, library, chapter, read state, category and track record. It is the only
copy. Back it up with the server stopped, or copy the `-wal` and `-shm` files
alongside it — a `.db` taken on its own from a running server is a torn read.

```bash
systemctl stop stremio4manga
cp /var/lib/stremio4manga/stremio4manga.db /srv/backups/
systemctl start stremio4manga
```

**The per-account archives.** Each account has its own backup schedule in the
app's Settings, writing into `backups/` in the data directory. It is **off by
default** (`backupInterval: 0`), which is the only defensible default for a job
that writes files on somebody's disk on a timer; `backupTTL` defaults to 14
days once it is on. These are what a person restores from when they delete the
wrong thing — they are not a substitute for backing up the database file, and
the database file is not a substitute for them.

`downloads/` is chapters kept for offline reading, and `cache/` and
`thumbnails/` are rebuildable. None of the three need backing up.

## Moving a library in from the old Java server

Version 1 kept everything in an H2 database that no Node process can open. The
only complete record that crosses is a Suwayomi/Tachiyomi backup — a
`.tachibk` (or `.proto.gz`), which is gzip around a protobuf message. Nothing
else carries the reading progress.

**On Windows, both versions default to the same folder.** Version 1 keeps
`instances\` and `shared\` in `%LOCALAPPDATA%\Stremio4Manga`; 2.0 puts
`stremio4manga.db`, `downloads\`, `backups\`, `cache\` and `thumbnails\` beside
them. Nothing is overwritten — no two names collide — but while both are
installed, "delete the Stremio4Manga data folder" stops meaning one thing, and
v1's library is usually the larger half. `install.ps1 -DataDir D:\S4M` keeps
them apart; `--data-dir` is the same flag on Linux, where the installer's own
`/var/lib/stremio4manga` never overlapped anything.

Export a backup from the old server, then, **signed in as the account it should
land in**:

> **Settings → Backup & restore → Restore → Choose a backup file**

Pick the `.tachibk`. The server reads it, tells you which sources and trackers
in the file it cannot resolve, and waits for you to confirm before writing
anything.

What to expect:

- **It merges; it does not replace.** Nothing is deleted. Where the archive and
  the account disagree about progress, the *further* value wins — a chapter read
  on either side stays read. A restore is meant to recover reading, never to
  undo it.
- **It is idempotent.** A title is keyed by `(account, source, url)`, a chapter
  by `(title, url)`, a category by name. Running the same file twice changes
  nothing the second time, which is what makes a half-finished restore safe to
  simply run again.
- **Unmatched sources keep their original id** rather than being dropped. The UI
  already draws "source not installed" for a title it cannot resolve, and a row
  that shows a name and remembers where you got to is worth far more than the
  progress that dropping it would throw away.
- **Trackers other than AniList are not imported**, and are counted in the
  report so you know what was left behind.
- **Source bindings do not survive.** The format carries no row ids, so a
  binding whose value was another title's id in the old database cannot be
  translated. They are dropped rather than left pointing at whatever now
  occupies that number, and they are the one thing a migrated library has to be
  told again.

The same import is available from the command line, for a server being stood up
before anyone has an account to sign in with, or a batch of accounts migrated in
one sitting:

```
s4m import <file.tachibk> <username> [--dry-run]
```

`--dry-run` reads the backup and reports what it would do without writing
anything, which is the cheap way to learn how many source bindings a particular
library is going to lose before committing to it. Both routes end in the same
code, so they import identically and are equally idempotent.

**Do not copy the old `state/gateway.db` or any account row across.** Accounts
are cheap to recreate and passwords should not travel.

## Before calling it done

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://<lan-ip>:8080/   # expect: connection refused
ss -ltnp | grep 8080                                            # expect: 127.0.0.1 only
curl -s localhost:8080/gateway/health                            # expect: {"ok":true,...}
curl -sI https://manga.example.com/ | head -1                    # expect: 200 or 303
```

The middle one is the one that matters. A wrong bind address is the single
mistake that quietly undoes everything else: a plain-HTTP sign-in form on the
LAN, with no TLS, no HSTS, and `trustProxy` trusting a header anyone on that LAN
can write. On Windows it is `netstat -ano | findstr :8080`.

`/gateway/health` needs no session and reports `{ok, users, sessions}` — usable
as a monitor's probe.

## Day to day

```bash
journalctl -u stremio4manga -f                    # everything, including startup crashes
tail -f /var/lib/stremio4manga/stremio4manga.log  # the server's own log, 5 MB x 3
systemctl restart stremio4manga                   # after editing config.json
```

The config is read once at boot, so every change to it needs a restart. Accounts
are not: adding, changing and removing one takes effect on the next request.

Moving to a newer release is `sudo s4m update --check` to see whether there is
one and `sudo s4m update --yes --restart` to take it. It replaces the built
server and UI and nothing else — the config, the database and the downloads are
untouched, and the build it replaced is kept for `sudo s4m rollback`.
[RELEASING.md](RELEASING.md) has the rest, including how to run it on a timer.

On Windows the equivalents are **Ver log** in the tray, and
`server.out.log` / `server.err.log` in the data directory — which is where a
crash that happens before the logger starts lands, and nowhere else.
