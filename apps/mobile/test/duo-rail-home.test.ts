/**
 * THE iPHONE DUO AGAINST THE APPROVED DESIGN (prototype v5), as arithmetic — the deviations the
 * device conformance pass measured on 2026-09-21, each pinned so it cannot return: the closed
 * face's rail lives in the safe-area strip iOS reserves for controls (right 84 · top 0 on iOS
 * 27.1) and starts below the status cluster; the ONE rail swaps to the reader's verbs over an
 * open message on the closed face too (no bottom bar); the outer display in landscape stays one
 * pane; a pushed route's rail leads with Back; the inner portrait list takes the prototype's share of the width;
 * the `@canvas` flag rides the preset name; a full-width status bar is not a cluster.
 */
import { describe, expect, it } from "vitest";
import {
  OUTER_FACE_MAX,
  POSTURE_PRESETS,
  derivePosture,
  parsePostureOverride,
  statusClusterOf,
  type PostureInput,
} from "../src/ui/posture/derive";
import { readerVerbMode } from "../src/ui/reader-verbs";
import {
  OUTER_CLUSTER_H,
  RAIL_W,
  isTabRoute,
  paneSplit,
  railHome,
  scaffoldPlan,
  sheetOwnsTheWayOut,
} from "../src/ui/scaffold/plan";

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

/* iOS 27.1's reading on the closed Duo: the right strip reserved, no top bar. */
const CLOSED_INSETS = { top: 0, right: 84, bottom: 34, left: 0 };
const CLOSED_WIN = { w: 466, h: 678 };
/* The inner display (the prototype's device table; the open face never rendered on the beta). */
const INNER_INSETS = { top: 14, right: 0, bottom: 34, left: 0 };

describe("the closed Duo's rail lives in the reserved strip, below the status cluster", () => {
  it("centres the 62pt column in the 84pt strip: buttons at x≈402, the prototype's camera line", () => {
    const home = railHome(plan("duo-closed"), CLOSED_INSETS, CLOSED_WIN, null);
    expect(home.inStrip).toBe(true);
    expect(home.x).toBe(466 - 84);
    expect(home.width).toBe(84);
    // the 44pt button centred in the strip
    expect(home.x + (home.width - 44) / 2).toBe(402);
  });
  it("starts below the status cluster the module read", () => {
    const home = railHome(plan("duo-closed"), CLOSED_INSETS, CLOSED_WIN, { bottom: 155 });
    expect(home.top).toBe(163);
  });
  it("falls back to the measured cluster height when the module cannot read it — never y 6", () => {
    const home = railHome(plan("duo-closed"), CLOSED_INSETS, CLOSED_WIN, null);
    expect(home.top).toBe(OUTER_CLUSTER_H + 8);
    expect(home.top).toBeGreaterThan(155);
  });
  it("the inner display's right edge: no strip, the column hugs the edge (x 889, buttons at 898)", () => {
    const home = railHome(plan("duo-unfolded"), INNER_INSETS, { w: 951, h: 669 }, null);
    expect(home.inStrip).toBe(false);
    expect(home).toMatchObject({ x: 951 - RAIL_W, width: RAIL_W, top: 20, bottom: 34 });
    expect(home.x + (RAIL_W - 44) / 2).toBe(898);
  });
  it("a left-mirrored rail (split, app on the left) carries no clock: top is the inset's", () => {
    const home = railHome(plan("duo-split-left"), { top: 14, right: 0, bottom: 34, left: 84 }, { w: 471, h: 669 }, null);
    expect(home).toMatchObject({ x: 0, width: 84, inStrip: true, top: 20 });
  });
  it("a landscape phone's left rail hugs the notch inset, 62 wide", () => {
    const home = railHome(plan("phone-landscape"), { top: 0, right: 44, bottom: 21, left: 44 }, { w: 844, h: 390 }, null);
    expect(home).toMatchObject({ x: 44, width: RAIL_W, inStrip: false });
  });
});

describe("the ONE rail carries the reader's verbs on the closed face too", () => {
  it("duo-closed: rail right, one pane, railCarriesReaderVerbs", () => {
    expect(plan("duo-closed")).toMatchObject({ nav: "rail", navSide: "right", panes: 1, railCarriesReaderVerbs: true });
    expect(readerVerbMode(plan("duo-closed"))).toBe("rail");
  });
  it("the phone keeps the compact bar; the iPad keeps the ActionBar", () => {
    expect(readerVerbMode(plan("phone"))).toBe("compact");
    expect(readerVerbMode(plan("ipad"))).toBe("bar");
  });
});

describe("the outer display in landscape stays one pane with the side rail", () => {
  it("duo-closed-landscape: outer, one pane, rail right", () => {
    const { posture } = at("duo-closed-landscape");
    expect(posture.outer).toBe(true);
    expect(posture.panes).toBe(1);
    expect(plan("duo-closed-landscape")).toMatchObject({ nav: "rail", navSide: "right", panes: 1 });
  });
  it("the inner display is never 'outer': both unfolded poses keep two panes", () => {
    expect(at("duo-unfolded").posture.outer).toBe(false);
    expect(at("duo-unfolded-portrait").posture.outer).toBe(false);
    expect(at("duo-unfolded").posture.panes).toBe(2);
    expect(Math.max(951, 669)).toBeGreaterThan(OUTER_FACE_MAX);
  });
  it("a plain phone or iPad is never 'outer' — the rule needs the fold hardware", () => {
    expect(at("phone").posture.outer).toBe(false);
    expect(at("ipad").posture.outer).toBe(false);
    const android = derivePosture({ platform: "android", width: 466, height: 678, folds: [], hasFold: true });
    expect(android.outer).toBe(false);
  });
});

describe("a pushed route's rail leads with Back (the prototype's pushed rail)", () => {
  it("the five tab roots are not pushed", () => {
    for (const p of ["/", "/index", "/screener", "/reads", "/receipts", "/more", "/screener/"]) {
      expect(isTabRoute(p)).toBe(true);
    }
  });
  it("everything else is", () => {
    for (const p of ["/settings", "/message/abc", "/sender/waiting/x", "/servers", "/triage", "/history"]) {
      expect(isTabRoute(p)).toBe(false);
      expect(sheetOwnsTheWayOut(p, true), p).toBe(false);
    }
  });
  /* New mail is a sheet with its own Cancel: a rail Back beside it was a lone chevron saying it twice. */
  it("New mail's sheet carries the way out while it is up; its pages without one keep the rail's Back", () => {
    expect(sheetOwnsTheWayOut("/compose", true)).toBe(true);
    expect(sheetOwnsTheWayOut("/compose/", true)).toBe(true);
    expect(sheetOwnsTheWayOut("/compose", false), "no mailbox to send from: a page, Back stays").toBe(false);
    expect(isTabRoute("/compose"), "CONTROL: nor is it a tab root").toBe(false);
  });
});

describe("the inner portrait list is the prototype's 46 %; the iPad keeps 42 %", () => {
  it("duo-unfolded-portrait at 669: 294", () => {
    const { posture } = at("duo-unfolded-portrait");
    const split = paneSplit(posture, plan("duo-unfolded-portrait"), 669, 951);
    expect(split).not.toBeNull();
    // gutter 10 at medium width: inner = 669 - 20 - 10 = 639; 0.46 × 639 = 294
    expect(split?.first).toBe(294);
    expect(split?.gap).toBe(10);
  });
  it("the iPad landscape pane keeps the canonical 42 % (1180 → 400 cap)", () => {
    const { posture } = at("ipad");
    const split = paneSplit(posture, plan("ipad"), 1180, 820);
    expect(split?.first).toBe(400);
  });
});

describe("the @canvas flag rides the preset name", () => {
  it("duo-unfolded@canvas is the preset with canvas: true", () => {
    const o = parsePostureOverride("duo-unfolded@canvas");
    expect(o).toMatchObject({ width: 951, height: 669, canvas: true });
    expect(o).not.toBe(POSTURE_PRESETS["duo-unfolded"]);
  });
  it("the bare preset is unchanged and carries no canvas", () => {
    expect(parsePostureOverride("duo-unfolded")).toBe(POSTURE_PRESETS["duo-unfolded"]);
    expect(POSTURE_PRESETS["duo-unfolded"].canvas).toBeUndefined();
  });
  it("an unknown flag is ignored; an unknown name is still null", () => {
    expect(parsePostureOverride("duo-closed@nonsense")).toBe(POSTURE_PRESETS["duo-closed"]);
    expect(parsePostureOverride("no-such@canvas")).toBeNull();
  });
});

describe("the status bar frame is a cluster only when it is a side column", () => {
  it("the closed Duo's right-strip frame answers its bottom", () => {
    expect(statusClusterOf({ x: 382, y: 0, width: 84, height: 155 }, 466)).toEqual({ bottom: 155 });
  });
  it("a full-width bar, an empty frame or a short one answers null", () => {
    expect(statusClusterOf({ x: 0, y: 0, width: 466, height: 44 }, 466)).toBeNull();
    expect(statusClusterOf({ x: 0, y: 0, width: 0, height: 0 }, 466)).toBeNull();
    expect(statusClusterOf({ x: 382, y: 0, width: 84, height: 20 }, 466)).toBeNull();
    expect(statusClusterOf(null, 466)).toBeNull();
  });
});
