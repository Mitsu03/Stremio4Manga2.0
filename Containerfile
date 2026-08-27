# Stremio4Manga 2.0 — one process, one port, one database.
#
# Linux is the primary target, and this is the shortest honest description of
# what a Linux deployment needs: a Node runtime and the built output. There is
# no JVM, no Chromium, and no native module to compile — which is the whole
# reason a container image for this is small and one for the server it replaces
# was not.
#
# Build:  podman build -t stremio4manga .
# Run:    podman run --rm -p 8080:8080 \
#           -v ./server/config.json:/app/server/config.json:ro \
#           -v s4m-data:/data stremio4manga
#
# Set dataDir to /data in the mounted config; the volume is what survives a
# rebuild.

FROM docker.io/library/node:24-bookworm-slim AS build

WORKDIR /app

# Manifests first so a dependency install is only redone when they change.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build


# A stage that proves the image works rather than only that it built. Used by
# test/podman-validate.sh: the runtime image deliberately carries no test
# tooling, so the checks run against the build stage instead.
#
# It sits *before* the runtime stage on purpose. A build with no --target builds
# the last stage in the file, so leaving this at the end would quietly make
# `podman build -t stremio4manga .` produce the test image.
FROM build AS validate
CMD ["node", "test/smoke.mjs"]


FROM docker.io/library/node:24-bookworm-slim AS runtime

# Runs as a normal user. Nothing here needs root, and a manga reader is not a
# reason to hand a container one.
RUN useradd --system --create-home --home-dir /home/s4m --shell /usr/sbin/nologin s4m \
    && mkdir -p /data && chown s4m:s4m /data

WORKDIR /app

# Only what the server actually reads at runtime: the two bundles, the CLI shim,
# the source catalogue, and the built UI. No node_modules — the bundle carries
# its dependencies.
COPY --from=build --chown=s4m:s4m /app/server/dist ./server/dist
COPY --from=build --chown=s4m:s4m /app/server/bin ./server/bin
COPY --from=build --chown=s4m:s4m /app/server/catalog.json ./server/
COPY --from=build --chown=s4m:s4m /app/server/config.example.json ./server/
COPY --from=build --chown=s4m:s4m /app/web/dist ./web/dist

USER s4m

# Both data roots derive from these, and a container image sets neither by
# default — the same trap the systemd unit documents.
ENV HOME=/home/s4m \
    XDG_DATA_HOME=/data \
    NODE_ENV=production

EXPOSE 8080
VOLUME ["/data"]

# The server never terminates TLS; put a reverse proxy in front of the port.
CMD ["node", "server/dist/main.js"]
