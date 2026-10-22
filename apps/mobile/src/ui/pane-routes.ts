/**
 * Where a full-screen message migrates when the window gains a second pane (unfolding the
 * Duo, rotating the iPad onto the route): the surface whose LIST belongs beside it, carrying
 * the open id as the `open` param the list-detail screens read. Pure, so the continuity test
 * drives it as data. `null` keeps the reader full-screen — mail held at the gate belongs to
 * its sender's decision screen, and a folder row does not carry its folder's id, so those two
 * stay where they are rather than land beside the wrong list.
 */
import type { WorldMail } from "../state/world";

export function paneRouteFor(
  m: Pick<WorldMail, "id" | "place" | "historyPlace" | "gateHeld" | "folderLeaf">,
): { pathname: string; params: { open: string } } | null {
  if (m.gateHeld === true || m.folderLeaf !== undefined) return null;
  if (m.historyPlace !== undefined) return { pathname: "/history", params: { open: m.id } };
  if (m.place === "reads") return { pathname: "/reads", params: { open: m.id } };
  if (m.place === "receipts") return { pathname: "/receipts", params: { open: m.id } };
  return { pathname: "/", params: { open: m.id } };
}

/**
 * THE OHBOX ARM OF {@link paneRouteFor}, as a predicate: the message stands in the Ohbox (not
 * History, not held at the gate, not in one of the account's own folders). There the reader shows
 * the thread-read presentation (tint, rail, Mark unread in ⋯) and the open reads nothing by itself;
 * `state/live.ts#standsInOhbox` is the same question asked of the projection.
 */
export function standsInOhboxMail(m: Pick<WorldMail, "place" | "historyPlace" | "gateHeld" | "folderLeaf">): boolean {
  return m.gateHeld !== true && m.folderLeaf === undefined && m.historyPlace === undefined && m.place === "ohbox";
}
