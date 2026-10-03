import type { WaitingRequestWire, WaitingTargetWire } from "./types.js";

/** The route the waiting list is read from. */
export const ORGANIZER_REQUESTS_PATH = "/organizer-requests";

const STATES: ReadonlySet<string> = new Set(["pending", "sent", "applied", "expired", "refused"]);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * `GET /organizer-requests`'s body, read defensively and door-free (no fetch here, so any surface
 * may import it). A row that does not parse is dropped; a body that is not a list throws, because
 * an empty list would say nothing waits when the answer was simply unreadable.
 */
export function waitingRequestsOf(body: unknown): WaitingRequestWire[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error("GET /organizer-requests answered something that is not a list");
  const out: WaitingRequestWire[] = [];
  for (const raw of items) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r !== "object") continue;
    const id = str(r.id); const kind = str(r.kind); const state = str(r.state);
    const mailboxId = str(r.mailboxId); const decidedAt = str(r.decidedAt);
    if (!id || !kind || !state || !STATES.has(state) || !mailboxId || !decidedAt) continue;
    const holder = r.holder as { name?: unknown } | null;
    out.push({
      id, kind, state: state as WaitingRequestWire["state"], mailboxId, decidedAt,
      holder: { name: str(holder?.name) },
      resolvedAt: str(r.resolvedAt), refusedReason: str(r.refusedReason),
      target: (r.target && typeof r.target === "object" ? r.target : { unknown: true }) as WaitingTargetWire,
    });
  }
  return out;
}
