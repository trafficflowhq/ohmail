/**
 * Where the navigation, the panes and the reader's verbs go, per posture — the foldable
 * prototype's `layout()` classifier, kept as one pure function so the suite can drive every
 * device × pose (`test/scaffold-plan.test.ts`) and `AppScaffold` only renders what this says.
 * The ruled design: ONE navigation material with positions per platform — phone: bottom dock
 * + search pill; Android medium/expanded: leading icon rail; the closed Duo: right rail; the
 * unfolded Duo landscape: the right-edge rail carrying the reader verbs, panes meeting at the
 * hinge; unfolded-portrait Duo and iPad: two panes + the pinned ActionBar; a split mirrors the
 * nav to the app's half; search in the nav always; flat=nothing, half=hairlines, hard=bar.
 */
import type { Posture } from "../posture/derive";
import type { PlatformName } from "../posture/derive";

export type NavKind = "dock" | "rail" | "bars";
export type NavSide = "bottom" | "left" | "right";
export type FoldPaint = "none" | "hairlines" | "bar";

export interface ScaffoldPlan {
  nav: NavKind;
  navSide: NavSide;
  panes: 1 | 2;
  /** Tabletop stacks the panes; everything else sits them side by side. */
  paneAxis: "row" | "column";
  /** Two panes with a vertical fold: the list ends at the hinge, the reader begins past it. */
  snapToHinge: boolean;
  foldPaint: FoldPaint;
  /** The whole keep-out band: hinge width + 8dp each side of a soft crease, 0 extra on hardware. */
  foldGap: number;
  /** The desktop reader's ActionBar, pinned at the reading pane's foot. */
  actionBar: boolean;
  /** The reader verbs ride the right-edge rail instead of the ActionBar (the Mail shape). */
  railCarriesReaderVerbs: boolean;
  /** The destinations live behind the list pane's toggle as a drawer (never across a hinge). */
  drawer: boolean;
  /** The pane gutter — the prototype's --gap-t/--gap-e per width class. */
  gutter: number;
  /** Tabletop only: the rail owns the upper half, so nothing sits on or below the seam. */
  railUpperHalfOnly: boolean;
}

const KEEP_OUT = 8;

const gutterOf = (p: Posture): number =>
  p.sizeClass === "compact" ? 0 : p.sizeClass === "medium" ? 10 : 16;

/**
 * The keep-out belongs to the SEPARATING postures only (v5 ruling; Android keys it on
 * `isSeparating`): half-open, the band is the fold plus 8dp each side and the crease is a
 * hairline pair; FLAT, "it has no width at all" — nothing is drawn, no keep-out, and the two
 * panes meet at the hinge line with the desktop's own pane gutter (`--gap-tile`, 16dp at
 * expanded width; 10 at medium). Only real hardware (the Surface Duo 2's hinge) keeps its own
 * width in every posture.
 */
function foldPaintOf(p: Posture): { foldPaint: FoldPaint; foldGap: number } {
  if (p.fold === "none" || p.hinge === null) return { foldPaint: "none", foldGap: gutterOf(p) };
  const band = Math.min(p.hinge.w, p.hinge.h);
  if (p.fold === "hard") return { foldPaint: "bar", foldGap: band };
  if (p.fold === "half") return { foldPaint: "hairlines", foldGap: band + 2 * KEEP_OUT };
  return { foldPaint: "none", foldGap: gutterOf(p) };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const RAIL_W = 62;

/** What a one-pane list must reserve so the flying nav does not sit over its content. */
export interface NavClearance {
  bottom: number;
  left: number;
  right: number;
}

/**
 * The clearance a one-pane list scroller reserves for the flying navigation. The dock floats at
 * the bottom, so the list keeps its footer clear (`dockClearance`, the caller's token). A rail
 * hugs a side edge — a closed foldable's right rail, a compact-height landscape phone's left
 * rail — so the list insets from THAT edge by the rail's own footprint (`RAIL_W + gutter`, the
 * same room the two-pane scaffold leaves), or its rows run under the rail (dates and the
 * Screener pill were clipped on the real Duo). The two-pane surfaces ("bars") reserve their own
 * gutter in `AppScaffold`, so a list there asks for nothing here.
 */
export function listNavClearance(plan: ScaffoldPlan, dockClearance: number): NavClearance {
  if (plan.nav === "rail") {
    const w = RAIL_W + plan.gutter;
    return { bottom: 0, left: plan.navSide === "left" ? w : 0, right: plan.navSide === "right" ? w : 0 };
  }
  if (plan.nav === "dock") return { bottom: dockClearance, left: 0, right: 0 };
  return { bottom: 0, left: 0, right: 0 };
}

/**
 * Where a floating reader bar may stand: a full-window reader beside the rail starts past the
 * rail's column; a reader in the pair's pane, or under a dock, spans its own width.
 */
export function readerBarClearance(plan: ScaffoldPlan, inPane: boolean): { left: number; right: number } {
  if (inPane || plan.nav !== "rail") return { left: 0, right: 0 };
  const { left, right } = listNavClearance(plan, 0);
  return { left, right };
}

/**
 * What a SCREEN pays for the rail: a one-pane rail's column, for every screen; and on a two-pane
 * posture, a screen that still fills the window (a full-window reader beside the rail) pays it too —
 * the same clearance its floating bar takes, from the same source.
 */
export function screenRailClearance(
  plan: ScaffoldPlan, fullWindow: boolean, inPane = false,
): { left: number; right: number } {
  /* A pane of the pair never pays: the pair pays once, on a two-pane posture in its padding and
     while a fold holds it open on its own Screen (`pairPadding`). */
  if (plan.nav !== "rail" || inPane || !(plan.panes === 1 || fullWindow)) return { left: 0, right: 0 };
  const { left, right } = listNavClearance(plan, 0);
  return { left, right };
}

/** The side safe-area insets a `Screen` pays: all of them, except inside a pane, whose pair paid them. */
export const screenSideInsets = (
  insets: { left: number; right: number }, inPane: boolean,
): { left: number; right: number } => (inPane ? { left: 0, right: 0 } : { left: insets.left, right: insets.right });

/**
 * Whether a `Screen` fills the window, and so pays the rail's column on a two-pane posture: what
 * it says, else every screen that is not one pane of the pair. Settings, Search, More and the
 * composer render alone under a two-pane posture, and starting at the window's edge put the rail
 * over their first letters.
 */
export const screenFillsWindow = (fullWindow: boolean | undefined, inPane: boolean): boolean =>
  fullWindow ?? !inPane;

/**
 * The two panes' split along the plan's axis, in dp — the FIRST pane's size and the gap
 * between them. Row mode: list then reader, the list ending at the hinge when one crosses the
 * window (the seam is the divider); no hinge, the canonical ~42% list. Column mode (tabletop):
 * the reader above the fold, the list below — the first pane is the reader's height. Null =
 * one pane; the scaffold renders `children` alone.
 */
export function paneSplit(
  p: Posture,
  plan: ScaffoldPlan,
  containerW: number,
  containerH: number,
): { first: number; gap: number } | null {
  if (plan.panes !== 2) return null;
  const railW = plan.nav === "rail" ? RAIL_W : 0;
  if (plan.paneAxis === "column") {
    if (p.hinge === null) return null;
    const center = p.hinge.y + p.hinge.h / 2;
    return { first: Math.max(0, Math.round(center - plan.foldGap / 2 - plan.gutter)), gap: plan.foldGap };
  }
  const leadEdge = plan.gutter + (plan.navSide === "left" ? railW : 0);
  if (plan.snapToHinge && p.hinge !== null && p.hinge.h >= p.hinge.w) {
    const center = p.hinge.x + p.hinge.w / 2;
    return { first: Math.max(0, Math.round(center - plan.foldGap / 2 - leadEdge)), gap: plan.foldGap };
  }
  const inner = containerW - 2 * plan.gutter - railW - plan.gutter;
  /* The Duo's inner portrait (a horizontal hinge, panes side by side): the prototype's 46 %
     list, clamped 280–340; the iPad and the Android tablets keep the canonical ~42 %. */
  if (p.hasFold) return { first: clamp(Math.round(inner * 0.46), 280, 340), gap: plan.gutter };
  return { first: clamp(Math.round(inner * 0.42), 280, 400), gap: plan.gutter };
}

/**
 * The list-detail pair's own padding: the gutter on every side, and the rail's column on its side
 * only on a two-pane posture. While a fold holds the pair open (one pane), the pair's `Screen` pays
 * the rail by the one-pane rule, so the padding does not pay it again.
 */
export function pairPadding(plan: ScaffoldPlan): { left: number; right: number; top: number; bottom: number } {
  const rail = plan.nav === "rail" && plan.panes === 2 ? RAIL_W : 0;
  return {
    left: plan.gutter + (plan.navSide === "left" ? rail : 0),
    right: plan.gutter + (plan.navSide === "right" ? rail : 0),
    top: plan.gutter,
    bottom: plan.gutter,
  };
}

/**
 * THE DETAIL PANE'S RECT in window dp, from the same `paneSplit` and `pairPadding` the pair renders
 * with — where a sheet stands on a two-pane posture (the More sheet, the composer). The pair's
 * `Screen` pays the horizontal insets, so the pair's box is the window less those. Null in one pane,
 * and in tabletop, where the sheet keeps the lower segment.
 */
export function detailPaneRect(
  p: Posture,
  plan: ScaffoldPlan,
  win: { w: number; h: number },
  insets: { left: number; right: number },
): { x: number; w: number } | null {
  if (plan.panes !== 2 || plan.paneAxis !== "row") return null;
  const boxW = win.w - insets.left - insets.right;
  const split = paneSplit(p, plan, boxW, win.h);
  if (split === null) return null;
  const pad = pairPadding(plan);
  const lead = pad.left + split.first + split.gap;
  return { x: insets.left + lead, w: Math.max(0, boxW - lead - pad.right) };
}

export function scaffoldPlan(p: Posture, platform: PlatformName): ScaffoldPlan {
  const { foldPaint, foldGap } = foldPaintOf(p);
  const gutter = gutterOf(p);
  const base: ScaffoldPlan = {
    nav: "dock",
    navSide: "bottom",
    panes: p.panes,
    paneAxis: "row",
    snapToHinge: false,
    foldPaint,
    foldGap,
    actionBar: false,
    railCarriesReaderVerbs: false,
    drawer: false,
    gutter,
    railUpperHalfOnly: false,
  };

  /* Split View: each app places controls along its OUTER edge (Apple); Android keeps
     Material's bottom bar in a compact window — no mirroring, as the prototype records. */
  if (p.split !== "full") {
    if (platform === "ios" && p.hasFold) {
      return { ...base, nav: "rail", navSide: p.split, panes: 1 };
    }
    return { ...base, panes: 1 };
  }

  /* Tabletop: half-open, horizontal fold — content above the seam, hands below. The Duo keeps
     its right rail but only over the upper half; Android takes the dock (Samsung Flex). */
  if (p.fold === "half" && p.hinge !== null && p.hinge.w >= p.hinge.h) {
    const duo = platform === "ios" && p.hasFold;
    return {
      ...base,
      nav: duo ? "rail" : "dock",
      navSide: duo ? "right" : "bottom",
      panes: 2,
      paneAxis: "column",
      snapToHinge: true,
      railUpperHalfOnly: duo,
      gutter: 8,
    };
  }

  /* One pane. The Duo's outer display keeps controls at the side (Apple, right thumb); a
     compact-height landscape phone keeps a leading side rail for the vertical room; everything
     else is the bottom dock in Material's/Apple's position. */
  if (p.panes === 1) {
    /* The closed Duo: the ONE rail swaps to the reader's verbs over an open message (the
       prototype's Mail shape on the outer display) — never a second bar at the foot. */
    if (platform === "ios" && p.hasFold) {
      return { ...base, nav: "rail", navSide: "right", railCarriesReaderVerbs: true };
    }
    if (p.heightClass === "compact") return { ...base, nav: "rail", navSide: "left" };
    return base;
  }

  /* Two panes on the unfolded Duo. A vertical hinge (landscape, flat or book) is the Mail
     shape: list at the hinge, reader past it, the right-edge rail carrying the reader's verbs,
     the destinations behind the list toggle. Inner portrait is Apple's exception — horizontal
     bars, the desktop verb bar pinned at the reader's foot. */
  if (platform === "ios" && p.hasFold) {
    if (p.hinge !== null && p.hinge.h >= p.hinge.w) {
      return {
        ...base,
        nav: "rail",
        navSide: "right",
        snapToHinge: true,
        railCarriesReaderVerbs: true,
        drawer: true,
      };
    }
    return { ...base, nav: "bars", snapToHinge: p.hinge !== null, actionBar: true, drawer: true };
  }

  /* The iPad (plain iOS, two panes): sidebar toggle + drawer, the pinned ActionBar — HIG; a
     bottom dock is an Android idiom and leaves this platform (the design review's reading). */
  if (platform === "ios") {
    return { ...base, nav: "bars", actionBar: true, drawer: true };
  }

  /* Android two panes (Fold inner, tablets): the leading icon rail at medium AND expanded,
     panes snapping to a vertical fold where one crosses the window. */
  return {
    ...base,
    nav: "rail",
    navSide: "left",
    snapToHinge: p.hinge !== null && p.hinge.h >= p.hinge.w,
    actionBar: true,
    drawer: true,
  };
}

/**
 * Whether the LIST PANE'S FOOT carries the search field. Search rides the navigation on every
 * posture (owner rule 5), so where that navigation is the rail, the rail's own pill IS search
 * and a second field at the pane foot is the same control twice — measured on the Duo in
 * unfolded landscape, where "Search" matched twice. The foot keeps it only where the nav has
 * no pill of its own: the iPad and the unfolded-portrait Duo, whose nav is the bars.
 */
export const paneFootSearch = (plan: Pick<ScaffoldPlan, "nav">, platform: PlatformName): boolean =>
  platform === "ios" && plan.nav !== "rail";

/* ──────────────────────────────── where the rail lives ─────────────────────────────────── */

export interface RailInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface RailHome {
  /** The column's left edge and width, window coordinates; the 62pt rail centres inside it. */
  x: number;
  width: number;
  top: number;
  bottom: number;
  /** The rail sits in the safe-area strip the OS reserved for controls (the closed Duo). */
  inStrip: boolean;
}

/**
 * The closed Duo's status cluster (time · wifi · camera) sits in the right strip, read as
 * ~155pt tall on iOS 27.1; when the module cannot read its frame, this is the floor the rail's
 * first pill starts below. A top inset this small means no top bar — the cluster's signature.
 */
export const OUTER_CLUSTER_H = 160;
export const OUTER_CLUSTER_TOP_FLOOR = 20;

/**
 * Where the vertical rail goes. iOS reserves the closed Duo's right strip for controls (safe
 * area right 84, top 0 on iOS 27.1) — the rail lives IN that strip, centred, aligned with the
 * camera (Apple: controls "move to the right side … aligned with the camera"), and its first
 * pill starts below the status cluster; content keeps the safe area and never runs under it.
 * Where the inset is narrower than the rail (the inner display, a landscape phone's left
 * rail), the column hugs the inset as before. A left-mirrored rail carries no clock.
 */
export function railHome(
  plan: Pick<ScaffoldPlan, "navSide">,
  insets: RailInsets,
  win: { w: number; h: number },
  cluster: { bottom: number } | null,
): RailHome {
  const side = plan.navSide === "left" ? "left" : "right";
  const inset = side === "left" ? insets.left : insets.right;
  const inStrip = inset >= RAIL_W;
  const width = inStrip ? inset : RAIL_W;
  const x = side === "left" ? (inStrip ? 0 : inset) : win.w - (inStrip ? inset : inset + RAIL_W);
  const clusterBottom =
    side !== "right" ? 0
    : cluster !== null ? cluster.bottom
    : inStrip && insets.top < OUTER_CLUSTER_TOP_FLOOR ? OUTER_CLUSTER_H
    : 0;
  const top = Math.max(insets.top + 6, clusterBottom + 8);
  const bottom = Math.max(insets.bottom, 12);
  return { x, width, top, bottom, inStrip };
}

/** The tab roots — a rail over any other path leads with Back (the prototype's pushed rail). */
const TAB_ROUTES = new Set(["/", "/index", "/screener", "/reads", "/receipts", "/more"]);
export const isTabRoute = (pathname: string): boolean => TAB_ROUTES.has(pathname.replace(/\/+$/, "") || "/");
