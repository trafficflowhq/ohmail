/**
 * THE HOST-CLIENT'S INJECTED WIRES — the window's transports, over the bearer socket. The
 * shared shell takes a handful of things it must not know how to fetch; this page is the
 * third consumer of the same seams, and the rule holds: the NARROWING and refusal contracts
 * live once, in the wire modules (`readMailboxFactsVia`, `profileImportVia`), and this file
 * supplies only the transport — the manager's fetch. Every wire module is DOOR-FREE, a build
 * fact: the factories once sat beside their bridge bindings, so importing one pulled
 * `bridge-fetch.ts` into the bundle a phone is handed — `scan:host` refuses that. They live
 * in `*-wire.ts` modules importing no transport; `host-client-no-engine-door.test.ts`
 */

/*
 * measures it on the built artifact.
 */

import type { JunkWire } from "../../../webapp/app/shell/junk-window";
import type { MailboxFacts } from "../../../webapp/app/shell/mail-state";
import type { ProfileImportTransport } from "../../../webapp/app/shell/ProfileImportCard";
import type { OlderBodyWire } from "../../../webapp/app/shell/older-body";
import type { TrashWire } from "../../../webapp/app/shell/trash-window";
import { olderBodyVia } from "@ohmail/client-engine";
import { junkVia } from "../junk-wire.js";
import { readMailboxFactsVia } from "../mailbox-facts-wire.js";
import { profileImportVia } from "../profile-import-wire.js";
import { trashVia } from "../trash-wire.js";
import type { BearerManager } from "./bearer.js";

/** The sync strip's mailbox facts — `GET /mailboxes` over the bearer, window rules verbatim. */
export function mailboxFactsOverBearer(bearer: BearerManager): () => Promise<MailboxFacts[]> {
  return () => readMailboxFactsVia(bearer.fetch);
}

/**
 * The profile-import card's three calls over the bearer. The rejection contract the shared card
 * relies on — the message is the ENGINE's own sentence — rides in from `profileImportVia`.
 */
export function profileImportOverBearer(bearer: BearerManager): ProfileImportTransport {
  return profileImportVia(bearer.fetch);
}

/**
 * The reach-past body door over the bearer. This page's engine lists over a BOUNDED in-memory
 * mirror of the host's store, so a folder or pile can hand the shell rows from beyond the
 * window; the host's `/messages/:id/body` answers them from the store on the hosting computer
 * (and, on its hosted door, forwards a row that store never held). Without this wire the shared
 * shell's Cloud fallback stays off — `api-client` is the refusing stub in this artifact — and
 * the reader is the stalled Retry again (review-caught, the DesktopGate finding's twin).
 */
export function olderBodyOverBearer(bearer: BearerManager): OlderBodyWire {
  return olderBodyVia(bearer.fetch);
}

/**
 * THE TWO LIVE WINDOWS OVER THE BEARER — Junk and Trash, and never one of them. Both read a
 * folder the mirror never holds (the provider's own \Junk and \Trash); `desktopHostRoutes`
 * spreads `localRoutes`, so the host's engine serves all four reads one hop away. Without a
 * wire the shared hooks fall back to `api-client` — the refusing stub — and the shell
 * withholds both sections with nothing naming why. A PAIR because they are one absence:
 * fixing either alone leaves the other silently missing. Only the transport is supplied —
 * the paths and read-only rule are `junkVia`'s and `trashVia`'s. What each section DOES is
 * the flag's: both sit behind "Use folders", which a host engine cannot store
 */

/*
 * (`withoutFoldersFlag`), exactly as on the desktop's own standalone door.
 */
export function junkOverBearer(bearer: BearerManager): JunkWire {
  return junkVia(bearer.fetch);
}

export function trashOverBearer(bearer: BearerManager): TrashWire {
  return trashVia(bearer.fetch);
}
