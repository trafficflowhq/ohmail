/**
 * WHAT A DEVICE COPY HOLDS THAT THE SERVER DOES NOT SEND AS SUCH: the engine's message row (the
 * server's letter as a client reads it, with its own local extras), the rows of the sample world,
 * a reading stream's line, and the views a client groups folders into.
 */
import type { EmailAddress, Folder, ISODateTime, SensitivityFlags } from "./base.js";
import type { MessageStateDTO, TriageState } from "./mail.js";

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
  /**
   * THE INSTANT THE ROW SORTS BY — the server's clamp of {@link date} against the mailbox's own
   * recorded arrival (`materialize.ts#sortAtOf`, mail 0119): the header while it lies within
   * tolerance before a KNOWN arrival, else that arrival. OPTIONAL for {@link lastReadAt}'s reason:
   * absent on every row whose arrival was never recorded and on a server older than the field,
   * and absent means "the header decides" — the exact order every mirror had before. Every date
   * comparator reads `sortAt ?? date` through ONE derivation ({@link selectors.ts#tsOf}).
   */
  sortAt?: ISODateTime;
  /**
   * WHEN THE MAILBOX RECORDED THIS MESSAGE — the wire's `arrivedAt` (`messages.created_at`).
   *
   * The cutline dates a message by {@link date} ELSE this, because `Date:` is sender-written and
   * any stranger can omit it — see `consent-cutline.ts#messageMs`. OPTIONAL for
   * {@link lastReadAt}'s reason: a mirror row written before the field is `undefined`, which
   * means "no arrival recorded" and falls back to the pre-field answer rather than to an
   * invented instant. Every server this engine talks to sends it; fixture rows may leave it out.
   */
  arrivedAt?: ISODateTime;
  folder: Folder;
  snippet: string;
  unread: boolean;
  /**
   * When this message stopped being unread — STATE, the seen pill; it sorts nothing (owner ruling
   * 2026-09-18). `null` where not known, and OPTIONAL because the mirror can be older than the
   * field: `absent === null`. Fixture rows leave it absent: a demo mailbox has no reading history.
   */
  lastReadAt?: ISODateTime | null;
  /**
   * THE OPEN READ (`messages.open_read_at`): when this message was read in ohmail while its conversation was the
   * held row ({@link OhmailEngine.holdOpenRow}). "Earlier" places a row by max(arrival, this), so a
   * message opened, read and left takes the top; no other read writes it, and every unread clears
   * it. OPTIONAL for {@link lastReadAt}'s reason: `absent === null` = arrival.
   */
  openReadAt?: ISODateTime | null;
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
  /**
   * TRUE ⇒ ohmail can tell this is a meeting invitation and cannot show the
   * event: the message declares itself a calendar message and carries no
   * calendar part. The reading surface says so in one line rather than
   * rendering the sender's boilerplate as the message. Server-computed;
   * absent means "not known" and says nothing, as every older mirror did.
   */
  invitationWithoutEvent?: boolean;
  /**
   * TRUE ⇒ the message declares `method=REPLY`, on its top-level `Content-Type` or on a
   * calendar part's stored type. One arm of
   * {@link isItipAcknowledgement}, which is what holds a machine's calendar
   * acknowledgement out of a conversation's face; the other arm is the
   * subject, which this side already holds. Absent means "not known".
   */
  itipReplyHeader?: boolean;
  /**
   * What this message's own provider said about its claimed author — `messages.auth_verdict`
   * in routing's four words. Only `"fail"` changes anything: a forged `From` is a claim, never
   * a correspondent (`@trafficflow/core/sender-headers`). Absent reads as `null`, "nobody asked".
   */
  authVerdict?: "unauthenticated" | "unavailable" | "pass" | "fail" | null;
  /**
   * THE IDENTITY FACT (`MessageDTO.senderCheck`): the sender's name claims `brand` and this address
   * is not one `brand` sends from. `null` — checked, nothing found; absent — never checked, which
   * renders as nothing. The client reads it and decides nothing from a dictionary of its own.
   * `by` is which writer gave it (mail 0149), read by the held-claim term; absent from an older server.
   * `list` — the address is one a mailing list posts as (mail 0150); absent reads as not.
   * `unverified` — the address is `brand`'s own and its provider did not confirm the sender: a line
   * to read, never a claim; `unchecked` says the identity column under it was never written. There
   * `brand` may be a domain (`admin.ch`), where the address names no one brand: say it as given.
   * `held`: the gate holds the letter for want of confirmation (mail 0176), a claim to the partition
   * and the press alike, dated by its record time; beside `impersonation` it changes only the dating.
   */
  senderCheck?: {
    reason: "impersonation" | "unverified"; brand: string; domainShared: boolean; by?: "ingest" | "backfill";
    list?: boolean; unchecked?: true; held?: true;
  } | null;
  /**
   * THIS LETTER'S PLACE IS DECIDED (`MessageDTO.placeDecided`): a person placed it, or the gate
   * admitted it as an answer to the person's own writing. The partition keeps such a letter in
   * the INBOX where it is, whatever its sender's standing. Absent: no such decision is known.
   */
  placeDecided?: true;
}

/** A triage pile entry with no backing message in the demo world. */
export interface TriageItemDTO {
  id: string;
  pile: Exclude<TriageState, "none" | "muted" | "resurfaced">;
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
  /** That message's place in the pile's order (`storeInstantOf`): the line stays put when it leaves. */
  anchorAt?: ISODateTime;
  label?: string;
  meta?: string;
}

/** Views are CLIENT groupings over folders, not folders (brief §4). */
export type OhmailView = "ohbox" | "reads" | "receipts" | "screener" | "screened" | "spam";

/**
 * The five views a Screener decision may file mail INTO — every view except `screener` itself.
 *
 * `screener` is where mail is HELD, never a destination consent can choose: a promoted rule
 * pointing back at the gate would re-screen that sender for ever. The server refuses it with a
 * 400 (`screener-service.ts` — `DECIDABLE_FOLDERS`); this type is why a client cannot ask.
 */
export type ScreenDest = Exclude<OhmailView, "screener">;
