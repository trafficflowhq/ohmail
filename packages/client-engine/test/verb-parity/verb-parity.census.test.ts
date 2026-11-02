import { describe, expect, it } from "vitest";
import { MUTATION_KINDS } from "@ohmail/client-engine";
import { VERB_MATRIX, coveredScenarios, type VerbEntry } from "./registry.js";

/**
 * THE VERB CENSUS — the half of the parity chain that makes a NEW verb red until it is proven.
 *
 * The chain (INSTANT-ARCH §6.2(e)): `EngineMutation` (the type) → `MUTATION_KINDS` (its runtime
 * census, compile-pinned in src/types.ts both directions, in a file `tsc -b` actually checks) →
 * this registry (every kind classified) → the matrix (three assertions per covered scenario).
 * Each link fails loudly when the next one is missing:
 *
 *   · a new union kind without a MUTATION_KINDS entry  → `pnpm typecheck` red, naming the kind;
 *   · a MUTATION_KINDS entry without a registry entry  → the first test here, naming the kind;
 *   · a covered entry with no scenarios                → the second test (coverage that
 *     asserts nothing is the disabled-survival shape this census exists to forbid);
 *   · a scenario missing any of the three legs         → the third test — `landed` must be a
 *     real function and the pass leg must be a REAL run or a WRITTEN reason, never absent,
 *     never an empty excuse.
 *
 * What this census deliberately cannot see — the runner itself skipping a leg — is covered the
 * way every guard here is covered: by mutation, watched red (the historical-regression re-proofs
 * recorded in the project's design notes re-create the pre-fix defect and show the matrix catching it).
 *
 * ── LEG (d) IS UNCONDITIONAL AND HAS NO REGISTRY FIELD, ON PURPOSE ─────────────────────────
 *
 * *"The verb was on disk before the wire was asked"* is not a property of a SCENARIO — it is a
 * property of `OhmailEngine.mutate`, identical for every kind — so there is nothing per-verb for
 * this census to demand, and an opt-out field would be an invitation to write one. The runner
 * asserts it for all 37 covered scenarios with a vacuity guard in front of it, and it earned its
 * place on the first run: the header-level version of the witness was silently vacuous for
 * `feed_mark_seen`, which sends no Idempotency-Key at all, and the guard caught that rather than
 * passing over it.
 *
 * Watched red the way the rest of this chain is: deferring `putOutbox` until after `dispatch`
 * reddens all 37 at once, which is the kill-loses-the-verb defect stated as an assertion failure.
 */
describe("verb-parity census", () => {
  it("every mutation kind in the vocabulary is classified — no more, no less", () => {
    const classified = Object.keys(VERB_MATRIX).sort();
    expect(classified).toEqual([...MUTATION_KINDS].sort());
  });

  it("a covered verb carries at least one scenario; an excluded verb carries a written reason", () => {
    for (const kind of MUTATION_KINDS) {
      const entry: VerbEntry = VERB_MATRIX[kind];
      if (entry.coverage === "covered") {
        expect(entry.scenarios.length, `"${kind}" is covered but asserts nothing`).toBeGreaterThan(0);
      } else {
        expect(entry.coverage.out.length, `"${kind}" is excluded without a reason`).toBeGreaterThan(40);
        expect(entry.scenarios, `"${kind}" is excluded yet carries scenarios — classify it covered`).toHaveLength(0);
      }
    }
  });

  it("every scenario carries all three legs: a seed, the verb, `landed`, and a pass run or a written reason", () => {
    for (const { kind, scenario } of coveredScenarios()) {
      const at = `${kind} / "${scenario.name}"`;
      expect(typeof scenario.seed, at).toBe("function");
      expect(typeof scenario.mutation, at).toBe("function");
      expect(typeof scenario.landed, `${at} — the survival assertion is missing`).toBe("function");
      // Leg (o): the optimistic oracle is REQUIRED — "landed" reuse, a bespoke function, or a
      // written reason; an absent field would let overlay ≡ echo rot back into hand discipline.
      const opt = scenario.optimistic as unknown;
      expect(opt, `${at} — the optimistic oracle is absent entirely`).toBeDefined();
      if (typeof opt === "object" && opt !== null && "none" in (opt as object)) {
        expect((opt as { none: string }).none.length, `${at} — the optimistic exclusion has no real reason`).toBeGreaterThan(40);
      } else {
        expect(opt === "landed" || typeof opt === "function", `${at} — optimistic must be "landed", a function, or {none}`).toBe(true);
      }
      expect(scenario.pass, `${at} — leg (c) is absent entirely`).toBeDefined();
      if ("none" in scenario.pass) {
        expect(scenario.pass.none.length, `${at} — the worker-pass exclusion has no real reason`).toBeGreaterThan(40);
      } else {
        expect(typeof scenario.pass.run, at).toBe("function");
        expect(scenario.pass.name.length, at).toBeGreaterThan(0);
      }
      if (scenario.landedAfterPass !== undefined) {
        // The override may only STRENGTHEN the post-pass claim on a transforming pass — it must
        // itself be an assertion, and it is meaningless beside a `none` leg.
        expect(typeof scenario.landedAfterPass, at).toBe("function");
        expect("run" in scenario.pass, `${at} — landedAfterPass beside a none-leg disables survival`).toBe(true);
      }
    }
  });

  it("the census counts are stated, so a drift is a diff and not an archaeology", () => {
    const covered = MUTATION_KINDS.filter((k) => VERB_MATRIX[k].coverage === "covered");
    const out = MUTATION_KINDS.filter((k) => VERB_MATRIX[k].coverage !== "covered");
    // 22 → 23 covered and 37 → 39 scenarios for `draft_resolve` (mail 0095): ONE verb, TWO
    // scenarios, because its two outcomes are different writes on both the draft and the ledger
    // row — `arrived` settles the row `sent` and takes the draft out of the list, `not_arrived`
    // settles it `failed` and hands the draft back as an ordinary one. `out` does NOT move: the
    // verb has a route, writes server state and carries an overlay, so "deliberately out" would
    // have been a false sentence in a guard. The two numbers moving by 1 and 2 is the reading —
    // a verb admitted with one arm of a two-armed decision would move them by 1 and 1.
    expect(covered).toHaveLength(23);
    expect(out).toEqual(["draft_accept"]);
    // 39 → 40 (SCREENER-020 item 3): `screener_decide` gained the two-mailbox account-wide
    // scenario — the widened verb's own leg, no new verb, so `covered` stands at 23.
    // 40 → 42: `screener_decide` gained a removed mailbox's letter and a list address's claim.
    expect(coveredScenarios().length).toBe(42);
  });
});
