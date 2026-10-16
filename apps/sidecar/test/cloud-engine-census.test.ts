import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE STRUCTURAL CENSUS — Cloud mode cannot reach the organizer.
 *
 * This is the load-bearing safety of the whole CloudMirror feature: the hosted worker is the single
 * organizer of a mailbox, and a Cloud-mode desktop install must never become a second one. That is
 * made UN-SHIPPABLE here rather than trusted to discipline — this walks the STATIC import graph of
 * `cloud-engine.ts` and fails the moment it reaches any of the three modules an organizer is built
 * from:
 *
 *   · the IMAP adapter        `@trafficflow/core/adapters/imap`  (opens the user's mailbox)
 *   · the organizer lease     `@trafficflow/worker/lease`        (claims the mailbox)
 *   · the shared sync loop     `@trafficflow/worker/sync`         (files mail)
 *
 * The census is transitive: it resolves every workspace and relative import to its SOURCE and
 * recurses, so a forbidden module reached three packages deep fails exactly as a direct import
 * does. An unresolved workspace specifier fails LOUD (`unresolvedWorkspace`), because a silently
 * skipped edge is a silently incomplete graph — the one way a census like this goes falsely green.
 *
 * ── THE GRAPH IT WALKS GREW WITH THE READ SURFACE AND THE PROXY ────────────────────────────────
 *
 * An earlier change gave the Cloud engine the full mail READ surface (`cloud-read.ts`) and a write-through proxy
 * (`cloud-proxy.ts`). Both are now in `cloud-engine.ts`'s graph, and the census walks them: a test
 * below asserts each was actually visited, so this cannot pass by failing to reach them. The read
 * surface calls read services out of the same `@trafficflow/services/mail` graph the engine already
 * imported, which is why it adds no NEW module an organizer is built from — and this proves it.
 *
 * ── AND IT GREW AGAIN WITH THE PRE-AUTH SIGN-IN ────────────────────────────────────────────────
 *
 * `cloud-signin.ts` is the newest door into this engine, and it is the one most likely to acquire
 * the wrong dependency: signing in is where a "and while we are here, verify the mailbox" or a "let
 * us check the lease first" edit looks reasonable. Either would put an organizer module in the
 * graph of a surface reachable by an install with NO session at all. It is asserted visited below
 * for the same reason the read surface is — a census that silently stopped walking it would go
 * green about a module it no longer covers.
 *
 * ── HOW TO WATCH IT FAIL (the mutation that proves it is not vacuous) ──────────────────────────
 *
 * Add `import { ImapAdapter } from "@trafficflow/core/adapters/imap";` to `cloud-engine.ts` — OR to
 * `cloud-read.ts`, `cloud-proxy.ts` or `cloud-signin.ts` — and this goes RED on `forbiddenHits`;
 * restore it and it goes green. Same for either worker module. Each surface added since widened the
 * graph without widening what it may reach, which is the whole claim.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const r = (p: string): string => resolve(REPO, p);

const CLOUD_ENGINE = resolve(HERE, "../src/cloud-engine.ts");

/** The three modules an organizer is built from. Their exact `/sync`-visible specifiers. */
const FORBIDDEN_SPECIFIERS = [
  "@trafficflow/core/adapters/imap",
  "@trafficflow/worker/lease",
  "@trafficflow/worker/sync",
];
const FORBIDDEN_FILES = new Set([
  r("packages/core/src/adapters/imap.ts"),
  r("apps/worker/src/lease.ts"),
  r("apps/worker/src/sync.ts"),
]);

/**
 * Workspace specifier → source entry, mirroring `vitest.config.ts`'s alias table so the census
 * resolves exactly what the suite does. A specifier under `@trafficflow/*` or `@ohmail/*` that is
 * not here is an unresolved edge and fails the run — extend this map, do not paper over it.
 */
const ALIASES: Record<string, string> = {
  "@trafficflow/core/adapters/imap": r("packages/core/src/adapters/imap.ts"),
  // The IMAP wire types, split out of the adapter so type-only importers (the junk window's
  // search shapes among them) stop pulling imapflow into graphs that never dial. A new subpath
  // export is a new workspace edge, and an unresolved edge means this census's graph was
  // incomplete — the suite sat red from the slice that added it until this entry.
  "@trafficflow/core/adapters/imap-types": r("packages/core/src/adapters/imap-types.ts"),
  "@trafficflow/core/adapters/organizer-lease": r("packages/core/src/adapters/organizer-lease.ts"),
  // The organizer profile's document and store halves — imported by apps/worker/src/profile.ts,
  // which the census reaches through the worker's sync surface.
  "@trafficflow/core/adapters/organizer-profile": r("packages/core/src/adapters/organizer-profile.ts"),
  "@trafficflow/core/adapters/organizer-profile-store": r("packages/core/src/adapters/organizer-profile-store.ts"),
  "@trafficflow/core/adapters/drizzle-repo": r("packages/core/src/adapters/drizzle-repo.ts"),
  "@trafficflow/core/mail": r("packages/core/src/mail.ts"),
  // The search ranking rule, dependency-free, imported by the client engine's in-memory search and
  // by the services' SQL search so both order one answer the same way. Added with the search
  // ranking work; the census sat red from that slice until this entry.
  "@trafficflow/core/search-rank": r("packages/core/src/search-rank.ts"),
  // The SSRF gate and its pin, reached from `packages/services/src/{ssrf-guard,pinned-fetch}.ts`
  // (which are now adapters over it) and from the worker's wake sender. It is node-only
  // (`node:http`), which is why it is a subpath and not part of the barrel — and why it has to be
  // listed here rather than falling through: an unresolved workspace edge means the graph this
  // census walked was incomplete, and an incomplete graph cannot prove the organizer is
  // unreachable.
  "@trafficflow/core/net": r("packages/core/src/net/index.ts"),
  // The client mirrors' shared drain policy (INSTANT-ARCH §6.7): the staleness threshold, the
  // dense-page limit and the three freshness states, held once so `cloud-mirror.ts` and the client
  // engine cannot drift. Reached from `cloud-mirror.ts`, which `cloud-engine.ts` imports, so the
  // graph walks it — and it must be listed for the reason `net` states above: an unresolved edge
  // is an incomplete graph, and an incomplete graph cannot prove the organizer is unreachable.
  // The leaf itself imports NOTHING, so it adds exactly one node and no reachability at all.
  "@trafficflow/core/drain-policy": r("packages/core/src/drain-policy.ts"),
  /* The pairing link's grammar — dependency-free source, reached from the probe's paired-desktop
     arm, which applies `originNeedsPin` rather than writing a second IP test so the desktop and
     the phone cannot disagree about which addresses are safe to pair with unpinned. */
  "@trafficflow/core/pair-link": r("packages/core/src/pair-link.ts"),
  "@trafficflow/core/mailto": r("packages/core/src/mailto.ts"),
  /* The transport's byte cap and the outbound text ceiling it is spent against — both reached
     through `packages/services/src/sync-page-byte-budget.ts`, which the snapshot builder imports
     to bound a page by the bytes the frame codec refuses on rather than by rows alone. Listed for
     `net`'s reason above: an unresolved edge is an incomplete graph, and an incomplete graph
     cannot prove the organizer is unreachable. Both leaves are constants, so each adds one node
     and no reachability whatever. */
  "@trafficflow/core/transport-frame": r("packages/core/src/transport-frame.ts"),
  "@trafficflow/core/outbound-text": r("packages/core/src/outbound-text.ts"),
  /* The order over rules, reached through the client engine's press read-back and consent
     index. Import-free, so it adds one node and no reachability. */
  "@trafficflow/core/rule-order": r("packages/core/src/rule-order.ts"),
  "@trafficflow/core/conversation-fold": r("packages/core/src/conversation-fold.ts"),
  /* Why a reader's press has nowhere to go, reached through the services' refusal doors. Import-
     free, so it adds one node and no reachability. */
  "@trafficflow/core/reader-refusal": r("packages/core/src/reader-refusal.ts"),
  /* The rest of the export map, so a leaf the graph starts to reach is never an unresolved edge:
     test/core-leaf-registration.test.ts asks this table for every exported leaf. Unreached today,
     each adds nothing to the walk. */
  "@trafficflow/core/adapters/http-host": r("packages/core/src/adapters/http-host.ts"),
  "@trafficflow/core/organizer-install": r("packages/core/src/organizer-install.ts"),
  "@trafficflow/core/ics": r("packages/core/src/ics.ts"),
  "@trafficflow/core/url-escapes": r("packages/core/src/url-escapes.ts"),
  "@trafficflow/core/image-dimensions": r("packages/core/src/image-dimensions.ts"),
  "@trafficflow/core/folder-name": r("packages/core/src/folder-name.ts"),
  "@trafficflow/core/away-scope": r("packages/core/src/away-scope.ts"),
  "@trafficflow/core/destinations": r("packages/core/src/destinations.ts"),
  "@trafficflow/core/reply-subject": r("packages/core/src/reply-subject.ts"),
  "@trafficflow/core/sender-headers": r("packages/core/src/sender-headers.ts"),
  "@trafficflow/core/model-name": r("packages/core/src/model-name.ts"),
  "@trafficflow/core/ai-transports": r("packages/core/src/ai/transports/index.ts"),
  "@trafficflow/core/ai-provider-env": r("packages/core/src/ai/transports/host.ts"),
  "@trafficflow/core/diagnostics": r("packages/core/src/diagnostics/index.ts"),
  "@trafficflow/core": r("packages/core/src/index.ts"),
  "@trafficflow/services/mail": r("packages/services/src/mail.ts"),
  "@trafficflow/services": r("packages/services/src/index.ts"),
  "@trafficflow/api/local": r("packages/api/src/local.ts"),
  // The relay allowlist and the resolver it uses. Import-free at runtime, which is the
  // condition for the sidecar reading them at all.
  "@trafficflow/api/relay-allowlist": r("packages/api/src/relay-allowlist.ts"),
  "@trafficflow/api/match-path": r("packages/api/src/match-path.ts"),
  "@trafficflow/api/health-cloud": r("packages/api/src/routes/health-cloud.ts"),
  "@trafficflow/api": r("packages/api/src/index.ts"),
  "@trafficflow/worker/sync": r("apps/worker/src/sync.ts"),
  "@trafficflow/worker/lease": r("apps/worker/src/lease.ts"),
  "@trafficflow/worker/entry": r("apps/worker/src/entry.ts"),
  "@ohmail/sidecar": r("apps/sidecar/src/index.ts"),
  "@ohmail/db-mail": r("packages/db-mail/src/index.ts"),
  "@ohmail/client-engine": r("packages/client-engine/src/index.ts"),
  "@ohmail/fixtures": r("packages/fixtures/src/index.ts"),
  "@ohmail/tokens": r("packages/tokens/src/index.ts"),
  "@ohmail/ui": r("packages/ui/src/index.ts"),
  "@trafficflow/db/testing": r("packages/db/src/testing.ts"),
  "@trafficflow/db/admin": r("packages/db/src/admin.ts"),
  "@trafficflow/db/journal": r("packages/db/src/journal.ts"),
  "@trafficflow/db/cloud": r("packages/db/src/cloud.ts"),
  /* The dialect seam, reached from `engine.ts` — which names the store this install actually
     opened, so `/health` can say `sqlite` or `pglite` instead of null. A new workspace edge is an
     unresolved edge until it is listed here, and this census failed naming it, which is the
     table working as designed rather than an obstacle. */
  "@trafficflow/db/dialect": r("packages/db/src/dialect/index.ts"),
  /* The device migrator, on its own subpath so the phone's composition root reaches it without
     the barrel. Listed for the same reason, ahead of the edge reaching this census. */
  "@trafficflow/db/sqlite-migrate": r("packages/db/src/sqlite-migrate.ts"),
  "@trafficflow/db/mail-sqlite": r("packages/db/src/schema-mail-sqlite.ts"),
  /* The ledger-source VOCABULARY — string construction over `node:crypto`, with no table and no
     connection, which is why the engine may reach this door while `/cloud` and the root barrel
     stay forbidden to it. Listed on `drain-policy`'s reasoning above: an unresolved edge is an
     incomplete graph, and an incomplete graph cannot prove the organizer is unreachable.
     Unlike the `find` table in `vitest.config.ts`, this map is matched by EXACT key
     (`spec in ALIASES`), so position here is readability alone and none of that file's
     subpath-before-bare ordering rule applies. */
  "@trafficflow/db/ledger-source": r("packages/db/src/ledger-source.ts"),
  "@trafficflow/db/mail": r("packages/db/src/schema-mail.ts"),
  "@trafficflow/db": r("packages/db/src/index.ts"),
};

/** Every module specifier a file statically imports or re-exports from, comments stripped first. */
function specifiersOf(source: string): string[] {
  const src = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")       // block comments (the JSDoc that NAMES the forbidden modules)
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");   // line comments, but not the `//` in a `://`
  const out = new Set<string>();
  const push = (re: RegExp): void => {
    for (let m = re.exec(src); m !== null; m = re.exec(src)) out.add(m[1]!);
  };
  push(/\bfrom\s*["']([^"']+)["']/g);        // import/export … from "X"
  push(/\bimport\s*\(\s*["']([^"']+)["']/g); // dynamic import("X")
  push(/\bimport\s+["']([^"']+)["']/g);      // side-effect import "X"
  return [...out];
}

/** Resolve a specifier to an absolute source file, `"external"` (npm/node) or `null` (workspace miss). */
function resolveSpec(spec: string, fromFile: string, unresolvedWorkspace: Set<string>): string | "external" | null {
  if (spec.startsWith(".")) {
    const base = dirname(fromFile);
    const candidates = spec.endsWith(".js")
      ? [join(base, spec.replace(/\.js$/, ".ts")), join(base, spec.replace(/\.js$/, ".tsx"))]
      : [join(base, `${spec}.ts`), join(base, `${spec}.tsx`), join(base, spec, "index.ts")];
    return candidates.find((c) => existsSync(c)) ?? null;
  }
  if (spec in ALIASES) return ALIASES[spec]!;
  if (spec.startsWith("@trafficflow/") || spec.startsWith("@ohmail/")) {
    unresolvedWorkspace.add(spec);
    return null;
  }
  return "external"; // npm (drizzle-orm, @electric-sql/pglite, …) or node: builtins
}

interface Crawl {
  visited: Set<string>;
  forbiddenHits: Array<{ from: string; spec: string }>;
  unresolvedWorkspace: Set<string>;
}

function crawl(entry: string): Crawl {
  const visited = new Set<string>();
  const forbiddenHits: Array<{ from: string; spec: string }> = [];
  const unresolvedWorkspace = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const spec of specifiersOf(source)) {
      if (FORBIDDEN_SPECIFIERS.includes(spec)) forbiddenHits.push({ from: file, spec });
      const target = resolveSpec(spec, file, unresolvedWorkspace);
      if (target && target !== "external" && !visited.has(target)) stack.push(target);
    }
  }
  return { visited, forbiddenHits, unresolvedWorkspace };
}

describe("cloud-engine.ts cannot reach the organizer — the structural safety of Cloud mode", () => {
  const result = crawl(CLOUD_ENGINE);

  it("resolves every workspace edge, so the graph it walked is complete", () => {
    // A silently skipped edge is a silently incomplete graph — the one way this goes falsely green.
    expect([...result.unresolvedWorkspace].sort(), "extend ALIASES for these").toEqual([]);
  });

  it("actually traversed the graph — not a vacuous green", () => {
    // The crawl reached the sidecar-local modules AND the shared service barrel, so a broken
    // extractor that found nothing would fail here rather than pass everything.
    expect(result.visited.has(resolve(HERE, "../src/cloud-mirror.ts"))).toBe(true);
    expect(result.visited.has(resolve(HERE, "../src/cloud-auth.ts"))).toBe(true);
    expect(result.visited.has(resolve(HERE, "../src/db.ts"))).toBe(true);
    // The expanded graph: the read surface and the write-through proxy are reached from the engine.
    // If a refactor detached either, this fails rather than letting the census pass for a graph it
    // no longer covers.
    expect(result.visited.has(resolve(HERE, "../src/cloud-read.ts")), "the read surface is not in the Cloud-engine graph").toBe(true);
    expect(result.visited.has(resolve(HERE, "../src/cloud-proxy.ts")), "the write-through proxy is not in the Cloud-engine graph").toBe(true);
    // The pre-auth sign-in. Reachable by an install that holds NO hosted session, which is exactly
    // why it has to be inside the graph this census walks rather than beside it.
    expect(result.visited.has(resolve(HERE, "../src/cloud-signin.ts")), "the sign-in surface is not in the Cloud-engine graph").toBe(true);
    expect(result.visited.has(ALIASES["@trafficflow/services/mail"]!)).toBe(true);
    expect(result.visited.size).toBeGreaterThan(20);
  });

  it("reaches NEITHER the IMAP adapter, NOR the worker lease, NOR the worker sync loop", () => {
    expect(
      result.forbiddenHits,
      "cloud-engine's graph imported an organizer module — Cloud mode could open IMAP / take the lease / run the loop",
    ).toEqual([]);
    const reachedForbidden = [...result.visited].filter((f) => FORBIDDEN_FILES.has(f));
    expect(reachedForbidden, "an organizer source file is in the Cloud-engine graph").toEqual([]);
  });

  it("does not reach the local organizer engine either — the module that legitimately holds all three", () => {
    // `engine.ts` is where the IMAP adapter, the lease and the sync loop are imported for real.
    // If cloud-engine ever imported it, the three would arrive together; this pins the seam.
    expect(result.visited.has(resolve(HERE, "../src/engine.ts"))).toBe(false);
  });
});
