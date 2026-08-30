/**
 * THE REACH-PAST BODY WIRE IN THE DESKTOP WINDOW — the transport, and deliberately nothing else.
 *
 * The door itself — the session cache, the states, the one-ask-per-row rule, the honest terminal
 * for a row the account no longer holds — is the shared shell's (`shell/older-body.ts`, over the
 * engine's `createSessionBodyDoor`), exactly as `local-consent.ts` says about the consent
 * controls. Only the wire differs: this window's content policy is `connect-src 'none'` and the
 * Cloud client is aliased to a refusing stub, so the ask goes down the pipe to the mail engine
 * on this machine. The fetch-shaped wire itself — the narrowing and the status contract — is
 * `olderBodyVia` (`@ohmail/client-engine`), shared with the LAN host client's bearer transport
 * (`host-client/transports.ts`); this file supplies only `bridgeFetch`.
 *
 * On the HOSTED door the engine serves `GET /messages/:id/body` from its mirror when the message
 * is mirrored, and FORWARDS it to the hosted account when it is a reach-past row the mirror never
 * held (`cloud-engine.ts`'s fall-through) — so this one wire answers both shapes, and the answer
 * is the account's own stored row either way. A 404/410 down the pipe means the account no longer
 * holds the row, which the door renders as its terminal sentence rather than as a Retry that
 * cannot work; every other refusal rejects, which the door renders as `failed` with a real Retry.
 */

import { olderBodyVia, type OlderBodyWire } from "@ohmail/client-engine";
import { bridgeFetch } from "./bridge-fetch.js";

export { olderBodyVia };

export const olderBodyOverBridge: OlderBodyWire = olderBodyVia(bridgeFetch);
