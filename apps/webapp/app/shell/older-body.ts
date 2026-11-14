"use client";

/**
 * The reach-past body door — a session-held body for the rows `useOlderMail` fetched from beyond the mirror window. A
 * reach-past row is deliberately not a mirror row, and the engine's body machinery keys on the mirror (`bodyPlan`
 * answers `skip` for an id the mirror does not hold), so opening one never issued a request: the stall timer expired
 * over a fetch that never started, rendered "Couldn't load the full message" with a Retry, and the Retry re-ran the
 * same skip — a control whose promise could never be kept.
 */

/**
 * The mechanics are the engine's (`createSessionBodyDoor`); what lives here is this door's own: the wire, the
 * `reopenFailed: false` policy (a failed row re-asks only on the human press), and the rendering of held phases into
 * `MessageBody`'s own vocabulary.
 */

/**
 * The phases: not asked → `snippet` (the surface asks via `open` when the row shows); in flight →
 * `loading`; delivered → `full`; policy-emptied → `withheld` with the server's marker (no Retry, the
 * honest terminal); 404/410 → `withheld: "expunged"` — the account no longer holds the row, a
 * retry cannot change it, and `failed` would offer a Retry that cannot work, the exact defect this
 * module removes; transport/5xx → `failed`, where the Retry is real (`open(id, { retry: true })`
 * dispatches a fresh request even while a hung first ask still shows `loading`). Nothing writes to
 * the mirror or IndexedDB: closing the app forgets it — the rows' own lifetime.
 */

import { useOlderBodyDoor, type OlderBodyDoor } from "@ohmail/app-logic/reader";
import {
  narrowOlderBody, type OlderBodyOutcome, type OlderBodyWire,
} from "@ohmail/client-engine";
import { api, ApiError, apiConfigured } from "../api-client";

// The seam types are the engine's now; re-exported so this door's consumers (`AppShell`, the
// desktop's transports) keep importing them from the door they bind.
export { narrowOlderBody, type OlderBodyOutcome, type OlderBodyWire };

/**
 * The hosted transport — the browser asking the API this app was written against. The same
 * `GET /messages/:id/body` the engine's adapter uses for mirror rows: ownership is proven
 * server-side through `messages`, and the withheld markers ride the same field. Not
 * `olderBodyVia`: the Cloud client's `api()` carries the session's own error contract
 * (`ApiError` with the status), so the narrowing binds to that rather than to a raw Response.
 */
export const cloudOlderBodyFor = (expectedOwner?: string): OlderBodyWire => ({
  body: async (messageId) => {
    try {
      return narrowOlderBody(
        await api<Record<string, unknown>>(`/messages/${encodeURIComponent(messageId)}/body`, { expectedOwner }),
      );
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
        return { kind: "gone" };
      }
      throw err;
    }
  },
});

export const CLOUD_OLDER_BODY = cloudOlderBodyFor();

export type { OlderBodyDoor } from "@ohmail/app-logic/reader";

export function useOlderBody(
  active: boolean,
  transport?: OlderBodyWire,
  mayRead?: () => boolean,
): OlderBodyDoor {
  return useOlderBodyDoor(active ? transport ?? (apiConfigured() ? CLOUD_OLDER_BODY : undefined) : undefined, mayRead);
}
