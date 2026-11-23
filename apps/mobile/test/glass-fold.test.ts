/**
 * THE TWO FOLD LAWS OF THE GLASS PRIMITIVES — the rail's height budget (fold bottom-to-top
 * into ⋯, never clip) and the bar's greedy admission (bar-density's law: row order is fold
 * order, a later verb never stands while an earlier one folds, a segment pays its gap once).
 */
import { describe, expect, it } from "vitest";
import {
  RAIL,
  admitVerbs,
  dockFold,
  railColumnHeight,
  railFold,
  railGroupHeight,
  type RailEntry,
} from "../src/ui/glass/fold";

const ids = (groups: RailEntry[][]) => groups.map((g) => g.map((e) => e.id));

describe("the rail budget", () => {
  const back: RailEntry[] = [{ id: "back", fixed: true }];
  const verbs: RailEntry[] = [
    { id: "reply", fixed: true },
    { id: "replyall", fixed: true },
    { id: "fwd", fixed: true },
    { id: "done" },
    { id: "park" },
    { id: "junk" },
  ];
  const more: RailEntry[] = [{ id: "more", fixed: true }];

  it("group arithmetic is the prototype's: n×44 + (n−1)×2 + 8, pills joined by 10", () => {
    expect(railGroupHeight(1)).toBe(52);
    expect(railGroupHeight(3)).toBe(3 * 44 + 2 * 2 + 8);
    expect(railColumnHeight([back, more])).toBe(52 + 10 + 52);
  });

  it("a tall rail folds nothing", () => {
    const fold = railFold([back, verbs, more], 2000);
    expect(fold.folded).toEqual([]);
    expect(ids(fold.kept)).toEqual([["back"], ["reply", "replyall", "fwd", "done", "park", "junk"], ["more"]]);
  });

  it("a short rail folds bottom-to-top — Junk first, then Park, then Done; the fixed verbs never", () => {
    const full = railColumnHeight([back, verbs, more]);
    const fold = railFold([back, verbs, more], full - 1);
    expect(fold.folded.map((e) => e.id)).toEqual(["junk"]);
    const tighter = railFold([back, verbs, more], full - 100);
    expect(tighter.folded.map((e) => e.id)).toEqual(["junk", "park", "done"]);
  });

  it("only fixed items left = the floor: nothing else folds, nothing throws", () => {
    const fold = railFold([back, verbs, more], 10);
    expect(fold.folded.map((e) => e.id)).toEqual(["junk", "park", "done"]);
    expect(ids(fold.kept)).toEqual([["back"], ["reply", "replyall", "fwd"], ["more"]]);
  });

  it("an emptied group's pill disappears rather than standing empty", () => {
    const fold = railFold([back, [{ id: "a" }], more], 52 + 10 + 52);
    expect(fold.folded.map((e) => e.id)).toEqual(["a"]);
    expect(ids(fold.kept)).toEqual([["back"], ["more"]]);
  });
});

describe("the bar's greedy admission", () => {
  const boxes = [
    { id: "rall", width: 90, seg: null },
    { id: "fwd", width: 80, seg: null },
    { id: "later", width: 60, seg: "defer" },
    { id: "aside", width: 70, seg: "defer" },
    { id: "resurface", width: 85, seg: "defer" },
    { id: "tag", width: 50, seg: null },
  ];

  it("admits a prefix in row order — a later verb never stands while an earlier folds", () => {
    // fixed 100; gaps 4. rall: 100+94=194; fwd: +84=278; later: +64=342 — room 350 seats three.
    expect(admitVerbs(boxes, 350, 100, 4)).toBe(3);
    expect(admitVerbs(boxes, 278, 100, 4)).toBe(2);
  });

  it("a verb continuing its predecessor's segment abuts — no second gap", () => {
    // aside continues defer: 342 + 70 = 412 (no gap), resurface: +85 = 497.
    expect(admitVerbs(boxes, 412, 100, 4)).toBe(4);
    expect(admitVerbs(boxes, 411, 100, 4)).toBe(3);
    expect(admitVerbs(boxes, 497, 100, 4)).toBe(5);
  });

  it("no room beyond the fixed parts = the floor: zero verbs", () => {
    expect(admitVerbs(boxes, 100, 100, 4)).toBe(0);
  });
});


describe("the Paper phone dock", () => {
  it("shows Receipts at 412dp and puts it in More at 390dp", () => {
    const destinations = ["index", "screener", "reads", "receipts", "more"];
    expect(dockFold(destinations, 412, true)).toEqual({ kept: destinations, folded: [] });
    expect(dockFold(destinations, 390, true)).toEqual({
      kept: ["index", "screener", "reads", "more"], folded: ["receipts"],
    });
  });
});
