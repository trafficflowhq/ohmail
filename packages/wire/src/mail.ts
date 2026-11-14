/**
 * A LETTER AS THE SERVER ANSWERS IT, and what hangs off one: its triage state, the identity fact
 * about its sender, its conversation, the routing decision and the approval it may wait on.
 */
import type { AuthVerdict, EmailAddress, Folder, ISODateTime, SensitivityFlags } from "./base.js";

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
  /**
   * Every state that crosses the wire, `resurfaced` included: the server has always been able to
   * serve it here, so a narrower type was a claim the wire never honoured.
   */
  state: TriageState;
  bubbleUpAt: ISODateTime | null;
  setAt: ISODateTime;
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
  /**
   * WHEN THE MAILBOX RECORDED THIS MESSAGE — `messages.created_at`, never null.
   *
   * {@link date} is the sender's own `Date:` header and any stranger can omit it; this is the
   * fact beside it that nobody outside can withhold, and the cutline dates a message by the
   * header ELSE this (`@trafficflow/db#cutlineInstant`, and the client engine's `messageMs`).
   * Without it on the wire the client had no arrival to fall back to, so an undated message
   * retired its sender on a mirror the server counted active.
   */
  arrivedAt: ISODateTime;
  /**
   * THE INSTANT THE ROW SORTS BY — the sender's {@link date} while it lies within tolerance before
   * the mailbox's own arrival (`messages.arrived_at`, the IMAP INTERNALDATE), else that arrival
   * (a header months from arrival took a position months from where the reader watched
   * the row). Computed in ONE place, `materialize.ts#sortAtOf`; the client keys its date order on
   * `sortAt ?? date`. ABSENT when the row's arrival was never recorded (every row before mail
   * 0119, a server older than the field) — absent means "the header decides", the exact order
   * every mirror had before, so neither side has to deploy first and no history re-sorts.
   */
  sortAt?: ISODateTime;
  folder: Folder;
  snippet: string;
  unread: boolean;
  /**
   * When this message stopped being unread, or `null` if that is not known — state, the seen
   * pill; it orders nothing (the one read that places a row is {@link openReadAt}). `null` covers
   * never read and read before the field existed. Projected on EVERY message the API emits — one
   * projection, so every mirror reads the same state. A client newer than the server reads
   * `undefined` as `null`, so neither side has to deploy first.
   */
  lastReadAt: ISODateTime | null;
  /**
   * When this message was read in ohmail while it was the row open in the reader —
   * Earlier places a row by max(arrival, this). `null` for every other read and for an unread. This
   * server projects it on every message; OPTIONAL because an older server omits it and every reader
   * takes `undefined` as `null` — arrival, the order before the field.
   */
  openReadAt?: ISODateTime | null;
  /**
   * The mail server holds no copy of this letter that ohmail knows of (mail 0164), and the mirror
   * keeps its only one; a reader can say so. ABSENT when held, and on a server older than the field.
   */
  missingOnServer?: true;
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
  /**
   * TRUE ⇒ the message SAYS it is a meeting invitation and carries no calendar part for the card
   * to render — the Outlook Web Access shape, where the event went out as a link and the body is
   * boilerplate about it. Server-computed from stored headers and parts (`invitationWithoutEvent`
   * in core's `mime.ts`, `invitationWithoutEventWhere` in SQL). OPTIONAL: absent means "not
   * known", read as "say nothing", which is what every mirror did before the field.
   */
  invitationWithoutEvent?: boolean;
  /**
   * TRUE ⇒ this message declares `method=REPLY` (its top-level `Content-Type` or a calendar
   * part's stored type) — one arm of "is
   * this a calendar acknowledgement rather than something a person said". The other arm is the
   * subject a calendar client writes, which the client composes itself. Server-computed because
   * the header is not mirrored. Absent means "not known"; consumers test `=== true`.
   */
  itipReplyHeader?: boolean;
  /**
   * What this message's own provider said about its claimed author — `messages.auth_verdict`
   * narrowed to routing's four words (`asAuthVerdict`); `null` is "nobody asked". Only `"fail"`
   * changes a client's reading: a forged `From` is a claim, never a correspondent. Projected on
   * every message; a client reads absent (an older server) as `null`.
   */
  authVerdict?: AuthVerdict | null;
  /**
   * THE IDENTITY FACT (`messages.sender_check`, mail 0148): the sender's name claims `brand`, and
   * this address is not one `brand` sends from; `domainShared` — the address is at a provider where
   * anyone can register one. `null` is "checked, nothing found"; ABSENT is "never checked" (a row
   * older than the column, an older server), which a client renders as nothing. `unverified` is
   * read off `authVerdict` beside it: see {@link SenderCheckDTO.reason}.
   */
  senderCheck?: SenderCheckDTO | null;
  /**
   * THIS LETTER'S PLACE IS DECIDED (`folder_state.decided_at`, mail 0145): a person placed it — a
   * press here, a move adopted from another client — or the gate admitted it as an answer to the
   * person's own writing. ABSENT where no such decision stands, and from an older server.
   */
  placeDecided?: true;
}

/** The identity fact as every surface reads it — one sentence per field, outside any AI advice. */
export interface SenderCheckDTO {
  /**
   * `impersonation`: the sender's name claims `brand` and the address is not `brand`'s.
   * `unverified`: the address is at `brand`'s own domain and the mailbox's provider did not confirm
   * the sender (`auth_verdict` not `pass`), so a forgery of that exact domain would read the same.
   * Derived when read, never stored; a line to read, which holds nothing back and draws no chip.
   * There `brand` is the name the address gives itself: the brand's, or the registrable domain where
   * that names no one brand (a government's umbrella such as `admin.ch`, a domain two brands list).
   */
  reason: "impersonation" | "unverified";
  brand: string;
  domainShared: boolean;
  /**
   * Which writer gave the fact (`messages.sender_check_by`, mail 0149): `"ingest"` as the message was
   * stored, `"backfill"` later, for a row stored before the fact existed. ABSENT is a build older than
   * the column. The client's held-claim term reads it as the server's does.
   */
  by?: "ingest" | "backfill";
  /**
   * The address is one a mailing list posts as (mail 0150): anyone on the list can write as it.
   * Present only as `true`; absent is "not a list address" and "an older server" alike.
   */
  list?: true;
  /**
   * On the queue page's row only: a screen-out of this sender files the letters that claim `brand`
   * alone and writes no rule — a list address the person let in, with a claim a press can reach.
   * Absent: the screen-out is the address's, as from an older server.
   */
  claimsOnly?: true;
  /**
   * On `unverified` only: the row's identity column was never written (NULL), so a press reads the
   * letter as never checked, exactly as the server's press does (`heldRowMovesOnPress`).
   */
  unchecked?: true;
  /**
   * The gate holds the letter (on a queue row, a letter of the sender) for want of confirmation
   * (`messages.unconfirmed_hold`, mail 0176); on a message, beside a claim too. A held claim to every
   * reader: it keeps its sender waiting, dated by its record time, no release takes it unless a person
   * consented (on `unverified`, a domain rule a person wrote or pressed too), and only a press on its own address
   * moves it.
   */
  held?: true;
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
