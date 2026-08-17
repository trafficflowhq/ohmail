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
# BUILT FROM THIS REPOSITORY'S OWN TREE AND TOOLCHAIN: the manifests here are generated for
# npm workspaces and the committed package-lock.json pins the resolution, so `npm ci` is the
# whole install story. The workspace packages this app imports (`@ohmail/ui`,
# `@ohmail/client-engine`, …) are TypeScript sources resolved through npm's workspace links;
# `next.config.mjs` names them in `transpilePackages`, so `next build` compiles them exactly
# as the managed deployment does.
#
# The build context is the REPO ROOT (this app is a workspace importer). BuildKit reads the
# sibling `Dockerfile.dockerignore`, which admits only this app's compile closure.

# ── Base: pinned runtime ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS base
ENV CI=true
WORKDIR /app

# ── Build: the locked tree, then `next build` the self-host flavor ───────────────────────
FROM base AS build
COPY . .
RUN npm ci --no-audit --no-fund
# Next type-checks the app as it builds. typescript and the @types the app compiles against
# are build-stage tools, installed --no-save so they can never join the published manifests —
# the same arrangement the repository's own CI uses for the engine typecheck. The React
# types are pinned to the major the manifests resolve (react 18).
RUN npm install --no-save \
      typescript@5.6 \
      @types/node@^22.10.0 \
      @types/react@^18.3.12 \
      @types/react-dom@^18.3.1
# The flavor is a BUILD fact (see next.config.mjs — the proxy owns the split, so this bundle
# rewrites nothing and calls /api on its own origin). The star count is pinned so the config's
# build-time badge fetch never reaches the network from inside a build container.
ENV OHMAIL_FLAVOR=selfhost \
    NEXT_PUBLIC_GITHUB_STARS=1
RUN cd apps/webapp && ../../node_modules/.bin/next build
# Fail the BUILD, not the container, if Next emitted nothing.
RUN test -d apps/webapp/.next

# ── Runtime: `next start` over the built app ────────────────────────────────────────────
# The workspace is copied whole (node_modules included): this app has no `output: standalone`,
# so `next start` needs the real module tree, and `next.config.mjs` is re-evaluated at start —
# which is why the flavor is stated again for the runtime environment. Trimming this image is
# deliberate follow-up work, not this file's.
FROM base AS runtime
ENV NODE_ENV=production \
    OHMAIL_FLAVOR=selfhost \
    NEXT_PUBLIC_GITHUB_STARS=1
COPY --from=build --chown=node:node /app /app
USER node
WORKDIR /app/apps/webapp
EXPOSE 3000
# The port is this file's own choice: the compose network expects this container on 3000.
# npm workspaces put every bin at the ROOT node_modules, hence the relative path up.
CMD ["../../node_modules/.bin/next", "start", "-p", "3000"]
