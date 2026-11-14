/**
 * WHAT THE SCREENER'S READS AND PRESSES ANSWER (`…Wire`), and the rows a device copy keeps of
 * those answers (`…DTO`): mail held behind a rule, senders nobody decided about, the waiting
 * queue, what ohmail filed on its own, and the requests sent to the install that organizes.
 */
import type { HolderWire } from "./act-answers.js";
import type { Folder, ISODateTime } from "./base.js";
import type { RuleDTO } from "./organizing.js";

/**
 * One group on the release screen: the rule, and how much of its mail is stuck at the gate — or,
 * with `sender` set, a CONTACT nobody wrote a rule for (row id `sender:<address>`, `kind`
 * "sender", `match` the address, `destination` the Ohbox), which the press names in `senders`.
 */
export interface HeldReleaseGroupDTO {
  /** The rule's id — this row's own id, and what `releaseHeld` names. */
  id: string;
  /** Set on a contact-only sender's line: the address the press names. Absent on a rule's group. */
  sender?: string;
  kind: "sender" | "domain";
  /** The address, or the domain, the rule matches — lower-cased as stored. */
  match: string;
  /** Where the rule would file it. Named beside the count so a press is never a surprise. */
  destination: Folder;
  /** Held messages this rule would reach. NEVER summed across groups — see {@link heldReleaseTotalOf}. */
  count: number;
  /**
   * DISTINCT messages across EVERY group, carried on each row because the mirror stores rows and
   * not a document. One message can sit in two groups (a domain rule and a sender rule inside it
   * both claim it), so the headline number is this, never the sum. Identical on every row of one
   * refresh; a stale row is replaced wholesale, never merged.
   */
  total: number;
  /**
   * The whole SET's identity and its dismissal state, carried on each row for `total`'s reason.
   * `fingerprint` is what a "not now" press names; `dismissed` true means the account already
   * said it to exactly this set, so no surface offers the row. "" / false from an older server.
   */
  fingerprint: string;
  dismissed: boolean;
}

/** One group on the undecided-sender screen: who wrote, how much, and how recent. */
export interface UnscreenedGroupDTO {
  /** The sender's address, lower-cased — this row's own id, and what the press names. */
  id: string;
  count: number;
  /** The newest of the group's messages, ISO, or "" from a server that does not send one. */
  newestAt: string;
  /**
   * Messages across EVERY shown group, carried on each row because the mirror stores rows and not
   * a document. Identical on every row of one refresh; a stale row is replaced wholesale.
   */
  total: number;
  /** False when `total` is a floor (the server's walk stopped at its bound); carried like `total`. */
  complete?: boolean;
}

export type ScreenerWaitingDTO = ScreenerWaitingPageDTO | ScreenerWaitingSenderDTO;

export interface ScreenerWaitingPageDTO {
  /** The id of the one `page` row; every sender row's id is `sender:` plus its key. */
  id: "page";
  kind: "page";
  /** Waiting senders across every page — the store's own count. */
  total: number;
  /** Where the next page starts, or null when this page is the whole queue. */
  nextCursor: string | null;
  /** The subjects of decisions the server is still carrying out, which it leaves off every page. */
  inFlight: Array<{ scope: "sender" | "domain"; match: string }>;
  /**
   * The mailboxes the queue leaves out, sorted (`ScreenerWaitingWire.gone`): the partition presents
   * their mail itself. Absent from an older server's answer, whose page lists their senders.
   */
  gone?: string[];
  /**
   * The copy this page was read beside was still taking in the account (`ScreenerWaitingWire`), or
   * this window has not yet settled a drain begun after the door said it had caught up.
   */
  copyBehind?: true;
  /** Which ask wrote this answer — rises with every refresh, so a reader can tell a newer one. */
  ask: number;
  /**
   * How many sender rows this answer wrote. A decision's overlay hides its sender's row, and the
   * count on screen drops by the rows hidden, until the next answer states the store's own again.
   */
  rows: number;
  /**
   * How far a walk of the pages after this one has read (`screenerWaitingPage`): the senders
   * those pages listed, the last row's instant, and where the next page starts — null once the
   * walk reached the queue's end. Absent until a walk from this page; a new answer drops it.
   */
  walked?: { edge: string; listed: string[]; nextCursor: string | null };
}

export interface ScreenerWaitingSenderDTO {
  id: string;
  kind: "sender";
  /** The position on the page, from 0. */
  order: number;
  /** The representative held message — the id `POST /screener/:id` resolves. */
  messageId: string;
  address: string;
  name: string | null;
  /** The representative's instant, ISO, or "" from a row that carried none. */
  receivedAt: string;
  subject: string;
  snippet: string;
  mailboxId: string | null;
  /** The page's `total`, on every row for {@link HeldReleaseGroupDTO.total}'s reason. */
  total: number;
  /** A held letter of this sender claims a company (the page's `checked`): another address's press keeps them waiting. */
  marked?: true;
  /** A screen-out of this sender files its claims alone and writes no rule (the page's `checked.claimsOnly`, mail 0150). */
  claimsOnly?: true;
}

/**
 * ONE ROW OF `GET /organizer-requests` — a request this door sent the install that organizes a
 * mailbox, still in flight or resolved within a day. The target is the server's projection per
 * kind; the stored payload never travels.
 */
export interface WaitingRequestWire {
  id: string;
  kind: string;
  state: "pending" | "sent" | "applied" | "expired" | "refused";
  mailboxId: string;
  holder: { name: string | null };
  decidedAt: ISODateTime;
  resolvedAt: ISODateTime | null;
  refusedReason: string | null;
  target: WaitingTargetWire;
}

export type WaitingTargetWire =
  | {
    rule: { kind: string; match: string; subjectContains: string | null; bodyContains: string | null };
    destination?: string;
  }
  | { messageId: string | null; folder: string | null }
  | { scope: string; match: string }
  | { fields: string[] }
  | { unknown: true };

/** One group as `GET /screener/held-releases` sends it. */
export interface HeldReleaseGroupWire {
  ruleId: string;
  kind: "sender" | "domain";
  match: string;
  destination: string;
  count: number;
}

/** A contact nobody wrote a rule for, whose mail is held at the gate: the address and the count. */
export interface HeldReleaseSenderWire {
  /** The address, lower-cased — this line's key, and what a press names in `senders`. */
  sender: string;
  count: number;
}

/** Why a message stayed when its sender's rule moved the rest (`GET /screener/stayed`). */
export type StayedWhy = "failed-checks" | "set-aside" | "replied" | "filed-elsewhere";

export interface StayedWire { id: string; why: StayedWhy }

/** One letter ohmail filed out of the Screener on its own and that is still where it put it. */
export interface AutoFiledItemWire {
  messageId: string;
  from: string | null;
  subject: string | null;
  /** The pile it was filed to. */
  to: string;
  /** When, ISO. */
  filedAt: string;
  /** `impersonation`: it claimed a company it cannot be from, and was filed to Spam with no AI. */
  why: "impersonation" | null;
  /** The company it claimed, beside `impersonation`. */
  brand: string | null;
}

/** `GET /screener/auto-filed`'s answer: the newest filings still in place, and whether more are behind them. */
export interface AutoFiledWire { items: AutoFiledItemWire[]; more: boolean }

/** Put back's answer: put back here, or sent to the install that organizes the mailbox. */
export interface AutoFiledUndoWire { putBack: string[]; requested: string[] }

/** The read's answer: the groups, the DISTINCT message total, and the server's own group ceiling. */
export interface HeldReleaseWire {
  groups: HeldReleaseGroupWire[];
  /**
   * Contact-only senders, one line each. Their mail is claimed by no rule, so it is OUTSIDE
   * `total`, which stays the rule groups' figure. Absent from an older server: none offered.
   */
  senders?: HeldReleaseSenderWire[];
  /** Distinct messages across every group — never the sum of the counts. */
  total: number;
  /** How many groups one press may name. Read rather than hardcoded, so the client cannot drift. */
  max: number;
  /** This set's identity — what a dismissal names. Absent/"" from a server that predates it. */
  fingerprint?: string;
  /** The account already said "not now" to exactly this set. Absent/false from an older server. */
  dismissed?: boolean;
}

/** The press's answer: the groups it released and the distinct messages they held. */
export interface HeldReleaseResultWire {
  released: HeldReleaseGroupWire[];
  /** The contact-only senders the press decided into the Ohbox. Absent from an older server. */
  releasedSenders?: HeldReleaseSenderWire[];
  /** Distinct messages across the released groups AND senders. */
  total: number;
}

/** One sender group as `GET /screener/unscreened` sends it. */
export interface UnscreenedGroupWire {
  /** The sender's address, lower-cased — this group's key, and what a press names. */
  address: string;
  count: number;
  /** The newest of the group's messages, ISO. */
  newestAt: string;
}

/** A pile whose letters can come from senders nobody let in, asked by its note. */
export type UnscreenedPileWire = "news" | "receipts";

/** The read's answer: the groups, the messages they hold, and the server's own group ceiling. */
export interface UnscreenedWire {
  groups: UnscreenedGroupWire[];
  /** Messages the SHOWN groups hold. Every message has one sender, so these do add up. */
  total: number;
  /** False when the server's walk stopped at its bound: `total` is then a floor. Absent: an older server, read as whole. */
  complete?: boolean;
  /** How many groups one press may name. Read rather than hardcoded, so the client cannot drift. */
  max: number;
  /** The pile the answer is about, said back; absent from the Ohbox's offer and from a server before piles. */
  pile?: UnscreenedPileWire;
}

/** One waiting sender as `GET /screener` lists it: the representative held message and its author. */
export interface ScreenerWaitingItemWire {
  messageId: string;
  address: string;
  name: string | null;
  receivedAt: string;
  subject: string;
  snippet: string;
  mailboxId: string | null;
  /** The page's `checked`: a held letter of this sender claims a company its address is not, or is `held`. */
  marked?: true;
  /** The page's `checked.claimsOnly`: a screen-out of this sender files its claims alone and writes no rule (mail 0150). */
  claimsOnly?: true;
}

/** One page of the queue. `total` is stated on the first page only; `null` where none was. */
export interface ScreenerWaitingWire {
  items: ScreenerWaitingItemWire[];
  nextCursor: string | null;
  total: number | null;
  /** Decisions the server is still carrying out; their senders are on no page. */
  inFlight: Array<{ scope: "sender" | "domain"; match: string }>;
  /** The route's `pendingDecisions` as sent, refused ones included, for a surface that says what became of them. */
  pendingDecisions?: unknown[];
  /**
   * The door's own copy is still taking in the account (a mirror mid-bootstrap), so this page is
   * ahead of the mail and rules it is read beside. Absent everywhere else.
   */
  copyBehind?: true;
  /**
   * The mailboxes the queue leaves out (removed with the copy kept, or erased), sorted: their mail
   * makes nobody waiting, so the page's silence says nothing about it. Absent from an older server,
   * whose page lists their senders as before.
   */
  gone?: string[];
}

/** The press's answer: the groups it screened and how many messages they held. */
export interface UnscreenedResultWire {
  screened: UnscreenedGroupWire[];
  total: number;
}

// ── a decision, as `POST /screener/:id` answers it ──────────────────────────

/** One queued half of an account-wide decision — which mailbox waits, on whom, under which request. */
export interface ScreenRequestedMailbox {
  mailboxId: string;
  requestId: string;
  holder: HolderWire;
}

/**
 * WHERE AN ACCOUNT-WIDE DECISION LANDED, PER MAILBOX (0.20). `filed` re-routed now; `requested`
 * queued on the request road for the named install. A mailbox in neither list either held nothing
 * from this sender or is held by an install that cannot take requests — those rows stay visibly
 * held, which is the truthful rendering. Optional on the wire: an older server omits it.
 */
export interface ScreenDecisionMailboxes {
  filed: string[];
  requested: ScreenRequestedMailbox[];
  /**
   * Mailboxes this install was asked to organize and does not yet: the rule is written, the held
   * mail moves on the first organizing pass after the claim lands. Absent when there are none.
   */
  awaiting?: string[];
}

export interface ScreenDecisionResult {
  messageId: string;
  appliedFolder: Folder;
  createdRuleId: string | null;
  /**
   * The rules this decision wrote, as `/sync` carries them: the promoted rule, and every twin it
   * retargeted. A client whose drain lags the server holds the decision from the confirm on, as
   * `POST /rules` has always answered with its rule. Absent from an older server.
   */
  createdRule?: RuleDTO | null;
  retargetedRules?: RuleDTO[];
  /** See {@link ScreenDecisionMailboxes}. Absent from an older server; never absent from this one. */
  mailboxes?: ScreenDecisionMailboxes;
  /**
   * WHAT THIS REQUEST'S UNSUBSCRIBE FAN-OUT DID, and what it left: `done` of `of` is the honest
   * half of a per-request ceiling, since the hourly drain finishes the rest.
   *
   * ABSENT MEANS THIS REQUEST STARTED NO FAN-OUT — a "yes", a deployment with no unsubscribe
   * port, a decision that re-routed nothing, or an IDEMPOTENT REPLAY, served from the stored row
   * before `decide` runs and therefore posting to nobody. It never means the fan-out finished.
   */
  unsubscribed?: { done: number; of: number };
}

/**
 * `POST /screener/:id`'s OTHER shape (0.14.1) — a reader's decision, accepted but not
 * yet applied. `202`, never `200`: "Rule saved" is never claimed before the organizer's own pass
 * actually applies it (the ruling's own words). `holder` is who the client names in "Decided —
 * <holder> files it on its next pass."
 */
export interface ScreenRequestResult {
  pending: true;
  requestId: string;
  holder: HolderWire;
  /**
   * The account-wide picture (0.20): `filed` is always empty on this shape (nothing was written
   * here), and `requested` names EVERY queued mailbox — the primary `requestId`/`holder` above
   * stay what they always were, the TARGET mailbox's, so an older client reads them unchanged.
   * Where a screen-out filed a list's claims alone they are the target's move, else the first.
   */
  mailboxes?: ScreenDecisionMailboxes;
}

/** One entry of {@link ScreenerPage.pendingDecisions}. */
export interface ScreenerPendingDecision {
  /** The address (sender scope) or the domain (domain scope) the decision covers, lower-cased. */
  subject: string;
  scope: "sender" | "domain";
  decidedAt: string;
  /**
   * Has this install's own cycle appended it to the mailbox yet?
   *
   * KEPT ALONGSIDE {@link state} rather than replaced by it: a client written against the 0.14.1
   * shape reads this field, and `state === "sent"` is exactly what it always meant. Renaming it
   * would have been a wire break for a rename's worth of benefit.
   */
  sent: boolean;
  /**
   * WHERE THE DECISION ACTUALLY IS (mail 0090). `pending` — queued here, not yet handed to the
   * mailbox. `sent` — in the mailbox, waiting for the organizer. `refused` — the organizer said
   * no; THE SENDER IS BACK IN THE QUEUE, and this entry explains why the decision did not take
   * effect. `applied` and `expired` never appear: the first needs no explaining, the second
   * returns the sender to the queue with the ordinary "nobody is organizing this" notice.
   */
  state: "pending" | "sent" | "refused";
  /**
   * What the organizer said no to — a closed vocabulary this codebase defines (`unauthenticated`,
   * `conflict`, `wrong_mailbox`, `invalid_payload`, `unhandled_kind`, `stale`, `account_erased`),
   * never free text and never a stranger's. `null` outside `refused`, and also for a refusal whose
   * named reason this build does not recognise — a newer organizer's vocabulary reaches an older
   * reader as "refused, reason unknown" rather than as an unrendered string.
   */
  refusedReason: string | null;
}
