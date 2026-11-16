import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// ONE scanner, so a `//` inside a string is never read as a comment — the quoted glob in
// packages/services/src/mailbox-service.ts opened one, and a bracket walk ran off the file.
import * as scan from "../../../scripts/lib/source-scan.mjs";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE HOOK THAT FAILS INSTEAD OF THE ASSERTION
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A census, not a behaviour test, and it exists because the failure it forbids is INVISIBLE at
 * the place it is read. `truncateAll` empties 88 tables and, in a worker e2e `beforeEach`, runs
 * after a case that started a worker — so it also waits on the connections that worker is still
 * letting go of. At vitest's 10 s default `hookTimeout` the reset alone measured ~8.3 s for a file
 * resetting two databases: a large share of the budget, leaving whether a file is green or red to scheduler
 * load rather than to the code under test.
 *
 * What that looks like from the outside is the whole point. It does NOT say "the fixture was
 * slow". It says `Hook timed out in 10000ms` against every case AFTER the first worker case, and
 * on 2026-09-06 that cost a release-blocking investigation: `organizer-lease.e2e.test.ts` was
 * reported as a product regression in the organizer lease's own bookkeeping — a mailbox that
 * "never said why it was not syncing" — when the lease code was correct and the test passed the
 * moment it was run on its own. `release-stranded-claim.test.ts` had already hit the same wall and
 * written it down, and bought its way out with a per-file 60 s hook, which cured that one file and
 * left the cost everywhere else.
 *
 * So the two halves are guarded here together: the reset is ONE statement (the cost), and every
 * hook that runs it NAMES its budget (the margin). Neither half is observable from a passing
 * suite, which is exactly why a census is the only thing that can hold them.
 */

const TEST_DIR = join(import.meta.dirname, ".");
/** The organizer's package's tests, which moved out of this folder with their passes (ruling:organizer-cut). */
const ORG_TEST_DIR = join(import.meta.dirname, "../../../packages/organizer/test");
const FIXTURE = "_isolateddb.ts";
const BUDGET = "ISOLATED_DB_RESET_BUDGET_MS";

/** Span of `name( … )` with the parentheses balanced, skipping string and template bodies. */
function hookCalls(src: string, name: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const opener = new RegExp(`\\b${name}\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = opener.exec(src)) !== null) {
    let depth = 0;
    let quote: string | null = null;
    const open = m.index + m[0].length - 1;
    for (let i = open; i < src.length; i++) {
      const c = src[i]!;
      if (quote) {
        if (c === "\\") { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) { out.push({ start: m.index, end: i }); break; }
      }
    }
  }
  return out;
}

const lineOf = (src: string, index: number): number => src.slice(0, index).split("\n").length;

interface Hook { file: string; line: number; hook: string; hasBudget: boolean }

function census(): Hook[] {
  const files = [TEST_DIR, ORG_TEST_DIR].flatMap((d) => readdirSync(d)
    .filter((f) => f.endsWith(".ts") && f !== FIXTURE)
    .sort()
    .map((f) => [d, f] as const));
  const found: Hook[] = [];
  for (const [d, f] of files) {
    const src = readFileSync(join(d, f), "utf8");
    if (!src.includes("truncateAll")) continue;
    for (const hook of ["beforeEach", "afterEach"]) {
      for (const { start, end } of hookCalls(src, hook)) {
        const body = src.slice(start, end + 1);
        // The two hooks that pay the cost: the reset itself, and the teardown that stops the
        // workers the reset then waits on. A hook doing neither is not in scope.
        if (!body.includes("truncateAll") && !body.includes("closers")) continue;
        const tail = body.slice(body.lastIndexOf("}") + 1);   // between the callback and the `)`
        found.push({
          file: f, line: lineOf(src, start), hook,
          hasBudget: /,\s*[A-Za-z_0-9]/.test(tail),
        });
      }
    }
  }
  return found;
}

describe("the isolated-database fixture cannot go back to failing in the hook", () => {
  /**
   * THE POSITIVE CONTROL, and it comes first deliberately. Every other assertion in this file is
   * a refusal, and a refusal census over an empty list passes while guarding nothing — the shape
   * that let a `/join` capture be deleted with all four of its cases still green. If the scanner
   * stops matching (a hook renamed, the fixture moved, `readdirSync` pointed at the wrong
   * directory) this is the assertion that says so, instead of the suite reporting a clean sweep
   * of nothing.
   */
  it("the census actually finds the hooks it claims to police", () => {
    const hooks = census();
    expect(hooks.length, "the scanner matched NO hooks — it is guarding nothing").toBeGreaterThan(40);
    const files = new Set(hooks.map((h) => h.file));
    expect(files.size, "the scanner found hooks in only one file").toBeGreaterThan(10);
    // The file this whole census was written for must be among them.
    expect([...files]).toContain("organizer-lease.e2e.test.ts");
  });

  it("every hook that resets an isolated database names its own timeout", () => {
    const offenders = census().filter((h) => !h.hasBudget);
    const rendered = offenders.map((h) => `${h.file}:${h.line} ${h.hook}(…)`);
    expect(rendered,
      "these hooks take vitest's 10s default while doing a reset that has measured 8.3s — they " +
      `will fail as "Hook timed out in 10000ms" under load and read as a defect in the code ` +
      `under test. Pass ${BUDGET} as the hook's last argument`).toEqual([]);
  });

  /**
   * The other half: the margin above is only affordable because the reset stopped costing 4.1 s
   * per database. A revert to the per-table loop restores the 88-statement sweep and puts every
   * file back at the edge of its budget — silently, because the budgets above would absorb it and
   * the suite would stay green until the next busy afternoon.
   */
  it("the reset is one TRUNCATE naming every table, not one per table", () => {
    const raw = readFileSync(join(TEST_DIR, FIXTURE), "utf8");
    // COMMENTS COME OUT FIRST. The fixture's own doc comment quotes the per-table loop it
    // replaced, in as many words — so a check run over the raw file matches the explanation of
    // the defect and reports the defect. A comment here is the claim under test, never evidence
    // for it, and this guard read its own prose as a violation the first time it was run.
    const src = scan.withoutComments(raw);
    expect(src, "the reset went back to a per-table loop").not.toMatch(/FOREACH\s+\w+\s+IN\s+ARRAY/i);
    expect(src, "the single multi-table TRUNCATE is gone")
      .toContain("EXECUTE format('TRUNCATE TABLE %s CASCADE', tables)");
    expect(src, `${BUDGET} is what the hooks import; it must stay exported here`)
      .toMatch(new RegExp(`export const ${BUDGET}\\s*=`));
  });
});
