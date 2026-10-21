import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * TWO INVARIANTS THE RETRO PASS MUST NOT BREAK, AS TESTS THAT CAN FAIL.
 *
 * Both are about what this pass CALLS rather than what it computes, so both are source scans —
 * no behavioural test can see a code path it never enters, and the dangerous paths here are the
 * ones a future edit would add.
 *
 * ══ 1. IT NEVER OPENS IMAP ═══════════════════════════════════════════════════════════════
 *
 * The "Organize-in-place" invariant: organization lands in real IMAP folders, and the API never opens a connection to
 * apply it — moves defer to the worker through `folder_state` desired-state. The retro pass runs
 * ON the worker and still must not dial, for a second reason: `reconcileFolders`
 * (`apps/worker/src/sync.ts`) holds the mailbox's adapter and its organizer lease, and a bulk
 * mover opening its own connection would be a second organizer for one mailbox — the exact thing
 * `ohmail/_meta`'s lease exists to make impossible.
 *
 * ══ 2. IT ARMS NO OUTBOUND ACTION ════════════════════════════════════════════════════════
 *
 * This is the one worth reading before changing anything here.
 *
 * A rule whose destination is a reject folder is coupled to AUTO-UNSUBSCRIBE. "Apply this
 * domain rule to all previous mail" therefore has a shape where one click could send RFC 8058
 * one-click unsubscribe requests to every list under a domain — outbound, to third parties, on
 * the user's behalf, with no undo. `WORKLIST.md` *"that must be stated in the sheet
 * before it runs, not discovered afterwards."*
 *
 * **Measured, not assumed: it cannot happen today.** `unsubscribe.onScreenOut` has exactly ONE
 * production caller — `screener-service.ts`, after `decide`'s commit, on the reject branch, over
 * the mail that decision re-routed. `sweepScreenedOut` is the function that would turn plain
 * moves-into-Screened into unsubscribe candidates, and it STILL has no production caller. The
 * retro pass calls neither: it writes `folder_state` and a `change_log` move and stops.
 *
 * So the honest answer is that retroactive apply arms nothing, and the sheet must not claim
 * otherwise in either direction — no warning the code cannot justify, and no silence once it can.
 *
 * **THE COUPLING IS THE POINT OF THE SECOND ASSERTION.** The day `sweepScreenedOut` gains a
 * production caller, a retro apply of a domain rule to `ohmail/Screened` becomes a bulk
 * unsubscribe of every sender under that domain, and nothing else in the tree would say so. This
 * test goes red at that moment and makes the decision explicit rather than emergent.
 */

const PASS = fileURLToPath(new URL("../src/rule-retro.ts", import.meta.url));
/**
 * The one-time gate release sweep is the SECOND bulk mover on this worker and is under both
 * invariants for the same reasons — it arms this pass's release licence and writes
 * `folder_state` for contact-only senders, so a dialer added to it would be a second organizer
 * exactly as one added here would be. Named rather than left to the reader: the first file this
 * guard was written for is not the only one it is about any more.
 */
const SWEEP = fileURLToPath(new URL("../src/gate-release.ts", import.meta.url));
/** The gap catch-up is the THIRD: desired state for gap mail, never a move of its own. */
const GAP = fileURLToPath(new URL("../src/gap-catchup.ts", import.meta.url));
const MOVERS: ReadonlyArray<readonly [string, string]> = [
  ["rule-retro.ts", PASS], ["gate-release.ts", SWEEP], ["gap-catchup.ts", GAP],
];
const UNSUBSCRIBE = fileURLToPath(
  new URL("../../../packages/services/src/unsubscribe-service.ts", import.meta.url),
);
const SCREENER = fileURLToPath(
  new URL("../../../packages/services/src/screener-service.ts", import.meta.url),
);

/** Every module specifier a file imports — the import machinery, not the prose. */
function importsOf(file: string): string[] {
  const body = readFileSync(file, "utf8");
  return [...body.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
}

/**
 * THE PASS AND EVERY LOCAL MODULE IT PULLS IN. A relative sibling is not a third party — it is
 * this pass's own code in another file — so the rule has to reach through it, or moving one line
 * into a sibling is how a future edit dodges the import boundary without naming anything forbidden. Each entry
 * carries the file that named the specifier, so a refusal says WHERE.
 */
function packageImportsOf(entry: string): Array<{ file: string; spec: string }> {
  const seen = new Set<string>();
  const out: Array<{ file: string; spec: string }> = [];
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      if (spec.startsWith(".")) stack.push(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
      else out.push({ file: basename(file), spec });
    }
  }
  return out;
}

/** `apps/worker/test/deps.test.ts` forbids the SERVICES package under `apps/worker/src` — it is an
 * API-host concern and is not in the worker's image. Asserted here at the file level too, because
 * it is why these passes can live on the worker rather than becoming operator one-shots. The
 * package specifier is never a literal in this file, deliberately: `deps.test.ts` scans test
 * sources for that exact string without stripping comments. */
const ALLOWED = ["drizzle-orm", "@trafficflow/db", "@trafficflow/core"];

/** The file's relative imports, every package import having been held to {@link ALLOWED}. */
function siblingsOf(file: string, who: string): string[] {
  const out: string[] = [];
  for (const spec of importsOf(file)) {
    if (spec.startsWith(".")) { out.push(spec); continue; }
    const ok = ALLOWED.some((a) => spec === a || spec.startsWith(`${a}/`));
    expect(ok, `${who} imports ${spec}, which is outside db + core`).toBe(true);
  }
  return out;
}

/** Which siblings each mover may reach. A sibling of a sibling is not admitted — see below. The
 * gate release checks an unchecked row before it releases one, through the backfill's own write. */
const SIBLINGS: Record<string, string[]> = {
  "rule-retro.ts": ["./rule-pass.js"],
  "gate-release.ts": ["./sender-check-backfill.js"],
  // And where a look opens its window (RULING-026 lane A): a leaf of db + drizzle, re-exported.
  "gap-catchup.ts": ["./rule-pass.js", "./gap-window.js"],
};

describe.each(MOVERS)("%s opens no IMAP connection", (name, file) => {
  it("names neither imapflow nor an IMAP adapter", () => {
    // `@trafficflow/core/adapters/imap` is the only door to `imapflow` in this workspace, so
    // naming either is the whole violation surface. Matched on the IMPORT rather than on the
    // word, because this file's prose discusses IMAP at length and a guard that a deleted
    // comment satisfies is not a guard.
    for (const { file: from, spec } of packageImportsOf(file)) {
      expect(spec, `${name} imports ${spec} (via ${from})`).not.toMatch(/imapflow/);
      expect(spec, `${name} imports ${spec} (via ${from})`).not.toMatch(/adapters\/imap/);
    }
  });

  it("does not reach the unsubscribe surface at all", () => {
    // The identifiers, not the word — this file's own prose discusses it deliberately.
    const body = readFileSync(file, "utf8");
    expect(body).not.toMatch(/\bonScreenOut\s*\(/);
    expect(body).not.toMatch(/\bsweepScreenedOut\s*\(/);
    expect(body).not.toMatch(/UnsubscribeService/);
  });

  it("imports only the database and the shared library — the no-IMAP rule is satisfied, not dodged", () => {
    // The rule and why the package specifier stays in prose here are on {@link ALLOWED}.
    //
    // A RELATIVE SIBLING IS NOT A PACKAGE, AND IT IS NOT A HOLE EITHER. `./rule-pass.js` is the
    // write two passes share; admitting the specifier alone would let the ban be dodged by one
    // hop, so the sibling's OWN imports are asked the same question and may reach no sibling of
    // their own. The `MOVERS really do reach one` case below keeps this from admitting nothing.
    expect(siblingsOf(file, name)).toEqual(SIBLINGS[name] ?? []);
  });
});

describe("the sibling hop is closed, not waved through", () => {
  it("the admitted siblings exist, satisfy the same rule and reach no sibling of their own", () => {
    const named = Object.entries(SIBLINGS).flatMap(([who, rels]) => rels.map((r) => [who, r] as const));
    // Admitting nothing would make the rule above vacuous, so the list is asserted non-empty.
    expect(named.length).toBeGreaterThan(0);
    for (const [who, rel] of named) {
      const target = fileURLToPath(new URL(rel.replace(/\.js$/, ".ts"), pathToFileURL(PASS)));
      expect(siblingsOf(target, `${who} -> ${rel}`), `${rel} reaches a sibling of its own`).toEqual([]);
    }
  });
});

describe("the retro pass arms no outbound action, and the coupling is watched", () => {
  it("`sweepScreenedOut` STILL has no production caller — the day it does, decide about this pass", () => {
    /**
     * If this fails, someone has wired the sweep. Read the header of this file before
     * "fixing" it: at that moment a retroactive apply of a domain rule to a reject folder becomes
     * a BULK UNSUBSCRIBE of every sender under the domain, and the sheet's pre-click disclosure
     * (`SenderMenu.tsx`, `ScreeningPlan.unsubscribes`) is computed from the DECIDE path only, so
     * it will say nothing. Either widen that disclosure to cover retroactive applies, or make the
     * retro pass exclude reject destinations. Do not just delete this assertion.
     */
    const definition = /async\s+sweepScreenedOut\s*\(/;
    expect(readFileSync(UNSUBSCRIBE, "utf8"), "sweepScreenedOut has been renamed or removed — " +
      "this guard is now watching nothing").toMatch(definition);

    // Its only mention outside its own module is the one that would arm it.
    const screener = readFileSync(SCREENER, "utf8");
    expect(screener, "screener-service now calls sweepScreenedOut").not.toMatch(/sweepScreenedOut\s*\(/);
  });

  it("`onScreenOut`'s single production caller is still the decide path, and it is not us", () => {
    const screener = readFileSync(SCREENER, "utf8");
    // One call, in `decide`, after the commit, on the reject branch. This assertion is what makes
    // `ScreeningPlan.unsubscribes`'s "true exactly when the DECIDE path runs" a checked claim
    // rather than a remembered one.
    const calls = [...screener.matchAll(/unsubscribe\.onScreenOut\s*\(/g)];
    expect(calls).toHaveLength(1);
  });
});
