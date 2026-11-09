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

/**
 * MORE ON TWO PANES is a pair too: its rows beside the destination one opened, the selection the
 * More route's `open` param, keyed `settings`, `history`, `search`, `triage[:<pile>]`, `drafts`,
 * `trash`, `away`, `servers`, `scheduled`, `tag:<id>` or `folder:<id>`. {@link morePaneKeyOf}
 * names a route as its key (null: no pane shows it), {@link morePathOf} is the pushed route a key
 * goes back to when the pane goes, and {@link morePaneRouteFor} is the inverse move of
 * {@link paneRouteFor}: a destination shown full-screen on two panes lands in More's pane.
 */
export type MoreHref = string | { pathname: string; params?: Record<string, string | undefined> };

const MORE_PLAIN = new Set(["settings", "history", "search", "drafts", "trash", "away", "servers", "scheduled"]);

export function morePaneKeyOf(to: MoreHref): string | null {
  const [path, query] = typeof to === "string" ? to.split("?", 2) as [string, string | undefined] : [to.pathname, undefined];
  const pile = typeof to === "string" ? new URLSearchParams(query ?? "").get("pile") : to.params?.pile;
  const [, head, rest, extra] = path.split("/");
  if (head === undefined || extra !== undefined) return null;
  if (rest === undefined) {
    if (head === "triage") return pile ? `triage:${pile}` : "triage";
    return MORE_PLAIN.has(head) ? head : null;
  }
  if ((head === "tag" || head === "folder") && rest !== "") return `${head}:${decodeURIComponent(rest)}`;
  return null;
}

export function morePathOf(key: string): string | null {
  const at = key.indexOf(":");
  const head = at < 0 ? key : key.slice(0, at);
  const arg = at < 0 ? null : key.slice(at + 1);
  if (arg === null) return MORE_PLAIN.has(head) || head === "triage" ? `/${head}` : null;
  if (arg === "") return null;
  if (head === "triage") return `/triage?pile=${encodeURIComponent(arg)}`;
  if (head === "tag" || head === "folder") return `/${head}/${encodeURIComponent(arg)}`;
  return null;
}

export function morePaneRouteFor(key: string): { pathname: string; params: { open: string } } {
  return { pathname: "/more", params: { open: key } };
}
