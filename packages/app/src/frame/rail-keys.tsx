/**
 * THE RAIL AND THE KEYS. The zone walk (`h` and ← toward the rail, Escape back) is told where the frame's rail stands:
 * at the side where the plan draws it in words, else nowhere until More puts the whole rail up over the app. A step
 * toward a rail that does not stand at the side puts it up, as today's drawer was summoned.
 *
 * A rail put up stays up while the window is widened (the plan then draws it at the side, and its sheet is not
 * drawn): Escape takes it down, as today's shell's Escape ladder took its drawer down. Whenever it comes down while it
 * holds the keys, they go to the list's row, never to a rail nobody put up (today: "focus leaves the drawer with the
 * drawer"). While the sheet stands it answers its own Escape.
 */
import { useEffect, useRef } from "react";
import { leaveRail, setRailSummon, setRailZone, useKeyBindings } from "@ohmail/app-logic/keys";
import { useTextLookup } from "../text/index.js";

/** The box every rail of the frame stands in (`SideRail`), drawing nothing. */
export const RAIL_BOX = "fr-railzone";
/** The whole rail over the app (More's sheet). */
export const RAIL_SHEET = "fr-railsheet";

export function RailKeys({
  side,
  up,
  put,
}: {
  /** A rail stands at the side at this width. */
  readonly side: boolean;
  /** The rail is put up (More, or a step toward it). */
  readonly up: boolean;
  readonly put: (up: boolean) => void;
}) {
  useEffect(() => {
    setRailZone({
      rail: `.${RAIL_BOX}, .${RAIL_SHEET}`,
      current: '[aria-current="page"]',
      up: `.${RAIL_SHEET}`,
      side,
    });
    return () => setRailZone(null);
  }, [side]);
  useEffect(() => {
    setRailSummon(() => put(true));
    return () => setRailSummon(null);
  }, [put]);
  const was = useRef(up);
  useEffect(() => {
    const before = was.current;
    was.current = up;
    if (before && !up) leaveRail();
  }, [up]);
  return up && side ? <RailDownKey put={put} /> : null;
}

/** Escape takes down a rail put up and since drawn at the side. */
function RailDownKey({ put }: { readonly put: (up: boolean) => void }): null {
  const label = useTextLookup()("shortcuts")("escape");
  useKeyBindings([{ chord: "Escape", group: "app", label, inInput: true, run: () => put(false) }], "overlay");
  return null;
}
