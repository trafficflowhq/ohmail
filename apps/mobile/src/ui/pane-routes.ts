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
