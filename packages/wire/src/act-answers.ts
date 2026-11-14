/**
 * WHAT AN ACT COMES BACK AS: carried out, recorded for the install that organizes the mailbox, or
 * (thrown, not here) refused; and what a cancelled send was told.
 */
import type { OrganizerKind } from "./mailbox-states.js";
import type { RuleDTO } from "./organizing.js";
import type { MirrorChange } from "./records.js";

export interface MutationOutcome {
  /**
   * THE ARM: the server CARRIED THIS OUT. Optional because absence has exactly one meaning —
   * applied — and every construction site that predates the queued arm is one. The queued arm
   * below states itself, and it is the only thing that can: a 202 cannot be built without the
   * holder it is waiting on, which is what makes "a request recorded, read as a move made"
   * unrepresentable rather than merely censused.
   */
  settlement?: "applied";
  /**
   * Authoritative changes to apply to the mirror right away (the §3.4
   * read-your-writes echo). Empty ⇒ the endpoint returned no seq'd DTO —
   * the engine reconciles via the next /sync drain instead.
   */
  changes: MirrorChange[];
  /**
   * `changes` carry only part of what the verb wrote, so the engine still drains after applying
   * them. Only `screener_decide` sets it: the rules are echoed, the held mail's moves are not.
   */
  partialEcho?: true;
  /** The X-Sync-Seq of the mutation (null when the endpoint does not echo one). */
  seq: number | null;
  /**
   * The server's own id for a row this mutation created, when the caller
   * must keep using it. Absent for mutations on something already named and
   * for creations whose id the caller never needs again (`tag_create` mints
   * a client-local overlay id; the server's row arrives in {@link changes}).
   * `draft_save` is the real exception: an autosaving compose must keep
   * PATCHing the same row and then send that row — one draft from first
   * keystroke to delivery. Without the id here the surface would hunt the
   * mirror for a lookalike row, the matching that sends the wrong message.
   */
  entityId?: string;
  /** The version a `draft_save` left the row at (`DraftDTO.contentRevision`), when the server said. */
  revision?: string;
  /**
   * The delivered Message-ID of a send the server confirmed sent — present
   * only on `mail_send` with status `sent` (never unverified/failed/
   * in_flight). It is the header the server minted and appended to the Sent
   * folder, so it is the exact `messageIdHeader` the real Sent copy carries
   * when the worker ingests it later. That identity lets the engine drop its
   * optimistic Sent overlay the moment a drain delivers the real row instead
   * of leaving a fabricated twin. Absent ⇒ no Sent overlay is materialised,
   * which is an older server's answer, and a Send later's.
   */
  providerMessageId?: string | null;
  /**
   * THIS SEND WAS ANSWERED FROM A RESERVATION THIS KEY ALREADY HELD — the server's statement
   * that the press delivered nothing new. Present only on `mail_send` with status `sent` and
   * only where the server names it; absence reads as the ordinary send it always was. It exists
   * because the two cases are otherwise one answer: a second press under a resumed key either
   * finds a reservation (the earlier message went) or does not (its own words go), and a 200 is
   * the same shape either way — which is how a confirmation came to name the wrong message.
   */
  firstSend?: { status: string; at: string } | null;
  /**
   * THE PRESS CHANGED THE WORDS AND THE SERVER KEPT THE EARLIER ONES — the resume's save was refused
   * because a send already holds the row (409), or an older server took it over a row past `draft`.
   * With `firstSend` it is the earlier message that went. Present only on `mail_send`, only when true.
   */
  earlierWordsKept?: boolean;
  /**
   * Where a delivered send's Sent copy stands, as the server said it: `filed`, `pending` (still being
   * retried) or `missing` (delivered, and no copy could be written). Only on a `mail_send` it delivered.
   */
  sentCopy?: "filed" | "pending" | "missing";
  /**
   * Why a `pending` or `missing` copy is not filed, when the server's answer said: the server would
   * not keep one this large, the mailbox is full, the server refused it, or could not be reached.
   */
  sentCopyReason?: "too_big" | "full" | "refused" | "unreachable";
  /** A `pending` copy kept without its uploaded files is tried until then (ISO-8601). */
  sentCopyUntil?: string;
  /**
   * The decision was accepted for somebody else to carry out — who, by
   * name. Only `screener_decide` carries it, and only where the mailbox is
   * organized by another install: the server records the decision, answers
   * 202, nothing moved and no rule was written — this is NOT a confirmation
   * the decision took effect. It travels back because a queued decision
   * emits no `change_log` row, so this is the only evidence the press
   * happened. `name` is `null` where the holder is real but unnamed — the
   * three-state shape every holder sentence renders.
   */
  pendingWith?: { name: string | null } | null;
}

/**
 * WHAT THE SERVER SAID ABOUT A CANCEL — `POST /sends/withdraw` — or why it could not be asked.
 * The first five are the server's words: `withdrawn` (nothing left under the key and nothing
 * will), `already_sent`, `unverified`, `in_flight`, `failed` (nothing left, the key spent).
 * `unsupported`: a server without the route (a 404). `unreachable`: no answer to read — the
 * network, a 5xx, a body that does not parse, a door that refused to ask. Never a throw.
 */
export type WithdrawSendOutcome =
  | "withdrawn" | "already_sent" | "unverified" | "in_flight" | "failed" | "unsupported" | "unreachable";

/**
 * THE 202 ARM — the server RECORDED the mutation for the install that organizes the mailbox and
 * did nothing else: nothing moved, no `change_log` row exists, and this answer is the only
 * evidence the press happened. A SEPARATE ARM rather than a flag on {@link MutationOutcome},
 * because read as one thing the engine settles the request as a completion and a reader's Move
 * reports "Moved" over mail that has not moved; a queued answer cannot be built without saying
 * who it waits on. `changes` is always empty and `seq` always null — nothing changed in this
 * account's store, and a seq would advance every cursor past a change that does not exist.
 */
export interface MutationQueued {
  settlement: "queued";
  /**
   * Who it is waiting on. `name: null` is a real holder without a name — the three-state shape
   * every holder sentence renders, never "nobody".
   */
  queuedWith: { name: string | null };
  /**
   * The server's `organizer_requests.id`, or `null` from a door that answers a queued state
   * without naming one. The first of {@link requestIds}.
   */
  requestId: string | null;
  /**
   * EVERY request the press made: a rule edit's 202 names none at the top and one per held mailbox
   * under `travel.pending`, and the server's list settles the press only by these. Absent from an
   * adapter that names one id at most: `requestId` alone then.
   */
  requestIds?: string[];
  changes: MirrorChange[];
  seq: null;
}

/**
 * What a mutation comes back as. Two arms RETURN; the third — refused — is the thrown
 * {@link MutationRejectedError}, which is a typed channel of its own with the server's code and
 * sentence on it, and which the engine turns into `rolled_back` at one place. Three answers, one
 * vocabulary: applied, queued, refused.
 */
export type MutationAnswer = MutationOutcome | MutationQueued;

// ── the 202 arm, as it travels ──────────────────────────────────────────────

/**
 * Who organizes a mailbox this install only reads, as an answer names them. `name: null` is a
 * real holder without a name, never "nobody". `ref` is an opaque reference on one refusal only.
 */
export interface HolderWire {
  kind: OrganizerKind | null;
  name: string | null;
  since: string | null;
  ref?: string | null;
}

/**
 * A PRESS THAT BECAME A REQUEST — the body of a 202. This install reads the mailbox, another
 * organizes it, and the press now waits on that install: nothing moved here, no change was
 * written, and this answer is the only evidence the press happened. `pending: true` is what
 * every route switches its status on.
 */
export interface QueuedAnswer {
  pending: true;
  /** The request's id, which the record sent to the organizer carries too. */
  requestId: string;
  /** Who this is waiting on, so the sentence names a machine rather than "another install". */
  holder: HolderWire;
}

/**
 * WHERE ONE RULE EDIT WENT, MAILBOX BY MAILBOX. A rule belongs to the account and an account may
 * hold several mailboxes with different roles, so one press is a local write for the mailboxes
 * this install organizes AND a request to each install holding one of the others.
 */
export interface RuleTravel {
  /** Mailboxes this install organizes — the local row IS their rule. */
  appliedLocally: string[];
  /** One request per held mailbox whose holder takes rule requests. */
  pending: Array<{ mailboxId: string; requestId: string; holder: HolderWire }>;
  /** Held by an install that will not take a rule request, and why. */
  refused: Array<{ mailboxId: string; holder: HolderWire; reason: string }>;
}

/**
 * A RULE EDIT THAT WROTE NOTHING HERE — every live mailbox is organized by another install. `rule`
 * is the UNCHANGED local row on an update or a delete, and absent on a create, where no row
 * exists here until every holder the press went to has applied it.
 */
export interface RuleQueuedAnswer {
  pending: true;
  travel: RuleTravel;
  rule?: RuleDTO;
}
