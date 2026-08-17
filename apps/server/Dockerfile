# syntax=docker/dockerfile:1
#
# ohmail self-host server — the standalone multi-user API host.
#
# BUILT FROM THIS REPOSITORY'S OWN TREE AND TOOLCHAIN. The manifests here are generated for
# npm and the committed package-lock.json pins the whole dependency resolution, so the build
# is two deterministic steps: `npm ci` (which refuses to improvise), then a single-file
# esbuild bundle — the same pinned bundler, resolution rules and layout the desktop mail
# engine is built with from this same source (`scripts/bundle-host.mjs` and
# `scripts/engine-bundle.mjs` state the reasoning and the pin).
#
# The RUNTIME stage carries the bundle and the two migration journals it reads off disk —
# never src/, never test/, and no node_modules at all (the bundle has no imports left to
# resolve). The release pipeline's image-prune check proves those absences with
# `docker run … find` rather than trusting this comment.
#
# The build context is the REPO ROOT (this app imports its sibling workspace packages).
# BuildKit reads the sibling `Dockerfile.dockerignore`, which admits only this app's compile
# closure — an import reaching outside it fails the BUNDLE, at build time, which is the same
# boundary a filtered install used to enforce.

# ── Base: pinned runtime ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS base
ENV CI=true
WORKDIR /app

# ── Build: the locked tree, then one file ────────────────────────────────────────────────
FROM base AS build
COPY . .
# The committed lockfile IS the resolution: the tree this bundle is built from is the tree
# this repository's own CI typechecks.
RUN npm ci --no-audit --no-fund
# The bundler, pinned and off to one side — never a project dependency. Same arrangement as
# the engine build; scripts/engine-bundle.mjs refuses any other esbuild version.
RUN mkdir -p /tmp/esbuild && cd /tmp/esbuild && npm install --no-save esbuild@0.24.0
RUN OHMAIL_ESBUILD_FROM=/tmp/esbuild node scripts/bundle-host.mjs server
# Fail the BUILD, not the container, if the bundle or a journal did not get laid out.
RUN test -f build/host-server/bin/ohmail-server.mjs \
 && test -d build/host-server/drizzle \
 && test -d build/host-server/drizzle-cloud

# ── Runtime: the bundle, its journals, and nothing else ─────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
# Heap ceiling below the container cap so the JS engine aborts loggably instead of the
# kernel SIGKILLing the process — an OOM kill leaves a log that says nothing.
ENV NODE_OPTIONS="--max-old-space-size=512"
COPY --from=build --chown=node:node /app/build/host-server /app
USER node
EXPOSE 8080
# The bundled entry: the process that runs is the one file the build above produced.
CMD ["node", "/app/bin/ohmail-server.mjs"]
