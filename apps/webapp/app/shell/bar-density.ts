"use client";

/**
 * THE ACTION PILL'S RUNTIME DENSITY — fold on ACTUAL overflow, not on a reference font's idea
 * of it.
 *
 * ── WHY THE RUNGS ALONE WERE WRONG ON SOME MACHINES ─────────────────────────────────────────
 *
 * The density ladder in `action-bar.css` folds verb groups behind More at static container
 * widths, each derived from label widths measured in one reference font. That font does not
 * resolve everywhere — the ladder's own comments record readings drifting per string on a
 * machine without it — and on a system whose UI font renders NARROWER, every rung fires early:
 * the pill folds verbs behind More with visible room left beside them. Reported from real use
 * on exactly such a machine. The rungs' stated failure direction (fold early, never overflow)
 * held; the cost was verbs a wider row could have carried.
 *
 * So the pill now measures ITS OWN row: a hidden copy of every group the message could stand
 * (same markup, same classes, same font — rendered invisibly inside the pill) gives each
 * group's REAL width, and groups are admitted greedily, in the ladder's own row order, while
 * they actually fit. The CSS rungs stay untouched underneath as the no-JS/first-paint
 * fallback: until the first measurement lands, `data-admit` is absent and the rungs govern —
 * and they still only ever err toward folding early, which the measurement then corrects.
 *
 * ── THE LAWS, KEPT ──────────────────────────────────────────────────────────────────────────
 *
 *  · ROW ORDER IS FOLD ORDER. Admission is a greedy PREFIX over the groups in row order
 *    (reply-all · forward · horizons · tag · filing): the walk stops at the first group that
 *    does not fit, so a later verb can never stand while an earlier one is folded — the same
 *    law `action-bar.test.ts` pins over the rungs ("the rungs ascend in ROW ORDER").
 *  · NO OVERFLOW. The admitted row's width — base + every admitted group + the gaps between —
 *    is never allowed past the width the pill actually has. Folding too early is the benign
 *    direction; painting a control outside the pill is the defect the ladder exists to prevent.
 *  · IN THE ROW OR BEHIND MORE, NEVER BOTH. The `data-admit` CSS (foot of `action-bar.css`)
 *    switches each group's row form and its `mm-*` menu row in the same rule pair, exactly as
 *    every rung does.
 *
 * The SELECTION bar (`.pick-bar`) is deliberately untouched: its verbs are a different label
 * set with its own geometry and its own rungs, and this hook arms only under `.msg-actions`.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** The pill's own horizontal padding — what `.msg-actions > .abar` takes out of the container. */
export const PILL_PADDING_PX = 12;

/** The row's gap between groups, when the computed style cannot be read (jsdom). */
export const FALLBACK_GAP_PX = 6;

/** The density groups, in ROW ORDER — which is the ladder's rung order and the fold order. */
export const BAR_GROUP_ORDER = ["rall", "fwd", "defer", "tag", "file"] as const;
export type BarGroup = (typeof BAR_GROUP_ORDER)[number];

export interface MeasuredGroup {
  name: BarGroup;
  width: number;
}

/**
 * Greedy prefix admission: walk the PRESENT groups in row order, admitting while the row still
 * fits, and STOP at the first that does not — never skip past it to a narrower later group,
 * because standing a later verb over a folded earlier one breaks the row-order law.
 *
 * `basePx` is the floor that always stands (Reply + the read switch with More); each admitted
 * group costs its own width plus one row gap.
 */
export function admitGroups(
  availPx: number,
  basePx: number,
  groups: readonly MeasuredGroup[],
  gapPx: number,
): BarGroup[] {
  const admitted: BarGroup[] = [];
  let total = basePx;
  for (const g of groups) {
    const next = total + gapPx + g.width;
    if (next > availPx) break;
    admitted.push(g.name);
    total = next;
  }
  return admitted;
}

/** Read one measure-row group's density name off its class list, or null for a base group. */
function groupNameOf(el: Element): BarGroup | null {
  for (const name of BAR_GROUP_ORDER) if (el.classList.contains(`abar-${name}`)) return name;
  return null;
}

/**
 * The hook: observe the pill's container, measure the hidden row, publish the admitted set.
 *
 * Returns the space-joined admitted names for `data-admit` — or `null` before the first
 * measurement (and wherever `ResizeObserver` does not exist, jsdom included), which leaves the
 * attribute off and the CSS rungs in charge. The measure row is found by ref; its children are
 * classified by their own `abar-*` classes, so the hook needs no markers and no ordering
 * contract beyond the DOM order the row already renders in.
 */
export function useBarDensity(): {
  /** Ref for the hidden measure row (`.abar-measure`). */
  measureRef: (el: HTMLDivElement | null) => void;
  /** The `data-admit` value, or null while unmeasured (rungs govern). */
  admit: string | null;
  /**
   * Render the measure row at all? False on the server, on the hydration render (so the two
   * trees match — the engine provider's header carries the cost of getting that wrong) and
   * under a client with no `ResizeObserver` (jsdom included, which is what keeps the pill's
   * byte-capture and every bar test measuring the same markup they always did). Flips in an
   * effect, one commit after mount, where a measurement is actually possible.
   */
  armed: boolean;
} {
  const [admit, setAdmit] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (typeof ResizeObserver !== "undefined") setArmed(true);
  }, []);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const frameRef = useRef(0);

  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const container = row.closest(".msg-actions");
    if (!container) return; // a selection bar or a bare mount: rungs only
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return; // not laid out; keep the fallback
    const style = getComputedStyle(container);
    const avail =
      rect.width -
      (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0) -
      PILL_PADDING_PX;
    const gap = parseFloat(getComputedStyle(row).columnGap) || FALLBACK_GAP_PX;
    let base = 0;
    const groups: MeasuredGroup[] = [];
    for (const child of row.children) {
      if (!(child instanceof HTMLElement) || !child.classList.contains("abar-g")) continue;
      const name = groupNameOf(child);
      const w = child.offsetWidth;
      if (w <= 0) return; // the copy has no layout yet; a wrong zero must not admit the world
      if (name === null) base += base === 0 ? w : gap + w;
      else groups.push({ name, width: w });
    }
    if (base === 0) return;
    const next = admitGroups(avail, base, groups, gap).join(" ");
    setAdmit((prev) => (prev === next ? prev : next));
  }, []);

  const measureRef = useCallback(
    (el: HTMLDivElement | null) => {
      rowRef.current = el;
      if (el) {
        // The copy is furniture: invisible to the tree and to the pointer, and inert to focus.
        // (`inert` is set imperatively — the React version here has no prop for it.)
        el.setAttribute("aria-hidden", "true");
        (el as HTMLElement & { inert: boolean }).inert = true;
      }
    },
    [],
  );

  useEffect(() => {
    if (!armed) return; // no ResizeObserver (jsdom, SSR): rungs govern for good
    const row = rowRef.current;
    const container = row?.closest(".msg-actions");
    if (!row || !container) return;
    const onResize = () => {
      if (frameRef.current) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0;
        measure();
      });
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);
    // Label changes re-run through the row's own size; the locale flip re-renders the buttons
    // and the observer sees the row resize. The container observation covers the window.
    ro.observe(row);
    roRef.current = ro;
    measure();
    return () => {
      ro.disconnect();
      roRef.current = null;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
  }, [armed, measure]);

  return { measureRef, admit, armed };
}
