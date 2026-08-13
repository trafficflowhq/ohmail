export interface EmailAddress { name: string | null; address: string; }

export interface CanonicalId {
  /**
   * Normalized: ONE pair of angle brackets stripped, trimmed, and **case preserved**.
   *
   * It used to be lowercased. RFC 5322 §3.6.4 makes `msg-id` an opaque token whose `id-left` is
   * a `dot-atom-text` — case-SIGNIFICANT — so lowercasing threw away a distinction the sender
   * made, and two senders' ids differing only in case collapsed onto one row. See
   * `identity.ts#normalizeMessageId`; the legacy population is reached through
   * {@link legacyDedupKey}, which re-lowercases on purpose.
   */
  messageIdHeader: string | null;
  bodyHash: string;                 // sha256 hex, always present
}

export type Destination =
  | "INBOX"
  | "ohmail/Screener"
  | "ohmail/Reads"
  | "ohmail/Receipts"
  | "ohmail/Screened"
  | "ohmail/Quarantine";

/**
 * The six {@link Destination} strings as a VALUE — the folders ohmail may put mail into.
 *
 * ── WHY THIS IS IN THE MODEL AND NOT BESIDE `WATCHED_FOLDERS` ────────────────────────────────
 *
 * The adapter's `WATCHED_FOLDERS` is a SCAN LIST: which folders one `changesSince` pass reads. The
 * set it reads is strictly larger than the set it FILES INTO — the Sent folder and the customer's
 * own folders are read and never organized — so the two questions are different and only one of them
 * is a fact about IMAP.
 *
 * `isOrganizedFolder` is the predicate every path that WRITES to a mailbox asks, and several of
 * those callers must never pull the IMAP adapter into their import graph. `apps/worker/src/
 * rule-retro.ts` is the one that proved it: it needs this predicate for its candidate query and
 * `rule-retro.no-imap.test.ts` scans its imports and fails on `adapters/imap` — the pass runs beside
 * `reconcileFolders`, which holds the mailbox's adapter and its organizer lease, so a bulk mover
 * that could dial would be a second organizer for one mailbox. Importing a six-string list from a
 * module that carries `imapflow` is how that guard gets weakened by accident.
 *
 * This module has no imports at all, which is what makes it reachable from anywhere.
 */
export const DESTINATIONS: readonly Destination[] = [
  "INBOX",
  "ohmail/Screener",
  "ohmail/Reads",
  "ohmail/Receipts",
  "ohmail/Screened",
  "ohmail/Quarantine",
];

/**
 * Does ohmail ORGANIZE this folder — is it one a decision may file mail into?
 *
 * NOT "do we read it". `Sent` is read and never organized; a customer's own folders
 * (`imap-types.ts#passiveFolderExclusion`) are read and never organized. Both answer false here, and
 * that is the point: conflating the two is how a folder somebody spent fifteen years filing acquires
 * a mover.
 */
export function isOrganizedFolder(folder: string): boolean {
  return (DESTINATIONS as readonly string[]).includes(folder);
}

/**
 * Attachment METADATA captured at ingest. The BLOB bytes are NEVER
 * stored server-side — only this metadata persists; the bytes are
 * fetched on-demand from IMAP by `partId`. `partId` is the IMAP MIME body-part
 * number (e.g. "2", "1.2") mailparser surfaces on each attachment node; it is what
 * `ImapAdapter.fetchPart` passes to `client.download`. `inline` marks an embedded part —
 * a `related` (cid:) sibling of the html, or any part whose Content-ID the html body
 * references (`mime.ts#referencesCid`) — not a user-facing file.
 */
export interface AttachmentMeta {
  filename: string | null;
  contentType: string;
  sizeBytes: number;
  partId: string | null;
  contentId: string | null;
  inline: boolean;
  /**
   * `sha256(decoded bytes)`, hex — the ONE piece of an attachment that identifies its CONTENT.
   * Computed in `mime.ts#toAttachmentMeta`, where `a.content` is already resident
   * and was previously read for `.length` and thrown away; it is therefore free, and it is the
   * only place it can be computed, because §13.2/§14 forbid persisting the bytes.
   *
   * It exists for {@link messageFingerprint}. Without it two messages identical in every header
   * and body but carrying DIFFERENT attachments of the same size and name have the same logical
   * identity — one of them is then filed as a duplicate of the other and the user never sees it.
   *
   * `null` when mailparser produced no Buffer for the part (it does not for a part it could not
   * decode). Null is domain-separated from a real digest by the fingerprint encoder, so "no
   * digest" and "the digest of nothing" are different messages.
   */
  contentSha256: string | null;
}

export interface NormalizedMessage {
  canonical: CanonicalId;
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  /**
   * `Cc:`, parsed. No routing rule reads it; {@link messageFingerprint} consumes it, and
   * `insertMessage` now writes it to `messages.cc_addresses` so the reader can render a Cc line.
   *
   * It is in the fingerprint because leaving it out is the UNSAFE direction: two messages that
   * differ only in their Cc list would share a logical identity, and the second would be filed
   * as a duplicate of the first and never shown. A field that only ever ADDS distinctions can
   * only ever split, never collapse.
   */
  cc: EmailAddress[];
  date: Date | null;
  headers: Record<string, string[]>;   // lowercased header name -> raw values
  textBody: string;
  htmlBody: string | null;
  hasAttachments: boolean;
  attachments: AttachmentMeta[];        // metadata only — bytes are fetched on-demand from IMAP (§13.2/§14)
}
