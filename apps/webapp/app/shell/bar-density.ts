"use client";

/**
 * THE ACTION PILL'S RUNTIME DENSITY — fold on ACTUAL overflow, not on a reference font's idea
 * of it.
 *
 * ── WHY STATIC WIDTHS WERE WRONG ON SOME MACHINES ───────────────────────────────────────────
 *
 * This bar used to fold its verb groups behind More at static container widths, each derived
 * from label widths measured in one reference font. That font does not resolve everywhere, and
 * on a system whose UI font renders NARROWER every such width fires early: the pill folds verbs
 * behind More with visible room left beside them. Reported from real use on exactly such a
 * machine. That failure direction (fold early, never overflow) was the benign one; the cost was
 * verbs a wider row could have carried. The direction it could NOT survive was a font that
 * renders WIDER than the reference — then the static width admits a group the row cannot hold.
 *
 * So the pill measures ITS OWN row: a hidden copy of every group the message could stand
 * (same markup, same classes, same font — rendered invisibly inside the pill) gives each
 * group's REAL width, and groups are admitted greedily, in row order, while they actually fit.
 *
 * THIS IS THE ONLY MECHANISM. The static widths are gone from `action-bar.css` — two mechanisms
 * deciding one question disagreed, and the static rule outranked the measurement's on the menu
 * twin, so a folded group stood in NEITHER place: Later, Park and Resurface were reachable from
 * nowhere on the messages where the two disagreed. Until the first measurement lands,
 * `data-admit` is absent and the row is its floor (Reply, the read switch, More) with every
 * group behind More; the measurement runs in the commit that mounts the copy, before the
 * browser paints.
 *
 * ── THE LAWS, KEPT ──────────────────────────────────────────────────────────────────────────
 *
 *  · ROW ORDER IS FOLD ORDER. Admission is a greedy PREFIX over the groups in row order
 *    (reply-all · forward · horizons · tag · filing): the walk stops at the first group that
 *    does not fit, so a later verb can never stand while an earlier one is folded. Pinned as a
 *    property over random rows in `bar-density.test.ts`.
 *  · NO OVERFLOW. The admitted row's width — base + every admitted group + the gaps between —
 *    is never allowed past the width the pill actually has. Folding too early is the benign
 *    direction; painting a control outside the pill is the defect this measurement exists to
 *    prevent.
 *  · IN THE ROW OR BEHIND MORE, NEVER BOTH. The `data-admit` CSS (foot of `action-bar.css`)
 *    switches each group's row form and its `mm-*` menu row in the same rule pair — the only
 *    rules that touch either half.
 *  · THE FLOOR YIELDS ITS WORDS ONCE. When even the floor does not fit, the read switch's label
 *    is dropped (`compact` in `data-admit`) and the floor is re-measured without it; the dot
 *    and the keycap stay, and the verb moves to the button's name. Nothing below the compact
 *    floor can fold — the measurement reports that state rather than hiding a control.
 *
 * The SELECTION bar (`.pick-bar`) is deliberately untouched: its verbs are a different label
 * set with its own geometry and its own two container rungs, and this hook arms only under
 * `.msg-actions`.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Fallback for the pill's horizontal padding when the computed style is unreadable — the
 *  live value is read off the pill itself in `measure()`. */
export const PILL_PADDING_PX = 12;

/** The row's gap between groups, when the computed style cannot be read (jsdom). */
export const FALLBACK_GAP_PX = 6;

/** The density groups, in ROW ORDER — which is the admission order and the fold order. */
export const BAR_GROUP_ORDER = ["rall", "fwd", "defer", "tag", "file"] as const;
export type BarGroup = (typeof BAR_GROUP_ORDER)[number];
/** The `data-admit` token for the floor's one concession — the read switch without its words. */
export const COMPACT = "compact";

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
 * attribute off and the row at its floor. The measure row is found by ref; its children are
 * classified by their own `abar-*` classes, so the hook needs no markers and no ordering
 * contract beyond the DOM order the row already renders in.
 */
export function useBarDensity(): {
  /** Ref for the hidden measure row (`.abar-measure`). */
  measureRef: (el: HTMLDivElement | null) => void;
  /** The `data-admit` value, or null while unmeasured (the row stands at its floor). */
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
    /* The pill's own padding is READ, exactly as the container's is — a constant here would
       skew every admission silently the day `.msg-actions > .abar { padding }` changes. The
       row's parent IS the pill; the fallback covers an unparseable read only. */
    const abar = row.parentElement;
    const abarStyle = abar ? getComputedStyle(abar) : null;
    const padL = abarStyle ? parseFloat(abarStyle.paddingLeft) : NaN;
    const padR = abarStyle ? parseFloat(abarStyle.paddingRight) : NaN;
    // The fallback fires on ANY unreadable read: half a measurement is not a measurement,
    // and an unreadable side silently contributing zero would grant phantom pixels to the
    // admission walk — the overflow direction, the one this measurement exists to prevent.
    const pillPad =
      Number.isFinite(padL) && Number.isFinite(padR) ? padL + padR : PILL_PADDING_PX;
    const avail =
      rect.width -
      (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0) -
      pillPad;
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
    /* THE COMPACT FLOOR — the read switch's words are the one thing the floor can give up.
       Measured off the copy's own label span (same font, same size) plus the gap the button
       closes when the span goes; the button's `gap` is read, not assumed, for the reason the
       paddings are. */
    const tokens: string[] = [];
    let floor = base;
    if (base > avail) {
      const lab = row.querySelector<HTMLElement>(".abar-read .abar-read-lab");
      const readBtn = lab?.closest<HTMLElement>(".abar-read") ?? null;
      const labW = lab ? lab.getBoundingClientRect().width : 0;
      const inner = readBtn ? parseFloat(getComputedStyle(readBtn).columnGap) || 0 : 0;
      if (labW > 0) {
        floor = base - labW - inner;
        tokens.push(COMPACT);
      }
    }
    const next = [...admitGroups(avail, floor, groups, gap), ...tokens].join(" ");
    setAdmit((prev) => (prev === next ? prev : next));
  }, []);

  /**
   * OBSERVE FROM THE REF CALLBACK, NOT FROM A MOUNT EFFECT. The measure row is not mounted for
   * the life of the bar: the panel branches (Move, the delete confirm, the resurface chooser)
   * early-return without it, and a mount-keyed effect kept observing the DETACHED row — so
   * after one panel cycle, a label-width change that arrived through re-render alone (the read
   * slot flipping to a wider verb, a locale switch) no longer re-measured, and a stale
   * `data-admit` computed against the narrower row could admit more than fits. The ref
   * callback fires on every mount and unmount of the row, so the observer — and a fresh
   * measurement — follow it through every panel cycle.
   */
  const onResize = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      measure();
    });
  }, [measure]);

  const measureRef = useCallback(
    (el: HTMLDivElement | null) => {
      const prev = rowRef.current;
      if (prev && roRef.current) {
        roRef.current.unobserve(prev);
        // The children were observed too (below); a detached row's children must not keep
        // firing a measurement for a row that is no longer in the tree.
        for (const child of prev.children) {
          if (child instanceof HTMLElement) roRef.current.unobserve(child);
        }
      }
      rowRef.current = el;
      if (!el) return;
      // The copy is furniture: invisible to the tree and to the pointer, and inert to focus.
      // (`inert` is set imperatively — the React version here has no prop for it.)
      el.setAttribute("aria-hidden", "true");
      (el as HTMLElement & { inert: boolean }).inert = true;
      if (typeof ResizeObserver === "undefined") return;
      roRef.current ??= new ResizeObserver(onResize);
      roRef.current.observe(el);
      const container = el.closest(".msg-actions");
      if (container) roRef.current.observe(container); // observing twice de-duplicates
      /**
       * AND EVERY GROUP IN THE COPY, because the widths this hook reads are the CHILDREN's and
       * those can change while neither the row's box nor the container's does.
       *
       * The measure row is `position: absolute` inside the pill with `overflow: hidden`, so in a
       * constrained column its own box can stay put while a child grows. React also REUSES this
       * row across message swaps. Put together, that was a live defect: at the 1024px German
       * Triage width, moving from a resurfaced message (whose read slot says the short
       * "Erledigt") to an ordinary read one (whose slot says "Als ungelesen markieren") grows the
       * floor by the difference between two labels — and if neither observed box resized, the
       * previous non-`compact` admission survived, the floor overflowed, and More was pushed past
       * the column. That is precisely the overflow the compact floor exists to prevent,
       * reintroduced through the one door the observer was not watching.
       *
       * Observing the children closes it for every cause rather than for that one: a label swap,
       * a locale switch, a face switch, and a webfont finishing load all change a child's box.
       */
      for (const child of el.children) {
        if (child instanceof HTMLElement) roRef.current.observe(child);
      }
      // Ref callbacks run after the commit's DOM insertion — the row is laid out enough to
      // read, and the first measurement must not wait for a resize that may never come.
      measure();
    },
    [measure, onResize],
  );

  /** Teardown with the BAR, not with the row — the row's own cycles are handled above. */
  useEffect(
    () => () => {
      roRef.current?.disconnect();
      roRef.current = null;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    },
    [],
  );

  return { measureRef, admit, armed };
}
