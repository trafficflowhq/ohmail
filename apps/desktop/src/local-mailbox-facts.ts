/**
 * THE WINDOW'S MAILBOX LIST — the bridge binding, and deliberately nothing else.
 *
 * The narrowing is `mailbox-facts-wire.ts`'s, shared with the served host client's bearer
 * transport; this file supplies only the window's transport, the RETRYING read, so one refused
 * frame down the pipe is not the whole answer. A module of its own because the pane that
 * renders the list is published at older commits' content — an import added there would name
 * a module those trees do not have.
 */

import type { MailboxFacts } from "../../webapp/app/shell/mail-state";
import { retryingBridgeFetch } from "./bridge-fetch.js";
import { readMailboxFactsVia } from "./mailbox-facts-wire.js";

/** The mailboxes this install opens, for the shared shell's sync line. */
export async function readMailboxFacts(): Promise<MailboxFacts[]> {
  return readMailboxFactsVia(retryingBridgeFetch);
}
