import type { Destination, EmailAddress, UnsubscribeHeaderState, WorkflowStep, WorkflowTrigger, WorkflowPattern } from "@trafficflow/core/mail";
import type { EntityType, ChangeOp } from "@trafficflow/db";

export type { EntityType, ChangeOp };

// `Folder` ≡ core `Destination`.
export type Folder = Destination;
export type ISODateTime = string;

export interface SensitivityFlags {
  sensitive: boolean;
  category: "otp" | "verification" | "password_reset" | "security_alert" | null;
  no_ai: boolean;
  no_forward: boolean;
  no_kb: boolean;
  priority: boolean;
}

// ── Cursor-paginated list envelope. Independent from /sync cursors. ──
export type Cursor = string;
export interface Page<T> {
  items: T[];
  nextCursor: Cursor | null;   // null ⇒ last page
}

export type TriageState = "none" | "reply_later" | "set_aside" | "bubbled_up" | "muted";

export interface MessageStateDTO {
  messageId: string;
  state: TriageState;
  bubbleUpAt: ISODateTime | null;
  setAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface ScreenerItem {
  id: string;                     // the screener entry id (the representative message id when derived)
  messageId: string;
  threadId: string | null;
  sender: EmailAddress;
  subject: string;
  snippet: string;
  receivedAt: ISODateTime;
  aiSuggestion: {                 // AI pre-suggestion (reuses the injected classifier)
    // `hold` ⇒ the model declined to place this sender, so the decision belongs to the person
    // reading the Screener. A surface may show it; a BULK control may never act on it. See
    // `screener-service.ts`'s SCREEN_DISPOSITION for why this is three-valued and not two.
    //
    // THIS FIELD IS THE BULK-ACTIONABLE VERDICT AND NOTHING ELSE. It is deliberately still
    // three-valued after `destination` was added beside it: every bulk control reads `decision`,
    // so widening it would have widened what "Apply all" may do in one step.
    decision: "yes" | "no" | "hold";
    /**
     * WHICH PILE the model actually named — the answer `decision` collapses.
     *
     * Added because the collapse was lossy in a way the user could see: on a live account 63
     * `ohmail/Receipts`, 43 `ohmail/Reads` and 5 `ohmail/Quarantine` answers all rendered as the
     * single word "Screened out", so the Screener appeared never to suggest Receipts, never Reads
     * and never spam. It suggested all three; `decision` had no room to say so.
     *
     * A surface shows this; nothing acts on it. `decision` remains the only field a control may
     * consult, so a client that ignores this field behaves exactly as it did before.
     */
    destination: Destination;
    /** The model's own hard "no". Separated from `ohmail/Screened` so junk can be named as junk. */
    spam: boolean;
    confidence: number;           // 0..1
    rationale: string;
  } | null;                       // null while unclassified / when AI is unavailable
  updatedAt: ISODateTime;
}

export interface MessageDTO {
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
   * WHEN THIS MESSAGE STOPPED BEING UNREAD, or `null` if that is not known.
   *
   * The order the client's "Earlier" group is sorted by — reading history, ordered by reading,
   * rather than by the order the senders happened to send. `null` covers two rows that cannot be
   * told apart and do not need to be: never read, and read before the field existed. Both sort
   * below every stamped row.
   *
   * Projected on EVERY message the API emits — list, single, delta and snapshot alike — because
   * there is one projection and the sort has to work on a mirror built from any of them. A client
   * that predates the field ignores it; a client newer than the server reads `undefined` and
   * treats it exactly like `null`, so neither side has to deploy first.
   */
  lastReadAt: ISODateTime | null;
  hasAttachments: boolean;
  attachmentCount: number;
  sensitivity: SensitivityFlags;
  triage: MessageStateDTO | null;
  /**
   * The ids of the tags on this message. OURS — a row in `message_tags`, never an IMAP
   * folder or an IMAP keyword. Hardcoded `[]` in an early build until the tags backend landed.
   */
  labels: string[];
  remoteContent: "blocked" | "loaded" | "none";
  updatedAt: ISODateTime;
}

/**
 * A tag — the account's own label, keyed by message through `message_tags`.
 *
 * It is NEVER an IMAP folder: ohmail organizes in place with a fixed folder set and a tag is a
 * cross-cutting dimension over it, not a seventh pile. The consequence the UI states plainly is
 * that a tag lives only in our database — a disconnect keeps it (that is a reversible soft
 * delete), but erasing the account takes it, and it never outlives its message.
 *
 * No `className`: the client derives presentation from `hue`.
 */
export interface TagDTO {
  id: string;
  name: string;
  hue: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ── Message body. The 1:1 `message_bodies` row.
// `text` is the sensitivity-REDACTED body when the message is sensitive (never an
// OTP/secret) — the API returns it as-is and NEVER re-derives a secret. ──
export interface MessageBodyDTO {
  messageId: string;
  text: string;
  html: string | null;
  headers: Record<string, unknown>;
  loadedRemoteContent: boolean;
  /**
   * What this sender's `List-Unsubscribe`/`-Post` headers offer, DERIVED server-side from the
   * raw `headers` above (which never reach the client mirror). It rides the body fetch a surface
   * already makes, so a Screener preview can say "this sender offers a way out" and, for
   * `one_click`, act on it via `POST /messages/:id/unsubscribe`. See
   * `@trafficflow/core/mail#unsubscribeHeaderState`.
   */
  unsubscribe: UnsubscribeHeaderState;
  /**
   * The sender's OWN `https:` unsubscribe page, present ONLY for `unsubscribe === "not_one_click"`
   * — a link the reader opens in their own browser when one-click is not on offer. `null`
   * otherwise: a `one_click` message is acted on by the server route (its POST token never
   * reaches the client), and `no_header`/`mailto_only` have no https link to offer.
   */
  unsubscribeUrl: string | null;
}

/**
 * One row of the batch text pull (`GET /messages/bodies`) — the foundation of the macOS
 * Cloud-local text mirror.
 *
 * A TRIMMED {@link MessageBodyDTO}: the stored `text` (already sensitivity-redacted at write
 * time) and `html` (`null` for positively-sensitive mail, dropped by the pipeline at write
 * time), both VERBATIM — this surface never re-derives a secret. There is deliberately **no
 * `headers`** field and no attachment bytes: the batch text pull carries the body and nothing
 * else, and that absence is the no-rehydrate guarantee.
 */
export interface MessageBodyBatchItem {
  messageId: string;
  text: string;
  html: string | null;
  loadedRemoteContent: boolean;
  /**
   * The sender's unsubscribe posture — `?ids=` MODE ONLY, and absent in the keyset mode.
   *
   * The two modes of `GET /messages/bodies` serve two different consumers and the difference is
   * the point. The keyset page feeds the macOS local text mirror and joins the body row and
   * NOTHING else; that absence is its no-rehydrate guarantee, and it is pinned structurally by a
   * test that asserts the item's exact key set. The `?ids=` page feeds a READER opening a thread
   * — the same surface {@link MessageBodyDTO} feeds — so its rows carry the same derived posture
   * the single-message route carries, or a conversation's siblings would silently offer no way
   * out where the message above them does.
   *
   * Optional rather than a second interface because it is one row shape with one field the
   * mirror mode does not populate; two types would mean two places for the redaction contract
   * above to be restated. Raw headers cross the wire in NEITHER mode.
   */
  unsubscribe?: UnsubscribeHeaderState;
  /** The sender's own https unsubscribe page, `?ids=` mode and `not_one_click` only; else null. */
  unsubscribeUrl?: string | null;
}

export interface ThreadDTO {
  id: string;
  accountId: string;
  subject: string;
  messageIds: string[];
  participants: EmailAddress[];
  lastMessageAt: ISODateTime;
  unreadCount: number;
  muted: boolean;
  folder: Folder;
  updatedAt: ISODateTime;
}

export interface RoutingDecisionDTO {
  id: string;
  accountId: string;
  messageId: string;
  inputProvenance: "rule" | "header" | "screener" | "ai";
  matchedRuleId: string | null;
  destination: Folder;
  confidence: number | null;
  rationale: string | null;
  spam: boolean;
  status: "auto_applied" | "pending_approval" | "approved" | "rejected";
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface ApprovalDTO {
  id: string;
  kind: "routing" | "draft_send" | "workflow_action";
  messageId: string | null;
  proposed: { action: string; summary: string; payload: unknown };
  routingDecisionId: string | null;
  confidence: number | null;
  expiresAt: ISODateTime;
  status: "pending" | "approved" | "rejected" | "expired";
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ── Mailboxes ──
// Identity + lifecycle (real `status`/`displayName`/`lastSyncAt`/`authKind`
// columns) + a per-folder sync summary. Credentials live in the separate,
// envelope-encrypted `mailbox_credentials` table and are NEVER surfaced here.
export interface MailboxFolderSummary {
  folder: string;
  /** highestmodseq present ⇒ the folder has been scanned at least once. */
  hasSyncCursor: boolean;
  updatedAt: ISODateTime;
}

/**
 * WHY a mailbox is in `error` (mail 0023). A stable key, not a sentence: the client owns the
 * wording, so the copy stays localizable and the server never ships English down the wire.
 *
 * `unknown` is a real member and not a fallback for a missing case — the worker emits it when
 * it genuinely cannot name the failure, and the UI must say so rather than guess.
 */
/**
 * Defined ONCE in `@trafficflow/db`, beside the `mailboxes.error_code` column it constrains.
 * This union used to be written out here AND in the worker's mailbox module AND in a
 * comment on the column, with nothing keeping the three in step — so the DTO could promise a
 * code the worker never emits, or miss one it does and render a blank reason beside a red
 * mailbox. Re-exported, because `MailboxErrorCode` is part of this module's public DTO surface.
 */
import type {
  MailboxDisabledReason, MailboxErrorCode, MailboxSyncBlockReason,
} from "@trafficflow/db";
export type { MailboxDisabledReason, MailboxErrorCode, MailboxSyncBlockReason };

export interface MailboxDTO {
  id: string;
  provider: string;              // 'imap' today; 'exchange' planned
  address: string;
  displayName: string | null;
  status: "connected" | "error" | "disabled";
  authKind: "password" | "oauth";
  lastSyncAt: ISODateTime | null;
  // ── WHY it failed (mail 0023). All four are null/0 whenever `status !== 'error'`: the
  //    worker clears them in the same statement that writes `connected`, so a client can never
  //    render "connected" beside a stale reason.
  //
  //    `errorDetail` is an ALLOWLISTED token — an IMAP response code, a Node errno, a TLS
  //    constant, an SQLSTATE — and never an error message. That rule is enforced at the write
  //    (`markMailboxFailed`, in the worker) rather than here, because this DTO
  //    is not the only reader: the admin console projects the same column, and a raw message
  //    can carry RFC822 header bytes, which staff may never see.
  errorCode: MailboxErrorCode | null;
  errorDetail: string | null;
  failedAt: ISODateTime | null;
  /** Attempts within the CURRENT outage. Not the worker's backoff counter — see the column. */
  retryCount: number;
  // ── WHY A `connected` MAILBOX IS NOT BEING SYNCED (mail 0029) ──
  //
  //    PROJECTED UNCONDITIONALLY, and the asymmetry with the four fields above IS THE POINT.
  //    Do not "fix" it into consistency: gating these on `status === 'error'` would restore the
  //    exact invisibility this slice exists to end, because in every scenario they describe the
  //    status is `connected`. That is not an oversight of the worker's — it is the design. An
  //    infrastructure fault (an unreadable organizer lease, credentials not yet provisioned, this
  //    deployment's mailbox cap) must never be rendered as "your mailbox is broken", must never
  //    earn a retry backoff, and must never quarantine anything. So the row keeps saying
  //    `connected` and says WHY IT IS NOT SYNCING in these two fields instead.
  //
  //    `syncBlockedReason` is a closed set of three (`MAILBOX_SYNC_BLOCK_REASONS`,
  //    `@trafficflow/db`) with a CHECK constraint behind it, so — unlike `errorCode` — no value a
  //    mail server chose can ever reach it. A stable key, not a sentence: the client owns the
  //    wording.
  //
  //    NULL/NULL is the normal case and means "nothing is blocking this mailbox". They are cleared
  //    in the same statement by every writer that makes that true.
  //
  //    ── AND `null` HERE DOES NOT MEAN "NOT BLOCKED" ──
  //    `mailbox-service.ts:526` narrows this field to the closed set on read and forwards
  //    `syncBlockedSince` on the next line UNCONDITIONALLY. A server that grows a fourth member
  //    therefore emits `{syncBlockedReason: null, syncBlockedSince: <ts>}` to a client whose build
  //    predates the widening — "blocked, reason unrecognised", which is a state the client must
  //    render, not a healthy mailbox. **This field is COPY; `syncBlockedSince` is the predicate,**
  //    and `apps/webapp/app/shell/mail-state.ts` gates on it. Widening this type to `string` to
  //    forward the raw token was considered and REJECTED: it destroys the only type-level statement
  //    this wire makes, and a timestamp cannot carry a server-chosen value at all.
  syncBlockedReason: MailboxSyncBlockReason | null;
  /**
   * When the CURRENT block began — `coalesce`d on write, so it does not restart every pass — **and
   * the authoritative "this mailbox is not being synced" signal on this wire.**
   *
   * `non-null reason ⇒ non-null since` is held by the five writers in one statement each, NOT by a
   * constraint: `0029_mailbox_sync_block.sql:113` constrains membership only. Narrowing this field
   * for symmetry with the one above reinstates the original blocked-but-invisible bug.
   */
  syncBlockedSince: ISODateTime | null;
  /**
   * WHY a `disabled` mailbox is disabled, when the reason is the organizer lease and not a
   * person (mail 0027) — **and for a time it was the one column on this row that no client could
   * ever see.**
   *
   * ── THE FAILURE THAT PUT IT ON THE WIRE ─────────────────────────────────────────────────
   *
   * The failure this closes: a connect is accepted end to end, then loses the organizer claim to
   * a LOCAL install whose heartbeat is hours stale (`decideLease` arm 8 — a stale foreign claim
   * is `available`, never `organize`, without an authorized takeover). `markMailboxStoodDown`
   * wrote `status='disabled'` +
   * `disabled_reason='organized_elsewhere:local'` and cleared the four `error*` columns AND the
   * two `sync_blocked_*` columns in the same statement, because **a stand-down is neither a
   * failure nor an infrastructure block**. Both of those are correct. The consequence was not:
   * with `errorCode` null, `syncBlockedSince` null and this column absent from the DTO, the
   * client had NO field that carried the fact. It rendered "disconnected" beside "No mail yet —
   * added 3 minutes ago", under a strip that said "No mailbox connected, so nothing can arrive".
   *
   * ── GATED ON `status === 'disabled'`, WHICH IS THE OPPOSITE OF THE TWO FIELDS ABOVE ────
   *
   * And the asymmetry is not an inconsistency — it is the SAME rule pointing the other way.
   * mail 0029's fields must be ungated because every state they describe happens while `status`
   * IS `connected`; a gate would make them permanently NULL, which is the invisibility the
   * migration exists to end. This column is the inverse: `markMailboxStoodDown` writes it in the
   * same statement as `status='disabled'` and it is meaningful under no other status.
   *
   * Ungated projection was drafted first and is WRONG, for a reason worth recording.
   * `MailboxService.update` deliberately does not clear the column on a re-enable —
   * `clearOrganizerStandDown` in the worker owns that clear and performs it
   * only once the gate has actually WON the mailbox back. So an ungated projection would ship
   * `{status: 'connected', disabledReason: 'organized_elsewhere:local'}` for the whole re-enable
   * window: a mailbox telling its owner it is connected AND that somebody else holds it. That is
   * a NEW instance of the exact contradiction this field was added to remove.
   *
   * ── AND `null` HERE MEANS "NOT STOOD DOWN", SO A NON-NULL COLUMN MAY NEVER BECOME ONE ──
   *
   * The same invariant, transposed. `syncBlockedReason` can afford to narrow an unrecognised member to `null`
   * because `syncBlockedSince` carries the predicate beside it. This field has no such partner:
   * `status` is the predicate, and under `disabled` a `null` reason is the ORDINARY DISCONNECT —
   * a real, common and completely different state. So a server that grows a fourth member must
   * not narrow it to `null` on the way out, or a newer worker's stand-down reads on an older API
   * as "the user disconnected this", which is the original defect wearing a different hat. The
   * closed set ships its own catch-all for exactly this, and `toDTO` uses it.
   *
   * A CLOSED set of three (`MAILBOX_DISABLED_REASONS`, `@trafficflow/db`) with a CHECK
   * constraint behind it, so — like `syncBlockedReason` and unlike `errorDetail` — no value a
   * mail server chose can reach it. A stable key, never a sentence: the client owns the wording.
   */
  disabledReason: MailboxDisabledReason | null;
  /**
   * WHEN this mailbox's FIRST import actually finished (mail 0038) — stamped by the worker the
   * first time a cycle completes with no backlog remaining, and NULL until then.
   *
   * It is here because it is the one honest end-of-import signal, and `lastSyncAt` is not: that
   * column is shared across every mailbox a cycle served and lands after the FIRST cycle whether
   * or not a backlog remains, so a mailbox thirty seconds into a long import already carries one.
   * This column is per-mailbox and late — `apps/webapp/app/shell/mail-state.ts` reads it as a
   * FLOOR (`null ⇒ still importing`) so a partial mailbox cannot present itself as complete just
   * because a client's own mirror has stopped growing. Projected UNCONDITIONALLY: unlike the
   * `error*` fields it is meaningful in every lifecycle state, and gating it would hide exactly
   * the partial-import case it exists to disclose.
   */
  initialImportCompletedAt: ISODateTime | null;
  /**
   * HOW MANY OF OUR OWN FILINGS THIS MAILBOX HAS NOT YET APPLIED.
   *
   * ── THE SILENCE THIS ENDS ────────────────────────────────────────────────────────────
   *
   * Invariant #3: the serverless API never opens IMAP. A Screener decision, a bulk apply, a
   * move — every one of them writes `folder_state` and returns, and the WORKER performs the
   * actual IMAP move on its next cycle. That is correct and it is what keeps a request path
   * from holding a mail connection. What the wire never carried is the consequence: between
   * the press and the worker's cycle the user's mail has been filed in ohmail and NOT on their
   * server, and if the mail host is refusing connections that gap does not close.
   *
   * From the client's side that state was indistinguishable from a finished job. The mirror
   * shows the mail where the user put it, `status` says `connected` (a host that refuses one
   * cycle has not yet earned `error`), `syncBlockedSince` is null because this is not one of
   * our own infrastructure blocks, and the strip is `quiet`. So the product looked complete
   * while a growing backlog of the user's own decisions sat unapplied — and the one screen
   * that could have said so said nothing.
   *
   * ── WHAT IT COUNTS, AND WHY EACH CLAUSE IS THERE ─────────────────────────────────────
   *
   * `folder_state` rows for this mailbox where `reconcile_status = 'pending'` AND
   * `last_set_by = 'us'` AND `desired_folder <> observed_folder`. All three:
   *
   *  · `last_set_by = 'us'` — an EXTERNAL pending row is the user moving mail in their own
   *    client, which we adopt rather than apply. Counting it would report the user's own
   *    tidying as our backlog.
   *  · `desired <> observed` — a pending row whose two folders already agree is a no-op the
   *    reconciler will retire without touching IMAP. It is not work.
   *  · `pending` — `reconciled` and `failed` are both terminal for this purpose; a failed row
   *    is a different sentence (and a different column) from "not applied yet".
   *
   * ── PROJECTED UNCONDITIONALLY, LIKE THE SYNC-BLOCK PAIR AND UNLIKE THE `error*` FOUR ──
   *
   * Every state it describes happens while `status` IS `connected` — that is the point. A gate
   * on `status` would make it permanently 0 on the wire, which is the invisibility being
   * removed. And 0 is the ordinary case and means exactly "nothing of ours is outstanding".
   *
   * A client must read it with a `typeof === "number"` guard, never `> 0` on a possibly-absent
   * field: a bundle older than this column omits it, and `undefined > 0` is false, so a naive
   * read degrades correctly — but `Filing 0 messages` is the failure in the other direction and
   * `apps/webapp/app/shell/mail-state.ts` states the rule it applies.
   */
  pendingMoves: number;
  folders?: MailboxFolderSummary[];
  createdAt: ISODateTime;
  // NOTE: intentionally NO credential field — creds are envelope-encrypted at rest
  // in `mailbox_credentials` and never leave the server.
}

// ── Tracker / spy-pixel events — "who tried to spy
// on you". Materialized from `tracker_events` joined to the message (sender) and
// its body (blocked = remote content not yet loaded). The stored `kind`
// ('pixel'|'remote_image'|'read_receipt') maps to the wire kind. ──
export interface TrackerEventDTO {
  id: string;
  messageId: string;
  sender: EmailAddress;
  pixelHost: string;              // who tried to spy (host; "" when unresolvable)
  detectedAt: ISODateTime;
  kind: "tracking_pixel" | "read_receipt" | "remote_beacon";
  blocked: boolean;               // true while remote content is blocked (not loaded)
}

export interface RuleDTO {
  id: string;
  kind: "sender" | "domain" | "header";
  match: string;
  destination: Folder;
  priority: number;
  /** `seeded-from-sent`: written by the onboarding seed for someone the user had written to. */
  provenance: "manual" | "migrated" | "promoted" | "seeded-from-sent";
  enabled: boolean;
  /**
   * The rule's SECOND term, or `null` — *from this address AND with this in the subject* (mail
   * 0050). A conjunction, never an alternative: a present term only ever makes the rule fire less
   * often. Offered on `kind: "sender"` only; see `RulesService.validSubjectContains`.
   *
   * It is on the DTO because two surfaces cannot tell the truth without it: the rules list would
   * render two rules for one address identically, and the sender sheet's rule ladder would retarget
   * a narrow subject rule when the user changed a broad sender's destination.
   */
  subjectContains: string | null;
  /**
   * The rule's THIRD term, or `null` — *from this address AND with this in the message text*
   * (mail 0052). `subjectContains`' contract one field deeper, and on the DTO for its reasons:
   * the rules list and the ladder must be able to tell a body-narrowed rule from a bare one.
   */
  bodyContains: string | null;
  stats: { hits: number; lastHitAt: ISODateTime | null; demotions: number };
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference & compose niceties. These are REST-only resources (no /sync entity
// growth); clients refetch. The wire shapes reflect the 0010 tables (which the
// migration fixes) — noting two deviations from the aspirational DTOs: a snippet
// carries `title`/`shortcut` (its stored columns) rather than `name`, and a
// notify-rule carries a `{ kind, target }` text spec rather than a contact/thread
// union (the 0010 column shape).
// ─────────────────────────────────────────────────────────────────────────────

export interface ContactDTO {
  id: string;
  name: string | null;
  addresses: string[];            // the known sender address(es) — one per contact row today
  screened: "approved" | "screened_out" | "unknown";   // Screener outcome (default "unknown" pre-integration)
  lastSeenAt: ISODateTime | null;
  updatedAt: ISODateTime;
}

export type NoteTarget =
  | { kind: "contact"; contactId: string }
  | { kind: "thread"; threadId: string };

export interface NoteDTO {
  id: string;
  target: NoteTarget;
  body: string;
  updatedAt: ISODateTime;
}

export interface SnippetDTO {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  updatedAt: ISODateTime;
}

export interface NotifyRuleDTO {
  id: string;
  kind: string;                   // 'sender' (default) | 'domain' | 'keyword' | 'thread' …
  target: string;
  createdAt: ISODateTime;
}

export interface AwayResponderDTO {
  enabled: boolean;
  subject: string | null;
  body: string | null;
  startsAt: ISODateTime | null;
  endsAt: ISODateTime | null;
  /**
   * Who gets an automatic reply. `'screened_in'` — the default, and what the default-disabled shape
   * reports — restricts it to senders already past the Screener; `'everyone'` includes a
   * first-contact stranger still held there. Never null: see the column's note in `schema-mail.ts`.
   */
  audience: "screened_in" | "everyone";
  updatedAt: ISODateTime | null;  // null when never configured (default disabled shape)
}

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Base + manual drafts (`/kb`, `/drafts`).
//
// `KbEntryDTO` is the account's knowledge-base entry (REST-only). `DraftDTO`
// is a STORED, never-auto-sent reply; `status` is the send-progress state a
// `draft` change_log row surfaces to clients. `mailboxId` is required
// (send must pick the identity/SMTP).
// ─────────────────────────────────────────────────────────────────────────────

export interface KbEntryDTO {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type DraftStatus = "draft" | "sending" | "sent" | "unverified";

export interface DraftDTO {
  id: string;
  mailboxId: string;
  threadId: string | null;
  inReplyToMessageId: string | null;
  subject: string;
  /**
   * The text/plain body. Always present and always authoritative for a plain draft.
   *
   * When {@link html} is set this is the alternative DERIVED from it on the server rather than
   * anything a client supplied — see `outbound-html.ts`. A `multipart/alternative` is a promise
   * that its two parts say the same thing, and deriving one from the other is what makes that
   * promise structural instead of a convention two clients have to keep.
   */
  body: string;
  /** The rich body, sanitized. `null` for a plain-text draft — the ordinary case. */
  html: string | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  /**
   * Blind-carbon recipients. Echoed back so a client can confirm the server ACCEPTED them — a new
   * client sending `bcc` to a server that predates it gets a DTO with no `bcc` key and can refuse
   * to send rather than deliver silently without the copies. Never leaves the envelope on the wire:
   * the delivered message and the Sent copy carry no Bcc header (see `SendService`).
   */
  bcc: EmailAddress[];
  rationale: string | null;
  status: DraftStatus;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow automation. Both DTOs are
// REST-only (no /sync entity growth): clients refetch via `GET /workflows` +
// `GET /workflow-runs`. `WorkflowDTO.steps` may only declare the three allowlisted
// tools (validated at create/update). `provenance` is 'user' for user-authored
// workflows; 'proposed' (AI, inert until enabled) / 'graduated' arrive later.
// ─────────────────────────────────────────────────────────────────────────────

export type WorkflowProvenance = "proposed" | "user" | "graduated";

export interface WorkflowDTO {
  id: string;
  name: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  enabled: boolean;
  provenance: WorkflowProvenance;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// An AI-proposed automation. REST-only, INERT until
// `POST /workflows { fromProposalId }` materializes it into a disabled workflow.
export type WorkflowProposalStatus = "open" | "materialized" | "dismissed";

export interface WorkflowProposalDTO {
  id: string;
  name: string;
  rationale: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  sourcePattern: WorkflowPattern | null;   // redacted metadata the suggestion was derived from
  status: WorkflowProposalStatus;
  createdAt: ISODateTime;
}

export type WorkflowRunStatus =
  | "pending" | "running" | "awaiting_approval" | "succeeded" | "failed" | "undone";

export interface WorkflowRunDTO {
  id: string;
  workflowId: string | null;      // null once the source workflow is soft-deleted (retention)
  status: WorkflowRunStatus;
  trigger: WorkflowTrigger | Record<string, unknown>;
  log: unknown[];
  stepCursor: number;
  reason: string | null;
  createdAt: ISODateTime;
  finishedAt: ISODateTime | null;
}

// ── /sync wire shapes ──

export interface SyncChange<T = unknown> {
  type: EntityType;
  op: ChangeOp;
  id: string;
  seq: number;
  updatedAt: ISODateTime;
  entity?: T;                                   // omitted for op:"delete"
  move?: { from: Folder | null; to: Folder };   // present only for op:"move"
}

export interface SyncResponse {
  changes: {
    creates: SyncChange[];
    updates: SyncChange[];
    moves: SyncChange[];
    deletes: SyncChange[];
  };
  cursor: string;
  hasMore: boolean;
  serverTime: ISODateTime;
}

/**
 * How far back the snapshot reaches, SERVED rather than agreed.
 *
 * The client needs the numbers to say "this is everything since March" and to decide when to
 * fall back to the delta replay, and a constant compiled into the client is a constant that
 * disagrees with the server the first time either moves. So the server states its own window in
 * every response and the client reads it.
 *
 * `days` is the recency floor; `minRows` is the volume floor. A snapshot serves whichever is
 * LARGER — every message of the last `days`, and never fewer than `minRows` of them when the
 * mailbox has that many. A quiet mailbox therefore still bootstraps into something usable, and a
 * busy one is not truncated at ninety days minus one message.
 */
export interface SnapshotWindow {
  days: number;
  minRows: number;
}

/**
 * `GET /sync/snapshot` — the bootstrap reader.
 *
 * ── WHY THIS REUSES `SyncChange` INSTEAD OF HAVING A SHAPE OF ITS OWN ─────────────────────────
 *
 * The client's apply path is the thing worth protecting. It already takes `SyncChange[]`, sorts
 * by seq, upserts on (type,id) and refuses an older-or-equal seq; a bespoke snapshot shape would
 * need a second apply path, and two apply paths over one store is how a mirror ends up holding a
 * state neither path can explain. So a snapshot row is a `SyncChange` with `op: "create"` and the
 * full DTO — a create is exactly what a bootstrap means — and the client changes nothing.
 *
 * EVERY row carries `seq = asOfSeq`, and that is what makes the older-or-equal guard correct for
 * free: a delta change that comes later has `seq > asOfSeq` and therefore wins, while a re-read
 * of the same snapshot page has `seq == asOfSeq` and is ignored. There is no per-row seq to
 * invent, and inventing one would be a claim about ordering the snapshot does not make.
 *
 * `nextCursor` is `null` when the snapshot is complete. It is opaque and encodes `asOfSeq`
 * alongside the keyset position, so every page of one snapshot reads the same consistent point
 * and the client's post-bootstrap delta cursor is that same `asOfSeq` whichever page it stopped on.
 */
export interface SnapshotResponse {
  asOfSeq: number;
  changes: SyncChange[];
  nextCursor: string | null;
  window: SnapshotWindow;
}
