import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { configDefaults, defineConfig } from "vitest/config";
import { desktopFiles } from "./test/support/ci-shards.mjs";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
/* The webapp's own next-intl where the workspace installs it per package (pnpm), the hoisted root copy
   where it does not (the published tree's npm workspaces). Either way there is one, and every importer
   gets it. */
const nextIntl = [r("./apps/webapp/node_modules/next-intl"), r("./node_modules/next-intl")].find((p) => existsSync(p))
  ?? r("./apps/webapp/node_modules/next-intl");

/* ONE DEPENDENCY TREE FOR THE WHOLE SUITE: the root's.
 *
 * `apps/desktop` is installed from its own lockfile, and the documented setup installs it beside the
 * root (`npm ci`, then `npm ci` in `apps/desktop`). Node resolves a bare specifier from the nearest
 * `node_modules`, so with that tree present every desktop source and test reached `react`, `react-dom`,
 * `@tiptap/react` and `use-intl` from `apps/desktop/node_modules`, while `@testing-library/react`,
 * `next-intl` and every shared view under `apps/webapp` and `packages/ui` reached the root's: two
 * Reacts, and every desktop test that renders failed on "Invalid hook call". CI installs the root alone
 * for the suite, so it never saw this. A `dedupe` of React alone is not enough: a package loaded from
 * the desktop tree (`@tiptap/react`, `use-intl`) is loaded by Node, which resolves its own `react`
 * beside it.
 *
 * So a bare import made by a file under `apps/desktop` (its own `node_modules` excepted) resolves as the
 * root resolves it, and falls back to the desktop tree only for a package the root does not install
 * (`@vitejs/plugin-react`, which the desktop's vite config imports). Both install shapes then load the
 * same modules. `apps/desktop/test/one-react.test.tsx` holds it. */
const slashed = (p: string) => p.replace(/\\/g, "/");
const DESKTOP_DIR = `${slashed(r("./apps/desktop"))}/`;
const ROOT_IMPORTER = r("./package.json");
const BARE = /^(?![./\\#]|[a-z]+:|\0)/i;
const oneDependencyTree: Plugin = {
  name: "ohmail:one-dependency-tree",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (!importer || !BARE.test(source)) return null;
    const from = slashed(importer);
    if (!from.startsWith(DESKTOP_DIR) || from.includes("/node_modules/")) return null;
    return (await this.resolve(source, ROOT_IMPORTER, { ...options, skipSelf: true })) ?? null;
  },
};

/* …AND WITH THE ROOT INSTALLED ALONE, the desktop tests that load the desktop's vite config are left out:
 * its `@vitejs/plugin-react` is installed only by `apps/desktop`'s lockfile, so on this install they cannot
 * even be collected. CI's shards install the root alone and never hand them over (they run in its desktop
 * job); this says so to a person who runs `npm test` on the same install, instead of failing those files
 * on a missing package. */
const desktopTreeInstalled = existsSync(r("./apps/desktop/node_modules/@vitejs/plugin-react/package.json"));
const needsDesktopTree: string[] = desktopTreeInstalled ? [] : desktopFiles(r("."), undefined, { configOnly: true });
/* Once per process: vitest loads this file more than once in one run. */
const NOTICE = Symbol.for("ohmail.vitest.desktop-tree-notice");
const said = globalThis as { [NOTICE]?: true };
if (needsDesktopTree.length > 0 && !said[NOTICE]) {
  said[NOTICE] = true;
  process.stderr.write(
    `vitest.config.ts: apps/desktop is not installed; the ${needsDesktopTree.length} tests that load its vite config ` +
      "are left out (cd apps/desktop && npm ci, then node scripts/apply-patches.mjs apply, runs them too).\n",
  );
}

export default defineConfig({
  plugins: [oneDependencyTree],
  resolve: {
    // A workspace subpath the table below does not name resolves through its package's exports,
    // where `node` (which vite matches for a test) names the compiled twin; this condition, listed
    // ahead of it in every map, keeps that subpath on the source as well.
    conditions: ["ohmail-source"],
    // Map workspace package names (and core's subpath exports) to their TS sources
    // so tests run against src without a prior `tsc` build. Order matters: the more
    // specific subpaths must precede the bare "@trafficflow/core".
    alias: [
      // The node-only http adapter (the self-host server's entry and the desktop host door's
      // loopback listener). Above the bare package name like every other subpath.
      { find: "@trafficflow/core/adapters/http-host", replacement: r("./packages/core/src/adapters/http-host.ts") },
      { find: "@trafficflow/core/adapters/imap-types", replacement: r("./packages/core/src/adapters/imap-types.ts") },
      { find: "@trafficflow/core/adapters/imap", replacement: r("./packages/core/src/adapters/imap.ts") },
      { find: "@trafficflow/core/adapters/organizer-lease", replacement: r("./packages/core/src/adapters/organizer-lease.ts") },
      // BEFORE its prefix `…/organizer-profile` — the table is scanned in order and a string
      // `find` is a prefix match, so the shorter entry would rewrite this specifier to
      // `organizer-profile.ts-store`, a path that does not exist.
      { find: "@trafficflow/core/adapters/organizer-profile-store", replacement: r("./packages/core/src/adapters/organizer-profile-store.ts") },
      { find: "@trafficflow/core/adapters/organizer-profile", replacement: r("./packages/core/src/adapters/organizer-profile.ts") },
      { find: "@trafficflow/core/adapters/drizzle-repo", replacement: r("./packages/core/src/adapters/drizzle-repo.ts") },
      // The MAIL-half entry points, above their bare package names for the same ordering reason
      // as core's adapters: the table is scanned in order, so "@trafficflow/core" would otherwise
      // swallow "@trafficflow/core/mail".
      { find: "@trafficflow/core/mail", replacement: r("./packages/core/src/mail.ts") },
      // The browser-safe ics module — the one core entry point the engine and the webapp load.
      { find: "@trafficflow/core/ics", replacement: r("./packages/core/src/ics.ts") },
      { find: "@trafficflow/core/url-escapes", replacement: r("./packages/core/src/url-escapes.ts") },
      { find: "@trafficflow/core/image-dimensions", replacement: r("./packages/core/src/image-dimensions.ts") },
      { find: "@trafficflow/core/folder-name", replacement: r("./packages/core/src/folder-name.ts") },
      // The away responder's pile vocabulary — dependency-free source, imported by the ENGINE
      // (`away-eligibility.ts`, which decides with it) and by the webapp's Ohbox banner and
      // settings row (which display with it). The banner cannot reach `away-eligibility.ts`
      // itself: `awayTextHash` there imports `node:crypto`.
      { find: "@trafficflow/core/away-scope", replacement: r("./packages/core/src/away-scope.ts") },
      // The six folders a decision may file mail into — dependency-free source, read by the
      // webapp's consent-copy guard, which cannot reach the barrel (mailparser, node:crypto) and
      // has no build ordered ahead of it. Above the bare name like the rest.
      { find: "@trafficflow/core/destinations", replacement: r("./packages/core/src/destinations.ts") },
      // The client mirrors' shared staleness policy — dependency-free source, imported by the
      // engine AND by the sidecar's mirror driver so the two cannot drift.
      { find: "@trafficflow/core/drain-policy", replacement: r("./packages/core/src/drain-policy.ts") },
      // `Re: ` exactly once — dependency-free source, imported by the browser/phone engine (which
      // cannot load this package's barrel) and reached through the `mail` barrel by the away
      // responder's pass, so the compose window and the one reply nobody reads before it leaves
      // cannot disagree about the prefix.
      { find: "@trafficflow/core/reply-subject", replacement: r("./packages/core/src/reply-subject.ts") },
      // The search ranking rule — dependency-free source, imported by the browser engine's local
      // index AND by the hosted search service, so the two doors cannot order one question two
      // ways. Above the bare name like the rest.
      { find: "@trafficflow/core/search-rank", replacement: r("./packages/core/src/search-rank.ts") },
      // The pairing link's grammar — dependency-free source, and the FIRST of these leaves the
      // SIDECAR compiles: the desktop client door parses a link printed by another machine's
      // desktop, and `apps/sidecar` may not link `@ohmail/client-engine` (its own census says so).
      { find: "@trafficflow/core/pair-link", replacement: r("./packages/core/src/pair-link.ts") },
      { find: "@trafficflow/core/mailto", replacement: r("./packages/core/src/mailto.ts") },
      { find: "@trafficflow/core/sender-headers", replacement: r("./packages/core/src/sender-headers.ts") },
      { find: "@trafficflow/core/rule-order", replacement: r("./packages/core/src/rule-order.ts") },
      { find: "@trafficflow/core/conversation-fold", replacement: r("./packages/core/src/conversation-fold.ts") },
      { find: "@trafficflow/core/reader-refusal", replacement: r("./packages/core/src/reader-refusal.ts") },
      { find: "@trafficflow/core/outbound-text", replacement: r("./packages/core/src/outbound-text.ts") },
      { find: "@trafficflow/core/model-name", replacement: r("./packages/core/src/model-name.ts") },
      { find: "@trafficflow/core/ai-transports", replacement: r("./packages/core/src/ai/transports/index.ts") },
      { find: "@trafficflow/core/transport-frame", replacement: r("./packages/core/src/transport-frame.ts") },
      { find: "@trafficflow/core/diagnostics", replacement: r("./packages/core/src/diagnostics/index.ts") },
      // The SSRF gate + its pin. Node-only (node:http), on its own subpath so nothing that lacks
      // node builtins can reach it by importing the barrel, and above the bare name like the rest.
      { find: "@trafficflow/core/net", replacement: r("./packages/core/src/net/index.ts") },
      /* The organizer INSTALL identity — four pure values with no imports at all. Its own door
         because the worker's lease module re-exports them and is itself bundled into the desktop
         engine: named at the barrel, that re-export is a runtime edge to the core package's root index,
         whose `export *` lines convey the whole AI runtime and, through the workflow runner, the
         hosted database half. */
      { find: "@trafficflow/core/organizer-install", replacement: r("./packages/core/src/organizer-install.ts") },
      { find: "@trafficflow/core", replacement: r("./packages/core/src/index.ts") },
      { find: "@trafficflow/services/mail", replacement: r("./packages/services/src/mail.ts") },
      // The session-lifecycle + pairing entry (Phase 3). Above the bare package name for the
      // standing ordering reason: the table is scanned in order and a string `find` is a prefix
      // match, so "@trafficflow/services" would otherwise swallow it.
      { find: "@trafficflow/services/auth", replacement: r("./packages/services/src/auth.ts") },
      { find: "@trafficflow/services", replacement: r("./packages/services/src/index.ts") },
      { find: "@trafficflow/api/local", replacement: r("./packages/api/src/local.ts") },
      { find: "@trafficflow/api/relay-allowlist", replacement: r("./packages/api/src/relay-allowlist.ts") },
      { find: "@trafficflow/api/match-path", replacement: r("./packages/api/src/match-path.ts") },
      // The standalone server's route table. Its own entry point for `local`'s reason: importing
      // it through the default barrel would pull the hosted table's whole module graph back in.
      { find: "@trafficflow/api/self-host", replacement: r("./packages/api/src/routes/self-host.ts") },
      // The desktop-host door's table (Phase 3) — its own entry point for the same reason.
      { find: "@trafficflow/api/desktop-host", replacement: r("./packages/api/src/routes/desktop-host.ts") },
      // The BOTH-HALVES schema census. Its own entry point because `routes/health.ts` ships in the
      // desktop engine and its entries are Cloud table names — see `routes/health-cloud.ts`.
      { find: "@trafficflow/api/health-cloud", replacement: r("./packages/api/src/routes/health-cloud.ts") },
      { find: "@trafficflow/api", replacement: r("./packages/api/src/index.ts") },
      /* Before the bare entry: a string `find` matches by PREFIX, so `@ohmail/tokens` alone
         would rewrite this subpath to `src/index.tsomarchy-rule`. */
      { find: "@ohmail/tokens/omarchy-rule", replacement: r("./packages/tokens/omarchy/rule.ts") },
      { find: "@ohmail/tokens/tokens.css", replacement: r("./packages/tokens/src/tokens.css") },
      { find: "@ohmail/tokens/faces.css", replacement: r("./packages/tokens/src/faces.css") },
      { find: "@ohmail/tokens/ohmarchy.css", replacement: r("./packages/tokens/src/ohmarchy.css") },
      { find: "@ohmail/tokens", replacement: r("./packages/tokens/src/index.ts") },
      { find: "@ohmail/fixtures", replacement: r("./packages/fixtures/src/index.ts") },
      // The durable-write door as a leaf, ABOVE the bare name for the ordering reason the core
      // subpaths above give: a string `find` is a prefix match, so the barrel entry would
      // rewrite this specifier to `…/src/index.ts/durable` and resolve nothing.
      { find: "@ohmail/client-engine/durable", replacement: r("./packages/client-engine/src/durable.ts") },
      { find: "@ohmail/client-engine/send-fingerprint", replacement: r("./packages/client-engine/src/send-fingerprint.ts") },
      { find: "@ohmail/client-engine/html-tree-budget", replacement: r("./packages/client-engine/src/html-tree-budget.ts") },
      { find: "@ohmail/client-engine", replacement: r("./packages/client-engine/src/index.ts") },
      // The body page bound as a leaf, ABOVE the bare name (the prefix-match reason above): the phone links it.
      { find: "@ohmail/ui/long-text", replacement: r("./packages/ui/src/format/long-text.ts") },
      { find: "@ohmail/ui", replacement: r("./packages/ui/src/index.ts") },
      // ONE PHYSICAL `next-intl` FOR THE WHOLE SUITE, and it is the same hazard the workspace
      // file pins `drizzle-orm`'s peers for: a React context is identified by the module object
      // that created it, so two resolutions of one library are two contexts, and a provider from
      // the first is invisible to a hook from the second. `apps/webapp` is the only workspace that
      // depends on it, so every file under `app/shell` already resolves here; the alias is what
      // lets a test OUTSIDE that app — the desktop's, over the same shared components — wrap them
      // in the provider those components' own `useTranslations` will actually read.
      //
      // ANCHORED, and this is the whole of the care it needs. Every other entry in this table is a
      // string, and a string `find` is a PREFIX match — which for this package is not a wider
      // version of the same rule, it is a different and broken one. `next-intl/server` is an
      // exports-map subpath with no file of that name on disk (`server.d.ts` is types only), so a
      // prefix rewrite points it at a directory that does not exist and every server component in
      // `apps/webapp` stops resolving. The regexp says "this specifier and no subpath of it".
      { find: /^next-intl$/, replacement: nextIntl },
      // apps/sidecar imports the worker's sync loop rather than reimplementing it (one pipeline,
      // The project's design notes). The package's `exports` map points at source for the same reason
      // the worker deploys from source, but the suite still resolves through this table like
      // every other workspace specifier.
      { find: "@trafficflow/worker/sync", replacement: r("./apps/worker/src/sync.ts") },
      { find: "@trafficflow/worker/lease", replacement: r("./apps/worker/src/lease.ts") },
      { find: "@trafficflow/worker/profile", replacement: r("./apps/worker/src/profile.ts") },
      { find: "@trafficflow/worker/entry", replacement: r("./apps/worker/src/entry.ts") },
      // …and the scheduled-resurface flip, for the same reason: the standalone desktop door has no
      // worker behind it, so its own drain runs the worker's pass rather than a second copy of it.
      { find: "@trafficflow/worker/bubble-up", replacement: r("./apps/worker/src/bubble-up-pass.ts") },
      { find: "@trafficflow/worker/rule-retro", replacement: r("./apps/worker/src/rule-retro.ts") },
      { find: "@trafficflow/worker/gap-catchup", replacement: r("./apps/worker/src/gap-catchup.ts") },
      { find: "@trafficflow/worker/known-set", replacement: r("./apps/worker/src/known-set.ts") },
      { find: "@trafficflow/worker/dead-letter", replacement: r("./apps/worker/src/dead-letter.ts") },
      { find: "@trafficflow/worker/screener-auto-act", replacement: r("./apps/worker/src/screener-auto-act.ts") },
      { find: "@trafficflow/worker/screener-correspondent-retro", replacement: r("./apps/worker/src/screener-correspondent-retro.ts") },
      { find: "@trafficflow/worker/thread-join-heal", replacement: r("./apps/worker/src/thread-join-heal.ts") },
      { find: "@trafficflow/worker/inbound-quiet", replacement: r("./apps/worker/src/inbound-quiet.ts") },
      { find: "@trafficflow/worker/sender-check-backfill", replacement: r("./apps/worker/src/sender-check-backfill.ts") },
      { find: "@trafficflow/worker/list-address-backfill", replacement: r("./apps/worker/src/list-address-backfill.ts") },
      { find: "@ohmail/sidecar", replacement: r("./apps/sidecar/src/index.ts") },
      // The shared mail-domain half. Above `@trafficflow/db` for the same reason core's
      // subpaths are above core: the table is scanned in order.
      /* THE JOURNAL'S OWN ENTRANCE, BEFORE THE BARREL'S — and the order is the whole entry. A
         string `find` is a PREFIX match scanned in order, so with the barrel first this specifier
         resolves to `…/src/index.ts/sqlite-journal` and the failure names the importing file
         rather than this table. Same trap the sqlite project's own comment records for
         `@trafficflow/db/mail`. */
      { find: "@ohmail/db-mail/sqlite-journal", replacement: r("./packages/db-mail/src/sqlite-journal.ts") },
      { find: "@ohmail/db-mail", replacement: r("./packages/db-mail/src/index.ts") },
      { find: "@trafficflow/db/testing", replacement: r("./packages/db/src/testing.ts") },
      { find: "@trafficflow/db/admin", replacement: r("./packages/db/src/admin.ts") },
      { find: "@trafficflow/db/journal", replacement: r("./packages/db/src/journal.ts") },
      { find: "@trafficflow/db/cloud", replacement: r("./packages/db/src/cloud.ts") },
      /* The ledger-source VOCABULARY on its own — pure string construction over `node:crypto`, no
         table, no connection. It has its own door because the mail half calls these names from
         inside the desktop engine, and reaching them through `/cloud` (or through the root barrel,
         which is the connection half) is a runtime import edge that drags billing, the credit
         ledger, the hosted schema and the postgres server driver into the engine bundle. */
      { find: "@trafficflow/db/ledger-source", replacement: r("./packages/db/src/ledger-source.ts") },
      // The mail half ALONE — 41 tables, no identity ceremony, no ledger. The desktop engine
      // imports this rather than the barrel, so that its bundle carries no `password_hash`,
      // `token_hash` or `credit_ledger` column definition; see `packages/db/test/schema-split.test.ts`.
      // The dialect seam and the second schema twin. ABOVE `@trafficflow/db/mail`, whose
      // string `find` is a prefix match and would otherwise swallow `…/mail-sqlite`.
      { find: "@trafficflow/db/dialect", replacement: r("./packages/db/src/dialect/index.ts") },
      { find: "@trafficflow/db/mail-sqlite", replacement: r("./packages/db/src/schema-mail-sqlite.ts") },
      // The device migrator, on its own subpath so the phone's composition root can reach it
      // without importing the whole barrel. ABOVE `@trafficflow/db` for the reason the two entries
      // above state: a string `find` is a PREFIX match and the table is scanned in order.
      { find: "@trafficflow/db/sqlite-migrate", replacement: r("./packages/db/src/sqlite-migrate.ts") },
      { find: "@trafficflow/db/mail", replacement: r("./packages/db/src/schema-mail.ts") },
      { find: "@trafficflow/db", replacement: r("./packages/db/src/index.ts") },
    ],
  },
  // JSX, FOR TESTS ONLY.
  //
  // Per-file, esbuild takes its JSX setting from the nearest tsconfig, and the console's app sets
  // `jsx: "preserve"` because Next owns that transform in the real build. The consequence is that a
  // test importing an admin `.tsx` component renders nothing and dies on `React is not defined` —
  // which is why the console had no rendering test at all, and why a field the API sent could be
  // dropped by every view with a green suite.
  //
  // Setting it here fixes that WITHOUT touching how the app builds: Next reads its own tsconfig and
  // never this file, and `tsc -b` is likewise unaffected. "automatic" is what `packages/ui`'s
  // tsconfig already selects (`jsx: "react-jsx"`), so this makes one rule of the whole suite
  // instead of two, and needs no `import React` in files that never referenced it.
  esbuild: { jsx: "automatic" },
  test: {
    // The root `test/` entry is for checks that belong to the repository rather
    // than to any one workspace (e.g. "the lockfile and the committed source
    // describe the same workspace") — filing those under an arbitrary package
    // is how they end up unowned and unread.
    include: ["packages/*/test/**/*.test.{ts,tsx}", "apps/*/test/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    exclude: [...configDefaults.exclude, ...needsDesktopTree],
    environment: "node",
    // THE DEFAULT RUN SAYS WHICH STORE IT IS, so that "no expectation" is never a state a run can
    // be in. The dialect guard used to return early when this was absent, which meant one deleted
    // block in the second project's config both turned that run back into a copy of this one AND
    // silenced the check written to notice. With both runs declaring an expectation, an absent one
    // is a failure rather than a skip, and the pairing is checked from the run that always happens.
    env: { OHMAIL_EXPECT_DIALECT: "pg" },
    // The "Testing bar" invariant ("the suite performs zero external requests") is enforced here, for every
    // file, rather than asserted by the two files that happened to think of it. Loopback
    // stays open because the *.pg.test.ts files use a local docker Postgres and the
    // worker health test fetches its own listener. See the file for what it hooks.
    // The second entry stops an editor mounted anywhere in the shell from throwing an uncaught
    // exception out of a passing test — see the file, which explains why per-suite was not
    // enough and how the gap was measured.
    // The third applies this checkout's own GreenMail (`scripts/lane-greenmail.sh`) to the
    // environment before any test module reads it; without `.lane-greenmail.env` it does nothing.
    setupFiles: [
      "./test/setup/no-external-network.ts",
      "./test/setup/prosemirror-geometry.ts",
      "./test/setup/lane-greenmail.ts",
    ],
    // ONE `initdb`, BEFORE ANY TEST FILE. The sidecar suite stands the real engine up in the test
    // body, and PGlite's `initdb` inside WASM measured 9.7 s of every 10 s standup — 625 s for one
    // file of 61 tests. `apps/sidecar/test/_datadir.ts` builds one initialised, migrated PGDATA and
    // copies it (82 ms + 19 ms); this warms that build here, because built lazily it lands inside
    // whichever test asks first, against the 5 s default, and fails a correct test on the clock.
    // It never throws: a run that selects no sidecar file pays one `existsSync`, and a warm-up that
    // could not run leaves the fixture's own lazy path as the guarantee. See the file.
    globalSetup: ["./test/setup/pgdata-template.global.ts"],
    // The worker's single-active guarantee uses ONE global pg advisory-lock key; the leader-lock,
    // main-loop, and cron tests would contend across parallel files against the shared Postgres.
    // Run files serially (each still isolated in its own worker) so the lock semantics hold.
    fileParallelism: false,
  },
});
