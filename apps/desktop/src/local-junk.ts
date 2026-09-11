/**
 * THE JUNK WINDOW IN THE DESKTOP WINDOW — the transport, and deliberately nothing else.
 *
 * The window itself — the page, the honest states, the session body cache, the two rescue verbs,
 * the search-append and the one-time sweep offer — is the shared shell's (`shell/junk-window.ts`),
 * exactly as `local-older-body.ts` says about the reach-past body door. Only the wire differs:
 * this window's content policy is `connect-src 'none'` and the Cloud client is aliased to a
 * refusing stub, so every ask goes down the pipe to the mail engine on this machine.
 *
 * ── BOTH DOORS, ONE WIRE — and what each door does with it ──────────────────────────────────
 *
 * On the HOSTED door the engine has no `/screener/junk*` of its own: the routes are absent from
 * `cloud-read.ts`'s mirror table on purpose (a live read of the provider's own \Junk is the one
 * question a mirror can never answer — the window's defining property is that Junk is NEVER
 * mirrored), so they fall through to the write-through proxy and are answered by the hosted
 * account, which dials the mailbox under its own admission cap. The reach-past rule, verbatim:
 * a read whose answer is not in the mirror travels through to the server.
 *
 * On the STANDALONE door the engine mounts `localRoutes` — the screener table included — and its
 * organizer resolves the mailbox's native \Junk at connect (`findSpecialFolders`), so the routes
 * ARE served here, from this machine. What withholds the segment there today is not this wire but
 * the flag in front of it: the window exists only behind "Use folders", and the standalone door
 * cannot STORE that flag (the pane's standing condition, FOLDERS-SPEC.md §17). Not "has no consent
 * row" — that is the phrasing this line carried and it is false: `consentRoutes` are mounted on
 * `localRoutes`, so the row exists and is served, and the standalone door reads and writes its own
 * screening window through it. What is missing is the one FIELD: this engine mounts no folder verb,
 * so `withoutFoldersFlag` forces the flag off on the read and drops it on the write, and the
 * transport declares that as `foldersStorable: false` (`local-consent.ts`). The
 * wire is handed in on both doors regardless — `olderBodyOverBridge`'s transport-not-a-control
 * rule — so the day the standalone door grows a folders pane, the segment follows the switch with
 * no desktop change at all.
 *
 * The requests themselves — the paths, the status contract and the rescue verbs — are
 * `junk-wire.ts`'s, which imports no door so the served host client can share them.
 */

import { bridgeFetch } from "./bridge-fetch.js";
import type { JunkWire } from "../../webapp/app/shell/junk-window";
import { junkVia } from "./junk-wire.js";

export { JunkBridgeError, junkVia } from "./junk-wire.js";

export const junkOverBridge: JunkWire = junkVia(bridgeFetch);
