# Cutting a release, and moving a server onto one

Two jobs that are the same subject from opposite ends: turning a commit into
something a machine can install, and getting a machine that is already running
onto it without losing the library it holds. Read the first half when you are
about to tag; read the second when a server needs to move.

Installing from scratch is [README.md](README.md), and everything around a
running deployment is [DEPLOY.md](DEPLOY.md).

## What a release is

A git tag `vX.Y.Z` pushed to GitHub, and nothing else. `.github/workflows/release.yml`
picks it up and does the rest.

```bash
git tag v2.1.0
git push origin v2.1.0
```

The workflow attaches two assets to the release: `stremio4manga-X.Y.Z.tar.gz`
and `stremio4manga-X.Y.Z.tar.gz.sha256`. The tarball is the runtime payload and
only the runtime payload — `server/dist`, `server/bin`, `server/catalog.json`,
`server/config.example.json`, `web/dist`. That is the same set the
`Containerfile`'s runtime stage copies, for the same reason: it is everything
the server opens once it is running and nothing else.

What it deliberately does not carry matters as much. No `node_modules` — the
esbuild bundle already carries its dependencies, which is why the archive is a
few megabytes rather than a few hundred. No source and no toolchain: the build
needs npm, esbuild, vite and roughly 200 MB of devDependencies, and it runs once,
here, so it never has to run on the machine that serves manga. And no
`config.json`, because a server's configuration is its own and an update that
overwrote it would replace a working `publicOrigin` with an example one.

The same push also builds and publishes a container image to
`ghcr.io/mitsu03/stremio4manga:vX.Y.Z` and `:latest`, from the `Containerfile`'s
runtime target. That is a separate job for a separate kind of deployment; see
[Containers update themselves](#containers-update-themselves).

## The version number, and the one place it lives

The workspace root `package.json` `version` field. Everything else derives from
it.

`server/build.js` reads it at build time and hands it to esbuild as a define, so
the bundle carries the literal string as `__S4M_VERSION__`; `server/src/version.ts`
exposes it as `VERSION`. It is substituted rather than read at startup because of
the tarball above: `package.json` is not next to `dist/` in a deployment, so a
server that tried to read it would find nothing.

A source checkout that was never built has no define, and `VERSION` falls back
to `0.0.0-dev`. `isDevBuild()` is true there, and `s4m update` refuses to run a
check — not out of caution, but because there is genuinely nothing to compare:
"0.0.0-dev" is the honest answer to "which release is this", and the honest
answer is "not one".

The release workflow fails the build if the tag and `package.json` disagree,
before it builds anything. That check is not tidiness. The tag names the release
and `package.json` is what the running server reports, so if they drift apart
`s4m update` compares a tag against a number that was never inside that tarball
— and then either offers an update that is already installed, forever, or hides
one that is not. Both are silent, both are discovered by somebody else, and
neither reproduces on the machine that cut the release. Failing in CI costs a
minute; the alternative costs an afternoon.

## Database versions

The database version is SQLite's `PRAGMA user_version`, a single integer in the
file header that belongs to the application. There is no table to create, so
nothing has to be migrated before the migrations can run, and it is already
present in every database this server has ever written.

`SCHEMA_VERSION` in `server/src/db/migrations.ts` is `1 + MIGRATIONS.length`.
Version 1 is 2.0.0's `schema.sql` — the shape every database that existed when
versioning was introduced already has.

`applySchema` in `server/src/db/open.ts` handles four cases on every open:

| | |
|---|---|
| no tables | A fresh install. Run `schema.sql`, stamp the current version, done. |
| tables, version 0 | A database from before versioning. Its shape *is* version 1, so run `schema.sql` — every statement in it is `CREATE ... IF NOT EXISTS`, so this is a no-op except for anything that only ever appeared by that route — stamp it 1, and let the ladder carry it the rest of the way. |
| version *n* | Apply every migration above *n*, one transaction each, covering the SQL and the version stamp together. A migration that throws leaves the database on the version it started at rather than on a number that describes neither shape. |
| version above `SCHEMA_VERSION` | Refuse to open at all. |

That last case is the rollback guard, and it is the reason a rollback is not
simply "put the old files back". A database above what the build understands has
been through a migration this build has never heard of, which happens exactly
when a server is moved back to an older release. Opening it anyway would mean a
build reading columns that moved out from under it, so it stops and says what it
needs instead.

Migrations are forward-only. There is no `down`, and adding one would be a
promise this cannot keep — the fix for a bad release is the previous build plus
the backup the updater took, not a reverse migration.

## The two-places rule

**Every schema change goes in both `schema.sql` and a new `MIGRATIONS` entry.**
This is the single thing in this document most worth remembering.

`schema.sql` is what makes a brand-new database correct in one step. The
migration is what gets a database that already exists to the same place. They
are not alternatives, and neither one implies the other:

- Forget the migration, and you ship a server that works perfectly on a fresh
  install and is missing a column on every machine that already had data.
- Forget `schema.sql`, and you get the reverse: existing servers are fine, and
  the next person to install from scratch gets a database that no migration will
  ever fix, because migrations only run above the version a fresh database is
  stamped with.

The trap is that neither failure shows up on the machine cutting the release.
That machine has a database, so it takes the migration path and never exercises
`schema.sql`; or it has a scratch one, so it takes `schema.sql` and never
exercises the ladder. The test that would have caught it is the one nobody runs
on their own laptop.

`migrations.ts` asserts at module load that `to` values are contiguous from 2, so
a gap or a duplicate is a crash on the developer's machine rather than a
database that stops halfway and reports success. That check catches a bumped
version with no migration behind it. It cannot catch a migration whose
`schema.sql` half is missing — nothing can, from inside the code. That half is
on the person cutting the release.

A migration entry reads:

```
{ to: 2, sql: `ALTER TABLE manga ADD COLUMN last_read_at INTEGER;` },
```

`to` is the version the database carries once the SQL has run, always one more
than the entry above it.

## Updating a server

On the machine, as root:

```bash
sudo s4m update
```

`install.sh` writes `/usr/local/bin/s4m` — a two-line wrapper with the absolute
paths to node and to `server/bin/s4m.js` baked in, regenerated on every re-run.
It is a wrapper rather than a symlink because the shim is not marked executable
in the repository and its `#!/usr/bin/env node` would have to find node on a
`PATH` that `sudo` has usually already stripped. An install predating that
wrapper has no `s4m` on `PATH`; there, the command is
`sudo /usr/bin/node /opt/stremio4manga/server/bin/s4m.js update`, and re-running
`install.sh` creates the short form.

What it does, in order:

1. Reads the running version from the bundle.
2. Asks the GitHub API for the latest release and compares.
3. Downloads the tarball and its `.sha256`.
4. Verifies the hash — before extracting anything.
5. Extracts to `PREFIX/.updates/staging/`.
6. Checks the staged tree actually contains `server/dist/main.js`,
   `server/dist/cli.js` and `web/dist/index.html`.
7. Takes a database snapshot with SQLite `VACUUM INTO`, to
   `<dataDir>/backups/pre-update-<old>-to-<new>.db`.
8. Swaps each payload path with a pair of renames, moving the live one aside to
   `PREFIX/.updates/previous/`.

The ordering is the whole design. Every step that can fail — the network, the
checksum, a truncated archive, a release published half-built, a disk with no
room for the snapshot — happens before anything in the live tree is touched. A
failure anywhere in the first seven steps leaves the install exactly as it was,
still running, still serving. Only step 8 writes over anything, and by then
everything that could have gone wrong already has not.

`VACUUM INTO` rather than a file copy because the server is still running at that
point, and a `.db` copied out from under an open SQLite connection is a torn
read.

Migrations do not run during the update. They run on the next server start,
where the ordinary open path handles them with a transaction each. The update
moves files; the server owns its database.

Three flags:

| | |
|---|---|
| `--check` | Report and stop. Changes nothing. |
| `--yes` | Do not prompt. For timers and scripts. |
| `--restart` | `systemctl restart stremio4manga` at the end, which is what actually puts the new build in front of readers. |

`--check` exits 10 when an update is available, which is what makes it usable
from a script that has an opinion about when updates happen:

```bash
if s4m update --check; then
  echo "up to date"
elif [ $? -eq 10 ]; then
  echo "an update is waiting"
fi
```

## Why the updater runs as root, and why that is deliberate

`install.sh` chowns `PREFIX` to `root:root` and runs the service as the
unprivileged `stremio4manga` user, and the systemd unit's `ReadWritePaths=` is
the data directory and nothing else. The install tree is deliberately not
writable by the process that runs from it. That is not incidental hardening: this
server's job is parsing HTML from three hundred sites it does not control, and
the arrangement means a source parser going wrong cannot rewrite the server it is
running inside.

The updater is the one thing that writes that tree, which is precisely why it
does not run from the server process. It runs from a root shell, or from a
systemd timer that root owns. There is no HTTP route to it, no button in the UI,
and no way for a request — or a source's response — to reach it. The privilege
and the exposure are in different processes, and they stay there.

If that trade is not one you want on a particular machine, the answer is to skip
the timer and run `s4m update` by hand when you choose — not to make `PREFIX`
writable by the service user.

## Rolling back

```bash
sudo s4m rollback
sudo systemctl restart stremio4manga
```

This restores the payload from `PREFIX/.updates/previous/`. The files are
copied, not moved, so a rollback interrupted halfway can simply be run again —
the source is still there.

Only the immediately previous build is kept. Rollback is a way to undo the
update that just happened, not a version history; two releases back is a fresh
install of an older tag.

**If the release you are rolling back from ran a migration, the payload is only
half of it.** The old build will refuse to open the database — that is the guard
described above doing its job, and the error names the two version numbers — so
the snapshot has to go back as well, with the service stopped:

```bash
sudo systemctl stop stremio4manga
sudo s4m rollback
sudo -u stremio4manga cp \
  /var/lib/stremio4manga/backups/pre-update-2.0.0-to-2.1.0.db \
  /var/lib/stremio4manga/stremio4manga.db
sudo rm -f /var/lib/stremio4manga/stremio4manga.db-wal \
           /var/lib/stremio4manga/stremio4manga.db-shm
sudo systemctl start stremio4manga
```

The `cp` runs as the service user so the restored file is owned by it rather than
by root. The `-wal` and `-shm` files have to go because they describe a database
that no longer exists; leaving them beside a replaced `.db` is how a restore
turns into corruption.

Be clear about what this costs. Everything written since the update — reading
progress, new titles, sessions — is in the database being replaced, not in the
snapshot. Restoring it is the right move when the new release is broken enough
that the alternative is worse, and it is never free.

## Unattended updates

A systemd timer running the updater weekly. Two files:

`/etc/systemd/system/stremio4manga-update.service`

```ini
[Unit]
Description=Update Stremio4Manga to the latest release
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
# The absolute path, not `s4m`: a unit runs with a minimal PATH, and this one
# has to keep working even if /usr/local/bin is not on it.
ExecStart=/usr/bin/node /opt/stremio4manga/server/bin/s4m.js update --yes --restart
```

`/etc/systemd/system/stremio4manga-update.timer`

```ini
[Unit]
Description=Weekly Stremio4Manga update

[Timer]
OnCalendar=Sun 04:00
RandomizedDelaySec=2h
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now stremio4manga-update.timer
systemctl list-timers stremio4manga-update.timer
```

`Type=oneshot` because the command finishes; without it systemd treats the exit
as a crash. `RandomizedDelaySec=2h` spreads installs out rather than having every
one of them ask GitHub at the same minute. `Persistent=true` runs a missed
occurrence at the next boot, which is the difference between a timer and a timer
that only works on machines that are never switched off.

Be honest about the trade before enabling it. Unattended updates mean a bad
release restarts the server with nobody watching, at four in the morning, on a
machine other people rely on. The mechanism above is careful — the checksum, the
staged-tree check and the database snapshot all happen before anything is
replaced — but none of that protects against a release that installs perfectly
and behaves badly. Recommend it for a deployment where there is a track record
of releases that were fine, and run `s4m update` by hand until then.

After the fact, the timer's runs are in the journal:

```bash
journalctl -u stremio4manga-update
journalctl -u stremio4manga --since '4 hours ago'
```

## Containers update themselves

For a deployment running the `Containerfile` image rather than `install.sh`,
none of the above applies. Label the container:

```
io.containers.autoupdate=registry
```

and enable the runtime's own timer:

```bash
systemctl --user enable --now podman-auto-update.timer
```

Podman then pulls a newer `:latest`, restarts the container and rolls back to the
previous image if the new one fails to start — pull, restart and rollback, with
no code from this repository involved at all. It only acts on containers that
systemd starts, so the container has to be run from a unit (a Quadlet file, or
`podman generate systemd`) rather than a bare `podman run`.

This is the container path only. The systemd install that `install.sh` produces
is the documented default, and it uses `s4m update`.

## The checklist

Each line is one thing, in order:

1. Every schema change in this release also has a `MIGRATIONS` entry.
2. Bump `version` in the root `package.json`.
3. `npm run lint && npm run build && npm run test:offline` locally.
4. Commit.
5. `git tag vX.Y.Z` — the same X.Y.Z as `package.json`.
6. `git push origin vX.Y.Z`.
7. Watch the workflow; the tag/`package.json` check fails first if it is going to.
8. Confirm both `stremio4manga-X.Y.Z.tar.gz` and its `.sha256` are attached to
   the release.
9. `sudo s4m update --check` on a server — it should name the new version.
10. `sudo s4m update --yes --restart` — without `--yes` it only reports.
11. `s4m version`, `curl -s localhost:8080/gateway/health`, and open the UI.

## The payload list lives in three places

`.github/workflows/release.yml` packs it, `server/src/update.ts` has it as
`PAYLOAD` and swaps each entry, and the `Containerfile`'s runtime stage copies
it. Three copies of one list, in three languages, none of which can see the other
two.

They have to be changed together. Adding a runtime file to the Containerfile and
not to the workflow ships a tarball that is missing it; adding it to the workflow
and not to `PAYLOAD` extracts it into staging and never swaps it in.

What keeps a disagreement from becoming a broken install is `update.ts`'s
`MUST_EXIST` check: a staged tree without `server/dist/main.js`,
`server/dist/cli.js` and `web/dist/index.html` is refused before the swap, so the
update stops rather than completing and leaving a server unable to start. That is
the most a check on this side can do — it turns a silent breakage into a refusal,
but it cannot know about a file nobody added to any of the three.
