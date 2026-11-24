import type { PlaceEntry } from "../../src/frame/contract.js";

/**
 * A registration as a host that stands the place's model itself takes it: without its seat and without the rail group
 * it draws, both of which read the mail ground such a host does not stand.
 */
export function unseated(entry: PlaceEntry): PlaceEntry {
  const { railGroup: _drawn, ...rest } = entry;
  if (rest.panes.kind !== "columns") return rest;
  const { Above: _seat, keepsOpen: _kept, ...panes } = rest.panes;
  return { ...rest, panes };
}
