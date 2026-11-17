/**
 * WHAT A PERSON STATES ONCE FOR EVERY INSTALL OF A MAILBOX. Closed words only, each declared here
 * and nowhere else: the profile kept in the mailbox carries them, and anything outside a set reads
 * as not stated.
 */

/** Where a conversation's subject stands in the reader: once at its head, or on each letter. */
export const SUBJECT_HEADINGS = ["head", "each"] as const;
export type SubjectHeading = (typeof SUBJECT_HEADINGS)[number];

/** What a reader shows while nothing is stated. */
export const SUBJECT_HEADING_DEFAULT: SubjectHeading = "head";

/** Is `word` one of the two? A value read from a document is a member of the set or nothing. */
export function isSubjectHeading(word: unknown): word is SubjectHeading {
  return word === "head" || word === "each";
}
