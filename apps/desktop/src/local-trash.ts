/**
 * THE LIVE TRASH WINDOW IN THE DESKTOP WINDOW — the transport, and deliberately nothing else.
 * The window itself is the shared shell's (`shell/trash-window.ts`); only the wire differs:
 * this window's content policy is `connect-src 'none'` and the Cloud client is a refusing
 * stub, so every ask goes down the pipe to the engine on this machine. The standalone door
 * mounts `localRoutes`, which spreads `trashRoutes`, so `/trash/window*` is served here; the
 * hosted door has no mirror entry — a live read of the provider's own \Trash is the one
 * question a mirror cannot answer — so those paths fall through to the write-through proxy
 * (`relay-allowlist` carries all three). The requests are `trash-wire.ts`'s, door-free.
 */

import { bridgeFetch } from "./bridge-fetch.js";
import type { TrashWire } from "../../webapp/app/shell/trash-window";
import { trashVia } from "./trash-wire.js";

export { TrashBridgeError, trashVia } from "./trash-wire.js";

export const trashOverBridge: TrashWire = trashVia(bridgeFetch);
