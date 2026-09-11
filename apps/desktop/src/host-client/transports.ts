/**
 * THE HOST-CLIENT'S INJECTED WIRES — the window's transports, over the bearer socket.
 *
 * The shared shell takes a handful of things it must not know how to fetch (the publish DENYs
 * `app/api-client`, and the desktop window injects bridge-backed implementations). This page is
 * the third consumer of the same seams, and the rule holds: the NARROWING and the refusal
 * contracts live once, in the wire modules (`readMailboxFactsVia`, `profileImportVia`), and this
 * file supplies only the transport — the manager's fetch, which carries the Authorization header
 * and the one 401 recovery.
 *
 * ── AND EVERY ONE OF THOSE MODULES IS DOOR-FREE, WHICH IS A BUILD FACT ──────────────────────
 *
 * The factories used to sit in the window's `local-*` modules beside their bridge bindings, so
 * importing one here pulled `bridge-fetch.ts` into the bundle the host door serves and the shell
 * command's name was in the bytes a phone is handed. `scan:host` refuses that, and the packaged
 * release runs it. So the factories live in `*-wire.ts` modules that import no transport at all,
 * the `local-*` modules bind them to the bridge, and nothing this file imports names a shell
 * channel. `host-client-no-engine-door.test.ts` measures it on the built artifact.
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
 * THE TWO LIVE WINDOWS OVER THE BEARER — Junk and Trash, and never one of them.
 *
 * Both read a folder the mirror never holds (the provider's own \Junk and \Trash), so neither can
 * be answered from this page's in-memory mirror; `desktopHostRoutes` spreads `localRoutes`, which
 * mounts both groups, so the host's engine serves all four reads one hop away. Without a wire the
 * shared hooks fall back to `api-client` — the refusing stub in this artifact — report "no server"
 * and the shell withholds both sections with nothing on screen naming why.
 *
 * Handed in as a PAIR because they are one absence: fixing either alone leaves the other silently
 * missing on the same door for the same reason. Like every wire here, only the transport is
 * supplied — the paths, the status contracts and the read-only rule are `junkVia`'s and
 * `trashVia`'s, so this door cannot ask for a route the desktop window does not.
 *
 * What each section then DOES is the flag's, not the wire's: both sit behind "Use folders", which
 * a host engine cannot store (`withoutFoldersFlag` strips the field — it serves no folder verb),
 * exactly as on the desktop's own standalone door. The wire is handed in regardless, so the day
 * that door grows the verbs the sections follow the switch with no change here.
 */
export function junkOverBearer(bearer: BearerManager): JunkWire {
  return junkVia(bearer.fetch);
}

export function trashOverBearer(bearer: BearerManager): TrashWire {
  return trashVia(bearer.fetch);
}
