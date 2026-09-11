/**
 * "WE FOUND YOUR OHMAIL SETTINGS ON THIS MAILBOX" IN THE DESKTOP WINDOW — the transport, and
 * deliberately nothing else.
 *
 * The card, the counts-in-words, the fingerprint-as-consent and the durable "Not now" are the
 * shared client's (`app/shell/ProfileImportCard.tsx`), rendered here unchanged. Only the wire is
 * different, and it has to be: this window's content policy is `connect-src 'none'` and
 * `offline-guard.ts` has replaced every browser API that could open a socket, so the Cloud
 * client is not merely unused here — `vite.config.ts` aliases it to a stub whose value exports
 * refuse. The three calls go down the pipe to the mail engine instead, exactly as the away
 * responder's two do (`local-away.ts`).
 *
 * ── BOTH DOORS, AND WHY THAT DIFFERS FROM THE RESPONDER ─────────────────────────────────────
 *
 * `local-away.ts` is wired on the HOSTED door alone, because nothing on the standalone door
 * SENDS an away reply. This wire is live on BOTH doors (`profileImportDoorFor` in `doors.js`),
 * and the difference is a fact about where the routes are served rather than a policy choice:
 *
 *  · STANDALONE — the engine on this machine mounts the three confirm routes on its own table
 *    (`localRoutes` carries the mailbox group) and answers them out of the store on this
 *    machine, dialling the user's own mailbox from the sealed credential for the fresh read.
 *    This door is the feature's whole point: a mailbox that arrives carrying another ohmail's
 *    settings — leave Cloud, install the app — is asked, here, before anything is applied.
 *  · HOSTED — the engine serves no such route from the mirror (`cloud-read.ts`'s table is
 *    deliberately mail-reads only) and forwards all three to the account with the bearer, so
 *    the question, the answer and the durable dismissal are the ACCOUNT's own — a browser tab's
 *    exact behaviour with one hop more, and a dismissal here dismisses everywhere.
 *
 * ── WHAT A REJECTION PROMISES ────────────────────────────────────────────────────────────────
 *
 * The shared card's contract ({@link ProfileImportTransport}): a rejection's `message` is the
 * ENGINE's own sentence, fit to show verbatim. That matters most on the 409 for a changed
 * document — "review them again before importing" is an instruction the generic retry line
 * does not give — so the wire reads the engine's error body rather than composing words of its
 * own, the same shape every transport in this directory keeps.
 *
 * The three calls themselves — the route, the narrowing and the refusal contract — are
 * `profile-import-wire.ts`'s, which imports no door so the served host client can share them.
 */

import { bridgeFetch } from "./bridge-fetch.js";
import type { ProfileImportTransport } from "../../webapp/app/shell/ProfileImportCard";
import { profileImportVia } from "./profile-import-wire.js";

export { profileImportPath, profileImportVia } from "./profile-import-wire.js";
export type { ProfileImportFetch } from "./profile-import-wire.js";

/**
 * The WINDOW's instance, over the bridge. A module constant rather than a per-render factory
 * call: it holds no state, and one object per module means the shell's `useProfileImport` sees a
 * stable identity across renders.
 */
export const profileImportOverBridge: ProfileImportTransport = profileImportVia(bridgeFetch);
