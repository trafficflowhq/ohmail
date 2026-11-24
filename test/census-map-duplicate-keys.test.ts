/**
 * A DUPLICATE KEY IN A CENSUS MAP, WHEREVER THE TYPECHECK DOES NOT REACH.
 *
 * TypeScript calls a repeated property TS1117 — in the programs it compiles. Census maps live in
 * `test/` directories, and `scripts/typecheck-test-dirs.mjs` pins fourteen of those as UNREACHED
 * (AGENTS.md): there a second `foo:` overwrites the first in silence, and the census counts one
 * fewer sink than it lists while reading green.
 *
 * Measured at this file's own base: `IN_SINKS` in `packages/api/test/input-bounds-census.test.ts`
 * declared `"schedule-send-pass.ts :: [...mailboxIds]"` twice, 12 lines apart, with two DIFFERENT
 * `bounded` sentences. The later one won, the earlier one described a sink nothing enforced, and
 * the census that reads that map passed throughout. One site exists in the source; the two entries
 * are now one.
 *
 * The root `test/` directory is in no tsconfig project (AGENTS.md), so `pnpm typecheck` says
 * nothing about this file; the module under test is plain `.mjs`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs helper, no declarations by design.
import { censusMapLiterals, topLevelKeys, duplicateCensusKeys } from "../scripts/lib/census-map-keys.mjs";

const ROOT = join(import.meta.dirname, "..");

/** Tracked sources, and the two cheap reads that say a file could hold one of these at all. */
function candidates(): string[] {
  const files = execFileSync("git", ["-C", ROOT, "ls-files", "*.ts", "*.tsx", "*.mjs", "*.js", "*.cjs"],
    { encoding: "utf8", maxBuffer: 64e6 }).split("\n").filter(Boolean);
  return files;
}
const BINDING = /(?:^|[\s;{}()])(?:export\s+)?(?:const|let|var)\s+[A-Z][A-Z0-9_]*[A-Z0-9]\b/;

describe("census maps declare each key once", () => {
  it("finds no duplicate key in any census map in the tree", () => {
    const found: string[] = [];
    let maps = 0;
    let scanned = 0;
    for (const rel of candidates()) {
      let src: string;
      try { src = readFileSync(join(ROOT, rel), "utf8"); } catch { continue; }
      if (!BINDING.test(src) || !/=\s*\{/.test(src)) continue;
      scanned++;
      maps += (censusMapLiterals(src) as unknown[]).length;
      for (const d of duplicateCensusKeys(src) as { map: string; key: string; line: number; firstLine: number }[]) {
        found.push(`${rel}:${d.line} — ${d.map}["${d.key}"] repeats the entry at :${d.firstLine}`);
      }
    }
    // The subject is reported, so a run that scanned nothing cannot read as a pass: a census with
    // no subject has not looked.
    expect(scanned, "files carrying a SCREAMING_SNAKE object binding").toBeGreaterThan(200);
    expect(maps, "census map literals found").toBeGreaterThan(500);
    expect(found).toEqual([]);
  }, 120_000);

  it("finds a planted duplicate in the real map, by file:line", () => {
    // The positive control for the case above, driven through the map that carried the live one.
    const rel = "packages/api/test/input-bounds-census.test.ts";
    const src = readFileSync(join(ROOT, rel), "utf8");
    const key = '"account-deletion-service.ts :: ownMailboxIds": {';
    expect(src.split(key)).toHaveLength(2);
    const planted = src.replace(key, `"account-deletion-service.ts :: ownMailboxIds": { origin: "subquery", count: 1 },\n  ${key}`);
    const dups = duplicateCensusKeys(planted) as { map: string; key: string }[];
    expect(dups.map((d) => `${d.map}.${d.key}`))
      .toEqual(["IN_SINKS.account-deletion-service.ts :: ownMailboxIds"]);
  });

  it("reads a binding whose TYPE ANNOTATION carries braces and semicolons", () => {
    // The first version of the finder matched `const NAME<no ; or =>= {` and skipped exactly this
    // declaration — the one the row was measured on — so the whole census was blind and green.
    const src = 'const IN_SINKS: Readonly<Record<string, { origin: A; count: number }>> = {\n  "a": 1,\n  "a": 2,\n};\n';
    expect((censusMapLiterals(src) as { name: string }[]).map((l) => l.name)).toEqual(["IN_SINKS"]);
    expect((duplicateCensusKeys(src) as { key: string; line: number }[])[0]).toMatchObject({ key: "a", line: 3 });
  });

  it("compares a quoted key with its bare spelling", () => {
    const src = 'const MAP = {\n  alpha: 1,\n  "alpha": 2,\n};\n';
    expect((duplicateCensusKeys(src) as { key: string }[]).map((d) => d.key)).toEqual(["alpha"]);
  });

  it("does not read an identifier inside a VALUE as a key", () => {
    // `a: b ? c : d` has a `c` followed by a `:`. A regex over this reports `c` as a key and then
    // reports a duplicate the moment a second value uses the same name.
    const src = "const MAP = {\n  a: b ? c : d,\n  e: f ? c : g,\n};\n";
    expect(duplicateCensusKeys(src)).toEqual([]);
    expect((topLevelKeys(src, src.indexOf("{")) as { keys: { key: string }[] }).keys.map((k) => k.key))
      .toEqual(["a", "e"]);
  });

  it("reads only the literal's OWN top level, so a nested repeat is not this literal's", () => {
    const src = "const MAP = {\n  a: { x: 1, y: 2 },\n  b: { x: 3, y: 4 },\n};\n";
    expect(duplicateCensusKeys(src)).toEqual([]);
  });

  it("says nothing about computed keys, which it cannot compare", () => {
    const src = "const MAP = {\n  [K]: 1,\n  [K]: 2,\n};\n";
    expect(duplicateCensusKeys(src)).toEqual([]);
  });

  it("is not fooled by a declaration inside a comment or a string", () => {
    const src = '// const MAP = { a: 1, a: 2 };\nconst NOPE = "const OTHER = { b: 1, b: 2 }";\n';
    expect(censusMapLiterals(src)).toEqual([]);
    expect(duplicateCensusKeys(src)).toEqual([]);
  });

  it("ignores a lower-case binding, which is a value rather than a register", () => {
    const src = "const mapOfThings = {\n  a: 1,\n  a: 2,\n};\n";
    expect(censusMapLiterals(src)).toEqual([]);
  });
});
