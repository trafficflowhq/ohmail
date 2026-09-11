"use client";

/**
 * The action pill's runtime density — fold on ACTUAL overflow, not a reference font's idea of it.
 * Static widths derived from one font folded early on machines whose UI font renders narrower and
 * could not survive a wider one (a group admitted that the row cannot hold). So the pill measures
 * ITS OWN row: a hidden copy of every verb the message could stand — same markup, classes, font —
 * gives each verb's real width, and verbs are admitted greedily, in row order, while they fit. THIS
 * IS THE ONLY MECHANISM: the static widths are gone from `action-bar.css` — two mechanisms deciding
 * one question disagreed, and a folded group stood in NEITHER place. Until the first measurement,
 * `data-admit` is absent and the row is its floor; the measurement runs in the commit, before paint.
 */

/**
 * The laws. ROW ORDER IS FOLD ORDER, THE UNIT IS ONE VERB: admission is a greedy prefix over the
 * verbs in row order, so a later verb never stands while an earlier one is folded (pinned as a
 * property in `bar-density.test.ts`). It used to be one GROUP — a row with room for Later and Park
 * folded both with Resurface, 150px standing empty; the refusing reading is THE SLACK CANNOT SEAT
 * THE NEXT FOLDED VERB (`scripts/fit-render.mjs`). A segment pays its row gap once. NO OVERFLOW:
 * folding early is benign, painting outside the pill is the defect. IN THE ROW OR BEHIND MORE,
 * NEVER BOTH: `data-admit` switches each verb's row form and its `mm-*` menu row in one rule pair.
 * THE FLOOR YIELDS ITS WORDS ONCE: one label drops (`compact`); nothing below the compact floor folds.
 */

/**
 * The selection bar is this bar now. The old `.pick-bar` strip is retired: a selection's verbs wear
 * the message pill — the same element under the same `.msg-actions` — so they fold through this
 * hook with the same `data-admit` tokens and CSS; nothing branches on which mount, which is the
 * point — two folding mechanisms for one row is how the two came apart before. The one
 * generalisation is in the compact floor: a message's floor gives up the read switch's words, a
 * selection's the count capsule's ("× 7 selected" → "× 7"); both are `abar-*-lab` spans, so the
 * floor drops THE WIDEST ONE PRESENT — widest and not both, because the floor yields its words
 * once, and a row that still overflows is a column that is too narrow, which is reported.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Fallback for the pill's horizontal padding when the computed style is unreadable — the
 *  live value is read off the pill itself in `measure()`. */
export const PILL_PADDING_PX = 12;

/**
 * The row's room is the reading pane, not the reading column. Ruled 2026-09-10: the body keeps its 640px
 * column; the bar uses the width the pane has. The pane's centre and the column's centre are the same point
 * (`.msg` is `margin: 0 auto` inside `.read-col`; measured at 1440), so widening the row symmetrically cannot
 * move the pill off the text's centre. The width is published from HERE rather than CSS: reaching an ancestor's
 * width needs a container query, and `container-type: inline-size` makes that ancestor a containing block for
 * `position: fixed` descendants — which would place the resurface date picker against the pane instead of the
 * window. This hook already measures and publishes an attribute, so the room rides beside it as a custom
 * property. `.read-col` only, never `.reader`: the phone/overlay mount is already the full pane.
 */
export const ROOM_VAR = "--abar-room";
const PANE_SELECTOR = ".read-col";

/** The row's gap between row groups, when the computed style cannot be read (jsdom). */
export const FALLBACK_GAP_PX = 6;

/**
 * THE ADMISSIBLE VERBS, IN ROW ORDER — which is the admission order and the fold order.
 *
 * `seg` names the segmented control a verb is a member of, or null for one that stands alone.
 * The horizons and filing are segments — their members abut, with no row gap between them, and
 * that is what makes three buttons read as one control — so a verb continuing the segment its
 * predecessor opened costs its own width and no gap. Reply all, Forward and Tag stand alone and
 * each pays a gap.
 */
export const BAR_VERB_ORDER = [
  { verb: "rall", seg: null },
  { verb: "fwd", seg: null },
  { verb: "later", seg: "defer" },
  { verb: "aside", seg: "defer" },
  { verb: "resurface", seg: "defer" },
  { verb: "tag", seg: null },
  { verb: "screen", seg: "file" },
  { verb: "move", seg: "file" },
] as const;
export type BarVerb = (typeof BAR_VERB_ORDER)[number]["verb"];
export type BarSeg = "defer" | "file";

/**
 * THE SEGMENT WRAPPERS, each with the verb whose admission puts the wrapper in the row.
 *
 * A segment has a visible member exactly when its FIRST member is admitted — which is a
 * consequence of admission being a greedy prefix, not a second rule. Exported so the stylesheet
 * pin reads this mapping rather than a second copy of it.
 */
export const BAR_SEGMENTS: ReadonlyArray<{ seg: BarSeg; first: BarVerb }> = [
  { seg: "defer", first: "later" },
  { seg: "file", first: "screen" },
];

/** The `data-admit` token for the floor's one concession — a base button without its words. */
export const COMPACT = "compact";

/**
 * THE WORDS THE FLOOR MAY GIVE UP, each as the label span and the button that closes a gap
 * when it goes. Exported so the stylesheet pin and the two bars' tests read one list rather
 * than three copies of it; the ORDER is immaterial, because the widest is taken, not the first.
 */
export const COMPACT_LABELS: ReadonlyArray<{ label: string; button: string }> = [
  { label: ".abar-read .abar-read-lab", button: ".abar-read" },
  { label: ".abar-count .abar-count-word", button: ".abar-count" },
];

export interface MeasuredVerb {
  name: BarVerb;
  width: number;
  /** The segment this verb belongs to, or null when it stands alone. See {@link BAR_VERB_ORDER}. */
  seg: BarSeg | null;
}

/** What one verb costs to seat, given the segment the verb before it left open. */
export function verbCost(verb: MeasuredVerb, openSeg: BarSeg | null, gapPx: number): number {
  return verb.seg !== null && verb.seg === openSeg ? verb.width : gapPx + verb.width;
}

/**
 * Greedy prefix admission: walk the PRESENT verbs in row order, admitting while the row still
 * fits, and STOP at the first that does not — never skip past it to a narrower later verb,
 * because standing a later verb over a folded earlier one breaks the row-order law.
 *
 * `basePx` is the floor that always stands (Reply + the read switch with More). Each admitted
 * verb costs {@link verbCost}: its own width, plus one row gap unless it continues the segment
 * its predecessor opened.
 */
export function admitVerbs(
  availPx: number,
  basePx: number,
  verbs: readonly MeasuredVerb[],
  gapPx: number,
): BarVerb[] {
  const admitted: BarVerb[] = [];
  let total = basePx;
  let openSeg: BarSeg | null = null;
  for (const v of verbs) {
    const next = total + verbCost(v, openSeg, gapPx);
    if (next > availPx) break;
    admitted.push(v.name);
    total = next;
    openSeg = v.seg;
  }
  return admitted;
}

/**
 * A measured width, as a float. `offsetWidth` rounds to the nearest integer, so a walk summing ten
 * of them lands up to ~5px away from the width the layout uses — harmless while the row sat inside
 * a wider column, not harmless once the row became exactly the room it is given, where one pixel of
 * understatement is one pixel of clipping (the overflow direction this measurement exists to
 * prevent). Measured: a German 1600px reply-all bar admitted a set summing to 912 whose real width
 * was 913.1, and the row clipped by 1px. The rect is the same number the layout used.
 */
function widthOf(el: Element): number {
  return el.getBoundingClientRect().width;
}

/** Read an element's verb token off its class list, or null when it carries none. */
function verbNameOf(el: Element): BarVerb | null {
  for (const { verb } of BAR_VERB_ORDER) if (el.classList.contains(`abar-${verb}`)) return verb;
  return null;
}

/** Read a measure-row group's segment name off its class list, or null when it is not one. */
function segNameOf(el: Element): BarSeg | null {
  for (const { seg } of BAR_SEGMENTS) if (el.classList.contains(`abar-${seg}`)) return seg;
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
    if (!container) return; // a bare mount with no pill around it: nothing to measure against
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
    /* THE ROOM. The reading pane's content box when this bar is the message pane's — see
       `ROOM_VAR` — and the container's own box everywhere else (the selection pill in the list
       column's foot, a stream card's bar), which is what those mounts have always measured. */
    const pane = container.closest(".msg") ? container.closest(PANE_SELECTOR) : null;
    let room = rect.width
      - (parseFloat(style.paddingLeft) || 0)
      - (parseFloat(style.paddingRight) || 0);
    let fromPane = false;
    if (pane) {
      const ps = getComputedStyle(pane);
      const inner = pane.getBoundingClientRect().width
        - (parseFloat(ps.paddingLeft) || 0) - (parseFloat(ps.paddingRight) || 0);
      if (inner > 0) { room = inner; fromPane = true; }
    }
    /* PUBLISH THE PANE'S ROOM, AND NOTHING ELSE — because the property SETS this row's width,
       and a number taken from the row's own box and written back onto it is a feedback loop.
       Measured when it was: `width: <the row's own 310px>` with `margin-inline: calc(50% - 155px)`
       resolves 50% against `.msg`'s 322px content box, so the row lost 12px on every pass and the
       phone cells drifted (390 room 310 → 292, and the 640 reply-all bar dropped a verb). Where
       there is no pane the property is REMOVED, which leaves `width: 100%` and zero margins —
       today's behaviour, for the phone overlay and for every mount that is not this one. */
    if (container instanceof HTMLElement) {
      if (fromPane) {
        const px = `${Math.round(room)}px`;
        if (container.style.getPropertyValue(ROOM_VAR) !== px) {
          container.style.setProperty(ROOM_VAR, px);
        }
      } else if (container.style.getPropertyValue(ROOM_VAR) !== "") {
        container.style.removeProperty(ROOM_VAR);
      }
    }
    const avail = room - pillPad;
    const gap = parseFloat(getComputedStyle(row).columnGap) || FALLBACK_GAP_PX;
    /* THE WALK, AND WHY IT READS BUTTONS AND NOT GROUPS. `.abar-v` marks an element that is
       admitted or folded on its own: for a group that is one verb it is the group itself, and
       for a segment it is each member button. So a segmented control's three widths arrive as
       three verbs rather than as one block, which is the whole granularity change. Anything with
       neither mark is the floor. */
    let base = 0;
    const verbs: MeasuredVerb[] = [];
    for (const child of row.children) {
      if (!(child instanceof HTMLElement) || !child.classList.contains("abar-g")) continue;
      const seg = segNameOf(child);
      if (child.classList.contains("abar-v")) {
        const name = verbNameOf(child);
        const w = widthOf(child);
        if (w <= 0) return; // the copy has no layout yet; a wrong zero must not admit the world
        if (name === null) return; // marked admissible and unnamed: refuse rather than guess
        verbs.push({ name, width: w, seg: null });
      } else if (seg !== null) {
        for (const member of child.querySelectorAll<HTMLElement>(":scope > .abar-v")) {
          const name = verbNameOf(member);
          const w = widthOf(member);
          if (w <= 0) return;
          if (name === null) return;
          verbs.push({ name, width: w, seg });
        }
      } else {
        const w = widthOf(child);
        if (w <= 0) return;
        base += base === 0 ? w : gap + w;
      }
    }
    if (base === 0) return;
    /* THE COMPACT FLOOR — one word out of the floor, and it is the WIDEST of the words the
       floor is carrying. Measured off the copy's own label span (same font, same size) plus
       the gap its button closes when the span goes; each button's `gap` is read, not assumed,
       for the reason the paddings are.

       TWO CANDIDATES, ONE CONCESSION. A message pill carries the read switch's label; a
       selection pill carries that AND the count capsule's word. Taking the widest saves the
       most pixels for one lost word, and taking only one keeps "the floor yields its words
       once" literally true — see the header. A pill with neither (there is no such mount
       today) simply reports no `compact`, which is the honest answer rather than a token that
       hides nothing. */
    const tokens: string[] = [];
    let floor = base;
    if (base > avail) {
      let widest = 0;
      for (const sel of COMPACT_LABELS) {
        const lab = row.querySelector<HTMLElement>(sel.label);
        if (!lab) continue;
        const btn = lab.closest<HTMLElement>(sel.button);
        const labW = lab.getBoundingClientRect().width;
        if (labW <= 0) continue;
        const inner = btn ? parseFloat(getComputedStyle(btn).columnGap) || 0 : 0;
        widest = Math.max(widest, labW + inner);
      }
      if (widest > 0) {
        floor = base - widest;
        tokens.push(COMPACT);
      }
    }
    const next = [...admitVerbs(avail, floor, verbs, gap), ...tokens].join(" ");
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

  /**
   * THE SET OF OBSERVED CHILDREN, held explicitly rather than re-derived from the DOM.
   *
   * `unobserve` needs the elements that WERE observed. Reading `row.children` at teardown gives
   * the ones that are there NOW, so a group React had already removed was never unobserved and
   * went on firing measurements for a row it had left.
   */
  const watchedRef = useRef<Set<Element>>(new Set());

  /**
   * Re-sync which children are watched, and say whether the set changed. THE CHILDREN SET IS NOT FIXED FOR THE LIFE
   * OF THE ROW. `canReplyAll` and `canForward` add and remove a direct child, and React REUSES the measure row when
   * it does — so the ref callback, which fires only on mount and unmount, never runs. Observing "the children present
   * at mount" therefore missed every group that appeared later: switching in place from a 1:1 message to one with an
   * audience inserted a Reply-all group that nothing watched, neither the row's own box nor the container's had to
   * resize, and the previous `data-admit` survived — admitting a LATER group while the newly inserted earlier one
   * stayed folded, which breaks the greedy prefix the whole admission rests on.
   */
  const syncWatched = useCallback((row: HTMLDivElement): boolean => {
    const ro = roRef.current;
    if (!ro) return false;
    const next = new Set<Element>();
    for (const child of row.children) if (child instanceof HTMLElement) next.add(child);
    let changed = false;
    for (const gone of watchedRef.current) {
      if (!next.has(gone)) { ro.unobserve(gone); changed = true; }
    }
    for (const added of next) {
      if (!watchedRef.current.has(added)) { ro.observe(added); changed = true; }
    }
    watchedRef.current = next;
    return changed;
  }, []);

  const measureRef = useCallback(
    (el: HTMLDivElement | null) => {
      const prev = rowRef.current;
      if (prev && roRef.current) {
        roRef.current.unobserve(prev);
        /* The children that were ACTUALLY observed, not the ones still in the DOM.
           Given the after-every-render re-sync below, these two are the same list by the time a
           row unmounts — so this is belt-and-braces rather than the fix for anything, and it is
           written down as such because a mutation of this line does NOT go red. Before that
           re-sync existed, reading the live children here was a real leak: a group React had
           already removed was absent from `children` and so was never unobserved. The set is
           kept explicitly anyway, because it is the honest record of what was observed and does
           not depend on the effect below still being there. */
        for (const child of watchedRef.current) roRef.current.unobserve(child);
        watchedRef.current = new Set();
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
      /* AND THE PANE, because since the room is the pane's the row's own box no longer changes
         when the room does: the split column is user-resizable, so dragging it wider is exactly
         the moment a verb should come out of the menu and the container's box may not move. */
      const pane = container?.closest(".msg") ? container.closest(PANE_SELECTOR) : null;
      if (pane) roRef.current.observe(pane);
      /**
       * AND EVERY GROUP IN THE COPY, because the widths this hook reads are the CHILDREN's and those can change while
       * neither the row's box nor the container's does. The measure row is `position: absolute` inside the pill with
       * `overflow: hidden`, so in a constrained column its own box can stay put while a child grows. React also
       * REUSES this row across message swaps. Put together, that was a live defect: at the 1024px German Triage
       * width, moving from a resurfaced message (whose read slot says the short "Erledigt") to an ordinary read one
       * (whose slot says "Als ungelesen markieren") grows the floor by the difference between two labels — and if
       * neither observed box resized, the previous non-`compact` admission survived, the floor overflowed, and More
       * was pushed past the column.
       */

      /**
       * That is precisely the overflow the compact floor exists to prevent, reintroduced through the one door the
       * observer was not watching. Observing the children closes it for every cause rather than for that one: a label
       * swap, a locale switch, a face switch, and a webfont finishing load all change a child's box.
       */
      syncWatched(el);
      // Ref callbacks run after the commit's DOM insertion — the row is laid out enough to
      // read, and the first measurement must not wait for a resize that may never come.
      measure();
    },
    [measure, onResize, syncWatched],
  );

  /**
   * AND AGAIN AFTER EVERY RENDER, because that is when a group can appear or vanish.
   *
   * No dependency list: the thing being watched for is a change in the row's children, and no
   * value this hook can see tells it that. The work is a set comparison over at most six
   * elements. When the set really did change the row is re-measured immediately rather than
   * waiting for the observer, since the newly observed child may already be at its final size
   * and produce no resize of its own.
   */
  useEffect(() => {
    const row = rowRef.current;
    if (!row || !roRef.current) return;
    if (syncWatched(row)) measure();
  });

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
