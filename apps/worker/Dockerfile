# syntax=docker/dockerfile:1
#
# ohmail sync worker — the always-on process.
#
# WHY A DOCKERFILE AND NOT AN AUTO-DETECTED BUILDER
# -------------------------------------------------
# 1. The worker's runtime dependency set is a load-bearing invariant, not a detail:
#    core + db + drizzle-orm + imapflow + postgres and nothing else (enforced by
#    `test/deps.test.ts`). A `pnpm install --filter "@trafficflow/worker..."`
#    installs exactly that closure, so an accidental `@trafficflow/services` import fails
#    HERE, at build time, instead of resolving through the vitest alias in tests and dying
#    in production. An auto-detected builder installs the whole workspace — Next, React
#    Native, Expo, Playwright — and would silently satisfy the very import the rule forbids.
# 2. The worker boots from `dist/`, and `dist/` is gitignored. The image therefore has to
#    COMPILE before it can start. Here that is one explicit `tsc -b` line whose failure is a
#    failed build; an inferred build step is a thing you hope ran.
# 3. Node version, pnpm version and the start command are pinned in the file that is
#    reviewed alongside the code, rather than in dashboard state nobody diffs.
#
# The build context is the REPO ROOT (the worker is a workspace importer). See /.dockerignore.

# ── Base: pinned runtime + pinned package manager ───────────────────────────────────────
FROM node:22-bookworm-slim AS base
# CI=true: pnpm 11 otherwise tries to re-verify/recreate node_modules interactively.
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN npm install --global pnpm@11.10.0
WORKDIR /app

# ── Build: install the worker's closure, compile it, then drop the dev half ─────────────
FROM base AS build
# NOT production here — `typescript` is a root devDependency and pnpm honours NODE_ENV.
ENV NODE_ENV=development
COPY . .
# The root importer is selected alongside the worker's closure because `tsc` lives in the
# root devDependencies; `"@trafficflow/worker..."` pulls in packages/core and packages/db.
RUN pnpm install --frozen-lockfile --filter "ohmail-monorepo" --filter "@trafficflow/worker..."
# `tsc -b` follows the project references, so this emits packages/core/dist,
# packages/db/dist and apps/worker/dist in one pass. Nothing stale can survive: /.dockerignore
# keeps every dist/ and *.tsbuildinfo out of the context.
RUN pnpm --filter "@trafficflow/worker" build
# Sanity gate: fail the BUILD, not the container, if the entry point did not get emitted.
RUN test -f apps/worker/dist/index.js
# Re-resolve without the dev half. typescript/vitest/tsx and @trafficflow/services (a
# deliberate test-only devDependency) leave the image; the compiled dist/ stays.
RUN pnpm install --frozen-lockfile --prod --filter "@trafficflow/worker..."

# ── Runtime ─────────────────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
# The deployment platform caps the container at ~1 GB. A JS heap ceiling below it means the
# JS engine aborts with a heap trace on stderr instead of the kernel SIGKILLing the process, and a
# SIGKILL is unloggable — in one early outage that is why the whole deployment log read "Starting
# Container" and nothing else.
#
# BE HONEST ABOUT WHAT THIS DOES NOT DO: RFC822 bodies are Buffers, which live in the engine's
# EXTERNAL memory, not the JS heap — this flag does not bound them and would not have
# prevented that outage. The actual memory bound is the per-cycle batch budget in
# `packages/core/src/adapters/imap-types.ts`. This is a visibility aid and headroom, only.
ENV NODE_OPTIONS="--max-old-space-size=512"
COPY --from=build --chown=node:node /app /app
USER node
# The health server binds PORT (the platform injects it; the service also sets it explicitly).
EXPOSE 8080
# `node dist/index.js`, never `tsx src/index.ts`: the deployed process must be the compiled
# one. `isCliEntry()` compares import.meta.url against pathToFileURL(argv[1]), so an absolute
# path here is required and correct.
CMD ["node", "/app/apps/worker/dist/index.js"]
