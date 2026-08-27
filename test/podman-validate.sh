#!/usr/bin/env bash
#
# Proves the container image works, not only that it builds.
#
# Two things are checked, and they fail in different ways:
#
#   1. The *validate* stage runs the offline smoke suite inside the image, with
#      no network at all. That catches a build whose bundle is subtly wrong —
#      a missing embedded schema, a dependency that resolved on the host and
#      not in the image.
#   2. The *runtime* stage is started for real: a config, a data volume, a
#      published port, an account created through the CLI, a sign-in, a
#      GraphQL call, and a redeploy to prove the volume is what survives. That
#      catches everything the first check cannot see — the wrong user, an
#      unwritable /data, a port bound to the loopback *inside* the container.
#
# Usage:  test/podman-validate.sh [--keep]
#           --keep   leave the container and volume behind for poking at
#
# Nothing here touches the host's own data directory, and every name is
# suffixed so a real deployment on the same machine is never the thing that
# gets torn down.
set -euo pipefail

cd "$(dirname "$0")/.."

# Why every container-side path below is wrapped in `sh -c`: under Git Bash,
# podman.exe is a Windows process, so the shell rewrites bare Unix paths in its
# arguments — `podman exec c test -w /data` silently asks about
# C:/Program Files/Git/data and answers no. Inside a quoted `sh -c` string the
# path is just text and survives. Turning the rewriting off globally is not the
# fix: host-side paths (the temp config handed to `podman cp`) need it on.

IMAGE=localhost/stremio4manga:validate
BUILD_IMAGE=localhost/stremio4manga:validate-build
NAME=s4m-validate
VOLUME=s4m-validate-data
# Not 8080: a developer running the server on this machine is the common case,
# and taking their port out from under them is a rude way to fail.
PORT=18080
ORIGIN="http://127.0.0.1:${PORT}"
PASSWORD='validate-pw-9271'

KEEP=no
[ "${1:-}" = "--keep" ] && KEEP=yes

pass=0
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
die()  { printf '  \033[31mFAIL\033[0m %s\n' "$1" >&2; exit 1; }

cleanup() {
  status=$?
  if [ "$KEEP" = yes ]; then
    printf '\nLeft behind: container %s, volume %s, images %s and %s\n' \
      "$NAME" "$VOLUME" "$IMAGE" "$BUILD_IMAGE"
  else
    podman rm -f "$NAME" >/dev/null 2>&1 || true
    podman volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  fi
  [ -n "${WORKDIR:-}" ] && rm -rf "$WORKDIR"
  exit $status
}
trap cleanup EXIT

WORKDIR=$(mktemp -d)

# Leftovers from an interrupted run would make every check below meaningless.
podman rm -f "$NAME" >/dev/null 2>&1 || true
podman volume rm -f "$VOLUME" >/dev/null 2>&1 || true

# Every wait in this script is the same wait: the server is up when it answers,
# and 60 seconds is long enough for a cold container on a slow disk.
wait_for_health() {
  local i answer=''
  for i in $(seq 1 60); do
    answer=$(curl -fsS "${ORIGIN}/gateway/health" 2>/dev/null) && { printf '%s' "$answer"; return 0; }
    sleep 1
  done
  return 1
}

# Recreating from the same volume, which is what a pull-and-redeploy actually
# does. The config is copied into the container's own filesystem rather than
# bind-mounted: a host path mounted into a Podman machine on Windows is a
# different thing than on Linux, and this script has to mean the same on both.
deploy() {
  podman create --name "$NAME" -p "127.0.0.1:${PORT}:8080" -v "$VOLUME:/data" "$IMAGE" >/dev/null
  podman cp "$WORKDIR/config.json" "$NAME:/app/server/config.json"
  podman start "$NAME" >/dev/null
}


step "Build"

podman build --target validate -t "$BUILD_IMAGE" . >"$WORKDIR/build-validate.log" 2>&1 \
  || { tail -30 "$WORKDIR/build-validate.log"; die "the validate stage did not build"; }
ok "the validate stage builds"

podman build -t "$IMAGE" . >"$WORKDIR/build-runtime.log" 2>&1 \
  || { tail -30 "$WORKDIR/build-runtime.log"; die "the runtime stage did not build"; }
ok "the runtime stage builds"

# A default build must not land on the test stage. It sits before runtime in the
# Containerfile for exactly this reason, and a reordering would go unnoticed.
podman image inspect "$IMAGE" --format '{{.Config.Cmd}}' | grep -q 'server/dist/main.js' \
  || die "a default build produced the wrong stage: its CMD is not the server"
ok "a default build is the runtime stage, not the test stage"


step "The suite runs inside the image, with no network"

# --network=none is the point: the bundle has to be self-contained. Anything
# that quietly reached the internet during the host run fails here.
podman run --rm --network=none "$BUILD_IMAGE" node test/smoke.mjs --offline \
  >"$WORKDIR/smoke.log" 2>&1 \
  || { tail -40 "$WORKDIR/smoke.log"; die "the offline suite failed inside the image"; }
grep -q 'checks passed' "$WORKDIR/smoke.log" || die "the suite did not report a pass"
ok "$(grep -o 'All [0-9]* checks passed' "$WORKDIR/smoke.log") in the image"


step "Run"

# 0.0.0.0, and only here. The host config keeps 127.0.0.1 because there the
# loopback is the boundary; in a container the namespace is, and binding to the
# loopback would publish a port nothing answers on.
cat >"$WORKDIR/config.json" <<JSON
{
  "publicOrigin": "${ORIGIN}",
  "listen": { "host": "0.0.0.0", "port": 8080 },
  "trustProxy": false,
  "dataDir": "/data",
  "uiDist": "/app/web/dist",
  "flaresolverr": { "url": "", "timeoutMs": 60000 }
}
JSON

podman volume create "$VOLUME" >/dev/null
deploy

health=$(wait_for_health) \
  || { podman logs "$NAME" | tail -30; die "the server never answered on the published port"; }
echo "$health" | grep -q '"ok":true' || die "health said: $health"
ok "the published port answers /gateway/health"

echo "$health" | grep -q '"users":0' || die "a fresh volume already had accounts: $health"
ok "a fresh volume starts with no accounts"

[ "$(podman exec "$NAME" id -u)" != "0" ] || die "the server is running as root"
ok "the server runs as a normal user, not root"

podman exec "$NAME" sh -c 'test -w /data' || die "/data is not writable by the server user"
ok "/data is writable by the server user"

# The sign-in form is the one page served before a session exists; the app shell
# behind it must not be.
curl -fsS "${ORIGIN}/gateway/login" | grep -qi '<form' || die "the sign-in page is not being served"
ok "the sign-in page is served"

code=$(curl -s -o /dev/null -w '%{http_code}' "${ORIGIN}/api/graphql" -X POST \
  -H 'Content-Type: application/json' -H "Origin: ${ORIGIN}" -d '{"query":"{ __typename }"}')
[ "$code" = "401" ] || die "an unauthenticated GraphQL call answered $code, not 401"
ok "GraphQL refuses an unauthenticated call"


step "An account, end to end"

printf '%s' "$PASSWORD" | podman exec -i "$NAME" node server/bin/s4m.js users add validator --password-stdin \
  >"$WORKDIR/useradd.log" 2>&1 || { cat "$WORKDIR/useradd.log"; die "the CLI could not add an account"; }
ok "the CLI adds an account inside the container"

login=$(curl -sS -c "$WORKDIR/cookies" "${ORIGIN}/gateway/login" -X POST \
  -H 'Content-Type: application/json' -H "Origin: ${ORIGIN}" \
  -d "{\"username\":\"validator\",\"password\":\"${PASSWORD}\"}")
echo "$login" | grep -q '"username":"validator"' || die "sign-in said: $login"
grep -q 'session' "$WORKDIR/cookies" || die "sign-in set no session cookie"
ok "the account signs in and gets a session cookie"

me=$(curl -fsS -b "$WORKDIR/cookies" "${ORIGIN}/gateway/me")
echo "$me" | grep -q '"username":"validator"' || die "/gateway/me said: $me"
ok "the session is accepted on a following request"

gql=$(curl -fsS -b "$WORKDIR/cookies" "${ORIGIN}/api/graphql" -X POST \
  -H 'Content-Type: application/json' -H "Origin: ${ORIGIN}" \
  -d '{"query":"{ categories { nodes { id name } } }"}')
echo "$gql" | grep -q '"categories"' || die "GraphQL said: $gql"
! echo "$gql" | grep -q '"errors"' || die "GraphQL returned errors: $gql"
ok "an authenticated GraphQL query answers"

# The UI is copied into the runtime stage as its own layer; a missing web/dist
# is a build mistake that only shows up here.
curl -fsS -b "$WORKDIR/cookies" "${ORIGIN}/" | grep -qi 'id="root"' \
  || die "the built UI is not being served"
ok "the built UI is served to a signed-in session"


step "The volume is what survives"

podman exec "$NAME" sh -c 'find /data -maxdepth 2 -name "*.db" | grep -q .' \
  || { podman exec "$NAME" sh -c 'find /data -type f' | head -20; die "no database under /data"; }
ok "the database is written under /data"

podman restart "$NAME" >/dev/null
after=$(wait_for_health) \
  || { podman logs "$NAME" | tail -30; die "the server did not come back after a restart"; }
echo "$after" | grep -q '"users":1' || die "the account did not survive the restart: $after"
ok "the account survives a restart of the container"

# A restart is not a new container. Destroying and recreating against the same
# volume is what a redeploy does, and it is the only check that proves the data
# lives in the volume rather than in the container's writable layer.
podman rm -f "$NAME" >/dev/null
deploy
recreated=$(wait_for_health) \
  || { podman logs "$NAME" | tail -30; die "a recreated container did not start"; }
echo "$recreated" | grep -q '"users":1' || die "a recreated container lost the account: $recreated"
ok "the account survives the container being destroyed and recreated"

printf '\n\033[32mAll %d checks passed.\033[0m\n' "$pass"
