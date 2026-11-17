import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { decisionCanBeApplied } from "../src/organizer-role.js";
import type { RequestEligibility } from "../src/organizer-role.js";

/**
 * ONE PREDICATE, TWO SPENDERS — the census that keeps "could a decision here ever land" from being
 * asked in one place and forgotten in the other.
 *
 * The manual purchase route has asked it since 0.14.1. The automatic worker pass did not, so a
 * person who stopped the sole organizer kept being charged every cycle for advice nobody could
 * apply. The fix is not a second copy of the three clauses in the worker — a copy is exactly how
 * the two drifted in the first place — it is one exported function both callers call.
 *
 * ## What this holds, from both directions
 *
 *  1. both money call sites CALL `decisionCanBeApplied` (a renamed or deleted call is red);
 *  2. NEITHER re-spells its clauses inline, so a future edit cannot quietly fork the rule;
 *  3. the function itself answers the three states a mailbox can be in.
 *
 * The source is read through the repository's ONE-PASS comment stripper, because the clause this
 * census hunts for is quoted in the prose above several of these very call sites — a two-pass
 * regex strip has already eaten thousands of characters of one source file here, and a scanner that
 * silently matches nothing is green precisely when it is useless.
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const read = (p: string): string => withoutComments(readFileSync(`${REPO}/${p}`, "utf8"));

/** The two call sites that SPEND on the answer. Both are money paths; neither may guess. */
const SPENDERS: ReadonlyArray<[string, string]> = [
  ["packages/services/src/screener-service.ts", "the manual purchase route (ScreenerService.suggest)"],
  ["packages/organizer/src/screener-auto-suggest.ts", "the automatic worker pass (screenerAutoSuggestPass)"],
];

/**
 * THE INLINE SPELLING, as a regex over comment-free source: any `capable` conjoined with a
 * `status` comparison. It is deliberately loose about spacing and operand order — a copy that
 * reordered its clauses would be the same defect wearing a different shape.
 */
const INLINE = /\.capable\s*&&[^;]{0,120}\.status\s*!==|\.status\s*!==[^;]{0,120}&&\s*\w+\.capable/;

describe("no organizer, no spend — one predicate at both spenders", () => {
  it.each(SPENDERS)("%s calls the shared predicate", (file) => {
    expect(read(file)).toContain("decisionCanBeApplied(");
  });

  it.each(SPENDERS)("%s does not re-spell the clauses inline", (file) => {
    expect(read(file)).not.toMatch(INLINE);
  });

  /**
   * THE POSITIVE CONTROL FOR THE SCANNER ITSELF — the needle this census hunts, fed to it
   * directly. Without it a typo in `INLINE` would make every case above pass for nothing, which
   * is the measured failure mode of every source-scanning guard in this repository.
   */
  it("the inline-spelling scanner finds a copy when there is one", () => {
    expect(withoutComments("if (e && e.capable && e.status !== \"disabled\") continue;"))
      .toMatch(INLINE);
    expect(withoutComments("if (x.status !== 'disabled' && x.capable) return true;"))
      .toMatch(INLINE);
    // And it does not fire on the shared call, which is what the two cases above assert.
    expect(withoutComments("if (decisionCanBeApplied(e)) continue;")).not.toMatch(INLINE);
  });

  /** And the comment stripper is doing its job: the clause quoted in PROSE is not a copy. */
  it("a clause quoted in a comment is not read as a copy", () => {
    const src = "// e.capable && e.status !== \"disabled\" is what this used to say\nconst a = 1;\n";
    expect(withoutComments(src)).not.toMatch(INLINE);
  });

  const at = (o: Partial<RequestEligibility>): RequestEligibility => ({
    role: "organizer", state: "held", capable: true, status: "active", takeoverPending: false,
    by: { kind: "cloud", name: null, since: null }, ...o,
  });

  it("answers the three states a mailbox can be in", () => {
    expect(decisionCanBeApplied(at({}))).toBe(true);
    // The sole organizer stopped: the holder is not coming back, so nothing applies a decision.
    expect(decisionCanBeApplied(at({ role: "reader", state: "stopped", capable: false }))).toBe(false);
    // A tombstone keeps its stale role column, and a removed mailbox organizes nothing.
    expect(decisionCanBeApplied(at({ status: "disabled" }))).toBe(false);
    // No row at all for this account — a decision cannot land on a mailbox that is not there.
    expect(decisionCanBeApplied(null)).toBe(false);
  });
});
