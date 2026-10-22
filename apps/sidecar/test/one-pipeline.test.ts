import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * ONE PIPELINE IMPLEMENTATION — the ruling this whole package exists to obey, asserted.
 *
 * The project's design notes: "The decisive reason is **one pipeline implementation**. Two engines
 * diverge, and divergence here means mail filed differently on desktop than on Cloud — a defect
 * a defect heard about from a confused customer rather than from a test."
 *
 * That is the entire justification for a Node sidecar over native IMAP in Swift and Rust, and it
 * is exactly the kind of constraint that erodes: someone needs one small behavioural difference,
 * copies twenty lines of `runSyncCycle` into the sidecar, and six months later desktop and Cloud
 * disagree about where a newsletter goes. So it is a test, not a comment.
 *
 * The rule: `apps/sidecar/src` may DRIVE the pipeline and may not BE one. It imports
 * `runSyncCycle`; it never calls `planChange`, `commitChange` or `reconcile` itself, and it never
 * decides a destination.
 *
 * ── AND THE PUBLISH BOUNDARY ───────────────────────────────────────────────────────────────
 *
 * This package holds the engine — `@trafficflow/api`, `@trafficflow/db`, `imapflow`, PGlite —
 * and is open source with the rest of the product, the whole server included. The case that held
 * the earlier private tree's export step to naming `apps/sidecar/src` on purpose left with that
 * step, which is not part of this repository; the block below pins the engine tier.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "src");
const REPO = join(HERE, "..", "..", "..");

function sources(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, into);
    else if (extname(name) === ".ts") into.push(p);
  }
  return into;
}

const FILES = sources(SRC).map((p) => ({ path: p.slice(REPO.length + 1), text: readFileSync(p, "utf8") }));
/**
 * Comments say what the code should do; only the code decides what it does — read through the
 * repo's one scanner. A block-first pair of regexes reads a block-comment OPENER quoted inside a
 * line comment as real and deletes every line to the next terminator; `engine.ts`, the driver this
 * census is about, quotes folder globs that way, so the pair handed the negatives below an extract
 * short of the file, and a negative over absent code passes for nothing.
 */
const code = (text: string): string => withoutComments(text);

describe("the sidecar drives the pipeline and is not a second one", () => {
  it("resolved a real file list", () => {
    // A walker that silently returns nothing would make every assertion below vacuous.
    expect(FILES.length).toBeGreaterThan(5);
    expect(FILES.map((f) => f.path)).toContain("apps/sidecar/src/engine.ts");
  });

  it("imports the worker's sync loop rather than defining one", () => {
    const importers = FILES.filter((f) => /from\s+"@trafficflow\/worker\/sync"/.test(f.text));
    /* TWO FILES MAY NAME THE LOOP'S MODULE, AND EXACTLY ONE MAY RUN IT.
     *
     * `engine.ts` is the driver. `roster.ts` is the second, and it is here for the reason the
     * paragraph below already gives about `SyncDeps`: the per-mailbox runtime holds the bag the
     * loop is fed, and it declares that bag as `Omit<SyncDeps, …>` so its shape is DERIVED from
     * the loop's own declaration and cannot drift from it. A hand-written copy of those fields
     * would be the divergence this whole file exists to prevent, arriving as a type instead of as
     * a function.
     *
     * The list is sorted because it comes from a directory walk, whose order is the filesystem's
     * and not alphabetical — an unsorted comparison would pass or fail by luck of inode order.
     */
    expect([...importers.map((f) => f.path)].sort())
      .toEqual(["apps/sidecar/src/engine.ts", "apps/sidecar/src/roster.ts"]);
    /* …AND EVERY IMPORTER THAT IS NOT THE DRIVER IMPORTS TYPES AND NOTHING ELSE. This is what
       keeps naming a second consumer from being a way of admitting a second pipeline: the clause
       has to open `import type`, so nothing it names can execute. Asserted for every file but the
       driver rather than for `roster.ts` by name, so a third importer added later meets the same
       bar without anyone remembering to extend a list. */
    for (const f of importers) {
      if (f.path === "apps/sidecar/src/engine.ts") continue;
      expect(f.text, `${f.path} may import TYPES from the sync loop and nothing else`)
        .toMatch(/import\s+type\s*\{[^}]*\}\s*from\s+"@trafficflow\/worker\/sync"/);
      expect(f.text, `${f.path} must not carry a value import from the sync loop`)
        .not.toMatch(/import\s*\{[^}]*\}\s*from\s+"@trafficflow\/worker\/sync"/);
    }
    /* THE VALUE IMPORT IS THE CLAIM. This used to require the clause to name `runSyncCycle` and
       nothing else, which read as strictness and was really a coincidence: the module also exports
       `SyncDeps`, and the engine takes that type so its own screening resolver is shaped by the
       loop's declaration rather than by a hand-written copy of it — which is more of this test's
       point, not less. So the assertion names what must be there and stays silent about what else
       the clause may carry, and the next line is what keeps that from becoming a hole. */
    /* THE DRIVER BY PATH, never `importers[0]`. That index was the driver while the driver was
       the only importer; with a second one it is whichever file the directory walk happened to
       reach first, so the two assertions below would be about `roster.ts` on some filesystems and
       about the engine on others — the shape of a guard that passes by luck. */
    const driver = importers.find((f) => f.path === "apps/sidecar/src/engine.ts");
    expect(driver, "the engine must be the file that imports the loop").toBeDefined();
    expect(driver!.text).toMatch(/import\s*\{[^}]*\brunSyncCycle\b[^}]*\}\s*from\s+"@trafficflow\/worker\/sync"/);
    /* …and nothing but TYPES may ride along. A second VALUE pulled out of the loop's module is a
       second piece of the pipeline executing in this process, which is the thing being prevented;
       a type cannot execute. Written as "every other name is prefixed `type`" rather than as a
       list, so a new export cannot join the clause by being unlisted. */
    const clause = /import\s*\{([^}]*)\}\s*from\s+"@trafficflow\/worker\/sync"/.exec(driver!.text)![1]!;
    const others = clause.split(",").map((s) => s.trim()).filter((s) => s && !/^runSyncCycle$/.test(s));
    expect(others.filter((s) => !s.startsWith("type "))).toEqual([]);
  });

  it.each(["planChange", "commitChange", "buildCursor", "reconcileMailbox", "evaluateRules", "classifyDedup"])(
    "never calls %s itself",
    (symbol) => {
      const offenders = FILES.filter((f) => new RegExp(`\\b${symbol}\\s*\\(`).test(code(f.text))).map((f) => f.path);
      expect(
        offenders,
        `${symbol} is being called in the sidecar — that is a SECOND pipeline driver, and ` +
          "The desktop's one-pipeline rule allows exactly one. Extend the shared loop instead.",
      ).toEqual([]);
    },
  );

  it("names no ohmail destination folder of its own", () => {
    // Where mail goes is `packages/core`'s decision. A string like "ohmail/News" appearing here
    // is the first line of a divergent router.
    // Both News spellings: naming the pile's folder in EITHER form is the same divergent router.
    const offenders = FILES.filter((f) => /["'`]ohmail\/(Screener|Reads|News|Receipts|Screened|Quarantine)["'`]/.test(code(f.text)));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("the detector is not vacuous — it fires on the shapes it is looking for", () => {
    // A guard nobody has watched fail is not evidence (CLAUDE.md). These are the violations.
    expect(/\bplanChange\s*\(/.test(code("const plan = await planChange(change, deps);"))).toBe(true);
    expect(/["'`]ohmail\/(Screener|Reads|News)["'`]/.test(code('const dest = "ohmail/News";'))).toBe(true);
    // …and it ignores the same words in prose, so the rule can be explained without breaking it.
    expect(/\bplanChange\s*\(/.test(code("// the worker calls planChange(...) for us"))).toBe(false);
    expect(/["'`]ohmail\/(Screener|Reads|News)["'`]/.test(code('/* files into "ohmail/News" */'))).toBe(false);
  });
});

describe("the sidecar drives the DRAIN POLICY and does not define one", () => {
  /**
   * ONE STALENESS POLICY — INSTANT-ARCH §6.7, stage 7's first adopted responsibility, held the
   * same way §1 is held: structurally, not by discipline.
   *
   * The mirror in this package and the engine in `packages/client-engine` are two
   * implementations of "drain the account's change feed into a local store", and they will stay
   * two for as long as the relational apply is load-bearing for the LOCAL door. What must NOT
   * stay two is the layer that forked — twice, measurably, in one week:
   *
   *   · stage 2 shipped `STALE_RESUME_MS` + a stale predicate + a three-state `freshness()` in
   *     the engine, then wrote `CLOUD_STALE_RESUME_MS` + an inline stamp comparison + a second
   *     `freshness()` here;
   *   · stage 3 shipped `BACKLOG_PAGE_LIMIT = 2000` in the engine and
   *     `STALE_REPLAY_PAGE_LIMIT = 2000` here.
   *
   * Both copies agreed on the day they were written, which is what made the duplication
   * dangerous rather than obviously broken: nothing was red, and the NEXT change to the policy
   * would have landed on one surface and missed the other — the "the engine got a fix, the
   * sidecar didn't" class §6.7 names. So the copies are retired and this is what keeps them
   * retired: the mirror imports the shared module, and it may not re-derive what that module
   * decides.
   *
   * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────────
   *
   * Put `const CLOUD_STALE_RESUME_MS = 5 * 60_000;` back in `cloud-mirror.ts` and the threshold
   * case goes RED; hand-write the three-state ternary back into `freshness()` and the derivation
   * case goes RED; drop the import and the first case goes red. Restore and they go green.
   */
  const MIRROR = FILES.find((f) => f.path === "apps/sidecar/src/cloud-mirror.ts")!;

  it("resolved the mirror source", () => {
    // A find that silently missed would make every assertion below vacuous.
    expect(MIRROR, "apps/sidecar/src/cloud-mirror.ts was not in the walked file list").toBeTruthy();
    expect(MIRROR.text.length).toBeGreaterThan(1000);
  });

  it("imports the shared policy — and reaches the engine through that subpath and no other", () => {
    expect(MIRROR.text).toMatch(
      /import\s*\{[^}]*\bmirrorStale\b[^}]*\}\s*from\s+"@trafficflow\/core\/drain-policy"/,
    );
    /* AND THE BARREL STAYS OUT. `@ohmail/client-engine` reaches IndexedDB, the search index and
       the whole optimistic-overlay machinery; a Node mirror driver that linked it would be
       carrying a second client. The policy module is dependency-free source on its own subpath
       precisely so this line can stay true (`packages/core/package.json`, `//drain-policy`). */
    const engineImporters = FILES.filter((f) => /from\s+"@ohmail\/client-engine/.test(f.text));
    expect(engineImporters.map((f) => f.path)).toEqual([]);
  });

  it("declares no staleness threshold of its own", () => {
    /* The shape of the retired fork: a module-level constant holding a duration that the freshen
       and the label both compare against. Any `… _MS = <n> * 60_000` in this file that is not one
       of the mirror's OWN timings (poll cadence, reconnect backoff, counts TTL) would be a second
       opinion about the same fact. Asserted as an exact set so a new timing has to be classified
       rather than absorbed. */
    const consts = [...code(MIRROR.text).matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_MS)\s*=/g)]
      .map((m) => m[1]!);
    expect(new Set(consts)).toEqual(new Set([
      "DEFAULT_CLOUD_POLL_MS",   // how often this process pulls — its own cadence, not a policy
      "HOSTED_COUNTS_TTL_MS",    // how long a counted refresh is reused
      "HOSTED_COUNTS_MIN_GAP_MS",
      "RECONNECT_BASE_MS",
      "RECONNECT_MAX_MS",
      "WALLED_POLL_MS",          // how often a refused account's pull asks again — its own asks
      "FOLLOW_UP_CAP_MS",        // how long a cut echo keeps asking the feed — its own asks
      "RULES_REFRESH_MIN_GAP_MS", // how often a queue answer may owe a rules pass — its own asks
    ]));
    expect(consts).not.toContain("CLOUD_STALE_RESUME_MS");
  });

  it("declares no page-size policy of its own beyond its default", () => {
    // `DEFAULT_PAGE_LIMIT` is this driver's own steady-state ask and is passed INTO the shared
    // helper. A second limit constant here is the retired `STALE_REPLAY_PAGE_LIMIT`.
    const limits = [...code(MIRROR.text).matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_PAGE_LIMIT)\s*=/g)]
      .map((m) => m[1]!);
    expect(limits).toEqual(["DEFAULT_PAGE_LIMIT"]);
    expect(code(MIRROR.text)).toMatch(/drainPageLimit\(/);
  });

  it("re-derives neither the stale verdict nor the three freshness states", () => {
    const src = code(MIRROR.text);
    /* The hand-written derivations, by their shapes. The stale predicate was a `Date.parse` on
       the drain stamp compared against a threshold; the label was a ternary over "stale" and
       "current" string literals. Both are now one call each. */
    expect(src, "the mirror is parsing its own drain stamp again — call mirrorStale/mirrorFreshness")
      .not.toMatch(/Date\.parse\s*\(\s*(stamp|cursor\.lastDrainAt)/);
    expect(src, "the mirror is deriving the freshness states again — call mirrorFreshness")
      .not.toMatch(/["']stale["']\s*(as const)?\s*[:)]\s*.*["']current["']/);
    expect(src).toMatch(/mirrorStale\(/);
    expect(src).toMatch(/mirrorFreshness\(/);
  });

  it("the detectors are not vacuous — they fire on the shapes they are looking for", () => {
    // A guard nobody has watched fail is not evidence (CLAUDE.md). These are the violations,
    // written out verbatim as they stood in this file before the adoption.
    const planted = code("const CLOUD_STALE_RESUME_MS = 5 * 60_000;");
    expect([...planted.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_MS)\s*=/g)].map((m) => m[1]))
      .toEqual(["CLOUD_STALE_RESUME_MS"]);
    expect([...code("const STALE_REPLAY_PAGE_LIMIT = 2000;")
      .matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_PAGE_LIMIT)\s*=/g)].map((m) => m[1]))
      .toEqual(["STALE_REPLAY_PAGE_LIMIT"]);
    expect(/Date\.parse\s*\(\s*(stamp|cursor\.lastDrainAt)/.test("const t = Date.parse(stamp);")).toBe(true);
    expect(/["']stale["']\s*(as const)?\s*[:)]\s*.*["']current["']/.test(
      'state: now().getTime() - t > MS ? ("stale" as const) : ("current" as const),',
    )).toBe(true);
    // …and they ignore the same words in prose, so the rule can be explained without breaking it.
    expect(/Date\.parse\s*\(\s*(stamp|cursor\.lastDrainAt)/.test(
      code("// the policy module does the Date.parse(stamp) for us"),
    )).toBe(false);
  });
});

describe("the sidecar publishes with the open product, deliberately", () => {
  it("holds engine dependencies — the engine tier may import them; the UI tier may not", () => {
    // Stated as a fact about this tree rather than a worry: these are the specifiers that mark
    // the engine tier, and they are here on purpose (the sidecar drives the same pipeline the
    // hosted worker runs; the UI tier may not touch them).
    const all = FILES.map((f) => f.text).join("\n");
    // Matched as a PREFIX, because the engine now enters `packages/api` and `packages/core`
    // through their mail-half entry points (`@trafficflow/api/local`) rather than their default
    // barrels. The claim is unchanged and is still about this tree: these imports are what make
    // the sidecar engine-tier. Naming the subpath form is naming the new consumer, not relaxing
    // the assertion — a specifier that disappeared entirely still fails here.
    for (const spec of ["@trafficflow/api", "@trafficflow/db", "@electric-sql/pglite", "drizzle-orm"]) {
      expect(all, `${spec} is no longer imported — has the engine moved?`).toMatch(
        new RegExp(`"${spec.replace(/[/@-]/g, "\\$&")}(/[a-z-]+)?"`),
      );
    }
  });
});
