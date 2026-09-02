"use client";

/**
 * THE TWO COLUMN SEPARATORS — and the handle IS the gap.
 *
 * The shell stands in three tiles and the two seams between them are now draggable. There is
 * no grip and there are no dots: a tiling compositor has neither, the gap between windows is
 * where you drag, the cursor says so and the border is what lights. So each handle is an
 * invisible strip exactly one tile gap wide, whose only visible part is a centre line at the
 * ring's own width — a hairline under paper, the face's 2px under ohmarchy — that appears on
 * hover and turns to the focus accent while it is dragged or focused. Paper is quieter by the
 * same rule rather than by a second one; the whole appearance is in `column-handles.css` and
 * is token reads only. What the numbers may be, where they are stored and how they reach CSS
 * is `column-store.ts`.
 *
 * ── WHY THE LIST HANDLE IS A PORTAL AND THE RAIL HANDLE IS NOT ──────────────────────────────
 *
 * A handle has to be positioned against the column whose width it changes, and the two columns
 * live in different places. The rail's is easy: the rail is a child of `.deck` with a width
 * this file controls, so its handle is a child of `.deck` too, at `--gap-edge + <the rail's
 * clamp>` — an expression CSS can evaluate on its own.
 *
 * The list's cannot be written that way. Its left edge is the resolved size of a `minmax()`
 * grid track, which no `calc()` can name, so the handle has to hang off the list column
 * itself. Eight views render that column (through `ListPane`, `packages/ui`), and none of them
 * should have to know this feature exists — so the handle is PORTALLED into whichever
 * `.view.split > .list-col` is mounted, and the target is re-resolved after every render of
 * this component. That is cheap (a `querySelector` and an identity compare) and it is the only
 * thing that has to happen when a view swaps, because the views are keyed on the route in
 * `AppShell` and a route change re-renders this component too.
 *
 * The alternative — measuring the column and gluing the handle to its right edge with a
 * `ResizeObserver` — was rejected: it fires on the list's own width but not on the rail's, so
 * it needed a second listener for a case the portal does not have at all.
 *
 * ── THE KEYS ARE THE WIDGET'S OWN, AND DELIBERATELY NOT IN THE REGISTRY ─────────────────────
 *
 * ←/→ move by 16px, with Shift by 64, Home/End go to the floor and the ceiling, Backspace or
 * Delete resets — but ONLY while the handle holds focus, and the handler CLAIMS the event so
 * nothing else acts on it. That is what keeps the zone model's own ←/→ intact, and the moment
 * focus leaves the handle every key means what it always meant.
 *
 * Claiming it takes `stopImmediatePropagation` on the native event and not `stopPropagation`,
 * for a reason that is invisible from this file and is written out at the handler itself: on
 * the web door React and the keyboard registry are two bubble listeners on the SAME node, and
 * `stopPropagation` does nothing about a sibling. An earlier draft of this paragraph asserted
 * the opposite; it was wrong, and the guard now watches the call rather than the outcome
 * because no test DOM can tell the two apart.
 *
 * These are not app verbs and they get no chord in the registry, for the same reason the rich
 * editor's and a `<select>`'s keys have none: the `?` sheet lists what the app does, and a
 * widget's own keys belong to the widget you are standing in. The handle is reached by Tab —
 * it sits in the tab order between the rail and the list, and between the list and the reader
 * — which is also the whole discoverability story a separator is entitled to.
 *
 * ── NOTHING IS RENDERED UNTIL AFTER MOUNT ───────────────────────────────────────────────────
 *
 * `aria-valuenow` is a measurement, and the server has no layout — rendering a guess and then
 * correcting it is a hydration mismatch that React resolves by KEEPING THE SERVER'S value, so
 * the announced width would be permanently wrong. The handles are invisible chrome, so the
 * honest fix is to not render them in the SSR pass at all. The widths themselves do not wait
 * for this: they are stamped on `<html>` before first paint by the boot script, so the columns
 * are already the right size in the frame before these handles exist.
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
   * The column's REAL width — the on-screen one, not the stored one, and the difference
   * matters: the list's ceiling is `min(<chosen>, <the room>)`, so on a window too narrow to
   * honour a stored 720 the column stands at whatever the room allows, and a ← that stepped
   * from 720 would need a dozen presses before anything moved. Every step is relative to what
   * is in front of the reader.
   *
   * WHEN THERE IS NO LAYOUT TO READ the fallback is this handle's OWN last value and only then
   * the shipped default. A hard default here is a real defect and not a theoretical one: it
   * makes every press start again from 224, so two → presses land on 240 rather than 256 (found
   * by the keyboard walkthrough, which drives the real shell where jsdom measures nothing). The
   * same window exists in a browser — a column mid-transition, or one a view has just detached
   * — and the honest answer in both is "the number I last set", never "the number you never
   * chose".
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
   * LEAVE THE DRAG STATE BEHIND AND THE WHOLE SHELL IS UNUSABLE, so clearing it is a function
   * every exit calls rather than a line inside `onPointerUp`.
   *
   * `.deck.col-resizing` puts `cursor: col-resize !important` and `user-select: none !important`
   * on the deck and EVERY descendant and takes pointer events off every mail-body iframe. That
   * is correct for the half-second of a gesture and catastrophic if it sticks: nothing is
   * selectable, every cursor is a resize cursor and message bodies stop accepting clicks, until
   * the reader reloads. A pointerup is not guaranteed to arrive at this element — the list's
   * handle is portalled into whichever view is mounted, so a route change mid-gesture unmounts
   * it, and `setPointerCapture` can be refused — so the class is cleared on unmount and on
   * `lostpointercapture` as well as on release.
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
     * `stopImmediatePropagation` ON THE NATIVE EVENT, AND NOTHING ELSE — not `stopPropagation`,
     * and not both, because the first already does everything the second does.
     *
     * The first draft called only `stopPropagation`, on the stated but false premise that the
     * shell's dispatcher is "a bubble listener on `document`, so an event stopped at this
     * element never reaches it". Two reviews caught it before it reached anyone.
     *
     * The App Router hydrates the WHOLE DOCUMENT (`next/dist/client/app-index.js`:
     * `const appElement = document; hydrateRoot(appElement, …)`), so React's delegated keydown
     * listener and `keymap.tsx`'s `document.addEventListener("keydown", …)` are two bubble
     * listeners on the SAME node. `stopPropagation` only stops an event moving to the next
     * NODE; it does nothing about a second listener already attached to the one it is on. So
     * React's runs first, this handler stopped propagation, and the registry ran anyway — →
     * would widen the rail AND fire the zone model's "step into the reader", pulling focus off
     * the separator, which made keyboard resizing single-shot in a browser and fine on the
     * desktop (whose entry mounts at `#root`, below `document`).
     *
     * Only `stopImmediatePropagation` stops a sibling listener. `MoreMenu.tsx` measured this on
     * a deployed build and states the same mechanism; this is the sixth surface to need it.
     *
     * A TEST DOM CANNOT REPRODUCE IT — a harness mounts React into a `<div>`, where React's
     * listener really is below `document` and a plain `stopPropagation` really does work. So
     * the guard watches the CALL and not the outcome (`column-handles.test.tsx`), which is the
     * only thing that differs between the broken build and this one.
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
