# syntax=docker/dockerfile:1
#
# ohmail web application — the SELF-HOST build of the one Next program that serves every
# visitor: the landing to a stranger, the mail client to a session.
#
# This image exists for exactly one composition: `deploy/selfhost/docker-compose.yml`, where a
# reverse proxy in front of this container owns the origin split (`/api/*` and friends go to the
# API container, everything else here). `OHMAIL_FLAVOR=selfhost` is therefore baked at BUILD
# time — `next.config.mjs` emits no rewrite and arms `NEXT_PUBLIC_API_BASE=/api` for the client
# bundle, and a flavor value the config does not recognise fails the build rather than silently
# producing the managed shape. The managed deployment never uses this file.
#
# The build context is the REPO ROOT (this app is a workspace importer). BuildKit reads the
# sibling `Dockerfile.dockerignore`, which admits only this app's compile closure.

# ── Base: pinned runtime + pinned package manager ───────────────────────────────────────
FROM node:22-bookworm-slim AS base
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN npm install --global pnpm@11.10.0
WORKDIR /app

# ── Build: install this app's closure, then `next build` the self-host flavor ───────────
FROM base AS build
# NODE_ENV deliberately UNSET here: pnpm installs the dev half (Next needs typescript to
# type-check), and `next build` sets production for its own compile — an explicit development
# value would make Next warn about a non-standard NODE_ENV and second-guess the bundle mode.
COPY . .
# The root importer rides along because the workspace's devDependencies live there;
# "@ohmail/webapp..." pulls the UI packages, the client engine and @trafficflow/core.
RUN pnpm install --frozen-lockfile --filter "ohmail-monorepo" --filter "@ohmail/webapp..."
# The flavor is a BUILD fact (see next.config.mjs — the proxy owns the split, so this bundle
# rewrites nothing and calls /api on its own origin). The star count is pinned so the config's
# build-time badge fetch never reaches the network from inside a build container.
ENV OHMAIL_FLAVOR=selfhost \
    NEXT_PUBLIC_GITHUB_STARS=1
RUN pnpm --filter "@ohmail/webapp" build
# Fail the BUILD, not the container, if Next emitted nothing.
RUN test -d apps/webapp/.next

# ── Runtime: `next start` over the built app ────────────────────────────────────────────
# The workspace is copied whole (node_modules included): this app has no `output: standalone`,
# so `next start` needs the real module tree, and `next.config.mjs` is re-evaluated at start —
# which is why the flavor is stated again for the runtime environment. Trimming this image is
# the packaged-image slice's work, not this one's.
FROM base AS runtime
ENV NODE_ENV=production \
    OHMAIL_FLAVOR=selfhost \
    NEXT_PUBLIC_GITHUB_STARS=1
COPY --from=build --chown=node:node /app /app
USER node
WORKDIR /app/apps/webapp
EXPOSE 3000
# The port is this file's, not package.json's: the dev `start` script binds 3001 beside a local
# API, while the compose network expects this container on 3000.
CMD ["./node_modules/.bin/next", "start", "-p", "3000"]
