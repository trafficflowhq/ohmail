import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BACKLOG_PAGE_LIMIT, STALE_RESUME_MS } from "@trafficflow/core/drain-policy";
import { BACKLOG_PAGE_LIMIT as ENGINE_BACKLOG, STALE_RESUME_MS as ENGINE_STALE } from "../src/index.js";

/**
 * ONE DRAIN POLICY IN THE TREE — the engine's half of the census `apps/sidecar/test/
 * one-pipeline.test.ts` keeps on the mirror's half (INSTANT-ARCH §6.7, stage 7's first adopted
 * responsibility).
 *
 * There are two drivers that drain the account's change feed into a local store: this engine
 * (over IndexedDB on the web, sqlite on the phone) and `apps/sidecar/src/cloud-mirror.ts` (over
 * the desktop's relational PGlite store). They stay two — the relational apply is load-bearing
 * for the LOCAL door and cannot be deleted — so what has to be one is the POLICY they share:
 * when a mirror counts as behind, what a surface may say about its age, and how big the pages of
 * a catch-up drain are.
 *
 * That policy forked twice inside one week, and both times it forked SILENTLY, with matching
 * values: `STALE_RESUME_MS` / `CLOUD_STALE_RESUME_MS`, `BACKLOG_PAGE_LIMIT` /
 * `STALE_REPLAY_PAGE_LIMIT`, and a hand-written stale predicate and freshness ternary on each
 * side. Nothing was red. The defect such a fork produces arrives one change later, on one
 * surface only.
 *
 * So the rule this file holds is not "the numbers agree" — they always did — but "there is only
 * one place the numbers COULD be written". The definitions live in
 * `packages/core/src/drain-policy.ts`, on a dependency-free subpath both graphs can reach, and
 * the two drivers may re-export them but may not restate them.
 *
 * ── HOW TO WATCH IT FAIL ──────────────────────────────────────────────────────────────────────
 *
 * Write `const STALE_RESUME_MS = 5 * 60_000;` (rather than the re-export) into `engine.ts` and
 * the definition case goes RED; hand the freshness ternary back into `OhmailEngine.freshness()`
 * and the derivation case goes RED. Both restore green.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..", "..");

/** The two drivers' source trees — the only places a second policy could be written. */
const DRIVER_DIRS = [
  join(REPO, "packages", "client-engine", "src"),
  join(REPO, "apps", "sidecar", "src"),
];

function sources(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, into);
    else if (extname(name) === ".ts") into.push(p);
  }
  return into;
}

/** Comments say what the code should do; only the code decides what it does. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const FILES = DRIVER_DIRS.flatMap((d) => sources(d)).map((p) => ({
  path: p.slice(REPO.length + 1),
  src: code(readFileSync(p, "utf8")),
}));

describe("the two mirror drivers share one drain policy", () => {
  it("walked both driver trees", () => {
    // A walker that silently returned nothing would make every assertion below vacuous.
    const paths = FILES.map((f) => f.path);
    expect(paths).toContain("packages/client-engine/src/engine.ts");
    expect(paths).toContain("apps/sidecar/src/cloud-mirror.ts");
    expect(FILES.length).toBeGreaterThan(20);
  });

  it("neither driver DEFINES a staleness threshold or a backlog page size — both re-export", () => {
    /* A DEFINITION is `const NAME = <expression>`. A RE-EXPORT (`export { … } from`) is not one,
       and that distinction is the whole assertion: the engine's public surface still carries both
       names, because twenty consumers import them from `@ohmail/client-engine`, and the values
       behind those names come from one file. */
    const definers = FILES.filter((f) =>
      /\bconst\s+(STALE_RESUME_MS|CLOUD_STALE_RESUME_MS|BACKLOG_PAGE_LIMIT|STALE_REPLAY_PAGE_LIMIT)\s*=/.test(f.src),
    );
    expect(definers.map((f) => f.path)).toEqual([]);
  });

  it("the names the drivers publish carry the shared values", () => {
    // The re-export is not a copy: same module object, same numbers, asserted rather than assumed.
    expect(ENGINE_STALE).toBe(STALE_RESUME_MS);
    expect(ENGINE_BACKLOG).toBe(BACKLOG_PAGE_LIMIT);
  });

  it("neither driver re-derives the three freshness states", () => {
    /* The retired shape, on both sides: a ternary over the `"stale"` and `"current"` literals.
       A driver that computes those two words itself has an opinion about mirror age that the
       shared derivation cannot correct. */
    const derivers = FILES.filter((f) => /["']stale["'][\s\S]{0,80}?["']current["']/.test(f.src));
    expect(derivers.map((f) => f.path)).toEqual([]);
  });

  it("neither driver parses the drain stamp itself", () => {
    // `Date.parse` on the last-drain stamp is the stale predicate being written a third time.
    const parsers = FILES.filter((f) =>
      /Date\.parse\s*\(\s*(stamp|lastDrainAt|cursor\.lastDrainAt)/.test(f.src),
    );
    expect(parsers.map((f) => f.path)).toEqual([]);
  });

  it("the detectors are not vacuous — they fire on the shapes they are looking for", () => {
    // A guard nobody has watched fail is not evidence (AGENTS.md). Verbatim from the pre-adoption
    // sources of both drivers.
    expect(/\bconst\s+(STALE_RESUME_MS|CLOUD_STALE_RESUME_MS|BACKLOG_PAGE_LIMIT|STALE_REPLAY_PAGE_LIMIT)\s*=/
      .test("export const CLOUD_STALE_RESUME_MS = 5 * 60_000;")).toBe(true);
    expect(/\bconst\s+(STALE_RESUME_MS|CLOUD_STALE_RESUME_MS|BACKLOG_PAGE_LIMIT|STALE_REPLAY_PAGE_LIMIT)\s*=/
      .test("const STALE_REPLAY_PAGE_LIMIT = 2000;")).toBe(true);
    // …and a re-export is deliberately NOT a definition.
    expect(/\bconst\s+(STALE_RESUME_MS|BACKLOG_PAGE_LIMIT)\s*=/
      .test('export { STALE_RESUME_MS, BACKLOG_PAGE_LIMIT } from "@trafficflow/core/drain-policy";')).toBe(false);
    expect(/["']stale["'][\s\S]{0,80}?["']current["']/
      .test('state: now.getTime() - t > staleMs ? "stale" : "current",')).toBe(true);
    expect(/Date\.parse\s*\(\s*(stamp|lastDrainAt|cursor\.lastDrainAt)/
      .test("const t = Date.parse(cursor.lastDrainAt);")).toBe(true);
    // …and prose about the rule does not break the rule.
    expect(code("// compares 'stale' against 'current' for us").trim()).toBe("");
  });
});
