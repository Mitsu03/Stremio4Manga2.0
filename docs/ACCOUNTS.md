# Managing accounts

An account is a username, a display name and a scrypt hash. That is the whole of
it — no port, no data directory, no process. Version 1 allocated all three per
account; here the separation is a `user_id` column on every domain row, so
creating an account is one `INSERT`.

Creating one still happens at a shell and nowhere else. **There is no
registration page, no first-run claim and no password recovery**, which makes
the sign-in form the only thing an anonymous request can reach. That is the
smallest surface this can have, and it is a decision rather than an omission.

This is the reference for the whole lifetime of an account. The short version is
in the [README](README.md).

## The commands

```bash
node server/dist/cli.js users add    <username> [--password-stdin]
node server/dist/cli.js users passwd <username> [--password-stdin]
node server/dist/cli.js users remove <username> [--yes]
node server/dist/cli.js users list
```

`server/bin/s4m.js` is a shim over exactly the same thing, so an npm bin link
gives you `s4m users add …`. Running either with no command prints the list.

Every command reads `server/config.json` — it has to exist and to name a real
`publicOrigin` before any of them work, because that is what tells the CLI where
the database is.

Run them as the account that owns the data:

```bash
# Linux, after install.sh
sudo -u stremio4manga /usr/bin/node /opt/stremio4manga/server/dist/cli.js users list

# Windows
node .\server\dist\cli.js users list
```

On Linux this matters more than it looks. The CLI opens the database, and
opening a database that does not exist yet **creates** it — as root that leaves a
root-owned `stremio4manga.db` the service cannot write to, and the failure does
not surface until the first sign-in.

**Adding, changing and removing take effect on the next request. The server is
never restarted for an account.** Accounts are state, not configuration; the
config is the thing that is read once at boot.

## Where an account is stored

Not in the config.

| | |
|---|---|
| `server/config.json` | settings of the deployment. Edited by hand, read at boot. |
| `<dataDir>/stremio4manga.db` | every account, session and library. Written by the server and by these commands. |

The split is by nature: the config is a file a person reads to understand the
server, and that is a different job from state two processes write at once.
Keeping both in one JSON file made the settings harder to read *and* the state
unsafe — a CLI command and the server overlapping in the tenth of a second it
takes to hash a password lose one of the two writes outright.

The `users` table holds one row per account, and only these five columns:

| column | |
|---|---|
| `username` | primary key, always lower-cased |
| `display_name` | the spelling given to `add`, kept for the UI |
| `password` | the scrypt hash — never a password |
| `password_changed_at` | the stamp that invalidates older sessions |
| `created_at` | |

### The hash

The password field is self-describing, so a hash carries the parameters it was
made with and an old row stays verifiable after the cost is raised:

```
scrypt$32768$8$1$<32-byte salt, base64>$<64-byte key, base64>
```

N=2¹⁵ costs about 32 MiB and roughly 100 ms per attempt on a modern core. That
is invisible to somebody signing in — the login path is rate limited to single
digits per minute — and ruinous to somebody grinding a stolen database. The
hashing module imports nothing outside `node:`, on purpose: it is the one piece
standing between the open internet and every account's library, and a supply
chain is a poor thing to put there.

Passwords are NFKC-normalised before hashing, so a password typed on a phone
keyboard and the same password typed on a desktop agree.

The hashing happens **in the CLI, before the database is touched**. A plaintext
password never reaches disk, the shell history or the process list, and a
mistyped confirmation or a Ctrl-C at the prompt leaves the database exactly as
it was.

### Sessions

Alongside it, `sessions` stores only `id_hash` — the SHA-256 of the cookie
value. The cookie itself is never written, so reading the database is not enough
to forge a session.

Sessions expire on idleness after 7 days and absolutely after 30, both
adjustable under `session` in the config.

## Creating an account

```bash
node server/dist/cli.js users add mitsu
```

The password is typed at a hidden prompt and asked for twice. `--password-stdin`
reads it from stdin instead, for provisioning from a script with no TTY.

**There is deliberately no flag that takes a password.** A password on the
command line is a password in `ps`, in `/proc`, in the shell history and in
whatever your provisioning tool logs. `install.sh` and `install.ps1` follow the
same rule: neither has a password parameter, and both hand the prompt to this
CLI rather than collecting one themselves.

In order, `add`:

1. **Lower-cases and checks the username**, against
   `^[a-z0-9][a-z0-9._-]{0,31}$` — 1 to 32 characters, letters, digits, dot,
   dash or underscore, starting with a letter or a digit. The names `gateway`,
   `api`, `admin` and `root` are reserved: they are namespaces the router and
   the cookies already answer to, and an account called `api` would be confusing
   at best and a source of look-alike links at worst.
2. **Refuses a name that exists**, and says which command changes its password
   instead.
3. **Checks the password.** At least 10 characters. This server faces the
   internet.
4. **Hashes it**, then inserts the row in a transaction.

A new account starts with an empty library and, in the same transaction, the
English and multi-language half of the catalogue already installed — 166 of the
405 sources, everything whose language is `en` or `all`. Nothing is downloaded:
the sources are compiled into the server, and "installing" one is a row in
`source_state`.

The other twelve languages — Spanish, Turkish, Portuguese, Indonesian, Thai,
Arabic, French and the rest — are listed on the Sources page from the first
sign-in and switched on from there. They are off by default because search fans
out across every *installed* source, so seeding all 405 made every query wait on
hundreds of sites in languages the reader cannot read. An account that starts
with nothing has the opposite problem — an empty Sources page and a search that
reaches nothing looks like a broken install — which is why the seed is a subset
rather than none.

Seeding is guarded on "this account has no `source_state` rows at all", never on
"nothing is installed", so uninstalling everything is a choice the server never
overrides. Accounts created before this narrowed keep all 405: they have rows,
so the seed does not touch them.

## Changing a password

```bash
node server/dist/cli.js users passwd mitsu
```

Every session that account left signed in is deleted in the same transaction,
and `password_changed_at` moves — which is belt and braces: even a session row
that somehow survived would be refused, because the server checks every request
against that stamp.

Somebody changing a password usually believes the old one was learned by
somebody else, so leaving their other devices signed in would defeat the point.
Expect to sign in again on the phone; that is the feature working.

**This is the only password recovery there is.** No e-mail, no reset link, no
security question — each of those would be an anonymous path into an account,
which is precisely what this design does not have. A forgotten password is fixed
by whoever runs the server.

## Removing an account

```bash
node server/dist/cli.js users remove mitsu          # explains, changes nothing
node server/dist/cli.js users remove mitsu --yes    # actually removes
```

Without `--yes` it only prints what would happen. With it, the row goes — and so
does everything that references it.

**This destroys their library.** Every domain table carries
`user_id … REFERENCES users(username) ON DELETE CASCADE`, and the schema turns
foreign keys on at open, so a single `DELETE FROM users` takes with it:

- the library entries and every chapter row
- reading progress, `lastPageRead` and history
- categories and their memberships
- track records and the **AniList token**
- per-title and global metadata, the account's settings
- the download queue and which sources it had switched on
- every session

There is no undo and no confirmation beyond `--yes`. If there is any doubt,
export a backup from the app first — or copy `stremio4manga.db` with the server
stopped.

**Downloaded page files are left on disk.** They are in `downloads/` in the data
directory, they are large, and deleting somebody's files is not something a
one-line command should do on your behalf. Remove them yourself once you are
sure.

## Listing

```bash
node server/dist/cli.js users list
```

Username, display name and creation date. To ask the running server how many
sessions are live right now:

```bash
curl -s localhost:8080/gateway/health      # {"ok":true,"users":N,"sessions":M}
```

## Backing up an account

Two levels, and they answer different questions.

- **`stremio4manga.db`** — every account at once. The only copy. Take it with
  the server stopped, or copy the `-wal` and `-shm` files with it; a `.db`
  grabbed on its own from a running server is a torn read.
- **The account's own backup**, exported from **Settings → Backup & restore**
  inside the app, or written on a schedule into `backups/`. That is the one a
  person restores from when they delete the wrong thing, and it restores into
  any account — including a brand-new one on a different machine.

Restoring an account is therefore: `users add` the name, sign in, and restore
their backup file. Nothing about the old row travels, and no password ever
should.

## When something is wrong

| | |
|---|---|
| `No config at ...` | Copy `server/config.example.json` to `server/config.json` and set `publicOrigin`. The CLI needs it to find the database. |
| `"x" already exists.` | The account is there. `passwd` changes its password; `list` shows it. |
| `"x" will not do.` | The username failed the pattern — 1-32 characters, lower-case letters, digits, dot, dash or underscore, starting with a letter or a digit. |
| `"x" is reserved by the server itself.` | `gateway`, `api`, `admin` and `root` are router namespaces. Pick another. |
| `No account "x".` | Nothing by that name. `list` shows what there is; names are lower-cased on the way in. |
| `Password too short` | Minimum 10 characters, no exceptions. |
| `SQLITE_READONLY`, or a sign-in that never works | The database file is owned by the wrong user. On Linux this is almost always a CLI command run as root before the service ever started. `chown` it back to the service account. |
| The old session stops working right after `passwd` | By design. Sign in again. |
| Somebody says they cannot sign in at all, briefly | Eight failed attempts in fifteen minutes buys a fifteen-minute lockout. Under `login` in the config, and worth leaving alone. |
