import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
/* The one-pass scanner — blanking comments and literals rather than matching text, so a line
   that merely NAMES `planScreeningChange` in a docblock is not a hit. */
import * as scan from "../../../scripts/lib/source-scan.mjs";
import { shellFrameOf } from "./source-anchor";

/**
 * ═══ EVERY SCREENING PLAN GOES THROUGH THE WINDOW, OR IS PINNED WITH ITS REASON ═════════════
 *
 * `planScreeningChange` builds a routing press: a rule written or retargeted, sometimes a
 * Screener decision, and a capped pass over mail already filed. The rule half has no wire
 * inverse, so a press that dispatches it straight away can never be taken back. The plans a
 * person presses now ride a delayed commit; the ones that do not are here with their reasons.
 */
/**
 * EQUALITY AND NOT A CEILING: a lane that takes one of these through the window lowers its pin
 * in the same commit, and a new site is refused by name. The count is per SITE and not per file,
 * because two calls in one file can be two different decisions — `SenderMenu` is that pair.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const APP = join(HERE, "..", "app");
/** The behaviour moved out of the shell: read with it, keyed `app-logic/…`. */
const LOGIC = join(HERE, "..", "..", "..", "packages", "app-logic", "src");
const NEEDLE = "planScreeningChange(";

/**
 * The plans that do NOT open a window, and why each one may not. None of them is a press whose
 * routing a person could still be looking at and want back, which is the property the window
 * defends.
 */
const PINNED: ReadonlyArray<readonly [string, number, string]> = [
  ["shell/SenderMenu.tsx", 2,
   "the sheet's PREVIEW and its unsubscribe disclosure — neither dispatches anything; the count "
   + "on screen and the work that happens come from one function evaluated twice, which is the "
   + "whole reason the sheet calls it at all"],
  ["shell/screener-state.ts", 1,
   "the Screener's own commit, which is ALREADY inside a delayed-commit window — its decision is "
   + "held for the same UNDO_MS and this plan is what that window sends. A second window here "
   + "would delay one press twice and journal one decision in two places"],
  ["shell/AppShell.tsx", 0,
   "none left: all three went with the verbs (ARCH-022). The row is KEPT at zero so a plan "
   + "built back in the composition root is refused by this count rather than needing a new row"],
  ["shell/shell-verbs.ts", 4,
   "the sender sheet's `changeScreening` (an address press past the gate IS held, as a v2 intent; "
   + "a domain press and a Screener decision go at once — a residual line on the row names it), "
   + "`planMoveToPlace` (which BUILDS the press the window then holds), `planBulkScreening` "
   + "(`makeRule: false`, so its plans have no rule half to hold at all) and `screeningForecast` "
   + "(the step's preview of the press, which dispatches nothing)"],
  ["app-logic/press/routing-undo.ts", 1,
   "the window's own re-plan at the commit — the plan this whole census is about, read from the "
   + "mirror at the moment it is finally sent"],
];

/**
 * THE TOTAL, PINNED APART FROM THE ROWS. The shell split hands a count from one frame to
 * another; both rows move together while the sum quietly grows, which is a new unheld plan
 * arriving under cover of a refactor. Eight is the reading (the sheet's forecast raised it) — a
 * row that falls hands its share to a named row, never to nobody.
 */
const PINNED_TOTAL = 8;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function sites(): Map<string, number> {
  const counted = new Map<string, number>();
  for (const [root, prefix] of [[APP, ""], [LOGIC, "app-logic/"]] as const) for (const file of tsFiles(root)) {
    const blanked = scan.withoutCommentsAndLiterals(readFileSync(file, "utf8"));
    /* The DEFINITION is not a call site: it is the only occurrence followed by a parameter list
       on the next line, and it lives in the planner's own file. */
    const hits = blanked.split(NEEDLE).length - 1
      - (file.endsWith("sender-screening.ts") ? 1 : 0);
    if (hits > 0) counted.set(prefix + relative(root, file).split("\\").join("/"), hits);
  }
  return counted;
}

describe("every screening plan is held, or pinned with the reason it cannot be", () => {
  it("has no unpinned site building a screening plan", () => {
    const counted = sites();
    const pinned = new Map(PINNED.map(([rel, n]) => [rel, n] as const));
    const unpinned = [...counted.keys()].filter((rel) => !pinned.has(rel));
    expect(unpinned, "a NEW screening plan — take it through the routing window, or pin it here "
      + "with the reason its routing cannot be taken back").toEqual([]);
    const moved = [...pinned.entries()]
      .filter(([rel, n]) => (counted.get(rel) ?? 0) !== n)
      .map(([rel, n]) => `${rel}: pinned ${n}, found ${counted.get(rel) ?? 0}`);
    expect(moved, "the count moved: a plan taken through the window lowers its pin in the same "
      + "commit, and a new one is refused above").toEqual([]);
    expect(PINNED.reduce((n, [, count]) => n + count, 0),
      "the pinned rows no longer sum to the census's own total — a split moved a count and some "
      + "of it went missing, or a row was raised without another falling").toBe(PINNED_TOTAL);
  });

  it("the press door holds the plan rather than dispatching it", () => {
    /* THE FRAME THAT DECLARES THE DOOR, from the manifest: the verbs left `AppShell.tsx` at
       ARCH-022 and `shellFrameOf` refuses both zero hits and two, so the door cannot be read
       off a frame where the name means something else. */
    const blanked = scan.withoutCommentsAndLiterals(shellFrameOf("fileThroughRouting").source);
    const from = blanked.indexOf("const fileThroughRouting");
    expect(from, "the routing door is not declared under that name any more").toBeGreaterThan(-1);
    const body = blanked.slice(from, blanked.indexOf("const moveToPlace", from));
    expect(body.length, "the door's slice is too short to be its body").toBeGreaterThan(600);
    expect(body, "the door does not open a window").toContain("routing.hold(");
    /* THE MAIL IS DISPATCHED AND THE RULES ARE NOT — both halves named, so a door that sent
       everything and one that sent nothing are each refused. */
    expect(body).toContain("for (const mu of mail)");
    expect(body, "the door dispatched the rules it is supposed to be holding")
      .not.toContain("for (const mu of rules)");
  });

  it("the offer is the ENGINE's classification, read in the door", () => {
    /* A surface that decided for itself whether a routing press is undoable is a second opinion
       that can disagree with `UNDO_CLASS` — the drift the one table exists to make impossible. */
    const src = shellFrameOf("fileThroughRouting").source;
    expect(src).toMatch(/UNDO_CLASS\.routing_plan !== "window"/);
  });
});
