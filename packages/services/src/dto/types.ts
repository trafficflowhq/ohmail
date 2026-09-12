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

/**
 * Every state a `message_states` row can hold. `none` plus the four bottom piles, then
 * `resurfaced` — not a pile but a PIN at the top of the Ohbox (`selectors.ts#ohboxView`), cleared
 * back to `none` when the row is marked read. It was on this wire before it was in this union —
 * `bubbleUpPass` has written it since the pin shipped, so every resurfaced row the API ever
 * served carried a `state` the type said was impossible. A client may set it directly: "resurface
 * this now" has no honest spelling in `bubbled_up` — a past `bubbleUpAt` pins nothing until a
 * pass runs, gated at 60s in the worker and never run on a standalone desktop. `bubbleUpAt` is
 * null on it in both directions: there is no schedule to spend.
 */
export type TriageState =
  | "none" | "reply_later" | "set_aside" | "bubbled_up" | "muted" | "resurfaced";

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
     * WHICH pile the model actually named — the answer `decision` collapses. The collapse was
     * lossy in a way the user could see: on a live account 63 `ohmail/Receipts`, 43
     * `ohmail/Reads` and 5 `ohmail/Quarantine` answers all rendered as the single word "Screened
     * out", so the Screener appeared never to suggest Receipts, Reads or spam. A surface shows
     * this; nothing acts on it. `decision` remains the only field a control may consult, so a
     * client that ignores this field behaves exactly as before.
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
   * When this message stopped being unread, or `null` if that is not known. The order the
   * client's "Earlier" group is sorted by — reading history, ordered by reading, rather than by
   * when senders happened to send. `null` covers two rows that cannot be told apart and do not
   * need to be: never read, and read before the field existed; both sort below every stamped row.
   * Projected on EVERY message the API emits — list, single, delta and snapshot — because there
   * is one projection and the sort must work on a mirror built from any of them. A client newer
   * than the server reads `undefined` and treats it like `null`, so neither side has to deploy
   * first.
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
  /**
   * TRUE means this row is a reply the away responder sent, not one the person wrote.
   * Server-computed: raw `headers` cross the wire in neither body mode, and the `away_replies`
   * ledger is not mirrored; `packages/db/src/auto-reply-by-us.ts` is the one definition,
   * evaluated once per page. `ohboxView` unions the account's own sent mail into "Earlier" —
   * right for mail the person wrote, wrong for a machine's reply wearing "Re: …"; this field
   * tells them apart. It is NOT "was this automated": an inbound out-of-office from a stranger is
   * `false` — the predicate asks whether WE sent it. OPTIONAL, additive: `undefined` means "not
   * known", read as the person's own — the client's test is `!== true`, never `=== false`.
   */
  autoReplyByUs?: boolean;
  /**
   * When the away responder answered THIS message — an instant, or `null`. The mirror of {@link
   * autoReplyByUs}, deliberately a different row: that flag marks the REPLY, this stamp marks the
   * ORIGINAL — a reader wants to know a machine already answered, and the reply sits in Sent
   * where they are not looking. Which rows count: `outcome in ('sent','unverified')` AND non-null
   * `sent_at` — that set means "the claim is kept, no second reply will be offered". `sent_at`,
   * never `decided_at`: the finalizer writes `sent_at` only on `sent`, so an `unverified` row
   * yields no mark today — the member keeps the field correct the day an ambiguous send learns a
   * stamp. Absent reads like `null`.
   */
  awayRepliedAt?: ISODateTime | null;
}

/**
 * One row of the Trash list — a message plus the two things only Trash needs to say. `MessageDTO`
 * unchanged, with two additions rather than a second projection: the list renders the same row
 * component every folder view renders, and the reading pane opens these rows through the ordinary
 * body route, so a row that was not a `MessageDTO` would need a conversion at the one seam where
 * a conversion is a bug. Note what `folder` still says on these rows: the mailbox's Trash path,
 * because that is where the message is — deliberately not rewritten to the origin: the mirror's
 * rule is that `folder` is where the server has the message, and a row that lied about it would
 * move wrongly if anything ever filed it.
 */
export interface TrashRowDTO extends MessageDTO {
  /**
   * WHEN IT WAS DELETED — `folder_state.updated_at`, which is the instant the delete wrote the
   * desired folder. This list is ordered by it, so it is also the row's keyset position.
   *
   * Not `messages.updated_at`: that moves whenever anything about the message changes (a read
   * stamp arriving from another client, a tag), so it would reorder Trash for reasons that have
   * nothing to do with deleting. Not `deleted_at` either — a message tombstoned by the expunge
   * reaper carries one and never rode to Trash, and it is not in this list.
   */
  trashedAt: ISODateTime;
  /**
   * WHERE RESTORE WOULD PUT IT — already RESOLVED, never the raw stored origin.
   *
   * `folder_state.trashed_from` when that still names INBOX, one of the six, or a folder this
   * mailbox still has; `"INBOX"` otherwise (no origin recorded, or the origin folder is gone).
   * Resolved on the server so the row and the button cannot disagree: the client renders this
   * string as the destination gloss AND the toast says it, and a client that resolved it itself
   * would need the folder inventory to do so — which a windowed mirror may not hold.
   */
  restoreTo: string;
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

/**
 * One of the mailbox's own folders — the `folder` entity `/sync` reserves and the folders
 * foundation fills (FOLDERS-SPEC.md §4). Materialized from the worker's `mailbox_folders`
 * inventory (post-exclusion: never the organized six, the Sent folder or the `ohmail` namespace),
 * and emitted ONLY while "Use folders" is on — a flag-off account's wire is byte-identical to the
 * pre-feature wire. `name` is the CANONICAL `/`-joined path, the spelling `MessageDTO.folder`
 * carries for mail living there — the natural key. `mailboxId` and `mailbox` extend the spec's
 * minimal shape: the rail sections folders by mailbox, and a live client has no other mirror
 * source for the owning address.
 */
export interface FolderDTO {
  id: string;
  name: string;
  mailboxId: string;
  mailbox: string;
  updatedAt: ISODateTime;
  /**
   * The user's in-flight COMMAND on this folder (folders stage 2: create / rename / delete),
   * absent when settled. `name` stays the mailbox's OWN truth throughout — a rename in flight
   * carries the target in `op.to` and keeps the old `name` until the worker's RENAME lands, so
   * the mirror never claims a mailbox state that does not exist yet. `error` is a closed
   * catalogue code once the worker refused the command; it stands until dismissed or replaced.
   */
  op?: { kind: "create" | "rename" | "delete"; to?: string; error?: string };
}

/**
 * The account's settings row on the delta feed — the `"settings"` entity. One row per account
 * (`entity_id` = the account id, op always `"update"`). It exists so a settings write travels the
 * sync channel and rings the wake like any other change; the AUTHORITY for what a surface renders
 * stays `GET /consent` — a client reads this as "the settings moved, re-ask", never as a second
 * consent read. The wire carries only the row's own scalars: the flags surfaces gate chrome on,
 * and the stamp that says they moved. Deliberately absent: the consent read's counts (they change
 * with every drain and are not settings), and anything that authorises spending on its own —
 * `autoSuggestAt` is here as a FACT; the spend gate still reads `GET /consent`.
 */
export interface SettingsDTO {
  /** The account id — the entity's own id on the wire, one row per account. */
  accountId: string;
  /** Stored dial, or null for "the product default" (never the default value itself). */
  dormancyDays: number | null;
  autoSuggestAt: ISODateTime | null;
  blockRemoteImagesAt: ISODateTime | null;
  loadTrackingPixelsAt: ISODateTime | null;
  blockAutoUnsubscribeAt: ISODateTime | null;
  foldersEnabledAt: ISODateTime | null;
  /** Per-mailbox "Use folders" EXCEPTIONS — `{ mailboxId: instant switched off }` (spec §17). */
  folderMailboxesOff: Record<string, ISODateTime>;
  /** The account's interface language, or null for "no preference stored". */
  locale: string | null;
  updatedAt: ISODateTime;
}

/**
 * Why a stored body holds no content, when that is POLICY rather than an empty message — the
 * projection of `message_bodies.withheld_reason`, verbatim, closed set. `"storage_cap"` — the
 * account's managed storage cap (mail 0062): declined at ingest or evicted by the rolling window;
 * the mail is untouched on the user's own server. `"junk_filed"` — the spam verdict filed this
 * message to the provider's native \Junk (mail 0065): the durable artifact is the sender rule,
 * and the bytes live on in the Junk folder, the master. `"expunged"` — every watched copy is gone
 * from the server (mail 0065): the row is tombstoned and the husk exists so the account stops
 * paying for its bytes. Absent for every ordinarily stored body, including a genuinely empty one.
 */
export type WithheldMarker = "storage_cap" | "junk_filed" | "expunged";

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
  /**
   * Why `text` is empty, when it is empty by POLICY: `"storage_cap"` means ingest declined to
   * store this body because the account was at its cap — the mail itself is untouched on the
   * user's own server. Absent for every ordinarily stored body, including a genuinely empty one,
   * so the client can tell "this message says nothing" from "we are not holding what it says" —
   * the two used to collapse into one blank pane claiming to be complete. Served AS STORED, on
   * the same no-rehydrate contract as everything else here. Mail 0065 widens the closed set — see
   * {@link WithheldMarker} for the two new members.
   */
  withheld?: WithheldMarker;
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
   * The sender's unsubscribe posture — `?ids=` MODE ONLY, absent in the keyset mode. The two
   * modes serve two consumers: the keyset page feeds the macOS local text mirror and joins the
   * body row and NOTHING else — that absence is its no-rehydrate guarantee, pinned by a test
   * asserting the item's exact key set. The `?ids=` page feeds a READER opening a thread, so its
   * rows carry the same derived posture the single-message route carries, or a conversation's
   * siblings would offer no way out. Optional rather than a second interface: one row shape, one
   * field the mirror mode does not populate. Raw headers cross the wire in NEITHER mode.
   */
  unsubscribe?: UnsubscribeHeaderState;
  /** The sender's own https unsubscribe page, `?ids=` mode and `not_one_click` only; else null. */
  unsubscribeUrl?: string | null;
  /**
   * The stored row's withheld marker, BOTH modes — see {@link MessageBodyDTO.withheld}. In both
   * it is a fact about the ROW, projected verbatim: the mirror needs it or a withheld body is
   * mirrored as an empty complete one and never re-asked; the reader needs it for the honest
   * sentence. It extends the no-rehydrate pin rather than weakening it — a withheld row is
   * served exactly as stored, and nothing here gains a fetch.
   */
  withheld?: WithheldMarker;
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
  MailboxDisabledReason, MailboxErrorCode, MailboxSyncBlockReason, OrganizerKind,
} from "@trafficflow/db";
export type { MailboxDisabledReason, MailboxErrorCode, MailboxSyncBlockReason, OrganizerKind };

export interface MailboxDTO {
  /**
   * Organizer or reader — what THIS install is to this mailbox (mail 0083). `'reader'` means
   * another install organizes it, or nobody has asked this one to: the mailbox is CONNECTED and
   * its mirror is growing; what a reader does not do is move, file or delete mail. It is the
   * field every client's banner and the "Organize here instead" button read, and it rides the
   * POLLED `GET /mailboxes` row rather than a live IMAP dial — at most one worker pass behind,
   * which the copy states rather than hides. The three organizer fields are UNCONDITIONAL, on
   * `syncBlockedReason`'s rule: every state they describe happens while `status` IS `connected`,
   * and gating them on a status would reproduce the invisibility they exist to end.
   */
  organizerRole: "organizer" | "reader";
  /**
   * Who organizes it, when this install does not — `null` when this install does, or when nobody
   * has ever claimed it. `kind` is `ORGANIZER_KINDS` ITSELF rather than a second spelling, with a
   * CHECK behind the column — three literals written here instead went a whole release without
   * `mobile`, so a phone's claim reached this field as a value the wire could not name. `name` is
   * the holder's own machine name, which is why it is on the ADMIN DTO's deny-list: the account's
   * own user may see what named their laptop, staff may not. `since` is when that install BECAME
   * the organizer, not when it was last seen — a banner says "since Tuesday", never "last seen 40
   * seconds ago", because a heartbeat on a screen invites a person to watch it.
   */
  organizedBy: { kind: OrganizerKind | null; name: string | null; since: string | null } | null;
  /**
   * Whether that organizer is still RENEWING — `'held'` — or stopped and left its claim behind
   * (`'stopped'`). `null` is "this install has not looked", which is every reader's row until its
   * first cycle and every organizer's row always.
   *
   * The two states want opposite offers on screen ("ohmail Cloud organizes this" versus "ohmail
   * Cloud stopped organizing this"), which is the whole reason the lease's three verdicts are not
   * collapsed into two anywhere they reach a person.
   */
  organizerState: "held" | "stopped" | null;
  /**
   * Is the claim on this mailbox this install's OWN — answered by the server, not inferred. A
   * client asking it from `organizedBy.kind` gets `cloud`, which is what a SECOND Cloud
   * deployment is too; their ids differ by design, so the category cannot answer an identity
   * question. The id itself is deliberately NOT on the wire — an internal deployment name every
   * viewer would receive for no purpose — so the server compares and sends the answer. `false`
   * where nobody holds the mailbox, where another install does, and where this deployment cannot
   * say: every one of those means "do not offer to give up this claim".
   */
  organizedByThisInstall: boolean;
  /**
   * When somebody agreed to let ohmail organize THIS mailbox, or `null`. A different question
   * from `organizerRole`, and the pair is not derivable from either half: the role says who
   * organizes it NOW; this says whether permission was ever given. Freshly connected is `reader`
   * with a null; an organizer displaced by another install is `reader` with a stamp. The first
   * needs the consent screen; the second must NEVER be shown it again — re-asking for a granted
   * permission teaches people to click through consent. `organizeHere`'s precondition is `role =
   * 'reader' OR consent IS NULL`, unwritable with one field. UNCONDITIONAL: a mailbox awaiting
   * consent is `connected`.
   */
  organizeConsentedAt: ISODateTime | null;
  /**
   * When the organizing situation last changed, and when the person last acknowledged it
   * (0.14.1). The notice is DERIVED — `organizerEventAt > organizerEventSeenAt`, null `seenAt` =
   * never — not sent as a flag. Two instants make three properties hold: once per event on EVERY
   * door (a per-client flag shows the sentence once per client); two changes between two reads
   * COLLAPSE to the later one — the only statement still true; a dismissal cannot suppress a
   * LATER change. The sentence is NOT on the wire: derived at read time from the same facts a
   * stored sentence would copy — a copy drifts, and a server-rendered string cannot be
   * translated. UNCONDITIONAL, on the organizer fields' rule.
   */
  organizerEventAt: ISODateTime | null;
  organizerEventSeenAt: ISODateTime | null;
  /**
   * Can the holder of this mailbox accept a decision from a reader? (0.14.1) `true` only where a
   * reader's press has somewhere to go: the holder is still renewing AND its claim advertises the
   * request capability; `false` everywhere else. On the wire because the client must withhold a
   * control BEFORE the press: a decision bar wired to a refusal is the shape that let a released
   * build say "filed" and take it back forty-five seconds later. A derived boolean, not the
   * capability set: the set is a holder's self-description in somebody else's vocabulary, and a
   * customer DTO must not invite branching on unknown tokens. One question, one answer, computed
   * by the door's own rule.
   */
  organizerAcceptsRequests: boolean;
  /**
   * When this install last gave this mailbox up DELIBERATELY, or `null`. Written by the release
   * path and cleared by the next claim, so it is a statement about the CURRENT tenure rather than
   * a history: a mailbox released and then taken back reports null again, because "released" is
   * no longer what it is. On the wire so the mailbox pane can date its own permanent line: the
   * three reader shapes are otherwise indistinguishable from the outside — never organized,
   * holder vanished, and let go on purpose all read as a reader with no holder — and only the
   * third is something the person here did.
   */
  organizerReleasedAt: ISODateTime | null;
  /**
   * The standing ask to stop organizing this mailbox here, or `null`. Written the instant the
   * person presses "Stop organizing here, keep the mail", honoured by the organizer's own next
   * pass — so there is always a window, and on a server that will not confirm the removal there
   * can be many passes, in which the ask is real and nothing else on this row says so. A pane
   * reading only the role rendered an ordinary organized mailbox for that whole window: the
   * person pressed a button and the screen showed no trace, which on a slow server reads as the
   * button not working. Cleared by the pass that completes the release and by the countermanding
   * "Organize here" press. Projected raw: PENDING is the row's own state.
   */
  releaseRequestedAt: ISODateTime | null;
  /**
   * THE STANDING PRESS TO ORGANIZE THIS MAILBOX HERE, or `null` — the takeover's pending half,
   * on the same argument as {@link releaseRequestedAt}: the stamp is spent by the gate's next
   * pass, and until then the ask exists only on this column. A client that keeps its own
   * "asked for" note can end that note the moment either this clears or the role moves,
   * instead of showing it for ever beside a row that has long since answered.
   */
  takeoverAuthorizedAt: ISODateTime | null;
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
  // Why a `connected` mailbox is not being synced (mail 0029). PROJECTED UNCONDITIONALLY, and the
  // asymmetry with the four fields above IS the point: in every scenario these describe, the
  // status is `connected`. An infrastructure fault must never render as "your mailbox is broken",
  // earn a backoff, or quarantine anything — the row keeps saying `connected` and says WHY here.
  // `syncBlockedReason` is a closed set of three with a CHECK; a stable key, not a sentence.
  // NULL/NULL is the normal case. And `null` here does NOT mean "not blocked": the service
  // narrows an unrecognised member to `null` and forwards `syncBlockedSince` unconditionally —
  // "blocked, reason unrecognised" is a state the client must render. This field is COPY;
  // `syncBlockedSince` is the predicate. Widening to `string` was rejected.
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
   * Why a `disabled` mailbox is disabled, when the reason is the organizer lease and not a person
   * (mail 0027). A connect succeeded, then lost the claim to a LOCAL install with a stale
   * heartbeat; the stand-down cleared the error and block columns, and with nothing carrying the
   * fact the client rendered "disconnected". GATED on `status === 'disabled'` — the same rule as
   * the ungated pair, pointing the other way: meaningful under no other status, and ungated it
   * would ship `{connected, organized_elsewhere}` for the whole re-enable window. `null` here
   * means "not stood down": under `disabled` a null reason is the ORDINARY DISCONNECT, so an
   * unrecognised member must NOT narrow to `null` — the closed set ships its own catch-all.
   */
  disabledReason: MailboxDisabledReason | null;
  /**
   * When this mailbox's FIRST import actually finished (mail 0038) — stamped by the worker the
   * first time a cycle completes with no backlog remaining, NULL until then. The one honest
   * end-of-import signal: `lastSyncAt` is shared across every mailbox a cycle served and lands
   * after the FIRST cycle whether or not a backlog remains, so a mailbox thirty seconds into a
   * long import already carries one. Per-mailbox and late — `mail-state.ts` reads it as a FLOOR
   * (`null` = still importing), so a partial mailbox cannot present as complete just because a
   * client's mirror stopped growing. Projected UNCONDITIONALLY: meaningful in every lifecycle
   * state, and gating it would hide exactly the partial-import case it discloses.
   */
  initialImportCompletedAt: ISODateTime | null;
  /**
   * The forwarding-detection notice's evidence pair (mail 0078) — a quiet, dismissible fact about
   * a HEALTHY mailbox: a provider-level forward once diverted every inbound mail before IMAP
   * storage while the mailbox synced perfectly. `inboundQuietSince` non-null means the worker's
   * inbound-quiet pass recognised an episode — a connected, fully-imported mailbox whose genuine
   * inbound has been zero for the pass's window; the value is the newest genuine inbound date.
   * `inboundQuietDismissedAt` is the dismissal; the CLIENT owns the comparison: show iff `since`
   * is set, the health claims hold, and `dismissedAt` predates `since`. PROJECTED
   * UNCONDITIONALLY: every state here happens while `status` IS `connected`.
   */
  inboundQuietSince: ISODateTime | null;
  inboundQuietDismissedAt: ISODateTime | null;
  /**
   * How many of OUR OWN filings this mailbox has not yet applied. The API never opens IMAP — a
   * decision writes `folder_state` and the WORKER moves the mail next cycle — and between press
   * and cycle the mail is filed in ohmail, not on the server; that state was indistinguishable
   * from a finished job. What it counts: `pending` AND `last_set_by = 'us'` AND `desired <>
   * observed` — an EXTERNAL row is the user's own tidying; agreeing folders are a no-op; `failed`
   * is a different sentence. Projected UNCONDITIONALLY: a status gate would zero it on exactly
   * the rows it describes. Read with `typeof === "number"`, never `> 0` on a possibly-absent
   * field — and never render "Filing 0 messages".
   */
  pendingMoves: number;
  /**
   * The same outstanding filings, split by the operand that decides (mail 0097). One number
   * covered four situations: the shell read "Filing 1 message… the server is catching up" for ten
   * minutes — the COUNT was right, the sentence was the only one the single field could produce.
   * Three of the four are not "catching up": the rotation has not reached this mailbox (a turn
   * versus a stall); the server REFUSED and the retry is deferred; or a READER install decided,
   * and the holder applies it on its own schedule. Present WITH ZEROS, never absent: absent means
   * "this server predates the field", so a conditional projection would make a deployment that
   * CAN tell indistinguishable from one that cannot.
   */
  filing: {
    /** Outstanding filings the next reconcile turn will pick up (`next_attempt_at` null or past). */
    due: number;
    /**
     * Outstanding filings that are ASLEEP — refused, retry scheduled ahead.
     *
     * The row the reported sentence was about. `due + deferred` is {@link pendingMoves}; a client
     * that cannot tell the two apart cannot say anything true about either.
     */
    deferred: number;
    /**
     * When the OLDEST outstanding filing was written, ISO-8601 UTC, or null when none is.
     * `folder_state.updated_at` — the reconciler's own queue order (`listPendingFolderStates`
     * orders by it) and the honest "waiting since": the intent writers stamp it and
     * `deferFolderReconcile` deliberately does not — a refusal is not a re-filing. NOT a creation
     * stamp, considered and rejected: `folder_state` is keyed by message and upserted, so a
     * `created_at` dates the message's FIRST filing and would report weeks of waiting over a
     * decision made a second ago.
     */
    oldestPendingAt: string | null;
    /**
     * When the SOONEST deferred filing may be attempted again, or null when none is deferred.
     *
     * MIN and not max: it is when something will next happen, which is what a sentence promising
     * a retry has to name.
     */
    nextAttemptAt: string | null;
    /** The highest refusal count among the outstanding filings — 0 when none has been refused. */
    attempts: number;
    /**
     * WHY the worst-off outstanding filing was refused — one of
     * `refused | no_such_folder | read_only | over_quota`, or null.
     *
     * Read from the same row {@link attempts} comes from, so the two halves of one sentence are
     * about one message. NARROWED against the closed set rather than projected verbatim: a value
     * a newer worker writes and this API does not know becomes null, and a client renders its own
     * "your server would not say why" — never the raw string, which is one step from a mail
     * server's own words on somebody's screen.
     */
    lastRefusalClass: string | null;
    /**
     * WHEN THIS READ HAPPENED, ISO-8601 UTC.
     *
     * The strip runs a clock (nothing in the mirror moves when the worker drains this backlog, so
     * a state keyed on mirror movement would freeze) while the facts behind it are re-fetched
     * every 30 s and on nothing else. So the number was being animated up to thirty seconds
     * stale. With this the surface can state when it last looked instead.
     */
    asOf: string;
    /**
     * When the organizer's last pass finished, ISO-8601 UTC, or null when this deployment cannot
     * say. The fact that separates a TURN from a STALL: a pending filing waits for the rotation,
     * so one outstanding move is unremarkable while passes are landing and alarming while none
     * are. `null` on every local tier — there is no heartbeat to read — and a client must render
     * SILENCE on that clause rather than "no pass has ever run": a desktop install organizes its
     * own mailbox in-process and must never be told its organizer is dead.
     */
    lastCycleAt: string | null;
  };
  /**
   * The biggest message this mailbox's submission server said it will accept, in bytes — its own
   * RFC 1870 `SIZE` announcement, recorded by the connect-time SMTP probe (mail 0055). The
   * compose surface used to state a CONSTANT ceiling — the hosted API's body limit — too small
   * for a local install and too LARGE for a provider capping submission below it, where the
   * product accepted the send and let the server bounce it. `null` means no announced ceiling (no
   * `SIZE`, the bare keyword, or `SIZE 0` — RFC 1870 §6); ABSENT is an API older than the column.
   * NOT the cap on its own: the applying ceiling is the SMALLER of this and what the host can
   * take — `effectiveAttachmentCap` in `send-service.ts` is the authority.
   */
  smtpMaxSizeBytes?: number | null;
  /**
   * Why sending is not set up for this mailbox — a reason code, or `null` when it is. An outgoing
   * server is not a reason to stop receiving: a refused submission dial used to abort the whole
   * connect, so a mailbox whose incoming server worked could not be connected at all. The connect
   * succeeds now: the incoming credential is stored, no `smtp` row is written (an unproven
   * submission credential is what the service refuses to store), and this carries the probe's own
   * reason — `auth` · `connect` · `tls` · `timeout` · `unknown`, the set the connect form already
   * renders. `null` means sending is settled — proved when the password was stored, not a
   * promise. The repair is a normal credential patch, which re-probes.
   */
  sendingUnsettledReason?: string | null;
  /**
   * How much mail is in this mailbox — the only OPT-IN field on this DTO. An aggregate over the
   * account's ENTIRE `messages` table on a POLLED route (the shell reads it every 30 s per tab);
   * unconditional would put a full history scan behind a heartbeat. Computed only for `GET
   * /mailboxes?counts=1`, in ONE account-scoped statement grouped by mailbox. ABSENT and `0` are
   * different answers: `0` is a real state — a freshly connected mailbox during its first import;
   * ABSENT means nobody asked. A renderer reads `typeof === "number"` and shows NOTHING when
   * absent — never "0 messages", which would tell somebody their mail vanished because a status
   * poll happened to land last. Whole mail, unread or not.
   */
  messageCount?: number;
  /**
   * How much mail the SERVER says is in there — the first pull's DENOMINATOR. {@link
   * messageCount} is the numerator; until this there was no denominator: the adapter read
   * `EXISTS` off every SELECT and threw it away. Mail 0083 added `mailbox_folders.server_exists`;
   * this is that column, summed. UNCONDITIONAL: the projection already reads these rows, so the
   * sum costs nothing. A sum over OPENED folders, so it can go UP — a floor that moves — and it
   * can be smaller than {@link messageCount}; a caller clamps `remaining` at zero and shows
   * nothing at zero. ABSENT covers both no-number cases; a `0` floor would claim the server holds
   * no mail — an uncounted server has no answer at all.
   */
  serverMessageCount?: number;
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
  /**
   * The responder is REPLY-ONLY (mail 0087): it carries no subject of its own and answers with
   * `Re: <what the correspondent wrote>`, threaded by `In-Reply-To`/`References`. `subject` is
   * therefore GONE from this contract — the column survives one release for a rolling deploy's
   * sake, unread and unwritten, and `put` accepts the field and ignores it so an older client's
   * save is not a 400. It is dropped by a 0.15 contract migration.
   */
  body: string | null;
  startsAt: ISODateTime | null;
  endsAt: ISODateTime | null;
  /**
   * Who gets an automatic reply. `'screened_in'` — the default, and what the default-disabled shape
   * reports — restricts it to senders already past the Screener; `'everyone'` includes a
   * first-contact stranger still held there. Never null: see the column's note in `schema-mail.ts`.
   */
  audience: "screened_in" | "everyone";
  /**
   * Which piles get a reply (mail 0096; four members by mail 0101) — folder names, `['INBOX']`
   * when omitted. The second dimension beside `audience`: `audience` is a fact about a SENDER
   * (past the Screener, decided once); this is a fact about WHERE their mail landed. FOLDERS, not
   * pile words: the Ohbox pile's folder is `INBOX`, and the surface translates for display
   * (`AWAY_PILE_VIEW`/`awayEffectivePiles` in `@trafficflow/core/away-scope`, imported by both
   * the settings control and the banner so the offered set cannot drift from the refused one).
   * Never null; an EMPTY array is a responder that answers nobody — a state, not an absence.
   * `ohmail/Screener` is only ever stored beside `audience: 'everyone'`.
   */
  piles: ("INBOX" | "ohmail/Reads" | "ohmail/Receipts" | "ohmail/Screener")[];
  /**
   * HOW OFTEN ONE PERSON MAY BE ANSWERED — `'per_day'` when omitted by a client, which is both the
   * column default and what every row migrated by 0087 carries.
   *
   * `'per_message'` means "once, until you change the text" and is keyed by a hash of the body, not
   * by this row's `updatedAt`: a save is not an edit, and keying on the row is what made switching
   * the responder off and on again re-answer every correspondent.
   */
  throttle: "always" | "per_message" | "per_day" | "per_week";
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

export type DraftStatus = "draft" | "scheduled" | "sending" | "sent" | "unverified";

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
  /**
   * WHEN this draft is scheduled to be sent (mail 0077) — non-null exactly while `status` is
   * `scheduled` (it also survives, invisibly to clients, through the worker's claim window as
   * the crash-recovery predicate). A client renders it in the reader's own local time; the
   * value is the instant the user picked, with timezone.
   */
  sendAt: ISODateTime | null;
  /**
   * The failure sentence from a scheduled send that could not be kept — the mailbox was
   * disconnected by send time, and so on. Server words, rendered as a quotation (the same
   * treatment `SendState.reason` gives a live refusal); cleared by the next edit or schedule.
   */
  sendError: string | null;
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
 * How far back the snapshot reaches, SERVED rather than agreed. The client needs the numbers to
 * say "this is everything since March" and to decide when to fall back to the delta replay, and a
 * constant compiled into the client disagrees with the server the first time either moves — so
 * the server states its own window in every response. `days` is the recency floor; `minRows` the
 * volume floor. A snapshot serves whichever is LARGER: every message of the last `days`, and
 * never fewer than `minRows` when the mailbox has that many — a quiet mailbox still bootstraps
 * into something usable, and a busy one is not truncated at ninety days minus one message.
 */
export interface SnapshotWindow {
  days: number;
  minRows: number;
}

/**
 * `GET /sync/snapshot` — the bootstrap reader. It reuses `SyncChange` because the client's apply
 * path is the thing worth protecting: it already sorts by seq, upserts on (type,id) and refuses
 * an older-or-equal seq — a bespoke snapshot shape would need a second apply path, and two apply
 * paths over one store is how a mirror holds a state neither can explain. A snapshot row is a
 * `SyncChange` with `op: "create"` and the full DTO. EVERY row carries `seq = asOfSeq`, making
 * the older-or-equal guard correct for free: a later delta wins, a re-read of the same page is
 * ignored. `nextCursor` is `null` when complete, opaque, encoding `asOfSeq` beside the keyset
 * position — every page reads one consistent point.
 */
export interface SnapshotResponse {
  asOfSeq: number;
  changes: SyncChange[];
  nextCursor: string | null;
  window: SnapshotWindow;
}
