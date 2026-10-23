import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lineOf, withoutComments, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

/* @reads: apps/webapp/app/shell/sync-scheduler.ts apps/mobile/src/net/drain.ts
   The two cadences that poll what waits, read by path so a landing selects this file when they move. */

/**
 * THE ENGINE OWNS NO TIMERS (`apps/webapp/app/shell/engine.tsx`'s claim, VERIFY-026 HIGH 3). A timer
 * inside the engine outlives every surface that drops it: nothing outside can stop it, and it keeps
 * the mirror and its reads alive. Cadence belongs to the surfaces (the web scheduler's tick, the
 * phone's drain round). Read in one pass with comments and literals blanked; the admitted timers are
 * deadlines on one request each (the replay's, the hold's ceiling, the drain's belt), each cleared
 * when its race settles. Planted fixtures prove both directions.
 */
const ENGINE = fileURLToPath(new URL("../src/engine.ts", import.meta.url));
const CADENCES = ["../../../apps/webapp/app/shell/sync-scheduler.ts", "../../../apps/mobile/src/net/drain.ts"]
  .map((rel) => fileURLToPath(new URL(rel, import.meta.url)));
/** Admitted timers, by the text on their line: why each cannot outlive its own await. */
const ADMITTED: Record<string, string> = {
  "timer = setTimeout(() => { timedOut = true; resolve({ r: null }); }, this.replayDeadlineMs);":
    "the replay deadline: raced against one replay and cleared in the same function when it settles",
  "const ceilingTimer = setTimeout(() => end(), this.holdCeilingMs);":
    "the hold's ceiling: raced against one write's request and cleared in the same function when it settles",
  "timer = setTimeout(() => reject(noAnswerWithin(this.drainCeilingMs)), this.drainCeilingMs);":
    "the drain's belt: raced against one page read and cleared in the same function when it settles",
};

function timersIn(src: string): string[] {
  const code = withoutCommentsAndLiterals(src);
  const lines = src.split("\n");
  const out: string[] = [];
  for (const m of code.matchAll(/\b(setTimeout|setInterval)\s*\(/g)) out.push(lines[lineOf(src, m.index!) - 1]!.trim());
  return out;
}
const refused = (src: string) => timersIn(src).filter((l) => !(l in ADMITTED));

describe("the engine owns no timers", () => {
  it("finds a planted timer, admits the replay deadline, and reads a timer in prose as nothing (controls)", () => {
    expect(refused("class E { arm() { const t = setTimeout(() => this.read(), 30_000); } }")).toHaveLength(1);
    expect(refused("setInterval(poll, 1000);")).toHaveLength(1);
    expect(refused("        timer = setTimeout(() => { timedOut = true; resolve({ r: null }); }, this.replayDeadlineMs);")).toEqual([]);
    expect(refused("// a setTimeout( in a comment\nconst s = \"setInterval(\";")).toEqual([]);
  });

  it("engine.ts holds no timer but the admitted ones, and every admitted one still exists", () => {
    const found = timersIn(readFileSync(ENGINE, "utf8"));
    expect(found.filter((l) => !(l in ADMITTED))).toEqual([]);
    expect(Object.keys(ADMITTED).filter((k) => !found.includes(k)), "an admitted timer is gone: drop its row").toEqual([]);
  });

  it("…and the cadence that replaces one is wired on both surfaces: each calls the poll in code", () => {
    const calls = (src: string) => [...withoutComments(src).matchAll(/\.pollWaitingOnOrganizer\?\.\(\)/g)].length;
    expect(calls("// engine.pollWaitingOnOrganizer?.()\n"), "a call in prose counted").toBe(0);
    for (const f of CADENCES) expect(calls(readFileSync(f, "utf8")), f).toBeGreaterThan(0);
  });
});
