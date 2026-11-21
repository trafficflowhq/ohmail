import { addressBook, matchAddresses, type EntityReader } from "@ohmail/client-engine";

/** Offer people from the same local address book as the mail composer. */
export function calendarInviteeSuggestions(reader: EntityReader, typed: string, exclude: readonly string[]) {
  if (typed.trim() === "") return [];
  return matchAddresses(addressBook(reader, { exclude }), typed.trim(), 6);
}
