/**
 * WHAT STANDS AT THE FOOT OF THE WINDOW — the bottom dock, the reader's compact verb bar, the
 * pinned ActionBar — reported by the surface that draws it, read by the one thing that must
 * clear it: the toast (`chrome.tsx#Toast`). Measured on the iPhone 18 Pro (FIX-022, 2026-09-21):
 * the pill stood at a fixed 74pt over the inset, which is the dock's height, and the reader's bar
 * there wraps to two rows at ~136pt — the sentence and its Undo landed across Later and Park. A
 * bar knows its height only at layout, so it is reported, never assumed; a surface that leaves
 * clears its own slot. The provider sits at the root (`app/_layout.tsx`), above the navigator.
 */
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/** The pill's floor over the bottom inset — the dock's own height plus its lift, unchanged. */
export const TOAST_FLOOR = 74;
/** The gap the pill keeps above whatever chrome stands under it. */
export const TOAST_GAP = 12;

type Report = (key: string, extent: number | null) => void;
export type Slots = Readonly<Record<string, number>>;

const ExtentContext = createContext<number>(0);
const ReportContext = createContext<Report>(() => undefined);

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
  return createElement(
    ReportContext.Provider,
    { value: report },
    createElement(ExtentContext.Provider, { value: extent }, children),
  );
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

/** The pill's frame in window points, for the suite: `bottom` is measured from the window's foot. */
export function toastFrame(
  window: { width: number; height: number },
  insets: { top: number; bottom: number },
  chromeExtent: number,
  pillHeight: number,
): { left: number; right: number; top: number; bottom: number; height: number } {
  const bottom = toastBottom(insets.bottom, chromeExtent);
  return { left: 12, right: window.width - 12, top: window.height - bottom - pillHeight, bottom, height: pillHeight };
}
