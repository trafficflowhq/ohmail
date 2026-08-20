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
# are build-stage tools, installed --no-save so they can never join the published manifests.
# EXACT versions, not ranges: the committed lockfile cannot pin what the manifests do not
# declare, so a caret here would let two otherwise-identical builds of one release resolve
# different declaration files — the image must be reproducible from the tree alone. The React
# types match the major the manifests resolve (react 18), and all four are REMOVED again
# after the build (below), so the runtime copy ships nothing the type pass pulled in.
RUN npm install --no-save \
      typescript@5.6.3 \
      @types/node@22.10.2 \
      @types/react@18.3.12 \
      @types/react-dom@18.3.1
# THE LOCKFILE HOISTS `styled-jsx` — next's own dependency — TO THE ROOT while nesting next,
# react and react-dom under this app, and the root also carries a DIFFERENT React major for an
# unrelated workspace. styled-jsx resolves `react` by walking UP from where it physically sits,
# so at the root it binds that foreign React, while react-dom arms the hook dispatcher on the
# React instance it resolved beside this app — and every pages-router prerender (`/_error`,
# /404, /500; the app-router pages use Next's vendored React and never notice) dies with
# "Cannot read properties of null (reading 'useContext')". Relocate styled-jsx beside the
# react it must share an instance with. This step MUST stay below the stage's last npm
# operation: any `npm install` reconciles the whole tree against the lockfile and puts
# styled-jsx back at the root (measured — the install above undid an earlier placement of
# this line). The guard makes it a no-op the day the lockfile nests styled-jsx correctly
# itself; a tree carrying NEITHER copy fails right here, at build time.
RUN [ -d apps/webapp/node_modules/styled-jsx ] \
 || mv node_modules/styled-jsx apps/webapp/node_modules/styled-jsx
# The flavor is a BUILD fact (see next.config.mjs — the proxy owns the split, so this bundle
# rewrites nothing and calls /api on its own origin). The star count is pinned so the config's
# build-time badge fetch never reaches the network from inside a build container.
ENV OHMAIL_FLAVOR=selfhost \
    NEXT_PUBLIC_GITHUB_STARS=1
# WHERE `next` PHYSICALLY LANDS IS THE LOCKFILE'S DECISION, NOT THIS FILE'S. npm hoists a
# workspace dependency to the root node_modules only while nothing forces it deeper; a lockfile
# regeneration moved it to apps/webapp/node_modules and broke a hardcoded ../../node_modules/
# .bin/next here. `npx --offline` asks npm's own resolver instead of assuming a layout, and
# `--offline` keeps the failure honest: a genuinely absent binary is a hard error, never a
# registry fetch of whatever `next` currently is — the image builds from the tree alone.
RUN cd apps/webapp && npx --offline next build
# Fail the BUILD, not the container, if Next emitted nothing.
RUN test -d apps/webapp/.next
# The type pass's tools leave before the runtime stage copies the workspace: `next start`
# executes JavaScript only, and declaration files are dead weight in a serving container.
RUN rm -rf node_modules/typescript node_modules/@types node_modules/.bin/tsc node_modules/.bin/tsserver

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
# Same resolution story as the build stage: the lockfile decides where `next` sits, so ask
# npm (`npx --offline`) rather than hardcode a hoisted path. npx forwards SIGTERM to the
# server it spawns, so `docker stop` still shuts Next down instead of waiting out the kill.
CMD ["npx", "--offline", "next", "start", "-p", "3000"]
