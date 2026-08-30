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

/* ══════════════════════════════════════════════════════════════════════════════════════════
   USER-COMMANDED FOLDER NAMES — the shared validator (FOLDERS-SPEC.md stage 2).

   Create / rename take a CANONICAL `/`-joined path chosen by the user, and both the client
   (the honest sentence BEFORE the wire) and the server (the sentence is a claim, the refusal
   is the contract) must ask the same question — so the question lives here, in the one module
   both import graphs already reach (this file has no imports; see the header of DESTINATIONS
   for who depends on that).

   What is deliberately NOT here: the mailbox's REAL hierarchy delimiter. It is discovered at
   connect (`imap.ts`) and persisted nowhere, so only the worker's folder-op pass can refuse a leaf
   that contains it — `bad_name` on the op, reported through the entity's `op.error`. This
   validator covers every rule that is knowable without a connection.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Leaf names a mailbox RESERVES — the single source of `PASSIVE_EXCLUDED_LEAF`
 * (`adapters/imap-types.ts` re-exports this value; the import points that way because THIS
 * module must stay import-free). A folder created under one of these names would never be
 * watched by the passive read, so its mail would never mirror: refusing the name up front is
 * the honest sentence, and silently creating an invisible folder is the dishonest alternative.
 */
export const RESERVED_FOLDER_LEAF =
  /^(drafts?|entw(?:ü|ue)rfe|junk[ -]?(?:e-?mail)?|spam|bulk[ -]?mail|unerw(?:ü|ue)nscht|trash|bin|recycle[ -]?bin|deleted[ -](?:items|messages)|gel(?:ö|oe)schte[ -](?:objekte|elemente|nachrichten)|papierkorb|all[ -]mail|alle[ -]nachrichten|starred|important|outbox|postausgang)$/i;

/**
 * The longest canonical path a create/rename may command. RFC 9051 caps a mailbox NAME at
 * 255 octets on the wire and UTF-7 encoding only grows it, so the canonical cap sits under
 * that with room for the server-side delimiter translation.
 */
export const FOLDER_PATH_MAX = 200;

/**
 * SENT-SHAPED CANONICAL PATHS — the English resolver family plus the localized German one the
 * SPECIAL-USE resolver can surface, at top level or under a prefix a Sent folder actually lives
 * under: `INBOX/` (Dovecot trees) and Gmail's `[Gmail]/` namespace (`[Google Mail]/` on the
 * German account, which is also where `Gesendet` comes from). NOT nested generally —
 * `Alternativen/Sent Messages` is a folder the reader keeps and no resolver would ever pick it.
 *
 * The `[Gmail]/` arm is not a widening for its own sake: SPECIAL-USE is the FIRST step of the
 * worker's resolver (`imap.ts#findSentForScan`), so `[Gmail]/Sent Mail` is a path the resolver
 * genuinely produces, and every reader below was answering "no" about it.
 *
 * It lives HERE, beside {@link RESERVED_FOLDER_LEAF} and for the same reason, because it now has
 * THREE readers in graphs that share nothing else and one of them is a browser bundle:
 *
 *  · the folders inventory (`packages/services/src/folders.ts`) excludes these paths from the
 *    user-folder class — a Sent folder is not one of the user's own folders;
 *  · the folder delete's stale-residue cleanup (`adapters/drizzle-repo.ts#tombstoneFolderMessages`)
 *    must NEVER take a Sent-folder instance row — Sent is scanned by UID WATERMARK, not enumerated
 *    end to end, so after a UIDVALIDITY reset an old message's renumbered copy is never re-learned
 *    and a deleted "stale" Sent row is the last evidence that copy exists;
 *  · the client mirrors' {@link isSentFolderPath}, through `@trafficflow/core/folder-name` — which
 *    is the reader that moved it, because `adapters/imap-types.ts` is not reachable from the
 *    browser/phone engine and a second copy of this regex is a drift the other two readers pay for.
 *
 * `adapters/imap-types.ts` re-exports the value under its own name; the import points that way
 * because THIS module must stay import-free.
 */
export const SENT_SHAPED_CANONICAL =
  /^(inbox\/|\[(gmail|google mail)\]\/)?(sent([ -](items|messages|mail))?|gesendet(e[ -](objekte|elemente|nachrichten))?)$/i;

/**
 * IS THIS CANONICAL PATH THE MAILBOX'S SENT FOLDER — {@link SENT_SHAPED_CANONICAL} as a question.
 *
 * A PREDICATE and not the bare regex for the client's sake: a module-level `RegExp` with no `g`
 * flag is safe to `.test()` repeatedly, but exporting the pattern invites a caller to add one and
 * inherit `lastIndex`, and every reader here asks the same yes/no.
 *
 * ── WHAT IT DELIBERATELY IS NOT ────────────────────────────────────────────────────────────
 *
 * It is not "the mailbox's resolved Sent folder". The worker resolves that at connect
 * (SPECIAL-USE, then `imap.ts`'s `SENT_BY_NAME`) and persists the answer nowhere, so no reader
 * outside that connection can ask; this recognises Sent-SHAPED paths, which is every form the
 * resolver itself can produce for the English names plus the localized German family. The
 * residual — a Sent folder advertising SPECIAL-USE under a name neither belt knows — is the one
 * `packages/services/src/folders.ts` already documents and hands off (persist the resolved Sent
 * path beside `mailboxes.junk_folder` / `trash_folder`); this shares that residual rather than
 * inventing a second, differently-wrong answer.
 */
export function isSentFolderPath(path: string): boolean {
  return SENT_SHAPED_CANONICAL.test(path);
}

/**
 * Why this canonical path may NOT be a user folder's name, or `null` when it may — the
 * `userFolderExclusion` answer shape, for its reason: every refusal is a sentence, keyed by a
 * CLOSED code so both catalogues can carry it.
 *
 *  · `empty`     — no name at all (or a path of empty segments: `a//b`, `/a`, `a/`);
 *  · `spaces`    — a segment with leading/trailing whitespace (IMAP keeps it, users cannot
 *                  see it, and the same name "twice" is the support ticket);
 *  · `control`   — control characters (many servers refuse them; none renders them);
 *  · `wildcard`  — `%` or `*` (IMAP LIST wildcards — several servers refuse them in CREATE,
 *                  and a name that breaks the user's OTHER client is not a name to write);
 *  · `long`      — over {@link FOLDER_PATH_MAX};
 *  · `reserved`  — a segment the mailbox reserves ({@link RESERVED_FOLDER_LEAF}), the
 *                  organized six, `INBOX`, or the `ohmail` namespace: names the passive read
 *                  would never watch, so the folder would hold invisible mail.
 */
export type FolderNameError = "empty" | "spaces" | "control" | "wildcard" | "long" | "reserved";

export function folderNameError(path: string): FolderNameError | null {
  if (typeof path !== "string" || path.length === 0) return "empty";
  if (path.length > FOLDER_PATH_MAX) return "long";
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg.length === 0) return "empty";
    if (seg !== seg.trim()) return "spaces";
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(seg)) return "control";
    if (/[%*]/.test(seg)) return "wildcard";
    if (RESERVED_FOLDER_LEAF.test(seg)) return "reserved";
    if (/^ohmail$/i.test(seg)) return "reserved";
  }
  // The Imbox itself — as the WHOLE path only. `INBOX/<name>` is deliberately admitted: a
  // personal-namespace server files every user folder under the INBOX prefix (measured live —
  // a root-named create lands as `INBOX/<name>` and its rename must re-spell that full path),
  // so refusing the segment would ban renaming anything such a mailbox holds.
  if (/^inbox$/i.test(path)) return "reserved";
  if ((DESTINATIONS as readonly string[]).includes(path)) return "reserved";
  return null;
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
