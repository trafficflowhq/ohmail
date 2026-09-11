/**
 * THE PROFILE-IMPORT CARD'S THREE CALLS — over an injected transport, and with no door here.
 *
 * The card is the shared client's (`app/shell/ProfileImportCard.tsx`); the route, the narrowing
 * and the engine's-own-sentence rule for a refusal are here, once, for every door that carries
 * them: the desktop window over its bridge (`local-profile-import.ts`) and the served host client
 * over its bearer socket (`host-client/transports.ts`).
 *
 * The factory lives in a module that imports no transport because the served host client has no
 * bridge — sharing a file with the window's bridge binding put the shell command's name into the
 * bundle a phone is handed, which `scan:host` refuses. The fetch shape is spelled here rather than
 * imported from the bridge for the same reason, and it is the LOOSE one on purpose: `init` is
 * `unknown` so both of the adapter option declarations this source is published beside accept it.
 */

import type { ProfileImportTransport } from "../../webapp/app/shell/ProfileImportCard";
import type { ProfileImportAppliedWire, ProfileImportCandidateWire } from "../../webapp/app/api-client";

/** The transport shape the three calls ride — the bridge's, without importing the bridge. */
export type ProfileImportFetch = (url: string, init?: unknown) => Promise<Response>;

/**
 * The mailbox group's confirm route, addressed root-relative like every path in this window.
 *
 * Exported so the suite pins the LITERAL: every other assertion addresses this function, so a
 * wrong path here would leave them all green around a transport the engine answers 404 to.
 * It is the hosted API's own endpoint too (`packages/api/src/routes/mailboxes.ts`), which is
 * what lets one transport serve both doors — locally answered on one, forwarded on the other.
 */
export const profileImportPath = (mailboxId: string): string =>
  `/mailboxes/${encodeURIComponent(mailboxId)}/profile-import`;

/** The engine's own sentence for a refusal, or the status line when it composed none. */
async function refusal(res: Response): Promise<Error> {
  let said: string | undefined;
  try {
    said = ((await res.json()) as { error?: { message?: string } }).error?.message;
  } catch {
    /* Not JSON, or an empty body. The status is all there is. */
  }
  return new Error(said ?? `the mail engine answered ${res.status}`);
}

async function wireOf<T>(res: Response): Promise<T> {
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as T;
}

/**
 * The three calls the shared card makes, over an injected transport function.
 *
 * A factory over the FETCH rather than over anything else, because the desktop now has two
 * consumers of the same three routes and the same refusal contract: the window (the bridge down
 * the pipe) and the served host-client (the loopback socket, bearer-authenticated — see
 * `host-client/transports.ts`). The wire narrowing and the engine's-own-sentence rule live once,
 * here, whichever transport carries the bytes.
 */
export function profileImportVia(fetchImpl: ProfileImportFetch): ProfileImportTransport {
  return {
    candidate: async (mailboxId) =>
      wireOf<ProfileImportCandidateWire>(await fetchImpl(profileImportPath(mailboxId))),
    apply: async (mailboxId, fingerprint) =>
      wireOf<ProfileImportAppliedWire>(
        await fetchImpl(profileImportPath(mailboxId), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fingerprint }),
        }),
      ),
    decline: async (mailboxId, subject) =>
      wireOf<{ dismissed: boolean }>(
        await fetchImpl(`${profileImportPath(mailboxId)}/decline`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(subject),
        }),
      ),
  };
}
