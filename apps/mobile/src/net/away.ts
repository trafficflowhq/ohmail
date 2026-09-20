import type { ConnectedSession } from "./pairing.js";
/* THE ONE BASE EVERY REQUEST IS COMPOSED OFF — see `request-base.ts`. */
import { requestBase } from "./request-base";
import type { AwayRow } from "../ui/away-form";

/**
 * The away responder over the paired door — `GET /away-responder` and `PUT /away-responder`, the
 * webapp `AwayResponderRow`'s exact route pair, so one control anywhere is every client's answer.
 * The route is in `localRoutes`, which means the standalone door this phone opens on itself
 * serves it too and its own engine runs the pass. Transport: `session.fetch` only, bound to one
 * origin. A read that could not be made answers `null` — never a default row, because a default
 * row is a shape a save would then WRITE (`PUT` is a full replace).
 */

/**
 * WHAT A SAVE DID — three answers, because two of them are not failures.
 *
 * `asked` is the route's 202: the edit wrote nothing on this server and a request is waiting on
 * the install that organizes this account's mailboxes, which is the ordinary state of a phone
 * reading a mailbox a laptop holds. Saying "Saved." over that is the false state the webapp's own
 * `asked` sentence exists to end. The row in `saved` and `asked` is the SERVER's, never the
 * values that were typed: what the controls show has to be what is stored.
 */
export type AwaySave =
  | { kind: "saved"; row: AwayRow }
  | { kind: "asked"; row: AwayRow }
  | { kind: "refused"; status: number | null };

function rowOf(body: Record<string, unknown>): AwayRow {
  return {
    enabled: body.enabled === true,
    body: typeof body.body === "string" ? body.body : null,
    startsAt: typeof body.startsAt === "string" ? body.startsAt : null,
    endsAt: typeof body.endsAt === "string" ? body.endsAt : null,
    /* The three the phone does not edit are read as WHATEVER THE SERVER SENT, not narrowed to a
       member this build knows: they are carried back verbatim on the next save, and a value this
       build filtered would be a value this phone silently took away from the account. */
    audience: typeof body.audience === "string" ? body.audience : "screened_in",
    throttle: typeof body.throttle === "string" ? body.throttle : "per_day",
    piles: Array.isArray(body.piles) ? body.piles.filter((p): p is string => typeof p === "string") : [],
    updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : null,
  };
}

/** Read the row. `null` is "could not ask", which is never "off" and never a row to save over. */
export async function readAway(session: ConnectedSession): Promise<AwayRow | null> {
  try {
    const res = await session.fetch(`${requestBase(session)}/away-responder`, { method: "GET" });
    if (res.status !== 200) return null;
    return rowOf((await res.json()) as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Save the WHOLE row — see `away-form.ts`'s header for why a partial write is a silent reset.
 * `updatedAt` is the server's and never sent; everything else goes exactly as composed.
 */
export async function saveAway(session: ConnectedSession, next: AwayRow): Promise<AwaySave> {
  const { updatedAt: _serverOwns, ...put } = next;
  try {
    const res = await session.fetch(`${requestBase(session)}/away-responder`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(put),
    });
    if (res.status === 202) return { kind: "asked", row: rowOf((await res.json()) as Record<string, unknown>) };
    if (res.status !== 200) return { kind: "refused", status: res.status };
    return { kind: "saved", row: rowOf((await res.json()) as Record<string, unknown>) };
  } catch {
    return { kind: "refused", status: null };
  }
}
