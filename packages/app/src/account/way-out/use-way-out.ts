import { useCallback, useMemo, useState } from "react";
import { WAY_OUT_START, wayOutStep, type WayOutDoor, type WayOutModel, type WayOutSection } from "./model.js";

/**
 * The card's model over its door. Drawing it opens nothing: a browser is asked for by the press, once per press.
 * It holds one fact, whether the last press started a browser, and nothing to guard: an answer that lands after the
 * card was left has nowhere to go.
 */
export function useWayOut(door: WayOutDoor, section: WayOutSection): WayOutModel {
  const [state, setState] = useState(WAY_OUT_START);
  const open = useCallback(() => {
    void door.open().then((opened) => setState((was) => wayOutStep(was, { kind: "answered", opened })));
  }, [door]);
  return useMemo(() => ({ section, ...state, open }), [section, state, open]);
}
