/**
 * WHAT A PLACE'S SEAT HANDS ITS LIVE HOOK: the frame's side of a place, as the one record `@ohmail/app-logic` types
 * (`PlaceLiveArgs`). A seat calls this once and its place's `use<Place>Live` once, and stands what that answers
 * above the place's columns:
 *
 *     const model = useHistoryLive(usePlaceLiveArgs());
 *
 * One record while nothing of it moved, with the scope the frame is mounted under. It throws where no room is on
 * (`usePress`): a place that presses stands over a host that hands a ground above the panes, or a reader.
 */
import { useContext, useMemo } from "react";
import type { PlaceLiveArgs } from "@ohmail/app-logic/lists";
import { FrameContext, useEntered, useFrame } from "./commands.js";
import { isCalendarPlace } from "./product.js";
import { usePress } from "./room.js";

export function usePlaceLiveArgs(): PlaceLiveArgs {
  const { host, route, plan, commands, report } = useFrame();
  const press = usePress();
  const entered = useEntered();
  const initialPlace = useContext(FrameContext)?.initialPlace;
  const scope = host.session.scope;
  /* Under the frame's own gate every mounted part has a scope; a part mounted outside it has no account to keep under. */
  if (scope === null) throw new Error("usePlaceLiveArgs: a place stands under no scope");
  /* A seat is mounted with its own place's columns, so the address names a mail place wherever one calls this. */
  const place = route.place;
  if (isCalendarPlace(place))
    throw new Error("usePlaceLiveArgs: a mail place's seat stands at a calendar place");
  return useMemo(
    () => ({ press, scope, route: { ...route, place }, commands, plan, report, entered, initialPlace }),
    [press, scope, route, place, commands, plan, report, entered, initialPlace],
  );
}
