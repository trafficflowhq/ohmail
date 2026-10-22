import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
/* The one-pass scanner — blanking comments and literals rather than matching text, so the line
   in `screener-state.ts` that QUOTES `void engine.mutate(…)` inside a comment is not a hit. */
import * as scan from "../../../scripts/lib/source-scan.mjs";
/* The declaration's own slice, by NAME. `anchor-census.test.ts` refuses a literal that names a
   declaration by the hook it is declared with, and correctly: such a literal goes green against
   an EMPTY slice the moment the declaration is reworded. This throws `anchor not found`. */
import { shellFrameOf, sliceOfDeclaration } from "./source-anchor";

/**
 * ═══ THE SHELL'S ACTION HANDLERS DISPATCH THROUGH THE SEAM, AND NOTHING ELSE ════════════════
 *
 * A press reported from anything other than its answer is the standing defect this census
 * exists to keep closed: `void engine.mutate(…)` throws the verdict away, so the success
 * sentence stands over mail the service refused and the engine rolled back. Every press the
 * shell's action handlers make now goes through `mutateAndReport` / `mutateSetAndReport`.
 *
 * TWO PINS, BOTH ONE-WAY:
 *  1. ZERO bare dispatches inside the shell's own action handlers, each named and sliced by its
 *     own declaration — a renamed handler throws `anchor not found` rather than quietly
 *     measuring an empty slice.
 *  2. The REMAINDER, per file, each with a reason. Equality rather than a ceiling: a lane that
 *     takes one of these through the seam lowers the pin in the same commit, and one that adds a
 *     bare dispatch is refused by name.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const APP = join(HERE, "..", "app");
const NEEDLE = "void engine.mutate(";

/**
 * The bare dispatches that remain, and why each is not this census's subject. None of them raises
 * a success sentence over a verdict it discarded, which is the property the seam defends.
 */
const REMAINDER: ReadonlyArray<readonly [string, number, string]> = [
  ["shell/screener-state.ts", 5,
   "the Screener's own state machine: two of these read the result and refuse the row "
   + "(`refuse`, `refuseRelease`); the `mark_seen` fan-out over already-filed mail is documented "
   + "unwatched on purpose — the decision has landed and only a seen flag can be lost; and the "
   + "card's INBOX letters, moved by id only once its decide stands, whose sentence is the decide's "
   + "own: a refused or skipped move leaves its letter and is not the decision's status"],
  ["shell/mail-send.ts", 1,
   "a settled reply's one after-effect — clearing the answered message's Answer Later. Nothing is "
   + "claimed about it: the sentence the person reads is the send's own"],
  ["shell/AppShell.tsx", 0,
   "none left: the last one, the subject rule's move half, went with the verbs (ARCH-022). The "
   + "row is KEPT at zero so a dispatch written back beside the JSX is refused by this count"],
  ["shell/shell-verbs.ts", 1,
   "the subject rule's move half, whose sentence comes from the awaited RULE — the same one, "
   + "moved out of `AppShell.tsx` with the screening and tag verbs (ARCH-022)"],
  ["shell/shell-compose.ts", 6,
   "the six draft verbs, five of which read `res.status` and speak from it — the five moved out of "
   + "`AppShell.tsx` with the compose and draft verbs (ARCH-022), and `sendAgain`, whose answer is "
   + "the message opening with Send live on `confirmed` and a named toast on anything else; it "
   + "raises no success sentence a discarded verdict could stand over"],
  ["shell/shell-open-state.ts", 3,
   "the three seen-batchers, which are glance marks with no sentence to make false — the same "
   + "three, moved out of `AppShell.tsx` with the open state (ARCH-022)"],
  ["shell/folder-verbs.ts", 1,
   "the folder-op notice's dismissal: it raises no sentence at all, and its three siblings in the "
   + "same object already speak only on `rolled_back`"],
  ["views/ComposeView.tsx", 1,
   "`draft_accept` beside taking a draft into the form — the form filling IS the confirmation"],
];

/**
 * THE TOTAL, PINNED APART FROM THE ROWS. A shell module split hands a count from one row to
 * another, and both rows move together while the sum quietly grows — which is a new bare dispatch
 * arriving under cover of a refactor. Eighteen is the reading (the plain reply's pin spend went,
 * SEND-IS-NOT-DONE); a row that falls hands its share
 * to a named row, never to nobody.
 */
const REMAINDER_TOTAL = 18;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every bare dispatch in a file, by 1-based line, over source with comments and strings blanked. */
function bareIn(text: string): number[] {
  const blanked = scan.withoutCommentsAndLiterals(text);
  const at: number[] = [];
  for (let i = blanked.indexOf(NEEDLE); i >= 0; i = blanked.indexOf(NEEDLE, i + 1)) {
    at.push(scan.lineOf(blanked, i));
  }
  return at;
}

describe("the shell's dispatch seam", () => {
  /**
   * The handlers a press reaches the engine through, named one by one. `moveToPlace` and
   * `planMoveToPlace` are here too: they dispatch through `dispatchScreeningChange`, which awaits
   * its own outcome, and a bare dispatch appearing in them would be the same defect.
   */
  const HANDLERS = [
    "markSeen", "toggleTag", "bulkToggleTag", "createTag", "createTagAlone", "renameTag",
    "deleteTag", "recolorTag", "planMoveToPlace", "moveToPlace", "onMessageAction",
    "onBulkAction", "onBulkScreen",
  ] as const;

  it("has no bare `void engine.mutate(` in the shell's action handlers", () => {
    const offenders: string[] = [];
    for (const name of HANDLERS) {
      /* THE FRAME THAT DECLARES IT, from the manifest: the handlers sit in more than one shell
         frame since ARCH-022 (`markSeen` is the open state's), and `shellFrameOf` refuses both
         zero hits and two — a handler read off the wrong frame is the defect, not a pass.
         THROWS when a handler is renamed rather than measuring nothing — the whole reason this
         is a slice by name and not an index into the file. */
      const blanked = scan.withoutCommentsAndLiterals(shellFrameOf(name).source);
      const slice = sliceOfDeclaration(blanked, name);
      const hits = slice.split(NEEDLE).length - 1;
      if (hits > 0) offenders.push(`${name}: ${hits}`);
    }
    expect(offenders, "a press in the shell's action handlers throws its verdict away again")
      .toEqual([]);
  });

  it("pins the remainder, one reason each, and refuses a new bare dispatch", () => {
    const counted = new Map<string, number>();
    for (const file of tsFiles(APP)) {
      const hits = bareIn(readFileSync(file, "utf8"));
      if (hits.length > 0) counted.set(relative(APP, file).split("\\").join("/"), hits.length);
    }
    const pinned = new Map(REMAINDER.map(([rel, n]) => [rel, n] as const));
    const unpinned = [...counted.keys()].filter((rel) => !pinned.has(rel));
    expect(unpinned, "a NEW bare `void engine.mutate(` — take it through the seam, or pin it here "
      + "with the reason its verdict may be discarded").toEqual([]);
    const moved = [...pinned.entries()]
      .filter(([rel, n]) => (counted.get(rel) ?? 0) !== n)
      .map(([rel, n]) => `${rel}: pinned ${n}, found ${counted.get(rel) ?? 0}`);
    expect(moved, "the count moved: a dispatch taken through the seam lowers its pin in the same "
      + "commit, and a new one is refused above").toEqual([]);
    expect(REMAINDER.reduce((n, [, count]) => n + count, 0),
      "the pinned rows no longer sum to the census's own total — a split moved a count and some "
      + "of it went missing, or a row was raised without another falling").toBe(REMAINDER_TOTAL);
  });
});
