/**
 * THE LIVE TRASH WINDOW IN THE DESKTOP WINDOW — the transport, and deliberately nothing else.
 *
 * The window itself — the page, the honest states, the session body cache — is the shared shell's
 * (`shell/trash-window.ts`), exactly as `local-junk.ts` says about the Junk one. Only the wire
 * differs: this window's content policy is `connect-src 'none'` and the Cloud client is aliased to
 * a refusing stub, so every ask goes down the pipe to the mail engine on this machine.
 *
 * BOTH DOORS, ONE WIRE. The standalone door mounts `localRoutes`, which spreads `trashRoutes`, so
 * `/trash/window*` is served from this machine. The hosted door has no mirror entry for those paths
 * — a live read of the provider's own \Trash is the one question a mirror cannot answer — so they
 * fall through to the write-through proxy and are answered by the hosted account (`relay-allowlist`
 * carries all three). The wire is handed in on both doors regardless.
 *
 * The requests themselves — the two paths, the epoch, the status contract and the GET-only rule —
 * are `trash-wire.ts`'s, which imports no door so the served host client can share them.
 */

import { bridgeFetch } from "./bridge-fetch.js";
import type { TrashWire } from "../../webapp/app/shell/trash-window";
import { trashVia } from "./trash-wire.js";

export { TrashBridgeError, trashVia } from "./trash-wire.js";

export const trashOverBridge: TrashWire = trashVia(bridgeFetch);
