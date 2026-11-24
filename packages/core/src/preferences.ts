import type { Assert, Same, SubjectHeading as WireSubjectHeading } from "@ohmail/wire";

/**
 * WHAT A PERSON STATES ONCE FOR EVERY INSTALL OF A MAILBOX. Closed words only, each declared here
 * and nowhere else: the profile kept in the mailbox carries them, and anything outside a set reads
 * as not stated.
 */

/** Where a conversation's subject stands in the reader: once at its head, or on each letter. */
export const SUBJECT_HEADINGS = ["head", "each"] as const;
export type SubjectHeading = (typeof SUBJECT_HEADINGS)[number];
/** The wire spells the pair again, for the clients; the two stay one set or this line does not compile. */
type _SubjectHeadingIsTheWires = Assert<Same<SubjectHeading, WireSubjectHeading>>;

/** What a reader shows while nothing is stated. */
export const SUBJECT_HEADING_DEFAULT: SubjectHeading = "head";

/** Is `word` one of the two? A value read from a document is a member of the set or nothing. */
export function isSubjectHeading(word: unknown): word is SubjectHeading {
  return word === "head" || word === "each";
}

/**
 * A store's word as stated: one of the two, and only beside the instant it was stated at. Anything
 * else is `null`, nothing stated, which a reader shows as {@link SUBJECT_HEADING_DEFAULT}.
 */
export function subjectHeadingOf(word: unknown, at: unknown): SubjectHeading | null {
  return at !== null && at !== undefined && isSubjectHeading(word) ? word : null;
}
