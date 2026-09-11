/**
 * THE REACH-PAST BODY WIRE IN THE DESKTOP WINDOW — the transport and nothing else. The door
 * itself is the shared shell's (`shell/older-body.ts`, over `createSessionBodyDoor`); this
 * window's Cloud client is a refusing stub under `connect-src 'none'`, so the ask goes down
 * the pipe to the engine on this machine. The wire is `olderBodyVia` (`@ohmail/client-engine`),
 * imported directly by the LAN host client's bearer transport (`host-client/transports.ts`);
 * this file supplies only `bridgeFetch`. The hosted door serves `GET /messages/:id/body` from
 * the mirror or forwards a reach-past row (`cloud-engine.ts`). A 404/410 means the row is gone
 * — the door's terminal sentence; every other refusal renders `failed` with a real Retry.
 */

import { olderBodyVia, type OlderBodyWire } from "@ohmail/client-engine";
import { bridgeFetch } from "./bridge-fetch.js";

export const olderBodyOverBridge: OlderBodyWire = olderBodyVia(bridgeFetch);
