import type { Tx } from "../change-log.js";
import { readOwnAddresses } from "../own-mail.js";

/**
 * WHOSE AN EVENT IS: the addresses an event of the account's own is organized under, in lower
 * case. They are the account's mailboxes by the one own set (`readOwnAddresses`: a mailbox erased or
 * removed is no mailbox of the account's any more) and the calendar connection's principal where
 * that is an address (Google's and Microsoft's sign-in name the account by its address there). The
 * write door and the drain ask `writeActRefusal` with this one set, so they take an event for the
 * account's own alike. The addresses a CalDAV server names for the signed-in person are stored
 * nowhere yet: until they are, an event organized under one of them is someone else's.
 */
export async function ownOrganizerAddresses(tx: Tx, accountId: string, principal: string | null): Promise<Set<string>> {
  const own = await readOwnAddresses(tx, accountId);
  const address = principal?.trim().toLowerCase().replace(/^mailto:/, "") ?? "";
  if (address.includes("@") && !address.includes("/")) own.add(address);
  return own;
}
