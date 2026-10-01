import { isStorableMessageId } from "./identity.js";

/**
 * THE BOUNDS ON A SENDER-WRITTEN VALUE, APPLIED WHERE IT IS STORED AND NOWHERE ELSE. A btree refuses a
 * key near 2.7 KB and a tsvector one over 1 MiB (`54000`), and an ingest INSERT that fails holds the
 * folder's cursor, so the message came back every cycle. The parsed message keeps the values as sent:
 * the fingerprint and the legacy key read them, so a message stored before these bounds keeps its
 * identity when it is seen again.
 */

/** RFC 5321's 254, the draft door's own ceiling. A longer address is stored as none, never cut. */
export const MAX_STORED_ADDRESS_CHARS = 254;

/** The stored subject's ceiling; `subject_tsv` and the search document read it into a tsvector. */
export const MAX_STORED_SUBJECT_CHARS = 4096;

/** The address as stored: itself, or `""` when no transport could deliver to it. */
export function storedAddress(address: string): string {
  return address.length > MAX_STORED_ADDRESS_CHARS ? "" : address;
}

/** At most {@link MAX_STORED_SUBJECT_CHARS}, never ending in half a surrogate pair. */
export function storedSubject(subject: string): string {
  if (subject.length <= MAX_STORED_SUBJECT_CHARS) return subject;
  const cut = subject.slice(0, MAX_STORED_SUBJECT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** The Message-ID as stored: itself, or none over the btree's ceiling (a cut id is a different id). */
export function storedMessageId(id: string | null): string | null {
  return id !== null && isStorableMessageId(id) ? id : null;
}
