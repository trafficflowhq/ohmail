/**
 * DRAFTING A REPLY FROM THE DESKTOP WINDOW — the transport (`draft-reply-wire.ts`'s two calls)
 * and nothing else. Both go down the private pipe to the engine, on every engine-backed door, and
 * neither probes a mail server, so both keep the bridge's one-minute deadline. On the standalone
 * door the engine's drafting service answers with the model this install chose; paired, the host
 * computer's engine does; on the account door the engine relays to the account's server, which
 * meters them. Which door also decides who can connect a missing model, so it picks the sentence.
 */

import { bridgeAvailable, bridgeFetch, type EngineStatus } from "./bridge-fetch.js";
import type { DraftReplyWire } from "../../webapp/app/shell/draft-reply.js";
import { isDesktopHost } from "./doors.js";
import { draftReplyVia } from "./draft-reply-wire.js";

const available = (): boolean => bridgeAvailable();

/** The account door: only the account's operator connects a drafter, so its sentence stands. */
export const draftReplyOverBridge: DraftReplyWire = draftReplyVia(bridgeFetch, available);
const standalone: DraftReplyWire = draftReplyVia(bridgeFetch, available, "noModelHere");
const paired: DraftReplyWire = draftReplyVia(bridgeFetch, available, "noModelHost");

/** The wire for this door. Module constants, so the shell's hook sees one identity per door. */
export function draftReplyOverBridgeFor(status: EngineStatus | null): DraftReplyWire {
  if (isDesktopHost(status)) return paired;
  return status?.mode === "local" ? standalone : draftReplyOverBridge;
}
