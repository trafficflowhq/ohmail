/**
 * @ohmail/client-engine — wire vocabulary.
 *
 * These shapes MIRROR the ohmail Cloud API contract without importing any
 * backend package: the engine consumes the wire contract only, exactly as the
 * native SwiftData mirror will. Clients must tolerate unknown fields and
 * unknown entity types (forward-compatible parsing) — hence the open unions
 * below.
 *
 * ABOUT THE `§` REFERENCES in this package. They cite the Cloud API contract
 * document, which is **not public** — ohmail Desktop is the free, AGPL-3.0 half
 * of the product and the Cloud service is the other half. The citations are
 * left in rather than stripped because they are load-bearing where the file is
 * authored, and because pretending the other half does not exist would be its
 * own kind of dishonesty. Nothing here depends on being able to read that
 * document: this file IS the public statement of the wire vocabulary, and in
 * the Desktop build the client that would speak it is aliased out of the bundle
 * entirely (`adapters/http-adapter.ts` is a stub whose constructor throws).
 */

export type ISODateTime = string;
export type Cursor = string;

export interface EmailAddress {
  name: string | null;
  address: string;
}

/**
 * ONE FILE THE COMPOSE FORM IS SENDING — bytes and nothing kept.
 *
 * It rides the `mail_send` mutation and then the send REQUEST (`POST /drafts/:id/send`), base64 so
 * a JSON body can carry it, and nothing on the account keeps it: no `attachments` row, no `drafts`
 * column. The compose surface reads a picked `File` into `contentBase64` and states the total-size
 * limit up front — the SMALLER of what the sending SURFACE can carry and what the sending
 * mailbox's own submission server announced it will accept. This is the SEND path only — a draft
 * is not given attachment bytes, because nothing on the account stores them.
 *
 * ONE TRANSPORT QUALIFICATION. A client permitted to stage
 * (`HttpAdapterOptions.stageAttachments`) sends these bytes to object storage on a signed URL when
 * they exceed what one request body can carry, and puts REFERENCES on the send instead — which is
 * what lets such a surface promise the mailbox's real limit rather than the request pipeline's.
 * The bytes are then at rest, in a private bucket, for at most 24 hours. Every other client, both
 * desktop doors included, still puts them in the request exactly as described above.
 */
export interface ComposeAttachment {
  filename: string;
  contentType: string;
  /** base64-encoded bytes. */
  contentBase64: string;
}

/**
 * Real IMAP folders — identical to core `Destination` (contract §1.2).
 *
 * These five strings are the most durable copy the product writes: they are
 * created inside the customer's own mailbox and render in Apple Mail, Outlook
 * and every other client, forever — including after the customer leaves. The
 * namespace was renamed from the pre-rebrand company name to `ohmail/…` on
 * 2026-07-31, while zero real mailboxes were connected, precisely so that no
 * folder-rename migration would ever be needed. Changing them again is an
 * IMAP data migration, not an edit.
 *
 * The narrow UI rule stands regardless: NEVER render a raw folder string. Map
 * it through `VIEW_OF_FOLDER`; when a server sends a folder this client does
 * not know (contract §8 forward-compatible parsing), fall back to
 * `folderLeaf()`, which yields the last path segment.
 */
export type Folder =
  | "INBOX"
  | "ohmail/Screener"
  | "ohmail/Reads"
  | "ohmail/Receipts"
  | "ohmail/Screened"
  | "ohmail/Quarantine";

export type ChangeOp = "create" | "update" | "move" | "delete";

/**
 * The EntityType values the server's `/sync` feed carries today (contract §3.1).
 *
 * `"tag"` JOINED THIS LIST LATE, and the move is the whole point. It used to sit
 * only in {@link MirrorEntityType}, among the demo-world types, and the consequence was not a
 * missing feature but an invisible one: `TagView`, `TagPicker` and the `t` shortcut were all
 * built and all worked against fixtures, while a real Cloud account drained a `/sync` feed with
 * no vocabulary for a tag and therefore rendered an empty picker forever. Mirrors the server's
 * change-log entity type, which grew the same member at the same time.
 *
 * Tag ASSIGNMENTS are deliberately not a type here. They ride the `message` entity —
 * `MessageDTO.labels` — so a client can never hold an assignment that names a tag it has not
 * received yet.
 */
export type SyncEntityType =
  | "message" | "thread" | "routing_decision" | "approval"
  | "draft" | "rule" | "message_state" | "folder" | "tag";

/**
 * Everything the LOCAL mirror stores. Beyond the synced types, the engine keeps
 * client-local entities for the demo/fixture world (`screener_sender`,
 * `triage_item`, `mailbox`), view metadata (`view_meta`, e.g. the Reads
 * waterline) and hydrated message bodies (`message_body`).
 * Unknown strings are tolerated by design.
 */
export type MirrorEntityType =
  | SyncEntityType
  | "screener_sender" | "triage_item" | "mailbox" | "view_meta" | "message_body"
  | (string & {});

// ── /sync wire shapes (contract §3.1) ──────────────────────────────────────

export interface SyncChange<T = unknown> {
  type: MirrorEntityType;
  op: ChangeOp;
  id: string;
  /** Global monotonic per-account sequence — the order of record (§3.3). */
  seq: number;
  updatedAt: ISODateTime;
  /** The full resource DTO; OMITTED for op:"delete". */
  entity?: T;
  /** Present only for op:"move" on messages. */
  move?: { from: Folder | null; to: Folder };
}

export interface SyncResponse {
  changes: {
    creates: SyncChange[];
    updates: SyncChange[];
    moves: SyncChange[];
    deletes: SyncChange[];
  };
  cursor: Cursor;
  hasMore: boolean;
  serverTime: ISODateTime;
}

/**
 * ONE PAGE OF `GET /sync/snapshot` — the cold-start path that replaces `since=0`.
 *
 * ## WHY THIS EXISTS AND IS NOT JUST `/sync?since=0`
 *
 * `since=0` replays the WHOLE change log: every create, every subsequent update, every move, in
 * the order they happened, so a mailbox that has been organized for a year costs the client every
 * intermediate state of every row it will end up holding exactly once. A snapshot is the CURRENT
 * state instead — one `op:"create"` per live row, nothing superseded — read at a single
 * consistent point, which is what {@link asOfSeq} names.
 *
 * ## THE THREE PROPERTIES A CONSUMER MAY RELY ON
 *
 *  1. **Every page reads the SAME point.** `asOfSeq` is identical on page 1 and page 9; it is not
 *     "where we got to". So a delta drain resuming at `asOfSeq` after the last page misses
 *     nothing, whatever happened on the server while the pages were being fetched.
 *  2. **Page 1 is all live state plus the newest page of messages**, and later pages are messages
 *     only, newest-first. A client that stops early therefore has a coherent — if short — mailbox
 *     rather than an arbitrary slice of one.
 *  3. **`nextCursor` is opaque and `null` on the last page.** It is the server's paging token, not
 *     a `/sync` cursor, and must never be written to the mirror as one.
 *
 * ## `window` IS INFORMATIONAL, DELIBERATELY
 *
 * It reports the retention window the server paged with. The client does NOT adopt it as its
 * storage policy: `EngineOptions.storePolicy` defaults to `full`, and a desktop install whose
 * whole point is that the mail is on the device must not become prunable because a server said so
 * in a response body. Reading it here and acting on it there would be exactly that.
 */
export interface SyncSnapshotPage {
  /**
   * The sequence number the whole snapshot was read at. The client commits `String(asOfSeq)` as
   * its `/sync` cursor — and only with the LAST page (contract §3.3): a crash mid-snapshot must
   * leave the cursor at "0" so the next start re-snapshots rather than resuming from a point it
   * never fully applied.
   */
  asOfSeq: number;
  /** Live rows as full DTOs. Always `op:"create"`, always `seq === asOfSeq`. */
  changes: SyncChange[];
  /** The server's opaque paging token; `null` ⇒ this was the last page. */
  nextCursor: string | null;
  /** What the server paged with. Informational — see the note above. */
  window: { days: number; minRows: number };
}

// ── entity DTO mirrors ─────────────────────────────────────────────────────

export interface SensitivityFlags {
  sensitive: boolean;
  category: "otp" | "verification" | "password_reset" | "security_alert" | null;
  no_ai: boolean;
  no_forward: boolean;
  no_kb: boolean;
  priority: boolean;
}

export type TriageState = "none" | "reply_later" | "set_aside" | "bubbled_up" | "muted";

/**
 * EVERY STATE THAT CROSSES THE WIRE — {@link TriageState} plus `resurfaced`.
 *
 * The extra member is kept OUT of `TriageState` itself, and that separation is load-bearing
 * rather than tidy. `TriageState` is this client's word for A BOTTOM PILE: `TriageItemDTO.pile`
 * is literally `Exclude<TriageState, "none" | "muted">`, and `selectors.ts#triagePiles` files
 * every member of it into one of three lists. A resurfaced message belongs to NO pile — it is
 * pinned at the TOP of the Ohbox (`ohboxView.resurfaced`) — so widening `TriageState` would
 * invite a fourth pile that must never exist.
 *
 * It has always been settable by the SERVER (`bubbleUpPass` writes it when a scheduled resurface
 * comes due) and is now settable by a client too, for "resurface this now" — a horizon that
 * `bubbled_up` cannot express, because a past `bubbleUpAt` pins nothing until some worker pass
 * runs and a standalone desktop install runs none.
 */
export type TriageWireState = TriageState | "resurfaced";

export interface MessageStateDTO {
  messageId: string;
  /**
   * {@link TriageWireState} and not {@link TriageState}: the server has always been able to serve
   * `resurfaced` here, so the narrower type was a claim the wire never honoured.
   */
  state: TriageWireState;
  bubbleUpAt: ISODateTime | null;
  setAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** Fixture-only display extras a message row may carry in the demo world. */
export interface EngineMessageExtras {
  /** Full body text (mirrored locally so search covers it). */
  body?: string;
  /** Display time exactly as the prototype renders it ("09:12", "Mon"). */
  time?: string;
  threadCount?: number;
  attachment?: { filename: string; size: string };
  protected?: { kind: string; label: string; redactedNote: string; policy: string };
  rationale?: string;
  trackerNote?: string;
  amount?: string;
  art?: { ariaLabel: string; caption: string };
  /**
   * Where this message actually is on the mail server, when `folder` is showing where it is
   * PRESENTED instead.
   *
   * Set only by `presentationReader` (see `consent-cutline.ts`). Mail is presented by who sent
   * it rather than by where it happens to sit, so the two can differ — and when they do the
   * product says so rather than pretending the presentation is the location.
   */
  physicalFolder?: string;
  /**
   * THIS ROW IS THE ENGINE'S OWN OPTIMISTIC SENT COPY, not a message the mirror synced.
   *
   * A confirmed `mail_send` materialises a provisional Sent-folder message so a reply appears in
   * its conversation instantly, minutes before the worker's Sent-folder watch ingests the real
   * one (see {@link OhmailEngine} and `sentOverlayMessage`). Absent on every synced row — a
   * server DTO never carries it — so a surface reads `local === true` as "this is on its way, not
   * yet confirmed by the mailbox" and the reconcile-by-`messageIdHeader` drops it when the real
   * row lands. It is deliberately NOT a `folder` value: the copy sits under `folder: "Sent"`,
   * which matches no pile view, and this flag is the only thing distinguishing it from a real
   * ingested Sent row until reconciliation removes it.
   */
  local?: boolean;
}

/**
 * The engine's message row — the wire `MessageDTO` (contract §5.2) plus optional
 * client-local extras. Server-fed rows simply leave the extras absent.
 */
export interface EngineMessage extends EngineMessageExtras {
  id: string;
  accountId: string;
  mailboxId: string;
  threadId: string | null;
  messageIdHeader: string | null;
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  date: ISODateTime | null;
  folder: Folder;
  snippet: string;
  unread: boolean;
  /**
   * WHEN THIS MESSAGE STOPPED BEING UNREAD — the order the Ohbox's "Earlier" group is sorted by.
   *
   * `null` where it is not known, and **OPTIONAL because the mirror can be older than the field**.
   * The mirror is persisted on the device: a message row written by a build that predates this
   * field is `undefined` here, not `null`, and both mean the same thing — no reading time is
   * recorded. Declaring it required would be a claim about stored data this type cannot make, and
   * the sort would be reading a value that is genuinely absent. So `absent === null` is the rule
   * every consumer follows, and it is enforced in one place ({@link ohboxView}'s comparator)
   * rather than at each read.
   *
   * Rows the fixtures world mints leave it absent for the same reason: there is no reading history
   * in a demo mailbox, and inventing one would put a fabricated order on screen.
   */
  lastReadAt?: ISODateTime | null;
  hasAttachments: boolean;
  attachmentCount: number;
  sensitivity: SensitivityFlags;
  triage: MessageStateDTO | null;
  labels: string[];
  remoteContent: "blocked" | "loaded" | "none";
  updatedAt: ISODateTime;
}

/**
 * IS THIS MESSAGE'S BODY WITHHELD FROM THE READER — now always NO.
 *
 * This predicate used to blank the body of a message flagged sensitive: the reader saw a lock and
 * a "······" placeholder instead of the mail, and the client refused to cache, fetch or index that
 * body. That is removed. A message body is never hidden from the person reading their own mailbox:
 * the mail already sits in full on their mail server, so hiding the copy shown in the app only hid
 * it from the one person entitled to read it — and the detector that drove it over-fired, blanking
 * ordinary mail (a calendar invite that merely mentioned a code) as if it were a live credential.
 *
 * Sensitivity is still a LABEL — a message that looks like it carries a login code is marked as
 * such and kept out of automatic AI — but the label no longer withholds the body. The predicate is
 * retained as a single named seam (its callers gate body fetch, the local search index and the
 * mirror's body cache) so the "always show the body" decision reads in one place rather than being
 * threaded through each of them; it is a constant `false` on purpose.
 */
export function isProtectedMessage(
  _m: { sensitivity?: SensitivityFlags | null; protected?: unknown } | null | undefined,
): boolean {
  return false;
}

// ── message bodies ─────────────────────────────────────────────────────────

/**
 * What a message's `List-Unsubscribe` / `-Post` headers offer, as the Cloud API reports it on
 * the body fetch (§8). MIRRORS core's `UnsubscribeHeaderState` without importing it — this
 * package speaks the wire vocabulary only.
 *
 *  · `one_click`     — RFC 8058 one-click; the server can POST it on the user's behalf.
 *  · `not_one_click` — an https unsubscribe page exists, but not one-click; open it in a browser.
 *  · `mailto_only`   — only a `mailto:` route, which ohmail never sends on the user's behalf.
 *  · `no_header`     — no unsubscribe route at all. Also the FORWARD-COMPATIBLE DEFAULT: an older
 *                      server that does not send the field is read as offering none (§8).
 */
export type UnsubscribeHeaderState = "one_click" | "no_header" | "mailto_only" | "not_one_click";

/**
 * Why an unsubscribe was refused, mirroring the server's `UnsubscribeRefusal`. Only
 * `"already_recorded"` arrives on a 2xx {@link UnsubscribeResult}; the rest are carried by a
 * thrown `MutationRejectedError` with the server's own sentence (the same shape every refused
 * mutation takes), so a surface renders that message rather than mapping these itself.
 */
export type UnsubscribeRefusal =
  | "not_actionable"
  | "author_failed_authentication"
  | "no_header"
  | "mailto_only"
  | "not_one_click"
  | "already_recorded";

/**
 * What `POST /messages/:id/unsubscribe` answered on a 2xx. A refusal (409) is NOT this — it is a
 * throw carrying the server's sentence, exactly as `fetchBody`'s 402 is. So the only outcomes
 * here are a genuine send (`posted: true`, `refusal: null`) and "this list was already left"
 * (`posted: false`, `refusal: "already_recorded"`), which is not a failure. Fields beyond these
 * are read leniently and unknown ones ignored (§8).
 */
export interface UnsubscribeResult {
  messageId: string;
  /** Did the server actually make the one-click request to the sender? */
  posted: boolean;
  /** The sender's HTTP status, or `null` when nothing was sent. */
  status: number | null;
  refusal: UnsubscribeRefusal | null;
  /** What the headers offered, independent of whether the server acted. */
  header: UnsubscribeHeaderState;
}

/**
 * `GET /messages/:id/body`, as much of it as this client reads.
 *
 * The endpoint answers `{messageId, text, html, headers, loadedRemoteContent}`.
 *
 * ── `html` USED TO BE DROPPED HERE ──────────────────────────────────────────────────
 *
 * This interface was `{ text: string }`, with a comment saying html was not read because
 * rendering it "would need a sanitiser, and it is also where a tracking pixel re-enters a
 * product whose spy-pixel blocker is a feature". Both objections were correct and both are
 * now answered — by the message-body renderer, which sanitizes with
 * DOMPurify and renders into a sandboxed frame that fetches nothing remote.
 *
 * What the narrowing COST, until 2026-08-04: the html part reached this process and was
 * thrown away one line before it was needed, so every reading surface rendered
 * mailparser's `htmlToText` rendition — the `text/plain` alternative — so a real billing
 * mail read as its sender's logo filename in square brackets, with a tracking pixel's
 * url as its last visible line. No amount of work in the renderer could fix that,
 * because the renderer was being handed the wrong input.
 *
 * `text` is ALSO still carried, and is not a legacy field: sensitive mail stores NO html at
 * all (`pipeline.ts` — `html: p.sensitivity.sensitive ? null : …`), plain-text-only mail has
 * none to store, and the html can be refused by the sanitizer. `text` is what all three
 * render.
 *
 * `text` is ALREADY sensitivity-redacted server-side (`message-service.ts`
 * `getBody`: "returned as-is, never re-derived"). This client stores exactly what it was
 * given and never attempts a redaction of its own — a second implementation of that rule is
 * a second place for it to be wrong. The same holds for `html`: the redaction decision is
 * that html is not stored, and this client neither re-derives nor second-guesses it.
 *
 * `headers` is still deliberately unread (contract §8: an unread field is not an error).
 */
export interface MessageBodyWire {
  text: string;
  /**
   * The stored `text/html` part, or `null`. NEVER rendered as-is by anything: it is
   * attacker-authored markup, and the one component allowed to touch it sanitizes it first.
   * It may also be TRUNCATED mid-tag — `prepareHtmlForStorage` cuts at 256 KiB and appends
   * an html comment — which is why the renderer must go through a parser that repairs, and
   * not a string transform.
   */
  html: string | null;
  /**
   * Whether the reader has already said yes to remote content for this message
   * (`message_bodies.loaded_remote_content`, flipped by `POST /messages/:id/load-remote`).
   * `false` is the default and the state every message starts in.
   */
  loadedRemoteContent: boolean;
  /**
   * The sender's unsubscribe posture, DERIVED server-side from the raw headers (which the client
   * never receives). Absent on an older server → the reader defaults it to `"no_header"` (§8).
   */
  unsubscribe: UnsubscribeHeaderState;
  /**
   * The sender's own https unsubscribe page, sent ONLY for `unsubscribe === "not_one_click"`;
   * `null` otherwise. Never a one-click POST token (the server owns that). Absent on an older
   * server → `null` (§8).
   */
  unsubscribeUrl: string | null;
  /**
   * The server's word for why `text` is empty, when it is empty by POLICY — the closed
   * {@link WithheldMarker} set. In every case the mail itself is untouched on the user's own
   * mail server (for `junk_filed` it lives in the provider's Junk folder, where the verdict
   * sent it). Absent on every ordinarily stored body and on an older server (§8). See
   * {@link MessageBodyRecord.withheld} for how the engine carries it and {@link BodyState} for
   * the terminal surface state it becomes.
   */
  withheld?: WithheldMarker;
}

/**
 * WHY a stored body holds no content, when that is policy rather than an empty message — the
 * server's closed set, verbatim (`MessageBodyDTO.withheld`):
 *
 *  · `"storage_cap"` — the account's managed storage cap declined or evicted the hosted copy.
 *  · `"junk_filed"`  — the spam verdict filed the message to the provider's native Junk; the
 *                      durable artifact is the sender rule, and the bytes live on in Junk.
 *  · `"expunged"`    — every watched copy is gone from the server; the row is tombstoned.
 *
 * Every member hydrates as ITSELF into the mirror ({@link MessageBodyRecord.withheld}): a build
 * that narrowed unknown members to `null` would persist "an ordinary, complete, empty body" —
 * ANSWERED, so never re-asked — which is precisely the permanent lie the tri-state ended.
 */
export type WithheldMarker = "storage_cap" | "junk_filed" | "expunged";

/**
 * ONE ROW of the batch body read — `GET /messages/bodies?ids=…`, the thread-open call.
 *
 * Exactly a {@link MessageBodyWire} plus the id it answers for, because the batch route serves the
 * same stored row the single-message route does and there must be no second shape for a body: the
 * engine writes the same `message_body` record from either, so a field carried by one and not the
 * other would make a message render differently depending on how it happened to be opened.
 *
 * The id is on the ROW rather than positional. The server answers only the ids it owns — a
 * cross-account or vanished id is silently ABSENT, never a null placeholder and never an error, so
 * that the response cannot be used as an existence oracle for another account's ids. Position is
 * therefore meaningless and the caller must match on this field.
 */
export interface MessageBodyBatchWire extends MessageBodyWire {
  messageId: string;
}

/**
 * THE HYDRATED BODY, AS A CLIENT-LOCAL RECORD — and why it is not on the message.
 *
 * `message_body` is in {@link MirrorEntityType} and deliberately NOT in
 * {@link SyncEntityType}: `/sync`'s vocabulary has no such type, so no delta can ever
 * carry one and no delta can ever overwrite one. That absence is the whole mechanism.
 *
 * Writing the fetched text onto the `message` row instead would look simpler and would be
 * broken in a way no fixture test can see. `applyToRecords` REPLACES the entity on
 * `create|update` (`apply.ts:56-58`), and opening a message emits `mark_seen`, whose echo
 * is an update carrying a server DTO — which has `snippet` and no `body`. So the body the
 * user is reading would be wiped by the read-receipt of the act of reading it, live only,
 * timing-dependent, and invisible in the demo because the FixturesAdapter's message rows
 * carry `body` already. Keeping the two in separate records makes the failure unreachable
 * rather than unlikely.
 *
 * `state` is on the record rather than derived, because "we asked and the server refused"
 * has to be distinguishable from "we never asked" — see {@link BodyState}.
 */
export interface MessageBodyRecord {
  messageId: string;
  state: "loading" | "ready" | "failed";
  /** The endpoint's already-redacted text. Empty while loading and after a failure. */
  text: string;
  /**
   * The server's word for WHY a `ready` record's text is empty: `"storage_cap"` means ingest
   * declined to store this body because the account was at its managed storage cap — the mail
   * itself is untouched in the mailbox on the user's own server. So `bodyOf` can tell "this
   * message says nothing" from "the server is not holding what it says". ANSWERED-TERMINAL: the
   * server replied, so the single-flight ledger treats it as answered — never `failed` (failed
   * implies Retry, and a retry cannot un-withhold), never re-asked in a loop.
   *
   * ── TRI-STATE, EXACTLY LIKE `html`, AND FOR THE SAME REASON ─────────────────────────────────
   *
   *  · `"storage_cap"`  answered, and withheld.
   *  · `null`           answered by a withheld-AWARE build: this body is ordinarily stored.
   *  · `undefined`      NO withheld-aware build has ever answered for this record.
   *
   * The third case is the one that matters and it used to be unrepresentable. This field was
   * `withheld?: "storage_cap"` written through a conditional spread, so absence meant BOTH "not
   * withheld" and "written by a build that had never heard of the marker" — and that ambiguity
   * was a permanent lie on a rolling upgrade. A tab still running pre-slice code fetches a body
   * the server has just begun withholding, does not know the wire field, and persists
   * `{state: "ready", text: "", html: null}`. Reloaded into withheld-aware code, the hydration
   * guard sees a `ready` record with an `html` key and skips for ever; `bodyOf` reports `full`
   * over an empty body; and the withheld message is indistinguishable from a genuinely empty one
   * for the life of that IndexedDB record. Nothing can heal it, because there is no way to ask
   * "did the build that wrote this understand the marker?".
   *
   * Writing `null` explicitly answers that question, and it terminates for the same reason
   * `html`'s normalization does: the write ALWAYS sets the key, so a healed record can never land
   * back in the re-ask branch. Both write sites must normalize — see `fetchBodyInto` and
   * `fetchBodiesInto`; one of the two left as a conditional spread turns every genuinely empty
   * mail into a once-per-session poll.
   *
   * The WIRE type is deliberately NOT tri-state ({@link MessageBodyDTO.withheld}): absence there
   * still means "not withheld, or a server too old to say", which is a statement about a response,
   * not about what this store has ever been told.
   */
  withheld?: WithheldMarker | null;
  /**
   * The endpoint's html part, or `null` — for a message with none, for sensitive
   * mail, and for every record that is not `ready`. Held here rather than on the message
   * row for exactly the reason the text is: a `/sync` delta must not be able to erase it.
   *
   * ── OPTIONAL, AND THAT IS ABOUT INDEXEDDB RATHER THAN ABOUT MAIL ────────────────────
   *
   * `message_body` records are PERSISTED (`IndexedDbMirrorStore`), so every browser that
   * ran a build from before `html` was read already holds records of the older shape — `{messageId,
   * state, text}` and nothing else. Those rows are not migrated and must not be: the body
   * is re-fetchable from the endpoint at any time, and a migration that invented `html:
   * null` for them would be indistinguishable from a message that genuinely has none.
   * Declaring these required would be the type system asserting something about the
   * store that is false on every existing install. `bodyOf` reads them with `?? null`.
   *
   * ── AND THAT ABSENCE IS NOW THE SIGNAL TO RE-ASK ───────────────────────────────────
   *
   * The paragraph above was right that they must not be migrated and wrong about what it
   * cost to leave them alone. `hydrateBody` returned early on `state === "ready"`, so a
   * message opened before the html part was read was never re-fetched and stayed a text
   * dump FOR EVER, on a build that contains the renderer — reported from a real install,
   * over the very mail that had defined the gap.
   *
   * So `undefined` here is load-bearing and is not merely tolerated: it means "no build
   * ever answered this record's question", and `hydrateBody` re-asks exactly once for it.
   * `null` means a build DID ask and the answer was "there is no html", which is the
   * ordinary state of a plain-text message and of every sensitivity-redacted one, and must
   * NOT re-ask. Never write `undefined` here from new code — `fetchBodyInto` normalises with
   * `?? null` so that a record this engine wrote always carries the key, and that is what
   * makes the re-fetch terminate.
   */
  html?: string | null;
  /** The reader's remote-content decision, as the server last stated it. Optional for the
   *  same reason `html` is: a record written before those fields were read carries neither. */
  loadedRemoteContent?: boolean;
  /**
   * The sender's unsubscribe posture on this hydrated body. Optional for the same reason `html`
   * is: a record persisted before this field was read carries neither, and `bodyOf` reads it with
   * `?? "no_header"`. `null`/absent on every non-`ready` record. */
  unsubscribe?: UnsubscribeHeaderState;
  /** The sender's https unsubscribe page, for `unsubscribe === "not_one_click"` only; else null. */
  unsubscribeUrl?: string | null;
  /** Why the fetch failed, for the console — never rendered to the user. */
  error?: string;
  /**
   * WHEN the fetch failed, as an epoch millisecond — the field that makes a failure survivable
   * across a reload instead of permanent.
   *
   * `hydrateBody` deliberately does NOT re-ask a `failed` record on an automatic trigger: a React
   * effect whose inputs change on every mirror bump would otherwise poll a server that is already
   * refusing, billed per attempt, with nobody behind it. That rule was written for a SESSION and
   * silently applied for ever, because these records are PERSISTED (`IndexedDbMirrorStore`). A
   * body that failed once — a 500 during a deploy, a lost connection, a lambda cold-starting past
   * the 12 s deadline — therefore stayed failed in that browser until the reader happened to press
   * Retry on that exact message. Reloading the tab, which is what everyone does, changed nothing.
   *
   * So the rule is narrowed to what it was always arguing for: never re-ask WITHIN the session
   * that already asked. A record whose `failedAt` predates this engine's boot is from a previous
   * one — a different network, a different deploy, possibly a different day — and is re-asked
   * exactly once, on the next explicit intent.
   *
   * ── ABSENT MEANS STALE ────────────────────────────────────────────────────────────────────
   *
   * Optional for the reason `html` is, and read the same way (`engine.ts` — the `html !==
   * undefined` re-read): every browser that ran a build from before this field already holds
   * `failed` records without it, and those are by construction from an earlier session. `undefined`
   * therefore reads as "older than this boot" and heals, rather than as "just now" and sticking.
   *
   * IT TERMINATES because the engine also remembers, in memory, which ids it has already healed
   * this session — so even a mirror that refuses the new record cannot turn the heal into a loop.
   */
  failedAt?: number;
}

/**
 * What a surface knows about the text it is about to render.
 *
 * The four values exist because ONE of them — `snippet` — is what shipped first: `body ??
 * snippet` renders a one-line truncation as though it were the whole message, with no
 * signal anywhere that there is more. A surface that cannot tell these apart cannot show
 * the difference, so the distinction is in the type rather than in each caller's guesswork.
 *
 *  · `full`     — this IS the whole message. Clamp it, offer the pill, say nothing.
 *  · `snippet`  — a preview; the body has not been asked for. The pill must still be
 *                 offered, or there is no way to ask.
 *  · `loading`  — asked, in flight. Say so.
 *  · `failed`   — asked, refused. Say so, and differently.
 *  · `withheld` — asked, ANSWERED: the server holds no body for this message because the
 *                 account was at its storage cap when it arrived. Terminal, not a failure —
 *                 no Retry (a retry cannot un-withhold), no spinner, and the honest sentence
 *                 instead of a blank pane claiming to be complete. The mail itself is still
 *                 in the mailbox on the user's own server.
 */
export type BodyState = "full" | "snippet" | "loading" | "failed" | "withheld";

/**
 * The body to render plus what it actually is. See {@link BodyState}.
 *
 * `html` is a SECOND rendition of the same message, never a replacement for `text`: a
 * surface picks html when it has a renderer for it and falls back to `text` otherwise, and
 * every surface that cannot render html (a stream card's clamped preview, the Screener's
 * consent preview, a notification) keeps reading `text` and is unaffected by `html`.
 *
 * `html` is non-null ONLY when `state === "full"`. A snippet is not html, and neither
 * `loading` nor `failed` has a body to describe — reporting one there would be the surface
 * rendering a stale document while saying it is still asking for it.
 */
export interface MessageBody {
  /**
   * Present ONLY on the `withheld` state: WHICH policy emptied the stored body, so a surface
   * can say the right sentence for each ({@link WithheldMarker}). Absent everywhere else.
   */
  withheld?: WithheldMarker | null;
  text: string;
  state: BodyState;
  /** The sender's html part, unsanitized. `null` unless `state === "full"`. */
  html: string | null;
  /** Whether the reader has consented to remote content for this message. */
  loadedRemoteContent: boolean;
  /**
   * The sender's unsubscribe posture. `"no_header"` for every state but `full` (nothing to say
   * before the body is hydrated), and the honest default for an older server. A surface offers an
   * action only for `one_click` / `not_one_click`.
   */
  unsubscribe: UnsubscribeHeaderState;
  /** The sender's https unsubscribe page, for `not_one_click` only; `null` otherwise. */
  unsubscribeUrl: string | null;
}

export interface RuleDTO {
  id: string;
  kind: "sender" | "domain" | "header";
  match: string;
  destination: Folder;
  priority: number;
  /**
   * Where this rule came from. `seeded-from-sent` is the onboarding seed: the user had written
   * to this address, so the rule records consent they had already given by writing.
   *
   * `promoted` still conflates a decision the user took in the Screener with one taken for
   * them, which is a distinction worth splitting the day anything decides on their behalf.
   */
  provenance: "manual" | "migrated" | "promoted" | "seeded-from-sent";
  enabled: boolean;
  /**
   * THE RULE'S SECOND TERM, or `null` — *from this address AND with this in the subject*.
   *
   * A conjunction the server evaluates, never something a surface here applies itself: a present
   * term makes the rule fire less often and nothing about it can admit a sender. Two surfaces would
   * be dishonest without it, which is why it is on the mirror rather than server-side only:
   *
   *  · the rules list renders one row per rule, and two rules for one address differing only by
   *    subject term would read as identical duplicates — with two Revoke buttons nobody could tell
   *    apart;
   *  · the sender sheet's rule ladder retargets an existing rule for the address instead of writing
   *    a second one, and a narrow subject rule must NOT be the row it retargets (that would silently
   *    widen a rule the user deliberately narrowed). The ladder needs to see the term to skip it.
   *
   * OPTIONAL on the type, and this is the one field on `RuleDTO` that is. An older server does not
   * send it, and a mirror row that predates the column must read as "no term" rather than as a
   * parse failure — `undefined` and `null` mean the same thing to every reader here.
   */
  subjectContains?: string | null;
  /**
   * THE RULE'S THIRD TERM, or `null` — *from this address AND with this in the message text*.
   *
   * `subjectContains`' contract one field deeper, including WHY it is on the mirror (the rules
   * list must render a body-narrowed rule differently from a bare one, and the sender sheet's
   * ladder must not retarget it) and why it is OPTIONAL: an older server does not send it, and a
   * mirror row predating the column reads as "no term" — `undefined` and `null` are the same
   * thing to every reader here.
   */
  bodyContains?: string | null;
  stats: { hits: number; lastHitAt: ISODateTime | null; demotions: number };
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface EngineDraft {
  id: string;
  mailboxId: string;
  threadId: string | null;
  inReplyToMessageId: string | null;
  subject: string;
  body: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  /** Blind-carbon recipients. Delivered on the envelope only; never a header on the sent mail. */
  bcc: EmailAddress[];
  rationale: string | null;
  status: "draft" | "sending" | "sent" | "unverified";
  /** Client-local: the user took the AI draft into the editor. */
  accepted?: boolean;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ── client-local entities (fixtures / demo world) ──────────────────────────

/**
 * A tag. NO LONGER FIXTURE-ONLY — it is a real `/sync` entity backed by the `tags`
 * table, and this interface is now the client mirror of the server's `TagDTO`.
 *
 * A tag is OURS: a row in our database keyed by message, and never an IMAP folder. That is why
 * it can be created and destroyed by the product at all, and it is also why the UI tells the
 * truth about its lifetime — a disconnect keeps tags (a mailbox `delete` is a reversible soft
 * delete), but erasing the account takes them, and a tag never outlives its message. The user's
 * FOLDERS survive leaving because they are real IMAP folders; their tags do not.
 *
 * `className` is OPTIONAL because the server does not send it: a CSS class is presentation, not
 * account data. The fixture adapter still supplies one, and `hueOf` derives the rendering from
 * `hue` for both worlds.
 */
export interface TagDTO {
  id: string;
  name: string;
  hue: string;
  className?: string;
  createdAt?: ISODateTime;
  updatedAt?: ISODateTime;
}

/**
 * One of the mailbox's OWN folders — a `"folder"` entity off `/sync` (FOLDERS-SPEC.md §4).
 *
 * `name` is the CANONICAL `/`-joined path ("Projects/Acme") and the natural key — the same
 * spelling `MessageDTO.folder` carries for mail living there, so a view can join the two with
 * `===` and nothing else. The id is the server's inventory row id; it names the entity on the
 * wire and in a URL (`#/folder/<id>`), never in the organizer profile.
 *
 * `mailboxId`/`mailbox` extend the spec's minimal `{ id, name }` deliberately: the rail sections
 * folders BY MAILBOX when an account has more than one (spec §14), every folder-shaped menu is
 * mailbox-scoped, and a live client has no other mirror source for the owning address — the
 * `mailbox` entity type is fixture-world only (`/sync` never emits it).
 *
 * Emitted ONLY while the account's "Use folders" flag is on. A mirror with no `folder` entities
 * is byte-identical to the pre-feature mirror, which is the flag-off parity claim (spec §10).
 */
export interface FolderEntity {
  id: string;
  /** Canonical `/`-joined path, exactly as messages carry it. */
  name: string;
  mailboxId: string;
  /** The owning mailbox's address — the rail's section label when 2+ mailboxes exist. */
  mailbox: string;
  updatedAt?: ISODateTime;
}

export type ScreenerSegment = "waiting" | "screened_out" | "spam";

export interface ScreenerHeldMail {
  /** Own identity, so a held message is never just a slot in a count. */
  id: string;
  subject: string;
  time: string;
  body: string;
  /**
   * WHAT `body` ACTUALLY IS. Absent ⇒ `full`, which is the fixture world:
   * a `screener_sender` entity carries its held bodies verbatim and there is nothing to
   * hydrate. A DERIVED row — every row on a Cloud account — starts at `snippet` and moves
   * through `loading` to `full` or `failed`, and the preview has to say which, because a
   * consent decision taken on a truncation is the risk the Screener exists to remove.
   */
  bodyState?: BodyState;
  /**
   * The stored `text/html` part, or null. Carried so the Screener renders a stranger's mail
   * with the SAME sandboxed renderer the reading pane uses — sanitized, in a frame that cannot
   * phone home, remote images blocked until consent — rather than as a text dump the consent
   * decision is taken on. Null on a fixture row (the demo carries text only) and on every
   * non-`full` `bodyState`, which is the contract {@link bodyOf} already keeps: only a hydrated
   * `ready` body has a document to show. Optional so a `screener_sender` fixture entity, whose
   * held array is carried verbatim, needs no new field.
   */
  html?: string | null;
  /** Whether the reader has consented to remote content for THIS held message. */
  loadedRemoteContent?: boolean;
  /**
   * The sender's unsubscribe posture on THIS held message, from its hydrated body. The Screener's
   * screened-out and spam previews render an unsubscribe control from it (one-click acts via the
   * route, not-one-click links out). Absent on a fixture row and until the body is `full`, which
   * is why it is optional and defaulted to `"no_header"` where read. */
  unsubscribe?: UnsubscribeHeaderState;
  /** The sender's https unsubscribe page, for `not_one_click` only; else null/absent. */
  unsubscribeUrl?: string | null;
  trackerNote?: string;
}

export interface ScreenerSenderDTO {
  id: string;
  segment: ScreenerSegment;
  from: EmailAddress;
  initial: string;
  time: string;
  scope: "sender" | "domain";
  dull?: boolean;
  /**
   * The advice on record for this sender, or `null` when none was ever bought.
   *
   * `noAnswer` is the third thing this field can say, and it exists because the other two could
   * not say it. A run that could not answer for a sender left the row looking exactly like a row
   * nobody had asked about, on a surface the person had just paid to fill in. Present ⇒ `dest` is
   * `screener`, there is nothing to act on, and the reason is the whole of the content.
   *
   * It was `withheld`, with a `"withheld"` member meaning "this mail is one we never send to a
   * model". Under the AI-OPEN ruling of 2026-08-08 there is no such mail on a path a person asked
   * for, so both the member and the name are gone. Every reason left is a fact about the RUN and
   * every one of them is answered by asking again.
   */
  ai: {
    dest: OhmailView | "screened" | "spam";
    confidence: number;
    rationale: string;
    noAnswer?: "out_of_credits" | "spend_unavailable" | "model_unavailable";
  } | null;
  /**
   * NO-COLLAPSE: every held message, in full, oldest first —
   * non-empty in every segment. There is deliberately no `heldCount` /
   * `lastSubject` / `lastBody` beside it: a count that is not `held.length`
   * can drift, and a "last body" is how held mail becomes hidden mail.
   */
  held: ScreenerHeldMail[];
  /** screened_out only */
  screenedOn?: string;
  /** spam only */
  detection?: { source: string; confidence: number; reason: string; label: string };
  /**
   * TRUE when `screenerSegments()` computed this row from the MESSAGE MIRROR rather
   * than reading a `screener_sender` entity — i.e. every row on a Cloud
   * account, and none in the demo world.
   *
   * It is not cosmetic. `id` is then the representative MESSAGE id, which is what
   * `POST /screener/:id` resolves, and the surrounding affordances differ: the server
   * has no un-screen and no delete endpoint, so releasing a derived screened-out or
   * quarantined sender is per-message `move`, and Delete is not offered at all. The
   * UI must not guess which kind of row it has.
   */
  derived?: true;
  /**
   * WHETHER THE REPRESENTATIVE IS PHYSICALLY AT THE GATE (`ohmail/Screener`) — waiting rows only.
   *
   * `screenerSegments` runs over the PROJECTED reader, in which an active-undecided sender's
   * INBOX mail is PRESENTED in the Screener even though it never left the INBOX. Such a row's
   * representative is physically in the INBOX, so `POST /screener/:id` would 404 it and
   * `derivedScreenerEffects` refuses it locally — a decide on it is a no-op that claims success.
   * `false` marks exactly that case, so the commit path routes the decision PAST THE GATE
   * (`rule_create`) instead. `true` when the rep is genuinely held; absent on a fixture row.
   *
   * It is the observable record of that split, not its authority: `screener-state.ts#commit`
   * re-reads the RAW mirror at commit time, because this DTO was computed at an earlier render
   * and the projection can move under it.
   */
  gatePhysical?: boolean;
  updatedAt: ISODateTime;
}

/** A triage pile entry with no backing message in the demo world. */
export interface TriageItemDTO {
  id: string;
  pile: Exclude<TriageState, "none" | "muted">;
  title: string;
  subtitle?: string;
  preview?: string;
  resurfaceAt?: string;
}

/**
 * The reading streams a waterline exists for. The Ohbox is deliberately not one of
 * them: it keeps per-row unread state, while these two piles carry no per-row newness
 * at all — the line is their only signal.
 */
export type FeedView = "reads" | "receipts";

/**
 * Each stream's `view_meta` row id. One mapping, shared by the `feed_mark_seen`
 * effect that writes the line and the partition selector that reads it, so the two
 * can never disagree about where a view's waterline lives.
 */
export function waterlineIdOf(view: FeedView): string {
  return view === "reads" ? "reads_waterline" : "receipts_waterline";
}

/**
 * `view_meta` ids "reads_waterline" / "receipts_waterline" — a stream's
 * seen-up-to-here marker, one row per {@link FeedView}.
 *
 * `newestSeenId` is the newest message that was on screen when the reader last left
 * the view, and the line renders directly ABOVE it: that message was seen, so it may
 * not present as "new since last visit". Everything strictly newer is above the line.
 * This is deliberately EXCLUSIVE — the old inclusive reading (line after the anchor)
 * could never say "everything here is old news", because the anchor itself stayed
 * above the line after a visit that had plainly seen it.
 *
 * `at` is when the line was committed (leave time); the views format it in the
 * reader's locale. `label`/`meta` are authored copy on the demo fixture only — a
 * live commit writes no display strings into the mirror.
 */
export interface WaterlineMeta {
  newestSeenId: string;
  at?: ISODateTime;
  label?: string;
  meta?: string;
}

// ── views ──────────────────────────────────────────────────────────────────

/** Views are CLIENT groupings over folders, not folders (brief §4). */
export type OhmailView = "ohbox" | "reads" | "receipts" | "screener" | "screened" | "spam";

export const FOLDER_OF_VIEW: Record<OhmailView, Folder> = {
  ohbox: "INBOX",
  reads: "ohmail/Reads",
  receipts: "ohmail/Receipts",
  screener: "ohmail/Screener",
  screened: "ohmail/Screened",
  spam: "ohmail/Quarantine",
};

/**
 * The last path segment of a folder name — the only safe way to show a folder
 * this client has no view for.
 *
 * It exists rather than views falling back to the raw string because unknown
 * folders are expected: the server may add folders a shipped client has never
 * heard of (contract §8), and customers nest their own. The leaf of
 * `ohmail/Receipts` is `Receipts`; the leaf of a customer's own
 * `Archive/2026/Q1` is `Q1`. Both read correctly; neither shows a path.
 */
export function folderLeaf(folder: string): string {
  const leaf = folder.split("/").filter(Boolean).pop() ?? folder;
  return leaf.trim() || folder;
}

/**
 * The five views a Screener decision may file mail INTO — every view except `screener` itself.
 *
 * `screener` is where mail is HELD, never a destination consent can choose: a promoted rule
 * pointing back at the gate would re-screen that sender for ever. The server refuses it with a
 * 400 (`screener-service.ts` — `DECIDABLE_FOLDERS`); this type is why a client cannot ask.
 */
export type ScreenDest = Exclude<OhmailView, "screener">;

export const VIEW_OF_FOLDER: Record<Folder, OhmailView> = {
  "INBOX": "ohbox",
  "ohmail/Reads": "reads",
  "ohmail/Receipts": "receipts",
  "ohmail/Screener": "screener",
  "ohmail/Screened": "screened",
  "ohmail/Quarantine": "spam",
};

// ── mutations ──────────────────────────────────────────────────────────────

/**
 * The optimistic mutation vocabulary. Each mutation is applied locally at once
 * (user-always-wins) and mapped by the adapter to its wire endpoint (HTTP) or
 * served in-place (fixtures).
 */
export type EngineMutation =
  | { kind: "move"; messageId: string; folder: Folder }
  /**
   * DELETE — the message rides to the provider's native `\Trash` on the server (never an
   * expunge) and leaves the mirror's living views everywhere (`DELETE /messages/:id`, mail
   * 0065). The optimistic effect is the tombstone itself; a mailbox with no Trash folder is
   * refused by the server (422 `no_trash_folder`) and the overlay rolls back, which is the
   * honest screen for a delete that cannot happen.
   */
  | { kind: "message_delete"; messageId: string }
  /**
   * `state: "resurfaced"` is the "Now" horizon and takes no `bubbleUpAt` — the server forces it
   * null, and so does the optimistic effect, so the two halves agree. See
   * {@link TriageWireState}.
   */
  | { kind: "triage_set"; messageId: string; state: TriageWireState; bubbleUpAt?: ISODateTime | null }
  | {
      kind: "screener_decide";
      senderId: string;
      decision: "yes" | "no";
      /**
       * Which of the five the user pressed — **and it is now on the wire.**
       *
       * `POST /screener/:id` carries this field, files the held mail there and promotes the
       * rule at the same folder. It used to be a local-only hint the adapter dropped, which
       * is what made three of the five buttons decoration: the server answered with `INBOX`
       * or `ohmail/Screened` whatever was pressed, and the follow-up `move`s the surfaces
       * composed to cover the difference lost a race against the decide's own write.
       *
       * `ScreenDest` and not {@link OhmailView}: `screener` is where mail is HELD, never a
       * place a decision can file it to, and the server refuses it.
       */
      dest?: ScreenDest;
      /** "&read" seen-semantics: a Yes files the held mail already-seen (unread=false). */
      read?: boolean;
      scope?: "sender" | "domain";
    }
  | {
      kind: "tag_assign";
      messageId: string;
      tagId: string;
      assigned: boolean;
      /**
       * Filled by the engine at mutate() time: the full next labels array.
       *
       * FOR THE OPTIMISTIC EFFECT ONLY — it is deliberately NOT the wire body, though it was
       * described as one before the backend existed. Sending an array would be a
       * read-modify-write, and two concurrent toggles of different tags on one message would
       * lose one of them. The adapter sends `{ tagId, assigned }`; see `http-adapter.ts`.
       */
      labels?: string[];
      /**
       * TAG-OR-CREATE, and it is no longer the ONLY way to mint a tag — see `tag_create`
       * below, which is the standalone verb this comment used to say did not exist. This one
       * stays because it is a different act: tagging a message with a name that happens to be
       * new is one gesture and one request, and splitting it into create-then-assign would put
       * a window between them in which the tag exists on nothing.
       *
       * `tagId` is then a CLIENT-MINTED uuid and the server uses it as the new row's id — so
       * the optimistic paint names the same tag the database ends up holding. If the name
       * turns out to already exist (a race, or a case-insensitive collision), the EXISTING
       * tag wins and the client's id is simply never seen; `tagsOfMessage` filters ids the
       * mirror does not know, so the chip appears one drain later under the correct id rather
       * than rendering something false in the meantime.
       */
      createName?: string;
    }
  /**
   * ═══ THE THREE TAG VERBS THAT HAD NO CALLER ═══════════════════════════════════════════
   *
   * `POST /tags`, `PATCH /tags/:id` and `DELETE /tags/:id` have been mounted and
   * contract-tested the whole time with **zero client callers** — the same "built, tested,
   * unreachable" shape `tag_assign`'s own comment records, and the shape the rules CRUD was
   * in before `rule_delete`/`rule_update` existed. The Settings pane offered Rename and
   * Delete buttons that raised a toast saying the feature was not wired up, and there was no
   * way at all to make a tag without first finding a message to put it on.
   *
   * They are engine mutations rather than a Cloud-only seam for the reason the rules pane
   * gives in `views/SettingsView.tsx`: `tag` is a real `/sync` entity, so the list comes from
   * the mirror and the demo, the desktop shell and a live account are all correct with no
   * special case — `FixturesAdapter` serves whatever `mutationEffects` produces.
   *
   * ── `tagId` IS A CLIENT-LOCAL NAME, NOT THE ROW'S ID ──────────────────────────────────
   *
   * Unlike tag-or-create above — where `POST /messages/:id/tags` genuinely mints under the
   * id the client chose — `POST /tags` takes `{ name, hue? }` and the database mints the id.
   * So `tagId` here names only the OPTIMISTIC row, which the engine deletes the instant the
   * mutation confirms, and the server's row arrives in the change the adapter returns. This is
   * the `rule_create` shape exactly. A name collision (the unique index is on `lower(name)`)
   * answers 409 and the optimistic row rolls back, which is the honest outcome — the surface
   * checks for the collision first, so 409 is the race and not the normal path.
   */
  | { kind: "tag_create"; tagId: string; name: string; hue?: string }
  /**
   * RENAME — NAME ONLY. The colour travels on its own verb ({@link tag_recolor}); a rename that
   * also carried a hue would make one "Save" mean two things and send a field the user did not
   * touch. `PATCH /tags/:id` accepts `name` alone, which is what this sends.
   */
  | { kind: "tag_rename"; tagId: string; name: string }
  /**
   * RECOLOUR — HUE ONLY, and the obstacle it waited on is gone.
   *
   * `TagsService.HUES` and `packages/ui`'s `TagHueName` used to be two different lists — six
   * server names (`moss|clay|slate|plum|amber|teal`) against three renderable ones
   * (`moss|ochre|rosewood`), overlapping only on `moss` — so any colour a picker could offer was
   * one the other half could not honour: an invisible dot or a 400. They are reconciled to the
   * hues the Blanc system actually paints, so every hue on the wire renders and every hue the
   * picker shows validates. That reconciled set is now TEN rather than three; the widening added
   * token families and `chip.css` rules on the client in the same change as the server's list,
   * and needed no migration because `tags.hue` is plain `text` with no CHECK.
   * `PATCH /tags/:id` takes `{ hue }` on its own.
   */
  | { kind: "tag_recolor"; tagId: string; hue: string }
  /**
   * DELETING A TAG TAKES IT OFF EVERY MESSAGE, AND THE EFFECT SAYS SO.
   *
   * `TagsService.remove` deletes the `message_tags` rows in the same transaction as the tag
   * and appends one `message` change per affected message, so the server's own answer clears
   * the chips. `mutations.ts` mirrors that rather than only tombstoning the tag row — an
   * effect that dropped the tag but left the ids in `labels` would paint chips for a tag the
   * mirror no longer has until the next drain.
   *
   * The messages themselves are untouched. A tag is a row keyed by message, never an IMAP
   * folder, so deleting one moves no mail — the surface has to say that before it asks.
   */
  | { kind: "tag_delete"; tagId: string }
  /**
   * A READING STREAM'S SEEN-STATE — the \Seen sweep and the waterline, one verb for both piles.
   *
   * `view` names which stream ({@link FeedView}; absent ⇒ `reads`, which is every caller that
   * predates Receipts having a line). It is ONE widened verb and deliberately not a second one:
   * the effect filters its flips to `FOLDER_OF_VIEW[view]` BY CONSTRUCTION and writes that
   * view's own `view_meta` row ({@link waterlineIdOf}), so Reads' line cannot move because
   * Receipts was left, and an id from any other folder is dropped locally exactly as the
   * Reads-only version dropped it.
   *
   * TWO ACTS, SEPARABLE ON PURPOSE:
   *
   *  - `messageIds` is the \Seen sweep — the flips reach the user's own IMAP server via the
   *    per-message PATCH loop. Absent ⇒ filled at mutate() time with every unread id in the
   *    view's folder (the mark-the-whole-feed form).
   *  - `upToId` is the waterline commit — the anchor the line will render directly ABOVE
   *    ({@link WaterlineMeta.newestSeenId}). ABSENT MEANS THE LINE DOES NOT MOVE. The line is
   *    "new since last visit", so it must hold still for the whole visit and move exactly once,
   *    when the reader leaves; the per-message sweep passes ids only, and the leave commit
   *    passes both. (It used to default to the newest message, which let every dwell-mark drag
   *    the line around mid-visit.)
   *
   * The waterline is CLIENT STATE: `/sync` has no `view_meta` entity type, so nothing about the
   * line crosses the wire — only the PATCHes do. The engine persists the meta past the
   * overlay's own lifetime (see `dispatch`), which is what makes the line survive its mutation
   * confirming on a live account.
   */
  | {
      kind: "feed_mark_seen";
      /** Which stream's folder and waterline. Absent ⇒ `reads`. */
      view?: FeedView;
      /** Waterline anchor — the newest message that was on screen. Absent ⇒ the line stays put. */
      upToId?: string;
      /** Filled by the engine at mutate() time: the unread ids of the view's folder to flip. */
      messageIds?: string[];
    }
  /**
   * FOLDER-AGNOSTIC read-state — the one thing `feed_mark_seen` still is not.
   *
   * `feed_mark_seen` is a STREAM's verb: its optimistic effect drops every id outside its
   * view's folder by construction (now per-{@link FeedView}, no longer Reads-only) while its
   * wire side would PATCH anything. Outside that folder the two halves disagree — the server
   * flips a message the local overlay did not — so reusing it for the Ohbox, or for any
   * cross-view selection, would produce a row that stays bold until the next drain and then
   * silently changes under the cursor. This one flips exactly the ids it is given, wherever
   * they live, and its wire side sends exactly the same list. It also never touches a
   * waterline, which is what makes it safe for surfaces that are not streams.
   *
   * `unread` and not a `seen` verb: it is the field the mutation sets, on the wire and in the
   * mirror, so `u` (toggle unread) and "mark selection read" are one mutation with two values
   * rather than two mutations that must be kept in agreement.
   */
  | {
      kind: "mark_seen";
      messageIds: string[];
      unread: boolean;
      /**
       * WAS THIS READ AN ACT, OR JUST A LOOK?
       *
       * The two are indistinguishable by the time they reach here — same verb, same ids, same
       * `unread: false` — and exactly one thing turns on the difference: a resurfaced row is
       * answered by being DEALT WITH, and the server spends its pin on a DELIBERATE read. So a
       * surface that marks mail read on the reader's behalf has to say so, or a two-second dwell
       * takes down a pin the user never answered.
       *
       * `"glance"` is claimed by the surfaces that decide FOR the reader: the Ohbox's dwell
       * commit and the Receipts per-card mark. Everything else — the read pill, `⇧I`, a bulk
       * selection, read-all, and the settled reply that marks its parent read — is the reader
       * saying so, and omits this.
       *
       * A GLANCE-LABELLED READ STILL LANDS (owner ruling 2026-08-26: a resurfaced message keeps
       * its genuine read state, and reading it sticks like anywhere else). The label travels on
       * the wire and the server marks read WITHOUT spending the pin — the engine no longer drops
       * pinned ids from a glance, which is what used to turn a read row back to unread.
       *
       * ABSENT MEANS DELIBERATE, which is the safe default in the only direction that matters: a
       * new call site that forgets this field spends the pin, which is the behaviour every caller
       * had before the field existed. The failure mode of forgetting it is a pin that comes down
       * a little too eagerly, never a pin that can never be answered.
       */
      via?: "glance";
    }
  /**
   * SEND MAIL — the one mutation whose effect leaves the building.
   *
   * ── ONE VERB, TWO ENTRY POINTS ─────────────────────────────────────────────────────────
   *
   * It shipped as `reply_send` and was generalized rather than copied: Compose needed
   * the same idempotency key, the same four-outcome failure surface, the same "a 200 is
   * inspected, not trusted" reading of the wire and the same double-send lock. A second
   * implementation of "send an email" is two places for "one press is one delivery" to be true
   * in, which is one place too many. `inReplyTo` is the ONLY difference between the two callers.
   *
   * ── `inReplyTo: null` IS LOAD-BEARING, NOT A DEFAULT ───────────────────────────────────
   *
   * A fresh compose starts a NEW conversation and must carry no `In-Reply-To` and no
   * `References`. Those headers are minted server-side from `drafts.inReplyToMessageId`
   * (`send-service.ts`: the whole threading block is inside `if (d.inReplyToMessageId)`), so
   * a null here is what keeps a stranger's Message-ID out of a message that is not answering
   * them. `null` rather than "absent" so a caller cannot forget the field and inherit
   * whatever a previous send left in scope.
   *
   * ── THE MUTATE-TIME EFFECT IS A `sending` DRAFT; THE SENT COPY IS A CONFIRM-TIME OVERLAY ─
   *
   * Every other verb here is a local edit the server later agrees with, and a rejection rolls the
   * overlay back with nothing lost. A send is not reversible that way: a message that reached SMTP
   * cannot be un-sent, so nothing OPTIMISTIC — applied at mutate time, before the server has
   * answered — may assert that it arrived. The mutate-time effect is therefore ONE `draft` row at
   * `status: "sending"`, the same state the server writes on its reservation, and NOT a Sent
   * message row (`mutations.ts` `effectsOf`).
   *
   * What changed: the Sent copy IS now shown instantly, but only ONCE THE SERVER CONFIRMS the
   * send. `POST /drafts/:id/send` answering `{status:"sent", providerMessageId}` is the mailbox's
   * own word that the message left and was appended to Sent, so on that confirm the engine
   * materialises a provisional Sent-folder message (`sentOverlayMessage` → the engine's overlay
   * merge) carrying the minted `messageIdHeader`. That is not the fabrication this comment used to
   * forbid: it is created on the confirmation, not ahead of it, and it is reconciled AWAY —
   * dropped by `messageIdHeader` — the moment the worker's Sent-folder watch delivers the real row
   * on a later drain, with a ~10-minute TTL as the backstop and an immediate drop if the send is
   * rejected. So the earlier rule ("deliberately NOT a Sent-folder message row") held for the
   * OPTIMISTIC effect and still does; the confirmed send is a different moment, and the reader's
   * own reply appearing in the conversation in under a second is worth a row the next drain
   * replaces with the identical real one.
   *
   * The three non-delivered outcomes are distinguishable at the call site and MUST stay
   * that way — `send_unverified` (SMTP threw and the Sent probe found nothing: genuinely
   * ambiguous), `send_failed` (a terminal prior attempt under this key), and a retryable
   * `in_flight`/network rejection that keeps the intent queued. A queued send that looks
   * like a delivered one is the failure this vocabulary exists to prevent.
   *
   * ── WHAT `Engine.enrich()` FILLS, AND WHAT IT MUST NOT ─────────────────────────────────
   *
   * For a REPLY the optional fields are derived from the parent (recipient, subject, mailbox,
   * thread), exactly as `tag_assign.labels` is, so the overlay and the wire body are computed
   * once from the same state and cannot disagree. For a COMPOSE the recipient and the subject
   * are the USER's and are never derived; only `mailboxId` is filled, from the mirror
   * (`sendingMailboxId`), because the account's own address is not something a compose form
   * can know.
   *
   * `cc` and `bcc` are both DELIVERED. They ride
   * `POST /drafts`, are stored on the row, and `SendService` copies them into `OutboundMessage`
   * (cc + bcc → the SMTP RCPT list). The privacy line lives at the MIME builder, not here: cc is a
   * `Cc:` header on the sent mail, bcc is on the envelope ONLY and never a header (`imap.ts#send`).
   * Compose fills both from the user's own fields. A reply-to-all fills `cc` with the parent's
   * surviving Cc line (the webapp's `replyAllRecipients`); a plain reply leaves both unset, and
   * `bcc` is never derived — no reply of any kind blind-copies anybody.
   */
  | {
      kind: "mail_send";
      /**
       * The message being answered, or `null` for a fresh compose — see above. A reply's
       * recipient, subject, mailbox and thread are all derived from it.
       */
      inReplyTo: string | null;
      /**
       * THE MESSAGE BEING FORWARDED — the EXCLUSIVE PEER of {@link inReplyTo}.
       *
       * A forward is not a reply: it carries no `In-Reply-To`, threads onto no conversation, and
       * goes to recipients the USER picks, so `inReplyTo` is `null` on a forward and this names the
       * original instead. Exactly one of the two is ever non-null.
       *
       * The client sends only the ID. The SERVER owns the rest: given `forwardOf` it reads the
       * original, REFUSES if it is `no_forward` (a sensitive body must never leave the account
       * through a quote block — the OTP-leak this closes), appends the quoted original to the body,
       * and STREAMS the original's attachments from IMAP at send time — none of which the client
       * can be trusted to assemble, because a client-built quote is exactly the seam a redacted body
       * would escape through. The compose surface offers a forward entry ONLY for a message that is
       * not `no_forward`; this field is the server's second, authoritative check on the same rule.
       */
      forwardOf?: string | null;
      /**
       * THE DRAFT ROW THIS MESSAGE ALREADY IS, when there is one.
       *
       * A compose autosaves through `draft_save`, so by the time Send is pressed the account
       * usually already holds this message as a `drafts` row. Naming it here is what makes the
       * send USE that row: the adapter skips its `POST /drafts` and goes straight to
       * `POST /drafts/:id/send`, so a message is one row from the first keystroke to delivery
       * instead of leaving an abandoned twin behind on every send.
       *
       * Absent for a reply and for any surface that does not autosave, which is the path this
       * had before autosave existed and still works unchanged: the adapter creates the row and
       * sends it in two requests.
       *
       * The final field values still travel on the mutation and the adapter PUTs them before
       * sending — the debounce means the last two seconds of typing may not have reached the
       * row, and "the message I sent is not the message on screen" is not a defect anybody would
       * find twice.
       */
      draftId?: string;
      /**
       * Exactly what the user typed, as plain text. No quoted original: see the http adapter.
       *
       * When {@link html} is set this is the LOCAL plain rendering of it, used for the
       * optimistic draft row and for deciding there is something to send. It is not what the
       * recipient's plaintext client will read: the server derives that from the sanitized
       * html, so the two parts of the multipart cannot be made to disagree by a client. The
       * mirror converges on the server's rendering at the next drain, which is the ordinary
       * optimistic-overlay contract rather than an exception to it.
       */
      body: string;
      /**
       * The rich body, as the editor produced it, or absent for a plain-text send.
       *
       * Sent INSTEAD of `body` on the wire — `POST /drafts` refuses both in one request,
       * because accepting both is how two clients end up disagreeing about which one the
       * recipient sees.
       */
      html?: string;
      mailboxId?: string;
      threadId?: string | null;
      subject?: string;
      to?: EmailAddress[];
      /** Carbon recipients (Compose, and a reply to all). A `Cc:` header on the delivered mail. */
      cc?: EmailAddress[];
      /** Blind-carbon recipients (Compose only). Delivered on the envelope; never a header. */
      bcc?: EmailAddress[];
      /**
       * FILES TO ATTACH — bytes, carried to the send request and never stored (see {@link
       * ComposeAttachment}). Reply and Compose alike may set it; absent for a plain send. The http
       * adapter puts these on `POST /drafts/:id/send`, the server decodes and hands them to the
       * transport, and the mailbox's own Sent copy carries them because it is built from the same
       * message. They are NOT part of the autosaved draft — a draft holds no attachment bytes.
       */
      attachments?: ComposeAttachment[];
    }
  | { kind: "draft_accept"; draftId: string }
  /**
   * ── AUTOSAVE: THE COMPOSE FORM BECOMES A ROW, AND STAYS THE SAME ROW ────────────────────
   *
   * A message somebody is writing used to live in one place — `localStorage`, under one key, in
   * this browser. That is enough to survive navigating away and a reload, and it is not enough
   * for anything else: close the tab on a phone and the draft is on the laptop's disk, not in
   * the account; clear site data and it is gone; and nothing on the mailbox ever knew about it.
   *
   * This writes it to the account instead. `draftId: null` CREATES (`POST /drafts`), and the
   * server's id comes back on {@link MutationResult.entityId} so the surface can adopt it. A
   * non-null id UPDATES that row (`PUT /drafts/:id`). One row from the first meaningful keystroke
   * to delivery: `mail_send` takes the same id rather than creating a second.
   *
   * ── WHY THIS IS AN ENGINE MUTATION AND NOT AN `app/api-client` CALL ─────────────────────
   *
   * The same argument `rule_delete` makes: the surface lives in `apps/webapp/app/views`, which is
   * copied into the public desktop mirror, and that mirror does not contain `app/api-client` at
   * all. The engine is the only wire a shared-shell view has. It also buys the two things a
   * hand-rolled fetch would not: the overlay, so the Drafts list shows what was just typed before
   * the server has answered, and `/sync`, which is what makes the draft appear on another device.
   *
   * ── WHAT IT DELIBERATELY DOES NOT CARRY ────────────────────────────────────────────────
   *
   * No `status`. A draft row is created at `draft` and only `POST /drafts/:id/send` may move it —
   * a client that could set the column would be a second path to "this was sent", written by the
   * side of the wire that cannot know whether it was.
   */
  | {
      kind: "draft_save";
      /** `null` ⇒ create. A server id ⇒ update THAT row. Never a client-minted id. */
      draftId: string | null;
      /**
       * The SENDING mailbox. Required on create; on an update it RE-TARGETS the row — the From
       * pick has to reach the account, or a draft reopened on another device sends from the
       * identity the row froze at its first autosave. The server refuses the move on any row
       * past `draft` (409), so a send in flight keeps the identity it was reserved under.
       */
      mailboxId?: string;
      threadId?: string | null;
      inReplyToMessageId?: string | null;
      subject: string;
      /**
       * The plain rendering, always. It is what the Drafts list shows and what decides there is
       * anything worth saving; when {@link html} is set the server derives the delivered
       * plaintext from the markup instead, exactly as it does for `mail_send`.
       */
      body: string;
      /** The markup, or absent for a plain-text draft. Never sent beside `body` on the wire. */
      html?: string;
      to: EmailAddress[];
      cc: EmailAddress[];
      bcc: EmailAddress[];
    }
  /**
   * THROW THE DRAFT AWAY — `DELETE /drafts/:id`, and a tombstone in the mirror.
   *
   * Discard is a real verb here in a way it was not when a draft was a `localStorage` key: the
   * row is on the account and on every device, so "I do not want this any more" has to be said
   * out loud rather than by clearing a form. An unknown id yields no effects, which the engine
   * reports as `not_found` without going near the wire — the right answer for a draft a
   * concurrent drain already removed.
   */
  | { kind: "draft_discard"; draftId: string }
  /**
   * REVOKE A RULE, AND CHANGE WHERE ONE FILES — the undo for the consent gate.
   *
   * ── WHY THESE ARE ENGINE MUTATIONS AND NOT `app/api-client` CALLS ───────────────────────
   *
   * Exactly the argument `tag_assign.createName` makes, and it is not a preference: the
   * surface lives in `apps/webapp/app/views`, which `scripts/publish-desktop.mjs` copies
   * into the public desktop mirror, and that mirror does not contain `app/api-client` at
   * all (the same script DENYs it). The engine is the only wire a shared-shell view has.
   *
   * ── THE PRECEDENT THIS IS DELIBERATELY FOLLOWING ────────────────────────────────────────
   *
   * `tag_assign` threw {@link UnsupportedMutationError} for the whole of Stage 2 while a
   * finished tag UI sat on top of it, so every real account painted a tag optimistically
   * and watched the overlay roll it back with no error on screen — green against fixtures
   * the entire time. `DELETE /rules/:id` and `PATCH /rules/:id` are mounted, tested and
   * were reachable from nothing. Adding the surface WITHOUT these two cases would have
   * reproduced that failure verbatim, one entity along.
   *
   * ── WHAT A REVOKE DOES NOT DO ───────────────────────────────────────────────────────────
   *
   * It does not move mail. `RulesService.remove` deletes the `rules` row and appends one
   * `rule` delete to the change log; it never touches `folder_state`, so every message the
   * rule ever filed stays exactly where it is. The same is true of a destination change:
   * rules are consulted by the routing pass when mail ARRIVES, never retroactively. The
   * surface is required to say so BEFORE the user commits,
   * because "undo the rule" silently re-sorting a backlog is a worse surprise than the rule
   * was — see `RulesView`.
   */
  | { kind: "rule_delete"; ruleId: string }
  /**
   * `destination` only, though `PATCH /rules/:id` accepts kind/match/priority/enabled too.
   *
   * Destination is the field the user has a mental model for — "this sender goes to the
   * wrong pile" is the whole of it — and it is the only one whose new value the surface
   * can offer as a closed set of six folders it already renders names for. `match` is a
   * free-text field whose validity is a server concern, and re-keying a rule's `kind` turns
   * one sender's decision into a whole domain's without saying so. Both are refused here
   * rather than offered thinly.
   */
  | { kind: "rule_update"; ruleId: string; destination: Folder }
  /**
   * MAKE A RULE FROM PAST THE GATE — the verb that did not exist.
   *
   * The requirement: creating a rule must also apply it to the mail ALREADY in the mailbox,
   * not only to what arrives next, and that has to be the default — managing a mailbox means
   * dealing with what is in it.
   *
   * ── WHY A NEW VERB, RATHER THAN RELAXING SOMETHING ──────────────────────────────────────
   *
   * `screener_decide` was the only rule-creating verb in this vocabulary, and it makes a rule
   * only for a sender the Screener is still holding: `mutationEffects`' derived branch returns
   * NO effects unless the representative message is in `ohmail/Screener`, and `Engine.mutate`
   * turns zero effects into `rolled_back` **without sending the request**. So the Ohbox case —
   * a sender whose mail is already past the gate, which is the case that matters here — could
   * not be made to reach the server by loosening the server. The rest of the sender work shipped
   * without it and named this seam rather than faking it. `POST /rules` has been mounted the whole
   * time; this is the caller it never had.
   *
   * ── IT MOVES NO MAIL, AND THAT IS THE POINT OF THE OTHER HALF ───────────────────────────
   *
   * Same doctrine as `rule_delete` and `rule_update`: creating a rule writes the `rules`
   * row and one `rule` change, and the routing pass consults rules when mail ARRIVES,
   * never retroactively. The mail that is already filed is moved
   * by the `move` mutations the surface composes ALONGSIDE this one, from the same scope — never
   * by an effect here, which would paint a re-sort the server is not going to perform.
   *
   * ── `ruleKind`, NOT `kind` ──────────────────────────────────────────────────────────────
   *
   * `kind` is the discriminant of this union, so the rules row's own kind needs another name.
   * `header` is deliberately absent: a header rule matches on something that is not a principal,
   * and no surface can compose one from a message the user clicked.
   */
  | {
      kind: "rule_create";
      /** The rules row's `kind`. `domain` widens it to everyone after the `@`. */
      ruleKind: "sender" | "domain";
      /**
       * The address or the domain, ALREADY NORMALIZED by the caller (trimmed, lower-cased).
       *
       * Normalized once at the call site rather than here, so the optimistic row and the wire
       * body are literally the same string — the server stores `match` verbatim
       * (`RulesService.validMatch` does not fold case) and echoes it back, so a client that
       * lower-cased in one place and not the other would show a row that changes under the
       * cursor on the echo. Empty yields no effects: the server answers 400, and an empty
       * `domain` match would be compared against the empty domain of every malformed address.
       */
      match: string;
      destination: Folder;
      /**
       * A SECOND TERM ON THE RULE — *from this address AND with this in the subject*.
       *
       * Absent for the ordinary one-term rule every existing caller writes. Present only from the
       * subject sheet, which is reached by pressing a message's title and offers the repeating token
       * it detected in that sender's other subjects.
       *
       * `ruleKind: "sender"` ONLY — the server answers 400 for a term on a domain rule, and
       * `mutationEffects` yields no effects for that combination so the engine rejects it locally
       * with nothing on the wire. It is unreachable from the sheet (which is always about one
       * message's sender) and the refusal is here so it stays unreachable rather than becoming a
       * silently-broadened rule.
       *
       * Sent as typed, matched case-folded by the server. The case is preserved because both
       * surfaces quote the term back at the user, who read it off their own mail.
       */
      subjectContains?: string | null;
      /**
       * A THIRD TERM ON THE RULE — *from this address AND with this in the message text*.
       *
       * `subjectContains`' contract verbatim: absent for the ordinary rule, `ruleKind: "sender"`
       * only (the server answers 400 elsewhere and `mutationEffects` yields no effects locally),
       * sent as typed and matched case-folded by the server against the message's plain text. It
       * composes with the subject term — a mutation may carry both, and both must then hold.
       */
      bodyContains?: string | null;
      /**
       * ALSO APPLY THIS RULE TO MAIL THAT IS ALREADY FILED.
       *
       * `RulesService.create` stamps `rules.retro_requested_at` and returns; the worker's
       * `ruleRetroPass` then walks the account's stored mail in bounded, resumable pages and
       * writes `folder_state` desired-state, which the reconciler turns into real IMAP moves.
       * So this one boolean is the difference between a rule that changes the future and one
       * that also reorganizes the past.
       *
       * ── IT IS SENT EXPLICITLY, NEVER OMITTED, AND THAT IS DELIBERATE ────────────────────
       *
       * The SERVER defaults an absent field to `true`, because that is what was asked for and
       * the honest API contract. The SURFACE still sends the value on every call, so what ships
       * is decided by one constant in the webapp
       * (`sender-screening.ts#RETRO_DEFAULT_ON`) rather than by a field's absence. That is what
       * makes the default a decision in one visible place — see the constant, which names it.
       *
       * The paragraph above `mutationEffects`' `rule_create` case is now WRONG for this flag and
       * says so there: the effects are still rule-only, but the mail really does re-sort
       * afterwards, and it arrives through `/sync` rather than through an overlay.
       */
      applyRetro?: boolean;
    };

// ── errors ─────────────────────────────────────────────────────────────────

/** `410 cursor_expired` — discard local state and re-bootstrap with since=0 (§3.2). */
export class CursorExpiredError extends Error {
  constructor(message = "sync cursor expired; re-bootstrap with since=0") {
    super(message);
    this.name = "CursorExpiredError";
  }
}

/** A mutation the server (or adapter) refused. `retryable` gates the offline queue. */
export class MutationRejectedError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly retryable: boolean;
  constructor(message: string, opts: { status?: number | null; code?: string | null; retryable?: boolean } = {}) {
    super(message);
    this.name = "MutationRejectedError";
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
    this.retryable = opts.retryable ?? false;
  }
}

/** A mutation kind this adapter has no wire mapping for (e.g. tags pre-Stage-2). */
export class UnsupportedMutationError extends MutationRejectedError {
  constructor(kind: string) {
    super(`mutation kind "${kind}" is not supported by this adapter`, { retryable: false, code: "unsupported_mutation" });
    this.name = "UnsupportedMutationError";
  }
}

// ── base64url helpers (browser + node) ─────────────────────────────────────

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64encodeAscii(s: string): string {
  if (typeof btoa === "function") return btoa(s);
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i);
    const b = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
    const c = i + 2 < s.length ? s.charCodeAt(i + 2) : NaN;
    out += B64_CHARS[a >> 2]!;
    out += B64_CHARS[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)]!;
    out += Number.isNaN(b) ? "=" : B64_CHARS[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)]!;
    out += Number.isNaN(c) ? "=" : B64_CHARS[c & 63]!;
  }
  return out;
}

function b64decodeAscii(s: string): string {
  if (typeof atob === "function") return atob(s);
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const ch of s) {
    if (ch === "=") break;
    const v = B64_CHARS.indexOf(ch);
    if (v < 0) throw new Error("invalid base64");
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/** Encode a numeric seq as an opaque base64url cursor (server-shape parity). */
export function encodeSeqCursor(seq: number): Cursor {
  return b64encodeAscii(String(seq)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a base64url seq cursor; returns null when malformed ("0" ⇒ 0). */
export function decodeSeqCursor(cursor: Cursor): number | null {
  if (cursor === "0" || cursor === "") return 0;
  try {
    const raw = b64decodeAscii(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    if (!/^\d+$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}
