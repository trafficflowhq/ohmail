import type { CreatedDraftRow } from "../adapters/adapter.js";
import { OUTBOX_WITHDRAWN_CODE } from "../adapters/refusal-shape.js";
import { narrowRead } from "../mark-seen-chunk.js";
import { asSendAndDoneIntent, type SendAndDonePlan } from "../send-and-done.js";
import { OUTBOX_PROTOCOL } from "../store.js";
import { type EngineMutation, MutationRejectedError } from "../types.js";
import type { MutationResult, PendingMutation, WithdrawOutcome } from "./mutation-views.js";
import { OUTBOX_UNKEYED_CREATE_TTL_MS } from "./options.js";

/**
 * THE DURABLE OUTBOX'S RECORD TYPE — a client-local record (`putLocal`, seq 0), one per
 * user verb, written the moment the verb is expressed and removed on its terminal outcome
 * (server confirmation or explicit refusal). `/sync` has no vocabulary for it, so no delta
 * can ever contradict or delete one; the windowed prune only ever evicts `message` rows, so
 * a policy pass cannot either. The mirror's persistence engine is what makes it durable —
 * IndexedDB on the webapp, sqlite on mobile, whatever `MirrorStore` a future surface binds
 * (INSTANT-ARCH §6.2 stage 1: the intent is durable the moment it is expressed).
 */
export { OUTBOX_TYPE } from "../types.js";

/**
 * THE PERSISTED OUTBOX SHAPE THIS BUILD WRITES. Exported so a guard can say "one past current"
 * instead of a literal.
 *
 * A test needed a version "from the future" to prove an unknown shape is left alone rather than
 * replayed, and it spelled that as a number. The number became current TWICE — at `v: 2` and again
 * at `v: 3` — and each time the guard silently inverted into asserting that the CURRENT shape is
 * unrecognised, which is the opposite of its claim. Deriving from here it cannot happen a third
 * time.
 */
export const OUTBOX_ENTRY_VERSION = 3;

/**
 * Where an abandoned verb goes — a client-local record like
 * {@link OUTBOX_TYPE}, holding a verb the server refused
 * {@link OUTBOX_MAX_SERVER_FAILURES} times in a way nobody modelled. A
 * separate type, not a flag: everything in `OUTBOX_TYPE` is replayed, and
 * moving the record makes the replay set correct by construction.
 * `putLocal` at seq 0, so the windowed prune cannot take it and no `/sync`
 * delta contradicts it: a failed verb is the user's work, and worse than a
 * queue that hammers forever is one that silently drops what it gave up on.
 */
export { OUTBOX_ABANDONED_TYPE } from "../types.js";

/**
 * One persisted verb. `v` names the shape so a future build migrates rather
 * than guesses; an unrecognised entry is left in place, not replayed. `key`
 * is the Idempotency-Key of the ORIGINAL attempt, so a replay after a
 * restart is the same request the server may have seen (`idempotency_keys`
 * replays stored responses; `outbound_sends` is UNIQUE on
 * `(accountId, idempotencyKey)`; state verbs are absolute PATCHes).
 * `(at, n)` restore queue order: iteration after a load is storage-key
 * order, and a `draft_save` replays before the `mail_send` naming its row.
 */
interface PersistedOutboxEntry {
  /**
   * `3` since the record lifecycle was made failure-atomic. **`v: 1` and `v: 2` are still accepted
   * and still replay** — see {@link isPersistedOutboxEntry}, where the migration is the whole point: this
   * shape is written the moment a verb is expressed and read back after an upgrade, so a gate that
   * demanded `v === 2` would silently orphan every verb queued by the previous build. The user's
   * unsent mail would be on disk, valid, and never looked at again.
   */
  v: 1 | 2 | 3;
  id: string;
  key: string;
  /** Session-monotonic tiebreak within one `at` millisecond. */
  n: number;
  /** Epoch ms at enqueue, from the engine's injected clock. */
  at: number;
  mutation: EngineMutation;
  /**
   * SERVER-ANSWERED failures so far — not attempts. Absent on a `v: 1` record and read as 0, which
   * is the honest value: that build counted nothing, so nothing is known to have failed, and the
   * verb gets a full ceiling's patience under the new rule rather than being retired on arrival.
   *
   * Persisted rather than kept in memory because the bound has to survive a restart. A counter that
   * resets on boot is not a bound at all — it turns "give up after eight" into "give up after eight
   * consecutive tries without a restart", which for a poisoned verb on a laptop that sleeps is
   * indistinguishable from forever.
   */
  attempts?: number;
  /** Epoch ms before which no drive may dispatch this verb. Absent ⇒ eligible now. */
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
  /** The last server sentence, kept so an abandoned verb can say WHY without inventing a reason. */
  lastError?: { message: string; code: string | null; status: number | null };
  /**
   * TRUE once a non-idempotent CREATE went out under this key and its answer could not be read —
   * see {@link PendingMutation.createAttempted}. Persisted because the adapter's own memory of it
   * does not survive a reload, and the replay that follows one is exactly the repeat it forbids.
   * Added to `v: 3` in place: absent on an older record, read as `false`, which is the same
   * information those builds had already lost at the reload — so no version bump.
   */
  createAttempted?: boolean;
  /** See {@link PendingMutation.createdRow}. Added to `v: 3` in place, as `createAttempted` was. */
  createdRow?: CreatedDraftRow;
  /** See {@link PendingMutation.owner}. In place on `v: 3`; absent is an older build's, never adopted. */
  owner?: string;
  /**
   * TRUE once a newer verb for the same target has been expressed — see
   * {@link OhmailEngine.planAbandonedSupersession}. Retrying such a record would overwrite the newer
   * intent with an older one the person cannot see is stale, so the retry is refused and only
   * Discard remains.
   */
  superseded?: boolean;
  /**
   * WHY A RETRY WAS REFUSED, once one has been — `outbox_superseded`, `outbox_expired`, or
   * `outbox_unknown_kind`. Persisted so the refusal survives a reload: a control that keeps
   * offering itself after every press is a silent no-op is worse than no control.
   */
  retryRefused?: string;
  /**
   * TRUE once this row was WITHDRAWN — see {@link OhmailEngine.withdrawQueued}. The row survives
   * the restart carrying the mark and {@link OhmailEngine.restoreOutbox} drops it rather than
   * queueing it: a send the person cancelled may not be delivered by a later boot. Added in
   * place, so an older record without it reads as not withdrawn, which is what it was.
   */
  withdrawn?: boolean;
  /** {@link OUTBOX_PROTOCOL}: this row's owner claims it on disk before every send. Absent on an older build's row. */
  protocol?: number;
  /** The owning engine's claim for an attempt in flight, written by the claim's own transaction. */
  sending?: string;
  /**
   * THE SEND + DONE INTENT, kept with the send it was pressed with — see
   * {@link MutationResult.andDone}. Added in place: absent reads as a plain Send. Written by pick
   * (`section`, `source`, `messageIds`); an older row's carried mutations are read and ignored.
   */
  andDone?: SendAndDonePlan;
  /**
   * THE SEND + DONE INTENT WAS HANDED OVER ON A CONFIRMATION while this row was kept (its echo
   * not yet in the mirror). A replay after a kill confirms the send again from its key and carries
   * no intent, so a Done the person undid is not filed a second time. Absent reads as not handed.
   */
  released?: boolean;
  /**
   * A SEND THE SERVER CONFIRMED, kept only until its echo is in the mirror. It is no standing send:
   * a new reply to the same message must not join its key and be answered "already sent".
   */
  confirmed?: boolean;
  /**
   * THIS DISK MAY HAVE PUT THE SEND ON THE WIRE: the owning engine's claim writes it unless the browser said
   * it was offline (and an offline claim sends nothing); otherwise the dispatch writes it before the
   * request leaves. Written on every send row, `false` included; never cleared. A send row WITHOUT it
   * is an older build's and reads as possibly sent ({@link persistedWired}). A Cancel the server could
   * not answer says `unknown` over a wired row and `withdrawn` only over one that never left. `v: 3`.
   */
  wired?: boolean;
  /**
   * A CANCEL THE SERVER HAS NOT ANSWERED: the row is marked withdrawn, so no window sends it, and is
   * kept until `POST /sends/withdraw` answers. Restored or adopted, it is asked again — never sent,
   * never dropped unanswered. In place on `v: 3`.
   */
  withdrawOwed?: boolean;
}

/**
 * What a verb is about — the TARGET, not the kind. `supersedeKey` answers
 * "same kind, same target", right for the QUEUE. The ABANDONED list keys on
 * the target: a record sits there for hours while the thing it names moves
 * on — an abandoned `draft_discard` retried after an edit deletes the newer
 * text; a `folder_delete` after a rename destroys the renamed folder — and
 * kind-keying cannot see those. Any newer verb naming the same target
 * retires the older record. `null` = no collidable target (creates; a
 * draftless `mail_send`). Exhaustive via `satisfies`: new verb = error here.
 */
export function targetOf(m: EngineMutation): string | null {
  switch (m.kind) {
    case "triage_set":
    case "move":
    case "message_delete":
      return `message:${m.messageId}`;
    // The read verbs name a LIST, so they have no single target; the abandoned plan subtracts
    // their ids the way `supersedeQueued` does and marks a record narrowed to nothing.
    case "mark_seen":
    case "feed_mark_seen":
      return null;
    case "tag_assign":
      return `message:${m.messageId}`;
    case "tag_create":
      return null;
    case "tag_rename":
    case "tag_recolor":
    case "tag_delete":
      return `tag:${m.tagId}`;
    case "folder_create":
      return null;
    case "folder_rename":
    case "folder_delete":
    case "folder_op_dismiss":
      return `folder:${m.folderId}`;
    case "rule_create":
      return null;
    case "rule_update":
    case "rule_delete":
      return `rule:${m.ruleId}`;
    case "screener_decide":
      return `sender:${m.senderId}`;
    case "draft_save":
      return m.draftId === null ? null : `draft:${m.draftId}`;
    case "draft_discard":
    case "draft_accept":
    case "draft_schedule_cancel":
    case "draft_resolve":
      return `draft:${m.draftId}`;
    // A send that NAMES a draft shares that draft's target: an abandoned send PUTs its stale body
    // before sending, so a newer edit must retire it. A send that names none owns nothing an older
    // record could overwrite.
    case "mail_send":
      return m.draftId ? `draft:${m.draftId}` : null;
    default: {
      /**
       * EXHAUSTIVE BY CONSTRUCTION. A new `MutationKind` is a compile error here, never a silent
       * `null` — and silently opting a verb out of supersession is exactly how a destructive retry
       * gets through: the record survives, nothing retires it, and Try again applies a stale intent
       * to a target that has moved on.
       */
      const unreachable: never = m;
      void unreachable;
      return null;
    }
  }
}

/** Replay order is user order: the stamp minted at `mutate()`, then its sequence. */
const byAtN = (a: PendingMutation, b: PendingMutation): number => (a.at - b.at) || (a.n - b.n);

/**
 * The answer a withdrawn verb settles with, here or from another window: the code a surface says nothing
 * for, and a send's row (the one it named, or made for a press that named none), so its words stay in it.
 */
function withdrawnResult(p: PendingMutation): MutationResult {
  const row = p.mutation.kind === "mail_send" ? p.createdRow?.id ?? p.mutation.draftId ?? null : null;
  return {
    id: p.id, key: p.key, status: "rolled_back", seq: null, ...(row ? { entityId: row } : {}),
    error: new MutationRejectedError("withdrawn before it was sent", {
      code: OUTBOX_WITHDRAWN_CODE, retryable: false, ...(row ? { entityId: row } : {}),
    }),
  };
}

/** What an owed Cancel past its ceiling says in the abandoned strip: neither outcome is known. */
const WITHDRAW_UNCONFIRMED_SENTENCE =
  "We couldn't confirm whether this send was cancelled. Check your Sent folder before sending it again.";

/** The more cautious of two Cancel answers: `unknown` over `on_the_wire` over `withdrawn`. */
function worseWithdraw(a: WithdrawOutcome, b: WithdrawOutcome): WithdrawOutcome {
  const rank = (w: WithdrawOutcome): number => (w === "unknown" ? 3 : w === "on_the_wire" ? 2 : w === "withdrawn" ? 1 : 0);
  return rank(b) > rank(a) ? b : a;
}

/**
 * MAY THIS PERSISTED SEND HAVE LEFT? This build writes the wire fact on every send row, `false`
 * included, so a send row without it was written by an older build, which kept no such record:
 * possibly sent, and a Cancel the server cannot answer says `unknown` over it, never `withdrawn`.
 */
function persistedWired(e: { mutation: { kind: string }; wired?: boolean }): boolean {
  return e.mutation.kind === "mail_send" && e.wired !== false;
}

/** One pending verb as the row that is persisted for it. */
function outboxEntryOf(p: PendingMutation): PersistedOutboxEntry {
  return {
    v: OUTBOX_ENTRY_VERSION, id: p.id, key: p.key, n: p.n, at: p.at, mutation: p.mutation,
    ...(p.attempts !== undefined ? { attempts: p.attempts } : {}),
    ...(p.nextAt !== undefined ? { nextAt: p.nextAt } : {}),
    ...(p.waitIsServerNamed !== undefined ? { waitIsServerNamed: p.waitIsServerNamed } : {}),
    ...(p.lastError !== undefined ? { lastError: p.lastError } : {}),
    ...(p.createAttempted === true ? { createAttempted: true } : {}),
    ...(p.createdRow !== undefined ? { createdRow: p.createdRow } : {}),
    ...(p.owner !== undefined ? { owner: p.owner, protocol: OUTBOX_PROTOCOL } : {}),
    ...(p.sending !== undefined ? { sending: p.sending } : {}),
    ...andDoneOf(p),
    ...(p.released === true ? { released: true } : {}),
    ...(p.confirmed === true ? { confirmed: true } : {}),
    ...(p.mutation.kind === "mail_send" ? { wired: p.wired === true } : {}),
    ...(p.withdrawOwed === true ? { withdrawn: true, withdrawOwed: true } : {}),
  };
}

/** A persisted created row read back defensively: a malformed one is no row, never a guess. */
function isCreatedRow(v: unknown): v is CreatedDraftRow {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === "string" && r.id.length > 0 && (r.revision === null || typeof r.revision === "string")
    && (r.fingerprint === undefined || r.fingerprint === null || typeof r.fingerprint === "string");
}

/** The persisted Send + Done intent of a send row, by PICK — see {@link asSendAndDoneIntent}. */
function andDoneOf(e: { mutation: EngineMutation; andDone?: unknown }): { andDone?: SendAndDonePlan } {
  const intent = e.mutation.kind === "mail_send" ? asSendAndDoneIntent(e.andDone) : undefined;
  return intent !== undefined ? { andDone: intent } : {};
}

/**
 * EVERY TARGET A VERB OWNS, not just its principal one.
 *
 * `targetOf` answers the single thing a verb is *about*, which is what the queue's whole-entry
 * replacement needs. Tagging is the case that breaks it: `tag_assign` is about a MESSAGE, so two
 * assignments of different tags to one message share a target and retire each other — losing the
 * first tag — while a `tag_delete` of the tag being assigned does not retire the assignment at
 * all, which is the destructive direction. It owns both, so it names both.
 */
function targetsOf(m: EngineMutation): string[] {
  const principal = targetOf(m);
  const out = principal === null ? [] : [principal];
  // `tag_assign` names ONE tag, and it owns that tag as well as the message.
  if (m.kind === "tag_assign") out.push(`tag:${m.tagId}`);
  return out;
}

/**
 * When a newer verb retires an abandoned one, and the two reasons it may. SAME KIND, SHARED TARGET: an
 * absolute-valued verb replaces its own earlier value — deliberately narrow, because sharing a target is NOT enough
 * on its own: a queued tag assignment and a later triage of the same message are independent intentions, and retiring
 * one for the other silently throws away work.
 */

/**
 * THE DESTRUCTIVE ASYMMETRIES, each a judgement with the OLDER record as the destructive one: a `draft_discard` is
 * retired by a later `draft_save` of that draft (the person came back to it); a `message_delete`, `folder_delete` or
 * `tag_delete` is retired by ANYTHING later on that target (a newer intent on a thing the record wants to destroy
 * says it should still exist); a `mail_send` naming a draft is retired by a later verb on that draft (a record that
 * would re-send a body the person has since changed is the worst kind of stale). Everything else is left alone:
 * retiring too eagerly is invisible — an intent disappears and nobody is told — while a stale record is something the
 * person can see and discard themselves.
 */
const DESTRUCTIVE_KINDS = new Set(["message_delete", "folder_delete", "tag_delete"]);

function retiresAbandoned(newer: EngineMutation, older: EngineMutation): boolean {
  const shared = targetsOf(newer).filter((t) => targetsOf(older).includes(t));
  if (shared.length === 0) return false;

  /**
   * TWO TAG ASSIGNMENTS ARE THE SAME KIND AND SHARE A MESSAGE, and they are still independent:
   * applying a second tag says nothing about the first. Same-kind replacement is about a verb
   * whose newer VALUE is the whole intent, and a tag assignment's value is the tag — so this pair
   * is decided on the tag, not on the message they happen to share.
   */
  if (newer.kind === "tag_assign" && older.kind === "tag_assign") {
    return newer.tagId === older.tagId;
  }
  if (newer.kind === older.kind) return true;

  /**
   * A DESTRUCTION ON EITHER SIDE RETIRES THE OLDER RECORD, and both directions are real:
   *  · the destruction is NEWER — the thing is gone, so replaying an edit of it can only fail or
   *    resurrect it (deleting a tag kills a queued assignment of that tag);
   *  · the destruction is OLDER — a newer intent on the target says plainly it should still
   *    exist, so the queued destruction is not what the person wants any more (a queued delete
   *    met by a later move).
   */
  if (DESTRUCTIVE_KINDS.has(newer.kind) || DESTRUCTIVE_KINDS.has(older.kind)) return true;
  if (older.kind === "draft_discard" && newer.kind === "draft_save") return true;
  if (older.kind === "mail_send" && targetOf(older) !== null) return true;
  return false;
}

/**
 * The SAME-KIND, SAME-TARGET identity a newer verb replaces a queued older verb under — see
 * {@link OhmailEngine.supersedeQueued} for the rule and its boundaries. `null` means this kind
 * never participates: creates (nothing to replace), `mail_send` (the reservation machinery owns
 * it), the read-flag verbs (they subtract ids instead — a list is not a scalar), and anything
 * whose replay is already convergent without help.
 */
function supersedeKey(m: EngineMutation): string | null {
  switch (m.kind) {
    case "triage_set":
      return `${m.kind}:${m.messageId}`;
    // ONE DECISION PER FIELD PER OUTBOX: a move and a delete both set the message's placement, so
    // a later delete retires a queued move rather than both replaying onto one field in one flush.
    case "move":
    case "message_delete":
      return `placement:${m.messageId}`;
    case "tag_assign":
      // PER TAG, not per message: the enriched `labels` union is optimistic-only — the WIRE is
      // `{ tagId, assigned }`, so two queued assignments of different tags on one message are
      // independent server-side deltas and replacing one with the other would un-tag the first
      // on reconciliation. Only a newer verb about the SAME tag replaces the older.
      return `tag_assign:${m.messageId}:${m.tagId}`;
    case "screener_decide":
      return `screener_decide:${m.senderId}`;
    case "rule_update":
      return `rule_update:${m.ruleId}`;
    case "tag_rename":
    case "tag_recolor":
      return `${m.kind}:${m.tagId}`;
    case "folder_rename":
    case "folder_delete":
    case "folder_op_dismiss":
      return `${m.kind}:${m.folderId}`;
    case "draft_save":
      // Only the autosave of an EXISTING row — the newer body is the whole intent. A create
      // (draftId null) supersedes nothing and is never superseded.
      return m.draftId === null ? null : `draft_save:${m.draftId}`;
    case "draft_schedule_cancel":
      return `draft_schedule_cancel:${m.draftId}`;
    // A person may answer "it arrived" and then "it didn't" before either reaches the server;
    // the LAST answer is the whole intent, so an earlier one queued for the same row is
    // superseded rather than replayed. Keyed per row, like the cancel above: two different
    // held rows are two different intents.
    case "draft_resolve":
      return `draft_resolve:${m.draftId}`;
    default:
      return null;
  }
}

/**
 * A PERSON'S READ OR UNREAD: a `mark_seen` with no glance label — the read pill, ⇧I, bulk; `via` is
 * the verb's own involuntary marker, so a dwell commit's `mark_seen` counts as a glance. A glance
 * can only ever READ: `unread: true` is a deliberate act whatever label a caller stuck on it, so the
 * value takes part in the classification, not the label alone.
 */
const explicitRead = (m: EngineMutation): boolean =>
  m.kind === "mark_seen" && (m.via !== "glance" || m.unread === true);
/** THE APP'S OWN READ: a stream's sweep, or a glance-labelled read (the dwell, the open's read). */
const involuntaryRead = (m: EngineMutation): boolean =>
  m.kind === "feed_mark_seen" || (m.kind === "mark_seen" && m.via === "glance" && m.unread === false);

/**
 * WHAT A NEWER READ VERB LEAVES OF AN OLDER ONE — the read-flag half of
 * {@link OhmailEngine.supersedeQueued}, one rule for a queued read and for one on its way to the
 * wire or on it ({@link PendingMutation.readsTaken}). `undefined`: the older stands whole;
 * `null`: nothing of it is left.
 */
function readLeftBy(newer: EngineMutation, older: EngineMutation): EngineMutation | null | undefined {
  if ((newer.kind !== "mark_seen" && newer.kind !== "feed_mark_seen")
    || (older.kind !== "mark_seen" && older.kind !== "feed_mark_seen")) return undefined;
  const readIds = new Set(newer.messageIds ?? []);
  // The allowed pairs, and only these: a person's read or unread outranks BOTH older read verbs; a
  // glance of either kind outranks only the app's own older reads — it must never cancel a
  // deliberate unread. Asked whenever the newer verb is a read verb at all, id overlap or not,
  // because a newer same-view leave-commit with an EMPTY id list (the ordinary waterline commit)
  // still supersedes the older line.
  const newerExplicit = explicitRead(newer);
  const olderInvoluntary = involuntaryRead(older);
  const qids = older.messageIds ?? [];
  // A newer same-view glance also replaces the older glance's waterline: the newer departure IS
  // the later line.
  const lineSuperseded = newer.kind === "feed_mark_seen" && older.kind === "feed_mark_seen"
    && (newer.view ?? "reads") === (older.view ?? "reads") && newer.upToId !== undefined;
  const overlaps = qids.some((mid) => readIds.has(mid));
  if (!(newerExplicit || olderInvoluntary) || (!overlaps && !lineSuperseded)) return undefined;
  const remaining = qids.filter((mid) => !readIds.has(mid));
  const keepsLine = older.kind === "feed_mark_seen" && older.upToId !== undefined && !lineSuperseded;
  if (remaining.length === 0 && !keepsLine) return null;
  const narrowed = (older.kind === "mark_seen" ? narrowRead(older, remaining) : { ...older, messageIds: remaining }) as EngineMutation;
  if (lineSuperseded && narrowed.kind === "feed_mark_seen") delete narrowed.upToId;
  return narrowed;
}

/**
 * THE STATE VERBS THAT CARRY THEIR PRESS'S AGE (`x-ohmail-press-age`): each sets one field of one
 * message, and the server refuses it `stale_press` when that field was decided after the press.
 * Sends, Screener decisions and rule verbs take none. `press-age-route-census.test.ts` holds this
 * set equal to the routes flagged `pressAge`.
 */
export const PRESS_AGE_KINDS: ReadonlySet<string> = new Set([
  "move", "message_delete", "triage_set", "tag_assign", "mark_seen", "feed_mark_seen",
]);

/** The press age of an entry at dispatch: the engine clock minus the persisted press instant, never negative. */
function pressAgeOf(m: EngineMutation, at: number, now: number): { pressAgeMs?: number } {
  return PRESS_AGE_KINDS.has(m.kind) ? { pressAgeMs: Math.max(0, now - at) } : {};
}

/** Why a create past {@link pastCreateDedupe}'s horizon is never sent again — the retry's and the boot's. */
const OUTBOX_EXPIRED_MESSAGE = "This change is too old to send safely — it would be created twice.";

/**
 * IS THIS QUEUED OR WIRE ENTRY A SEND A NEW PRESS MAY JOIN? Not one the server confirmed and the
 * engine keeps only for its echo (`confirmed`): a press joining it is answered from that delivery
 * and never goes. The one reading both surfaces' standing-send lookups share.
 */
export function joinableStandingSend(p: { mutation: { kind: string }; confirmed?: true }): boolean {
  return p.mutation.kind === "mail_send" && p.confirmed !== true;
}

/**
 * IS THIS AN UNKEYED CREATE TOO OLD TO REPLAY? — one predicate, so the boot replay and the manual Try again cannot
 * come to disagree about it. Past the server's idempotency window a replay is not a replay: the key has been
 * forgotten, so the request mints a SECOND row — a second draft, a second rule. The boot path never replays such
 * verbs; the retry button had no check at all, and the record a person presses there is by construction an old one,
 * since it spent a whole ceiling getting into that list. The membership test mirrors `restoreOutbox`'s exactly rather
 * than widening it: a create that carries a key of its own is safe at any age, and only these two arrive without one.
 */
function pastCreateDedupe(e: PersistedOutboxEntry, now: number): boolean {
  const unkeyedCreate = e.mutation.kind === "rule_create"
    || (e.mutation.kind === "draft_save" && e.mutation.draftId === null);
  return unkeyedCreate && now - e.at > OUTBOX_UNKEYED_CREATE_TTL_MS;
}

/**
 * The shape gate for {@link PersistedOutboxEntry} — see `v` above for why unknown ⇒ keep, not drop.
 *
 * **BOTH `v: 1` AND `v: 2` PASS, and the `v: 1` arm is not politeness.** The outbox is written when
 * a verb is expressed and read back on the next boot, which may be the boot AFTER an upgrade. A
 * gate that admitted only the current version would leave every verb queued by the previous build
 * on disk, shaped correctly, and never replayed — the user's unsent work, lost silently, by the
 * very record type that exists to make it durable. The optional fields are read defensively for the
 * same reason: a `v: 1` record has no `attempts`, and `??` is what makes it a valid `v: 2`.
 */
function isPersistedOutboxEntry(e: unknown): e is PersistedOutboxEntry {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return (r.v === 1 || r.v === 2 || r.v === 3)
    && typeof r.id === "string" && r.id.length > 0
    && typeof r.key === "string" && r.key.length > 0
    && typeof r.n === "number" && typeof r.at === "number"
    && (r.attempts === undefined || typeof r.attempts === "number")
    && (r.nextAt === undefined || typeof r.nextAt === "number")
    && typeof r.mutation === "object" && r.mutation !== null
    && typeof (r.mutation as Record<string, unknown>).kind === "string";
}

/**
 * ONE VERB THE SERVER WOULD NOT TAKE — what {@link OhmailEngine.abandoned} hands a surface.
 *
 * `error` carries the SERVER's own sentence rather than a category this client invented, for the
 * reason every refusal on this path already follows: the code that made the decision wrote a true
 * sentence, and a second taxonomy here is how somebody gets told the wrong thing. Where the server
 * said nothing usable — an unhandled 500 says "internal error" — the surface is responsible for
 * saying so plainly rather than repeating it.
 */
/**
 * A verb WAITING ON THIS CLIENT'S QUEUE as a surface lists it — a frozen copy, never the engine's
 * live entry, whose `mutation` the queue narrows in place. See {@link OhmailEngine.queuedDiscards}.
 */
export interface QueuedChange {
  readonly id: string;
  readonly key: string;
  readonly mutation: EngineMutation;
  /**
   * What the verb's last attempt met, as the queue holds it: `null` before any answer (it waits its
   * turn), absent from {@link OhmailEngine.queuedDiscards}. Set by {@link OhmailEngine.queuedChanges}.
   */
  readonly error?: { readonly code: string | null; readonly message: string; readonly status: number | null } | null;
}

const NO_QUEUED: readonly QueuedChange[] = Object.freeze([]);

/**
 * A SEND THAT HAS WAITED and has not gone — see {@link OhmailEngine.waitingSends}. `draftId` is the
 * row the send names (its created row, or the bound one), `null` before it has one; `paintId` the
 * send's own placeholder row in the overlay; `wire` a request for it running now.
 */
export interface WaitingSend {
  readonly id: string;
  readonly key: string;
  readonly draftId: string | null;
  readonly paintId: string | null;
  readonly wire: boolean;
  /** Epoch ms of the press. */
  readonly at: number;
  readonly mutation: Extract<EngineMutation, { kind: "mail_send" }>;
}

export const NO_WAITING: readonly WaitingSend[] = Object.freeze([]);

export interface AbandonedMutation {
  id: string;
  key: string;
  mutation: EngineMutation;
  /** Epoch ms when the verb was first expressed, so a surface can say how long it has been stuck. */
  at: number;
  attempts: number;
  error: { message: string; code: string | null; status: number | null };
  /** A newer change to the same thing has since been saved; Try again is refused. */
  superseded: boolean;
  /** False once a retry has been refused (superseded, too old, or a verb this build cannot run). */
  retryable: boolean;
  /** The refusal's code, when there is one — the surface picks its sentence from this. */
  refusedCode: string | null;
}

export {
  andDoneOf, byAtN, explicitRead, isCreatedRow, isPersistedOutboxEntry, NO_QUEUED, OUTBOX_EXPIRED_MESSAGE,
  outboxEntryOf, pastCreateDedupe, type PersistedOutboxEntry, persistedWired, pressAgeOf, readLeftBy,
  retiresAbandoned, supersedeKey, WITHDRAW_UNCONFIRMED_SENTENCE, withdrawnResult, worseWithdraw,
};
