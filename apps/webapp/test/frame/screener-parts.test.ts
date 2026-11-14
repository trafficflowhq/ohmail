/**
 * TODAY'S CONTROLS FIT THE SCREENER'S PORTS, before the seating step hands them in: the web shell's Junk window (its
 * offer to move ohmail's kept spam and its list of that spam aside, which the Screener does not draw), its suggestion
 * run's control, and the reader's parts a held letter is drawn with. Held at the type level by the type checker that
 * reads the web's tests (`tsc -p apps/webapp/tsconfig.json`): a member a port comes to require that today's control
 * lacks is red there. And one Junk row is named alike on both sides, so a selection or a cached text never moves to
 * another letter when the seat hands the window in.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ReaderParts } from "@ohmail/app/reader";
import type { HeldParts, ScreenerJunk, ScreenerSuggestControl } from "@ohmail/app/screener";
import { junkKey } from "@ohmail/app-logic/screener";
import { junkKeyOf, type JunkWindowControl } from "../../app/shell/junk-window";
import type { SuggestBatchControl } from "../../app/shell/screener-suggest";

describe("today's controls and the Screener's ports", () => {
  it("today's Junk window, its sweep and its kept list aside, is a ScreenerJunk", () => {
    expectTypeOf<Omit<JunkWindowControl, "sweep" | "held">>().toMatchTypeOf<ScreenerJunk>();
  });

  it("today's suggestion run is a ScreenerSuggestControl", () => {
    expectTypeOf<SuggestBatchControl>().toMatchTypeOf<ScreenerSuggestControl>();
  });

  it("the parts the shell hands the reader draw a held letter", () => {
    expectTypeOf<ReaderParts>().toMatchTypeOf<HeldParts>();
  });

  it("a Junk row has one name on both sides, its folder's epoch in it", () => {
    const rows = [
      { mailboxId: "mb-1", uidValidity: "7", uid: 12 },
      { mailboxId: "mb-1", uidValidity: "8", uid: 12 },
      { mailboxId: "mb-2", uidValidity: "7", uid: 12 },
    ];
    expect(rows.map(junkKey)).toEqual(rows.map(junkKeyOf));
    expect(new Set(rows.map(junkKey)).size).toBe(3);
  });
});
