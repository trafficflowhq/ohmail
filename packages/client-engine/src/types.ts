/**
 * @ohmail/client-engine — wire vocabulary. These shapes MIRROR the ohmail
 * Cloud API contract without importing any backend package; clients tolerate
 * unknown fields and entity types (forward-compatible parsing), hence the
 * open unions. The `§` references cite the Cloud API contract document,
 * which is not public — the citations stay because they are load-bearing
 * where the file is authored; nothing here depends on reading it. This file
 * IS the public statement of the wire vocabulary, and the Desktop build
 * aliases the client that would speak it out of the bundle entirely.
 */

export type ISODateTime = string;
export type Cursor = string;

export interface EmailAddress {
  name: string | null;
  address: string;
}

/**
 * One file the compose form is sending — bytes, nothing kept. It rides the
 * `mail_send` mutation and the send request (`POST /drafts/:id/send`),
 * base64; no `attachments` row, no `drafts` column. The compose surface
 * states the total-size limit up front — the smaller of what the surface
 * can carry and what the sending mailbox's submission server announced.
 * A client permitted to stage (`HttpAdapterOptions.stageAttachments`) puts
 * oversized bytes in object storage on a signed URL (at rest at most 24 h)
 * and sends references; every other client puts them in the request.
 */
export interface ComposeAttachment {
  filename: string;
  contentType: string;
  /** base64-encoded bytes. */
  contentBase64: string;
}

/**
 * Real IMAP folders — identical to core `Destination` (contract §1.2).
 * These five strings are the most durable copy the product writes: created
 * inside the customer's own mailbox, rendered by every client, forever —
 * including after the customer leaves. Renamed to `ohmail/…` on 2026-07-31
 * while zero real mailboxes were connected; changing them again is an IMAP
 * data migration, not an edit. Never render a raw folder string: map
 * through `VIEW_OF_FOLDER`, and fall back to `folderLeaf()` for a folder
 * this client does not know (contract §8).
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
 * The EntityType values the server's `/sync` feed carries today (contract
 * §3.1). `"tag"` joined late, and the move is the point: it sat only in
 * {@link MirrorEntityType} among the demo types, so `TagView`, `TagPicker`
 * and `t` all worked against fixtures while a real account drained a feed
 * with no vocabulary for a tag and rendered an empty picker forever. Tag
 * ASSIGNMENTS are deliberately not a type here — they ride the `message`
 * entity (`MessageDTO.labels`), so a client can never hold an assignment
 * naming a tag it has not received.
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
 * One page of `GET /sync/snapshot` — the cold-start path replacing `since=0`, which replays the
 * whole change log; a snapshot is the current state, one `op:"create"` per live row, read at
 * one consistent point ({@link asOfSeq}). Three properties a consumer may rely on: every page
 * reads the SAME point (a delta drain resuming at `asOfSeq` misses nothing); page 1 is all live
 * state plus the newest page of messages, later pages messages only, newest-first; `nextCursor`
 * is opaque and `null` on the last page — never a `/sync` cursor. `window` is informational:
 * the client must not adopt it as its storage policy.
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
 * Every state that crosses the wire — {@link TriageState} plus
 * `resurfaced`. The extra member is kept OUT of `TriageState`, and that is
 * load-bearing: `TriageState` is this client's word for a bottom pile
 * (`TriageItemDTO.pile` is `Exclude<TriageState, "none" | "muted">`), and a
 * resurfaced message belongs to NO pile — it is pinned at the top of the
 * Ohbox — so widening `TriageState` would invite a fourth pile that must
 * never exist. Server-set by `bubbleUpPass`, and client-settable for
 * "resurface this now" (a past `bubbleUpAt` pins nothing on standalone).
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
   * This row is the engine's own optimistic Sent copy, not a synced
   * message: a confirmed `mail_send` materialises a provisional Sent-folder
   * message so a reply appears in its conversation instantly, before the
   * worker ingests the real one. Absent on every synced row, so `local ===
   * true` reads "on its way, not yet confirmed by the mailbox", and the
   * reconcile-by-`messageIdHeader` drops it when the real row lands. Not a
   * `folder` value: the copy sits under `folder: "Sent"`, and this flag is
   * the only thing distinguishing it until reconciliation.
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
   * When this message stopped being unread — the order "Earlier" sorts by.
   * `null` where not known, and OPTIONAL because the mirror can be older
   * than the field: a row written by an earlier build is `undefined`, and
   * both mean "no reading time recorded". Requiring it would be a claim
   * about stored data this type cannot make. `absent === null` is the rule,
   * enforced in one place ({@link ohboxView}'s comparator). Fixture rows
   * leave it absent: a demo mailbox has no reading history.
   */
  lastReadAt?: ISODateTime | null;
  hasAttachments: boolean;
  attachmentCount: number;
  sensitivity: SensitivityFlags;
  triage: MessageStateDTO | null;
  labels: string[];
  remoteContent: "blocked" | "loaded" | "none";
  updatedAt: ISODateTime;
  /**
   * TRUE ⇒ the away responder sent this, not the person — server-computed.
   * Optional for {@link lastReadAt}'s reason twice over: a mirror row or a
   * server older than the field is `undefined`, meaning "not known" — which
   * must resolve to "the person's mail", the behaviour every mirror had
   * before the field. So every consumer tests `!== true`, never `=== false`;
   * the other reading would empty the Sent half of "Earlier" on any older
   * mirror or server. Fixture rows leave it absent.
   */
  autoReplyByUs?: boolean;
  /**
   * When the away responder answered THIS message — an instant, or `null`.
   * The other half of {@link autoReplyByUs} and a different row: that flag
   * is on the reply (the Sent copy), this stamp on the original it answers.
   * Server-computed (the `away_replies` ledger is not mirrored) and read by
   * the message header as one quiet line. Optional for {@link lastReadAt}'s
   * reason: older mirrors and servers leave it `undefined`, which renders
   * nothing — same as `null`. No third state: a mark nobody can
   * substantiate is worse than no mark. Fixture rows leave it absent.
   */
  awayRepliedAt?: ISODateTime | null;
}

/**
 * Is this message's body withheld from the reader — now always NO. It used
 * to blank mail flagged sensitive; that is removed: the mail already sits
 * in full on the person's own server, so hiding the app's copy only hid it
 * from the one person entitled to read it, and the detector over-fired on
 * ordinary mail. Sensitivity is still a label (kept out of automatic AI),
 * but it no longer withholds the body. The predicate stays as a single
 * named seam — its callers gate body fetch, search indexing and the body
 * cache — a constant `false` on purpose.
 */
export function isProtectedMessage(
  _m: { sensitivity?: SensitivityFlags | null; protected?: unknown } | null | undefined,
): boolean {
  return false;
}

// ── message bodies ─────────────────────────────────────────────────────────

/**
 * What a message's `List-Unsubscribe`/`-Post` headers offer, as the API
 * reports it on the body fetch (§8). Mirrors core's
 * `UnsubscribeHeaderState` without importing it.
 *  · `one_click`     — RFC 8058; the server can POST it for the user.
 *  · `not_one_click` — an https unsubscribe page, opened in a browser.
 *  · `mailto_only`   — a `mailto:` route ohmail never sends on the user's behalf.
 *  · `no_header`     — no route; also the forward-compatible default when
 *                      an older server does not send the field.
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
 * `GET /messages/:id/body`, as much as this client reads. `html` used to be dropped here
 * (pre-sanitizer), so every surface rendered the `text/plain` alternative — a billing mail read
 * as its logo's filename; the message-body renderer (DOMPurify + a sandboxed frame fetching
 * nothing remote) answered both objections. `text` is not legacy: sensitive mail stores no
 * html, plain-text mail has none, and the sanitizer can refuse it — `text` is what all three
 * render, ALREADY redacted server-side; this client never re-derives or second-guesses a
 * redaction. `headers` stays deliberately unread (§8: an unread field is not an error).
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
 * Why a stored body holds no content, when that is policy — the server's closed set, verbatim (`MessageBodyDTO.withheld`):
 *  · `"storage_cap"` — the managed storage cap declined or evicted the copy.
 *  · `"junk_filed"`  — the spam verdict filed to the provider's Junk; the
 *                      durable artifact is the sender rule.
 *  · `"expunged"`    — every watched copy is gone; the row is tombstoned.
 * Every member hydrates as ITSELF into the mirror: narrowing unknown
 * members to `null` would persist "an ordinary, complete, empty body" —
 * answered, never re-asked — the permanent lie the tri-state ended.
 */
export type WithheldMarker = "storage_cap" | "junk_filed" | "expunged";

/**
 * One row of the batch body read — `GET /messages/bodies?ids=…`, the
 * thread-open call. Exactly a {@link MessageBodyWire} plus the id it
 * answers for: both routes serve the same stored row and there must be no
 * second shape for a body. The id is on the ROW, not positional: the server
 * answers only ids it owns — a cross-account or vanished id is silently
 * absent, never a null placeholder or an error, so the response cannot be
 * an existence oracle for another account's ids; callers match on this field.
 */
export interface MessageBodyBatchWire extends MessageBodyWire {
  messageId: string;
}

/**
 * The hydrated body as a client-local record — and why it is not on the message. `message_body`
 * is in {@link MirrorEntityType} and deliberately NOT in {@link SyncEntityType}: `/sync` has no
 * such type, so no delta can ever overwrite one. Writing the text onto the `message` row would
 * break invisibly: `applyToRecords` REPLACES the entity on update, and opening a message emits
 * `mark_seen`, whose echo carries a DTO with `snippet` and no body — the body would be wiped by
 * the read-receipt of reading it. `state` is stored, not derived: "asked and refused" must be
 * distinguishable from "never asked" — see {@link BodyState}.
 */
export interface MessageBodyRecord {
  messageId: string;
  state: "loading" | "ready" | "failed";
  /** The endpoint's already-redacted text. Empty while loading and after a failure. */
  text: string;
  /**
   * The server's word for why a `ready` record's text is empty: `"storage_cap"` means ingest
   * declined to store the body (the mail is untouched in the mailbox). Answered-terminal: never
   * `failed` (Retry cannot un-withhold), never re-asked. Tri-state like `html`: `"storage_cap"`
   * = withheld; `null` = answered by a withheld-aware build, ordinarily stored; `undefined` =
   * no aware build ever answered — a pre-slice tab could persist `{state:"ready", text:""}` for
   * a withheld body, a permanent lie nothing could heal. Both write sites normalize
   * (`fetchBodyInto`, `fetchBodiesInto`); the WIRE type stays two-state.
   */
  withheld?: WithheldMarker | null;
  /**
   * The endpoint's html part, or `null` — none, sensitive mail, or a record that is not
   * `ready`. Held off the message row so a `/sync` delta cannot erase it. Optional because of
   * IndexedDB, not mail: persisted records from before `html` was read lack the key and must
   * not be migrated (an invented `html: null` is indistinguishable from a message with none).
   * `undefined` is load-bearing: "no build ever answered", and `hydrateBody` re-asks exactly
   * once; `null` means "asked — no html" and must NOT re-ask. Never write `undefined` from new
   * code: `fetchBodyInto` normalises with `?? null`, which terminates the re-fetch.
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
   * When the fetch failed, epoch ms — what makes a failure survivable
   * across a reload. `hydrateBody` never re-asks a `failed` record on an
   * automatic trigger (an effect re-firing per mirror bump would poll a
   * refusing server), but the records are PERSISTED, so "never re-ask" was
   * silently for ever: one 500 stayed failed until Retry on that message.
   * Narrowed to the session that asked: a `failedAt` before this engine's
   * boot is re-asked exactly once on the next explicit intent. Absent means
 * stale (older builds wrote none) and heals; the engine remembers healed ids in memory this session.
   */
  failedAt?: number;
}

/**
 * What a surface knows about the text it is about to render — in the type,
 * because `body ?? snippet` shipped a one-line truncation as the message:
 *  · `full`     — the whole message; clamp, offer the pill, say nothing.
 *  · `snippet`  — a preview; the body was never asked for. Offer the pill.
 *  · `loading`  — asked, in flight. Say so.  · `failed`   — asked, refused. Say so, differently.
 *  · `withheld` — asked, ANSWERED: no stored body (storage cap). Terminal —
 *    no Retry, no spinner, the honest sentence; the mail itself is still in
 *    the mailbox on the user's own server.
 */
export type BodyState = "full" | "snippet" | "loading" | "failed" | "withheld";

/**
 * The body to render plus what it actually is — see {@link BodyState}.
 * `html` is a second rendition, never a replacement for `text`: a surface
 * picks html when it has a renderer and falls back to `text`; surfaces that
 * cannot render html (clamped previews, the Screener's consent preview,
 * notifications) keep reading `text` unaffected. `html` is non-null ONLY
 * when `state === "full"`: a snippet is not html, and neither `loading` nor
 * `failed` has a body to describe.
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
   * The rule's second term, or `null` — from this address AND with this in
   * the subject. A conjunction the server evaluates, never applied by a
   * surface here; it is on the mirror because two surfaces need to see it:
   * the rules list (two rules differing only by term would render as
   * identical duplicates with two Revoke buttons) and the sender sheet's
   * ladder (retargeting a narrow rule would silently widen it — the ladder
   * must skip it). Optional, the one such field on `RuleDTO`: older servers
   * and rows read as "no term"; `undefined` and `null` mean the same.
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
  /**
   * The draft's plain text, or `null` when THIS MIRROR DOES NOT HOLD IT.
   *
   * Two states, named rather than collapsed: a string — empty included — is the text of record,
   * and `null` is a row that arrived without one. `/sync` changes carry whole DTOs, so `null` is
   * reachable only from a bounded page that omits the field; the type is nullable so no reader
   * can seed an editor from a body nobody sent. {@link draftBodyKnown} is the one predicate.
   */
  body: string | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  /** Blind-carbon recipients. Delivered on the envelope only; never a header on the sent mail. */
  bcc: EmailAddress[];
  rationale: string | null;
  status: "draft" | "scheduled" | "sending" | "sent" | "unverified";
  /**
   * WHEN a `scheduled` draft will be sent (Send later, mail 0077) — the instant the user
   * picked, rendered in the reader's own local time. Optional because an older server sends no
   * key at all, and a mirror row predating the field reads as "no appointment".
   */
  sendAt?: ISODateTime | null;
  /**
   * The failure sentence from a scheduled send that could not be kept — server words, rendered
   * as a quotation (`SendState.reason`'s treatment). Cleared by the next edit or schedule.
   */
  sendError?: string | null;
  /** Client-local: the user took the AI draft into the editor. */
  accepted?: boolean;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ── client-local entities (fixtures / demo world) ──────────────────────────

/**
 * A tag — a real `/sync` entity backed by the `tags` table, the client
 * mirror of the server's `TagDTO`. A tag is OURS: a row in our database
 * keyed by message, never an IMAP folder — which is why the product can
 * create and destroy it, and why the UI tells the truth about its lifetime:
 * a disconnect keeps tags, erasing the account takes them, and a tag never
 * outlives its message (folders survive leaving; tags do not). `className`
 * is optional because the server does not send it — presentation, not
 * account data; `hueOf` derives rendering from `hue` for both worlds.
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
 * One of the mailbox's own folders — a `"folder"` entity off `/sync`
 * (FOLDERS-SPEC.md §4). `name` is the canonical `/`-joined path and the
 * natural key — the same spelling `MessageDTO.folder` carries, so a view
 * joins the two with `===`. The id names the entity on the wire and in a
 * URL, never in the organizer profile. `mailboxId`/`mailbox` extend the
 * spec deliberately: the rail sections folders by mailbox (§14) and a live
 * client has no other mirror source for the owning address. Emitted only
 * while "Use folders" is on — flag-off parity (§10).
 */
export interface FolderEntity {
  id: string;
  /** Canonical `/`-joined path, exactly as messages carry it. */
  name: string;
  mailboxId: string;
  /** The owning mailbox's address — the rail's section label when 2+ mailboxes exist. */
  mailbox: string;
  updatedAt?: ISODateTime;
  /**
   * The user's in-flight COMMAND on this folder (stage 2: create / rename / delete), absent
   * when settled. `name` stays the MAILBOX's truth throughout — a rename in flight keeps the
   * old spelling here and carries the commanded target in `op.to`, so every join on `name`
   * (the folder view, the unread counts, the tail verdict) stays consistent with the messages
   * while the rail renders the pending state honestly. `op.error` is a closed catalogue code
   * once the worker refused the command; it stands until the user dismisses it.
   */
  op?: { kind: "create" | "rename" | "delete"; to?: string; error?: string };
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
   * The advice on record for this sender, or `null` when none was ever
   * bought. `noAnswer` exists because the other two could not say it: a run
   * that could not answer left the row looking exactly like one nobody had
   * asked about, on a surface the person had just paid to fill in. Present
   * ⇒ `dest` is `screener` and the reason is the content. It was
   * `withheld`; under the AI-OPEN ruling of 2026-08-08 there is no such
   * mail on a path a person asked for, so the member and the name are gone
   * — every reason left is a fact about the RUN, answered by asking again.
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
   * TRUE when `screenerSegments()` computed this row from the message
   * mirror rather than a `screener_sender` entity — every row on a Cloud
   * account, none in the demo. Not cosmetic: `id` is then the
   * representative MESSAGE id (what `POST /screener/:id` resolves), and the
   * affordances differ — the server has no un-screen and no delete
   * endpoint, so releasing a derived sender is per-message `move` and
   * Delete is not offered. The UI must not guess which kind of row it has.
   */
  derived?: true;
  /**
   * Whether the representative is physically at the gate (`ohmail/Screener`) — waiting rows
   * only. The segments run over the PROJECTED reader, where an active-undecided sender's INBOX
   * mail is presented in the Screener without leaving the INBOX; such a rep is physically in
   * the INBOX, so `POST /screener/:id` would 404 and the local guard refuses. `false` marks
   * exactly that case, so the commit path routes past the gate (`rule_create`); `true` when
   * genuinely held; absent on a fixture row. Observable record, not authority:
   * `screener-state.ts#commit` re-reads the raw mirror at commit time.
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
 * seen-up-to-here marker, one row per {@link FeedView}. `newestSeenId` is
 * the newest message on screen when the reader last left, and the line
 * renders directly ABOVE it: that message was seen, so it may not present
 * as "new since last visit". Deliberately EXCLUSIVE — the inclusive reading
 * could never say "everything here is old news". `at` is the leave time,
 * formatted in the reader's locale; `label`/`meta` are demo-fixture copy
 * only — a live commit writes no display strings into the mirror.
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
       * Which of the five the user pressed — and it is now on the wire:
       * `POST /screener/:id` carries it, files the held mail there and
       * promotes the rule at the same folder. It used to be a local-only
       * hint the adapter dropped, which made three of the five buttons
       * decoration — the follow-up `move`s lost a race against the decide's
       * own write. `ScreenDest`, not {@link OhmailView}: `screener` is where
       * mail is HELD, never a destination, and the server refuses it.
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
       * Tag-or-create — no longer the only way to mint a tag (see
       * `tag_create`), but a different act: tagging a message with a new
       * name is one gesture and one request; splitting it would leave a
       * window where the tag exists on nothing. `tagId` is a client-minted
       * uuid the server adopts as the row id, so the optimistic paint names
       * the tag the database holds. If the name already exists, the
       * existing tag wins and the client's id is never seen;
       * `tagsOfMessage` filters unknown ids, so the chip lands one drain later.
       */
      createName?: string;
    }
  /**
   * The three tag verbs that had no caller: `POST /tags`, `PATCH /tags/:id` and `DELETE
   * /tags/:id` were mounted and contract-tested with zero client callers — Rename and Delete
   * raised a "not wired up" toast. Engine mutations rather than a Cloud-only seam
   * (`SettingsView`'s argument): `tag` is a real `/sync` entity, so demo, desktop and live are
   * all correct with no special case. Here `tagId` is a CLIENT-LOCAL name, not the row id:
   * `POST /tags` mints the id server-side, the optimistic row is deleted on confirm (the
   * `rule_create` shape), and a name collision answers 409 and rolls back — the surface checks
   * first.
   */
  | { kind: "tag_create"; tagId: string; name: string; hue?: string }
  /**
   * RENAME — NAME ONLY. The colour travels on its own verb ({@link tag_recolor}); a rename that
   * also carried a hue would make one "Save" mean two things and send a field the user did not
   * touch. `PATCH /tags/:id` accepts `name` alone, which is what this sends.
   */
  | { kind: "tag_rename"; tagId: string; name: string }
  /**
   * Recolour — hue only. `TagsService.HUES` and the UI's `TagHueName` were
   * two different lists overlapping only on `moss`, so any colour a picker
   * offered was one the other half could not honour (an invisible dot or a
   * 400). Reconciled to the hues the Blanc system paints — ten now; the
   * widening added token families and `chip.css` rules in the same change
   * as the server's list, no migration (`tags.hue` is plain text).
   * `PATCH /tags/:id` takes `{ hue }` on its own.
   */
  | { kind: "tag_recolor"; tagId: string; hue: string }
  /**
   * Deleting a tag takes it off every message, and the effect says so:
   * `TagsService.remove` deletes the `message_tags` rows in the same
   * transaction and appends one `message` change per affected message, so
   * the server's own answer clears the chips; `mutations.ts` mirrors that
   * rather than only tombstoning the tag row. The messages themselves are
   * untouched — a tag is a row keyed by message, never an IMAP folder, so
   * deleting one moves no mail; the surface says that before it asks.
   */
  | { kind: "tag_delete"; tagId: string }
  /**
   * The folder verbs (FOLDERS-SPEC.md stage 2) — real IMAP operations in the user's OWN
   * mailbox, executed by the worker under the organizer lease after the API records the command
   * (`folder_ops`). The optimism model is PENDING MARKERS, never pretended completion: the
   * effect paints the entity's `op` marker, the adapter's echo replaces it with the server's
   * pending row, and the settled entity arrives when the worker confirms. CREATE: `folderId` is
   * a client-local name (`tag_create`'s rule); `name` is the full canonical path; the surface
   * validates with `folderNameError` first, so the server's 400 is the race.
   */
  | { kind: "folder_create"; folderId: string; mailboxId: string; name: string }
  /**
   * RENAME — the new FULL canonical path (rename and move are one wire act: a move is a rename
   * under a new parent; stage 2's UI ships rename-in-place and the vocabulary already carries
   * both). The subtree, the contained messages' folder addresses, the folder-scoped state and
   * the cursors all follow when the worker lands the swap — in ONE transaction beside the IMAP
   * RENAME. Until then the entity wears `op: { kind: "rename", to }` and keeps its old name.
   */
  | { kind: "folder_rename"; folderId: string; name: string }
  /**
   * DELETE — the ratified ceremony: the folder's messages (the whole subtree, children first)
   * move to the provider's native \Trash — the message-delete verb's own semantics, NEVER an
   * expunge — and each emptied folder is then removed. The surface asks BEFORE the act with the
   * server-truth numbers (`GET /folders/:id/summary` — "N messages across M folders move to
   * Trash"), the same confirm-before-act ceremony the message Delete ships, and for the same
   * reason: there is no un-delete on the wire. The entity wears `op: { kind: "delete" }` until
   * the tombstones arrive.
   */
  | { kind: "folder_delete"; folderId: string }
  /**
   * DISMISS a FAILED folder command — the refusal was read. A failed CREATE takes its
   * never-created row with it (nothing on the server answers to it); a failed rename/delete
   * leaves the folder exactly as the mailbox has it. Pending commands cannot be dismissed —
   * the worker may be mid-execution, and a cancel racing an IMAP write would leave the marker
   * lying in whichever direction lost.
   */
  | { kind: "folder_op_dismiss"; folderId: string }
  /**
   * A reading stream's seen-state — the \Seen sweep and the waterline, one verb for both piles.
   * `view` names the stream (absent ⇒ `reads`); the effect filters flips to
   * `FOLDER_OF_VIEW[view]` by construction and writes that view's own `view_meta` row, so
   * Reads' line cannot move because Receipts was left. Two separable acts: `messageIds` is the
   * \Seen sweep (absent ⇒ every unread id in the view's folder); `upToId` is the waterline
   * commit — ABSENT MEANS THE LINE DOES NOT MOVE, so it moves exactly once, on leave (a default
   * once let every dwell-mark drag it mid-visit). The waterline is client state: `/sync` has no
   * `view_meta` type; only the PATCHes cross the wire.
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
   * Folder-agnostic read-state — the one thing `feed_mark_seen` is not.
   * That is a stream's verb: its effect drops ids outside its view's
   * folder while its wire side would PATCH anything, so reusing it for the
   * Ohbox would leave rows bold until the next drain and then silently
   * change them. This one flips exactly the ids it is given, wherever they
   * live, wire and overlay alike, and never touches a waterline. `unread`,
   * not a `seen` verb: it is the field the mutation sets, so `u` and "mark
   * selection read" are one mutation with two values.
   */
  | {
      kind: "mark_seen";
      messageIds: string[];
      unread: boolean;
      /**
       * Was this read an act, or just a look? Indistinguishable by the time they reach here,
       * and one thing turns on it: the server spends a resurfaced row's pin on a DELIBERATE
       * read. `"glance"` is claimed by surfaces that decide FOR the reader (the Ohbox dwell,
       * the Receipts per-card mark); everything else omits it. A glance-labelled read still
       * lands (owner ruling 2026-08-26) — the server marks read WITHOUT spending the pin.
       * Absent means deliberate, the safe default: a call site that forgets this spends the pin
       * a little too eagerly, never leaves one that can never be answered.
       */
      via?: "glance";
    }
  /**
   * Send mail — the one mutation whose effect leaves the building. One verb, two entry points
   * (`inReplyTo` is the only difference); threading headers are minted server-side, so
   * `inReplyTo: null` keeps a stranger's Message-ID out of a fresh conversation. The
   * mutate-time effect is one `sending` draft, never a Sent row — nothing optimistic may assert
   * delivery; the Sent copy is a confirm-time overlay reconciled away by `messageIdHeader` (~10
   * min TTL backstop). `send_unverified`, `send_failed` and retryable `in_flight` stay
   * distinguishable. `cc` and `bcc` are both delivered; bcc rides the envelope only
   * (`imap.ts#send`).
   */
  | {
      kind: "mail_send";
      /**
       * The message being answered, or `null` for a fresh compose — see above. A reply's
       * recipient, subject, mailbox and thread are all derived from it.
       */
      inReplyTo: string | null;
      /**
       * The message being forwarded — the exclusive peer of {@link inReplyTo}: a forward
       * carries no `In-Reply-To`, threads onto nothing, and goes to recipients the user picks;
       * exactly one of the two is ever non-null. The client sends only the id. The server owns
       * the rest: it refuses `no_forward` (a sensitive body must never leave through a quote
       * block), appends the quoted original, and streams the attachments from IMAP — a
       * client-built quote is exactly the seam a redacted body would escape through. The
       * compose surface offers forward only for non-`no_forward` mail; this is the second
       * check.
       */
      forwardOf?: string | null;
      /**
       * The draft row this message already is, when there is one. A compose
       * autosaves through `draft_save`, so naming the row makes the send
       * USE it: the adapter skips `POST /drafts` and goes straight to
       * `POST /drafts/:id/send` — one row from first keystroke to delivery,
       * no abandoned twin per send. Absent for a reply and for surfaces
       * that do not autosave (the pre-autosave path, unchanged). The final
       * field values still travel on the mutation and are PUT before
       * sending: the debounce means the last two seconds of typing may not have reached the row.
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
      /**
       * Send later (mail 0077): the instant this message should leave, ISO
       * 8601 with timezone. Present ⇒ the adapter puts an appointment on
       * the draft (`POST /drafts/:id/schedule`) instead of sending — the
       * server's scheduled-send pass runs the ordinary gated send when the
       * time comes, and the draft rides `/sync` as `status: "scheduled"` so
       * every device can see and cancel it. Exclusive of
       * {@link attachments} and {@link forwardOf}: a draft row stores no
       * bytes and no forward reference, so the adapter refuses the combination.
       */
      sendAt?: string;
    }
  | { kind: "draft_accept"; draftId: string }
  /**
   * TAKE A SEND-LATER APPOINTMENT OFF A DRAFT — `DELETE /drafts/:id/schedule`. The row returns
   * to an ordinary draft on every device; the server answers 409 "already being sent" when the
   * scheduled-send pass claimed it first, which the surface reports rather than pretending the
   * cancel landed (the overlay rolls back, so the row keeps saying "scheduled" or converges to
   * "sent" on the next drain — never a false "cancelled").
   */
  | { kind: "draft_schedule_cancel"; draftId: string }
  /**
   * Autosave: the compose form becomes a row, and stays the same row. A draft used to live in
   * `localStorage` — gone with site data, invisible to the account, stranded on one device.
   * `draftId: null` CREATES (`POST /drafts`) and the server's id comes back on {@link
   * MutationResult.entityId}; a non-null id UPDATES that row. An engine mutation, not an
   * `app/api-client` call (`rule_delete`'s argument): the shared-shell views ship in the
   * desktop mirror, which has no api-client — and the engine buys the overlay and `/sync`. It
   * carries no `status`: only `POST /drafts/:id/send` may move a draft — a client that could
   * set the column would be a second path to "sent".
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
   * Answer for a send this server could not confirm — `POST /drafts/:id/resolve`, the one
   * sanctioned exit from the held state. An `unverified` draft said "check your Sent folder"
   * with nowhere to put the answer, so the row was parked permanently. `arrived` records the
   * delivery (the row becomes `sent`); `not_arrived` returns an ordinary draft that can be
   * edited, discarded or re-sent under a fresh key. Idempotent on the server: a
   * compare-and-swap on `unverified`, so a repeat answers 200 and the other outcome arriving
   * second cannot reopen a resolution. No durable key needed.
   */
  | { kind: "draft_resolve"; draftId: string; outcome: "arrived" | "not_arrived" }
  /**
   * Revoke a rule, and change where one files — the undo for the consent gate. Engine
   * mutations, not `app/api-client` calls: the surface ships in the public desktop mirror,
   * which contains no api-client (the publish script denies it); the engine is the only wire a
   * shared-shell view has. The precedent: `tag_assign` threw UnsupportedMutationError under a
   * finished UI for all of Stage 2 — mounted, tested, reachable from nothing. A revoke does not
   * move mail: `RulesService.remove` deletes the row and never touches `folder_state`; rules
   * are consulted when mail ARRIVES, never retroactively — the surface says so before the user
   * commits (see `RulesView`).
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
   * Make a rule from past the gate — the verb that did not exist. Creating a rule must also
   * apply to mail already in the mailbox, by default. A new verb because `screener_decide` only
   * writes a rule for a sender the Screener still holds (zero effects ⇒ `rolled_back`, nothing
   * sent), so the Ohbox case could not reach the server; `POST /rules` was mounted the whole
   * time — this is the caller it never had. It moves no mail: the routing pass consults rules on
   * arrival, and the already-filed mail is moved by the `move` mutations the surface composes
   * alongside. `ruleKind`, not `kind` (the union's discriminant); `header` is absent — no
   * surface can compose one from a clicked message.
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
       * A second term on the rule — from this address AND with this in the subject. Absent for
       * the ordinary one-term rule; present only from the subject sheet, which offers the
       * repeating token it detected. `ruleKind: "sender"` only — the server answers 400 for a
       * term on a domain rule, and `mutationEffects` yields no effects for that combination so
       * the engine rejects it locally; the refusal is here so it stays unreachable rather than
       * silently broadening. Sent as typed, matched case-folded — both surfaces quote the term
       * back at the user, who read it off their own mail.
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
       * Also apply this rule to mail that is already filed. `RulesService.create` stamps
       * `rules.retro_requested_at`; the worker's `ruleRetroPass` walks stored mail in bounded,
       * resumable pages and writes `folder_state`, which the reconciler turns into real IMAP
       * moves — this boolean is the difference between changing the future and also
       * reorganizing the past. Sent explicitly, never omitted: the server defaults absence to
       * `true`, but the surface always sends the value, so what ships is decided by one visible
       * constant (`sender-screening.ts#RETRO_DEFAULT_ON`).
       */
      applyRetro?: boolean;
    };

/**
 * The mutation vocabulary as a runtime value — the census pin for the verb-parity harness.
 * {@link EngineMutation} is a type, so nothing at runtime can enumerate it, and the harness
 * that drives every user verb through the real API (`test/verb-parity/`, INSTANT-ARCH §6.2(e))
 * needs a runtime list or it covers whatever somebody remembered. Pinned both ways in a file
 * `tsc -b` checks: `satisfies` refuses a non-mutation entry, and {@link
 * MutationKindsAreComplete} goes red when the union grows without this list. Adding a verb
 * without extending the list fails typecheck; extending it without classifying the verb fails
 * the parity census.
 */
export const MUTATION_KINDS = [
  "move",
  "message_delete",
  "triage_set",
  "screener_decide",
  "tag_assign",
  "tag_create",
  "tag_rename",
  "tag_recolor",
  "tag_delete",
  "folder_create",
  "folder_rename",
  "folder_delete",
  "folder_op_dismiss",
  "feed_mark_seen",
  "mark_seen",
  "mail_send",
  "draft_accept",
  "draft_schedule_cancel",
  "draft_save",
  "draft_discard",
  "draft_resolve",
  "rule_delete",
  "rule_update",
  "rule_create",
] as const satisfies readonly EngineMutation["kind"][];

/** One user verb's discriminant — the unit the verb-parity census counts in. */
export type MutationKind = (typeof MUTATION_KINDS)[number];

/**
 * The union → array half of the pin: `never` while every {@link EngineMutation} kind appears in
 * {@link MUTATION_KINDS}; the MISSING KIND ITSELF the moment one does not, so the compile error
 * on the line below names the verb that was added without being listed.
 */
type MutationKindMissingFromCensus = Exclude<EngineMutation["kind"], MutationKind>;
type MutationKindsAreComplete = [MutationKindMissingFromCensus] extends [never] ? true
  : { "EngineMutation kind missing from MUTATION_KINDS": MutationKindMissingFromCensus };
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mutationKindsAreComplete: MutationKindsAreComplete = true;
void mutationKindsAreComplete;

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
  /**
   * How long the server asked us to wait, in ms, from its `Retry-After` —
   * `null` when it said nothing. Load-bearing for the outbox's give-up
   * ceiling: a refusal that names its interval is a server declining work
   * it knows it cannot do yet (`503 db_busy`), which must not consume the
   * queue's patience — a twenty-minute pool outage would abandon every
   * legitimate verb — while an unmodelled failure must, or a poisoned verb
   * hammers forever (`OUTBOX_MAX_SERVER_FAILURES`). `null` and `0` differ:
   * `0` is the server saying "immediately", which is still the server speaking.
   */
  readonly retryAfterMs: number | null;
  /**
   * The server row this refusal is about, when the refusal knows one — `null` otherwise.
   * `MutationResult.entityId` rides the confirmed result only; the exception that matters is a
   * send pressed before the first autosave: the adapter creates a row, the answer comes back
   * `unverified`, and without this the client is never told which row was marked — it sits in
   * Drafts looking ordinary and one press delivers the message twice. The row is NAMED, not
   * adopted (nothing may PUT to it), so the durable record can park the message it belongs to.
   * Same for a `queued` answer: a reload that cannot name the row mints a second one.
   */
  readonly entityId: string | null;
  /**
   * The refusal's own structured facts, from the server's `{error:{details}}`. `message` is
   * server English — rendering it puts an untranslated protocol sentence inside a translated
   * interface (shipped once already), so surfaces branch on `code`. But a code cannot carry a
   * FACT, and some refusals turn on one: a duplicate send is refused differently depending on
   * whether the first attempt is known-sent, unconfirmed or still running. The details ride
   * along, opaque to this class, read by the surface that knows the shape. Distinct from
   * `retryAfterMs`: that is modelled and branched on; this is carried.
   */
  readonly details: unknown;
  constructor(
    message: string,
    opts: {
      status?: number | null; code?: string | null; retryable?: boolean; retryAfterMs?: number | null;
      entityId?: string | null;
      details?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "MutationRejectedError";
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.entityId = opts.entityId ?? null;
    this.details = opts.details;
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


/**
 * The two client-local types that survive a re-bootstrap. Declared here because the STORE
 * carries them through a wipe (`BaseMirrorStore.resetForBootstrap`) and the ENGINE writes and
 * replays them — "these two, and only these two, ride through a 410" has to be one declaration.
 * The carve-out is narrow: every seq-0 row is client-local, but most are re-derivable (a
 * `message_body` is re-fetched, a waterline costs one re-mark); these two derive from nothing —
 * a queued verb IS the user's intent, and an abandoned one is the intent nothing else will
 * deliver. A 410 is a statement about the CURSOR.
 */
export const OUTBOX_TYPE = "outbox_entry";
export const OUTBOX_ABANDONED_TYPE = "outbox_abandoned";

/** The rows {@link OUTBOX_TYPE} and {@link OUTBOX_ABANDONED_TYPE} name, as a membership test. */
export function isCarriedLocalType(type: string): boolean {
  return type === OUTBOX_TYPE || type === OUTBOX_ABANDONED_TYPE;
}
