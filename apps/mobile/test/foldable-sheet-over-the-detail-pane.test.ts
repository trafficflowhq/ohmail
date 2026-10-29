/**
 * ═══ ON AN OPEN FOLDABLE A SHEET RISES OVER THE DETAIL PANE ═══════════════════════════════════════
 *
 * The reader's More sheet and New mail opened as a 560 dp form sheet centred on the window, over
 * both panes: the list half-covered and the reader's own bar half visible beside it. The flat fold
 * hands the posture no hinge, so the hinge rule never fired. The panel is now anchored to the
 * DETAIL PANE's rect, computed from the same split and padding the pair renders with, at the
 * pane's own width, with the scrim over the whole window. One pane keeps the thumb sheet; tabletop
 * keeps the lower segment. The pair's rail and side insets are paid once (review LOWs 4 and 8).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { creaseAcross, derivePosture, type FoldFeature } from "../src/ui/posture/derive";
import {
  detailPaneRect, pairPadding, paneSplit, RAIL_W, scaffoldPlan, screenFillsWindow, screenRailClearance, screenSideInsets,
} from "../src/ui/scaffold/plan";
import { SHEET_TOP_ROOM, sheetPanelBounds, sheetRoom } from "../src/ui/sheet-bounds";

const src = (rel: string) => withoutComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

const inner = (width: number, height: number, state: FoldFeature["state"]) => ({
  width, height, ...derivePosture({
    platform: "android",
    width,
    height,
    folds: [{ bounds: { x: width / 2, y: 0, w: 0, h: height }, state, orientation: "vertical", occlusion: "none" }],
    hasFold: true,
  }),
});
/** What the AVD's flat inner screen reports: no fold at all. */
const flatNoFold = (width: number, height: number) => ({
  width, height, ...derivePosture({ platform: "android", width, height, folds: [], hasFold: true }),
});

const TOP = 24;
const TWO_PANE = {
  "unfolded portrait, no fold reported": flatNoFold(821, 905),
  "unfolded portrait": inner(821, 905, "flat"),
  "unfolded landscape": inner(905, 821, "flat"),
  "unfolded at 480 dpi": inner(719, 792, "flat"),
  "half open": inner(821, 905, "half"),
};

describe("a two-pane posture: the panel stands over the detail pane", () => {
  for (const [name, p] of Object.entries(TWO_PANE)) {
    it(`${name}: never across the list, the pane's own width, bounded under the top inset`, () => {
      const plan = scaffoldPlan(p, "android");
      expect(plan.panes, "not a two-pane posture; this measures nothing").toBe(2);
      const pane = detailPaneRect(p, plan, { w: p.width, h: p.height }, { left: 0, right: 0 });
      expect(pane).not.toBeNull();
      const b = sheetPanelBounds(p.width, p.height, TOP, pane, p.hinge);
      const left = b.marginLeft as number;
      const right = left + (b.width as number);
      // SHEET_STRADDLES_PANES: the list pane ends at pad.left + first, as the pair renders it.
      const split = paneSplit(p, plan, p.width, p.height)!;
      const listRight = pairPadding(plan).left + split.first;
      expect(left, "the panel crosses the list").toBeGreaterThanOrEqual(listRight);
      // SHEET_OFF_PANE: the panel is the pane, its own x and width (the pair's gutter on the right).
      expect(left).toBe(listRight + split.gap);
      expect(right).toBe(pane!.x + pane!.w);
      expect(right).toBe(p.width - pairPadding(plan).right);
      expect(b.alignSelf).toBe("flex-start");
      expect(b.maxWidth, "the centred form sheet's bound is gone").toBeUndefined();
      expect(b.maxHeight).toBe(p.height - TOP - SHEET_TOP_ROOM);
      if (p.hinge !== null && p.hinge.h >= p.hinge.w) expect(left, "the panel crosses the fold").toBeGreaterThanOrEqual(p.hinge.x + p.hinge.w);
    });
  }

  it("with a side inset the panel stops at the pane's edge, never under the inset", () => {
    const p = inner(905, 821, "flat");
    const plan = scaffoldPlan(p, "android");
    const insets = { left: 0, right: 30 };
    const pane = detailPaneRect(p, plan, { w: p.width, h: p.height }, insets)!;
    const b = sheetPanelBounds(p.width, p.height, TOP, pane, p.hinge);
    expect((b.marginLeft as number) + (b.width as number)).toBeLessThanOrEqual(p.width - insets.right);
  });

  it("the rect follows the pair's own composition, insets included (a landscape cutout)", () => {
    const p = inner(905, 821, "flat");
    const plan = scaffoldPlan(p, "android");
    const insets = { left: 30, right: 0 };
    const box = p.width - insets.left - insets.right;
    const split = paneSplit(p, plan, box, p.height)!;
    const pad = pairPadding(plan);
    expect(detailPaneRect(p, plan, { w: p.width, h: p.height }, insets)).toEqual({
      x: insets.left + pad.left + split.first + split.gap,
      w: box - pad.left - split.first - split.gap - pad.right,
    });
  });
});

describe("one pane and tabletop keep their sheets", () => {
  it("folded: no pane, the full-width thumb sheet", () => {
    const p = derivePosture({ platform: "android", width: 404, height: 905, folds: [], hasFold: true });
    const plan = scaffoldPlan(p, "android");
    expect(plan.panes).toBe(1);
    expect(detailPaneRect(p, plan, { w: 404, h: 905 }, { left: 0, right: 0 })).toBeNull();
    const b = sheetPanelBounds(404, 905, TOP, null, null);
    expect(b).toEqual({ alignSelf: "center", width: "100%", maxWidth: 560, maxHeight: 905 - TOP });
  });
  it("tabletop: the lower segment wins over any pane", () => {
    const p = derivePosture({
      platform: "android", width: 905, height: 821, hasFold: true,
      folds: [{ bounds: { x: 0, y: 410, w: 905, h: 0 }, state: "half", orientation: "horizontal", occlusion: "none" }],
    });
    const plan = scaffoldPlan(p, "android");
    expect(plan.paneAxis).toBe("column");
    expect(detailPaneRect(p, plan, { w: 905, h: 821 }, { left: 0, right: 0 })).toBeNull();
    const b = sheetPanelBounds(905, 821, TOP, { x: 400, w: 505 }, p.hinge);
    expect(b.alignSelf).toBe("center");
    expect(b.maxHeight).toBe(Math.min(821 - TOP, Math.max(280, 821 - (p.hinge!.y + p.hinge!.h))));
  });
  /* Typing a reply in tabletop: the keyboard took the lower half and Cancel, Send + Done and Send
     stood on the crease, the keyboard's top a little below it. */
  it("tabletop with the keyboard up: the sheet ends above the crease", () => {
    const crease = { x: 0, y: 336, w: 841, h: 0 };
    const p = derivePosture({ platform: "android", width: 841, height: 673, hasFold: true,
      folds: [{ bounds: crease, state: "half", orientation: "horizontal", occlusion: "none" }] });
    const across = creaseAcross(p.fold, p.hinge);
    const room = sheetRoom(TOP, 302, across, 673);
    expect(673 - (room.paddingBottom as number), "the sheet's foot").toBeLessThanOrEqual(crease.y);
    expect(sheetRoom(TOP, 0, across, 673).paddingBottom, "keyboard down: the lower segment, as before").toBe(0);
    expect(sheetRoom(TOP, 400, across, 673).paddingBottom, "a keyboard above the crease lifts it itself").toBe(400);
    expect(sheetRoom(TOP, 302, null, 673).paddingBottom, "CONTROL: no crease, the keyboard's own lift").toBe(302);
    const flat = derivePosture({ platform: "android", width: 841, height: 673, hasFold: true,
      folds: [{ bounds: crease, state: "flat", orientation: "horizontal", occlusion: "none" }] });
    expect(creaseAcross(flat.fold, flat.hinge), "a flat fold is no crease").toBeNull();
    expect(creaseAcross(p.fold, { x: 420, y: 0, w: 0, h: 673 }), "a book fold is not across").toBeNull();
  });
});

describe("the pane rect reaches the sheet from the pair's own law, nowhere else", () => {
  it("Sheet's bounds read detailPaneRect over the live posture; the composer shares them", () => {
    const sheet = src("../src/ui/Sheet.tsx");
    expect(sheet).toContain("const pane = detailPaneRect(posture, scaffoldPlan(posture,");
    expect(sheet).toContain("const hinge = posture.panes === 2 || separatingVerticalHinge(posture.fold, posture.hinge) !== null ? posture.hinge : null;");
    expect(sheet).toContain("return sheetPanelBounds(w, h, insets.top, pane, hinge);");
    expect(src("../src/ui/MessageActions.tsx")).toContain("const panelBounds = useSheetPanelBounds();");
  });
  it("the pair renders with the same padding the rect is computed from", () => {
    const pair = src("../src/ui/list-detail.tsx");
    expect(pair).toContain('const pad = show === "pair" ? pairPadding(plan) : { left: 0, right: 0, top: 0, bottom: 0 };');
    for (const side of ["paddingTop: pad.top,", "paddingBottom: pad.bottom,", "paddingLeft: pad.left,", "paddingRight: pad.right,"]) {
      expect(pair).toContain(side);
    }
    expect(pair, "a second spelling of the rail's padding").not.toMatch(/RAIL_W|railPad/);
  });
});

describe("the rail and the side insets are paid once around the pair", () => {
  const coverSideways = flatNoFold(905, 403);
  it("a fold holding the pair open: the pair's Screen pays the rail, its padding and its panes do not", () => {
    const plan = scaffoldPlan(coverSideways, "android");
    expect(plan.panes).toBe(1);
    expect(plan.nav, "not a rail posture; this measures nothing").toBe("rail");
    expect(screenRailClearance(plan, screenFillsWindow(false, false)), "the pair's own Screen").toEqual({ left: RAIL_W + plan.gutter, right: 0 });
    expect(pairPadding(plan).left, "the pair's padding pays the rail again").toBe(plan.gutter);
    expect(screenRailClearance(plan, screenFillsWindow(undefined, true), true), "a pane's Screen pays it a third time").toEqual({ left: 0, right: 0 });
  });
  it("two panes: the padding pays the rail, no Screen does", () => {
    const p = inner(821, 905, "flat");
    const plan = scaffoldPlan(p, "android");
    expect(pairPadding(plan).left).toBe(plan.gutter + RAIL_W);
    expect(screenRailClearance(plan, screenFillsWindow(false, false))).toEqual({ left: 0, right: 0 });
    expect(screenRailClearance(plan, screenFillsWindow(undefined, true), true)).toEqual({ left: 0, right: 0 });
  });
  it("a pane's Screen pays no side inset; a window's pays both", () => {
    expect(screenSideInsets({ left: 30, right: 12 }, true)).toEqual({ left: 0, right: 0 });
    expect(screenSideInsets({ left: 30, right: 12 }, false)).toEqual({ left: 30, right: 12 });
    const screen = src("../src/ui/base.tsx");
    expect(screen).toContain("const rail = screenRailClearance(plan, fills, inPane, useNavDrawn());");
    expect(screen).toContain("paddingLeft: Math.max(side.left + rail.left, hinge.left),");
    expect(screen).toContain("paddingRight: Math.max(side.right + rail.right, hinge.right),");
  });
});

describe("the scrim covers the whole window behind every sheet (the ruling's amendment)", () => {
  const sheet = src("../src/ui/Sheet.tsx");
  it("one backdrop: the scrim token, the whole window, behind the panel", () => {
    const at = sheet.indexOf("export function SheetBackdrop(");
    expect(at, "no shared backdrop").toBeGreaterThan(-1);
    const fn = sheet.slice(at, sheet.indexOf("\n}\n", at));
    expect(fn).toContain("style={[StyleSheet.absoluteFill, { backgroundColor: t.c.scrim }]}");
    expect(fn).toContain("onPress={onPress}");
  });
  it("the Sheet primitive and the composer both draw it, and no bare backdrop is left", () => {
    expect(sheet).toContain("<SheetBackdrop label={Copy.moveCancel} onPress={onClose} />");
    const actions = src("../src/ui/MessageActions.tsx");
    expect(actions).toContain("<SheetBackdrop label={Copy.replyCancel} onPress={closeComposer} />");
    for (const [name, body] of [["Sheet.tsx", sheet], ["MessageActions.tsx", actions]] as const) {
      expect(body, `${name} keeps an undimmed backdrop`).not.toMatch(/<Pressable style=\{\{ flex: 1 \}\}/);
    }
  });
});
