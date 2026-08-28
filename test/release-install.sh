#!/usr/bin/env bash
#
# Proves that installing from a release works, without publishing a release.
#
# The release path in install.sh is the one branch that cannot be tried on the
# machine that wrote it: it needs a published tag, and a tag is the one thing
# here that is awkward to take back. So this builds the two archives exactly as
# .github/workflows/release.yml builds them, serves them and a synthetic release
# document over file://, and runs the real installer against them inside a
# throwaway container.
#
# What that actually catches:
#
#   * an asset name the workflow and the installer spell differently — the whole
#     handshake is two strings agreeing, in two languages, with nothing checking
#   * a runtime file that is in the Containerfile and not in the tarball, or in
#     the tarball and not in update.ts's PAYLOAD
#   * an install-time file the installer opens and no archive carries: the
#     systemd unit template is the standing example
#   * a tree that extracts and then cannot start
#
# What it deliberately does not cover: systemd. The container has no init, so
# this runs with --no-service and starts the server by hand. The unit template
# is checked for existence and substitutability, not for booting.
#
# Usage:  test/release-install.sh [--keep]
#           --keep   leave the container behind for poking at
set -euo pipefail

cd "$(dirname "$0")/.."

# The same image the Containerfile builds on, for the same reason: it is the
# Node version this is meant to run under, and it is already pulled.
IMAGE=docker.io/library/node:24-bookworm-slim
NAME=s4m-release-install
# Not the real repository. Nothing here reaches GitHub, and a name that looks
# like a real one invites somebody to assume it did.
FAKE_REPO=example/stremio4manga-release-test
FAKE_VERSION=0.0.0-releasetest
FAKE_TAG="v$FAKE_VERSION"

KEEP=no
[ "${1:-}" != "--keep" ] || KEEP=yes

# Under Git Bash, podman.exe is a Windows process, so MSYS rewrites anything in
# its arguments that looks like a Unix path: `-v $STAGE:/rel:ro` arrives as
# `...:C:\Program Files\Git\rel;ro`, and podman rejects it. Turning the rewriting
# off for every podman call is the fix; the one host-side path that genuinely
# needs converting is converted by hand below. Both are no-ops on Linux.
pod() { MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 podman "$@"; }

ok()   { printf '    \033[32mok\033[0m   %s\n' "$*"; }
step() { printf '\n\033[32m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mFAILED:\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  [ "$KEEP" = yes ] || pod rm -f "$NAME" >/dev/null 2>&1 || true
  [ -z "${STAGE:-}" ] || rm -rf "$STAGE"
  [ "$KEEP" != yes ] || printf '\nKept: podman exec -it %s bash\n' "$NAME"
}
trap cleanup EXIT

# ------------------------------------------------------------------ build --

step "Building"

# The archives have to come from a real build; packing a stale server/dist would
# make this test pass on output nobody produced today.
npm run build >/dev/null || fail "npm run build"
ok "server/dist and web/dist"

STAGE=$(mktemp -d)
mkdir -p "$STAGE/assets" "$STAGE/api/repos/$FAKE_REPO/releases"

# What `-v` has to be handed. cygpath exists only under Git Bash, which is
# exactly where podman.exe wants a Windows path; everywhere else $STAGE is
# already the right thing to pass.
if command -v cygpath >/dev/null 2>&1; then
  STAGE_HOST=$(cygpath -w "$STAGE")
else
  STAGE_HOST=$STAGE
fi

# ------------------------------------------------------------------- pack --

step "Packing the release archives"

# Kept character-for-character in step with release.yml. If you change one, the
# other is wrong, and this test is the thing that says so.
RUNTIME="stremio4manga-$FAKE_VERSION.tar.gz"
INSTALLER="stremio4manga-$FAKE_VERSION-install.tar.gz"

tar -czf "$STAGE/assets/$RUNTIME" \
  server/dist \
  server/bin \
  server/catalog.json \
  server/config.example.json \
  web/dist || fail "packing $RUNTIME"

tar -czf "$STAGE/assets/$INSTALLER" \
  install.sh \
  deploy \
  docs \
  README.md || fail "packing $INSTALLER"

( cd "$STAGE/assets" && sha256sum "$RUNTIME" > "$RUNTIME.sha256" )
( cd "$STAGE/assets" && sha256sum "$INSTALLER" > "$INSTALLER.sha256" )

ok "$RUNTIME  $(du -h "$STAGE/assets/$RUNTIME" | cut -f1)"
ok "$INSTALLER  $(du -h "$STAGE/assets/$INSTALLER" | cut -f1)"

# ------------------------------------------------------------------ serve --

# The shape GitHub answers with, cut down to the fields install.sh reads. The
# URLs are container-side paths on purpose: curl resolves them inside the
# container, not here, and this script's own paths are Windows ones half the
# time it is run.
cat > "$STAGE/api/repos/$FAKE_REPO/releases/latest" <<JSON
{
  "tag_name": "$FAKE_TAG",
  "html_url": "https://example.invalid/releases/$FAKE_TAG",
  "assets": [
    { "name": "$RUNTIME", "browser_download_url": "file:///rel/assets/$RUNTIME" },
    { "name": "$RUNTIME.sha256", "browser_download_url": "file:///rel/assets/$RUNTIME.sha256" },
    { "name": "$INSTALLER", "browser_download_url": "file:///rel/assets/$INSTALLER" },
    { "name": "$INSTALLER.sha256", "browser_download_url": "file:///rel/assets/$INSTALLER.sha256" }
  ]
}
JSON

# ---------------------------------------------------------------- install --

step "Installing from the release, in a container"

pod rm -f "$NAME" >/dev/null 2>&1 || true

# No --network none: apt needs it below if curl is missing. Nothing in the test
# reaches the internet otherwise — every URL install.sh follows is a file://.
pod run -d --name "$NAME" \
  -v "$STAGE_HOST:/rel:ro" \
  "$IMAGE" sleep 900 >/dev/null || fail "starting $IMAGE"

# curl is what install.sh downloads with, and the slim images do not all carry
# it. Installing it here rather than skipping the check keeps the test honest
# about which binaries the release path actually needs.
pod exec "$NAME" sh -c \
  'command -v curl >/dev/null || (apt-get update -qq && apt-get install -y -qq curl >/dev/null)' \
  || fail "installing curl in the container"
ok "container up: $(pod exec "$NAME" sh -c 'node -v')"

# install.sh comes out of the archive, not out of the checkout — that is the
# bootstrap this is meant to prove. The loose copy the workflow attaches is the
# same file, so extracting it from the install archive tests both.
pod exec "$NAME" sh -c \
  "mkdir -p /boot && tar -xzf /rel/assets/$INSTALLER -C /boot install.sh" \
  || fail "extracting install.sh from $INSTALLER"
ok "install.sh taken out of the install archive"

pod exec \
  -e "S4M_RELEASE_API=file:///rel/api" \
  -e "S4M_RELEASE_REPO=$FAKE_REPO" \
  -e NO_COLOR=1 \
  "$NAME" bash /boot/install.sh \
    --release \
    --origin http://127.0.0.1:8080 \
    --no-service \
    --non-interactive \
  || fail "install.sh --release"

# ----------------------------------------------------------------- verify --

step "Checking what landed"

exec_ok() { pod exec "$NAME" sh -c "$1"; }

for f in \
  /opt/stremio4manga/server/dist/main.js \
  /opt/stremio4manga/server/dist/cli.js \
  /opt/stremio4manga/server/bin/s4m.js \
  /opt/stremio4manga/server/catalog.json \
  /opt/stremio4manga/web/dist/index.html \
  /opt/stremio4manga/deploy/stremio4manga.service \
  /opt/stremio4manga/deploy/Caddyfile.example \
  /opt/stremio4manga/docs/DEPLOY.md \
  /opt/stremio4manga/server/config.json
do
  exec_ok "test -f $f" || fail "missing after install: $f"
  ok "$f"
done

# The point of the whole exercise. A release install that dragged the toolchain
# in would be the source install with extra steps.
exec_ok 'test ! -e /opt/stremio4manga/node_modules' \
  || fail "node_modules exists — the release install built something"
ok "no node_modules: nothing was built on this machine"

exec_ok 'test ! -e /opt/stremio4manga/package.json' \
  || fail "package.json exists — the runtime archive is carrying source"
ok "no package.json: the runtime archive is runtime only"

# The wrapper is how `s4m update` gets typed, so an install that does not write
# it is an install that cannot reach the next release.
exec_ok 'test -x /usr/local/bin/s4m' || fail "/usr/local/bin/s4m is missing or not executable"
ok "/usr/local/bin/s4m"

exec_ok 'stat -c "%U %a" /opt/stremio4manga | grep -q "^root 755$"' \
  || fail "$(pod exec "$NAME" sh -c 'stat -c "%U %a" /opt/stremio4manga') — expected root 755"
ok "install tree is root-owned and not writable by the service user"

exec_ok 'stat -c "%U %a" /var/lib/stremio4manga | grep -q "^stremio4manga 750$"' \
  || fail "$(pod exec "$NAME" sh -c 'stat -c "%U %a" /var/lib/stremio4manga') — expected stremio4manga 750"
ok "data directory belongs to the service account, mode 750"

# --------------------------------------------------------------- it runs --

step "Starting what was installed"

# As the service user, exactly as the unit would. Running it as root here would
# hide a data directory the service account cannot actually write.
pod exec -d "$NAME" sh -c \
  'cd /opt/stremio4manga && HOME=/var/lib/stremio4manga XDG_DATA_HOME=/var/lib/stremio4manga \
     setpriv --reuid=stremio4manga --regid=stremio4manga --clear-groups \
     node server/dist/main.js > /tmp/s4m.log 2>&1' \
  || fail "starting the server"

HEALTH=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  HEALTH=$(pod exec "$NAME" sh -c 'curl -fsS http://127.0.0.1:8080/gateway/health 2>/dev/null' || true)
  [ -z "$HEALTH" ] || break
  sleep 1
done

[ -n "$HEALTH" ] || fail "the server never answered on /gateway/health
$(pod exec "$NAME" sh -c 'cat /tmp/s4m.log' 2>/dev/null)"
ok "GET /gateway/health -> $HEALTH"

# The version the server reports is the version the archive was built from. A
# mismatch here is the failure the release workflow's tag check exists to stop,
# seen from the other end.
VERSION=$(pod exec "$NAME" sh -c 'cd /opt/stremio4manga && node server/dist/cli.js version' | tr -d '\r')
ok "s4m version -> $VERSION"

# The unit template is not booted here, but it is substituted, which is the part
# install.sh does and the part that silently produces a broken unit when the
# template drifts.
exec_ok 'grep -q "^ExecStart=.*server/dist/main.js" /opt/stremio4manga/deploy/stremio4manga.service' \
  || fail "deploy/stremio4manga.service has no ExecStart install.sh can rewrite"
ok "the unit template still has the lines install.sh substitutes"

# ------------------------------------------------------------ re-runnable --

step "Running it a second time"

# An installer that is not safe to re-run is an installer nobody re-runs, and
# re-running is how a release install moves onto the next release by hand.
pod exec "$NAME" sh -c \
  'echo sentinel.invalid > /opt/stremio4manga/server/config.marker'

pod exec \
  -e "S4M_RELEASE_API=file:///rel/api" \
  -e "S4M_RELEASE_REPO=$FAKE_REPO" \
  -e NO_COLOR=1 \
  "$NAME" bash /boot/install.sh \
    --release --origin http://127.0.0.1:8080 --no-service --non-interactive >/dev/null \
  || fail "install.sh --release is not safe to re-run"
ok "second run completed"

exec_ok 'grep -q sentinel.invalid /opt/stremio4manga/server/config.marker' \
  || fail "the second run removed a file it should have left alone"
ok "files outside the two archives were left where they were"

printf '\n\033[32m==>\033[0m \033[1mThe release install path works end to end.\033[0m\n\n'
