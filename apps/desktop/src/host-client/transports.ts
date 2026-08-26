/**
 * THE HOST-CLIENT'S INJECTED WIRES — the window's transports, over the bearer socket.
 *
 * The shared shell takes a handful of things it must not know how to fetch (the publish DENYs
 * `app/api-client`, and the desktop window injects bridge-backed implementations). This page is
 * the third consumer of the same seams, and the rule holds: the NARROWING and the refusal
 * contracts live once, in the window's modules (`readMailboxFactsVia`, `profileImportVia`), and
 * this file supplies only the transport — the manager's fetch, which carries the Authorization
 * header and the one 401 recovery.
 */

import type { MailboxFacts } from "../../../webapp/app/shell/mail-state";
import type { ProfileImportTransport } from "../../../webapp/app/shell/ProfileImportCard";
import type { OlderBodyWire } from "../../../webapp/app/shell/older-body";
import { readMailboxFactsVia } from "../DesktopMailboxes.js";
import { olderBodyVia } from "../local-older-body.js";
import { profileImportVia } from "../local-profile-import.js";
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
