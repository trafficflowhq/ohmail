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

# WHICH ALLOW-LIST BUILT THIS CONTEXT. The lockfile above reaches it through the sibling
# `apps/server/Dockerfile.dockerignore`, and only BuildKit reads a per-Dockerfile list. The legacy
# builder falls back to the root one — the managed worker's context, which admits no lockfile — so
# npm answers EUSAGE over a lockfile this repository does commit, and the reader goes looking for a
# missing file instead of a missing builder. The builder is named here, before npm is asked.
RUN test -f package-lock.json || { \
      echo "REFUSED: package-lock.json is not in this build context."; \
      echo "  It IS committed at the repository root. This image's context list is the sibling"; \
      echo "  apps/server/Dockerfile.dockerignore, which only BuildKit reads."; \
      echo "  The legacy builder cannot build this image: install the buildx component"; \
      echo "  (https://docs.docker.com/go/buildx/) and build again."; \
      exit 1; }
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
# glibc gives a thread that first allocates under contention its own 64 MB arena and returns
# those bytes only from the top of one, so a burst leaves them resident for the life of the
# process — measured on the desktop engine as one +92.9 MB step in rss with the JS heap FALLING
# across it. The variable is read at process start, so this is the only place it can be set for
# an image. The value is the ENGINE's, measured; these processes talk to a real Postgres rather
# than a WASM one and their own throughput under it is owed.
ENV MALLOC_ARENA_MAX=2
# WHICH COMMIT THIS IMAGE WAS BUILT FROM. `config.ts` reads `TF_BUILD_VERSION` for `/health`'s
# `version`; with nothing set it answers `dev`, which is what every released image answered — so
# an operator could not tell two builds of one release apart and the registry digest was the only
# thing that identified one. The release workflow passes the tagged commit as the build argument.
# Baked HERE, in the runtime stage, so the value names the tree this image was built from; a local
# `docker build` with no arg keeps `dev`, which is the true answer for a build off a working tree.
ARG TF_BUILD_VERSION=""
ENV TF_BUILD_VERSION=${TF_BUILD_VERSION}
COPY --from=build --chown=node:node /app/build/host-server /app
USER node
EXPOSE 8080
# The bundled entry: the process that runs is the one file the build above produced.
CMD ["node", "/app/bin/ohmail-server.mjs"]
