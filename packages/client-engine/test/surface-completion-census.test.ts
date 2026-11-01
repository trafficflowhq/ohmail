import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * NO SURFACE FOLDS A MUTATION'S STATUS TO A BOOLEAN.
 *
 * SCANNED ROOTS: `apps/webapp/app` and `apps/mobile/src` — neither is this package, so touched-
 * package selection never reaches this file and it is run by its scanned roots (CLAUDE.md's
 * census rule).
 *
 * The defect is one expression. `r.status !== "rolled_back"` partitions four statuses into two
 * and puts BOTH waits on the completion side, so a verb the server merely RECORDED for the
 * install that organizes the mailbox came back through the same door as a verb that happened —
 * and the sentence above it said it was done. The K32 landing wrote that fold back into
 * `live.ts` verbatim while composing two fixes and measured that three suites, 50 tests, all
 * passed over it: the 202 census measures the ADAPTER door, and the surfaces were the
 * unmeasured half.
 *
 * So the rule is the expression, not a list of files: the two fold spellings are refused, and
 * every completion sentence reads {@link pressVerdict} instead. Source is read with comments
 * blanked — both spellings appear in the prose that explains them, including in this header's
 * own neighbours, and a census that counts prose measures nothing.
 */

const ROOTS = [
  new URL("../../../apps/webapp/app/", import.meta.url),
  new URL("../../../apps/mobile/src/", import.meta.url),
];

/**
 * A pair the census names and deliberately does not require, with its reason. One entry, and it
 * is a fact about the VOCABULARY rather than about the site: `delete-undo.ts` branches on a
 * `HeldOutcome`, whose `status` is a `string` because `restoreDispatch` maps the restore's
 * answer onto `"confirmed"` or `"rolled_back"` — `engine.restoreFromTrash` has its own words and this file owns the mapping. It
 * is not a reading of a `MutationResult`, so there is no verdict for it to read, and its
 * non-refusal arm settles both waits for reasons written at the function.
 */
const PINNED: Record<string, string> = {
  "apps/webapp/app/shell/delete-undo.ts":
    "HeldOutcome is not a MutationResult — restoreDispatch maps the restore's answer onto \"confirmed\" or \"rolled_back\" and the suite's doubles spell \"applied\", so `status` is a `string` and there is no MutationStatus here for the verdict to read. Its dispatch counts the organizer's wait by name all the same, beside the refusals.",
};

/** The two spellings that reduce a status to landed-or-not. */
const FOLDS: Array<{ name: string; re: RegExp }> = [
  { name: 'status !== "rolled_back"', re: /\.status\s*!==\s*"rolled_back"/g },
  { name: 'status === "rolled_back" ? … : …', re: /\.status\s*===\s*"rolled_back"\s*\n?\s*\?/g },
];

function sources(): Array<{ rel: string; src: string }> {
  const out: Array<{ rel: string; src: string }> = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full, `${rel}/${name}`); continue; }
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      out.push({ rel: `${rel}/${name}`, src: withoutComments(readFileSync(full, "utf8")) });
    }
  };
  for (const root of ROOTS) {
    const dir = fileURLToPath(root);
    const rel = root.href.includes("webapp") ? "apps/webapp/app" : "apps/mobile/src";
    walk(dir.replace(/\/$/, ""), rel);
  }
  return out;
}

/** Every fold found, as `file:spelling`. */
function foldsFound(): string[] {
  const found: string[] = [];
  for (const { rel, src } of sources()) {
    for (const { name, re } of FOLDS) {
      re.lastIndex = 0;
      if (re.test(src)) found.push(`${rel}: ${name}`);
    }
  }
  return found;
}

describe("the completion census — no surface says done from a folded status", () => {
  /** THE PREMISE, measured: a census over an empty corpus would pass for nothing. */
  it("reads both surfaces, and there is a corpus", () => {
    const files = sources();
    expect(files.length, "no surface source was read — the walk broke").toBeGreaterThan(100);
    expect(files.some((f) => f.rel.endsWith("apps/mobile/src/state/live.ts"))).toBe(true);
    expect(files.some((f) => f.rel.endsWith("apps/webapp/app/shell/AppShell.tsx"))).toBe(true);
  });

  /** …and the detector finds a fold when there is one, or an empty answer means nothing. */
  it("finds a planted fold in both spellings", () => {
    const planted = [
      'const ok = res.status !== "rolled_back";',
      'toast(res.status === "rolled_back" ? failed : ok);',
    ];
    for (const line of planted) {
      const hit = FOLDS.some(({ re }) => { re.lastIndex = 0; return re.test(line); });
      expect(hit, `the detector missed ${line}`).toBe(true);
    }
    /* …and does NOT fire on the shapes that are not folds: a bare refusal `if`, and the prose
       that explains the defect (blanked before the scan, so this arm is about the regex alone). */
    for (const line of ['if (res.status === "rolled_back") toast(failed);', 'if (o.status === "rolled_back") {']) {
      const hit = FOLDS.some(({ re }) => { re.lastIndex = 0; return re.test(line); });
      expect(hit, `the detector fired on ${line}`).toBe(false);
    }
  });

  it("no surface file folds a status, and every pin is still true", () => {
    const owed = foldsFound().filter((f) => !PINNED[f.split(":")[0]!]);
    expect(owed, "a surface reduces a mutation's status to landed-or-not").toEqual([]);
    /* A pin for a file that no longer folds is a claim about nothing — it goes when it stops
       being true, not when somebody notices. */
    const folding = new Set(foldsFound().map((f) => f.split(":")[0]!));
    expect(Object.keys(PINNED).filter((p) => !folding.has(p)), "a stale pin").toEqual([]);
  });

  /**
   * THE OTHER HALF OF THE COVERAGE. An empty owed list is also what a broken walk answers, so
   * the four functions that used to fold are named and asserted to REACH the reducer — a census
   * that cannot say what it did not cover silently covered nothing.
   */
  it("the four seams that used to fold now read the verdict", () => {
    const by = new Map(sources().map((f) => [f.rel, f.src]));
    const reaches = (rel: string, needle: string): boolean => (by.get(rel) ?? "").includes(needle);
    expect(reaches("apps/mobile/src/state/live.ts", "pressVerdict"), "the phone's watched").toBe(true);
    /* THE SHELL'S OWN SEAM MOVED. `dispatchPress` is `shell-dispatch.ts`'s now, so the claim is
       asked of the file that holds it — left on `AppShell.tsx` it would have read true off an
       unrelated `pressVerdict` in the draft verbs and vouched for a seam it no longer contains. */
    expect(reaches("apps/webapp/app/shell/shell-dispatch.ts", "pressVerdict"), "the shell's dispatchPress").toBe(true);
    expect(reaches("apps/webapp/app/shell/screener-state.ts", "pressVerdict"), "the Screener's moveAll").toBe(true);
    expect(reaches("apps/webapp/app/views/RulesView.tsx", "pressVerdict"), "the rules pane's report").toBe(true);
  });
});
