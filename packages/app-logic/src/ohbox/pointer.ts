/** The list's pointer: the long press that starts a selection on a phone, and the modifier clicks that pick. */
import type * as React from "react";
import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { DRAG_SLOP_PX } from "../lists/drag-slop.js";
import type { PickSet } from "./picks.js";
import type { OhboxListInput, OhboxPointer } from "./types.js";

/**
 * How long a finger must rest on a row before it starts a selection.
 *
 * 450ms is the figure both mobile platforms use for the same gesture, and the two directions of
 * error are not symmetric: shorter and a tap that lingers picks a row somebody meant to open;
 * longer and the gesture feels like a wait rather than a press. A constant and not a setting —
 * a knob here would be a knob about whether a tap means what it says.
 */
const LONG_PRESS_MS = 450;

/**
 * SHIFT-CLICK RANGES, intercepted in the CAPTURE phase.
 *
 * `MessageRow` lives in `@ohmail/ui` and its `onClick` takes no event, so the modifier is
 * unreachable from the row itself — and widening a shared design-system primitive for one
 * view's selection model is the wrong trade. Capture runs before the row's own handler, so
 * `stopPropagation` here means a shift-click extends the range INSTEAD of moving the cursor,
 * rather than doing both.
 */
/**
 * Entering a selection on a phone — a long press on a row. A phone had NO way in: `x` needs a
 * keyboard, ⇧-click a modifier, and a tap is the open — every verb the selection bar offers
 * was desktop-only. The hold is the gesture both platforms already use for "start selecting"
 * in a list, so it is the one to implement: a checkbox on every row would cost the row its
 * lead alignment for a mark the rail already makes, and a hover-reveal has no touch
 * equivalent.
 */

/**
 * Four conditions, each keeping this gesture out of another's way: `pointerType === "touch"` — a mouse hold is a
 * click somebody is taking their time over, and the desktop has `x` and ⌘-click; 450ms — long enough not to fire on
 * a lingering tap, the figure both platforms use; no travel past `DRAG_SLOP_PX` — a moving finger is scrolling, and
 * a selection mid-scroll would be the worst surprise (same threshold the drag-to-file gesture uses, imported — and
 * `drag-file.ts` returns early on touch, so the two cannot both arm on one pointer); and the press that fired is
 * not also a TAP — the `click` after a hold would open the reader over the selection that just appeared, so the
 * next one is swallowed. `contextmenu` is prevented while the timer runs: Android fires it on a long press, and
 * iOS's callout is covered by `-webkit-touch-callout: none` on `.row`.
 */
export function useOhboxPointer(input: OhboxListInput, { togglePick, pickRangeTo }: PickSet): OhboxPointer {
  const holdRef = useRef<{ id: string; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(
    null,
  );
  /** A hold FIRED, so the `click` closing the same press is not a tap. Cleared by that click. */
  const heldRef = useRef(false);

  const cancelHold = useCallback(() => {
    if (holdRef.current) clearTimeout(holdRef.current.timer);
    holdRef.current = null;
  }, []);

  const onHoldPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      cancelHold();
      /* A NEW PRESS ENDS THE LAST ONE'S CLAIM ON THE NEXT CLICK. The swallow flag is normally
       cleared by the `click` that closes the hold's own press — but that click is not
       guaranteed: Android suppresses it after some long presses, and a flag left standing would
       eat the next unrelated tap instead, which on a phone is the tap that adds the second row.
       Bounding it to the press that set it costs one line and removes the whole class. */
      heldRef.current = false;
      if (e.pointerType !== "touch") return;
      const row = (e.target as HTMLElement).closest<HTMLElement>(input.rowSelector);
      const id = row?.dataset.id;
      if (!id) return;
      /* The circle selects on click. Do not also toggle it when a touch lingers. */
      if (input.avatarSelector !== null && (e.target as HTMLElement).closest(input.avatarSelector)) return;
      holdRef.current = {
        id,
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          holdRef.current = null;
          heldRef.current = true;
          togglePick(id);
        }, LONG_PRESS_MS),
      };
    },
    [cancelHold, togglePick, input.rowSelector, input.avatarSelector],
  );

  const onHoldPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const h = holdRef.current;
      if (!h) return;
      if (Math.hypot(e.clientX - h.x, e.clientY - h.y) >= DRAG_SLOP_PX) cancelHold();
    },
    [cancelHold],
  );

  /** The hold's own press must not also open the row — see `heldRef`. */
  const onHoldClickCapture = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (!heldRef.current) return;
    heldRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  useEffect(() => cancelHold, [cancelHold]);

  const onRangeClickCapture = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      /* ⌘/Ctrl TOGGLES ONE ROW AND NEVER MOVES THE CURSOR — the standard single-pick every list
       on both platforms has, and until now the only modifier-less way to pick was the keyboard
       (`x` at the cursor), so a mouse user could build a RANGE and could not build a scattered
       set. ⇧ still extends. Both are additive; neither opens the message. */
      const pick = e.shiftKey ? pickRangeTo : e.metaKey || e.ctrlKey ? togglePick : null;
      if (!pick) return;
      const id = (e.target as HTMLElement).closest<HTMLElement>(input.rowSelector)?.dataset.id;
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      pick(id);
    },
    [pickRangeTo, togglePick, input.rowSelector],
  );

  const pointer: OhboxPointer = {
    onClickCapture: (e) => {
      onHoldClickCapture(e);
      onRangeClickCapture(e);
    },
    onPointerDownCapture: onHoldPointerDown,
    onPointerMoveCapture: onHoldPointerMove,
    onPointerUpCapture: cancelHold,
    onPointerCancelCapture: cancelHold,
    onContextMenuCapture: (e) => {
      if (holdRef.current) e.preventDefault();
    },
  };
  return pointer;
}
