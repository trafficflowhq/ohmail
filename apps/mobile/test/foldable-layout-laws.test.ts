/**
 * THE LAYOUT LAWS THAT MAKE A FOLDABLE'S NARROW WINDOWS FIT — each pure, driven at the window
 * widths of a 1080-px-wide cover screen at 420 / 480 / 560 dpi (404 / 353 / 303 dp) and the inner
 * screen's (821 / 719 / 616 dp). The dock folds destinations into More instead of clipping; the
 * bar's floor takes icon faces instead of running past its capsule; the doorbell draws the faces
 * its capsule has room for; a segmented control changes face instead of cutting a label; a window
 * narrower than a list and a reader side by side is one pane; and a sheet or composer open on the
 * reader holds the fold/unfold move until it closes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BAR_GAP, BAR_PILL_CHROME, DESTINATION_FOLD_ORDER, ICON_FACE, barAdmitted, barFloorFaces, dockFold, dockNeed,
  railDestinationFixed, railFold,
} from "../src/ui/glass/fold";
import { DOORBELL_MAX, doorbellFaces, doorbellMax } from "../src/ui/doorbell-stack";
import { SEGMENT_PAD, segmentFace } from "../src/ui/segment-face";
import { ANDROID_TWO_PANE_MIN, derivePosture } from "../src/ui/posture/derive";
import { RAIL_W, readerBarClearance, screenRailClearance } from "../src/ui/scaffold/plan";
import { holdReader, readerHeldNow, subscribeReaderHeld } from "../src/ui/reader-held";

const ROW = ["index", "screener", "reads", "receipts", "more"];
const COVER = [404, 353, 303] as const;

describe("the dock folds; nothing clips", () => {
  it("need(k) is the ruled arithmetic: 24 + (44k + 2(k−1) + 8) + 8 + 98", () => {
    for (const k of [1, 3, 5]) expect(dockNeed(k)).toBe(24 + (44 * k + 2 * (k - 1) + 8) + 8 + 98);
  });

  it("at every cover width the row fits its room, and every folded destination is in the fold order", () => {
    for (const room of [...COVER, 280]) {
      const { kept, folded } = dockFold(ROW, room);
      expect(dockNeed(kept.length), `${room} dp`).toBeLessThanOrEqual(room);
      expect([...kept, ...folded].sort()).toEqual([...ROW].sort());
      for (const id of folded) expect(DESTINATION_FOLD_ORDER as readonly string[]).toContain(id);
      expect(kept, "More never folds").toContain("more");
    }
  });

  it("folds from the tail of the ruled order: Receipts, then News, then the Screener", () => {
    expect(dockFold(ROW, dockNeed(5)).folded).toEqual([]);
    expect(dockFold(ROW, dockNeed(5) - 1).folded).toEqual(["receipts"]);
    expect(dockFold(ROW, dockNeed(4) - 1).folded).toEqual(["receipts", "reads"]);
    expect(dockFold(ROW, dockNeed(3) - 1).folded).toEqual(["receipts", "reads", "screener"]);
  });

  it("an unmeasured room keeps the whole row", () => {
    expect(dockFold(ROW, null)).toEqual({ kept: ROW, folded: [] });
  });
});

describe("the bar's floor takes icon faces before it overruns", () => {
  const widths = { __reply: 96, fwd: 104, __read: 118, __more: 44, later: 70 };
  const floorNeed = (w: Record<string, number>) =>
    w.__reply! + BAR_GAP + w.fwd! + BAR_GAP + w.__read! + BAR_GAP + w.__more! + BAR_PILL_CHROME;

  it("with room the worded floor stands", () => {
    const f = barFloorFaces({ widths, room: 600, reply: true, readSwitch: true, floor: ["fwd"] });
    expect(f).toEqual({ widths, readIcon: false, floorIcon: false });
  });

  it("the read switch takes its icon first, then Forward, and the floor then fits", () => {
    const readOnly = floorNeed(widths) - widths.__read + ICON_FACE;
    const a = barFloorFaces({ widths, room: readOnly, reply: true, readSwitch: true, floor: ["fwd"] });
    expect([a.readIcon, a.floorIcon]).toEqual([true, false]);
    const b = barFloorFaces({ widths, room: readOnly - 1, reply: true, readSwitch: true, floor: ["fwd"] });
    expect([b.readIcon, b.floorIcon]).toEqual([true, true]);
    expect(floorNeed(b.widths as Record<string, number>)).toBeLessThan(readOnly);
  });

  it("the floor pays as fixed cost, so a floor verb is never admitted or folded", () => {
    const verbs = [{ id: "fwd" }, { id: "later" }];
    const roomForLater = floorNeed(widths) + BAR_GAP + widths.later;
    expect(barAdmitted({ verbs, widths, reply: true, readSwitch: true, room: roomForLater, floor: ["fwd"] })).toBe(1);
    expect(barAdmitted({ verbs, widths, reply: true, readSwitch: true, room: roomForLater - 1, floor: ["fwd"] })).toBe(0);
  });

  it("before a measurement nothing is an icon", () => {
    expect(barFloorFaces({ widths: null, room: 300, reply: true, readSwitch: true, floor: ["fwd"] }).floorIcon).toBe(false);
  });
});

describe("the doorbell draws the faces its capsule has room for", () => {
  it("four from 360, three from 300, none below; an unmeasured capsule draws four", () => {
    expect([doorbellMax(384), doorbellMax(360), doorbellMax(359), doorbellMax(333), doorbellMax(300)]).toEqual([4, 4, 3, 3, 3]);
    expect([doorbellMax(299), doorbellMax(283), doorbellMax(260)]).toEqual([0, 0, 0]);
    expect(doorbellMax(0)).toBe(DOORBELL_MAX);
  });

  it("at large text the sentence takes the room: the width counts in text sizes, not points", () => {
    // Android at font 2.0 on a 360 dp phone: the capsule is about 340 wide, and four faces cut the sentence.
    expect([doorbellMax(340, 2), doorbellMax(384, 1.3), doorbellMax(384, 1.1)]).toEqual([0, 0, 3]);
    expect([doorbellMax(340, 1), doorbellMax(340)]).toEqual([3, 3]);
    expect(doorbellMax(0, 2)).toBe(DOORBELL_MAX);
  });

  it("with no faces the count is the sentence's alone — no stack and no chip is asked for", () => {
    const stack = doorbellFaces(["A", "B", "C"], doorbellMax(283));
    expect(stack.shown).toEqual([]);
  });
});

describe("a segmented control changes face instead of cutting a label", () => {
  // The Screener's three shelves at the 560-dpi cover (277 dp): each label with its count.
  const screener = [72, 81, 78];
  it("equal while the widest fits an equal share", () => {
    expect(segmentFace(378, [60, 70, 66])).toBe("equal");
    const n = 3;
    const share = (w: number) => (w - 6 - 2 * (n - 1)) / n;
    expect(Math.max(60, 70, 66) + SEGMENT_PAD).toBeLessThanOrEqual(share(378));
  });
  it("proportional while every segment fits at its own width", () => {
    expect(segmentFace(300, [110, 60, 70])).toBe("proportional");
    expect(segmentFace(297, [110, 60, 70]), "one dp short of the sum is stacked").toBe("stacked");
  });
  it("stacked once only the labels fit", () => {
    expect(segmentFace(277, screener)).toBe("stacked");
  });
  it("an unmeasured control keeps the equal face", () => {
    expect(segmentFace(0, screener)).toBe("equal");
    expect(segmentFace(277, [72, 0, 78])).toBe("equal");
  });
});

describe("a window too narrow for a list and a reader is one pane on Android", () => {
  const at = (width: number, height: number) =>
    derivePosture({ platform: "android", width, height, folds: null, hasFold: true });
  it("the inner screen at 616 and 679 dp is one pane; at 719 and 821 two", () => {
    expect(at(616, 679).panes).toBe(1);
    expect(at(679, 616).panes).toBe(1);
    expect(at(ANDROID_TWO_PANE_MIN - 1, 800).panes).toBe(1);
    expect(at(719, 792).panes).toBe(2);
    expect(at(821, 905).panes).toBe(2);
  });
  it("iOS keeps its own rule", () => {
    expect(derivePosture({ platform: "ios", width: 694, height: 1000, folds: null, isPad: true }).panes).toBe(2);
  });
});

describe("a sheet or composer open on the reader holds the move", () => {
  it("held while any holder holds, released when the last lets go, and listeners told once per change", () => {
    const a = Symbol("a");
    const b = Symbol("b");
    let told = 0;
    const off = subscribeReaderHeld(() => { told += 1; });
    holdReader(a, true);
    holdReader(b, true);
    expect(readerHeldNow()).toBe(true);
    holdReader(a, false);
    expect(readerHeldNow(), "one holder still holds").toBe(true);
    holdReader(b, false);
    expect(readerHeldNow()).toBe(false);
    holdReader(b, false);
    expect(told).toBe(2);
    off();
  });
});

describe("More never folds off the rail", () => {
  const NAV = readFileSync(fileURLToPath(new URL("../src/ui/nav-rail.tsx", import.meta.url)), "utf8");
  it("at any height the rail keeps More, and folds every other destination first", () => {
    const destinations = ["index", "screener", "reads", "receipts", "more"].map((id) => ({ id, fixed: railDestinationFixed(id) }));
    const fixedTail = [{ id: "__compose", fixed: true }, { id: "__search", fixed: true }];
    const fold = railFold([destinations, fixedTail], 10);
    expect(fold.kept.flat().map((e) => e.id)).toContain("more");
    expect(fold.folded.map((e) => e.id).sort()).toEqual(["index", "reads", "receipts", "screener"]);
  });
  it("the rail marks its destinations through that rule", () => {
    expect(NAV).toContain("fixed: railDestinationFixed(d.id),");
  });
});

describe("a full-window reader's bar starts past the rail", () => {
  it("beside the rail it clears the rail's column; in the pair's pane and under a dock it spans its width", () => {
    const railed = { nav: "rail", navSide: "left", gutter: 8 } as unknown as Parameters<typeof readerBarClearance>[0];
    const docked = { nav: "dock", navSide: "left", gutter: 8 } as unknown as Parameters<typeof readerBarClearance>[0];
    expect(readerBarClearance(railed, false)).toEqual({ left: RAIL_W + 8, right: 0 });
    expect(readerBarClearance(railed, false).left, "Reply inside the rail's column").toBeGreaterThanOrEqual(62 + 8);
    expect(readerBarClearance(railed, true)).toEqual({ left: 0, right: 0 });
    expect(readerBarClearance(docked, false)).toEqual({ left: 0, right: 0 });
  });
});

describe("a full-window reader beside the rail starts past it, header and body included", () => {
  const plan = (panes: number, nav = "rail") => ({ nav, navSide: "left", gutter: 8, panes } as unknown as Parameters<typeof screenRailClearance>[0]);
  it("a screen pays the rail's column on a one-pane rail, and a full-window one on a two-pane rail too", () => {
    expect(screenRailClearance(plan(1), false)).toEqual({ left: RAIL_W + 8, right: 0 });
    expect(screenRailClearance(plan(2), true), "the full-window reader's text sits in the rail's column").toEqual({ left: RAIL_W + 8, right: 0 });
    expect(screenRailClearance(plan(2), false), "a pane of the pair pays its own").toEqual({ left: 0, right: 0 });
    expect(screenRailClearance(plan(1, "dock"), true)).toEqual({ left: 0, right: 0 });
    // The same clearance the reader's floating bar takes: one source.
    expect(screenRailClearance(plan(2), true)).toEqual(readerBarClearance(plan(2), false));
  });
  it("the reader is a full-window screen whenever it is not in the pair's pane", () => {
    const reader = readFileSync(fileURLToPath(new URL("../src/ui/MessageReader.tsx", import.meta.url)), "utf8");
    expect(reader.match(/<Screen fullWindow=\{!inPane\}>/g)?.length, "a reader Screen that does not say it fills the window").toBe(2);
    expect(reader).not.toMatch(/<Screen>/);
  });
});
