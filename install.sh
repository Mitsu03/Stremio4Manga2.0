#!/usr/bin/env bash
#
# Stremio4Manga installer for Linux.
#
# Installs one Node process, one SQLite database and one systemd unit. There is
# no JVM, no port per account and no per-account data directory any more; the
# whole deployment is `node server/dist/main.js` plus whatever terminates TLS in
# front of it.
#
# Two ways in, and the difference is where the built output comes from:
#
#   sudo bash install.sh --release --origin https://manga.example.com
#     Downloads a published release, verifies both archives against their
#     checksums, extracts. Nothing is built here. This is how a server should be
#     installed, and this file is attached to every release on its own so the
#     first command on a new machine can be a curl.
#
#   sudo ./install.sh --origin https://manga.example.com
#     Builds this checkout. Needs npm and ~200 MB of devDependencies, and
#     installs whatever the checkout is on -- `main`, on a fresh clone, rather
#     than the last tag. For developing, and for running something unreleased.
#
# Safe to re-run either way. Every step checks for its own result first, so
# running this again after a `git pull`, or against a newer release, replaces the
# build without touching the config, the data or the accounts.
#
# `--help` lists the rest. docs/RELEASING.md has the whole picture.

set -euo pipefail

# ---------------------------------------------------------------- defaults --

PREFIX=/opt/stremio4manga
DATA_DIR=/var/lib/stremio4manga
SERVICE_USER=stremio4manga
SERVICE_NAME=stremio4manga
S4M_BIN=/usr/local/bin/s4m
LISTEN_HOST=127.0.0.1
LISTEN_PORT=8080
ORIGIN=""
FLARESOLVERR=""
# auto: decided from publicOrigin once it is known — see "trustProxy" below.
TRUST_PROXY=auto
ADMIN_USER=""
INTERACTIVE=auto
INSTALL_SERVICE=yes
# Empty means "build this checkout". Set by --release to a tag, or to the
# literal "latest", and then the tree comes from a published release instead
# and nothing is built here at all.
RELEASE=""
RELEASE_REPO=${S4M_RELEASE_REPO:-Mitsu03/Stremio4Manga2.0}
# Overridable so the release path can be exercised without publishing a release:
# test/release-install.sh points it at a directory served over file://, which is
# the only way to prove this branch works before the first tag exists. `s4m
# update` carries the same seam for the same reason (S4M_UPDATE_REPO).
RELEASE_API_BASE=${S4M_RELEASE_API:-https://api.github.com}

# Where this script is being run from — the tree that gets copied to PREFIX.
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

MIN_NODE_MAJOR=22

# ----------------------------------------------------------------- output --

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BOLD=$'\033[1m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'
  C_GREEN=$'\033[32m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_BOLD=""; C_RED=""; C_YELLOW=""; C_GREEN=""; C_DIM=""; C_OFF=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$C_GREEN" "$C_OFF" "$C_BOLD" "$*" "$C_OFF"; }
info() { printf '    %s\n' "$*"; }
note() { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
warn() { printf '%s warning:%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }

# Every failure names the step that failed and what to do about it. A bare
# "command not found" three functions deep is how an installer earns its
# reputation.
die() {
  printf '\n%serror:%s %s\n' "$C_RED" "$C_OFF" "$1" >&2
  shift
  for line in "$@"; do printf '       %s\n' "$line" >&2; done
  exit 1
}

usage() {
  cat <<'EOF'
Stremio4Manga installer (Linux, systemd)

  From a published release. No toolchain, nothing built on the server:

    curl -fsSLO https://github.com/Mitsu03/Stremio4Manga2.0/releases/latest/download/install.sh
    sudo bash install.sh --release --origin https://manga.example.com

  From a checkout. Builds on the machine, and installs whatever the checkout
  is on -- which is main, not the last release, unless you checked out a tag:

    sudo ./install.sh --origin https://manga.example.com

Options
  --origin URL          Public URL people will type. Required, and asked for
                        interactively if omitted. Every CSRF check compares
                        against it, and its scheme decides whether the session
                        cookie is Secure.
  --release[=TAG]       Install a published release instead of building this
                        checkout. Bare it takes the latest; --release=v2.1.0
                        pins one. Downloads the runtime and install archives
                        with their checksums, verifies both before writing
                        anything, and needs neither npm nor the ~200 MB of
                        build dependencies. This is how a server should be
                        installed; building from a checkout is for developing,
                        and for testing something that is not released yet.
  --prefix DIR          Where to install the tree.        (/opt/stremio4manga)
  --data-dir DIR        Database, downloads, backups,
                        page cache, log.               (/var/lib/stremio4manga)
  --user NAME           System account that runs it.        (stremio4manga)
  --host ADDR           Listen address.                          (127.0.0.1)
  --port N              Listen port.                                  (8080)
  --no-proxy            Force trustProxy=false: nothing sits in front of the
                        server. X-Forwarded-For is then a header the client
                        writes, and trusting it lets anyone dodge the login
                        lockout by sending a different one each attempt.
  --proxy               Force trustProxy=true: Caddy, nginx or similar is in
                        front and overwrites X-Forwarded-For. Without trust
                        there, the limiter sees one client for the whole
                        internet and eight failures lock out everybody.
                        Neither flag: decided from --origin. A loopback host
                        (localhost, 127.0.0.1, ::1) means no proxy; anything
                        else means there is one. Whichever is chosen is
                        printed, and it is one line in config.json to change.
  --flaresolverr URL    FlareSolverr endpoint, e.g. http://127.0.0.1:8191.
                        Optional and external; without it, sources behind
                        Cloudflare fail with a message saying so.
  --admin NAME          Create this account at the end. The password is typed
                        at a hidden prompt — never passed on the command line,
                        because argv is visible in `ps` and in shell history.
  --no-service          Build and configure, but do not install or start the
                        systemd unit.
  --non-interactive     Never prompt. Requires --origin. Skips account
                        creation and prints the command for it instead.
  --yes                 Alias for --non-interactive.
  -h, --help            This.

Afterwards
  systemctl status stremio4manga
  journalctl -u stremio4manga -f
  sudo -u stremio4manga /usr/bin/node PREFIX/server/dist/cli.js users add NAME

See docs/DEPLOY.md for TLS, backups and moving an existing library in.
EOF
}

# ------------------------------------------------------------------- args --

# Kept for the "you are not root" message: the argument list is consumed by the
# loop below, so `$*` is empty by the time that check runs.
ORIGINAL_ARGS="$*"

while [ $# -gt 0 ]; do
  case "$1" in
    --origin)        ORIGIN=${2:-}; shift 2 ;;
    --origin=*)      ORIGIN=${1#*=}; shift ;;
    --prefix)        PREFIX=${2:-}; shift 2 ;;
    --prefix=*)      PREFIX=${1#*=}; shift ;;
    --data-dir)      DATA_DIR=${2:-}; shift 2 ;;
    --data-dir=*)    DATA_DIR=${1#*=}; shift ;;
    --user)          SERVICE_USER=${2:-}; shift 2 ;;
    --user=*)        SERVICE_USER=${1#*=}; shift ;;
    --host)          LISTEN_HOST=${2:-}; shift 2 ;;
    --host=*)        LISTEN_HOST=${1#*=}; shift ;;
    --port)          LISTEN_PORT=${2:-}; shift 2 ;;
    --port=*)        LISTEN_PORT=${1#*=}; shift ;;
    --flaresolverr)  FLARESOLVERR=${2:-}; shift 2 ;;
    --flaresolverr=*) FLARESOLVERR=${1#*=}; shift ;;
    --admin)         ADMIN_USER=${2:-}; shift 2 ;;
    --admin=*)       ADMIN_USER=${1#*=}; shift ;;
    --no-proxy)      TRUST_PROXY=false; shift ;;
    --proxy)         TRUST_PROXY=true; shift ;;
    --release)       RELEASE=latest; shift ;;
    --release=*)     RELEASE=${1#*=}; [ -n "$RELEASE" ] || RELEASE=latest; shift ;;
    --no-service)    INSTALL_SERVICE=no; shift ;;
    --non-interactive|--yes) INTERACTIVE=no; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) die "Unknown option: $1" "Run './install.sh --help' for the list." ;;
  esac
done

if [ "$INTERACTIVE" = auto ]; then
  # A TTY on stdin is the only honest test. Piping this script into bash, or
  # running it from a provisioning tool, must not hang on a read.
  if [ -t 0 ]; then INTERACTIVE=yes; else INTERACTIVE=no; fi
fi

case "$PREFIX" in /*) ;; *) die "--prefix must be an absolute path (got: $PREFIX)" ;; esac
case "$DATA_DIR" in /*) ;; *) die "--data-dir must be an absolute path (got: $DATA_DIR)" ;; esac
case "$LISTEN_PORT" in *[!0-9]*|"") die "--port must be a number (got: $LISTEN_PORT)" ;; esac

# --------------------------------------------------------------- 0. checks --

step "Checking the machine"

[ "$(id -u)" = 0 ] || die \
  "This has to run as root." \
  "It creates a system account, writes to $PREFIX and installs a systemd unit." \
  "Try: sudo ./install.sh $ORIGINAL_ARGS"

command -v systemctl >/dev/null 2>&1 || {
  [ "$INSTALL_SERVICE" = no ] || die \
    "No systemctl on this machine." \
    "This installer targets systemd. On something else, re-run with --no-service" \
    "and start it yourself with: node $PREFIX/server/dist/main.js"
}

NODE_BIN=$(command -v node || true)
[ -n "$NODE_BIN" ] || die \
  "Node is not installed, or not on root's PATH." \
  "Stremio4Manga needs Node $MIN_NODE_MAJOR or newer — the database is node:sqlite," \
  "which does not exist before 22. There are no native modules, so any build works." \
  "" \
  "  Debian/Ubuntu:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs" \
  "  Fedora/RHEL:    sudo dnf module install nodejs:22/common" \
  "  Arch:           sudo pacman -S nodejs npm" \
  "" \
  "If you installed it through nvm as your own user, root does not see it." \
  "Point at it explicitly instead:  sudo env PATH=\"\$(dirname \$(which node)):\$PATH\" ./install.sh ..."

# `node -v` prints v24.3.0; take the digits between the v and the first dot.
NODE_VERSION=$("$NODE_BIN" -v)
NODE_MAJOR=${NODE_VERSION#v}
NODE_MAJOR=${NODE_MAJOR%%.*}
case "$NODE_MAJOR" in
  *[!0-9]*|"") die "Could not read a version out of \`node -v\` (got: $NODE_VERSION)." ;;
esac
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] || die \
  "Node $NODE_VERSION is too old — $MIN_NODE_MAJOR or newer is required." \
  "The server opens its database with node:sqlite, added in Node 22. There is no" \
  "fallback and no native module to build instead; it simply will not start." \
  "Upgrade Node and run this again."

# Resolve to the real binary now. `ExecStart` needs an absolute path anyway
# (systemd's PATH is not a login shell's), and resolving a shim here beats
# discovering at 3am that /usr/local/bin/node was a symlink into a deleted nvm.
NODE_BIN=$(readlink -f "$NODE_BIN")

# npm and a checkout are needed to build, and a release install builds nothing.
# Demanding them there would refuse a machine that is perfectly able to run the
# server, which is the entire point of installing from a release.
if [ -z "$RELEASE" ]; then
  NPM_BIN=$(command -v npm || true)
  [ -n "$NPM_BIN" ] || die \
    "npm is not installed." \
    "Most Node packages ship it; on Debian and Fedora it is a separate 'npm' package." \
    "" \
    "Or skip the build entirely and install a published release instead:" \
    "  sudo ./install.sh --release --origin ..."

  info "node $NODE_VERSION at $NODE_BIN"
  info "npm  $("$NPM_BIN" -v 2>/dev/null || echo '?') at $NPM_BIN"

  [ -f "$SOURCE_DIR/package.json" ] || die \
    "No package.json next to this script." \
    "Run install.sh from the root of the checkout, not from a copy of the file." \
    "" \
    "A single copy of install.sh is enough on its own with --release:" \
    "  sudo bash install.sh --release --origin ..."
else
  info "node $NODE_VERSION at $NODE_BIN"

  # What the release path needs instead. All three are on any machine that can
  # already be administered, but naming the missing one beats a failure three
  # steps further down inside a pipeline.
  for tool in curl tar sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || die \
      "$tool is not installed, and --release needs it." \
      "Debian/Ubuntu:  sudo apt install curl tar coreutils" \
      "Fedora/RHEL:    sudo dnf install curl tar coreutils"
  done
  info "installing release: $RELEASE (from $RELEASE_REPO)"
fi

# ----------------------------------------------------------------- 1. user --

step "System account: $SERVICE_USER"

if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  info "already exists — left alone"
else
  # A login shell on this account is a way in that never needs to exist: nobody
  # ever logs in as it, and every administrative command is run with sudo -u.
  NOLOGIN=/usr/sbin/nologin
  [ -x "$NOLOGIN" ] || NOLOGIN=/sbin/nologin
  [ -x "$NOLOGIN" ] || NOLOGIN=/bin/false

  useradd --system \
    --home-dir "$DATA_DIR" \
    --no-create-home \
    --shell "$NOLOGIN" \
    --comment "Stremio4Manga server" \
    "$SERVICE_USER" \
    || die "useradd failed for $SERVICE_USER." "Create it by hand and re-run with --user $SERVICE_USER."
  info "created (system account, shell $NOLOGIN, home $DATA_DIR, not created)"
fi

# ---------------------------------------------------------------- 2. tree --

# Owned by root, readable by everyone, writable by nobody. Nothing in the tree
# is written at runtime -- the config is read at boot and all state lives in the
# data directory -- so a source parser that goes wrong cannot rewrite the server
# it is running inside.
#
# A function because both paths below end with it and neither may skip it.
harden_prefix() {
  chown -R root:root "$PREFIX"
  chmod -R u=rwX,go=rX "$PREFIX"
}

if [ -n "$RELEASE" ]; then

# A release install writes the same tree the source path builds, minus the
# building. Two archives, because they answer to two different owners: the
# runtime payload is what `s4m update` replaces on every future update, and the
# install assets -- this script, the unit template, the example Caddyfile, the
# docs -- are read once, here, and never touched again. Keeping them apart is
# what lets the updater swap a server without ever rewriting an installer.
#
# Everything that can fail happens before $PREFIX is touched: the API call, both
# downloads, both checksums, and the check that the archives actually contain a
# server. That is the ordering `s4m update` uses, for the same reason.

step "Fetching $RELEASE from $RELEASE_REPO"

TMP_DIR=$(mktemp -d) || die "Could not create a temporary directory."
trap 'rm -rf "$TMP_DIR"' EXIT

if [ "$RELEASE" = latest ]; then
  RELEASE_API="$RELEASE_API_BASE/repos/$RELEASE_REPO/releases/latest"
else
  RELEASE_API="$RELEASE_API_BASE/repos/$RELEASE_REPO/releases/tags/$RELEASE"
fi

# --fail (the f in -fsSL) so a 404 is an error rather than a JSON body that
# fails to parse two steps later. GitHub rejects an API request with no
# User-Agent outright, hence -A.
curl -fsSL \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  -A 'stremio4manga-install.sh' \
  -o "$TMP_DIR/release.json" \
  "$RELEASE_API" \
  || die "Could not read $RELEASE_API." \
         "A 404 means that tag has no release -- check the spelling, or drop the" \
         "tag to take the latest. Otherwise it is the network, or GitHub's" \
         "unauthenticated rate limit, which is 60 an hour per address and resets" \
         "on its own." \
         "" \
         "If this repository has no releases yet, build from the checkout instead:" \
         "  sudo ./install.sh --origin $ORIGIN"

# node rather than jq: jq is not installed everywhere and node already is -- it
# is the thing being installed. Emitting shell assignments keeps the parsing in
# one place, and the quote check below is what makes sourcing them safe.
"$NODE_BIN" - "$TMP_DIR/release.json" > "$TMP_DIR/release.env" <<'JS' \
  || die "The GitHub API answered with something this cannot read."
const release = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const assets = release.assets || [];
const url = (name) => (assets.find((a) => a.name === name) || {}).browser_download_url || '';

const tag = release.tag_name || '';
const version = tag.replace(/^v/, '');
if (!version) {
  console.error('That release has no tag name, so there is nothing to install.');
  process.exit(1);
}

const runtime = `stremio4manga-${version}.tar.gz`;
const installer = `stremio4manga-${version}-install.tar.gz`;
const fields = {
  RELEASE_TAG: tag,
  RELEASE_VERSION: version,
  RUNTIME_TAR: runtime,
  RUNTIME_URL: url(runtime),
  RUNTIME_SHA_URL: url(`${runtime}.sha256`),
  INSTALL_TAR: installer,
  INSTALL_URL: url(installer),
  INSTALL_SHA_URL: url(`${installer}.sha256`),
};

for (const [key, value] of Object.entries(fields)) {
  // Single-quoted below, so a value carrying a quote would end the string and
  // let the rest of it run as shell. Nothing the release workflow produces
  // contains one; a value that does is not a release this should install.
  if (value.includes("'")) {
    console.error(`Refusing an asset name containing a quote: ${value}`);
    process.exit(1);
  }
  console.log(`${key}='${value}'`);
}
JS

# shellcheck source=/dev/null
. "$TMP_DIR/release.env"

info "release $RELEASE_TAG"

[ -n "$RUNTIME_URL" ] && [ -n "$RUNTIME_SHA_URL" ] || die \
  "Release $RELEASE_TAG has no $RUNTIME_TAR and .sha256 pair." \
  "That is either a release built by hand, or one whose workflow failed after" \
  "creating the release but before uploading the assets. Check the release page" \
  "before installing anything from it."

[ -n "$INSTALL_URL" ] && [ -n "$INSTALL_SHA_URL" ] || die \
  "Release $RELEASE_TAG has no $INSTALL_TAR, so it predates --release." \
  "Releases before that one carry the runtime payload only, and the systemd unit" \
  "template this installer needs is not in it." \
  "" \
  "Install a newer release, or build this checkout:" \
  "  sudo ./install.sh --origin $ORIGIN"

step "Downloading and verifying"

# $1 archive name, $2 archive URL, $3 checksum URL.
fetch_and_verify() {
  curl -fsSL -A 'stremio4manga-install.sh' -o "$TMP_DIR/$1" "$2" \
    || die "Downloading $1 failed." "Check the network and run this again; nothing has been changed."
  curl -fsSL -A 'stremio4manga-install.sh' -o "$TMP_DIR/$1.sha256" "$3" \
    || die "Downloading $1.sha256 failed." "Nothing has been changed."

  # The published .sha256 is `sha256sum` output -- hash, two spaces, filename --
  # and the file was saved under that same name, so -c checks it directly.
  ( cd "$TMP_DIR" && sha256sum -c "$1.sha256" >/dev/null 2>&1 ) \
    || die "$1 does not match its published checksum." \
           "Nothing has been changed. A truncated download is the ordinary" \
           "explanation, so run this again; if it repeats, do not install it."
  info "$1  $(du -h "$TMP_DIR/$1" | cut -f1), checksum verified"
}

fetch_and_verify "$RUNTIME_TAR" "$RUNTIME_URL" "$RUNTIME_SHA_URL"
fetch_and_verify "$INSTALL_TAR" "$INSTALL_URL" "$INSTALL_SHA_URL"

step "Installing the tree into $PREFIX"

mkdir -p "$PREFIX"

# Neither archive contains server/config.json -- a server's configuration is its
# own, and an install that overwrote it would replace a working publicOrigin
# with an example one. Re-running this on an existing install is therefore safe:
# it replaces the build and the docs and leaves the config, the database and the
# downloads alone.
tar -xzf "$TMP_DIR/$RUNTIME_TAR" -C "$PREFIX" \
  || die "Extracting $RUNTIME_TAR into $PREFIX failed." "Check free space and permissions on $PREFIX."
tar -xzf "$TMP_DIR/$INSTALL_TAR" -C "$PREFIX" \
  || die "Extracting $INSTALL_TAR into $PREFIX failed." "Check free space and permissions on $PREFIX."

# Proof that the extraction produced a server and not an empty directory tree.
# The first three are what `s4m update` checks, for the same reason; the unit
# template is the one thing this installer additionally cannot do without.
for required in \
  server/dist/main.js \
  server/dist/cli.js \
  web/dist/index.html \
  deploy/stremio4manga.service
do
  [ -f "$PREFIX/$required" ] || die \
    "$RELEASE_TAG extracted without $required, so it is not a complete release." \
    "Check the release page before installing anything from it."
done

harden_prefix
info "installed $RELEASE_TAG -- nothing was built here, and nothing needed to be"

else

# ---------------------------------------------------------------- 2. files --

step "Installing the tree into $PREFIX"

# The tree is COPIED rather than run from wherever it was cloned. The unit
# hard-codes the path, ProtectSystem=strict makes it read-only at runtime, and a
# checkout in someone's home directory is neither stable nor readable by a
# system account with ProtectHome=yes.
if [ "$SOURCE_DIR" = "$PREFIX" ]; then
  info "already running from $PREFIX — nothing to copy"
else
  mkdir -p "$PREFIX"
  # node_modules and dist are rebuilt below; copying them across would drag a
  # developer machine's platform-specific binaries onto the server. .git is
  # excluded because the server does not need history, and it is usually the
  # largest thing in the tree.
  ( cd "$SOURCE_DIR" && tar -cf - \
      --exclude=./.git \
      --exclude=./node_modules \
      --exclude='./*/node_modules' \
      --exclude=./server/dist \
      --exclude=./web/dist \
      --exclude=./server/config.json \
      . ) | ( cd "$PREFIX" && tar -xf - ) \
    || die "Copying $SOURCE_DIR to $PREFIX failed." "Check free space and permissions on $PREFIX."
  info "copied from $SOURCE_DIR (without .git, node_modules, dist, config.json)"
fi

harden_prefix


# --------------------------------------------------------------- 3. build --

step "Installing dependencies and building"

note "npm ci installs devDependencies on purpose: esbuild bundles the server and"
note "vite builds the UI, and both are devDependencies. Pruning happens after."

cd "$PREFIX"
export npm_config_update_notifier=false
export npm_config_fund=false
export npm_config_audit=false

"$NPM_BIN" ci --no-audit --no-fund \
  || die "\`npm ci\` failed in $PREFIX." \
         "There are no native modules here, so it is the network, a lockfile that" \
         "does not match package.json, or — if the error says EBADPLATFORM for a" \
         "package belonging to some other OS — a lockfile carrying stale" \
         "\"extraneous\" entries, which npm installs for real instead of skipping." \
         "That last one is fixed at the source: delete node_modules, run" \
         "\`npm install\`, and commit the smaller package-lock.json." \
         "Re-run it by hand to see the full output:  cd $PREFIX && npm ci"

"$NPM_BIN" run build \
  || die "\`npm run build\` failed in $PREFIX." \
         "This builds server/dist (esbuild) and web/dist (tsc + vite)." \
         "Re-run it by hand to see which of the two:  cd $PREFIX && npm run build"

[ -f "$PREFIX/server/dist/main.js" ] || die \
  "The build reported success but $PREFIX/server/dist/main.js is missing." \
  "Run 'npm run build -w server' in $PREFIX and read the output."
[ -f "$PREFIX/web/dist/index.html" ] || die \
  "The build reported success but $PREFIX/web/dist/index.html is missing." \
  "Run 'npm run build -w web' in $PREFIX and read the output."

# Both bundles are self-contained — esbuild inlines every dependency except
# node:*, and vite does the same for the UI — so nothing under node_modules is
# needed at runtime. Pruning is disk hygiene and one less thing to audit, not a
# correctness requirement, hence a warning rather than a failure.
"$NPM_BIN" prune --omit=dev >/dev/null 2>&1 \
  || warn "npm prune --omit=dev failed; node_modules keeps its build tools. Harmless."

info "server/dist and web/dist built"

fi


# --------------------------------------------------------------- 3b. s4m --

# A wrapper rather than a symlink to server/bin/s4m.js, for two reasons: the
# file is not marked executable in the repository, and its `#!/usr/bin/env node`
# would have to find node on a PATH that `sudo` has usually already stripped.
# Both go away when the absolute path to the interpreter is written down here.
#
# It matters because `s4m update` is how this install gets to the next release,
# and an update command nobody can type is an update command nobody runs.
step "Command: $S4M_BIN"

if [ -e "$S4M_BIN" ] && [ ! -f "$S4M_BIN" ]; then
  warn "$S4M_BIN exists and is not a regular file; leaving it alone."
  note "run s4m as: $NODE_BIN $PREFIX/server/bin/s4m.js"
else
  mkdir -p "$(dirname "$S4M_BIN")"
  cat > "$S4M_BIN" <<EOF
#!/bin/sh
# Installed by Stremio4Manga's install.sh. Regenerated on every re-run.
exec "$NODE_BIN" "$PREFIX/server/bin/s4m.js" "\$@"
EOF
  chmod 755 "$S4M_BIN"
  info "s4m version, s4m users, s4m update"
fi

# ------------------------------------------------------------ 4. data dir --

step "Data directory: $DATA_DIR"

mkdir -p "$DATA_DIR"
chown "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR"
# 0750: the database holds every account's library and its password hashes.
# There is no reason for another user on the machine to read it.
chmod 750 "$DATA_DIR"
info "owned by $SERVICE_USER, mode 750"
note "holds stremio4manga.db, downloads/, backups/, cache/, thumbnails/ and the log"

# ------------------------------------------------------------- 5. config --

step "Config: $PREFIX/server/config.json"

CONFIG="$PREFIX/server/config.json"

if [ -f "$CONFIG" ]; then
  info "already exists — left exactly as it is"
  note "delete it and re-run this script to regenerate, or edit it by hand"
  EXISTING_ORIGIN=$("$NODE_BIN" -e '
    try {
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (typeof c.publicOrigin === "string") process.stdout.write(c.publicOrigin);
    } catch {}
  ' "$CONFIG" 2>/dev/null || true)
  [ -z "$EXISTING_ORIGIN" ] || ORIGIN="$EXISTING_ORIGIN"
else
  if [ -z "$ORIGIN" ]; then
    if [ "$INTERACTIVE" = no ]; then
      die "No --origin, and this is a non-interactive run." \
          "publicOrigin is the URL people type, e.g. https://manga.example.com." \
          "It is not optional: every CSRF check compares against it, and its" \
          "scheme is what decides whether the session cookie is Secure." \
          "Re-run with:  --origin https://manga.example.com"
    fi
    printf '\n'
    printf '    The public URL people will type, e.g. https://manga.example.com\n'
    printf '    Use http://HOST:PORT only if there will be no TLS in front.\n\n'
    printf '    publicOrigin: '
    read -r ORIGIN
    [ -n "$ORIGIN" ] || die "publicOrigin cannot be empty."
  fi

  # Validated here, with the same parser the server uses, so a typo is caught
  # now rather than at the first `systemctl start`.
  "$NODE_BIN" -e '
    const raw = process.argv[1];
    let url;
    try { url = new URL(raw); } catch { console.error("not a URL"); process.exit(1); }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      console.error("scheme must be http or https"); process.exit(1);
    }
  ' "$ORIGIN" >/dev/null 2>&1 \
    || die "publicOrigin is not a usable URL: $ORIGIN" \
           "It needs a scheme and a host, e.g. https://manga.example.com."

  # trustProxy, when neither --proxy nor --no-proxy said so.
  #
  # There is no safe default for this key, only a correct one and a broken one,
  # and which is which depends on something the server cannot see: whether
  # anything rewrites X-Forwarded-For before it arrives. The origin is the best
  # evidence available at install time — a loopback host is somebody running
  # this on their own machine with nothing in front; a real hostname means a
  # proxy is terminating TLS for it. Whatever is chosen gets printed, so a wrong
  # guess is visible now rather than the day the lockout is tested.
  if [ "$TRUST_PROXY" = auto ]; then
    TRUST_HOST=$("$NODE_BIN" -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$ORIGIN")
    case "$TRUST_HOST" in
      localhost|127.0.0.1|::1|"[::1]") TRUST_PROXY=false ;;
      *) TRUST_PROXY=true ;;
    esac
    TRUST_REASON="derived from publicOrigin"
  else
    TRUST_REASON="you asked for it"
  fi

  # Written with node rather than a heredoc so the origin and the solver URL are
  # JSON-escaped by something that knows the rules.
  #
  # Only the keys that are genuinely deployment decisions are written. Anything
  # left out keeps the default in server/src/config.ts, and a default restated
  # in a file is indistinguishable from a deliberate override — only one of the
  # two is still correct after the code changes. `secureCookies` in particular
  # is derived from the scheme of publicOrigin and must not be pinned.
  #
  # Into a temporary file and then moved into place. `> "$CONFIG"` truncates the
  # target before node runs, so a failure there would leave an empty config.json
  # behind — and the next run would take the "already exists" branch above and
  # never regenerate it.
  CONFIG_TMP="$CONFIG.new.$$"
  "$NODE_BIN" -e '
    const [origin, host, port, trust, solver, dataDir] = process.argv.slice(1);
    const config = {
      publicOrigin: origin,
      listen: { host, port: Number(port) },
      trustProxy: trust === "true",
      dataDir,
    };
    if (solver) config.flaresolverr = { url: solver, timeoutMs: 60000 };
    process.stdout.write(JSON.stringify(config, null, 2) + "\n");
  ' "$ORIGIN" "$LISTEN_HOST" "$LISTEN_PORT" "$TRUST_PROXY" "$FLARESOLVERR" "$DATA_DIR" > "$CONFIG_TMP" \
    || { rm -f "$CONFIG_TMP"; die "Could not write $CONFIG."; }

  # Readable by the service account, not by the rest of the machine: with a
  # FlareSolverr URL in it, this file can name an internal host. Set on the
  # temporary file, before the move, so the finished config is never briefly
  # world-readable.
  chown root:"$SERVICE_USER" "$CONFIG_TMP"
  chmod 640 "$CONFIG_TMP"
  mv "$CONFIG_TMP" "$CONFIG" || die "Could not move $CONFIG_TMP to $CONFIG."

  info "written — publicOrigin $ORIGIN, listen $LISTEN_HOST:$LISTEN_PORT"
  [ -z "$FLARESOLVERR" ] || info "flaresolverr $FLARESOLVERR"
  if [ "$TRUST_PROXY" = true ]; then
    info "trustProxy: true ($TRUST_REASON)"
    note "Right behind Caddy or nginx. With NOTHING in front, this is wrong —"
    note "X-Forwarded-For is then client-supplied and the login lockout becomes"
    note "decoration. Set trustProxy to false in config.json and restart."
  else
    info "trustProxy: false ($TRUST_REASON)"
    note "Right with nothing in front. The day a reverse proxy goes there, set it"
    note "back to true, or the limiter buckets the whole internet as one client"
    note "and eight failed sign-ins lock everybody out."
  fi
fi

# ------------------------------------------------------------- 6. service --

if [ "$INSTALL_SERVICE" = yes ]; then
  step "systemd unit: $SERVICE_NAME.service"

  UNIT_SRC="$PREFIX/deploy/stremio4manga.service"
  UNIT_DST="/etc/systemd/system/$SERVICE_NAME.service"
  [ -f "$UNIT_SRC" ] || die "Missing $UNIT_SRC." "The deploy/ directory did not come across."

  # The template ships with the defaults spelled out; substitute whatever this
  # run actually chose. Anchored to the start of the line so a path that also
  # appears inside a comment is rewritten too — which is what you want, since
  # those comments name the same directories.
  sed \
    -e "s|^User=.*|User=$SERVICE_USER|" \
    -e "s|^Group=.*|Group=$SERVICE_USER|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$PREFIX|" \
    -e "s|^ExecStart=.*|ExecStart=$NODE_BIN $PREFIX/server/dist/main.js|" \
    -e "s|^Environment=HOME=.*|Environment=HOME=$DATA_DIR|" \
    -e "s|^Environment=XDG_DATA_HOME=.*|Environment=XDG_DATA_HOME=$DATA_DIR|" \
    -e "s|^ReadWritePaths=.*|ReadWritePaths=$DATA_DIR|" \
    "$UNIT_SRC" > "$UNIT_DST" \
    || die "Could not write $UNIT_DST."

  # StateDirectory= names a directory under /var/lib and creates it owned by
  # User=. It only makes sense while the data directory IS under /var/lib;
  # elsewhere it would silently create a second, unused directory.
  case "$DATA_DIR" in
    /var/lib/*/*) sed -i '/^StateDirectory=/d' "$UNIT_DST" ;;
    /var/lib/*)   sed -i "s|^StateDirectory=.*|StateDirectory=${DATA_DIR#/var/lib/}|" "$UNIT_DST" ;;
    *)            sed -i '/^StateDirectory=/d' "$UNIT_DST" ;;
  esac

  chmod 644 "$UNIT_DST"
  systemctl daemon-reload || die "systemctl daemon-reload failed."
  info "installed at $UNIT_DST"

  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 \
    || die "systemctl enable $SERVICE_NAME failed." "Read: systemctl status $SERVICE_NAME"

  # restart rather than start, so re-running this after a git pull actually
  # picks up the new build instead of reporting "already running".
  systemctl restart "$SERVICE_NAME" \
    || die "The service would not start." \
           "The reason is in the log:  journalctl -u $SERVICE_NAME -n 50 --no-pager"

  # A unit can be "active" for the half second before Node reaches the bind and
  # exits. Give it that half second before claiming success.
  sleep 2
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    info "running, and enabled at boot"
  else
    die "The service started and then stopped." \
        "Almost always the config or the port. The reason is in:" \
        "  journalctl -u $SERVICE_NAME -n 50 --no-pager"
  fi
else
  step "systemd unit"
  info "skipped (--no-service)"
  note "start it yourself with: $NODE_BIN $PREFIX/server/dist/main.js"
fi

# ------------------------------------------------------------ 7. accounts --

step "Accounts"

CLI="$NODE_BIN $PREFIX/server/dist/cli.js"

# runuser is part of util-linux and is on every systemd machine; sudo is not
# guaranteed to be installed. Either keeps the terminal attached, which the
# hidden password prompt needs.
if command -v runuser >/dev/null 2>&1; then
  AS_SERVICE="runuser -u $SERVICE_USER --"
elif command -v sudo >/dev/null 2>&1; then
  AS_SERVICE="sudo -u $SERVICE_USER"
else
  AS_SERVICE=""
  warn "Neither runuser nor sudo is here, so this script cannot drop to $SERVICE_USER."
  warn "Account commands below have to be run as that user by hand."
fi

# What to print. `$AS_SERVICE $CLI` would render with a stray leading space when
# there is no runuser and no sudo.
if [ -n "$AS_SERVICE" ]; then ACCOUNT_CMD="$AS_SERVICE $CLI"; else ACCOUNT_CMD="$CLI"; fi

# Deliberately not run as root: the CLI opens the database, and opening it when
# it does not exist yet CREATES it. As root that would leave a root-owned
# stremio4manga.db that the service then cannot write to — a failure that only
# surfaces on the first sign-in.
ACCOUNT_COUNT=0
if [ -n "$AS_SERVICE" ]; then
  ACCOUNT_COUNT=$($AS_SERVICE $CLI users list 2>/dev/null \
    | grep -cve '^username' -e '^No accounts' || true)
fi

if [ "${ACCOUNT_COUNT:-0}" -gt 0 ]; then
  info "$ACCOUNT_COUNT already exist — none created"
elif [ "$INTERACTIVE" = no ] || [ -z "$AS_SERVICE" ]; then
  info "none yet, and this run cannot prompt for a password"
  note "There is no registration page and no first-run claim, by decision: the"
  note "only thing an anonymous request can do is fail to sign in. Create the"
  note "first account yourself:"
  note ""
  note "  $ACCOUNT_CMD users add NAME"
else
  if [ -z "$ADMIN_USER" ]; then
    printf '\n'
    printf '    There is no registration page: accounts are created here and\n'
    printf '    nowhere else. Enter a username for the first one, or press Enter\n'
    printf '    to skip and do it later.\n\n'
    printf '    username: '
    read -r ADMIN_USER
  fi

  if [ -n "$ADMIN_USER" ]; then
    # The CLI does the asking. The password is typed at a hidden prompt inside
    # that process and hashed before anything is written, so it never reaches
    # argv, `ps`, this script's environment or the shell history — which is also
    # why there is no --password flag anywhere in this installer.
    if $AS_SERVICE $CLI users add "$ADMIN_USER"; then
      info "created \"$ADMIN_USER\" — no restart needed, sign-in works immediately"
    else
      warn "Creating \"$ADMIN_USER\" did not finish. Nothing was written."
      warn "Try again with: $ACCOUNT_CMD users add $ADMIN_USER"
    fi
  else
    info "skipped"
  fi
fi

# -------------------------------------------------------------- 8. summary --

cat <<EOF

$C_GREEN==>$C_OFF $C_BOLD Done.$C_OFF

  URL              $ORIGIN
  Listening on     http://$LISTEN_HOST:$LISTEN_PORT
  Installed in     $PREFIX
  Config           $PREFIX/server/config.json
  Data             $DATA_DIR
                     stremio4manga.db   the library, accounts and sessions
                     downloads/         chapters kept for offline reading
                     backups/           the automated backup schedule
                     cache/             page cache
                     thumbnails/
                     stremio4manga.log  rotated at 5 MB, three kept

  Logs             journalctl -u $SERVICE_NAME -f
                   tail -f $DATA_DIR/stremio4manga.log
  Service          systemctl status|restart|stop $SERVICE_NAME
  Health           curl -s http://$LISTEN_HOST:$LISTEN_PORT/gateway/health

  Accounts         $ACCOUNT_CMD users add NAME
                   $ACCOUNT_CMD users passwd NAME
                   $ACCOUNT_CMD users list
                   $ACCOUNT_CMD users remove NAME --yes

  Updates          sudo s4m update --check
                   sudo s4m update --yes --restart
                   Installs the latest release over this one; the config, the
                   database and the downloads are not touched, and the build it
                   replaces is kept for \`sudo s4m rollback\`. See docs/RELEASING.md.

EOF

case "$ORIGIN" in
  https://*)
    if [ "$LISTEN_HOST" = "127.0.0.1" ] || [ "$LISTEN_HOST" = "::1" ]; then
      cat <<EOF
  Still to do: TLS. The server never terminates it and is only reachable from
  this machine. Put Caddy in front — $PREFIX/deploy/Caddyfile.example is a
  complete config, certificate included. Details in $PREFIX/docs/DEPLOY.md.

EOF
    fi
    ;;
  http://*)
    cat <<EOF
  publicOrigin is http://, so the session cookie is not Secure and everything —
  passwords included — crosses the network in the clear. That is fine on a
  loopback or a trusted LAN and wrong on anything else. See docs/DEPLOY.md.

EOF
    ;;
esac
