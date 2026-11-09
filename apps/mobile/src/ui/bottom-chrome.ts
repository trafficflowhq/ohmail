/**
 * WHAT STANDS AT THE FOOT OF THE WINDOW — the bottom dock, the reader's compact verb bar, the
 * pinned ActionBar — reported by the surface that draws it, read by the one thing that must
 * clear it: the toast (`chrome.tsx#Toast`). Measured on the iPhone 18 Pro (FIX-022, 2026-09-21):
 * the pill stood at a fixed 74pt over the inset, which is the dock's height, and the reader's bar
 * there wraps to two rows at ~136pt — the sentence and its Undo landed across Later and Park. A
 * bar knows its height only at layout, so it is reported, never assumed; a surface that leaves
 * clears its own slot. The provider sits at the root (`app/_layout.tsx`), above the navigator.
 */
import { createContext, createElement, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { Posture } from "./posture/derive";
import { detailPaneRect, pairBoxOf, pairPadding, paneSplit, type ScaffoldPlan } from "./scaffold/plan";

/** The pill's floor over the bottom inset — the dock's own height plus its lift, unchanged. */
export const TOAST_FLOOR = 74;
/** The gap the pill keeps above whatever chrome stands under it. */
export const TOAST_GAP = 12;

type Report = (key: string, extent: number | null) => void;
export type Slots = Readonly<Record<string, number>>;

const ExtentContext = createContext<number>(0);
const ReportContext = createContext<Report>(() => undefined);

/** Which pane of the pair in front a verb belongs to: the reader's while a message is open, else the list's. */
export type PillPane = "list" | "detail";
type PaneReport = (key: string, pane: PillPane | null) => void;
export type PaneHeld = { key: string; pane: PillPane } | null;

const PaneContext = createContext<PillPane | null>(null);
const PaneReportContext = createContext<PaneReport>(() => undefined);

/** One pair's report folded in: a pair takes the slot, and a pair leaving clears only its own. */
export function foldPane(held: PaneHeld, key: string, pane: PillPane | null): PaneHeld {
  if (pane === null) return held?.key === key ? null : held;
  return held?.key === key && held.pane === pane ? held : { key, pane };
}

/** One report folded into the standing slots; `null` clears; an unchanged extent is the same object. */
export function foldSlots(slots: Slots, key: string, extent: number | null): Slots {
  if (extent === null) {
    if (!(key in slots)) return slots;
    const { [key]: _gone, ...rest } = slots;
    return rest;
  }
  return slots[key] === extent ? slots : { ...slots, [key]: extent };
}

/** The tallest standing extent, 0 with nothing at the foot. */
export const tallest = (slots: Slots): number => Math.max(0, ...Object.values(slots));

export function BottomChromeProvider({ children }: { children: ReactNode }) {
  const [slots, setSlots] = useState<Slots>({});
  const report = useCallback<Report>((key, extent) => setSlots((s) => foldSlots(s, key, extent)), []);
  const extent = useMemo(() => tallest(slots), [slots]);
  const [pane, setPane] = useState<PaneHeld>(null);
  const reportPane = useCallback<PaneReport>((key, p) => setPane((h) => foldPane(h, key, p)), []);
  return createElement(
    ReportContext.Provider,
    { value: report },
    createElement(
      ExtentContext.Provider,
      { value: extent },
      createElement(
        PaneReportContext.Provider,
        { value: reportPane },
        createElement(PaneContext.Provider, { value: pane?.pane ?? null }, children),
      ),
    ),
  );
}

/** The pane the pair in front reports for the pill; null when no pair is in front, or on one pane. */
export function useToastPane(): PillPane | null {
  return useContext(PaneContext);
}

/** The pair's report: which of its panes a verb belongs to, or null; cleared when the pair unmounts. */
export function useToastPaneSlot(): (pane: PillPane | null) => void {
  const report = useContext(PaneReportContext);
  const key = useId();
  useEffect(() => () => report(key, null), [key, report]);
  return useCallback((pane: PillPane | null) => report(key, pane), [key, report]);
}

/** The tallest extent from the window's bottom edge to a standing chrome's top; 0 when none stands. */
export function useBottomChromeExtent(): number {
  return useContext(ExtentContext);
}

/**
 * A slot for one surface at the foot. The returned function takes the surface's extent — its
 * distance from the window's bottom edge to its top, inset included — or null while it draws
 * nothing; the slot clears itself when the surface unmounts.
 */
export function useBottomChromeSlot(key: string): (extent: number | null) => void {
  const report = useContext(ReportContext);
  useEffect(() => () => report(key, null), [key, report]);
  return useCallback((extent: number | null) => report(key, extent), [key, report]);
}

/** Where the pill's bottom edge sits: over the floor, and over whatever is reported, whichever is higher. */
export function toastBottom(insetBottom: number, chromeExtent: number): number {
  return Math.max(insetBottom + TOAST_FLOOR, chromeExtent + TOAST_GAP);
}

/** The pill's inset from each side of the window. */
export const TOAST_SIDE = 12;

/**
 * THE PANE THE PILL STANDS IN, in window dp: the detail pane's rect, or the list pane's from the same
 * split and padding the pair renders with. Null with no pane reported, on one pane and in tabletop.
 */
export function toastPaneRect(
  p: Posture,
  plan: ScaffoldPlan,
  win: { w: number; h: number },
  insets: { left: number; right: number },
  which: PillPane | null,
): { x: number; w: number } | null {
  if (which === null) return null;
  if (which === "detail") return detailPaneRect(p, plan, win, insets);
  if (plan.panes !== 2 || plan.paneAxis !== "row") return null;
  const box = pairBoxOf(win, insets);
  const split = paneSplit(p, plan, box.w, box.h);
  return split === null ? null : { x: insets.left + pairPadding(plan).left, w: split.first };
}

/**
 * THE PILL'S SIDES. A book fold keeps it on the reading side (`screenHingeClearance`, passed in),
 * never across the crease. Else, on two panes, inside the one pane the verb happened in (`pane`,
 * from `toastPaneRect`): centred on the window it stood half over the list and half over the reader.
 * Else the window less the rail's column (`nav`, `screenRailClearance`), so it centres in the content.
 */
export function toastSpan(
  hinge: { left: number; right: number },
  pane: { x: number; w: number } | null = null,
  winW = 0,
  nav: { left: number; right: number } = { left: 0, right: 0 },
): { left: number; right: number } {
  if (hinge.left > 0 || hinge.right > 0) return { left: hinge.left + TOAST_SIDE, right: hinge.right + TOAST_SIDE };
  if (pane !== null) return { left: pane.x + TOAST_SIDE, right: Math.max(0, winW - pane.x - pane.w) + TOAST_SIDE };
  return { left: nav.left + TOAST_SIDE, right: nav.right + TOAST_SIDE };
}

/** The pill's frame in window points, for the suite: `bottom` is measured from the window's foot. */
export function toastFrame(
  window: { width: number; height: number },
  insets: { top: number; bottom: number },
  chromeExtent: number,
  pillHeight: number,
  hinge: { left: number; right: number } = { left: 0, right: 0 },
  pane: { x: number; w: number } | null = null,
  nav: { left: number; right: number } = { left: 0, right: 0 },
): { left: number; right: number; top: number; bottom: number; height: number } {
  const bottom = toastBottom(insets.bottom, chromeExtent);
  const span = toastSpan(hinge, pane, window.width, nav);
  return { left: span.left, right: window.width - span.right, top: window.height - bottom - pillHeight, bottom, height: pillHeight };
}
