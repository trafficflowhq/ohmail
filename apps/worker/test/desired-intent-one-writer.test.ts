import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

/**
 * ═══ ONE WRITER FOR THE FILING INTENT ══════════════════════════════════════════════════════
 *
 * Three worker passes wrote the same `folder_state` upsert: desired folder set, observed left
 * alone, `reconcile_status` DERIVED from whether the two agree. The derivation is the invariant —
 * a row that claims `reconciled` while desired ≠ observed is a message the reconciler will never
 * move, filed in the database and not in the mailbox — and it was stated three times, so a fix to
 * one pass would have left two passes writing the old rule.
 *
 * The census refuses a second declaration of the upsert under `apps/worker/src`, read from source
 * with comments and string literals stripped.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "../src");

const FILES = readdirSync(SRC)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ name: f, code: withoutCommentsAndLiterals(readFileSync(join(SRC, f), "utf8")) }));

/** The upsert by its own derivation line — the thing that makes it THIS write and not another. */
const DERIVATION = /reconcileStatus\s*=\s*destination\s*===\s*row\.observedFolder/g;

describe("the filing intent has one writer", () => {
  it("the derivation is written in exactly one file", () => {
    const holders = FILES.filter((f) => (f.code.match(DERIVATION) ?? []).length > 0).map((f) => f.name);
    expect(holders, `written in: ${holders.join(", ") || "(nowhere)"}`).toHaveLength(1);
  });

  it("every pass that files an intent calls the one writer", () => {
    const callers = FILES.filter((f) => /\bupsertDesired\s*\(/.test(f.code)).map((f) => f.name);
    // Measured at the base: ohbox-tidy, rule-retro and the retired auto-apply each carried their own copy.
    expect(callers).toEqual(
      expect.arrayContaining(["ohbox-tidy.ts", "rule-retro.ts"]),
    );
  });

  it("the census can see a planted second copy — it is not passing on a regex that matches nothing", () => {
    const one = FILES.filter((f) => (f.code.match(DERIVATION) ?? []).length > 0);
    expect(one, "the derivation is nowhere — the census reads nothing").toHaveLength(1);
    const planted = [...FILES, { name: "synthetic-copy.ts", code: one[0]!.code }];
    expect(planted.filter((f) => (f.code.match(DERIVATION) ?? []).length > 0)).toHaveLength(2);
  });
});

/**
 * ═══ AND ONE PROJECTION INTO THE SHAPE THE RULES LAYER READS ═══════════════════════════════
 *
 * The passes each built `NormalizedMessage` from their own row type, copies that could drift
 * field by field; the shared projection takes the body as an argument, so it is stated at the call
 * site that chooses it.
 *
 * `packages/services/src/sensitive-rescreen.ts` has a fourth, MEASURED and deliberately left:
 * it is another package, and importing a worker module there would pull the worker's closure
 * into a service the API host loads.
 */
describe("the rules projection has one home in the worker", () => {
  it("is declared once under apps/worker/src", () => {
    const holders = FILES
      .filter((f) => /\bfunction\s+ruleInputOf\s*\(/.test(f.code))
      .map((f) => f.name);
    expect(holders, `declared in: ${holders.join(", ") || "(nowhere)"}`).toEqual(["rule-pass.ts"]);
  });

  it("every pass that projects a row calls it, and names the body it passes", () => {
    const callers = FILES.filter((f) => /\bruleInputOf\s*\(/.test(f.code) && f.name !== "rule-pass.ts");
    expect(callers.map((f) => f.name).sort())
      .toEqual(["gap-catchup.ts", "ohbox-tidy.ts", "rule-retro.ts"]);
  });
});
