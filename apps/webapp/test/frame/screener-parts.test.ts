import { describe, expect, expectTypeOf, it } from "vitest";
import type { ReaderParts } from "@ohmail/app/reader";
import type { HeldParts, ScreenerJunk, ScreenerSuggestControl } from "@ohmail/app/screener";
import { junkKey, type ScreenerLive } from "@ohmail/app-logic/screener";
import { junkKeyOf } from "@ohmail/app-logic/screener/junk-window";

describe("the live controls and the Screener's ports", () => {
  it("the live Junk window, its sweep and its kept list aside, is a ScreenerJunk", () => {
    expectTypeOf<Omit<NonNullable<ScreenerLive["junk"]>, "sweep" | "held">>().toMatchTypeOf<ScreenerJunk>();
  });

  it("the live suggestion run is a ScreenerSuggestControl", () => {
    expectTypeOf<NonNullable<ScreenerLive["suggest"]>>().toMatchTypeOf<ScreenerSuggestControl>();
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
