/**
 * THE SELF-CHECK IN THE DESKTOP WINDOW — the bridge binding, and the session's last reading per
 * mailbox, which the diagnostic file carries (as hashes and classes) when it is written after a
 * check. Not the retrying read: a retry would dial the mail server twice for one press. Nothing
 * here runs on a timer; a mailbox reading exists only because somebody pressed. The bridge's
 * transport reading is passive: `asBytes` records it on every raw answer.
 */
import { bridgeFetch, bridgeTransportReading } from "./bridge-fetch.js";
import { selfCheckVia } from "./self-check-wire.js";

const lastReadings = new Map<string, unknown>();

export async function checkMailboxHere(mailboxId: string): Promise<unknown> {
  const reading = await selfCheckVia(bridgeFetch, mailboxId);
  lastReadings.set(mailboxId, reading);
  return reading;
}

/** The key the transport reading travels under; a mailbox id is a uuid and never this word. */
export const BRIDGE_SELF_CHECK_KEY = "bridge";

/**
 * The readings this window has taken, by mailbox id — the diagnostic file's input — and, under
 * {@link BRIDGE_SELF_CHECK_KEY}, how the command channel carried its raw answers since boot.
 */
export function selfChecksThisSession(): Record<string, unknown> {
  return { ...Object.fromEntries(lastReadings), [BRIDGE_SELF_CHECK_KEY]: bridgeTransportReading() };
}
