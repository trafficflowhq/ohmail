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
 * Attachment METADATA captured at ingest. The BLOB bytes are NEVER
 * stored server-side — only this metadata persists; the bytes are
 * fetched on-demand from IMAP by `partId`. `partId` is the IMAP MIME body-part
 * number (e.g. "2", "1.2") mailparser surfaces on each attachment node; it is what
 * `ImapAdapter.fetchPart` passes to `client.download`. `inline` marks a `related`
 * (cid:) part — an embedded image, not a user-facing file.
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
   * `Cc:`, parsed. Carried for {@link messageFingerprint} and nothing else — no
   * routing rule reads it, and `insertMessage` still does not write `messages.cc_addresses`.
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
