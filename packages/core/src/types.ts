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
  | "ohmail/News"
  | "ohmail/Receipts"
  | "ohmail/Screened"
  | "ohmail/Quarantine";

/**
 * The six {@link Destination} strings as a VALUE — the folders ohmail may put mail into. In the
 * model, not beside `WATCHED_FOLDERS`: the adapter's list is a SCAN LIST (what one `changesSince`
 * pass reads), strictly larger than what is FILED INTO, so the two questions are different.
 * `isOrganizedFolder` is the predicate every path that WRITES to a mailbox asks, and several
 * callers must never pull the IMAP adapter into their import graph —
 * `apps/worker/src/rule-retro.ts` proved it: `rule-retro.no-imap.test.ts` fails on an
 * `adapters/imap` import, because a bulk mover that could dial would be a second organizer for
 * one mailbox. This module has no imports at all, which is what makes it reachable from anywhere.
 */
export const DESTINATIONS: readonly Destination[] = [
  "INBOX",
  "ohmail/Screener",
  "ohmail/News",
  "ohmail/Receipts",
  "ohmail/Screened",
  "ohmail/Quarantine",
];

/** The News pile's canonical folder — what is created, filed into and stored going forward. */
export const NEWS_FOLDER = "ohmail/News";

/**
 * The News pile's PRE-0.22 folder name — the ONLY home of this literal outside fixtures
 * (`test/news-folder-literal-census.test.ts` holds that closed, both ways). Mailboxes organized
 * before the rename still carry it: the organizer renames it to {@link NEWS_FOLDER} on its next
 * pass, and until that pass succeeds every reader and filer reaches the pile through
 * {@link pileFolder} / {@link canonicalDestination}, so nothing breaks meanwhile.
 */
export const LEGACY_NEWS_FOLDER = "ohmail/Reads";

/**
 * A stored or wire folder name to its canonical spelling — the legacy News folder maps to
 * {@link NEWS_FOLDER}, everything else is itself. Both spellings mean the News pile: rows
 * written before 0.22 (database, mirrors, rules, profile piles) and requests from older
 * clients carry the legacy name for ever, so every comparison and classification goes
 * through this and never through string equality on the literal.
 */
export function canonicalDestination(folder: string): string {
  return folder === LEGACY_NEWS_FOLDER ? NEWS_FOLDER : folder;
}

/** Is this folder name the News pile, in either spelling? */
export function isNewsFolder(folder: string): boolean {
  return canonicalDestination(folder) === NEWS_FOLDER;
}

/**
 * THE pile → physical-folder resolver — News-first, Reads-fallback, canonical for creation.
 *
 * `listing` is canonical folder paths the server LISTed. For the News pile: `ohmail/News` when
 * the mailbox has it; else the legacy `ohmail/Reads` when that is what the mailbox still has;
 * else the canonical name, which is what a CREATE makes. Every other pile resolves to itself.
 * This is the one place the two spellings meet a live mailbox: the IMAP adapter routes every
 * select, scan, move and create through it, so an unrenamed mailbox keeps working unchanged.
 */
export function pileFolder(pile: Destination, listing: Iterable<string>): string {
  if ((pile as string) !== NEWS_FOLDER) return pile;
  let sawLegacy = false;
  for (const f of listing) {
    if (f === NEWS_FOLDER) return NEWS_FOLDER;
    if (f === LEGACY_NEWS_FOLDER) sawLegacy = true;
  }
  return sawLegacy ? LEGACY_NEWS_FOLDER : NEWS_FOLDER;
}

/**
 * Does ohmail ORGANIZE this folder — is it one a decision may file mail into?
 *
 * NOT "do we read it". `Sent` is read and never organized; a customer's own folders
 * (`imap-types.ts#passiveFolderExclusion`) are read and never organized. Both answer false here, and
 * that is the point: conflating the two is how a folder somebody spent fifteen years filing acquires
 * a mover.
 */
export function isOrganizedFolder(folder: string): boolean {
  // Canonicalized first: a mailbox organized before 0.22 has mail FILED in the legacy News
  // folder, and "is this one ohmail organizes" must answer the same for both spellings.
  return (DESTINATIONS as readonly string[]).includes(canonicalDestination(folder));
}

/** One message, as much of it as the question below reads — the wire's own fields. */
export interface RetroCandidateRow {
  /** Where the mailbox has it FILED: the wire's `folder`, which is `folder_state.desired_folder`. */
  folder: string;
  /** Set only by a client projection that re-homed `folder` for display; the filed folder wins. */
  physicalFolder?: string;
  /** The `message_states` row, or absent/null for a message with none. */
  triage?: { state: string } | null;
}

/**
 * WOULD THE SERVER'S RETRO PASS MOVE THIS MESSAGE — the one question both clients ask.
 *
 * The fifty a screening press moves at once must be a SUBSET of what
 * `rule-retro.ts#selectCandidates` would move, or the press undoes filing that pass never
 * touches: the clients filtered on the destination alone and so moved a customer's own folders
 * and mail set aside. Three of the pass's clauses are on the wire — the allow-list over the
 * organized six, the idempotency, no triage. Four are NOT (`last_set_by 'external'`, a draft
 * reply, a decided approval, an own reply in the thread), which keeps this a subset.
 */
export function retroPassWouldMove(row: RetroCandidateRow, destination: string): boolean {
  const filed = row.physicalFolder ?? row.folder;
  if (!isOrganizedFolder(filed)) return false;
  // Canonicalized: a row still filed at the pre-0.22 `ohmail/Reads` IS at the News pile, and
  // the idempotency clause must read it as already-there, not as mail to move.
  if (canonicalDestination(filed) === canonicalDestination(destination)) return false;
  return (row.triage?.state ?? "none") === "none";
}

/**
 * User-commanded folder names — the shared validator (FOLDERS-SPEC.md stage 2). Create/rename
 * take a canonical `/`-joined path chosen by the user, and the client (the honest sentence before
 * the wire) and the server (the refusal is the contract) must ask the same question, so the
 * question lives in the one module both import graphs reach — this file has no imports.
 * Deliberately NOT here: the mailbox's REAL hierarchy delimiter, discovered at connect
 * (`imap.ts`) and persisted nowhere — only the worker's folder-op pass can refuse a leaf
 * containing it (`bad_name` through the entity's `op.error`). This validator covers every rule
 * knowable without a connection.
 */

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
 * Sent-shaped canonical paths — the English resolver family plus the localized German one, at top
 * level or under `INBOX/` (Dovecot) or Gmail's `[Gmail]/` / `[Google Mail]/` namespaces; not
 * nested generally. Import-free HERE because it has THREE readers in graphs that share nothing:
 * the folders inventory excludes these from the user-folder class; the folder delete's
 * stale-residue cleanup must NEVER take a Sent instance row (Sent is scanned by UID watermark; a
 * deleted "stale" row is the last evidence a renumbered copy exists); and the client mirrors'
 * {@link isSentFolderPath} via `@trafficflow/core/folder-name`. `adapters/imap-types.ts`
 * re-exports the value.
 */
export const SENT_SHAPED_CANONICAL =
  /^(inbox\/|\[(gmail|google mail)\]\/)?(sent([ -](items|messages|mail))?|gesendet(e[ -](objekte|elemente|nachrichten))?)$/i;

/**
 * Is this canonical path the mailbox's Sent folder — {@link SENT_SHAPED_CANONICAL} as a question.
 * A predicate and not the bare regex for the client's sake: a module-level `RegExp` with no `g`
 * flag is safe to `.test()` repeatedly, but exporting the pattern invites a caller to add one and
 * inherit `lastIndex`. It is NOT "the mailbox's resolved Sent folder": the worker resolves that
 * at connect and persists it nowhere, so this recognises Sent-SHAPED paths — every form the
 * resolver itself can produce. The residual (a Sent folder advertising SPECIAL-USE under a name
 * neither belt knows) is the one `packages/services/src/folders.ts` documents and hands off — not
 * answered a second, differently-wrong way.
 */
export function isSentFolderPath(path: string): boolean {
  return SENT_SHAPED_CANONICAL.test(path);
}

/**
 * Why this canonical path may NOT be a user folder's name, or `null` when it may — every refusal
 * is a sentence keyed by a CLOSED code so both catalogues can carry it. `empty` — no name, or
 * empty segments (`a//b`); `spaces` — leading/trailing whitespace in a segment (IMAP keeps it,
 * users cannot see it); `control` — control characters; `wildcard` — `%` or `*` (IMAP LIST
 * wildcards several servers refuse in CREATE); `long` — over {@link FOLDER_PATH_MAX}; `reserved`
 * — a segment the mailbox reserves ({@link RESERVED_FOLDER_LEAF}), the organized six, `INBOX`, or
 * the `ohmail` namespace: names the passive read would never watch, so the folder would hold
 * invisible mail.
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
   * Computed in `mime.ts#toAttachmentMeta`, where `a.content` is already resident, so it is free
   * — and the only place it can be computed, because the bytes are never persisted. It exists for
   * {@link messageFingerprint}: without it, two messages identical in every header and body but
   * carrying DIFFERENT attachments of the same size and name share one logical identity, and one
   * is filed as a duplicate the user never sees. `null` when mailparser produced no Buffer for
   * the part; the fingerprint encoder domain-separates `null` from a real digest, so "no digest"
   * and "the digest of nothing" differ.
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
