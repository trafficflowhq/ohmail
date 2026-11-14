"use client";

/**
 * A ROW'S MENU STAYS ON SCREEN. The Screener's destination menu and the folder rail's ⋯ menu open
 * DOWNWARD from their row, and from a low row on a phone the Screener's ran 21px (53px in German)
 * past the viewport — the cut lines were the unsubscribe note, the sentence the press must show
 * before it happens. Measured before the first paint: below when it fits, else UPWARD from the
 * trigger, else the list scrolls by the smaller shortfall (the top row of a 355px list at 360),
 * else capped to the larger side with its own scroll, the caller's note first. The room is the viewport cut by
 * every clipping ancestor: a menu inside a scroller is cut at the scroller's edge.
 */
import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { cssRect, cssViewport } from "@ohmail/ui";
import { OVERLAY_EDGE } from "../screening/overlay-clamp";

export interface RowMenuFit {
  up: boolean;
  /** Set only when nothing else holds the menu whole: the menu scrolls inside this height. */
  maxHeight: number | null;
  /** Pixels added to the list's `scrollTop` so the chosen form fits whole; 0 when none is owed. */
  scroll: number;
}

/** `scrollHeight` is a rounded integer: a shortfall of one pixel is rounding, not overflow. */
const ROUNDING = 1;

/**
 * The pure decision. `downTop` is where the downward form starts (the containing row's bottom plus
 * the stylesheet's gap); `triggerTop` is the opening control's top, which the upward form rests on.
 * `roomDown`/`roomUp` are how far the list can scroll each way with the trigger still in the band.
 */
export function fitRowMenu(
  m: { natural: number; downTop: number; triggerTop: number; gap: number; roomDown?: number; roomUp?: number },
  band: { top: number; bottom: number },
): RowMenuFit {
  const below = band.bottom - OVERLAY_EDGE - m.downTop;
  const above = m.triggerTop - m.gap - (band.top + OVERLAY_EDGE);
  if (m.natural <= below + ROUNDING) return { up: false, maxHeight: null, scroll: 0 };
  if (m.natural <= above + ROUNDING) return { up: true, maxHeight: null, scroll: 0 };
  const lackDown = Math.ceil(m.natural - below);
  const lackUp = Math.ceil(m.natural - above);
  const down = lackDown <= (m.roomDown ?? 0);
  if (down && (lackDown <= lackUp || lackUp > (m.roomUp ?? 0))) return { up: false, maxHeight: null, scroll: lackDown };
  if (lackUp <= (m.roomUp ?? 0)) return { up: true, maxHeight: null, scroll: -lackUp };
  const up = above > below;
  return { up, maxHeight: Math.max(0, Math.floor(up ? above : below)), scroll: 0 };
}

/**
 * The vertical band a child of `from` can be seen in — the viewport, cut by every clipping
 * ancestor — and the innermost of them that scrolls, which is the list the menu can be scrolled in.
 */
export function visibleBand(
  from: Element | null,
  viewportHeight: number,
): { top: number; bottom: number; scroller: HTMLElement | null } {
  let top = 0;
  let bottom = viewportHeight;
  let scroller: HTMLElement | null = null;
  for (let e = from; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY;
    if (!o || o === "visible") continue;
    if (scroller == null && (o === "auto" || o === "scroll")) scroller = e as HTMLElement;
    const r = cssRect(e);
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
  }
  return { top, bottom, scroller };
}

/**
 * {@link fitRowMenu} wired to an open menu. The menu must be `position: absolute` under its row;
 * the upward form is inline (`top: auto`, `bottom` from the row's bottom to the trigger's top), so
 * the stylesheet keeps one rule per menu. `capped` tells the caller to put its note first. `open`
 * is falsy while closed and changes whenever a different row's menu opens.
 */
export function useRowMenuFit(
  menu: RefObject<HTMLElement | null>,
  trigger: RefObject<HTMLElement | null>,
  open: string | boolean | null,
  gap: number,
): { style: CSSProperties | undefined; capped: boolean } {
  const [fit, setFit] = useState<{ up: boolean; maxHeight: number | null; bottom: number } | null>(null);
  useLayoutEffect(() => {
    const el = menu.current;
    if (!open || el == null || typeof window === "undefined") {
      setFit(null);
      return;
    }
    const measure = (scrolled = false): void => {
      const row = (el.offsetParent as HTMLElement | null) ?? el.parentElement;
      const btn = trigger.current;
      if (row == null || btn == null) return;
      // CSS px throughout, the units of the scroll reads and the cap (`ui-zoom.ts` in @ohmail/ui).
      const rr = cssRect(row);
      const tr = cssRect(btn);
      // `scrollHeight` is the content's natural height even while capped; the border is added back.
      const natural = el.scrollHeight + (el.offsetHeight - el.clientHeight);
      const band = visibleBand(row.parentElement, cssViewport().height);
      const sc = band.scroller;
      const can = sc != null && !scrolled;
      const roomDown = can ? Math.min(sc.scrollHeight - sc.clientHeight - sc.scrollTop, tr.top - (band.top + OVERLAY_EDGE)) : 0;
      const roomUp = can ? Math.min(sc.scrollTop, band.bottom - OVERLAY_EDGE - tr.bottom) : 0;
      const f = fitRowMenu({ natural, downTop: rr.bottom + gap, triggerTop: tr.top, gap, roomDown, roomUp }, band);
      if (f.scroll !== 0 && sc != null) {
        sc.scrollTop += f.scroll;
        measure(true); // once: a list that moved less than asked is capped on the second reading
        return;
      }
      const next = { up: f.up, maxHeight: f.maxHeight, bottom: Math.round(rr.bottom - tr.top + gap) };
      setFit((p) => (p && p.up === next.up && p.maxHeight === next.maxHeight && p.bottom === next.bottom ? p : next));
    };
    const onResize = (): void => measure();
    measure();
    window.addEventListener("resize", onResize);
    // A content swap (the folder menu's delete confirm) changes the height: measured again.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
    ro?.observe(el);
    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, [menu, trigger, open, gap]);
  if (fit == null || (!fit.up && fit.maxHeight == null)) return { style: undefined, capped: false };
  const style: CSSProperties = fit.up ? { top: "auto", bottom: fit.bottom } : {};
  if (fit.maxHeight != null) Object.assign(style, { maxHeight: fit.maxHeight, overflowY: "auto", overscrollBehavior: "contain" });
  return { style, capped: fit.maxHeight != null };
}
