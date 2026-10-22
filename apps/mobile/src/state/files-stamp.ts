/**
 * A SURFACE THAT DRAWS FILES OR EVENT CARDS SUBSCRIBES TO THEM (re-exported by `world.tsx`). A
 * list, a part's byte state and the calendar texts land as engine notifications that move no stamp
 * the world derives from, so a card whose texts arrived after the body would never draw. The
 * fingerprint is over these ids alone: each list's state, each part's byte state, and the identity
 * of the calendar texts map, which the engine replaces when texts land.
 */
import { useCallback, useSyncExternalStore } from "react";
import { useConnection } from "../net/connection";

const MAP_SERIALS = new WeakMap<object, number>();
let lastSerial = 0;
function serialOf(map: object): number {
  let n = MAP_SERIALS.get(map);
  if (n === undefined) MAP_SERIALS.set(map, (n = ++lastSerial));
  return n;
}

export function useFilesStamp(ids: readonly string[]): string {
  const conn = useConnection();
  const engine = conn.state.k === "live" ? conn.state.session.engine : null;
  const key = ids.join("\u0000");
  const snapshot = useCallback(() => {
    if (!engine || key === "") return "";
    return key.split("\u0000").map((id) => {
      const held = engine.attachmentsOf(id, { includeInlineParts: true });
      if (held.state !== "ready") return `${id}:${held.state}`;
      return `${id}:${held.items.map((i) => `${i.id}=${i.state}`).join(",")}:cal${serialOf(engine.calendarTextsOf(id))}`;
    }).join("|");
  }, [engine, key]);
  return useSyncExternalStore(
    useCallback((cb: () => void) => (engine ? engine.subscribe(cb) : () => undefined), [engine]),
    snapshot,
  );
}
