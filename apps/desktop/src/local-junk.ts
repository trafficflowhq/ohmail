/**
 * THE JUNK WINDOW IN THE DESKTOP WINDOW — the transport (`junk-wire.ts`'s requests) and nothing
 * else; the window itself is the shared shell's (`shell/junk-window.ts`). This window's Cloud
 * client is a refusing stub under `connect-src 'none'`, so every ask goes down the pipe to the
 * engine on this machine. On the HOSTED door `/screener/junk*` is absent from `cloud-read.ts`'s
 * mirror table (Junk is NEVER mirrored): the asks fall through to the write-through proxy under
 * the hosted account's own admission cap. On the STANDALONE door the routes ARE served
 * (`localRoutes`, `findSpecialFolders`) but sit behind "Use folders", a flag this door cannot
 * STORE (FOLDERS-SPEC.md §17; `withoutFoldersFlag`, `foldersStorable: false`, `local-consent.ts`).
 */

import { bridgeFetch } from "./bridge-fetch.js";
import type { JunkWire } from "../../webapp/app/shell/junk-window";
import { junkVia } from "./junk-wire.js";

export { JunkBridgeError, junkVia } from "./junk-wire.js";

export const junkOverBridge: JunkWire = junkVia(bridgeFetch);
