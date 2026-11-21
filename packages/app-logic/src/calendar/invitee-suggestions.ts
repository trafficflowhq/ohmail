import { addressBook, matchAddresses, type EntityReader } from "@ohmail/client-engine";

/** Offer people from the same local address book as the mail composer. */
export function calendarInviteeSuggestions(reader: EntityReader, typed: string, exclude: readonly string[]) {
  const people = addressBook(reader, { exclude });
  const query = typed.trim();
  return query ? matchAddresses(people, query, 6) : people.slice(0, 6);
}
