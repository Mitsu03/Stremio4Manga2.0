# Stremio4Manga 2.0

A manga library and reader that several people share, served by one Node process
from one machine. Everyone signs in, everyone gets their own library, their own
reading progress and their own AniList account.

One process, one port, one SQLite file. No JVM, no port per person, no data
directory per person — version 1 had all three and none of them survived.

```bash
# Linux, systemd. Installs a published release; nothing is built on the server.
curl -fsSLO https://github.com/Mitsu03/Stremio4Manga2.0/releases/latest/download/install.sh
sudo bash install.sh --release --origin https://manga.example.com
```

```powershell
git clone https://github.com/Mitsu03/Stremio4Manga2.0
cd Stremio4Manga2.0
.\install.ps1                                            # Windows, tray icon
```

Needs **Node 22 or newer** — the database is `node:sqlite`. No native modules,
so no build tools.

Building on the machine instead — for developing, or for something not released
yet — is `git clone`, then `sudo ./install.sh --origin ...` without `--release`.
That installs whatever the checkout is on, which is `main` rather than the last
tag. [docs/RELEASING.md](docs/RELEASING.md) has both paths and why they differ.

## Documentation

| | |
|---|---|
| **[docs/README.md](docs/README.md)** | What it is, what it needs, installing on either platform, accounts, AniList, and how sources work. **Start here.** |
| [docs/DEPLOY.md](docs/DEPLOY.md) | A real deployment: the config a public server needs, TLS with Caddy, `trustProxy`, the systemd unit, backups, FlareSolverr, and moving a library in from the old Java server. |
| [docs/ACCOUNTS.md](docs/ACCOUNTS.md) | The whole lifetime of an account — where the row and the scrypt hash live, what changing a password does to open sessions, what `remove` destroys. |
| [docs/RELEASING.md](docs/RELEASING.md) | Cutting a release, and moving a server onto one: what the release tarball contains, where the version number lives, the database migration ladder, `s4m update` and `s4m rollback`, and the checklist to read every time. |
| [docs/UI-HISTORY.md](docs/UI-HISTORY.md) | How the interface got the way it is. |

## Layout

| | |
|---|---|
| `server/` | The server and the `s4m` CLI. TypeScript, bundled by esbuild to `server/dist/`. |
| `server/src/sources/sites/` | The six hand-written sites. One file each. |
| `server/src/sources/themes/` | The six engines behind the other 399 sites, which are rows in `server/sources.themed.json` rather than code. |
| `web/` | The React UI, built by vite to `web/dist/`. |
| `deploy/` | The systemd unit, an example Caddyfile, and the Windows launchers and tray. |
| `install.sh`, `install.ps1` | The installers. Both take `--help`. |

## Building by hand

```bash
npm ci        # devDependencies included: esbuild and vite ARE the build
npm run build # server/dist and web/dist
npm start     # node server/dist/main.js
```

## Accounts

There is no registration page and no password recovery, by decision — the
sign-in form is the only thing an anonymous request can reach.

```bash
node server/dist/cli.js users add <username>
```

The password is typed at a hidden prompt and hashed before the database is
touched. See [docs/ACCOUNTS.md](docs/ACCOUNTS.md).
