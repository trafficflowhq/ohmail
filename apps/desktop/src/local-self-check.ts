/**
 * THE SELF-CHECK IN THE DESKTOP WINDOW — the bridge binding, and the session's last reading per
 * mailbox, which the diagnostic file carries (as hashes and classes) when it is written after a
 * check. Not the retrying read: a retry would dial the mail server twice for one press. Nothing
 * here runs on a timer; a reading exists only because somebody pressed.
 */
import { bridgeFetch } from "./bridge-fetch.js";
import { selfCheckVia } from "./self-check-wire.js";

const lastReadings = new Map<string, unknown>();

export async function checkMailboxHere(mailboxId: string): Promise<unknown> {
  const reading = await selfCheckVia(bridgeFetch, mailboxId);
  lastReadings.set(mailboxId, reading);
  return reading;
}

/** The readings this window has taken, by mailbox id — the diagnostic file's input. */
export function selfChecksThisSession(): Record<string, unknown> {
  return Object.fromEntries(lastReadings);
}
