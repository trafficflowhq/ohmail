/**
 * WHERE THE NAV, THE PANES AND THE FOLD GO, PER DEVICE × POSTURE — the ruled design as the
 * suite reads them (v5): one glass grammar with positions per platform; no keep-out when the
 * fold is FLAT (the panes meet at the hinge line with the ordinary pane gutter, `--gap-tile`
 * 16); the keep-out band only half-open; hardware keeps its own width; the unfolded Duo's rail
 * carries the reader verbs; the iPad and the inner-portrait Duo pin the ActionBar; a split
 * mirrors the rail to the app's half; search rides the nav everywhere (the dock and rail take
 * it as a required prop, so that rule is the type's).
 */
import { describe, expect, it } from "vitest";
import { POSTURE_PRESETS, derivePosture, type PostureInput } from "../src/ui/posture/derive";
import { paneSplit, scaffoldPlan } from "../src/ui/scaffold/plan";

const at = (name: string) => {
  const p = POSTURE_PRESETS[name];
  if (!p) throw new Error(`no preset ${name}`);
  const input: PostureInput = {
    platform: p.platform ?? "ios",
    width: p.width,
    height: p.height,
    folds: p.folds ?? null,
    hasFold: p.hasFold,
    isPad: p.isPad,
    windowBounds: p.windowBounds ?? null,
  };
  return { posture: derivePosture(input), platform: input.platform };
};

const plan = (name: string) => {
  const { posture, platform } = at(name);
  return scaffoldPlan(posture, platform);
};

describe("the navigation's position per platform (one grammar, positions per platform)", () => {
  it("phone: the bottom dock", () => {
    expect(plan("phone")).toMatchObject({ nav: "dock", navSide: "bottom", panes: 1 });
  });
  it("a compact-height landscape phone: the leading rail keeps the vertical room", () => {
    expect(plan("phone-landscape")).toMatchObject({ nav: "rail", navSide: "left" });
  });
  it("the closed Duo: the right-edge rail (Apple, the right thumb)", () => {
    expect(plan("duo-closed")).toMatchObject({ nav: "rail", navSide: "right", panes: 1 });
  });
  it("the flip's inner display is an ordinary phone: the dock", () => {
    expect(plan("flip")).toMatchObject({ nav: "dock", panes: 1 });
  });
  it("android medium/expanded: the leading icon rail", () => {
    expect(plan("fold-inner")).toMatchObject({ nav: "rail", navSide: "left", panes: 2 });
    expect(plan("android-tablet")).toMatchObject({ nav: "rail", navSide: "left", panes: 2 });
  });
  it("the iPad: horizontal bars, the drawer, the pinned ActionBar — no dock on this platform", () => {
    expect(plan("ipad")).toMatchObject({ nav: "bars", actionBar: true, drawer: true, panes: 2 });
    expect(plan("ipad-portrait")).toMatchObject({ nav: "bars", actionBar: true });
  });
});

describe("the unfolded Duo", () => {
  it("landscape is the Mail shape: rail right, panes snapped to the hinge, the rail carrying the reader verbs, the destinations behind the toggle — never a sidebar", () => {
    expect(plan("duo-unfolded")).toMatchObject({
      nav: "rail",
      navSide: "right",
      panes: 2,
      snapToHinge: true,
      railCarriesReaderVerbs: true,
      drawer: true,
      actionBar: false,
    });
  });
  it("inner portrait is Apple's exception: horizontal bars, the ActionBar pinned", () => {
    expect(plan("duo-unfolded-portrait")).toMatchObject({
      nav: "bars",
      panes: 2,
      actionBar: true,
      railCarriesReaderVerbs: false,
    });
  });
  it("tabletop: panes stacked, the rail owning only the upper half", () => {
    expect(plan("duo-tabletop")).toMatchObject({
      nav: "rail",
      navSide: "right",
      paneAxis: "column",
      railUpperHalfOnly: true,
    });
  });
});

describe("a split mirrors the nav to the app's half", () => {
  it("left half: rail left; right half: rail right", () => {
    expect(plan("duo-split-left")).toMatchObject({ nav: "rail", navSide: "left", panes: 1 });
    expect(plan("duo-split-right")).toMatchObject({ nav: "rail", navSide: "right", panes: 1 });
  });
  /**
   * ANDROID READS NO SIDE (FIX-026 row 97, closed by construction). Every Android split plans the
   * dock with no drawer, so `posture.split`'s two readers (behind `plan.drawer`) are unreachable
   * there and no Android window frame is read. Pinned: split-right plans exactly as split-left.
   */
  it("android plans a right-half split exactly as a left-half one", () => {
    for (const hasFold of [true, false]) {
      const leftP = scaffoldPlan({ ...at("duo-split-left").posture, hasFold }, "android");
      const rightP = scaffoldPlan({ ...at("duo-split-right").posture, hasFold }, "android");
      expect(at("duo-split-right").posture.split, "control: the preset is a right-half split").toBe("right");
      expect(rightP).toEqual(leftP);
      expect(rightP).toMatchObject({ nav: "dock", drawer: false });
    }
  });
  it("android keeps Material's bottom bar in a compact split window — no mirroring", () => {
    const { posture } = at("duo-split-left");
    expect(scaffoldPlan({ ...posture, hasFold: false }, "android")).toMatchObject({ nav: "dock" });
  });
});

describe("the fold (flat takes no keep-out — the ruling)", () => {
  it("FLAT draws nothing and takes NO keep-out: the panes meet at the hinge line with the ordinary 16dp gutter", () => {
    expect(plan("duo-unfolded")).toMatchObject({ foldPaint: "none", foldGap: 16 });
  });
  it("half-open takes the keep-out band (fold + 8 each side) and the hairline pair", () => {
    expect(plan("duo-book")).toMatchObject({ foldPaint: "hairlines", foldGap: 9 + 16 });
  });
  it("hardware keeps its own width in every posture — the Surface Duo 2's 34dp hinge", () => {
    expect(plan("sd2")).toMatchObject({ foldPaint: "bar", foldGap: 34 });
  });
  it("the flat Pixel Fold meets at its medium gutter (10), the v5 table's own number", () => {
    const p = plan("fold-inner");
    // fold-inner is expanded width — 16; the medium case is the same rule at the other class
    expect(p.foldGap).toBe(16);
    const { posture } = at("fold-inner");
    const medium = scaffoldPlan({ ...posture, sizeClass: "medium" }, "android");
    expect(medium.foldGap).toBe(10);
  });
});

describe("the panes' split", () => {
  it("the unfolded Duo's list ends at the hinge: centre 475.5, half the 16 gutter each side", () => {
    const { posture } = at("duo-unfolded");
    const p = scaffoldPlan(posture, "ios");
    const split = paneSplit(posture, p, 951, 669);
    // leading edge = gutter 16 (the rail is on the RIGHT); 475.5 - 8 - 16 = 451.5 → 452
    expect(split).toEqual({ first: 452, gap: 16 });
  });
  it("tabletop splits on the horizontal hinge: the reader above, the fold band between", () => {
    const { posture } = at("duo-tabletop");
    const p = scaffoldPlan(posture, "ios");
    const split = paneSplit(posture, p, 669, 951);
    expect(split?.gap).toBe(9 + 16);
    expect(split?.first).toBeGreaterThan(0);
  });
  it("no hinge: the canonical list share, clamped", () => {
    const { posture } = at("ipad");
    const p = scaffoldPlan(posture, "ios");
    const split = paneSplit(posture, p, 1180, 820);
    expect(split?.first).toBeGreaterThanOrEqual(280);
    expect(split?.first).toBeLessThanOrEqual(400);
  });
  it("one pane: no split", () => {
    const { posture } = at("phone");
    expect(paneSplit(posture, scaffoldPlan(posture, "ios"), 390, 844)).toBeNull();
  });
});

/* A window between compact and two panes (the Fold's inner portrait, 673 and 616 dp) was a phone
   stretched across it: the dock at the foot and rows a window wide. */
describe("a one-pane window past compact width takes the leading rail", () => {
  const android = (width: number, height: number) =>
    derivePosture({ platform: "android", width, height, folds: null, hasFold: true });
  it("673 and 616 dp: one pane, the rail at the left, no dock", () => {
    for (const [w, h] of [[673, 841], [616, 679]] as const) {
      expect(android(w, h).panes, `${w}`).toBe(1);
      expect(scaffoldPlan(android(w, h), "android"), `${w}`).toMatchObject({ nav: "rail", navSide: "left", panes: 1 });
    }
  });
  it("iOS reads the same rule for a one-pane window that wide", () => {
    const one = { ...derivePosture({ platform: "ios", width: 673, height: 841, folds: [], isPad: true }), panes: 1 as const };
    expect(scaffoldPlan(one, "ios")).toMatchObject({ nav: "rail", navSide: "left" });
  });
  it("the control: a compact window keeps the dock", () => {
    expect(scaffoldPlan(android(599, 841), "android")).toMatchObject({ nav: "dock" });
  });
});

/* Android's two panes listed the destinations three times: the rail, More, and a drawer. */
describe("Android's two panes list the destinations on the rail, with no drawer", () => {
  it("the Fold inner, its book posture and the tablet plan no drawer", () => {
    for (const name of ["fold-inner", "fold-book", "android-tablet"]) {
      expect(plan(name), name).toMatchObject({ panes: 2, nav: "rail", drawer: false });
    }
  });
  it("the iPad and the unfolded Duo keep theirs: there it is the one list of destinations", () => {
    for (const name of ["ipad", "ipad-portrait", "duo-unfolded", "duo-unfolded-portrait"]) {
      expect(plan(name).drawer, name).toBe(true);
    }
  });
});
