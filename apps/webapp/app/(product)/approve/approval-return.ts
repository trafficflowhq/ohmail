/**
 * WHERE A SIGNED-OUT BROWSER COMES BACK TO after the ordinary sign-in, for the approval page.
 *
 * An ID and never a URL: the page keeps the request id it was opened with in this tab's
 * `sessionStorage`, and the login screen asks for it once, afterwards. No `?next=` exists, so no
 * link can send a sign-in anywhere; a value that is not a request id, or one older than the
 * request can live, is dropped. The two writes go through the per-tab durable door, so a jar that
 * refuses them is told the way every other refused write is.
 */

import { durableSessionRemove, durableSessionSet } from "../../shell/durable";

const KEY = "ohmail.approve.request";
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Longer than the request's own five minutes, so a slow sign-in still comes back. */
const KEEP_MS = 10 * 60_000;

export function isApprovalId(value: string): boolean {
  return ID_RE.test(value);
}

export function rememberApprovalRequest(id: string, now = Date.now()): void {
  if (!isApprovalId(id)) return;
  durableSessionSet(KEY, JSON.stringify({ id, at: now }), "approve.return");
}

/** The page to return to, once, or null. Reading it removes it. */
export function takeApprovalReturn(now = Date.now()): string | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  durableSessionRemove(KEY, "approve.return");
  try {
    const kept = JSON.parse(raw) as { id?: unknown; at?: unknown };
    const id = typeof kept.id === "string" ? kept.id : "";
    const at = typeof kept.at === "number" ? kept.at : 0;
    if (!isApprovalId(id) || now - at > KEEP_MS || now < at) return null;
    return `/approve?request=${id}`;
  } catch {
    return null;
  }
}
