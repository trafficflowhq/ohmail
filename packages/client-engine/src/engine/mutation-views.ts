import type { CreatedDraftRow } from "../adapters/adapter.js";
import { OUTBOX_WITHDRAWN_CODE } from "../adapters/refusal-shape.js";
import type { SendAndDonePlan } from "../send-and-done.js";
import type {
  EngineMutation, ISODateTime, MutationRejectedError, RuleDTO, RuleKeyAddress, WaitingTargetWire,
} from "../types.js";
import type { PersistedOutboxEntry } from "./outbox-record.js";

/**
 * `queued` and `awaiting_organizer` are two different waits and must never be collapsed:
 * `queued` is THIS client's retry queue (the wire failed, the intent stands under its
 * Idempotency-Key, a drive will send it again), `awaiting_organizer` is the SERVER's — the
 * request is recorded and the install that organizes the mailbox will carry it out, so nothing
 * here retries and nothing here may report it done. `superseded` is a verb a newer verb for the same
 * field replaced on the wire, or the server refused as stale behind a newer decision (`stale_press`);
 * the newer press owns the sentence and this one says nothing. A send re-pressed under its key is the
 * same case (a confirmation waits with the newer press, see `oneSpeaker`).
 */
/** Ids per `GET /screener/stayed` — the route's own ceiling (`WHY_STAYED_IDS_MAX`). */
export const WHY_STAYED_PAGE = 100;

export type MutationStatus = "confirmed" | "queued" | "awaiting_organizer" | "rolled_back" | "superseded";

/** The server's refusal of a press replayed after the field it sets was decided elsewhere. */
export const STALE_PRESS_CODE = "stale_press";

/** The Ohbox's folder, as the mirror's messages name it. */
const OHBOX_FOLDER = "INBOX";
/** Ohbox mail coming in re-asks the undecided-sender offer at most this often. */
export const UNSCREENED_REASK_MS = 30_000;

/**
 * WHAT A WITHDRAWAL FOUND — {@link OhmailEngine.withdrawQueued}'s answer. `withdrawn` is the
 * cancellation: nothing was on the wire and nothing will be. `on_the_wire` withdraws nothing —
 * the request has gone and only the server knows what it did with it. `gone` is neither: the
 * queue no longer holds the key, so whatever became of it has already been settled elsewhere.
 * `unknown`: the disk did not take or did not answer the Cancel, so nothing was cancelled and
 * nothing is released; pressing again asks again. Only where windows share the disk.
 */
export type WithdrawOutcome = "withdrawn" | "on_the_wire" | "gone" | "unknown";

/** The withdrawn ending's code — see `adapters/refusal-shape.ts`, where the adapter reads it too. */
export { OUTBOX_WITHDRAWN_CODE };

/**
 * A QUEUED EDIT KEPT AS A NEW DRAFT: refused `draft_changed` (the row moved elsewhere while it waited),
 * nobody reading the refusal, so its words were re-issued as a create. `key` is the edit's own,
 * `from` the row it was for, `row` the new draft once the server made it (`null` before).
 */
export interface KeptAsNewDraft { key: string; from: string; row: string | null; revision?: string }

export interface MutationResult {
  id: string;
  /** The Idempotency-Key used on the wire — stable across retries. */
  key: string;
  status: MutationStatus;
  seq: number | null;
  /** A confirmed `draft_save`'s version of the row ({@link MutationOutcome.revision}). */
  revision?: string;
  error?: MutationRejectedError;
  /**
   * The server's id for a row this mutation created — see
   * {@link MutationOutcome.entityId}. Present where the caller must keep
   * using it: `draft_save`'s confirmed CREATE (the compose surface adopts
   * it, PATCHes it and sends that row), and a QUEUED send — nothing adopts
   * that one, but the durable send record has to name it or a reload cannot
   * tell the row in Drafts is the message it is waiting on. A rolled-back
   * result carries it too when the refusal knows the row — see
   * {@link MutationRejectedError.entityId} (an `unverified` send's row, a withdrawn one's).
   */
  entityId?: string;
  /**
   * THE DECISION WAS ACCEPTED FOR ANOTHER INSTALL TO CARRY OUT — see
   * {@link MutationOutcome.pendingWith}.
   *
   * Present only on a confirmed `screener_decide` against a mailbox somebody else organizes, and
   * it is the ONLY evidence such a press ever produces: nothing moved, so no delta describes it,
   * and the overlay that made the row look filed is dropped the moment the mutation confirms. A
   * caller that ignores this shows the press undoing itself a second later.
   */
  pendingWith?: { name: string | null } | null;
  /**
   * THE SEND WAS ANSWERED FROM AN EARLIER RESERVATION — see {@link MutationOutcome.firstSend}.
   *
   * On the CONFIRMED result, because the mutation genuinely succeeded; what it qualifies is
   * WHICH message the confirmation is about. A surface that ignores it says "sent" about a
   * press that delivered nothing new, which is true of the mail and false of the words on
   * screen when the two have come apart.
   */
  firstSend?: { status: string; at: string };
  /** The press's newer words were kept back — see {@link MutationOutcome.earlierWordsKept}. */
  earlierWordsKept?: true;
  /** Where a delivered send's Sent copy stands — see {@link MutationOutcome.sentCopy}. */
  sentCopy?: "filed" | "pending" | "missing";
  /** Why it is not filed — see {@link MutationOutcome.sentCopyReason}. */
  sentCopyReason?: "too_big" | "full" | "refused" | "unreachable";
  /** Until when it is tried — see {@link MutationOutcome.sentCopyUntil}. */
  sentCopyUntil?: string;
  /**
   * WHO THE SERVER RECORDED THIS FOR — present on `awaiting_organizer` and nowhere else. The
   * mutation reached the wire and the wire took it; what has NOT happened is the act. The
   * surface says "Queued for the organizer" from this, and `pendingWith` carries the same fact
   * under the name the Screener's standing reader already knows.
   */
  queuedWith?: { name: string | null };
  /** The server's `organizer_requests.id` for a queued mutation, where the door named one. */
  requestId?: string;
  /**
   * THE SERVER ANSWERED THIS VERB WITH A FAILURE and it waits to be asked again — on a `queued`
   * result only, by the test that spends the give-up ceiling ({@link OhmailEngine.serverAnswered}).
   * Absent on a queued verb that never reached an answer: that one is offline or unreachable.
   */
  serverFailed?: true;
  /**
   * THE SEND + DONE INTENT this send was pressed with — on its CONFIRMED result only, from the
   * send's own outbox row. A later boot's replay hands it back too, so whichever surface collects
   * the confirmation reads the release then (`releasePlanAt`); the intent itself is never applied.
   */
  andDone?: SendAndDonePlan;
}

/** One rule verb waiting on this client's queue — see {@link OhmailEngine.queuedRuleWrites}. */
export interface QueuedRuleWrite {
  id: string;
  verb: "revoke" | "retarget";
  ruleId: string;
  /** The rule as the mirror holds it, without any overlay; absent when the mirror has none. */
  rule: RuleDTO | undefined;
  serverFailed: boolean;
}

/**
 * A mutation the SERVER queued for the install that organizes the mailbox, as a surface reads it.
 * It is not on any retry queue here: nothing this client does moves it, and only a change
 * arriving through /sync settles it.
 */
/** One row of {@link OhmailEngine.appliedRuleRequests}: a rule request the organizer applied. */
export interface AppliedRuleRequest {
  requestId: string;
  kind: string;
  mailboxId: string;
  decidedAt: ISODateTime;
  resolvedAt: ISODateTime | null;
  target: WaitingTargetWire;
}

/** One row of {@link OhmailEngine.unsettledRulePresses}: a rule press of this install not applied yet. */
export interface UnsettledRulePress {
  key: RuleKeyAddress;
  kind: "rule.create" | "rule.update" | "rule.delete";
  /** The place an update or a create asked for; `null` for a removal. */
  destination: string | null;
}

/** One row of {@link OhmailEngine.waitingOnOrganizer} — what a surface lists as waiting. */
export interface WaitingOnOrganizerView {
  /** The server's request id, or `null` for a request this session holds that names none. */
  requestId: string | null;
  /** The request kind (`rule.delete`, `message.move`, …). */
  kind: string;
  state: "pending" | "sent" | "refused";
  holder: { name: string | null };
  /** The mailbox the request went to, where the server named it. */
  mailboxId: string | null;
  decidedAt: ISODateTime;
  /** Why the organizer said no — only on `refused`. */
  refusedReason: string | null;
  target: WaitingTargetWire;
  /** The mirror's rule the request names, by key, or `null`. */
  ruleId: string | null;
  messageId: string | null;
  /** Past {@link ORGANIZER_REQUEST_SLOW_MS} and still in flight. */
  slow: boolean;
}

export interface OrganizerRequestView {
  id: string;
  key: string;
  kind: EngineMutation["kind"];
  /** The message the verb names, or `null` for a verb that names something else. */
  messageId: string | null;
  queuedWith: { name: string | null };
  requestId: string | null;
  /** When the press was recorded. */
  at: ISODateTime;
  /**
   * Past {@link ORGANIZER_REQUEST_SLOW_MS}. The surface says "Still waiting for the organizer"
   * and the request STAYS PENDING — the bound changes the sentence, never the belief.
   */
  slow: boolean;
}

/** What one supersession changed, and everything needed to put it back. */
/**
 * One abandoned record a newer verb would mark — PLANNED, never written here.
 *
 * `durable` says which half of {@link OhmailEngine.abandonedRows} it came from: a disk row rides
 * the replacement's own transaction, a session-local fallback is a memory write made only once
 * that transaction has landed. Either way nothing is marked on behalf of a replacement that was
 * refused, which is the property the old write-then-roll-back shape could not hold.
 */
interface AbandonedMark {
  id: string;
  entry: PersistedOutboxEntry;
  durable: boolean;
}

interface SupersedeEffect {
  retired: string[];
  /**
   * Queued rows this verb narrowed rather than retired, re-written in the
   * replacement's own transaction. They were once persisted by a separate
   * best-effort `putOutbox` per row — outside the replacement transaction,
   * outside `retired`, invisible to the no-write-no-wire rule — leaving two
   * windows: the narrowing lands and the replacement does not (disk keeps
   * only the narrowed intent), or the reverse (the full stale read is
   * replayed once the replacement is deleted).
   */
  narrowed: PendingMutation[];
  /** Everything this call changed, kept so a refused replacement can put it all back. */
  undo: Array<{ entry: PendingMutation; index: number; mutation: EngineMutation }>;
  /** A retired same-key send had a create out whose answer was unreadable — the newer verb carries it. */
  createAttempted?: true;
  /** A retired same-key send had made its row — the newer verb sends that row, as this session would. */
  createdRow?: CreatedDraftRow;
  /**
   * Requests on the wire this call marked superseded — see
   * {@link PendingMutation.supersededBy}. The mark is made BEFORE
   * persistence and undone on refusal, not deferred: the write is awaited,
   * and before it returns the older request can answer retryably and
   * re-queue itself — neither half would retire it, and the older verb
   * replays over the newer intent with no storage failure needed. Marking
   * before has one bad case — a refusal — where dropping the older verb
   * loses the only expressed intent, so the mark is part of the rollback.
   */
  markedInFlight: PendingMutation[];
  /** The reads on their way to the wire or on it whose ids this call took — {@link PendingMutation.readsTaken}. */
  takenOnWire: Array<{ entry: PendingMutation; by: string }>;
}

interface PendingMutation {
  id: string;
  key: string;
  mutation: EngineMutation;
  /** This engine's claim on the row for the attempt in flight — see {@link OhmailEngine.claimForSend}. */
  sending?: string;
  /**
   * The durable entry's order stamp — minted ONCE, at `mutate()`, and carried through every
   * re-persist so a retry can never re-order the queue: replay order is user order, which is
   * what lets a `draft_save` always precede the `mail_send` that names its row.
   */
  at: number;
  n: number;
  /**
   * TRUE only for an entry restored from a PREVIOUS session. It decides who may replay the
   * verb: a restored entry's owner died with its session, so the drive replays it freely and
   * consumes the result — there is no one left to notify. A SAME-SESSION entry is replayed by
   * the drive only when no living surface routes its result; the two families a surface does
   * wait on stay with `flushPending()` — see {@link OhmailEngine.ownerSettled}.
   */
  restored?: boolean;
  /**
   * Rows this verb SUPERSEDES and has not yet managed to retire.
   *
   * Carried on the verb rather than passed once, because the first write is not the only write: a
   * retryable failure re-asserts the durable entry, and a re-assert that omitted these left the
   * newer row on disk beside the stale one it was supposed to replace — the next boot then
   * replays the stale verb over newer state, with the newer verb's own row sitting beside it.
   * Cleared only by a commit that actually carried them.
   */
  retire?: string[];
  /**
   * THE NEWER VERB, by entry id, expressed for the same target while this one was on the wire.
   *
   * It cannot be un-sent, but it must not be replayed over the state the newer verb establishes.
   * The mark is tentative until that verb's durable write decides: a retryable answer waits for
   * the decision ({@link replacementDecided}), and a refused write takes the mark back.
   */
  supersededBy?: string;
  /**
   * A PERSON'S READS AND UNREADS, by entry id, that named this read's ids while it was on
   * its way to the wire or on it — {@link supersededBy} for the read verbs, which carry no key. The
   * request cannot be narrowed in the air, so each is kept and applied by the queue's own rule
   * ({@link readLeftBy}) before this read is sent or sent again: only the ids none of them names go.
   * Tentative, like the mark, until that verb's write has decided.
   */
  readsTaken?: Map<string, EngineMutation>;
  /**
   * TRUE once a non-idempotent CREATE went out under this key and its answer could not be read.
   *
   * The adapter remembers it too, and that memory dies with the adapter — a reload replays the
   * entry through a fresh one and `POST /drafts`, which ignores the key, writes a SECOND row. So
   * it is carried on the verb and persisted with it, and handed back on every later attempt.
   */
  createAttempted?: boolean;
  /**
   * The draft row this send's create made, reported before the send request went. A reload's
   * adapter is handed it back, so the replay sends that row rather than creating another.
   */
  createdRow?: CreatedDraftRow;
  /** The Web Lock of the engine that holds this verb — see {@link OhmailEngine.adoptOrphanedOutbox}. */
  owner?: string;
  /** The Send + Done intent — see {@link MutationResult.andDone}. Persisted with the row. */
  andDone?: SendAndDonePlan;
  /** The intent was handed over on a confirmation — see {@link PersistedOutboxEntry.released}. */
  released?: true;
  /** A send the server confirmed, kept only for its echo — see {@link PersistedOutboxEntry.confirmed}. */
  confirmed?: true;
  /** This disk may have put the send on the wire — see {@link PersistedOutboxEntry.wired}. Never cleared. */
  wired?: true;
  /** A Cancel the server has not answered yet — see {@link PersistedOutboxEntry.withdrawOwed}. */
  withdrawOwed?: true;
  /** Its caller was answered `queued`: nobody reads its ending, so a refusal has to speak for itself. */
  told?: true;
  /** Server-answered failures so far. See {@link OUTBOX_MAX_SERVER_FAILURES} for what counts. */
  attempts?: number;
  /** Epoch ms before which no drive may dispatch this verb. */
  nextAt?: number;
  /**
   * TRUE when `nextAt` came from the SERVER's `Retry-After` rather than this client's backoff.
   *
   * The two waits are not the same kind of thing and must not be honoured the same way. Ours is
   * pacing, and an explicit "try now" — a person pressing Try again, a host flushing after a
   * connection returns — may override it. The server's is an instruction, and overriding it turns
   * a considerate client into the thing the header exists to prevent: `flushPending` ignored
   * `nextAt` entirely, so a mobile app that flushes after every successful sync would retry a
   * one-hour `Retry-After` every few minutes, for ever, while spending none of the ceiling.
   */
  waitIsServerNamed?: boolean;
  /** The last server sentence, carried so an abandoned verb can quote it. */
  lastError?: { message: string; code: string | null; status: number | null };
}

export {
  type AbandonedMark, OHBOX_FOLDER, type PendingMutation, type SupersedeEffect,
};
