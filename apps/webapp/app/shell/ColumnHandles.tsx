"use client";

/**
 * The two column separators — the handle IS the gap. No grip, no dots: a tiling compositor has
 * neither, the gap between windows is where you drag, the cursor says so and the border is what
 * lights; appearance in `column-handles.css` (token reads only), numbers in `column-store.ts`. The
 * list handle is a PORTAL and the rail handle is not: the rail is a child of `.deck` whose offset
 * CSS can evaluate, while the list's left edge is the resolved size of a `minmax()` grid track no
 * `calc()` can name — so it is portalled into whichever `.view.split > .list-col` is mounted,
 * re-resolved after every render (cheap; the views are keyed on the route). A `ResizeObserver` was
 * rejected: it fires on the list's width but not the rail's.
 */

/**
 * The keys are the widget's own, deliberately not in the registry: ←/→ by 16px (Shift 64), Home/End
 * to floor and ceiling, Backspace/Delete resets — only while the handle holds focus, and the handler
 * CLAIMS the event (`stopImmediatePropagation`; React and the registry are two bubble listeners on
 * one node — see the handler). Not app verbs: the `?` sheet lists what the app does, and a widget's
 * keys belong to the widget; the handle is reached by Tab. Nothing renders until after mount:
 * `aria-valuenow` is a measurement the server does not have, and a hydration mismatch keeps the
 * server's value — invisible chrome skips the SSR pass; the widths are stamped pre-paint anyway.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import {
  applyColumnVars,
  clampList,
  clampRail,
  readColumns,
  writeColumns,
  BIG_STEP,
  LIST,
  RAIL,
  STEP,
  type ColumnState,
} from "./column-store";
import "./column-handles.css";

/** Where each handle's column actually is, so a measurement never guesses. */
const RAIL_SEL = ".deck > .rail";
const LIST_SEL = ".view.split > .list-col";
const SPLIT_SEL = ".view.split";

type Kind = "rail" | "list";

/**
 * The list's ceiling RIGHT NOW: its own 720px maximum, or whatever leaves the reading column
 * its floor, whichever is smaller. CSS enforces this on its own (`splitUserValue`'s `min()`),
 * so this exists only to announce an honest `aria-valuemax` — a separator that claims a
 * ceiling the drag cannot reach is worse than one that claims none.
 */
function listCeiling(): number {
  const split = document.querySelector<HTMLElement>(SPLIT_SEL);
  if (!split) return LIST.max;
  const gap = parseFloat(getComputedStyle(split).columnGap);
  const room = split.clientWidth - LIST.viewerMin - (Number.isFinite(gap) ? gap : 0);
  return Math.max(LIST.min, Math.min(LIST.max, Math.floor(room)));
}

interface HandleProps {
  kind: Kind;
  label: string;
  /** The live geometry, shared by both handles — one record, one write. */
  state: React.MutableRefObject<ColumnState>;
}

function Handle({ kind, label, state }: HandleProps) {
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; from: number } | null>(null);
  /** `aria-valuenow`/`max`, held as state because they are the only thing that re-renders. */
  const [now, setNow] = useState<number>(kind === "rail" ? RAIL.dflt : LIST.dflt);
  const [max, setMax] = useState<number>(kind === "rail" ? RAIL.max : LIST.max);

  /**
   * The column's REAL width — the on-screen one, not the stored one: the list's ceiling is
   * `min(<chosen>, <the room>)`, so on a window too narrow to honour a stored 720 the column stands
   * at what the room allows, and a ← stepping from 720 would need a dozen presses before anything
   * moved. Every step is relative to what is in front of the reader. With no layout to read, the
   * fallback is this handle's own last value and only then the shipped default — a hard default
   * makes every press start again from 224, so two → presses land on 240 rather than 256 (found by
   * the keyboard walkthrough; jsdom measures nothing). The honest answer is "the number I last
   * set", never "the number you never chose".
   */
  const measure = useCallback((): number => {
    const col = document.querySelector<HTMLElement>(kind === "rail" ? RAIL_SEL : LIST_SEL);
    if (col) {
      const w = col.getBoundingClientRect().width;
      if (w > 0) return Math.round(w);
    }
    return state.current[kind] ?? (kind === "rail" ? RAIL.dflt : LIST.dflt);
  }, [kind, state]);

  const announce = useCallback(() => {
    setNow(measure());
    setMax(kind === "rail" ? RAIL.max : listCeiling());
  }, [kind, measure]);

  const apply = useCallback(
    (next: ColumnState, persist: boolean) => {
      state.current = next;
      applyColumnVars(document.documentElement, next);
      if (persist) writeColumns(next);
      announce();
    },
    [announce, state],
  );

  const set = useCallback(
    (px: number, persist: boolean) => {
      const next: ColumnState = { ...state.current };
      if (kind === "rail") next.rail = clampRail(px);
      else next.list = clampList(px);
      apply(next, persist);
    },
    [apply, kind, state],
  );

  const reset = useCallback(() => {
    const next: ColumnState = { ...state.current };
    delete next[kind];
    apply(next, true);
  }, [apply, kind, state]);

  // Announce once the column has been laid out, and again whenever the WINDOW changes size —
  // the list's ceiling is a function of the room, and a stale `aria-valuemax` is a false claim.
  useEffect(() => {
    announce();
    window.addEventListener("resize", announce);
    return () => window.removeEventListener("resize", announce);
  }, [announce]);

  /**
   * Leave the drag state behind and the whole shell is unusable, so clearing it is a function every
   * exit calls rather than a line inside `onPointerUp`. `.deck.col-resizing` puts
   * `cursor: col-resize !important` and `user-select: none !important` on every descendant and
   * takes pointer events off every mail-body iframe — correct for the half-second of a gesture,
   * catastrophic if it sticks: nothing selectable, bodies refusing clicks, until a reload. A
   * pointerup is not guaranteed to arrive here — the list handle is portalled, so a route change
   * mid-gesture unmounts it, and `setPointerCapture` can be refused — so the class is cleared on
   * unmount and on `lostpointercapture` as well as on release.
   */
  const endDrag = useCallback((persist: boolean) => {
    if (!drag.current) return;
    drag.current = null;
    el.current?.classList.remove("dragging");
    document.querySelector(".deck")?.classList.remove("col-resizing");
    // Whatever the gesture settled on — including "nothing", which persists the record
    // unchanged rather than inventing a width for a press that never moved.
    if (persist) apply(state.current, true);
  }, [apply, state]);

  useEffect(() => () => {
    drag.current = null;
    document.querySelector(".deck")?.classList.remove("col-resizing");
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, from: measure() };
    // Wrapped: a browser that refuses capture must still get a working drag — the class and the
    // move handler do the work, and `lostpointercapture`/unmount are what clean up after it.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable — the gesture still runs, and still ends */
    }
    e.currentTarget.classList.add("dragging");
    document.querySelector(".deck")?.classList.add("col-resizing");
    // `preventDefault` stops the drag from starting a text selection — and it also suppresses
    // the focus the press would have given, so focus is taken by hand. A person who grabs a
    // handle with the mouse can then nudge it with the arrows, which is the point of the keys.
    e.preventDefault();
    e.currentTarget.focus();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // Live, NOT persisted: a drag writes the store once, on release, rather than on every
    // frame of a gesture somebody may still be changing their mind about.
    set(d.from + (e.clientX - d.x), false);
  };

  const onPointerUp = () => endDrag(true);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    const floor = kind === "rail" ? RAIL.min : LIST.min;
    // THE CEILING `End` GOES TO IS THE ONE `aria-valuemax` NAMES. The list's is a function of
    // the room, so on a narrow-but-split window the raw 720 is unreachable — storing it would
    // put the record past the maximum the reader was just told about, and re-expand the column
    // by hundreds of pixels the next time the window was widened.
    const ceiling = kind === "rail" ? RAIL.max : listCeiling();
    let handled = true;
    if (e.key === "ArrowLeft") set(measure() - step, true);
    else if (e.key === "ArrowRight") set(measure() + step, true);
    else if (e.key === "Home") set(floor, true);
    else if (e.key === "End") set(ceiling, true);
    else if (e.key === "Backspace" || e.key === "Delete") reset();
    else handled = false;
    if (!handled) return;
    e.preventDefault();
    /**
     * `stopImmediatePropagation` on the native event, and nothing else. The first draft called only
     * `stopPropagation`, on the stated but false premise that the dispatcher is a bubble listener further up; the App
     * Router hydrates the WHOLE DOCUMENT, so React's delegated keydown and `keymap.tsx`'s `document.addEventListener`
     * are two bubble listeners on the SAME node, and `stopPropagation` does nothing about a sibling — → would widen
     * the rail AND step focus into the reader, making keyboard resizing single-shot in a browser while fine on the
     * desktop (whose entry mounts at `#root`). Only `stopImmediatePropagation` stops a sibling; `MoreMenu.tsx`
     * measured the same mechanism. A test DOM cannot reproduce it (a harness mounts React into a `<div>`), so the
     * guard watches the CALL (`column-handles.test.tsx`).
     */
    e.nativeEvent.stopImmediatePropagation();
  };

  return (
    <div
      ref={el}
      className={`col-handle col-handle-${kind}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={kind === "rail" ? RAIL.min : LIST.min}
      aria-valuemax={max}
      aria-valuenow={now}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onPointerUp}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  );
}

/**
 * Mounted once by `AppShell`, inside `.deck`. Renders the rail's separator in place and the
 * list's into whichever split view is standing.
 */
export function ColumnHandles() {
  const t = useTranslations("columns");
  const state = useRef<ColumnState>({});
  const [mounted, setMounted] = useState(false);
  const [listHost, setListHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // The record read into memory, so a drag starts from what is stored rather than from the
    // default — AND APPLIED, which looks redundant beside the pre-paint stamp and is not.
    //
    // In production the stamp has already written exactly these two properties and this is an
    // idempotent no-op. Where it has NOT run — a host that mounts the shell without the boot
    // script (the render harness does), a page whose inline script was refused by a policy —
    // the store would hold 288 while the screen stood at 224, and the first nudge would jump
    // to 240: the widths and the record silently disagreeing, which is worse than either
    // number. Applying here means the stamp is an optimisation (no flash) rather than the
    // only writer, and the two files stop depending on each other's order.
    const restored = readColumns();
    state.current = restored;
    applyColumnVars(document.documentElement, restored);
    setMounted(true);
  }, []);

  // NO dependency list, on purpose: the portal's host is whichever `.list-col` the mounted
  // view rendered, and the honest trigger for re-resolving it is "this component rendered",
  // which happens on every route change. A dependency list here would be a second, weaker
  // statement of the same thing, and the body is a `querySelector` and an identity compare.
  useEffect(() => {
    const next = document.querySelector<HTMLElement>(LIST_SEL);
    setListHost((prev) => (prev === next ? prev : next));
  });

  if (!mounted) return null;
  return (
    <>
      <Handle kind="rail" label={t("railHandle")} state={state} />
      {listHost ? createPortal(<Handle kind="list" label={t("listHandle")} state={state} />, listHost) : null}
    </>
  );
}
