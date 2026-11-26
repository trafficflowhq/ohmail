import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { engineUnitFiles } from "../../../test/support/engine-unit.js";
import { moduleResolver } from "../../../scripts/lib/import-closure.mjs";

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
 *   · the organizer lease     `@ohmail/organizer/lease`        (claims the mailbox)
 *   · the shared sync loop     `@ohmail/organizer/sync`         (files mail)
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

const CLOUD_ENGINE = "apps/sidecar/src/cloud-engine.ts";

/** The three modules an organizer is built from. Their exact `/sync`-visible specifiers. */
const FORBIDDEN_SPECIFIERS = [
  "@trafficflow/core/adapters/imap",
  "@ohmail/organizer/lease",
  "@ohmail/organizer/sync",
];
const FORBIDDEN_FILES = new Set([
  r("packages/core/src/adapters/imap.ts"),
  r("packages/organizer/src/lease.ts"),
  r("packages/organizer/src/sync.ts"),
]);

const resolveSource = moduleResolver(REPO);

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
      const target = resolveSource(relative(REPO, file).replaceAll("\\", "/"), spec);
      if (target) stack.push(r(target));
      else if (spec.startsWith("@trafficflow/") || spec.startsWith("@ohmail/")) unresolvedWorkspace.add(spec);
    }
  }
  return { visited, forbiddenHits, unresolvedWorkspace };
}

describe("cloud-engine.ts cannot reach the organizer — the structural safety of Cloud mode", () => {
  const result = crawl(r(CLOUD_ENGINE));

  it("resolves every workspace edge, so the graph it walked is complete", () => {
    // A silently skipped edge is a silently incomplete graph — the one way this goes falsely green.
    expect([...result.unresolvedWorkspace].sort(), "a workspace import did not resolve to source").toEqual([]);
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
    expect(result.visited.has(r("packages/services/src/mail.ts"))).toBe(true);
    expect(result.visited.has(r("packages/core/src/calendar-privacy.ts"))).toBe(true);
    // The calendar's write door reaches the providers through their two pure doors alone (ruling (i)): the walk goes into both, so
    // a forbidden import planted in either is seen, and neither can drop out of the graph unnoticed.
    expect(result.visited.has(r("packages/cal-providers/src/repeat-shapes.ts")), "the providers' proof door is not in the Cloud-engine graph").toBe(true);
    expect(result.visited.has(r("packages/cal-providers/src/series.ts")), "the providers' series door is not in the Cloud-engine graph").toBe(true);
    expect(result.visited.size).toBeGreaterThan(20);
  });

  it("reaches NEITHER the IMAP adapter, NOR the worker lease, NOR the worker sync loop", () => {
    // Each forbidden import must resolve to a known forbidden file, even when no caller reaches it.
    expect(
      [
        ...FORBIDDEN_SPECIFIERS.filter((spec) => {
          const target = resolveSource(CLOUD_ENGINE, spec);
          return target === null || !FORBIDDEN_FILES.has(r(target));
        }),
        ...[...FORBIDDEN_FILES].filter((file) => !existsSync(file)),
      ],
      "a forbidden name of this census resolves to nothing",
    ).toEqual([]);
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
    for (const unit of engineUnitFiles()) expect(result.visited.has(unit), unit).toBe(false);
  });
});
