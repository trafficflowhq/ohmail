import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
/* The one-pass scanner — blanking comments and literals rather than matching text, so a line
   that merely NAMES `planScreeningChange` in a docblock is not a hit. */
import * as scan from "../../../scripts/lib/source-scan.mjs";
import { sliceOfDeclaration } from "./source-anchor";

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
/** The letter's body, moved out of the web app: read with it, keyed `letter-body/…`. */
const BODY = join(HERE, "..", "..", "..", "packages", "letter-body", "src");
const MOUNTED = join(HERE, "..", "..", "..", "packages", "app", "src");
const NEEDLE = "planScreeningChange(";
/** The press's routing door in the new shell. */
const PRESS_DOOR = join(LOGIC, "press", "move-to-place.ts");

/**
 * The plans that do NOT open a window, and why each one may not. None of them is a press whose
 * routing a person could still be looking at and want back, which is the property the window
 * defends.
 */
const PINNED: ReadonlyArray<readonly [string, number, string]> = [
  ["shell/AppShell.tsx", 0,
   "the composition root builds no plans"],
  ["components/sender-menu/SenderMenu.tsx", 2,
   "the sheet's PREVIEW and its unsubscribe disclosure — neither dispatches anything; the count "
   + "on screen and the work that happens come from one function evaluated twice, which is the "
   + "whole reason the sheet calls it at all"],
  ["app-logic/screener/screener-state.ts", 1,
   "the Screener's own commit, which is ALREADY inside a delayed-commit window — its decision is "
   + "held for the same UNDO_MS and this plan is what that window sends. A second window here "
   + "would delay one press twice and journal one decision in two places"],
  ["(product)/mailbox/WebContactScreening.tsx", 2,
   "takes over `screeningForecast` and `changeScreening` from the retired `shell-verbs.ts`: "
   + "one read-only forecast and one plan rebuilt after confirming; rule writes that take the "
   + "window path are handed to the routing window"],
  ["app-logic/press/contact-screening.ts", 1,
   "`screenContact` uses one plan for the shared card's filing forecast and confirmed press, "
   + "then hands rule writes that take the window path "
   + "to the routing window"],
  ["app-logic/press/routing-undo.ts", 1,
   "the window's own re-plan at the commit — the plan this whole census is about, read from the "
   + "mirror at the moment it is finally sent"],
  ["app-logic/press/move-to-place.ts", 1,
   "`planMoveToPlace` builds the press that `fileThroughRouting` holds; this shared call took over "
   + "the duplicate `planMoveToPlace` call in the retired `shell-verbs.ts`"],
  ["app-logic/press/selection-screening.ts", 1,
   "`planBulkScreening` takes over the duplicate bulk call in the retired `shell-verbs.ts`; "
   + "`makeRule: false` gives its plans no rule half to hold"],
];

/**
 * Pin the combined total independently of the rows so moving a site cannot hide a new call.
 * The retired `shell-verbs.ts` counted duplicate Move and bulk plans alongside the shared
 * `planMoveToPlace` and `planBulkScreening` calls. Those shared calls remain. Its sender forecast
 * and confirm calls moved to `WebContactScreening`; the shared card adds one `screenContact` plan.
 * Keep the retained sender sheet's calls counted until its source is removed.
 */
const PINNED_TOTAL = 9;

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
  for (const [root, prefix] of [[APP, ""], [LOGIC, "app-logic/"], [BODY, "letter-body/"], [MOUNTED, "app/"]] as const) for (const file of tsFiles(root)) {
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
    /* RE-POINTED TO THE NEW SHELL (D (3)): the door is the press's (`press/move-to-place.ts`), a function there. */
    const blanked = scan.withoutCommentsAndLiterals(readFileSync(PRESS_DOOR, "utf8"));
    const from = blanked.indexOf("function fileThroughRouting(");
    expect(from, "the routing door is not declared under that name any more").toBeGreaterThan(-1);
    const body = sliceOfDeclaration(blanked, "fileThroughRouting");
    expect(body.length, "the door's slice is too short to be its body").toBeGreaterThan(600);
    expect(body, "the door does not open a window").toContain("routing.hold(");
    /* THE MAIL IS DISPATCHED AND THE RULES ARE NOT — both halves named, so a door that sent
       everything and one that sent nothing are each refused. */
    expect(body).toContain("for (const mu of mail)");
    expect(body, "the door dispatched the rules it is supposed to be holding")
      .not.toContain("for (const mu of rules)");

    const web = readFileSync(join(APP, "(product)/mailbox/WebContactScreening.tsx"), "utf8");
    const shared = readFileSync(join(LOGIC, "press/contact-screening.ts"), "utf8");
    for (const [source, branch] of [
      [web, /if \(path !== "window"\)/],
      [shared, /if \(screeningPath\(sender, scope, makeRule\) !== "window" \|\| plan\.ruleMutations\.length === 0 \|\| input\.demo\)/],
    ] as const) {
      expect(source).toMatch(branch);
      expect(source).toMatch(/return;\s*\}\s+(?:(?!dispatchScreeningChange)[\s\S])*?press\.routing\.holdScreen\(/);
    }
  });

  it("the offer is the ENGINE's classification, read in the door", () => {
    /* A surface that decided for itself whether a routing press is undoable is a second opinion
       that can disagree with `UNDO_CLASS` — the drift the one table exists to make impossible. */
    const src = readFileSync(PRESS_DOOR, "utf8");
    expect(src).toMatch(/UNDO_CLASS\.routing_plan !== "window"/);
  });
});
