/**
 * No write, no wire: a verb whose durable record this device could not
 * write does not go to the server, in exactly two cases. A SEND — its
 * Idempotency-Key is the only thing between a retry and a second copy, and
 * the key lives in the row that just failed. And a verb that REPLACES
 * queued ones — the refused transaction retired nothing, so the older verbs
 * are still the disk's truth and a kill would replay them over the newer
 * intent. Both are refused to the person's face with the store's reason;
 * every other verb still goes — repeating a state change is a no-op.
 */
// `@trafficflow/core/ics` maps to a dependency-free SOURCE module (see its header) — the ONE
// core entry point browser bundles may import. Never the barrel or `./mail` from here: both
// carry mailparser and `node:crypto`, which no consumer of this engine can load.
import { CALENDAR_FALLBACK_FILENAME, isCalendarMime } from "@trafficflow/core/ics";
import type { AttachmentWire, EngineAdapter, MutationOutcome } from "./adapters/adapter.js";
import { messageIdKey, mutationEffects, replySubject, sentOverlayMessage, type MutationEffect } from "./mutations.js";
import {
  SearchIndex,
  type AddressDirection,
  type AddressResult,
  type LocalSearchResult,
} from "./search.js";
import { sendingMailboxId } from "./selectors.js";
import { flattenResponse } from "./apply.js";
import { MemoryMirrorStore, type EntityReader, type MirrorStore } from "./store.js";
// THE SHARED DRAIN POLICY — the staleness threshold, the dense-page limit and the two
// derivations over the drain stamp, held in one module with the desktop sidecar's mirror
// (INSTANT-ARCH §6.7). A dependency-free core subpath, like `./ics` above; imported for local
// use AND re-exported below, so this engine's public surface is unchanged while there is
// exactly one definition of each.
import {
  drainPageLimit, mirrorFreshness, mirrorStale, STALE_RESUME_MS, type MirrorFreshness,
} from "@trafficflow/core/drain-policy";
// The search tier vocabulary, shared with the hosted service — a dependency-free core subpath
// like the two above. The archive's answer names its tier on the wire, and the local index
// decides its own by the same rule, so the merged list can put both under one heading.
import type { SearchTier } from "@trafficflow/core/search-rank";
import {
  CursorExpiredError,
  FOLDER_OF_VIEW,
  MutationRejectedError,
  encodeSeqCursor,
  isProtectedMessage,
  type ComposeAttachment,
  type EngineDraft,
  type EngineMessage,
  type EngineMutation,
  type MessageBodyBatchWire,
  type MessageBodyRecord,
  type MessageStateDTO,
  type OhmailView,
  type SyncSnapshotPage,
  type UnsubscribeResult,
  type WithheldMarker,
  OUTBOX_TYPE,
  OUTBOX_ABANDONED_TYPE,
} from "./types.js";

/**
 * The wire's withheld marker, narrowed to the CLOSED set the mirror understands — every member
 * hydrates as itself, and anything else (an older/newer server) narrows to `null`, which is
 * ANSWERED-ordinary. See `WithheldMarker` for why dropping a real member here would be a
 * permanent lie in the record. One helper for both hydration sites so they cannot disagree.
 */
const withheldMarkerOf = (w: unknown): WithheldMarker | null =>
  w === "storage_cap" || w === "junk_filed" || w === "expunged" ? w : null;


/**
 * The delta-sync engine (brief §4 — the load-bearing abstraction):
 *
 *   bootstrap (since=0) → drain (hasMore) → apply idempotently → cursor;
 *   410 → discard local state, re-bootstrap;
 *   optimistic mutations: overlay instantly (user-always-wins), fire the wire
 *   request with an Idempotency-Key, reconcile on the X-Sync-Seq echo (or the
 *   next /sync drain), roll back only on a hard rejection;
 *   SSE/push are WAKE SIGNALS only — attachWakeSignal() nudges a syncOnce.
 */

export type MutationStatus = "confirmed" | "queued" | "rolled_back";

export interface MutationResult {
  id: string;
  /** The Idempotency-Key used on the wire — stable across retries. */
  key: string;
  status: MutationStatus;
  seq: number | null;
  error?: MutationRejectedError;
  /**
   * The server's id for a row this mutation created — see
   * {@link MutationOutcome.entityId}. Present where the caller must keep
   * using it: `draft_save`'s confirmed CREATE (the compose surface adopts
   * it, PATCHes it and sends that row), and a QUEUED send — nothing adopts
   * that one, but the durable send record has to name it or a reload cannot
   * tell the row in Drafts is the message it is waiting on. A rolled-back
   * result carries it too when the refusal knows the row — see
   * {@link MutationRejectedError.entityId} (an `unverified` send's row).
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
}

/** What one supersession changed, and everything needed to put it back. */
/** What one pass of abandoned-record marking actually managed to do. */
interface MarkerOutcome {
  marked: Array<{ id: string; before: PersistedOutboxEntry }>;
  failed: number;
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
  /** The abandoned-record markers, awaited before this verb may dispatch. */
  marked: Promise<MarkerOutcome>;
  /**
   * Requests on the wire this call marked superseded — see
   * {@link PendingMutation.supersededInFlight}. The mark is made BEFORE
   * persistence and undone on refusal, not deferred: the write is awaited,
   * and before it returns the older request can answer retryably and
   * re-queue itself — neither half would retire it, and the older verb
   * replays over the newer intent with no storage failure needed. Marking
   * before has one bad case — a refusal — where dropping the older verb
   * loses the only expressed intent, so the mark is part of the rollback.
   */
  markedInFlight: PendingMutation[];
}

interface PendingMutation {
  id: string;
  key: string;
  mutation: EngineMutation;
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
   * TRUE when a newer verb for the same target was expressed while this one was on the wire.
   *
   * It cannot be un-sent, but it must not be replayed: the newer verb has since established the
   * state, and re-running this one would put the older value back over it.
   */
  supersededInFlight?: boolean;
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

/**
 * THE DURABLE OUTBOX'S RECORD TYPE — a client-local record (`putLocal`, seq 0), one per
 * user verb, written the moment the verb is expressed and removed on its terminal outcome
 * (server confirmation or explicit refusal). `/sync` has no vocabulary for it, so no delta
 * can ever contradict or delete one; the windowed prune only ever evicts `message` rows, so
 * a policy pass cannot either. The mirror's persistence engine is what makes it durable —
 * IndexedDB on the webapp, sqlite on mobile, whatever `MirrorStore` a future surface binds
 * (INSTANT-ARCH §6.2 stage 1: the intent is durable the moment it is expressed).
 */
export { OUTBOX_TYPE } from "./types.js";

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
export { OUTBOX_ABANDONED_TYPE } from "./types.js";

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
   * TRUE once a newer verb for the same target has been expressed — see
   * {@link OhmailEngine.supersedeAbandoned}. Retrying such a record would overwrite the newer
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
    // The read verbs name a LIST, so they have no single target; `supersedeAbandoned` subtracts
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

/** One pending verb as the row that is persisted for it. */
function outboxEntryOf(p: PendingMutation): PersistedOutboxEntry {
  return {
    v: OUTBOX_ENTRY_VERSION, id: p.id, key: p.key, n: p.n, at: p.at, mutation: p.mutation,
    ...(p.attempts !== undefined ? { attempts: p.attempts } : {}),
    ...(p.nextAt !== undefined ? { nextAt: p.nextAt } : {}),
    ...(p.waitIsServerNamed !== undefined ? { waitIsServerNamed: p.waitIsServerNamed } : {}),
    ...(p.lastError !== undefined ? { lastError: p.lastError } : {}),
  };
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
    case "move":
    case "message_delete":
      return `${m.kind}:${m.messageId}`;
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
 * IS THIS AN UNKEYED CREATE TOO OLD TO REPLAY? — one predicate, so the boot replay and the manual Try again cannot
 * come to disagree about it. Past the server's idempotency window a replay is not a replay: the key has been
 * forgotten, so the request mints a SECOND row — a second draft, a second rule. The boot path has always dropped such
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

/**
 * WHAT `GET /search` ANSWERS, as much of it as this client reads. The route returns `{ items, facets, total }`.
 * `items` are canonical `MessageDTO`s, and an {@link EngineMessage} is exactly a `MessageDTO` plus optional fixture
 * extras, so a DTO IS one — no conversion, no second shape. `facets` is deliberately NOT read: the server's facet
 * keys are raw folder paths (`SearchService.folderExpr` → `desired_folder` / the native locator), while the local
 * index keys its facets by VIEW id or by folder leaf, and rendering the server's keys would put a namespaced IMAP
 * path straight on screen. The surface keeps its local facets; forward-compatible parsing (§8) means the extra field
 * is not an error.
 */
export interface ServerSearchWire {
  items: EngineMessage[];
  /** Matches for the query across the WHOLE corpus, which is more than `items.length`. */
  total: number;
  /**
   * WHICH TIER THE ARCHIVE'S ANSWER IS — `exact` when its lexical arm matched, `similar` when these rows are
   * typo-tolerant guesses because nothing matched literally. The rule and its floor are
   * `@trafficflow/core/search-rank`'s, applied identically by the local index. Optional on the wire, and ABSENT MEANS
   * `exact`. That is not a shrug: every server before this field existed returned its lexical answer (fused with a
   * fuzzy arm, but intending an answer, not a guess), and a client that read the absence as `similar` would file a
   * real result under a "Similar" heading. The unknown case takes the reading that does not mislabel a hit — and a
   * client and a server ship in the same wave, so the window is short.
   */
  tier?: SearchTier;
}

/**
 * THE ORDER THE ARCHIVE IS ASKED FOR — the same closed vocabulary the search service declares on the server, spelled
 * out again here for the reason `owner-cookie.ts` repeats a cookie name: this package is the STANDALONE desktop
 * payload and cannot import the hosted service, so the list is written out twice and held together by a test on the
 * server's side that reads both declarations and fails if they drift. Adding an order HERE that the server does not
 * accept is the dangerous direction — the route refuses what it does not recognise, so every search a user ran with
 * it would fail. `relevance` is the default at every layer, and an absent value means it: the parameter is left OFF
 * the wire rather than sent explicitly, so a client on this build asks an older server exactly the question it asked
 * before.
 */
export const SERVER_SEARCH_SORTS = ["relevance", "date_desc", "date_asc", "mailbox", "sender"] as const;
export type ServerSearchSort = (typeof SERVER_SEARCH_SORTS)[number];

/** What a caller may ask of one archive pass. */
export interface ServerSearchOpts {
  limit?: number;
  /** Absent ⇒ `relevance`, and nothing is put on the wire. */
  sort?: ServerSearchSort;
}

/**
 * The transport `searchServer` runs on. Optional everywhere: the demo has no server, the
 * desktop tier has no Cloud, and neither may be given one.
 */
export type ServerSearchFn = (
  query: string,
  opts: ServerSearchOpts,
) => Promise<ServerSearchWire | null>;

/**
 * WHAT `GET /search?address=&direction=from` ANSWERS — the archive half of the address view. `items` are canonical
 * `MessageDTO`s, so an {@link EngineMessage} IS one, exactly as {@link ServerSearchWire} explains. No `tier`: an
 * address query is an EQUALITY, so there is no lexical arm to have missed and no typo-tolerant guess to label.
 * `direction` is on the wire and is not assumed. Only `from` is answerable from an index today (the recipients are
 * two unindexed JSONB columns — `SearchService.searchByAddress` records the measurement), so the client asks for
 * `from` WHATEVER its toggle says and reads this field to label what came back. A client that inferred the direction
 * from its own request would report "everything in the archive" for an answer that covers one side of it.
 */
export interface ServerAddressWire {
  items: EngineMessage[];
  /** Matches across the WHOLE corpus in the answered direction, which is more than `items.length`. */
  total: number;
  /** Which side the server actually searched. Absent ⇒ `from`, the only direction it serves. */
  direction?: ServerAddressDirection;
}

/**
 * THE DIRECTIONS THE ARCHIVE'S VOCABULARY HAS — written out here rather than imported, for the
 * reason {@link SERVER_SEARCH_SORTS} gives one screen up: this package is the standalone desktop
 * payload and cannot import the hosted service.
 *
 * `SERVED` is the subset the server answers today. The two lists are separate because the
 * DIFFERENCE between them is a state the view has to state — "the archive cannot be searched by
 * recipient yet" — and a single list could not express it.
 */
export const SERVER_ADDRESS_DIRECTIONS = ["any", "from", "to"] as const;
export type ServerAddressDirection = (typeof SERVER_ADDRESS_DIRECTIONS)[number];
/** The one direction `GET /search?address=` answers. See {@link ServerAddressWire.direction}. */
export const SERVER_ADDRESS_DIRECTIONS_SERVED: readonly ServerAddressDirection[] = ["from"];

/** What a caller may ask of one archive address pass. */
export interface ServerAddressOpts {
  limit?: number;
}

/**
 * The transport {@link OhmailEngine.searchAddressServer} runs on. Optional everywhere, exactly
 * as {@link ServerSearchFn} is: the demo has no server and the desktop tier has no Cloud, and
 * both must read as "there is no archive here" rather than as broken.
 */
export type ServerAddressSearchFn = (
  address: string,
  opts: ServerAddressOpts,
) => Promise<ServerAddressWire | null>;

/**
 * The adapter capability this reaches for when no `serverSearch` was injected.
 *
 * Declared structurally HERE rather than as a member of `EngineAdapter` because the engine is
 * the only thing that calls it and the two adapters answer it differently in kind — the
 * FixturesAdapter has no server to ask and the HttpAdapter has one endpoint. An adapter
 * without the method is not broken; it is a client with no archive behind it, which
 * {@link OhmailEngine.serverSearchAvailable} reports and the UI states.
 */
interface ServerSearchCapableAdapter {
  searchServer?: ServerSearchFn;
}

/**
 * The address arm of the same capability, declared separately for the same structural reason —
 * and separately from `searchServer` because an adapter can have one and not the other: a
 * wrapper that forwards capabilities explicitly (`sync-scheduler.ts`'s read gate) forwards them
 * one at a time, and a build that predates this arm has the text search and not this.
 */
interface ServerAddressSearchCapableAdapter {
  searchAddressServer?: ServerAddressSearchFn;
}

/**
 * WHAT `GET /messages` ANSWERS for ONE view's page, as much of it as this client reads.
 *
 * The route returns `{ items, nextCursor }`, keyset-paged `date desc, id desc`. `items` are
 * canonical `MessageDTO`s, and an {@link EngineMessage} is exactly a `MessageDTO` plus optional
 * fixture extras — so a DTO IS one, with no conversion and no second shape (the same reasoning as
 * {@link ServerSearchWire}). `nextCursor` is the server's own opaque paging token: it is echoed
 * back untouched on the following call and is `null` on the last page.
 */
export interface ListOlderWire {
  items: EngineMessage[];
  nextCursor: string | null;
}

/**
 * The transport {@link OhmailEngine.listOlder} runs on. Optional everywhere, exactly as
 * {@link ServerSearchFn} is: a client whose whole mailbox is already on the device has nothing
 * behind the end of the list, and must be able to say so rather than spin.
 */
export type ListOlderFn = (
  view: OhmailView | "folder",
  opts: {
    cursor?: string;
    limit?: number;
    /**
     * One of the mailbox's own folders, by `folder` ENTITY id — required with `view: "folder"`
     * and meaningless otherwise (the folders foundation: a fresh web mirror is a window, and a
     * folder's older mail lives past it exactly as a pile's does). A transport that predates
     * the feature ignores it and resolves `null`, which reads as "nothing further back".
     */
    folderId?: string;
    /**
     * Start the FIRST page strictly below this (date, id) keyset position — the caller's mirror
     * boundary, so page one begins where the mirror ends instead of re-serving the newest rows
     * the mirror already renders. Ignored once a cursor exists (the cursor IS the position).
     */
    startBelow?: { date: string | null; id: string };
  },
) => Promise<ListOlderWire | null>;

/**
 * The adapter capability the out-of-window read reaches for. Declared STRUCTURALLY here, exactly as {@link
 * ServerSearchCapableAdapter} and {@link SnapshotCapableAdapter} are, and for the same reason: absence is a real
 * answer. A fixtures client has no server, and a client keeping the WHOLE mailbox has nothing older to fetch — both
 * must read as "there is nothing beyond this list", not as a broken adapter. It carries the same wiring risk the
 * other two do, and the risk has been paid for three times already: a wrapper that rebuilds the adapter surface as an
 * object literal drops a structural capability silently and still satisfies `EngineAdapter`.
 */

/**
 * `apps/webapp/app/shell/sync-scheduler.ts` has exactly such a wrapper, so it must spread this the way it spreads the
 * others: ...(adapter.listMessages ? { listMessages: adapter.listMessages.bind(adapter) } : {}) conditionally, never
 * unconditionally.
 */
interface ListMessagesCapableAdapter {
  listMessages?: ListOlderFn;
}

/** The batch body read, as {@link OhmailEngine.hydrateThread} calls it. */
export type FetchBodiesFn = (messageIds: string[]) => Promise<MessageBodyBatchWire[] | null>;

/**
 * The adapter capability a thread open reaches for.
 *
 * Declared STRUCTURALLY here for the same reason the three above it are, and carrying the same
 * wiring risk they do: `apps/webapp/app/shell/sync-scheduler.ts` rebuilds the adapter surface as
 * an object literal, and a literal that forgets a structural capability still satisfies
 * `EngineAdapter`. The failure would be invisible in the suite and live on the LIVE path only —
 * every real thread quietly back to N requests — so that wrapper must spread this the way it
 * spreads the others, conditionally and never unconditionally.
 */
interface FetchBodiesCapableAdapter {
  fetchBodies?: FetchBodiesFn;
}

/**
 * How many ids one batch body request may name.
 *
 * The server refuses more (400) rather than truncating, because a truncated answer is
 * indistinguishable from "those messages have no body". The engine therefore does the splitting
 * itself: a thread longer than this becomes two requests, not one refusal. Twenty is well past
 * any conversation a reader scrolls — the widest real thread measured here is nine — and it is the
 * count at which the byte budget rather than the id list is the binding constraint.
 */
export const BODIES_IDS_MAX = 20;

/**
 * `GET /sync/snapshot` as the engine calls it — see {@link SyncSnapshotPage} for the protocol. `cursor` is the
 * server's own opaque paging token from the previous page, absent on the first. `limit` is a hint the engine does not
 * currently send. PAGE 1 IS NOT "ALL LIVE STATE" ANY MORE, and that is what this sentence used to say. A message's
 * children — its state, a pending routing decision, an approval — ride with the page that carries their parent, so no
 * page holds the whole of anything and a client-imposed limit would cut a message away from its own children rather
 * than merely shortening a list. What page 1 still is: the newest page of messages, the state belonging to them, and
 * the account-wide rows small enough to have no page of their own.
 */
export type SnapshotFn = (params: { cursor?: string; limit?: number }) => Promise<SyncSnapshotPage>;

/**
 * The adapter capability the cold-start path reaches for. Declared STRUCTURALLY, exactly as {@link
 * ServerSearchCapableAdapter} is: absence is a real answer, not a broken adapter — the FixturesAdapter has no server
 * and a `?demo=1` tab must issue zero requests, and an older HttpAdapter simply has no `snapshot`, so the engine
 * falls back to `since=0`, which converges to the same mirror. The wiring risk this shape carries: an adapter WRAPPER
 * that rebuilds the surface as an object literal silently drops it and still satisfies `EngineAdapter` —
 * `sync-scheduler.ts`'s `guard` is exactly such a wrapper, and `fetchBody`, `searchServer` and the three attachment
 * methods each shipped unforwarded on the LIVE path for precisely this reason (the demo is unwrapped, so every test
 * stayed green).
 */

/**
 * A wrapper must spread it conditionally (`...(adapter.snapshot ? { snapshot: adapter.snapshot.bind(adapter) } :
 * {})`), never unconditionally — defining it always would make a gated fixtures adapter claim a snapshot endpoint it
 * has no server for.
 */
interface SnapshotCapableAdapter {
  snapshot?: SnapshotFn;
}

/**
 * HOW MUCH OF THE MAILBOX THIS CLIENT KEEPS ON DISK. `full` is the DEFAULT and the absent-config branch, and that
 * ordering is the whole safety property: the desktop tier's entire promise is that the mail is on the device, so a
 * host that forgets to configure this must get today's behaviour — nothing is ever evicted — rather than a quietly
 * truncated mailbox. A policy that pruned by omission would be a data-loss default. `windowed` is the browser's
 * answer, where the mirror is a cache in front of a Cloud that still holds everything: keep the newest `minRows`
 * messages unconditionally, plus anything within `days`, and drop the rest. Dropped rows are not lost — they are one
 * `/sync` change or one re-snapshot away, because {@link MirrorStore.prune} deletes rather than tombstones.
 */
export type StorePolicy =
  | { mode: "full" }
  | { mode: "windowed"; days: number; minRows: number };

/**
 * The two `/sync` entity types the pin set reads, narrowed to the ONE field each that decides whether the user still
 * owes it an answer. Declared here rather than in `types.ts` for the same reason {@link SnapshotCapableAdapter} is:
 * this is the only code in the package that looks at either type, and mirroring the server's whole
 * `RoutingDecisionDTO`/`ApprovalDTO` would be a second copy of a shape nothing else reads — which is a shape that can
 * drift without anything noticing. Every field is optional-safe: a status this build has never heard of is simply not
 * one of the pinning values, and the row is treated as resolved.
 */
interface PendingRoutingDecision {
  messageId?: string;
  status?: string;
}
interface PendingApproval {
  messageId?: string | null;
  status?: string;
}

/**
 * WHEN a message is, for windowing purposes — the mail's own date, falling back to the row's
 * `updatedAt`, and 0 for a row with neither.
 *
 * 0 sorts oldest, which is the conservative direction ONLY because the `minRows` floor and the
 * pin set are both checked independently of this number: an undated row can be evicted for being
 * undated, but never one of the newest N and never one something still references.
 */
function messageTime(m: EngineMessage): number {
  const t = Date.parse(m.date ?? m.updatedAt ?? "");
  return Number.isFinite(t) ? t : 0;
}

/**
 * The outcome of one archive pass. It NEVER rejects — see {@link OhmailEngine.searchServer}.
 *
 * `unavailable` is a first-class answer and not an error: it is what the demo and the desktop
 * get, and the difference between "there is no archive behind this client" and "the archive
 * refused" is the difference between two true sentences the UI has to be able to tell apart.
 */
export type ServerSearchOutcome =
  | { state: "unavailable" }
  | { state: "ready"; items: EngineMessage[]; total: number; tier: SearchTier }
  | { state: "failed"; error: string };

/**
 * THE ARCHIVE'S ANSWER ABOUT ONE ADDRESS. It never rejects — the outcome is a value the UI
 * renders, exactly as {@link ServerSearchOutcome} is.
 *
 * `ready` carries the direction the server ANSWERED, which the caller may not have asked for.
 * That is the whole reason this is not simply `ServerSearchOutcome` without the tier: a view
 * whose toggle says "All" or "To them" is handed the FROM half and has to say so
 * ("N in the archive, by sender"), and the field is what lets it. Inferring the direction from
 * the request would let a client claim the archive answered a question it did not.
 */
export type ServerAddressOutcome =
  | { state: "unavailable" }
  | { state: "ready"; items: EngineMessage[]; total: number; direction: ServerAddressDirection }
  | { state: "failed"; error: string };

/**
 * The outcome of one page of out-of-window mail. It NEVER rejects — see {@link OhmailEngine.listOlder}. Deliberately
 * shaped like {@link ServerSearchOutcome}, `unavailable` first-class and for the same reason: "this client holds the
 * whole mailbox, there is nothing further back" and "the server refused" are two true sentences, and a list that
 * renders them identically is lying about one of them. `ready` with an EMPTY `items` is a third: the server answered
 * and this view has nothing older. `nextCursor` is `null` on the last page, which is what lets a surface stop asking
 * rather than poll the end of the mailbox forever. `code` on a failure is the server's own error code, or `null` when
 * the failure never reached a server (a dead network, a bug in this client).
 */

/**
 * It is here because `error` is NOT uniformly showable text: some of what a server puts in an error message is
 * written for whoever reads a log, and some of it — the spend gate's explanation of what ran out — is written for the
 * person holding the mailbox. Only the code tells them apart, and a surface that guesses ends up printing an internal
 * vocabulary into somebody's mail.
 */
export type ListOlderOutcome =
  | { state: "unavailable" }
  | { state: "ready"; items: EngineMessage[]; nextCursor: string | null }
  | { state: "failed"; error: string; code: string | null };

// the Trash read, and putting one message back: MAIL THIS ACCOUNT DELETED IN OHMAIL, which is off-mirror by
// construction. A delete tombstones the row (`apply.ts` rule 4, `entity: null`), so the mirror holds NOTHING for a
// deleted message on any door — there is no local list to filter, and this is not a projection over `reader`. It is
// `listOlder`'s shape one verb over: the server answers a page, the view holds it in its own state, and it is gone
// when the view changes. AND THE RESTORE IS NOT AN `EngineMutation`. It cannot be: `mutate` REJECTS a mutation whose
// local effects are empty (404 `not_found`), and a mutation over a row the mirror does not hold has no local effects
// by definition. So there is no optimistic overlay and no outbox entry here; the durable record of a pressed restore
// is the intents journal the surface keeps (`delete-intents.ts`), exactly as the delete's own held window does.

/**
 * `GET /messages?view=trash&cursor=&limit=` as this client reads it.
 *
 * The items are `MessageDTO`s with two additions the list renders — `trashedAt` and a
 * server-RESOLVED `restoreTo` — so an {@link EngineMessage} plus those two, with no conversion
 * and no second shape (the same reasoning as {@link ListOlderWire}). Both are optional at the
 * type level because a client can be newer than the server it talks to: a build that predates
 * them reads `undefined` and the view falls back to the message's own date and to the inbox,
 * which is what those two values MEAN when nothing said otherwise.
 */
export interface TrashRowWire extends EngineMessage {
  trashedAt?: string;
  restoreTo?: string;
}

export interface ListTrashWire {
  items: TrashRowWire[];
  nextCursor: string | null;
}

/**
 * The transport {@link OhmailEngine.listTrash} runs on. Optional everywhere, exactly as
 * {@link ListOlderFn} is: the demo is fixtures and zero network, and a surface with no server
 * behind it must be able to say "Trash is not available here" rather than spin.
 */
export type ListTrashFn = (opts: { cursor?: string; limit?: number }) => Promise<ListTrashWire | null>;

/**
 * `POST /messages/:id/restore` as this client calls it.
 *
 * `restoreTo` is the folder the server decided on — which may not be the row's own `restoreTo`
 * if the origin folder disappeared between the page and the press — so the toast names THIS
 * value, not the one the row was rendered with. `pending` is always true and is carried rather
 * than assumed: the restore is a filing the mail server has not performed yet, and a surface
 * that treated the 200 as "done" would be claiming the mail is back.
 */
export interface RestoreFromTrashWire {
  restoreTo: string;
  pending: boolean;
}

export type RestoreFromTrashFn = (
  messageId: string,
  /**
   * The `Idempotency-Key` for this ONE intent, when the caller has a durable record of it.
   *
   * The route is `idempotent`-marked: a replay under the same key is answered with the first
   * response, where without one it met the state check and answered 409 `not_in_trash` about a
   * restore the server had already committed to. Optional because a caller with no durable
   * record has no stable key to send, and an invented one would make two presses one.
   */
  opts?: { idempotencyKey?: string },
) => Promise<RestoreFromTrashWire | null>;

/**
 * The adapter capabilities the two reach for. Declared STRUCTURALLY here, exactly as {@link
 * ListMessagesCapableAdapter} and the three beside it are, and carrying the identical wiring risk:
 * `apps/webapp/app/shell/sync-scheduler.ts` rebuilds the adapter surface as an object literal, and a literal that
 * forgets a structural capability still satisfies `EngineAdapter` — the failure is invisible in the suite and live on
 * the LIVE path only. That wrapper must spread these the way it spreads the others, conditionally and never
 * unconditionally. TWO capabilities and not one, for `ListMessagesCapableAdapter`'s own reason: a wrapper forwards
 * them one at a time, so a client can legitimately have the list and not the verb, and deriving one from the other
 * would make a control call a method that is not there.
 */

/**
 * They are reported TOGETHER by {@link OhmailEngine.trashAvailable}, because a Trash view you cannot restore from is
 * not the feature.
 */
interface ListTrashCapableAdapter {
  listTrash?: ListTrashFn;
}
interface RestoreFromTrashCapableAdapter {
  restoreFromTrash?: RestoreFromTrashFn;
}

/**
 * What one Trash page answered — {@link ListOlderOutcome}'s three states, for the same reasons.
 *
 * `unavailable` is a real answer and never an error: the demo has no server, and a surface must
 * render "Trash is not available here" rather than an empty list that reads as "you have deleted
 * nothing". `failed` carries the server's code beside its text so a surface can tell a sentence
 * written for a person from one written for a log.
 */
export type ListTrashOutcome =
  | { state: "unavailable" }
  | { state: "ready"; items: TrashRowWire[]; nextCursor: string | null }
  | { state: "failed"; error: string; code: string | null };

/**
 * What one restore answered.
 *
 * `rolled_back` is the vocabulary the held-verb window already branches on for a delete
 * (`delete-undo.ts` reads `res.status === "rolled_back"` to put the row back and say so), so the
 * restore answers in the same words rather than in a second dialect the surface would have to
 * translate. A 409 `not_in_trash` — the message is no longer there, restored from another client
 * or filed by its owner — arrives as `rolled_back` with that code, because from the surface's
 * point of view it is exactly a press that did not take effect.
 */
export type RestoreOutcome =
  | { state: "unavailable" }
  | { state: "restored"; restoreTo: string; pending: boolean }
  | { state: "rolled_back"; error: string; code: string | null };

// ── attachments ────────────────────────────────────────────────────────────
//
// ohmail STORES NO ATTACHMENT BYTES, anywhere, ever. Metadata is synced at ingest; the bytes live
// only in the user's own IMAP mailbox and are pulled from it at the moment somebody asks. What the
// types below model is therefore a CACHE WITH NO BACKING STORE: everything here dies with the tab,
// and that is the feature, not a limitation to be engineered away later.

/**
 * One attachment as a surface renders it. `mimeType` (not the wire's `contentType`) and a non-null `filename` — the
 * shape the strip is built against. {@link toAttachmentItem} is the ONE place the wire becomes this, so the fallback
 * name and the rename cannot drift into two answers. `state` is per ITEM because that is how it behaves: a message's
 * strip is a list where one file is open, one is still arriving and one failed, all at once. `objectUrl` is present
 * only in `ready`, and only until {@link OhmailEngine.releaseAttachments} revokes it.
 */
export interface AttachmentItem {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  state: "idle" | "loading" | "ready" | "failed" | "too_large";
  /**
   * Is this part one the html body REFERENCES (`cid:`) rather than one the sender attached as a
   * file — a signature logo, an embedded screenshot, a newsletter's header image.
   *
   * Carried rather than filtered away, because whether it is a "file" depends on something this
   * layer cannot see: HOW THE MESSAGE IS BEING DRAWN. In a framed rendering the html paints it
   * and listing it too would name the same picture twice. In the app's own frameless typography
   * no image is drawn at all, so an inline picture is unreachable unless something lists it —
   * which is what {@link OhmailEngine.attachmentsOf}'s `includeInlineImages` is for.
   */
  inline: boolean;
  /**
   * The part's `Content-ID` (brackets stripped at ingest), or `null` for a part carrying none.
   * It is the join key between the html body's `cid:<contentId>` references and this part —
   * what {@link OhmailEngine.loadInlineImages} matches on to draw an embedded image in place.
   */
  contentId: string | null;
  /**
   * A `blob:` URL for the fetched bytes, valid ONLY in the document that minted it.
   *
   * SAFE FOR `<img src>` AND `<a download>`. NOT safe to navigate to top-level: a `blob:` URL
   * inherits the app's origin, so a document type the browser will RENDER (SVG, HTML) executes
   * sender-controlled script as ohmail, with the session cookie in scope. The engine defends this
   * at the point the Blob is built — see {@link RENDERABLE_MIME} — rather than trusting every call
   * site to remember.
   */
  objectUrl?: string;
  /**
   * The fetched bytes, as the type-DOWNGRADED Blob the {@link objectUrl} was minted from. Present exactly when
   * `objectUrl` is, held only in memory, and dropped with the list. A preview surface reads this to parse a PDF or a
   * text part rather than re-fetching the object URL: `fetch(blob:…)` is governed by `connect-src`, and `'self'` does
   * NOT match the `blob:` scheme, so a re-fetch that passes every jsdom test dies on the deployed host. The Blob
   * already pins these bytes for the URL's lifetime, so carrying it costs nothing new. It is the POST-DOWNGRADE blob
   * (see {@link RENDERABLE_MIME}): an `image/svg+xml` part is `application/octet-stream` here, so a consumer that
   * minted its own URL from it could not reopen the document-execution hole the downgrade closes.
   */
  blob?: Blob;
  /** The server's own sentence when `state` is `failed` or `too_large`. */
  error?: string;
}

/**
 * The outcome of one message's metadata read. Never rejects, for the reason {@link ServerSearchOutcome} does not: the
 * caller is a React effect. `unavailable` is a first-class answer — the demo and the desktop tier have no server to
 * ask — and `ready` with an EMPTY `items` is a different, also-true answer that the surface must render differently.
 * The second one is COMMON rather than an edge case, and structurally so: a great many messages carry `inline` parts
 * and nothing else — an embedded logo in an HTML mail is one — and {@link OhmailEngine.attachmentsOf} withholds those
 * from a caller that did not ask for them. The paperclip is painted from `hasAttachments`, which COUNTS them. So a
 * paperclip over an empty strip is not a rare inconsistency to be tidied away; it is a state the UI has to be able to
 * say something honest about.
 */
export type AttachmentsOutcome =
  | { state: "unavailable" }
  /**
   * `retrying` is set ONLY when a human pressed the list's own retry over a held `failed`.
   * A surface renders the first ask as nothing — the read is one indexed row and a
   * skeleton on every message open would be noise — but it must NOT go silent again the moment
   * somebody presses "Try again": the row they pressed would vanish for the whole round-trip
   * and come back, which reads as "it worked" followed by "no it didn't". The flag is what lets
   * the failure row stay put and say it is asking again.
   */
  | { state: "loading"; retrying?: boolean }
  | { state: "ready"; items: AttachmentItem[] }
  /**
   * `code` and `retryable` are the SERVER'S own classification, carried through rather than re-derived from the
   * sentence — before that, only `error` survived the catch and the surface could not tell "you are offline" from
   * "that message is not yours". What can actually land here, because copy written for the wrong failure is a lie:
   * this route is `cost: "read"` and opens no IMAP adapter, so the 429 `mailbox_busy` refusal cannot reach it — what
   * does is `code: "network"` (the fetch itself rejected), a 5xx from ohmail's own API, or a definite 4xx (401 after
   * a session ends, 404 for a message this account cannot see). `retryable` is TRUE for anything the client could not
   * classify: an unclassified throw never established that the server refused, and re-asking costs one indexed row.
   */

  /**
   * `code: "timeout"` is the third arrival — a request the server accepted and never answered used to produce no
   * outcome at all; it now arrives bounded and aborted from `HttpAdapter.withDeadline`, retryable for the strongest
   * version of the reason above: nothing refused us, nothing even spoke.
   */
  | { state: "failed"; error: string; code: string | null; retryable: boolean };

/**
 * The MIME types whose bytes may keep their real content type on a client-minted Blob. Everything else is minted
 * `application/octet-stream`, which makes a browser DOWNLOAD it rather than render it. This closes the one hole the
 * server's own defences cannot: `GET /attachments/:id` sets `Content-Disposition: attachment` and
 * `X-Content-Type-Options: nosniff`, but an object URL created here from the response body carries NEITHER — the
 * headers described the response, and the Blob is a new thing with only a type. An `image/svg+xml` attachment opened
 * in a tab would then run its own `<script>` on ohmail's origin. The list is what a strip actually renders inline,
 * and nothing more. SVG is deliberately absent despite being an image: it is a document format that executes script.
 * 18 such attachments exist in the live corpus, so this is a real case and not a hypothetical one.
 */
const RENDERABLE_MIME = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf",
]);

/**
 * Wire → surface, in one place (the mapper the whole strip is rendered from).
 *
 * The filename fallbacks are the SERVER'S own stems for a nameless part (`attachments-service.ts`
 * `uniqueName`): `invite.ics` for a calendar part — the COMMON nameless case, because Google and
 * Outlook nest the invitation as an unnamed `text/calendar` alternative — and
 * `attachment-${id}.bin` for everything else. Matching them deliberately: the name in the strip
 * is then the same name that appears in a download-all zip entry, so a user reading both sees
 * one file, not two.
 */
function toAttachmentItem(wire: AttachmentWire): AttachmentItem {
  return {
    id: wire.id,
    filename:
      wire.filename?.trim() ||
      (isCalendarMime(wire.contentType || "") ? CALENDAR_FALLBACK_FILENAME : `attachment-${wire.id}.bin`),
    mimeType: wire.contentType || "application/octet-stream",
    sizeBytes: wire.sizeBytes,
    state: "idle",
    inline: wire.inline === true,
    contentId: typeof wire.contentId === "string" && wire.contentId !== "" ? wire.contentId : null,
  };
}

/**
 * Is this part a PICTURE — the only kind of inline part a surface may promote to the strip.
 *
 * `image/*` and nothing wider. An inline `text/calendar` or a `cid:`-referenced stylesheet is not
 * something a reader looking at a frameless rendering is missing, so promoting it would be adding
 * a row nobody asked about. SVG is deliberately included here and refused one layer up by the
 * surface's own preview gate — the same posture every other SVG attachment gets, rather than a
 * second, differently-shaped refusal in this file.
 */
function isPictureItem(item: AttachmentItem): boolean {
  return item.mimeType.startsWith("image/");
}

/**
 * The MIME types an embedded (`cid:`) image may carry into the mail
 * document as a `data:` URI — a strict subset of {@link RENDERABLE_MIME}:
 * the four raster types, nothing else. SVG is a document format that
 * executes script; "the sandbox would have caught it" is not a reason to
 * open the first gate. Checked twice per part, deliberately: against the
 * declared type before bytes are paid for, and against the fetched Blob's
 * OWN type before the URI is minted — the declaration is the sender's
 * claim; the post-downgrade Blob type is what a browser will honour.
 */
const INLINE_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The per-part ceiling on an automatically fetched embedded image — 4 MiB.
 * Covers both real populations (signature logos and newsletter art at tens
 * to hundreds of KB; pasted screenshots up to a few MB). The cost is not
 * just the fetch: the image lands in the frame as base64 (+33%), ~5.6 MB
 * at this ceiling. A part over it stays a blanked box — what every message
 * showed before this existed — and remains reachable through the strip's
 * explicit-press fetch, which allows the server's 32 MiB.
 */
export const INLINE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The per-message ceilings on the same automatic fetch: at most 12 parts,
 * at most 16 MiB of DECLARED payload, taken in document-reference order so
 * the images a reader sees first win the budget. The trigger is opening a
 * message and each fetch is the most expensive read in the product (one
 * short-lived IMAP connection, {@link OhmailEngine.openAttachment}); a
 * hostile message can reference any number of `cid:` parts, and a bound
 * chosen by the sender is not a bound. Twelve covers every legitimate
 * shape measured while capping what one open can spend.
 */
export const INLINE_IMAGE_MAX_PARTS = 12;
export const INLINE_IMAGE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/** The stable empty answer of {@link OhmailEngine.inlineImagesOf} — one identity, never mutated. */
const NO_INLINE_IMAGES: ReadonlyMap<string, string> = new Map();

/**
 * The per-part ceiling on an AUTOMATICALLY fetched calendar part, in bytes — 256 KiB.
 *
 * Real invites are 1–4 KB (the live corpus's 646 calendar parts top out at 4 035 bytes), so this
 * is two orders of magnitude of headroom, and it is an order of magnitude UNDER the inline-image
 * ceiling because the payload is a text file, not a photograph. A part over it is not fetched by
 * the automatic pass and stays an ordinary tile — the reader can still press it.
 */
export const CALENDAR_TEXT_MAX_BYTES = 256 * 1024;

/**
 * At most this many calendar parts fetched automatically per message. Real meeting mail carries
 * exactly one; a hostile message can declare hundreds, and each fetch is an IMAP connection.
 */
export const CALENDAR_TEXT_MAX_PARTS = 3;

/** The stable empty answer of {@link OhmailEngine.calendarTextsOf} — one identity, never mutated. */
const NO_CALENDAR_TEXTS: ReadonlyMap<string, string> = new Map();

/** The parts the automatic calendar pass may consider: real files declared as calendar data. */
function isCalendarItem(item: AttachmentItem): boolean {
  return !item.inline && isCalendarMime(item.mimeType);
}

/**
 * The fetched bytes of one embedded image, as a `data:` URI — or `null` for
 * anything that is not a small raster image. Both refusals here are the
 * enforcement (the declared-type pre-filter is the optimisation):
 * `blob.type` must be in {@link INLINE_IMAGE_MIME} — the post-downgrade
 * type, so an SVG arrives as `application/octet-stream` and can never be
 * minted, and nothing sender-controlled is spliced into the scheme; and
 * `blob.size` is the real byte count against {@link INLINE_IMAGE_MAX_BYTES}
 * — the metadata size the pre-filter read is only the sender's claim.
 */
async function mintInlineDataUrl(blob: Blob): Promise<string | null> {
  const type = blob.type.toLowerCase();
  if (!INLINE_IMAGE_MIME.has(type)) return null;
  if (blob.size === 0 || blob.size > INLINE_IMAGE_MAX_BYTES) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000; // String.fromCharCode is applied per-chunk: one call over MBs overflows the arg limit.
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

/**
 * The inverse codec of {@link mintInlineDataUrl}'s encode half, for the sent-copy attachment seed:
 * the compose surface read the picked bytes INTO base64 (`ComposeAttachment.contentBase64`), and
 * the seed reads them back out to hold the same Blob a real fetch would have minted. `atob` for the
 * same reason `btoa` above — present in every browser and in node ≥ 16, so the engine stays free of
 * `Buffer`. `null` for anything undecodable rather than a throw: the caller degrades to a
 * metadata-only item, never to a failed send overlay.
 */
function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * THE DRAIN POLICY'S CONSTANTS, RE-EXPORTED — defined once in `@trafficflow/core/drain-policy`
 * and shared with the desktop sidecar's mirror (INSTANT-ARCH §6.7, stage 7's first adopted
 * responsibility, which retired the mirror's own copies of both). They
 * are re-exported from here, rather than moved off the engine's public surface, because every
 * consumer in the tree already imports them from `@ohmail/client-engine` and a policy module is
 * not a reason to churn twenty call sites. The reasoning behind each number lives beside its
 * definition.
 */
export { STALE_RESUME_MS, BACKLOG_PAGE_LIMIT } from "@trafficflow/core/drain-policy";

/**
 * The meta key under which a completed drain stamps its own clock — the mirror's record of "when
 * was this device last caught up", read by nothing but the staleness comparison in
 * `@trafficflow/core/drain-policy`. Engine clock on both sides (`opts.now`), never `serverTime`:
 * cross-machine skew cannot touch a comparison whose two operands come from the same clock.
 *
 * The sidecar's mirror keeps the SAME fact under `CursorState.lastDrainAt` in its cursor file —
 * a different persistence, deliberately, because the two drivers own different stores; what they
 * share is the comparison, not the place it is written.
 */
export const LAST_DRAIN_AT_META = "lastDrainAt";

/**
 * WHICH SNAPSHOT'S ROWS THE MIRROR IS HOLDING — the durable half of the abandoned-prefix sweep. `GET /sync/snapshot`
 * stamps every row it emits with the SAME `asOfSeq`, and {@link OhmailEngine.runSnapshot} commits the cursor only
 * with the LAST page. So a bootstrap interrupted mid-stream leaves the mirror at cursor "0" holding a PREFIX of a
 * snapshot taken at some point in the past, and this key is where that point is written down — durably, before the
 * first row of the attempt lands, because the alternative is a variable in one process's memory and a crash is
 * precisely the case that matters. See {@link OhmailEngine.runSnapshot} for what the next attempt does with it.
 */
export const SNAPSHOT_PREFIX_SEQ_META = "snapshotPrefixSeq";

/**
 * THE FRESHNESS CONTRACT'S THREE STATES, and the value a surface renders — re-exported from
 * `@trafficflow/core/drain-policy`, where the derivation that produces them lives beside them.
 *
 * `MirrorFreshness.asOf` is {@link LAST_DRAIN_AT_META} verbatim: the engine-clock instant of the
 * last COMPLETED drain, or `null` exactly when `state` is `"unknown"`. Surfaces format it; they
 * never parse meta themselves.
 */
export type { FreshnessState, MirrorFreshness } from "@trafficflow/core/drain-policy";

export interface EngineOptions {
  adapter: EngineAdapter;
  /**
   * Override the archive transport. The shipped path takes it from the adapter (see
   * {@link ServerSearchCapableAdapter}); this exists so a test can drive the whole seam
   * without an adapter, and so a host that reaches `/search` some other way can supply it.
   */
  serverSearch?: ServerSearchFn;
  /** The address arm's override, on `serverSearch`'s rule and for its reasons. */
  serverAddressSearch?: ServerAddressSearchFn;
  /** Defaults to an in-memory mirror (SSR/tests); pass IndexedDbMirrorStore on web. */
  store?: MirrorStore;
  /**
   * How much of the mailbox to keep locally. ABSENT ⇒ `{ mode: "full" }` — see
   * {@link StorePolicy}. Enforced by one pass at the end of each successful drain.
   */
  storePolicy?: StorePolicy;
  /** Optional `?types=` filter for /sync. */
  types?: string[];
  /** Page size for the drain loop. */
  syncLimit?: number;
  /**
   * Override {@link STALE_RESUME_MS}. A test seam: the shipped paths never pass it, so the one
   * number above is the one every client uses.
   */
  staleResumeMs?: number;
  /**
   * EAGER RECENT-WINDOW HYDRATION (owner ruling, 2026-08-21). Arms {@link OhmailEngine.prefetchRecentBodies}: hydrate
   * the bodies of the mirror's newest {@link EAGER_BODIES_MAX} messages in the background, so opening any recent
   * message finds its body already local instead of paying a round trip (~100 ms warm, seconds on a serverless cold
   * start) at the moment of intent. The mirror IS the recent window every list surface renders; the archive tail is
   * not in it and stays fetch-on-open. The shell's sync scheduler calls the pass after each settled drain — the
   * engine never fires it on its own. OPT-IN, deliberately: the webapp shell and the desktop window pass `true`; an
   * embedder that never asked — apps/mobile with its windowed bootstrap semantics — changes nothing by upgrading this
   * package, and even a driver that calls the pass gets a no-op until the embedder means it.
   */
  eagerBodies?: boolean;
  now?: () => Date;
  uuid?: () => string;
  /**
   * Override {@link OUTBOX_REPLAY_DEADLINE_MS}. A test seam, exactly like `staleResumeMs`: the
   * shipped paths never pass it, so the one number below is the one every client uses.
   */
  outboxReplayDeadlineMs?: number;
  /**
   * WHO REPLAYS THE OUTBOX. `true` (the default, and the webapp's shape): the engine's own drives replay restored and
   * unowned entries before each drain — the webapp dispatches most verbs fire-and-forget and flushes only around
   * sends, so the drive is the only retry those verbs will ever get. `false` (the mobile shape): the drive replays
   * NOTHING and every entry — restored included — waits for the host's own `flushPending` cadence, because that host
   * routes EVERY returned result (the mobile ledger toasts a background confirmation as the send it was and a hard
   * refusal as the save that failed, keyed off `pendingMutations()` before the flush). Handing the drive those
   * entries would settle them silently. Restore itself is unaffected either way: overlays re-apply with the store's
   * load, and the entries sit visibly in `pendingMutations()` until their owner flushes.
   */
  outboxAutoReplay?: boolean;
}

/**
 * HOW LONG the boot replay waits on ONE restored verb's request before it stops waiting and
 * drains anyway. The replay runs inside the engine's single-flight, so an unbounded await on a
 * half-open socket would hold EVERY later sync hostage — no bootstrap, no mail, for the life of
 * the session. The timed-out dispatch keeps running and keeps OWNING its entry:
 * it settles it, re-queues it, or leaves it persisted for the next boot — the deadline only
 * stops the drive from waiting, never the verb from landing.
 */
export const OUTBOX_REPLAY_DEADLINE_MS = 10_000;

/**
 * REFUSALS THAT ARE A STATE MACHINE WORKING, NOT A FAULT — they spend none of the give-up ceiling. `send_queued` and
 * `send_in_flight` are the gated send's own vocabulary: the server HAS the reservation and an attempt is live or was
 * left live by a crashed invocation. Both arrive with an ordinary numeric status and no `Retry-After`, so {@link
 * OhmailEngine.serverAnswered} counted them as unmodelled server failures — and eight of them would abandon a send
 * whose SMTP submission may still be running. That is the worst possible thing to give up on: the overlay drops, the
 * composer unlocks, and the next press mints a FRESH key, which is a second delivery of a message the first attempt
 * may have already sent. The whole reservation design exists to make that impossible. These are waits, and a wait is
 * not evidence about the verb.
 */

/**
 * `send_unverified` and `send_failed` are deliberately absent: both are already non-retryable and never reach this
 * test.
 */
const MODELLED_WAIT_CODES = new Set([
  // The gated send's own vocabulary: the server HAS the reservation and an attempt is live or was
  // left live by a crashed invocation.
  "send_queued",
  "send_in_flight",
  // A duplicate refused while the FIRST attempt is still `pending`, which is the same kind of
  // answer as the two above: the server HAS a reservation for this content and cannot say yet how
  // it ended. It is retryable precisely so the client keeps asking until it can.
  //
  // Missing from this set it was counted as an unmodelled server failure, and the arithmetic
  // decided the outcome: eight refusals at the web retry cadence is ~255 seconds, while the
  // server's own stale recovery does not run until `SEND_STALE_AFTER_MS` (ten minutes). The verb
  // was abandoned as `send_unverified` BEFORE the thing it was waiting for could happen — so a
  // first attempt that then failed left a reclaimable claim nobody ever retried, and the message
  // was simply lost. A wait shorter than the wait it is waiting on is not a wait.
  "duplicate_send",
  // The desktop sidecar's DELIBERATE refusal while the hosted mailbox is unreachable
  // (`apps/sidecar/src/cloud-proxy.ts#offlineResponse`): `503`, `retryable: true`, and NO
  // `Retry-After`, because it does not know when the network returns. It is the offline case
  // wearing a server's clothes — an ordinary Cloud outage would otherwise abandon eight verbs'
  // worth of a person's work on reconnect, which is the exact loss the `network` carve-out
  // exists to prevent and was missed only because this one arrives with a status.
  "offline_read_only",
  // The response to an unreadable answer on a 2xx (`readJsonOrAmbiguous`): the server acted and
  // we cannot read what it said. Ambiguity is not evidence that the verb is bad.
  "unreadable_response",
]);

/**
 * The give-up ceiling, and why a durable outbox needs one. A retryable rejection used to re-queue with no counter and
 * no end — right for the offline laptop, wrong for a verb the server refuses identically for ever: `HttpAdapter`
 * classifies any unhandled 500 as retryable, so one mis-shaped request could become a permanent background loop
 * surviving restarts, holding the overlay open and telling nobody. So: {@link OUTBOX_MAX_SERVER_FAILURES}
 * SERVER-ANSWERED failures and the verb is abandoned — visibly, into {@link OUTBOX_ABANDONED_TYPE}, where a person
 * retries or discards. Only a server-answered failure counts, and that distinction is the design: `code: "network"`
 * and `"timeout"` never count — an offline laptop must retry for ever; the verb is fine, the wire is not.
 */

/**
 * Nor does a refusal naming its own interval — a `503 db_busy` with `Retry-After` is a server declining work it KNOWS
 * it cannot do yet, and without that carve-out a twenty-minute pool outage would abandon every legitimate verb in
 * flight. The counter counts only evidence that the server looked at this verb and failed in a way nobody modelled.
 */
export const OUTBOX_MAX_SERVER_FAILURES = 8;

/**
 * The first backoff after a server-answered failure, doubling to {@link OUTBOX_BACKOFF_CAP_MS}. 30 s rather than
 * brisk because the retry buys nothing on its own: the verb already has its Idempotency-Key, so there is no race to
 * win, and a poisoned verb retried quickly is just a faster loop. The window is ~63 MINUTES, and this comment once
 * said four hours: eight failures means seven waits (30 s, 1, 2, 4, 8, 16, 32 minutes = 3 810 s), so the cap is never
 * reached by a countable failure and binds only a server-named `Retry-After`. An hour is the right span — a brief
 * incident repairs inside the window, and somebody returning after lunch is told rather than left with a spinner. If
 * it should be longer, the ceiling is the knob — and doubling it adds EIGHT hours, not four: failures 8 through 15
 * each wait the full cap.
 */

/**
 * Stated because the last version was arithmetic nobody had done, and a number that sounds measured is taken on
 * trust.
 */
export const OUTBOX_BACKOFF_BASE_MS = 30_000;

/** The ceiling on one wait. Beyond an hour the retry is no longer the thing that will fix it. */
export const OUTBOX_BACKOFF_CAP_MS = 3_600_000;

/**
 * HOW OLD an UNKEYED CREATE may be and still replay — the server's own `idempotencyExpiry`
 * (24 h), mirrored as a literal for the same reason every compose-cap mirror is: this bundle
 * pulls in no server module. Only `rule_create` and a first `draft_save` are judged by it; see
 * the restore loop for why every other verb replays at any age.
 */
export const OUTBOX_UNKEYED_CREATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How many of the mirror's newest messages one eager pass offers a body fetch.
 *
 * Sized to cover what the list surfaces actually present — the Ohbox's groups, Reads, Receipts
 * are each windows of hundreds — while keeping the worst-case pass bounded: a thousand bodies at
 * the hosted average is tens of megabytes ONCE, and every later pass costs nothing because a
 * `ready` record is never re-fetched ({@link OhmailEngine.bodyPlan}). A whole mailbox would be
 * hundreds of megabytes, which is why the tail deliberately never enters the pass.
 */
export const EAGER_BODIES_MAX = 1000;

/**
 * How many ids one eager step hands the batch machinery before re-checking its generation.
 *
 * Two server batches' worth. The step boundary is what makes the pass abortable (a navigation
 * or teardown bumps the generation and the next step sees it) and what keeps the four-slot
 * queue shared: a single 1,000-id call would enqueue fifty chunks ahead of every Screener
 * preview, while urgent opens always bypass the queue either way.
 */
export const EAGER_BODIES_SLICE = 2 * BODIES_IDS_MAX;

/** Minimal EventSource-shaped surface (an attach point, not a dependency). */
export interface WakeSignalSource {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Read-through view: the mirror with the optimistic overlay applied on top. */
class OverlayReader implements EntityReader {
  constructor(
    private readonly store: MirrorStore,
    private readonly overlays: Map<string, MutationEffect[]>,
    private readonly rev: () => number,
  ) {}

  private overlayFor(type: string, id: string): MutationEffect | undefined {
    let hit: MutationEffect | undefined;
    for (const effects of this.overlays.values()) {
      for (const e of effects) if (e.type === type && e.id === id) hit = e; // last wins
    }
    return hit;
  }

  get<T = unknown>(type: string, id: string): T | undefined {
    const o = this.overlayFor(type, id);
    if (o) return o.entity === null ? undefined : (o.entity as T);
    return this.store.get<T>(type, id);
  }

  entries<T = unknown>(type: string): Array<{ id: string; entity: T }> {
    if (this.overlays.size === 0) return this.store.entries<T>(type);
    const byId = new Map<string, T>();
    for (const e of this.store.entries<T>(type)) byId.set(e.id, e.entity);
    for (const effects of this.overlays.values()) {
      for (const e of effects) {
        if (e.type !== type) continue;
        if (e.entity === null) byId.delete(e.id);
        else byId.set(e.id, e.entity as T);
      }
    }
    return [...byId.entries()].map(([id, entity]) => ({ id, entity }));
  }

  list<T = unknown>(type: string): T[] {
    if (this.overlays.size === 0) return this.store.list<T>(type);
    return this.entries<T>(type).map((e) => e.entity);
  }

  version(): number {
    return this.store.version() * 1_000_003 + this.rev();
  }
}

/**
 * The most body fetches in the air at once, across all messages.
 *
 * Four rather than one: a thread of a handful of messages should still fill in at roughly the
 * speed it does today, and browsers cap per-host connections in this region anyway — the point is
 * to stop a forty-message sender from opening forty at once, not to serialise reading.
 */
const MAX_CONCURRENT_BODIES = 4;

/**
 * HOW MANY OF THE MESSAGES A SURFACE LAST ASKED TO RENDER THE WINDOWED PRUNE HOLDS ON TO. Exported because it is a
 * policy number a guard depends on, and a guard that hand-copies the number it is checking goes green against a
 * shipped value it has never seen. Sized so that everything one screen can hold fits several times over — the widest
 * caller is the Screener preview, which hydrates one sender's whole held list in a single effect, and forty is the
 * largest such list this codebase has had a defect about ({@link MAX_CONCURRENT_BODIES}). It is a HOLD, not a cache:
 * it never touches the store, it dies with the tab, and its only effect is to keep the windowed prune off rows a
 * reader is looking at.
 */
export const RENDERED_PINS = 64;

/**
 * HOW LONG AN OPTIMISTIC SENT COPY STANDS before it is dropped on TTL alone. The overlay's real job is to bridge the
 * gap between "the server confirmed the send" and "the worker's Sent-folder watch ingested the copy", which is
 * normally minutes; {@link OhmailEngine.reconcileOptimisticSent} drops it the moment the real row arrives, so this
 * ceiling only bites when that ingest never lands in this session (the tab is closed, the mailbox is slow). Ten
 * minutes is past the ordinary Sent-watch latency and matches `SEND_STALE_AFTER_MS` on the server, so a copy that
 * outlives it is genuinely one whose real row this session will not see, and a stale "sent" row is worse than none —
 * the conversation would carry a message the mirror cannot confirm.
 */
export const OPTIMISTIC_SENT_TTL_MS = 10 * 60 * 1000;

/**
 * How many inherited parts a FORWARD's optimistic sent copy may list — the mirror of the send
 * service's `FORWARD_MAX_PARTS`, kept as a literal because this bundle pulls in no server module
 * (the same rule every compose-cap mirror follows). The send streams at most this many of the
 * original's parts onto the outgoing mail, so a projection listing more would claim files the
 * recipient never got.
 */
export const SENT_FORWARD_MAX_PARTS = 100;

export class OhmailEngine {
  readonly store: MirrorStore;
  private readonly adapter: EngineAdapter;
  private readonly types: string[] | undefined;
  private readonly syncLimit: number | undefined;
  private readonly now: () => Date;
  private readonly uuid: () => string;

  private readonly overlays = new Map<string, MutationEffect[]>();
  private overlayRev = 0;
  /**
   * THE OPTIMISTIC SENT COPIES, keyed by their overlay id — the confirm-time half of `mail_send`.
   *
   * Each names the entry it added to {@link overlays} (a provisional Sent message), the
   * `messageIdHeader` the real row will arrive under, and when it expires. It is SEPARATE from the
   * mutation overlays on purpose: a mutation overlay is dropped the instant its own request
   * resolves (`dispatch`), and this one must OUTLIVE that — it stands from the send's confirmation
   * until the worker's Sent-folder watch ingests the real row minutes later. {@link
   * reconcileOptimisticSent} drops each when its header appears in the mirror or its TTL passes.
   */
  private readonly optimisticSent = new Map<string, { header: string; expiresAtMs: number }>();
  private readonly queue: PendingMutation[] = [];
  /**
   * See {@link OhmailEngine.abandoned} — a stable snapshot for `useSyncExternalStore`, keyed on
   * the store's own version rather than invalidated by hand.
   */
  private abandonedCache: { v: number; out: AbandonedMutation[] } | null = null;
  /**
   * OVERLAYS WHOSE ECHO HAS NOT BEEN APPLIED YET, overlay id → the {@link drainEpoch} captured when the mutation's
   * POST returned. An entry lands here when the post-confirm reconcile drain FAILED (or was deliberately deferred by
   * the boot replay), and its overlay then STANDS — the user's intent stays on screen — until a drain whose page loop
   * began at a LATER epoch completes successfully. Seq order makes that sufficient: a drain issued after the POST
   * returned reads a log that already holds the mutation's rows (see {@link OhmailEngine.syncFresh}), so its success
   * means the echo is in the mirror and the overlay is redundant. This is INSTANT-ARCH §6.2(c): the overlay's
   * lifetime is bound to the verb, not to any single drain attempt — the retry itself is the scheduler's ordinary
   * (bounded, backed-off) cadence, so no new retry loop exists here.
   */
  private readonly awaitingEcho = new Map<string, number>();
  /** Count of drains whose page loop has BEGUN — the happens-before token {@link awaitingEcho} compares. */
  private drainEpoch = 0;
  /** {@link OhmailEngine.restoreOutbox}'s latch. */
  private outboxRestored = false;
  /**
   * TRUE once the store is known to hold what disk holds — `hydrate()` resolved, or a host called
   * `restoreOutbox()` after loading it itself. {@link restoreOutboxIfLoaded} reads this so the
   * drive cannot latch the restore over a store that has not been read.
   */
  private storeLoaded = false;
  /** See {@link OUTBOX_REPLAY_DEADLINE_MS}; overridable only through the test seam. */
  private readonly replayDeadlineMs: number;
  /**
   * THE GATE'S OWN STATE: THE ORDER BARRIER A TIMED-OUT DISPATCH LEAVES BEHIND: The still-in-flight dispatch, held
   * until it settles. While it stands, NO further outbox dispatch may start on ANY road, because the hung request may
   * yet commit and a verb dispatched behind it could land an older value after a newer one on the server. It clears
   * itself on settle; a process death clears it the honest way — every still-owed verb is persisted and replays in
   * order next boot. It used to be called `replayHold` and to have a short-lived twin, `replayActive`, which armed
   * for the whole of each attempt so that a fresh verb WAITED rather than queued.
   */

  /**
   * The twin is gone: {@link outboxGate} is a promise chain, so joining it IS waiting out whatever is in flight, and
   * every dispatch on that chain is deadline-bounded — a waiter can no longer inherit a hung request's unboundedness,
   * which was the only reason the twin needed to exist separately. What is left is the one distinction that is real:
   * a bounded wait you JOIN, and a hold that may stand for minutes, which a person pressing Send must never be made
   * to sit through. The gate honours this before releasing a queued caller; `mutate` reads it synchronously first,
   * and queues the verb rather than joining at all.
   */
  private outboxHold: Promise<void> | null = null;
  /**
   * Retries refused THIS SESSION whose durable marker could not be written — id to reason.
   *
   * Not a cache and not an optimisation: it is the only place the refusal exists when storage
   * would not take it. `abandoned()` merges it, so the control is disabled for the rest of the
   * session even though a reboot will offer it again — which is honest, because after a reboot
   * the store genuinely does not know.
   */
  private readonly refusedLocally = new Map<string, string>();
  /**
   * Terminal outcomes this session could not WRITE — id to the record it wanted to store.
   *
   * The durable row is still live on disk, so a reboot replays the verb; this is what keeps it
   * visible and operable until then, rather than leaving it referenced by nothing.
   */
  private readonly abandonedLocally = new Map<string, PersistedOutboxEntry>();
  /**
   * Answers that arrived AFTER their dispatch deadline, waiting for the next `flushPending`.
   *
   * A verb whose request outlived its deadline is owned by that in-flight attempt and is not on
   * the queue, so nothing else would ever produce a result for it — and the two families a
   * surface waits on (a send's settlement, a create's server id) exist nowhere else.
   */
  private readonly lateResults = new Map<string, MutationResult>();
  /**
   * Verbs currently ON THE WIRE — dispatched, not yet settled.
   *
   * They are in no other collection: `dispatch` takes them off the queue before the request goes
   * out. So a newer verb expressed while one is in flight could not see it, and supersession
   * silently skipped it — then the in-flight verb failed retryably, went back on the queue AFTER
   * the newer one had taken its snapshot, and replayed over the state the newer one established.
   * Both requests succeed and the older value wins, which is the whole class this lane exists to
   * close, arriving through the one door supersession could not look through.
   */
  private readonly inFlight = new Map<string, PendingMutation>();

  /**
   * The abandoned record for an id, from disk OR from the session-local fallback.
   *
   * Both controls used to read the durable collection alone while `abandoned()` merged the
   * fallback in — so a record whose terminal transition could not be written was LISTED with a
   * working-looking Retry and Discard, and both did nothing: Retry answered "this build cannot
   * retry that" because it found no row, and Discard deleted a row that was not there. A control
   * that is shown and inert is worse than one that is hidden, because the person presses it and
   * believes something happened.
   */
  private abandonedRecordOf(id: string): PersistedOutboxEntry | null {
    const row = this.store.entries<unknown>(OUTBOX_ABANDONED_TYPE).find((r) => r.id === id);
    if (row !== undefined && isPersistedOutboxEntry(row.entity)) return row.entity;
    return this.abandonedLocally.get(id) ?? null;
  }
  /** Bumped whenever {@link refusedLocally} changes, so the snapshot below cannot serve a stale row. */
  private localRefusalRev = 0;
  /** {@link EngineOptions.outboxAutoReplay}, resolved once. */
  private readonly autoReplayOn: boolean;
  /** Session-monotonic outbox tiebreak; seeded past every restored entry's `n`. */
  private outboxSeq = 0;
  private readonly listeners = new Set<() => void>();
  private readonly readerView: OverlayReader;
  private searchCache: { version: number; index: SearchIndex } | null = null;
  private syncing: Promise<void> | null = null;
  /** The in-flight mirror read, so concurrent callers coalesce. See {@link OhmailEngine.hydrate}. */
  private hydrating: Promise<void> | null = null;
  /** {@link EngineOptions.eagerBodies}, resolved once. */
  private readonly eagerBodiesOn: boolean;
  /** The in-flight eager pass — single-flight; a kick during a pass queues exactly one more. */
  private eagerRun: Promise<void> | null = null;
  private eagerAgain = false;
  /** Bumped by {@link OhmailEngine.stopEagerBodies}; a running pass checks it between steps. */
  private eagerGen = 0;
  /** In-flight body fetches by message id — see {@link OhmailEngine.hydrateBody}. */
  private readonly bodyRequests = new Map<string, Promise<void>>();
  /**
   * The messages a surface has most recently asked to render, oldest first, capped at
   * {@link RENDERED_PINS}. Read by {@link OhmailEngine.pinnedMessageIds}; written by
   * {@link OhmailEngine.hydrateBody}, which is the call every reading surface already makes.
   */
  private readonly renderedIds = new Set<string>();
  /**
   * In-flight body fetches, and the ones waiting for a slot. See {@link bodySlot}.
   *
   * A waiting entry carries the message ids it is FOR, because "urgent jumps the queue" has to
   * hold for a message that is already queued: an open arriving after a background pass has
   * registered that id finds the in-flight promise and would otherwise wait behind the backlog.
   * See {@link promoteBodyRequest}.
   */
  private bodyActive = 0;
  private readonly bodyQueue: Array<{ ids: readonly string[]; start: () => void }> = [];
  /**
   * WHEN THIS ENGINE STARTED, epoch ms — the line a `failed` body record is compared against.
   *
   * See {@link MessageBodyRecord.failedAt}: "never re-ask a server that refused" is a rule about
   * one session, and these records are persisted, so without a boot stamp it was a rule about for
   * ever. Read from `this.now` rather than `Date.now` so a test with a fixed clock gets the
   * in-session behaviour (`failedAt === bootedAt` is not "before"), which is the arm that must not
   * change.
   */
  private readonly bootedAt: number;
  /**
   * The ids whose stale `failed` record this session has ALREADY re-asked once.
   *
   * In memory, never persisted, and it is what makes the heal terminate as a property of the
   * ENGINE rather than of the mirror. `failBody`'s write can itself be refused — a full quota, a
   * private window — which would leave the old stamp-less record in place and put the re-ask
   * straight back on the table for the next render. One entry here closes that, the same way
   * `fetchBodyInto` normalising `html` closes the re-read loop.
   */
  private readonly bodyHealed = new Set<string>();
  /** The batch body read, or `null` when this adapter has none — see {@link FetchBodiesCapableAdapter}. */
  private readonly fetchBodiesFn: FetchBodiesFn | null;
  /** The archive transport, or `null` when this client has no server behind it. */
  private readonly serverSearchFn: ServerSearchFn | null;
  /** The archive's ADDRESS transport, or `null` — resolved by the same rule, independently. */
  private readonly serverAddressSearchFn: ServerAddressSearchFn | null;
  /** `GET /sync/snapshot`, or `null` when this adapter has no such route — see {@link SnapshotCapableAdapter}. */
  private readonly snapshotFn: SnapshotFn | null;
  /**
   * Latched TRUE once the snapshot route has proven unusable on its FIRST page — see
   * {@link OhmailEngine.runSnapshot}. It bounds the cost of a client that ships ahead of the
   * server to exactly one wasted request per engine, rather than one per drain forever.
   */
  private snapshotUnavailable = false;
  /** How much of the mailbox to keep. Resolved once; `full` when the host said nothing. */
  private readonly storePolicy: StorePolicy;
  /** See {@link STALE_RESUME_MS}; the option exists for tests. */
  private readonly staleResumeMs: number;
  /** In-flight archive passes by query key — see {@link OhmailEngine.searchServer}. */
  private readonly serverSearches = new Map<string, Promise<ServerSearchOutcome>>();
  /** In-flight archive ADDRESS passes, keyed as `searchServer`'s are — see that method. */
  private readonly serverAddressSearches = new Map<string, Promise<ServerAddressOutcome>>();
  /** `GET /messages`, or `null` when this adapter has none — see {@link ListMessagesCapableAdapter}. */
  private readonly listOlderFn: ListOlderFn | null;
  /** The Trash page transport, bound once in the constructor. See {@link ListTrashFn}. */
  private readonly listTrashFn: ListTrashFn | null;
  /** The restore verb's transport, bound once in the constructor. See {@link RestoreFromTrashFn}. */
  private readonly restoreFromTrashFn: RestoreFromTrashFn | null;
  /** In-flight Trash pages by cursor+limit — single-flight, {@link OhmailEngine.listOlder}'s rule. */
  private readonly trashPages = new Map<string, Promise<ListTrashOutcome>>();
  /** In-flight restores by message id, so a double press is one request. */
  private readonly restoreCalls = new Map<string, Promise<RestoreOutcome>>();
  /** In-flight out-of-window pages by view+cursor — see {@link OhmailEngine.listOlder}. */
  private readonly olderPages = new Map<string, Promise<ListOlderOutcome>>();

  /**
   * Attachment metadata + byte state by message id.
   *
   * IN MEMORY, NEVER `store.putLocal`, and that is a correctness requirement rather than a
   * preference. ohmail stores no attachment bytes anywhere — not server-side, not here — and an
   * `objectUrl` is only valid for the lifetime of the document that minted it. A record persisted
   * to IndexedDB would come back after a reload still holding a `blob:` string pointing at nothing,
   * and the surface would render a `ready` attachment whose image is permanently broken. Scoping
   * this to the tab is what makes "fetched on demand, held for the session" true.
   */
  private readonly attachmentLists = new Map<string, AttachmentsOutcome>();
  /**
   * The sent-copy seeds — which {@link attachmentLists} entries were written by {@link
   * OhmailEngine.materializeSentOverlay} from the send's own bytes, keyed by the optimistic copy's message id,
   * expiring with its {@link optimisticSent} entry. The copy's id exists on no server, so a metadata read against it
   * can only 404 — a reader opening the message they just sent watched its attachment vanish until the real Sent row
   * was opened. The seed is the answer the engine already holds; this map is its LIFECYCLE: while `live`, {@link
   * OhmailEngine.releaseAttachments} declines to drop it (a pane unmount must not turn a re-open back into the 404),
   * `reconcileOptimisticSent` clears `live` when the copy retires, and the TTL sweep is the backstop.
   */

  /**
   * `forwardOf` marks a FORWARD's copy, whose delivered message carries parts this client never held: its seed
   * composes `composeItems` plus the parent's own metadata ({@link OhmailEngine.recomposeForwardSeed}), and its
   * metadata reads delegate to the parent's REAL id — the one id a server can answer for.
   */
  private readonly sentAttachmentSeeds = new Map<string, {
    live: boolean;
    expiresAtMs: number;
    forwardOf?: string;
    composeItems: AttachmentItem[];
  }>();
  /** In-flight metadata reads by message id — single-flight, see {@link OhmailEngine.loadAttachments}. */
  private readonly attachmentListRequests = new Map<string, Promise<AttachmentsOutcome>>();
  /** In-flight byte fetches by `messageId:attachmentId` — see {@link OhmailEngine.openAttachment}. */
  private readonly attachmentRequests = new Map<string, Promise<void>>();
  /**
   * `contentId → data: URI` per message — the embedded images already minted for the reader's
   * frame, dropped with the rest of the message's byte state by
   * {@link OhmailEngine.releaseAttachments}. The held map is REPLACED on every mint, never
   * mutated, so a React memo keyed on its identity re-renders exactly when an image arrives.
   */
  private readonly inlineImages = new Map<string, ReadonlyMap<string, string>>();
  /** In-flight inline-image passes by message id — single-flight, see {@link OhmailEngine.loadInlineImages}. */
  private readonly inlineImageRequests = new Map<string, Promise<void>>();
  /**
   * `attachmentId → decoded ics text` per message — what an event-preview surface parses and
   * renders. Text, not a parsed structure: the engine holds bytes and their decodings, and the
   * ics grammar belongs to `@trafficflow/core/ics` at the render site. Replaced on every fill,
   * never mutated, and dropped with the rest of the message's byte state by
   * {@link OhmailEngine.releaseAttachments} — the same lifecycle as {@link inlineImages}.
   */
  private readonly calendarTexts = new Map<string, ReadonlyMap<string, string>>();
  /** In-flight calendar passes by message id — single-flight, see {@link OhmailEngine.loadCalendarTexts}. */
  private readonly calendarTextRequests = new Map<string, Promise<void>>();

  constructor(opts: EngineOptions) {
    this.adapter = opts.adapter;
    // The adapter's own capability is the shipped path; the option is the override. Resolved
    // ONCE, here, so `serverSearchAvailable()` cannot answer differently from what
    // `searchServer` will do a moment later.
    this.serverSearchFn =
      opts.serverSearch ??
      (opts.adapter as ServerSearchCapableAdapter).searchServer?.bind(opts.adapter) ??
      null;
    // The address arm, resolved by the SAME rule and INDEPENDENTLY of the text arm. Not derived
    // from `serverSearchFn`: an adapter wrapper forwards capabilities one at a time, so a client
    // can legitimately have the text search and not this, and deriving one from the other would
    // make `searchAddressServer` call a method that is not there.
    this.serverAddressSearchFn =
      opts.serverAddressSearch ??
      (opts.adapter as ServerAddressSearchCapableAdapter).searchAddressServer?.bind(opts.adapter) ??
      null;
    // Same resolution rule as `serverSearchFn`: the adapter's own capability, bound ONCE, so
    // nothing can answer "there is a snapshot route" differently from what `drain` will do.
    this.snapshotFn = (opts.adapter as SnapshotCapableAdapter).snapshot?.bind(opts.adapter) ?? null;
    // And again for the out-of-window read. No `opts` override beside it, unlike `serverSearch`:
    // one source means `listOlderAvailable()` and `listOlder` cannot disagree, and there is no
    // second way for a host to arm a capability the gate did not forward.
    this.listOlderFn = (opts.adapter as ListMessagesCapableAdapter).listMessages?.bind(opts.adapter) ?? null;
    // The Trash pair, bound by the SAME rule and INDEPENDENTLY of each other and of the list
    // above: an adapter wrapper forwards structural capabilities one at a time, so deriving
    // either from another would make a control call a method that is not there.
    this.listTrashFn = (opts.adapter as ListTrashCapableAdapter).listTrash?.bind(opts.adapter) ?? null;
    this.restoreFromTrashFn =
      (opts.adapter as RestoreFromTrashCapableAdapter).restoreFromTrash?.bind(opts.adapter) ?? null;
    // And a fourth time, same rule: bound ONCE here so `hydrateThread` cannot decide it has a
    // batch route and then call something else.
    this.fetchBodiesFn = (opts.adapter as FetchBodiesCapableAdapter).fetchBodies?.bind(opts.adapter) ?? null;
    // THE ABSENT BRANCH IS `full`. See {@link StorePolicy} — a host that configures nothing gets
    // today's behaviour, and no mirror is ever pruned by omission.
    this.storePolicy = opts.storePolicy ?? { mode: "full" };
    this.eagerBodiesOn = opts.eagerBodies === true;
    this.store = opts.store ?? new MemoryMirrorStore();
    this.types = opts.types;
    this.syncLimit = opts.syncLimit;
    this.staleResumeMs = opts.staleResumeMs ?? STALE_RESUME_MS;
    this.replayDeadlineMs = opts.outboxReplayDeadlineMs ?? OUTBOX_REPLAY_DEADLINE_MS;
    this.autoReplayOn = opts.outboxAutoReplay !== false;
    this.now = opts.now ?? (() => new Date());
    this.bootedAt = this.now().getTime();
    this.uuid = opts.uuid ?? (() => crypto.randomUUID());
    this.readerView = new OverlayReader(this.store, this.overlays, () => this.overlayRev);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Read the device's copy of the mailbox into memory — and SAY SO. `store.load()` reads the whole
   * persisted mirror and notifies nobody (the listener set lives here, not in the store), so a
   * returning user's mailbox was hydrated into memory and the UI was never told —
   * `useSyncExternalStore` holds its last snapshot, and the rows appeared only when the first
   * `/sync` page landed: on a slow connection the screen said "Nothing in your Ohbox." over mail
   * already on the device. Measured: two messages readable, store version 0 → 1000003, listeners
   * fired: 0 — mail sometimes appearing earlier was luck (any unrelated re-render re-reads).
   */

  /**
   * Single-flight, cleared in `finally` — `syncOnce()`'s pattern: concurrent callers coalesce, and
   * the promise is cleared even on REJECTION, so a failed hydration (IndexedDB blocked) can be
   * tried on the next wake — a memoized-forever version turns one transient storage error into a
   * mirror that can never be read for the life of the tab. `notify()` fires only on success: a
   * failed read changed nothing, and the scheduler counts the rejection as a failed tick, which is
   * what makes the retry happen. Re-hydrating mid-session is not reachable today (the scheduler
   * latches; `start()` runs this before its only drain) — noted rather than guarded, because a
   * guard nothing can trigger is a claim no test can put under load.
   */
  async hydrate(): Promise<void> {
    if (this.hydrating) return this.hydrating;
    this.hydrating = this.store
      .load()
      // Reconcile the no-raw-secret-at-rest rule before publishing: a body cached by an older
      // engine (or by a
      // delta that arrived before the protect cascade shipped) for a message that is protected in
      // the mirror this load just read must not survive. See {@link purgeProtectedBodies}.
      .then(() => this.purgeProtectedBodies())
      .then(() => {
        // The durable outbox re-arms with the same load that revives the mirror, so the first
        // publish below already carries every un-sent verb's optimistic effect — the boot
        // render is continuous with the killed session. See {@link OhmailEngine.restoreOutbox}.
        this.storeLoaded = true;
        this.restoreOutbox();
        this.notify();
      })
      .finally(() => {
        this.hydrating = null;
      });
    return this.hydrating;
  }

  /**
   * NO SENSITIVE BODY AT REST, RECONCILED ON LOAD. The delta cascade in {@link MirrorStore} purges a body the moment
   * a message TRANSITIONS to protected. This covers the two cases that transition cannot reach: a body cached by an
   * engine build from before that cascade existed, and a message that is ALREADY protected in the mirror this load
   * read (its protecting delta landed while a purge-less build was running). A protected message must hold no cached
   * `message_body`, and because {@link SearchIndex} is built from those records, purging here is also what keeps the
   * raw text out of the local search index — so a client that cached the body under an old engine, then updates,
   * converges. One pass over the client-local bodies, tombstoning only the ids whose message is protected; on the
   * ordinary mirror — where no protected message ever cached a body — it writes nothing.
   */

  /**
   * It does not `notify()`: `hydrate` publishes once after this settles, over the already-bumped store version.
   */
  private async purgeProtectedBodies(): Promise<void> {
    const reader = this.read();
    const victims: string[] = [];
    for (const { id } of this.store.entries<MessageBodyRecord>("message_body")) {
      if (isProtectedMessage(reader.get<EngineMessage>("message", id))) victims.push(id);
    }
    for (const id of victims) await this.store.putLocal("message_body", id, null);
  }

  /**
   * Hydrate the mirror, then bootstrap/catch up.
   *
   * THE COLD-START SNAPSHOT IS NOT A SEPARATE CALL HERE. `syncOnce()` → `drain()`, and `drain()`
   * checks for a cursor of "0" at the top of its loop, which is the same condition a cold start
   * is. Writing the check here TOO would be a second seam that has to stay in agreement with the
   * first — and the drain's copy is the one that has to exist regardless, because the 410
   * re-bootstrap re-enters the loop with a cursor of "0" without ever passing through `start()`.
   * So there is one condition in one place, and a cold start reaches it by calling `syncOnce`.
   */
  async start(): Promise<void> {
    await this.hydrate();
    await this.syncOnce();
  }

  /**
   * Ring the WORKER's doorbell — `POST /sync/pull` — so the next IMAP scan of this account's mailboxes happens now
   * instead of at the poll rotation's leisure. The gesture-side half of pull-to-refresh: a drain answers "what does
   * the worker already have", and this is the ask for mail the worker has not looked at yet. See {@link
   * EngineAdapter.requestPull}. `null` when this adapter has no doorbell (the demo's FixturesAdapter, older bundles),
   * which a caller treats as "this world has no worker to hurry" — the drain it was going to run is still the whole
   * of what the gesture can do there. Never throws: the pull is an accelerant on top of a sync that must proceed
   * regardless, so a refused or failed ring degrades to exactly the behaviour the gesture had before the doorbell
   * existed.
   */
  async requestPull(): Promise<{
    requested: number; requestedAt: string;
    mailboxes: Array<{ id: string; requestedAt: string }>;
  } | null> {
    const ring = this.adapter.requestPull?.bind(this.adapter);
    if (!ring) return null;
    try {
      return await ring();
    } catch {
      return null;
    }
  }

  /**
   * Does this client have a doorbell to ring at all? `attachmentsAvailable()`'s idiom for {@link
   * OhmailEngine.requestPull}: resolved from the adapter's own optional capability, so the predicate cannot disagree
   * with what the method will do. `false` for the demo (`?demo=1` is fixtures and zero network) and for any adapter
   * wrapper that did not forward the capability — which is exactly what a "Pull new mail" control must gate its own
   * rendering on: an affordance whose press could only ever degrade to the ordinary drain must not render as if it
   * reached the mail server. The webapp's `apiConfigured()` was the previous gate and it was wrong twice over — true
   * while the wrapped adapter had lost the doorbell (a dead button on the hosted client), and false on the desktop,
   * whose bridge adapter has a doorbell but no Cloud base (a missing button on both desktop doors).
   */
  pullAvailable(): boolean {
    return typeof this.adapter.requestPull === "function";
  }

  /**
   * One full drain: pull pages from the cursor of record until hasMore:false,
   * applying each page idempotently. A 410 discards local state and re-enters
   * as a bootstrap (once — a second 410 within one drain is surfaced).
   */
  async syncOnce(): Promise<void> {
    // Serialize concurrent callers onto one drain.
    if (this.syncing) return this.syncing;
    this.syncing = this.drive().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  /**
   * ONE DRIVE = the outbox first, then the drain — the boot-drain ordering INSTANT-ARCH §8 stage 1 requires ("the
   * outbox drains before/with the first sync"), generalised to EVERY drive because it is correct on every one: a
   * queued verb replayed before the pages are read means the drain that follows carries its echo (the POSTs returned
   * before the page loop began), so a restart converges in a single round of requests and a verb queued by a network
   * blip retries at the scheduler's ordinary cadence with no dedicated loop. The replay happens INSIDE the
   * single-flight (`this.syncing` is this promise), which is why {@link OhmailEngine.dispatch} runs in
   * `deferReconcile` mode here — its usual per-mutation `syncFresh()` would wait on this very promise.
   */
  private async drive(): Promise<void> {
    // NOT `restoreOutbox()` — see {@link restoreOutboxIfLoaded}. The drive can be reached before
    // `hydrate()` resolves, and latching there loses the previous session's verbs for good.
    this.restoreOutboxIfLoaded();
    await this.replayOutbox();
    await this.drain();
  }

  /** Replay every queued verb, oldest first, under its original Idempotency-Key. */
  /**
   * A verb whose RESULT a living surface is waiting on — the two families the drive must not consume while their
   * session is alive. `useMailSend` holds its send lock until `flushPending()` hands the result through `absorb`, and
   * the mobile ledger's send toasts (confirmed / check-Sent / failed) settle the same way; a compose adopts a
   * create's `entityId` from the result, and a create confirmed behind its back would leave the composer minting a
   * SECOND row under a fresh key on the next autosave. Everything else is fire-and-forget on every surface (the
   * rollback it could ever announce is already visible as the overlay coming off), so the drive retrying it is what
   * keeps user-always-wins CONVERGENT — a `mark_seen` queued by a blip has no owner to flush it, and stranding it
   * until reload was itself a review finding.
   */
  private static ownerSettled(m: EngineMutation): boolean {
    return m.kind === "mail_send" || (m.kind === "draft_save" && m.draftId === null);
  }

  private async replayOutbox(): Promise<void> {
    // The host owns the whole replay (`outboxAutoReplay: false` — the mobile shape): the drive
    // touches nothing, and `flushPending` routes every result to its ledger.
    if (!this.autoReplayOn) return;
    // A timed-out dispatch from an earlier drive is still in the air — see {@link outboxHold}:
    // nothing may be dispatched behind it until it settles, so this drive skips its replay and
    // goes straight to the drain. Read here rather than left to the gate on purpose: the gate
    // would make this drive WAIT for the hold, and a drive that waits is a drain that waits —
    // reads are never hostage to a hung write. The queue keeps everything, in order, for the
    // drive after; the hold's own settle nudges one.
    if (this.outboxHold) return;
    /**
     * A DRIVE REACHED FROM INSIDE A DISPATCH DOES NOT REPLAY. A confirmed dispatch awaits `syncFresh()` to reconcile,
     * and that is a `drive()`, and a drive calls this. So this method can be entered while a gated dispatch is still
     * on the chain — and joining the gate there would queue it behind its own holder, which never settles. The
     * deadlock is silent: the promise just hangs, and the guard that catches it reads as a timeout rather than a
     * defect. Skipping is the honest answer rather than a workaround, and it is the same one the hold above gives:
     * that nested drive exists to DRAIN, the queue keeps everything in user order, and the next drive replays it.
     * Reads are never hostage to a write.
     */
    if (this.inOutboxGate) return;
    if (this.queue.length === 0) return;
    // THE GATE, around the whole batch. The body re-reads the hold at release — see the gate's
    // own note: a dispatch this batch queued behind may have timed out and armed one, and
    // replaying behind a request still in the air is the reordering the barrier exists to stop.
    // Order within the batch is user order and the batch must not be interleaved with a
    // `mutate` or a `flushPending` — a fresh verb landing between two
    // replayed ones can commit first and be overwritten when the older one lands, which is
    // user-always-wins violated in exactly the window nobody watches. This road was the last one
    // outside the gate; `replayActive` was its private stand-in, and a private stand-in only
    // serializes the callers that know about it.
    return this.outboxGate(() => this.replayOutboxInner());
  }

  private async replayOutboxInner(): Promise<void> {
    // Release-time re-read. Skipping is right here for the same reason it is at the top: the
    // drive goes on to its drain, and the queue keeps everything in order for the drive after.
    if (this.outboxHold) return;
    // Every RESTORED entry (its owner died with its session), plus every same-session entry
    // whose result nobody routes — see {@link OhmailEngine.ownerSettled} for the two families
    // that stay with `flushPending()`.
    // `nextAt` is the backoff gate: a verb the server already refused waits out its delay instead
    // of being retried on every drive. Filtered here rather than inside `dispatch` so a waiting
    // verb never leaves the queue at all — it keeps its place in user order for the drive that
    // does take it, and nothing downstream has to know it was skipped.
    const ready = this.now().getTime();
    const batch = this.queue
      .filter((p) => (p.nextAt ?? 0) <= ready)
      .filter((p) => p.restored === true || !OhmailEngine.ownerSettled(p.mutation))
      .sort((a, b) => (a.at - b.at) || (a.n - b.n));
    if (batch.length === 0) return;
    const held = new Set(batch);
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (held.has(this.queue[i]!)) this.queue.splice(i, 1);
    }
    // Serial and awaited: order is user order, and the drain below must not begin until every
    // replayed POST has returned (that happens-before is what lets it carry their echoes). A
    // retryable failure re-queues onto the queue for the NEXT drive — `dispatch` never throws,
    // so one dead verb cannot stall the drain behind it. Each attempt is DEADLINE-BOUNDED —
    // the adapter's mutate has no timeout of its own, and one half-open request awaited here
    // would otherwise hold the single-flight forever: no bootstrap, no sync, for the whole
    // session. The in-flight dispatch still OWNS its timed-out entry (it settles it, re-queues
    // it, or leaves it persisted for the next boot), so the verb is never double-run and never
    // dropped.
    for (let i = 0; i < batch.length; i++) {
      const p = batch[i]!;
      // ONE ROAD. This loop used to hand-roll the deadline, the barrier and the hold, which is
      // how `retryAbandoned` came to be the road WITHOUT a deadline: the code that had one was
      // not reusable, so the third caller re-derived a subset of it. It is the same method now.
      // The drive's own drain follows this batch and carries every echo, so the reconcile this
      // dispatch defers is deliberately DROPPED rather than issued — one drain, not two. That is
      // the whole reason the deferred mode exists, and it is why `owed` is ignored here alone.
      const { timedOut, held, result } = await this.dispatchOnLane(p);
      /**
       * The replay's answer is kept, exactly as a late answer is. This loop used to throw the RESULT away, and for a
       * restored entry that result is the only thing anyone will ever know: its owner died with the previous session.
       * For a send that is a second delivery — press Send before the first autosave, lose the response, reload: the
       * replay delivers it, drops the `sent` answer and the `entityId`, the create gate opens, the next pause writes
       * a second row, and an edit un-matches the fingerprint so Send goes out under a fresh key. `lateResults` is
       * where an answer with no waiting caller belongs (the timeout path writes exactly this) and `flushPending()` is
       * its single destructive reader; the two writers are mutually exclusive per call.
       */

      /**
       * ONLY a settled answer: a `queued` result is the ABSENCE of an answer — the entry went back on the outbox —
       * and keeping it poisons the reader (measured: a 410 mid-drive test read the stale `queued` as the flush's
       * verdict; one level out, the compose adoption would settle a message on a send that has not settled — the
       * false "Sent." this seam prevents).
       */
      if (result !== null && result.status !== "queued") {
        this.lateResults.set(p.id, result);
        this.notify();
      }
      if (held) {
        // A hold armed while this batch ran. The rest stay queued in user order for the drive
        // after; this one proceeds to its drain, because reads are never hostage to a write.
        this.queue.unshift(...batch.slice(i));
        return;
      }
      if (timedOut) {
        // ORDER IS THE CONTRACT, so a timeout stops the BATCH, not just the wait: the hung
        // request may yet commit, and dispatching the entries behind it would let a newer write
        // land before an older one — mark-read then mark-unread arriving reversed is the exact
        // class the serial replay exists to prevent. The rest go back on the queue with their
        // stamps intact (the next replay re-sorts), and the in-flight dispatch is already the
        // order barrier: `dispatchWithDeadline` armed {@link outboxHold} before returning, so
        // no road may start another dispatch until it settles. This drive still proceeds to its
        // drain — reads are never hostage to a hung write.
        this.queue.unshift(...batch.slice(i + 1));
        return;
      }
    }
  }

  /**
   * Re-arm the durable outbox from the mirror store — the restart half of the contract. Reads every persisted {@link
   * PersistedOutboxEntry}, restores the queue in `(at, n)` order, and re-applies each verb's overlay so the BOOT
   * RENDER already carries the user's un-sent intents (INSTANT-ARCH §8 stage 1). Synchronous on purpose: everything
   * it reads is in memory once the store has loaded. Idempotent via a latch, called from three places so every
   * construction order is covered: `hydrate` (the webapp path), `drive` (an engine never hydrated), and directly by a
   * host that loaded the store first (the mobile boot) — a drive on an unloaded store latches over an empty set; the
   * entries replay next boot.
   */

  /**
   * An entry whose shape this build does not recognise is left in place, not replayed — it waits for a build that
   * understands it; an entry whose overlay cannot be recomputed (target pruned from a windowed mirror) still REPLAYS
   * — only the local paint is skipped.
   */
  restoreOutbox(): void {
    // Calling this IS the statement that the store was loaded first, so it also arms the drive's
    // own door — a host that loaded and restored has nothing left for `restoreOutboxIfLoaded` to
    // wait on.
    this.storeLoaded = true;
    /**
     * THE HOST'S STATEMENT THAT IT LOADED FIRST. Calling this latches the restore, so a caller
     * that has not loaded the store latches over an empty one and the previous session's verbs
     * are never replayed. `hydrate()` and the mobile boot both load before they call it; the
     * DRIVE does not, which is why the drive uses {@link restoreOutboxIfLoaded} instead.
     */
    this.restoreOutboxOnce();
  }

  /**
   * THE DRIVE'S DOOR: a no-op that does NOT latch until the store is known to be loaded. `drive()` is reachable from
   * `mutate → dispatch → syncFresh` before `hydrate()` resolves. It used to call the latching version, so a mutation
   * made in the first moments of a session could latch the restore over an unloaded store — and every verb the
   * previous session left on disk was then never replayed for the whole session. The verbs were durable, present, and
   * ignored. Not latching is the safe half: the worst case is that the restore happens on the next drive instead of
   * this one, which costs one cycle. Latching early costs a session.
   */
  private restoreOutboxIfLoaded(): void {
    if (!this.outboxLoadable()) return;
    this.restoreOutboxOnce();
  }

  /** True once the store is loaded — by `hydrate()` resolving, or by a host that loaded it. */
  private outboxLoadable(): boolean {
    return this.storeLoaded;
  }

  private restoreOutboxOnce(): void {
    if (this.outboxRestored) return;
    this.outboxRestored = true;

    const rows = this.store.entries<unknown>(OUTBOX_TYPE)
      .map((e) => e.entity)
      .filter(isPersistedOutboxEntry)
      .sort((a, b) => (a.at - b.at) || (a.n - b.n));
    if (rows.length === 0) return;
    let restored = false;
    for (const e of rows) {
      this.outboxSeq = Math.max(this.outboxSeq, e.n + 1);
      /**
       * AN ENTRY THIS SESSION IS ALREADY HANDLING IS NOT A RESTART'S ENTRY. The latch does not guarantee this method
       * runs before the first mutation: an engine driven without ever hydrating reaches here through its first drive,
       * and that drive can be the very `syncFresh` a confirmed mutation just issued — at which point that mutation's
       * entry is still on disk (its terminal cleanup runs after the drive starts) and re-queueing it would dispatch
       * the SAME verb twice in one session. Every live mutation holds either its overlay (in flight, or awaiting its
       * echo) or a queue slot (retryable), so those two are the skip. An entry skipped here that then fails its
       * cleanup simply replays next session, idempotently — the safe direction.
       */
      if (this.overlays.has(e.id) || this.queue.some((q) => q.id === e.id)) continue;
      /**
       * AN UNKEYED CREATE PAST THE SERVER'S DEDUPE HORIZON IS DROPPED, NOT REPLAYED. The server's idempotency records
       * live 24 h (`idempotency_keys.expires_at`); within that window every replay is exact. Past it, the state verbs
       * still converge on their own (absolute values, unique names, permanent send reservations) and keep replaying
       * at any age — but a `rule_create` has no uniqueness constraint and a compose's first `draft_save` mints a
       * fresh row, so replaying one after a day-plus-dead app mints a duplicate the user long since stopped
       * expecting. Dropping is the honest direction for exactly these two: a duplicate appears silently and wrongly;
       * an absent day-old unsaved intent is what the user already believes happened.
       */
      // The same predicate `retryAbandoned` applies — see {@link pastCreateDedupe}. It was two
      // copies of one rule for as long as there was only one caller.
      if (pastCreateDedupe(e, this.now().getTime())) {
        void this.dropOutbox(e.id);
        continue;
      }
      try {
        // The verb's OWN moment, not the restart's: a leave-commit restored the next morning
        // must not stamp its waterline (or any optimistic `updatedAt`) with boot time — the
        // effects are rebuilt under the clock the verb was expressed at.
        const asExpressed = () => new Date(e.at);
        const effects = mutationEffects(this.read(), e.mutation, { now: asExpressed, uuid: this.uuid });
        if (effects.length > 0) this.overlays.set(e.id, effects);
      } catch { /* a malformed or out-of-vocabulary mutation paints nothing; the wire decides */ }
      this.queue.push({
        id: e.id, key: e.key, mutation: e.mutation, at: e.at, n: e.n, restored: true,
        // A `v: 1` record carries none of these; `?? 0` is what makes it a valid `v: 2` in memory
        // and gives it the full ceiling rather than retiring it on arrival.
        attempts: e.attempts ?? 0,
        ...(e.nextAt !== undefined ? { nextAt: e.nextAt } : {}),
        /**
         * A `v: 2` RECORD WITH A WAIT AND NO FLAG IS READ AS SERVER-NAMED. `waitIsServerNamed` was added to the `v:
         * 2` shape in place, so records written before it can carry a `nextAt` that came from a `Retry-After` and no
         * way to say so. Reading the absent flag as `false` makes the explicit-flush path ignore an interval the
         * SERVER chose — the one wait this client has no right to override. So the ambiguity resolves toward
         * obedience: a `v: 2` record that has a wait is assumed to have been told to wait. `v: 1` had no `nextAt` at
         * all and is unaffected; `v: 3` always carries the flag explicitly, which is what the version bump is for.
         */
        ...(e.waitIsServerNamed !== undefined
          ? { waitIsServerNamed: e.waitIsServerNamed }
          : (e.v === 2 && e.nextAt !== undefined ? { waitIsServerNamed: true } : {})),
        ...(e.lastError !== undefined ? { lastError: e.lastError } : {}),
      });
      restored = true;
    }
    /**
     * A VERB IN BOTH COLLECTIONS IS A CRASH RESIDUE, AND THE LIVE ROW WINS. `abandon()` writes the abandoned record
     * before deleting the outbox one, so a kill between the two leaves both. The pair is not self-resolving: a later
     * replay success deletes only the live copy and leaves a false "could not be saved" row, and Discard deletes only
     * the abandoned copy while the live verb goes on to execute — a person told it was thrown away, watching it land.
     * Resolved here, at boot, where both collections are in hand: anything still queued is by definition not
     * abandoned, so the abandoned twin is the stale one and goes. The other order would delete work that is about to
     * be retried.
     */
    const queuedIds = new Set(this.queue.map((q) => q.id));
    for (const row of this.store.entries<unknown>(OUTBOX_ABANDONED_TYPE)) {
      if (!queuedIds.has(row.id)) continue;
      void this.store.commitLocal([], [{ type: OUTBOX_ABANDONED_TYPE, id: row.id }])
        .catch(() => { /* best-effort; the next boot tries again */ });
    }
    if (!restored) return;
    // Restored entries must replay in their (at, n) order even when a same-session verb was
    // queued before this ran — a retryable failure milliseconds after boot is older than
    // nothing. The sort is total because every stamp came from the same monotonic pair.
    this.queue.sort((a, b) => (a.at - b.at) || (a.n - b.n));
    this.overlayRev++;
    this.notify();
  }

  private async drain(): Promise<void> {
    /**
     * This drain's epoch — the other half of {@link awaitingEcho}'s happens-before. Stamped
     * BEFORE the first page is requested, so "registered epoch < this epoch" means the POST
     * returned before this drain read the log, and this drain's success therefore proves the
     * echo is applied. See {@link OhmailEngine.sweepAwaitingEcho} at the successful exit.
     */
    const epoch = ++this.drainEpoch;
    let rebootstrapped = false;
    // The rules-first pass runs AT MOST ONCE per drain (re-owed by the 410 reset below): the
    // completion stamp only lands when the whole drain settles, so without this latch every page
    // of a multi-page first drain would re-open with a redundant rules request.
    let rulesFirstDone = false;
    // A STALE resume converges its newest page FIRST — see the method for the whole argument.
    // Before the loop, once per drain: the 410 branch re-enters the loop with a wiped mirror,
    // where the bootstrap snapshot below already owns "newest first".
    //
    // The staleness verdict is read ONCE, before the freshen (a completed freshen changes no
    // stamp, but reading per page would let the loop's own completion flip the answer mid-
    // drain), and it selects the page size for the WHOLE drain: a stale resume is a backlog
    // catch-up and asks for {@link BACKLOG_PAGE_LIMIT} rows per page — see the constant for the
    // measured arithmetic. An explicit {@link EngineOptions.syncLimit} always wins (the test
    // seam), and a fresh resume keeps the server's default page, the deployed shape.
    const staleResume = this.isStaleResume();
    await this.freshenStaleResume();
    for (;;) {
      // COLD MIRROR + A SNAPSHOT ROUTE ⇒ TAKE THE SNAPSHOT INSTEAD OF REPLAYING THE LOG.
      //
      // This is the ONE place the condition is written, and it is reached by all three callers
      // that can present a cursor of "0": a first-ever `start()`, a `start()` over a mirror whose
      // last bootstrap crashed before its final page, and the 410 branch below — which resets to
      // "0" and `continue`s straight back here. See {@link OhmailEngine.runSnapshot}.
      // A NON-ZERO CURSOR ON A MIRROR THAT HAS NEVER COMPLETED A DRAIN is an interrupted
      // bootstrap resuming — an earlier session's `since=0` fallback (or post-snapshot catch-up)
      // committed some pages and died. Read BEFORE the snapshot check, because a successful
      // snapshot moves the cursor off "0" in this very iteration and must not read as a resume.
      const resumedIncomplete = this.store.getCursor() !== "0"
        && this.store.getMeta<string>(LAST_DRAIN_AT_META) === undefined;

      if (this.store.getCursor() === "0" && this.snapshotFn) await this.runSnapshot();

      // Rules before mail, on the degraded bootstrap. The snapshot path delivers the whole rule set in page 1 ("a
      // partial rule set is worse than none"), so a mid-bootstrap render never sees a message whose sender's decision
      // is missing; the `since=0` replay interleaves by seq, so a sender decided AFTER their mail arrived replays
      // mail-first and the consent cutline reads the absent rule as "undecided" — an already-screened sender in the
      // Screener until the replay catches up. Unknown is not undecided, so the fallback drains the rule type to its
      // horizon first, rows only (the cursor stays put; the per-entity seq guard absorbs the repeat).

      // Two ways in: a cold mirror whose snapshot failed page 1, and a resumed incomplete bootstrap, where the
      // committed pages may hold mail whose rule sits beyond the interruption (with a healthy route
      // `freshenStaleResume()` already applied page 1; this arm is the degraded completion plus the belt for a
      // freshen that failed). Deliberately NOT before `hydrate()`: holding the offline-first paint on a network drain
      // trades a bounded interim state for a blank screen on a dead network. Gated on a snapshot route EXISTING: the
      // route-less adapters are the demo (never partitioned) and servers that no longer exist.
      let resp;
      try {
        // INSIDE the try, deliberately: a later prefetch page can 410 exactly as the delta can
        // (the horizon moves), and the recovery is the same one — reset, re-enter as a bootstrap.
        if (this.snapshotFn && !rulesFirstDone
            && (resumedIncomplete || (this.store.getCursor() === "0" && this.snapshotUnavailable))) {
          rulesFirstDone = true;
          await this.drainRulesFirst();
        }
        // The dense-page ask covers the RESUMED-incomplete-bootstrap replay too — that is a
        // backlog by definition (an earlier session's since=0 fallback died mid-log), and it is
        // read fresh per iteration because the 410 branch can turn a stale resume INTO one.
        const backlogLimit = this.syncLimit !== undefined
          ? this.syncLimit
          : drainPageLimit(staleResume || resumedIncomplete, undefined);
        resp = await this.adapter.sync({
          since: this.store.getCursor(),
          ...(backlogLimit !== undefined ? { limit: backlogLimit } : {}),
          ...(this.types ? { types: this.types } : {}),
        });
      } catch (err) {
        if (err instanceof CursorExpiredError && !rebootstrapped) {
          // The once-per-drain guard stays exactly as it was: a SECOND 410 inside one drain is a
          // server that expires the cursor it just issued, and is surfaced rather than looped on.
          // It bounds the snapshot path too — at most one snapshot can follow a 410 per drain.
          rebootstrapped = true;
          // THE SEQ-0 ROWS RIDE THROUGH THE WIPE, and the STORE is what carries them: it
          // partitions them in `resetForBootstrap` and re-writes them inside the wipe's own
          // transaction. This used to be a snapshot here, a wipe, and a one-by-one write-back —
          // a durable zero-row window in which a kill, or one refused re-put, lost every queued
          // verb and every abandoned record. It was also a second writer of a rule the store
          // already owned for the cross-tab case.
          await this.store.resetForBootstrap(); // cursor → "0"
          // The wipe took the rules with it — the re-bootstrap owes the rules-first pass again.
          rulesFirstDone = false;
          this.notify();
          // Back to the top: with a snapshot route the cursor of "0" selects the snapshot and the
          // delta drain then resumes from `asOfSeq`; without one it selects `since=0`, which is
          // the pre-snapshot path and still converges. The fallback is not dead code — it is what
          // the FixturesAdapter and any adapter older than this route take.
          continue;
        }
        throw err;
      }
      await this.store.applyResponse(resp);
      this.notify();
      if (resp.hasMore) continue;

      // ONE PRUNE PASS PER SUCCESSFUL DRAIN, at the point the mirror is caught up and therefore
      // at its most complete — which is when a windowed client's eviction decision is least
      // likely to be made about a half-arrived mailbox. A `full` policy returns immediately.
      if (await this.pruneToPolicy()) this.notify();
      // A drain is the one thing that can deliver the REAL Sent row an optimistic copy is standing
      // in for — retire any copy the mirror now holds under the same header (or that has aged out),
      // so the conversation shows the ingested row alone rather than a duplicate.
      const before = this.optimisticSent.size;
      this.reconcileOptimisticSent();
      if (this.optimisticSent.size !== before) { this.overlayRev++; this.notify(); }
      // THE DRAIN'S LAST WORD: this mirror was fully caught up at this moment, on this device's
      // own clock. Written at COMPLETION and nowhere earlier — a drain that fails or aborts
      // mid-backlog leaves the old stamp standing, so the next drain still reads as a stale
      // resume and freshens again (idempotent: the seq guard absorbs the repeat).
      await this.store.setMeta(LAST_DRAIN_AT_META, this.now().toISOString());
      // ANNOUNCE THE SETTLE. The stamp is what {@link OhmailEngine.freshness} reads, and the
      // last data notify above fired BEFORE the stamp landed — so without this, a surface
      // rendering "as of 14:32 · catching up" off a freshness subscription keeps the label up
      // until something ELSE happens to notify (the next drain, seconds to minutes away). The
      // label must clear at the settle, not at the next coincidence; `freshness-label.test.ts`
      // watches this line red.
      this.notify();
      // THE OVERLAY SWEEP, only on this successful exit: every overlay whose POST returned
      // before this drain began now has its echo IN the mirror, so retiring it changes what is
      // rendered from "the overlay's claim" to "the server's identical statement".
      this.sweepAwaitingEcho(epoch);
      return;
    }
  }

  /**
   * Retire every {@link awaitingEcho} overlay registered before the drain of `epoch` began.
   * A failed drain never reaches this (its `throw` propagates out of {@link drain}), which is
   * the whole point: the overlay survives any number of failed attempts and retires only on
   * proof. Entries registered DURING the drain (`registered === epoch`) stay — that drain read
   * the log before their POST committed and proves nothing about them.
   */
  private sweepAwaitingEcho(epoch: number): void {
    if (this.awaitingEcho.size === 0) return;
    let swept = false;
    for (const [overlayId, registered] of this.awaitingEcho) {
      if (registered >= epoch) continue;
      this.awaitingEcho.delete(overlayId);
      swept = this.overlays.delete(overlayId) || swept;
      // The durable entry rode alongside the overlay for exactly this long — the echo is now
      // provably applied, so the verb needs no replay on any future boot. Best-effort: an
      // entry that survives a refused delete replays idempotently, the safe direction.
      void this.dropOutbox(overlayId);
    }
    if (swept) {
      this.overlayRev++;
      this.notify();
    }
  }

  /**
   * Drain `?types=rule` from seq 0 to its horizon, ROWS ONLY — the `since=0` fallback's opening move (see the call
   * site in {@link OhmailEngine.drain} for the whole argument). The cursor is never touched: the main replay that
   * follows re-delivers every one of these changes at the same seqs and the per-entity guard skips them, so a crash
   * between the two passes costs nothing and converges exactly as a crashed bootstrap always has. A failure here is a
   * failure of the SAME wire the main drain is about to use, so it is left to propagate on the main drain's own path
   * rather than being swallowed into an unordered bootstrap — swallowing would silently reintroduce the
   * misclassification this exists to stop, in exactly the flaky conditions that made the fallback fire.
   */
  private async drainRulesFirst(): Promise<void> {
    // An engine configured to sync a type list that excludes rules has no decisions to order.
    if (this.types && !this.types.includes("rule")) return;
    let since = "0";
    for (;;) {
      const resp = await this.adapter.sync({
        since,
        types: ["rule"],
        ...(this.syncLimit !== undefined ? { limit: this.syncLimit } : {}),
      });
      await this.store.applyChanges(flattenResponse(resp));
      since = resp.cursor;
      if (!resp.hasMore) break;
    }
    this.notify();
  }

  // ── eager recent-window hydration ──────────────────────────────────────────

  /**
   * Start (or queue) one eager pass — see {@link EngineOptions.eagerBodies} and the {@link EAGER_BODIES_MAX}/{@link
   * EAGER_BODIES_SLICE} bounds. Called by the SHELL's scheduler after a settled drain, deliberately not by `drain()`
   * itself: the engine owns the mechanism, the driver owns WHEN background work is welcome — the first wiring had
   * `drain()` fire it, and every bare `syncOnce()` in a test (and every discarded engine whose drain settled after
   * teardown) issued body fetches from behind the caller's back, the "requests on behalf of nobody" shape the gate
   * refuses; the opt-in flag makes even the ask a no-op until the embedder means it.
   */

  /**
   * Single-flight with ONE queued re-run: a kick during a pass must not stack passes, and must not be lost either —
   * the drain that kicked may have applied mail the running pass's snapshot predates; one boolean is exactly "run
   * once more with fresh eyes", and a settled mailbox's re-run costs nothing (every id plans to `skip`). Never
   * rejects: failures land as per-id `failed` records exactly as an explicit open's would.
   */
  prefetchRecentBodies(): Promise<void> {
    if (!this.eagerBodiesOn) return Promise.resolve();
    if (this.eagerRun) {
      this.eagerAgain = true;
      return this.eagerRun;
    }
    const gen = this.eagerGen;
    this.eagerRun = this.runEagerBodies(gen)
      .catch(() => {
        /* per-id failures are records the surfaces render; the pass has nothing to throw AT */
      })
      .finally(() => {
        this.eagerRun = null;
        const again = this.eagerAgain;
        this.eagerAgain = false;
        /*
         * THE QUEUED RE-RUN IS ALSO CANCELLED BY TEARDOWN, and it was not. `stopEagerBodies()`
         * bumps the generation, which the running pass checks between slices — but the re-run was
         * started from here unconditionally and then read the CURRENT generation, so a discarded
         * engine (a live→demo navigation swaps it) resumed fetching hundreds of bodies on behalf
         * of nobody, which is the exact shape the opt-in and the driver-owned kick exist to
         * prevent. The flag is consumed either way: it is a request for another pass in THIS
         * engine's life, not a standing order.
         */
        if (again && gen === this.eagerGen) void this.prefetchRecentBodies();
      });
    return this.eagerRun;
  }

  /**
   * ABORT the background pass between steps — a teardown's call (a live→demo navigation swaps
   * the engine; the discarded one must not keep fetching on behalf of nobody). Bodies already
   * in the air complete into the store; no new step starts. The next drain's kick resumes from
   * whatever is still missing, because the pass re-derives its want-list from the mirror.
   */
  stopEagerBodies(): void {
    this.eagerGen++;
  }

  /** Settles when no eager pass is in flight — the deterministic seam a test (or teardown) awaits. */
  async eagerBodiesIdle(): Promise<void> {
    while (this.eagerRun) await this.eagerRun;
  }

  /**
   * One pass: the mirror's newest {@link EAGER_BODIES_MAX} messages, offered to the SAME
   * admission and transport every explicit hydration uses ({@link bodyPlan} through
   * {@link hydrateMany}) — a ready body is never re-fetched, a failed one is never re-asked
   * within the session, protected and fixture-bodied rows issue nothing, and the four-wide
   * non-urgent slot queue is shared so an OPEN always jumps ahead. `rendered: false` is the one
   * divergence from a thread open, and it is load-bearing: a thousand prefetched ids must not
   * flush the {@link RENDERED_PINS} LRU that keeps the windowed prune off a message someone is
   * actually reading.
   */
  private async runEagerBodies(gen: number): Promise<void> {
    const entries = this.read().entries<EngineMessage>("message");
    const ids = entries
      .sort((a, b) => (b.entity.date ?? "").localeCompare(a.entity.date ?? ""))
      .slice(0, EAGER_BODIES_MAX)
      .map((e) => e.id);
    // The stop check is BETWEEN slices here and INSIDE the slice via `stopped` — a batch answer
    // the server truncated on its byte budget leaves a per-id tail of up to
    // {@link EAGER_BODIES_SLICE} single requests, and without a check in there a teardown between
    // the batch response and its tail let a discarded engine issue every one of them.
    const stopped = (): boolean => gen !== this.eagerGen;
    for (let i = 0; i < ids.length; i += EAGER_BODIES_SLICE) {
      if (stopped()) return;
      await this.hydrateMany(ids.slice(i, i + EAGER_BODIES_SLICE), { rendered: false, stopped });
    }
  }

  /**
   * A stale resume fetches the newest page before it replays its backlog. The delta feed is ascending-seq, so a
   * mirror resuming days stale replays oldest-first: the mail a returning user is looking for is in the LAST page.
   * Measured in production (2026-08-10): a full-log replay took 4 pages and 28.5 s, the newest message applying at
   * the very end, while `GET /sync/snapshot` page 1 (the newest messages plus ALL small state) answered in 509 ms —
   * on a real mailbox that reads as "the app takes minutes to show what I did on the other machine". So when {@link
   * LAST_DRAIN_AT_META} says no drain completed within {@link STALE_RESUME_MS}, snapshot page 1 is applied ROWS-ONLY
   * before the delta loop: Ohbox, counts and Screener are current after one round trip, and the backlog replays
   * behind content that is already right.
   */

  /**
   * Applying a snapshot page over a warm mirror is sound: snapshot rows carry `seq === asOfSeq`, ≥ every seq in the
   * backlog, so the backlog's replay of the same rows is refused by the older-or-equal guard; anything after the
   * snapshot read has a higher seq and wins; a row deleted while away is absent from the snapshot and the delta's
   * tombstone removes it. The CURSOR is never touched — committing `asOfSeq` here would skip every tombstone in the
   * backlog and keep ghosts for ever; the delta replay from the OLD cursor stays the mechanism of record, and
   * mutations are untouched (this is a READ overlay). Failure is swallowed and must not latch {@link
   * snapshotUnavailable} — that latch is the BOOTSTRAP probe's, and latching here on a transient would push a later
   * 410 re-bootstrap onto the full `since=0` replay for the life of the tab.
   */

  /**
   * A missing stamp on a warm cursor is stale: every pre-upgrade mirror, exactly the mailboxes that reported the
   * symptom; the arm fires at most once per such mirror.
   */
  /**
   * IS THIS DRAIN A STALE RESUME — a warm cursor whose last completed drain is older than
   * {@link STALE_RESUME_MS} (or was never stamped, the pre-upgrade-mirror arm the freshen
   * documents)? ONE predicate, two consumers with one condition by construction:
   * {@link OhmailEngine.freshenStaleResume} decides whether to fetch the newest page first,
   * and {@link OhmailEngine.drain} decides whether to ask for {@link BACKLOG_PAGE_LIMIT} pages
   * — a freshen without the dense drain leaves the convergence tail, a dense drain without the
   * freshen labels nothing, so the two firing on different verdicts would be a defect.
   */
  private isStaleResume(): boolean {
    if (this.store.getCursor() === "0") return false; // a cold mirror is the bootstrap's, not ours
    // The COLD GATE above is this engine's own — "am I bootstrapping" is a fact about this
    // store's cursor, not about the policy — and the stamp comparison below is the shared one
    // the sidecar's mirror makes (`@trafficflow/core/drain-policy`), absent-is-stale arm and all.
    return mirrorStale(this.store.getMeta<string>(LAST_DRAIN_AT_META), this.now(), this.staleResumeMs);
  }

  private async freshenStaleResume(): Promise<void> {
    if (!this.snapshotFn || this.snapshotUnavailable) return;
    if (!this.isStaleResume()) return;
    let page: SyncSnapshotPage;
    try {
      page = await this.snapshotFn({});
    } catch {
      return; // the delta drain that follows is the source of truth, and of error reporting
    }
    await this.store.applyChanges(page.changes); // rows only — the cursor is the delta's
    this.notify();
  }

  /**
   * Fetch `GET /sync/snapshot` to completion, committing the cursor with the LAST page and not one page earlier.
   * Every page but the last goes through `applyChanges` (writes rows, never the cursor); only the last goes through
   * `applyResponse`, whose single flush carries the rows and the cursor together (contract §3.3 step 3). A restart
   * can observe two states only: cursor "0" — a prefix of the snapshot present, and the next drain re-snapshots (rows
   * carry `seq === asOfSeq`, so a re-read skips or overwrites them; it converges) — or cursor `asOfSeq`, the whole
   * snapshot landed. The fatal third state — a cursor past rows that never arrived — is unreachable, because nothing
   * but the final page can write the cursor at all.
   */

  /**
   * Resuming at `asOfSeq` misses nothing: it is the point the snapshot was READ at, identical on every page; changes
   * committed while paging have seqs above it and the delta drain picks them up.
   */

  /**
   * The paging token is never the cursor (`nextCursor` is opaque server state, passed straight
   * back), and the cursor is not a decimal: it is {@link encodeSeqCursor}'s base64url, NOT
   * `String(seq)` — measured, not assumed: the first version committed `String(asOfSeq)` and eight
   * `contract.test.ts` tests went red with `CursorExpiredError`, because `SyncService.decodeCursor`
   * base64url-decodes what it is given and a bare "900" decodes to non-digits, so every drain
   * after a snapshot 410'd. The two encoders are the same function on both sides of the wire and
   * must stay that way.
   */

  /**
   * A first-page failure falls back; a later one does not. Page 1 failing latches {@link snapshotUnavailable} and the
   * caller takes the `since=0` path every client used before — an engine whose cold start hard-fails on a missing
   * route is a mailbox rendering empty in silence (`http-adapter-binding.test.ts` exists because that shipped once).
   * The swallow cannot hide an outage: the very next call is `/sync` on the same origin, which still rejects through
   * the path that has always reported it. A LATER page's failure is rethrown, different in kind: rows carrying `seq
   * === asOfSeq` are already in the mirror, and `since=0` over them would be silently wrong — the seq guard drops
   * every replayed change at or below `asOfSeq`, so the unreached pages would never be delivered by either path and
   * the mirror would settle into a permanently truncated state that looks healthy.
   */

  /**
   * Rethrowing leaves the cursor at "0", so the next drain re-snapshots from page 1. An abandoned attempt's rows do
   * not survive into the next one — see {@link OhmailEngine.claimSnapshotPrefix}.
   */
  /**
   * Claim this snapshot's seq, and sweep an earlier attempt's rows before writing over them. A
   * snapshot says nothing about what it OMITS: attempt A (asOfSeq 100) applies pages 1–3 holding
   * message M, page 4 fails, cursor stays "0"; M is deleted at seq 150; attempt B (asOfSeq 200)
   * never mentions M — a snapshot states LIVE state — completes, and commits the cursor at 200. M
   * is now in the mirror for ever: its delete sits at 150, below the adopted cursor, and `/sync`
   * sends a delta once. Deleted mail comes back and stays — the store.ts persistence class, the
   * falsified fact being "the rows on disk belong to the snapshot the cursor names".
   */

  /**
   * The predicate is the seq: every row a snapshot emits carries that snapshot's `asOfSeq`, so one seq names one
   * attempt's output exactly. The seq of the on-disk prefix is written to {@link SNAPSHOT_PREFIX_SEQ_META} BEFORE the
   * first row is applied, and an attempt finding a DIFFERENT seq sweeps those records first ({@link
   * MirrorStore.pruneBySeq}, a hard delete — anything the new snapshot still carries is re-materialized by its own
   * pages). The alternative, remembering applied ids in a field, is the defect in another shape: the failure is a
   * process that stopped, and a list in that process's memory stops with it. `pruneBySeq` refuses seq 0, which
   * protects the durable outbox and hydrated bodies (client-local by construction); an empty log answers `asOfSeq: 0`
   * and is a no-op on both halves.
   */

  /**
   * The marker is NOT cleared on completion, deliberately: after the last page it is a true statement, its only
   * reader is this method at cursor "0", and `resetForBootstrap` clears meta anyway.
   */
  private async claimSnapshotPrefix(asOfSeq: number): Promise<void> {
    const prior = this.store.getMeta<number>(SNAPSHOT_PREFIX_SEQ_META);
    if (typeof prior === "number" && prior !== asOfSeq) {
      // The prefix belongs to a snapshot taken at another point. It cannot be reconciled with
      // this one — a snapshot says nothing about what it omits — so it goes before this attempt
      // writes a single row over it.
      if (await this.store.pruneBySeq(prior)) this.notify();
    }
    // DURABLE BEFORE THE FIRST ROW, for the reason the whole class exists: a kill between this
    // write and the page's must leave a marker that names an attempt with no rows (harmless — the
    // sweep finds nothing), never rows with no marker (the defect above, unrecoverable).
    await this.store.setMeta(SNAPSHOT_PREFIX_SEQ_META, asOfSeq);
  }

  private async runSnapshot(): Promise<void> {
    const snapshot = this.snapshotFn;
    if (!snapshot || this.snapshotUnavailable) return;
    let cursor: string | undefined;
    let applied = false;
    for (;;) {
      let page: SyncSnapshotPage;
      try {
        page = await snapshot(cursor !== undefined ? { cursor } : {});
      } catch (err) {
        if (applied) throw err; // unsound to fall back — see the note above
        this.snapshotUnavailable = true;
        return; // nothing was written; `since=0` takes over
      }
      if (!applied) await this.claimSnapshotPrefix(page.asOfSeq);
      const last = page.nextCursor == null || page.nextCursor === "";
      if (last) {
        // Rows + cursor in ONE flush. The buckets are a formality: `flattenResponse` concatenates
        // all four and `applyToRecords` dispatches on each change's own `op`, so which bucket a
        // change sits in cannot affect the result. Snapshot changes are all `op:"create"`.
        await this.store.applyResponse({
          changes: { creates: page.changes, updates: [], moves: [], deletes: [] },
          cursor: encodeSeqCursor(page.asOfSeq),
          hasMore: false,
          serverTime: this.now().toISOString(),
        });
      } else {
        await this.store.applyChanges(page.changes); // rows only — the cursor stays "0"
      }
      applied = true;
      this.notify();
      if (last) return;
      cursor = page.nextCursor as string;
    }
  }

  // ── the windowed store: keeping only part of the mailbox on disk ─────────

  /**
   * Evict the messages this client has chosen not to keep; returns whether anything went. The
   * shape is {@link OhmailEngine.purgeProtectedBodies}'s: one pass computing a victim list, then
   * the store write. It runs after a drain, not on a timer: a timer would evict mid-bootstrap, and
   * "we are caught up" is the only moment the newest-N half of the window means what it says. The
   * rule: keep the newest `minRows` whatever their age (what stops a quiet mailbox evicting itself
   * down to an empty app); of the rest, keep anything newer than `days`; evict the remainder.
   */

  /**
   * Minus the pin set, which is the part that matters: a message the product is still USING must never be evicted for
   * being old — the thing referencing it renders from the mirror and would render a hole. Five references pin: a
   * surface currently RENDERING it (nothing in the mirror points at an open message — see {@link
   * OhmailEngine.pinnedMessageIds}); a `draft` replying to it (a reply-later draft outlives the window); a
   * `message_state` that is not `none` (every triage pile IS a set of these, and `bubbled_up` is a TIMER on an old
   * message — evicting it deletes the reminder); a `routing_decision` still `pending_approval`; and an `approval`
   * still `pending` — both unanswered questions, unanswerable without the mail. Anything resolved does NOT pin: it is
   * history, and history is what the window is for.
   */
  private async pruneToPolicy(): Promise<boolean> {
    const policy = this.storePolicy;
    if (policy.mode !== "windowed") return false; // `full` — the default. Nothing is ever evicted.

    const rows = this.store.entries<EngineMessage>("message");
    if (rows.length <= policy.minRows) return false;

    // Newest first. `date` is the mail's own time and the order every pile renders in; a row
    // without one (or with an unparseable one) sorts oldest, but is still protected by the
    // minRows floor and by the pin set — it is never singled out.
    const sorted = [...rows].sort((a, b) => messageTime(b.entity) - messageTime(a.entity));
    const cutoff = this.now().getTime() - policy.days * 86_400_000;
    const pinned = this.pinnedMessageIds();

    const victims: Array<{ type: string; id: string }> = [];
    for (let i = policy.minRows; i < sorted.length; i++) {
      const row = sorted[i]!;
      if (messageTime(row.entity) >= cutoff) continue;
      if (pinned.has(row.id)) continue;
      victims.push({ type: "message", id: row.id });
    }
    if (victims.length === 0) return false;
    await this.store.prune(victims); // hard delete + the `message_body` cascade
    return true;
  }

  /**
   * Note that a surface has asked to render this message. Newest last; the oldest fall off at
   * {@link RENDERED_PINS}. Re-asking moves an id back to the newest end, so a message that is
   * re-opened is held again rather than ageing out mid-read.
   */
  private noteRendered(messageId: string): void {
    this.renderedIds.delete(messageId);
    this.renderedIds.add(messageId);
    while (this.renderedIds.size > RENDERED_PINS) {
      const oldest = this.renderedIds.values().next();
      if (oldest.done) break;
      this.renderedIds.delete(oldest.value);
    }
  }

  /** The pin set — every message id the mirror is still referencing. See {@link pruneToPolicy}. */
  private pinnedMessageIds(): Set<string> {
    const pinned = new Set<string>();

    /**
     * The message on screen, which nothing in the mirror references. Every other clause reads a ROW that points at a
     * message; an open message is pointed at by nothing (reading is not a mutation), so the four record clauses could
     * all be satisfied while the windowed prune hard-deleted, cascade included, the mail under the reader's eyes.
     * `hydrateBody` is the signal and not a new registration call: every reading surface already tells the engine
     * which message it renders, from an effect keyed on the open id — that call IS the statement "I am rendering this
     * body", so honouring it needs no second seam a surface could forget. Not a promise that everything ever opened
     * survives: the hold is capped ({@link RENDERED_PINS}) and lives only in this tab — what the surfaces are
     * showing, not a second retention policy.
     */
    for (const id of this.renderedIds) pinned.add(id);

    for (const d of this.store.list<EngineDraft>("draft")) {
      if (d.inReplyToMessageId) pinned.add(d.inReplyToMessageId);
    }
    // The record id IS the message id for `message_state` (see `mutations.ts`), but the DTO
    // carries it too — read the field first so a server that ever keys these differently does not
    // silently empty this half of the set.
    for (const { id, entity } of this.store.entries<MessageStateDTO>("message_state")) {
      if (entity.state && entity.state !== "none") pinned.add(entity.messageId || id);
    }
    for (const r of this.store.list<PendingRoutingDecision>("routing_decision")) {
      if (r.status === "pending_approval" && r.messageId) pinned.add(r.messageId);
    }
    for (const a of this.store.list<PendingApproval>("approval")) {
      if (a.status === "pending" && a.messageId) pinned.add(a.messageId);
    }
    return pinned;
  }

  /**
   * A drain guaranteed to have STARTED AFTER the caller's write committed. `syncOnce()` coalesces —
   * right for a poll, wrong for a mutation reconciling its own write: a drain issued BEFORE the
   * POST committed read the log below the mutation's row and cannot carry it, however long it
   * takes; `dispatch` awaited it anyway, dropped the overlay, and the mail snapped back until the
   * next 8 s poll. Reported twice as "when I select one as ohbox, it does not seem to work" — and
   * then it does: it depends on whether a poll was in flight when the click landed, intermittent by
   * construction.
   */

  /**
   * "Started after the POST returned" is sufficient because the server allocates each seq through an `UPDATE …
   * RETURNING` on the account's `account_sync_state` row inside the mutation's own transaction, so seq order equals
   * COMMIT order per account: a drain issued after our POST returned reads a log in which our row is visible. The
   * argument rests entirely on that row lock — a future `bigserial` seq would leave every test green and make this
   * silently unsound. Deliberately NOT a wait for `cursor >= outcome.seq`: the cursor is the max seq RETURNED after
   * the `types` filter, so with `EngineOptions.types` set the wait never terminates; it also needs a fallback anyway
   * (`seq: null` on a stripped header), and a wait loop is unbounded requests with nobody behind them, where this is
   * exactly one drain.
   */

  /**
   * Cost: nothing in the common case — no drain in flight means `syncOnce()` starts one NOW, the same single drain
   * the mutation always paid for. A drain in flight means ONE follow-up, shared by every mutation landing in the
   * window (three clicks during one poll are three overlays and one extra drain). The bound comes from `syncOnce()`
   * itself: the waiting callbacks run as consecutive microtasks, the first assigns `this.syncing` synchronously,
   * every sibling coalesces — proven by experiment, the remembered-drain field removed with the suite green. Drains
   * never overlap (concurrency 1, `sync-liveness.test.ts`).
   */

  /**
   * Two accepted costs: a mutation landing during the cold bootstrap waits for it plus a follow-up (it already did,
   * through coalescing), and a POST that returned before the current drain started chains one drain it did not need —
   * sound, bounded at one, and distinguishing it would need a wall clock.
   */
  private syncFresh(): Promise<void> {
    const inFlight = this.syncing;
    // Nothing running ⇒ this starts a drain now, which is already after the commit.
    if (!inFlight) return this.syncOnce();
    return inFlight
      // The IN-FLIGHT drain's failure is not this mutation's failure — it is a poll that has
      // nothing to do with the write, and this mutation still needs its own drain afterwards.
      // Its rejection still reaches its own caller (the scheduler counts it and arms backoff):
      // `.catch` derives a NEW promise and steals no handler.
      .catch(() => { /* see above */ })
      .then(() => this.syncOnce());
  }

  /** Hook an SSE/EventSource (or push relay) as a wake signal: `sync` events nudge a drain. */
  attachWakeSignal(source: WakeSignalSource, event = "sync"): () => void {
    const onWake = (): void => {
      void this.syncOnce().catch(() => {
        /* a wake nudge must never throw into the event loop; the next tick retries */
      });
    };
    source.addEventListener(event, onWake);
    return () => source.removeEventListener(event, onWake);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** The overlay-merged reader — what selectors and the UI consume. */
  read(): EntityReader {
    return this.readerView;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  /**
   * WHAT A SURFACE MAY SAY ABOUT THIS MIRROR'S AGE — the one derivation of the Freshness Contract's three states (see
   * {@link FreshnessState}), computed from the drain's own completion stamp on the engine's own clock. Every surface
   * reads THIS; none re-derives it from meta, which is how three surfaces stay one contract. The comparison is the
   * same one {@link OhmailEngine.freshenStaleResume} makes — same stamp, same threshold, same clock — so "the label
   * is showing" and "the resume freshens newest-first" are a single fact observed twice, never two opinions that can
   * drift. CACHED BY VALUE for `useSyncExternalStore`: `getSnapshot` must return a stable identity while nothing
   * changed, or React loops on a fresh object per render.
   */

  /**
   * The value changes when a drain settles (which {@link OhmailEngine.drain} announces with a notify after stamping)
   * or when the clock crosses the threshold between two notifies — re-read at the next render either way.
   */
  freshness(): MirrorFreshness {
    // The DERIVATION is `@trafficflow/core/drain-policy`'s, shared with the sidecar's
    // `CloudMirror`; what stays here is the identity cache below, which is a React concern and
    // not a policy one.
    const next = mirrorFreshness(
      this.store.getMeta<string>(LAST_DRAIN_AT_META), this.now(), this.staleResumeMs,
    );
    if (next.state !== this.freshnessCache.state || next.asOf !== this.freshnessCache.asOf) {
      this.freshnessCache = next;
    }
    return this.freshnessCache;
  }

  /** The last {@link MirrorFreshness} handed out — identity-stable while its value stands. */
  private freshnessCache: MirrorFreshness = { state: "unknown", asOf: null };

  // ── message bodies ───────────────────────────────────────────────────────

  /**
   * Fetch one message's body, on explicit intent — the capability behind every reading surface (before it, the wire
   * carried `snippet` only, so every stream card measured "short" and the Expand pill never appeared). The result
   * goes into a client-local `message_body` record ({@link MessageBodyRecord}), never onto the message row.
   * Idempotent, single-flight: two surfaces render the same message at once, so concurrent callers join one request,
   * and a `ready` body is never re-fetched. A `loading` record with no promise behind it (a tab died mid-request; the
   * record persists, the promise does not) IS re-fetched — that cannot loop, because a `loading` record this engine
   * writes always has an in-flight entry above it; the map is the dedup, and deciding from the record alone would
   * make a zombie `loading` a permanent spinner.
   */

  /**
   * `retry` — why a failure is not retried by default: most callers are React effects that re-run
   * whenever inputs change, and a failed fetch writes a record, bumps the version, re-renders — a
   * `failed` state that re-fetched on the default path is a billed request loop against a server
   * already refusing (found by exactly that: a 500-ing adapter under a per-render callback spun
   * until the test timed out). The rule is about WHO asks: an automatic trigger asks once; a HUMAN
   * act passes `retry` and asks again, which also makes the failed state's exit a thing the user
   * chose. It never rejects: the outcome is the RECORD (`ready` or `failed`), a thing the UI
   * renders — reported on screen, not thrown at the DOM.
   */

  /**
   * `urgent` — a message somebody is looking at does not wait behind a backlog. {@link bodySlot}
   * runs four fetches and queues the rest, FIFO with no notion of what is on screen, so the
   * message just SELECTED could queue behind a Screener preview nobody is watching. `urgent`
   * jumps that queue, passed by the shell's two selection effects and nothing else — "this is the
   * message being opened" is knowledge only the selection has. A separate flag from `retry`,
   * deliberately: `retry` also jumps the queue, but it ALSO bypasses the failed-guard, so a
   * selection effect carrying it would re-ask a refusing server on every render — exactly the
   * billed poll the guard prevents. Two facts, two flags.
   */
  async hydrateBody(messageId: string, opts: { retry?: boolean; urgent?: boolean } = {}): Promise<void> {
    /**
     * ── AND IT DOUBLES AS "A SURFACE IS RENDERING THIS MESSAGE" ─────────────────────────────
     *
     * Recorded FIRST, above every early return, because the statement is true whatever the
     * answer turns out to be — a protected message and a body already `ready` are both on
     * screen. {@link OhmailEngine.pinnedMessageIds} reads it so the windowed prune cannot evict
     * the message a reader is looking at; see there for why this call is the signal.
     */
    this.noteRendered(messageId);
    const inFlight = this.bodyRequests.get(messageId);
    if (inFlight) {
      // JOINED, and then re-prioritised: the request may have been created by the background pass
      // (or by a thread open) and be sitting in the non-urgent queue. See
      // {@link promoteBodyRequest} — without this the claim "an open always jumps" is false for
      // precisely the messages the prefetch has queued.
      if (opts.urgent === true || opts.retry === true) this.promoteBodyRequest(messageId);
      return inFlight;
    }

    const plan = this.bodyPlan(messageId, opts.retry === true);
    if (plan.kind === "skip") return;
    if (plan.kind === "purge") return this.putBody(messageId, null);

    /**
     * ── EVERYTHING UP TO THIS `set` IS SYNCHRONOUS, AND IT HAS TO BE ────────────────────────
     *
     * The single-flight is the map, and a map written after an `await` is not one: two effects
     * firing in the same tick — which is what React does, twice over in StrictMode — would both
     * see an empty entry and both issue a request. `bodyPlan` is therefore a pure, synchronous
     * decision, and the first thing that may suspend is the marker write inside `startBody`,
     * which happens AFTER the promise is already registered here.
     */
    const request = this.startBody(messageId, plan.held, opts.urgent === true || opts.retry === true);
    this.bodyRequests.set(messageId, request);
    return request;
  }

  /**
   * IS THERE A BODY TO ASK FOR, AND WHAT IS HELD NOW — the whole admission decision, in one synchronous place because
   * two callers need exactly the same answer. {@link OhmailEngine.hydrateBody} asks about one message and {@link
   * OhmailEngine.hydrateThread} about a conversation's worth at once. Re-deriving these rules in the second caller
   * would put "does the demo issue requests", "is a protected body purged" and "is a failed body re-asked" in two
   * places that are only ever tested through one of them. `purge` is separated from `skip` because it is a WRITE, and
   * this function performs none — see the note in `hydrateBody` about why nothing here may suspend.
   */
  private bodyPlan(
    messageId: string,
    retry: boolean,
  ): { kind: "skip" } | { kind: "purge" } | { kind: "fetch"; held: MessageBodyRecord | undefined } {
    const msg = this.read().get<EngineMessage>("message", messageId);
    // Not in the mirror at all — a fixture `screener_sender`'s held id, or a row that has
    // since been drained away. Nothing to ask about.
    if (!msg) return { kind: "skip" };
    /**
     * ALREADY WHOLE. The demo's message rows carry `body` (`fixtures-adapter.ts` →
     * `toMessage`), and `bodyOf` answers `full` from exactly this field — so the two agree
     * by construction rather than by both being remembered. This is also what keeps the
     * demo at zero requests without the demo being a special case here.
     */
    if (msg.body !== undefined) return { kind: "skip" };
    /**
     * A PROTECTED MESSAGE HAS NO BODY TO ASK FOR — AND MUST HOLD NONE AT REST. Its surface renders `ProtectedBlock`
     * and no text whatever the mirror holds (`MessagePane` is where that decision lives), so a fetch here could only
     * ever produce a record nothing reads. Skipping it also keeps the demo's one body-less fixture from churning a
     * loading record every time it is selected. The second clause is the at-rest half. A message that cached a body
     * while it was ORDINARY and then became protected is the raw secret sensitive mail is redacted to avoid, sitting
     * in IndexedDB (and, via {@link SearchIndex}, the local search index). The delta cascade in {@link MirrorStore}
     * purges on the transition; this is the belt-and-braces for a body cached by an older engine, or one the
     * transition missed — purge any held record before returning.
     */

    /**
     * `isProtectedMessage` keys on `sensitivity.sensitive` (the Cloud signal) as well as the fixture `protected`
     * extra, so the real reclassification case is covered, not only the demo.
     */
    if (isProtectedMessage(msg)) {
      const held = this.read().get<MessageBodyRecord>("message_body", messageId);
      return held === undefined ? { kind: "skip" } : { kind: "purge" };
    }
    const held = this.read().get<MessageBodyRecord>("message_body", messageId);
    /**
     * Already ready — AND from a build that knew about `html`. The html renderer shipped, and a message already
     * opened was still a text dump: `message_body` records persist, one written by an older build has no `html` key
     * at all, `ready` suppressed the fetch, and every message the reader had already opened stayed frozen in the
     * pre-fix shape — while new mail rendered correctly, which is why the product looked unfixed only to the people
     * already using it. `html !== undefined` and NOT `!= null`, and the difference is the whole of it: `undefined` —
     * no build ever answered; ask now. `null` — a build asked and the answer was "no html" (a plain-text mail, or a
     * sensitive one whose html is deliberately not stored); re-asking is a permanent billed poll.
     */

    /**
     * A re-read, not a migration ({@link MessageBodyRecord} says why inventing `html: null` is forbidden) and not a
     * sweep — one extra request per message the reader opens again. It terminates because `fetchBodyInto` always
     * writes the key; `body-hydration.test.ts` asserts the COUNT, not just the outcome.
     */
    if (held?.state === "ready" && held.html !== undefined) {
      /**
       * The one ready record still worth asking about: a record from a build predating the storage-cap marker cannot
       * be told from a genuinely empty message — `{state: "ready", text: "", html: null}` is exactly what a pre-slice
       * client persists for a body the server has begun WITHHOLDING. Left alone, `bodyOf` reports `full` over nothing
       * for ever. `withheld === undefined` is the discriminator, and it works only because both write sites now
       * ALWAYS set the key — one re-ask heals the record and it can never match this branch again. Narrow on purpose:
       * only `text === ""` AND `html === null` qualifies (the withheld shape); a plain-text mail with real text must
       * never become a request, and `bodyHealed` bounds it to once per engine even if the mirror write is refused.
       */
      const preCapEmpty = held.text === "" && held.html === null && held.withheld === undefined;
      if (!preCapEmpty || this.bodyHealed.has(messageId)) return { kind: "skip" };
      this.bodyHealed.add(messageId);
      return { kind: "fetch", held };
    }
    /**
     * A FAILURE IS FOR THIS SESSION, NOT FOR EVER: See `retry` above for why an automatic trigger must not re-ask a
     * server that already refused: the effects behind this call re-run on every mirror bump, and a failed record IS a
     * mirror bump, so re-asking on the default path is a billed poll with nobody behind it. That argument is about
     * ONE SESSION and was being applied for ever, because these records are persisted. A body that failed during a
     * deploy, on a lost connection, or on a lambda that cold-started past the 12 s deadline stayed `failed` in that
     * browser until the reader pressed Retry on that exact message — and reloading the tab, which is what everybody
     * actually does, changed nothing at all. So the guard is narrowed to the thing it was defending: within this
     * engine's life, never re-ask.
     */

    /**
     * A record stamped before {@link OhmailEngine.bootedAt} — or carrying no stamp, which by construction means a
     * build that predates the field and therefore an earlier session ({@link MessageBodyRecord.failedAt}, read
     * exactly as `html !== undefined` above is) — is re-asked ONCE, and `bodyHealed` is what makes that "once" a
     * property of the engine rather than of a mirror write that can itself be refused.
     */
    if (held?.state === "failed" && !retry) {
      const stale = held.failedAt === undefined || held.failedAt < this.bootedAt;
      if (!stale || this.bodyHealed.has(messageId)) return { kind: "skip" };
      this.bodyHealed.add(messageId);
    }
    return { kind: "fetch", held };
  }

  /**
   * THE `loading` MARKER IS WRITTEN AT ENQUEUE, NOT AT DEPARTURE: This used to live at the top of `fetchBodyInto`,
   * which runs inside {@link bodySlot} — i.e. only once a slot is free. Four fetches may be in the air, so the fifth
   * message a reader opened had NO `message_body` record at all for as long as the queue held it, and a message with
   * no record is exactly what `bodyOf` answers `snippet` for. The surfaces then rendered that snippet as though it
   * were the mail: 200 characters cut mid-word, inside full message anatomy, with nothing on screen saying anything
   * was still coming. Silent, and worst precisely when the app is busiest. Writing it here closes the window
   * structurally: from the moment a fetch is DECIDED there is a record saying so, whether it departs now or in four
   * round trips.
   */

  /**
   * The surfaces' snippet branch becomes unreachable for a message being hydrated, which is why they may now treat a
   * resting `snippet` as the defect it is. The `.finally` clears the single-flight entry on both arms, rejection
   * included — a leaked entry would make every later call join a promise that is never coming back, which is the
   * failure {@link BODY_FETCH_TIMEOUT_MS} exists for, reached from the other side.
   */
  private startBody(
    messageId: string,
    held: MessageBodyRecord | undefined,
    urgent: boolean,
  ): Promise<void> {
    return this.markLoading(messageId, held)
      .then(() => this.bodySlot(urgent, () => this.fetchBodyInto(messageId), [messageId]))
      .finally(() => {
        this.bodyRequests.delete(messageId);
      });
  }

  /**
   * `held` is here so a re-read does not take the message off the screen. The write used to be unconditional, and
   * that is destructive: `bodyOf` answers a `loading` record with the SNIPPET, so a message being read collapsed to
   * one line the instant anything asked again — and the legacy re-read fires on exactly the message the reader just
   * opened; if the fetch then failed, they had LOST a body they already had. A `ready` record is left alone until
   * there is something better to put in its place. The refusal is swallowed, and that is not a tidy-up: this write
   * sits outside `fetchBodyInto`'s try, so an unguarded IndexedDB rejection (full quota, private window, a
   * version-changed connection) would propagate out of `hydrateBody` and break its never-rejects contract in a React
   * effect. The fetch still goes ahead: a mirror that cannot hold a marker can very well hold the answer.
   */
  private async markLoading(messageId: string, held: MessageBodyRecord | undefined): Promise<void> {
    if (held?.state === "ready") return;
    try {
      await this.putBody(messageId, {
        messageId, state: "loading", text: "", html: null, loadedRemoteContent: false,
      });
    } catch {
      /* the mirror refused the marker; ask anyway — see above, never rethrow */
    }
  }

  /**
   * One request for a whole conversation. Opening a thread needs every sibling's body, and the surface used to ask
   * one at a time through a four-wide limiter — eight siblings were eight requests, the last two not even STARTING
   * until a round trip finished, and the reader watched the conversation assemble in steps; the batch route answers
   * all in one. It changes nothing else: admission is `hydrateBody`'s own through {@link bodyPlan} (a demo row is not
   * asked, a protected sibling is PURGED rather than fetched — why the ids are passed in, not filtered by the caller
   * — a `ready` body with an `html` key is left alone, a failure re-asks only across a session boundary); markers are
   * written for the whole set BEFORE anything leaves, and the single-flight entries register synchronously so a
   * double-invoked effect produces one request.
   */

  /**
   * Not required to exist: an adapter with no batch route falls back to per-message, and a server that ignores the
   * parameter is merely slower — unanswered ids are fetched singly below.
   */
  hydrateThread(messageIds: string[]): Promise<void> {
    return this.hydrateMany(messageIds, { rendered: true });
  }

  /**
   * THE DRAFT'S TEXT, ASKED FOR ONCE, FOR A MIRROR ROW THAT ARRIVED WITHOUT ONE. Returns the text, or `null` when
   * this client cannot get it — an adapter without the capability (the demo world, whose rows always carry a body), a
   * refusal, or a server that named no text. `null` is what compose must not seed an editor from and what autosave
   * must not write back; a caller that treated it as "" would replace the person's message with the blank this client
   * happens to be holding. Nothing is written to the mirror. The row is the server's DTO and the next page carrying a
   * body is what repairs it; a local patch would put text at a seq the store did not observe.
   */
  async readDraftBody(draftId: string): Promise<string | null> {
    const fetchDraftBody = this.adapter.fetchDraftBody?.bind(this.adapter);
    if (!fetchDraftBody) return null;
    try {
      return await fetchDraftBody(draftId);
    } catch {
      return null;
    }
  }

  /**
   * The shared batch core behind {@link hydrateThread} and the eager pass. `rendered` is the
   * one difference between the two callers, and it is a fact only the caller knows: a thread
   * open means every one of these ids is ON SCREEN and must be pinned against the windowed
   * prune; a background prefetch means none of them is, and pinning them would flush the
   * {@link RENDERED_PINS} LRU of the ids that genuinely are.
   */
  private hydrateMany(
    messageIds: string[],
    opts: { rendered: boolean; stopped?: () => boolean },
  ): Promise<void> {
    const fetchBodies = this.fetchBodiesFn;
    const ids = [...new Set(messageIds)];
    if (!fetchBodies) {
      if (opts.rendered) {
        return Promise.all(ids.map((id) => this.hydrateBody(id))).then(() => undefined);
      }
      // The per-id fallback WITHOUT the pin write `hydrateBody` opens with — same admission,
      // same single-flight registration, no claim that a surface is rendering anything. A caller
      // that can be torn down (the eager pass) is asked before each id, for the reason
      // `runEagerBodies` gives: this loop is as long as the slice.
      const runs = ids.map((id) => {
        if (opts.stopped?.() === true) return Promise.resolve();
        const inFlight = this.bodyRequests.get(id);
        if (inFlight) return inFlight;
        const plan = this.bodyPlan(id, false);
        if (plan.kind === "purge") return this.putBody(id, null);
        if (plan.kind === "skip") return Promise.resolve();
        const request = this.startBody(id, plan.held, false);
        this.bodyRequests.set(id, request);
        return request;
      });
      return Promise.all(runs).then(() => undefined);
    }

    const take: Array<{ id: string; held: MessageBodyRecord | undefined }> = [];
    const writes: Array<Promise<void>> = [];
    for (const id of ids) {
      if (opts.rendered) this.noteRendered(id);
      // Already in the air, alone or in another batch — join it rather than ask twice.
      if (this.bodyRequests.has(id)) continue;
      const plan = this.bodyPlan(id, false);
      if (plan.kind === "purge") { writes.push(this.putBody(id, null)); continue; }
      if (plan.kind === "skip") continue;
      take.push({ id, held: plan.held });
    }

    // Split rather than refuse: the server caps an id list at {@link BODIES_IDS_MAX} because a
    // truncated answer is indistinguishable from "those messages have no body", so a conversation
    // longer than the cap becomes two requests here and never a 400 the reader would see.
    for (let i = 0; i < take.length; i += BODIES_IDS_MAX) {
      const chunk = take.slice(i, i + BODIES_IDS_MAX);
      const chunkIds = chunk.map((c) => c.id);
      const run = Promise.all(chunk.map((c) => this.markLoading(c.id, c.held)))
        .then(() => this.bodySlot(false, () => this.fetchBodiesInto(chunkIds, fetchBodies, opts.stopped), chunkIds))
        .finally(() => {
          for (const id of chunkIds) this.bodyRequests.delete(id);
        });
      for (const id of chunkIds) this.bodyRequests.set(id, run);
      writes.push(run);
    }
    return Promise.all(writes).then(() => undefined);
  }

  /**
   * Distribute one batch answer into `message_body` records. THE ROWS ARE MATCHED BY ID, NEVER BY POSITION. The
   * server answers only the ids the caller's own account owns and omits the rest — silently, so the response cannot
   * be read as an existence oracle for somebody else's ids — and it may also stop early on its byte budget. So
   * "shorter than asked" is a normal answer, and an id the batch did not carry is asked for on its own rather than
   * left as a marker nothing will ever replace. That per-id tail is also what makes a server which does not
   * understand the parameter degrade to the old behaviour instead of to a thread of empty messages. A THROW IS THE
   * WHOLE BATCH'S. One request carried all of these, so its refusal is each of their refusals — every id gets the
   * `failed` record it would have got asking alone, which is a state the surfaces render with a Retry beside it.
   */
  private async fetchBodiesInto(
    ids: string[],
    fetchBodies: FetchBodiesFn,
    stopped?: () => boolean,
  ): Promise<void> {
    let rows: MessageBodyBatchWire[] | null;
    try {
      rows = await fetchBodies(ids);
    } catch (err) {
      await Promise.all(ids.map((id) => this.failBody(id, err)));
      return;
    }
    // `null` ⇒ this adapter serves no bodies. Same meaning and same handling as `fetchBody`'s
    // `null`: tombstone the markers rather than leave a surface saying "loading…" for ever.
    if (rows === null) {
      for (const id of ids) {
        try { await this.putBody(id, null); } catch { /* the mirror refused; nothing to report */ }
      }
      return;
    }
    const byId = new Map(rows.map((r) => [r.messageId, r]));
    const missing: string[] = [];
    for (const id of ids) {
      const wire = byId.get(id);
      if (wire === undefined) { missing.push(id); continue; }
      try {
        // The same record `fetchBodyInto` writes, field for field — including the `?? null`
        // normalisations, which are about the KEY existing rather than about the value. See
        // there: a record that could leave `html` absent lands back in the re-read branch and
        // polls for ever.
        await this.putBody(id, {
          messageId: id,
          state: "ready",
          text: wire.text,
          html: wire.html ?? null,
          loadedRemoteContent: wire.loadedRemoteContent === true,
          unsubscribe: wire.unsubscribe ?? "no_header",
          unsubscribeUrl: wire.unsubscribeUrl ?? null,
          // ALWAYS written, never spread conditionally — `null` is "a withheld-aware build
          // answered, and this body is ordinarily stored". Absence is reserved for records no
          // such build ever touched, which is what makes the pre-slice heal terminate. The batch
          // path and the single path must agree; see `MessageBodyRecord.withheld`.
          withheld: withheldMarkerOf(wire.withheld),
        });
      } catch (err) {
        await this.failBody(id, err);
      }
    }
    /*
     * THE PER-ID TAIL, AND IT IS INTERRUPTIBLE. "Shorter than asked" is a normal answer — the
     * server omits ids the account does not own and stops early on its byte budget — so this loop
     * can be as long as the batch was, one request at a time. A background pass that has been
     * torn down must not walk it: the generation was checked before the batch left, and the answer
     * arrives arbitrarily later. Bodies already in the air still land in the store; nothing new
     * leaves.
     */
    for (const id of missing) {
      if (stopped?.() === true) return;
      await this.fetchBodyInto(id);
    }
  }

  /**
   * How many bodies may be in the air at once. `bodyRequests` single-flights per MESSAGE — the wrong axis for the
   * caller that matters: the Screener preview hydrates every held message of a sender in one effect, so forty held
   * messages opened forty requests in one tick, none of them duplicates. On screen that was the reported defect: a
   * burst overrunning the connection limit turns into plain-text dumps beside one or two rendered frames — it looks
   * like the viewer failing on threads; it is the fan-out.
   */

  /**
   * A human jumps the queue on either fact that means somebody is waiting for THIS message: `retry: true` (a person
   * pressing "try again") and `urgent: true` (the shell saying a message was just OPENED — the body that is the whole
   * screen must not queue behind a preview backlog); both arrive as one `urgent` parameter, two flags at the call
   * site because only one may also re-ask a server that refused (`hydrateBody`). The slot is released in `finally`,
   * including on rejection — a leaked slot starves every later hydration, silently.
   */
  private bodySlot<T>(urgent: boolean, run: () => Promise<T>, ids: readonly string[] = []): Promise<T> {
    if (urgent || this.bodyActive < MAX_CONCURRENT_BODIES) {
      this.bodyActive++;
      return run().finally(() => {
        this.bodyActive--;
        this.bodyQueue.shift()?.start();
      });
    }
    return new Promise<T>((resolve, reject) => {
      this.bodyQueue.push({
        ids,
        start: () => {
          this.bodyActive++;
          run().then(resolve, reject).finally(() => {
            this.bodyActive--;
            this.bodyQueue.shift()?.start();
          });
        },
      });
    });
  }

  /**
   * Let a waiting request for this message go NOW — the other half of "an open always jumps". `hydrateBody`
   * single-flights per message, and the eager pass registers hundreds of ids queued NON-urgently — so opening one of
   * those found the existing promise and waited behind slots of work nobody was watching: urgency was decided at
   * creation and never revisited, making "urgent opens jump the queue" false in exactly the case the prefetch
   * created. So urgency is re-decided on demand: the entry is pulled out of the queue and started immediately,
   * including exceeding {@link MAX_CONCURRENT_BODIES} by one, which is what "urgent" has always meant here. A no-op
   * when the id is not waiting (running already, or done). A BATCH entry is promoted whole — its ids travel in one
   * request, the same shape a thread open has always had.
   */
  private promoteBodyRequest(messageId: string): void {
    const at = this.bodyQueue.findIndex((e) => e.ids.includes(messageId));
    if (at < 0) return;
    const [entry] = this.bodyQueue.splice(at, 1);
    entry!.start();
  }

  /**
   * Unsubscribe this message's sender (RFC 8058 one-click, performed server-side). A passthrough
   * to the adapter, because there is nothing to reconcile into the mirror — the effect lives at a
   * third party, and the record of "we already asked" is the SERVER's `unsubscribe_records`
   * table, not a client entity. Returns `null` when the adapter serves no unsubscribe (the
   * FixturesAdapter — the demo, a test with no API), so a surface offers no control rather than a
   * dead one. A refusal REJECTS with the server's own sentence (`MutationRejectedError`), which
   * is the string the surface renders.
   */
  async unsubscribe(messageId: string): Promise<UnsubscribeResult | null> {
    if (!this.adapter.unsubscribe) return null;
    return this.adapter.unsubscribe(messageId);
  }

  /**
   * THE WRITE IS INSIDE THE TRY, WHICH IS NOT A TIDY-UP: `putBody` reaches IndexedDB, and IndexedDB refuses: a quota
   * that is full, a private window, a connection closed by a version change, an `IdbMirrorStore` whose owner moved. A
   * write outside the `try` propagates that refusal out of `hydrateBody` — breaking the "WHY IT NEVER REJECTS"
   * contract stated above it, in a React effect, where the outcome is an unhandled rejection over somebody's mailbox.
   * Everything that can throw is inside, and the failure arm has its own guard: see {@link OhmailEngine.failBody}.
   * The `loading` marker is NO LONGER WRITTEN HERE. It moved up to {@link markLoading}, which runs at enqueue rather
   * than at departure — see there for the window that closed.
   */
  private async fetchBodyInto(messageId: string): Promise<void> {
    try {
      const wire = await this.adapter.fetchBody(messageId);
      // `null` ⇒ this adapter serves no bodies (the fixtures world): tombstone the loading marker rather than leaving
      // a surface saying "loading…" for ever — `bodyOf` falls back to the snippet, the honest answer for an adapter
      // with no endpoint. `html` rides along UNTOUCHED: this is the one hop between the wire and the renderer and it
      // must stay a carry — sanitizing here would put attacker markup through a transform no surface can see, written
      // into the mirror. `?? null` is about the KEY existing, not the value: it maps `undefined` (a field this
      // adapter did not answer) onto the `null` that MEANS "no html", so a record this engine wrote always carries
      // the key — `hydrateBody` decides a record predates the html part from `html === undefined`, and a write that
      // left the field absent would poll for ever.

      // `EngineAdapter.fetchBody` is a seam with four implementations and no compiler check, so loop termination must
      // be the engine's property, not one adapter's manners — proven: this file's own double answers `{ text }`
      // alone, and two "a READY body is not re-fetched" tests went red the moment `hydrateBody` learned to distrust
      // an absent key.
      await this.putBody(
        messageId,
        wire === null
          ? null
          : {
              messageId,
              state: "ready",
              text: wire.text,
              html: wire.html ?? null,
              loadedRemoteContent: wire.loadedRemoteContent === true,
              // The unsubscribe posture rides the same ready record. `HttpAdapter.fetchBody`
              // already normalised the wire (default `"no_header"` / `null`); `?? …` here keeps
              // a bare test double or the FixturesAdapter — which answer `{ text }` — honest.
              unsubscribe: wire.unsubscribe ?? "no_header",
              unsubscribeUrl: wire.unsubscribeUrl ?? null,
              // The server's withheld marker, ALWAYS written — `null` when the body is
              // ordinarily stored, never omitted. The record stays `ready` (the server ANSWERED,
              // so the single-flight ledger and every "a READY body is not re-fetched" rule
              // apply unchanged) and `bodyOf` derives the terminal `withheld` surface state from
              // the marker, never from emptiness. Writing the key unconditionally is what lets
              // the guard below distinguish "not withheld" from "never asked by a build that
              // could tell", and so what makes the pre-slice heal happen ONCE and stop.
              withheld: withheldMarkerOf(wire.withheld),
            },
      );
    } catch (err) {
      await this.failBody(messageId, err);
    }
  }

  /**
   * Record that this body could not be read — the state the surfaces render as "couldn't load the full message" with
   * a Retry beside it. ITS OWN WRITE IS GUARDED, AND THAT IS THE POINT OF SPLITTING IT OUT. This runs on the arm that
   * already knows something has gone wrong, and it reaches the same IndexedDB that may be the thing going wrong. A
   * throw from here would escape `fetchBodyInto`'s `catch` — there is no outer one — and reject `hydrateBody`, so the
   * mirror refusing a write would turn a reportable failure into an unhandled rejection. Swallowed deliberately: the
   * record keeps whatever it held, `hydrateBody` still resolves, the single-flight entry is still cleared by the
   * `.finally` above it, and the reader can ask again.
   */
  private async failBody(messageId: string, err: unknown): Promise<void> {
    try {
      await this.putBody(messageId, {
        messageId,
        state: "failed",
        text: "",
        html: null,
        loadedRemoteContent: false,
        error: err instanceof Error ? err.message : String(err),
        // WHEN, so a reload can tell this failure apart from one this session already made and
        // refused to repeat. See {@link MessageBodyRecord.failedAt} and `bodyPlan`'s failed arm.
        failedAt: this.now().getTime(),
      });
    } catch {
      /* the mirror refused the failure record too; see above — never rethrow */
    }
  }


  private async putBody(messageId: string, record: MessageBodyRecord | null): Promise<void> {
    await this.store.putLocal("message_body", messageId, record);
    this.notify();
  }

  // ── optimistic mutations ─────────────────────────────────────────────────

  /** Fill in wire-derivable fields so adapter + overlay agree on the payload. */
  private enrich(m: EngineMutation): EngineMutation {
    if (m.kind === "tag_assign" && m.labels === undefined) {
      const msg = this.read().get<EngineMessage>("message", m.messageId);
      if (msg) {
        const labels = m.assigned
          ? [...new Set([...msg.labels, m.tagId])]
          : msg.labels.filter((l) => l !== m.tagId);
        return { ...m, labels };
      }
    }
    if (m.kind === "feed_mark_seen") {
      const reader = this.read();
      // The mark-the-whole-feed form: every unread id of the VIEW'S folder, so the wire PATCHes
      // exactly the set the optimistic effect flips — per `FeedView`, no longer Reads-only.
      const folder = FOLDER_OF_VIEW[m.view ?? "reads"];
      const given = m.messageIds ?? reader
        .list<EngineMessage>("message")
        .filter((msg) => msg.folder === folder && msg.unread)
        .map((msg) => msg.id);
      /**
       * A glance reads; it does not spend the pin — and the server knows the difference. `feed_mark_seen` is the
       * involuntary read (the per-card dwell, the leave-commit), and this seam used to FILTER resurfaced ids out of
       * it so the PATCH could not reach `MessageService.spendResurface` — protecting the pin by DROPPING THE READ:
       * the flip-back reported live (2026-08-26), a pinned row presented read while open and turning back to unread
       * on leave because the read never landed. The rule now: a resurfaced message keeps its genuine read state, and
       * the glance itself goes on the wire — `HttpAdapter` sends `via: "glance"` and the server marks read WITHOUT
       * spending the pin; only dealing with the row takes the pin down (the read pill, `⇧I`, bulk, read-all, filing,
       * the settled reply, Done).
       */

      /**
       * The id list is still frozen HERE: the enriched mutation is what the overlay, the demo echo and the adapters
       * all read afterwards — one list, no divergence.
       */
      return { ...m, messageIds: given };
    }
    if (m.kind === "mail_send") {
      // FREEZE THE ENVELOPE HERE, and nowhere else. The overlay effect and the wire body are
      // both computed from this one object, so they cannot disagree — and because the
      // enriched mutation is what goes on the queue, a retry after a network failure sends
      // the SAME envelope rather than re-deriving it from a mirror that has since drained.
      if (m.inReplyTo === null) {
        // A COMPOSE. The recipient and the subject are the USER's and are not derived from
        // anything; the only unknown is which of the account's mailboxes it goes out from,
        // and `threadId` is pinned to null so nothing downstream can wander into a thread.
        return {
          ...m,
          mailboxId: m.mailboxId ?? sendingMailboxId(this.read()) ?? undefined,
          threadId: null,
        };
      }
      const parent = this.read().get<EngineMessage>("message", m.inReplyTo);
      if (!parent) return m; // unknown parent ⇒ no effects ⇒ mutate() rejects it below
      return {
        ...m,
        mailboxId: m.mailboxId ?? parent.mailboxId,
        threadId: m.threadId ?? parent.threadId,
        subject: m.subject ?? replySubject(parent.subject),
        // The reply goes to the sender of the message being answered. `Reply-To` is not in
        // the mirror (the DTO has no field for it), so a sender who set one is answered at
        // their From — filed as owed rather than silently approximated.
        to: m.to ?? [parent.from],
      };
    }
    return m;
  }

  /**
   * Apply locally NOW, fire the request, reconcile on the echo. Hard rejection ⇒ overlay rolled back; retryable
   * failure ⇒ the mutation stays queued and visible (user-always-wins) for `flushPending()` with the SAME key.
   * `opts.key` is for a caller that already owns an Idempotency-Key, and the one that needs it is the send:
   * `useMailSend` persists the key with the send lane the moment it is minted, ahead of this call, because a send's
   * lock must outlive the component — a reload inside the queued window used to let the restored editor mint a SECOND
   * key and deliver the same mail twice. Resuming the stored key makes the server's same-key branch
   * (`SendService.resumeExisting` — replay, report, or verify-by-Sent, never a blind resend) the authority on whether
   * that mail has gone.
   */

  /**
   * Not restricted to `mail_send` in the signature — the rule is "the caller owns this verb's identity" — but a key
   * must be durable at the caller before it is handed over, or this is just a slower `uuid()`.
   */
  async mutate(m: EngineMutation, opts: { key?: string } = {}): Promise<MutationResult> {
    const enriched = this.enrich(m);
    const id = this.uuid();
    const key = opts.key ?? this.uuid();

    // THE EFFECTS ARE COMPUTED BEFORE SUPERSESSION, deliberately: they must be read over the
    // superseded verbs' overlays. A reversal is the case that breaks the other order — a
    // queued move to Reads, then the user moves it back to INBOX: with the Reads overlay
    // already dropped the mirror says "it is in INBOX", the reversal computes zero effects,
    // and mutate() would reject a verb the server absolutely needs (the queued move may have
    // COMMITTED with its response lost, and only the reversal on the wire can undo it).
    const effects = mutationEffects(this.read(), enriched, { now: this.now, uuid: this.uuid });

    // THEN supersession, still SYNCHRONOUS — the first frame after mutate() must already show the newer verb's
    // overlay (re-resurface-first-frame pins that mutate() publishes before its first await), and enrich above read
    // the old overlays it needed. The store-side deletes/rewrites inside are fire-and-forget: if a kill outruns them,
    // the stale entry replays BEFORE the newer one — restore sorts by (at, n) — so the newer verb still lands last
    // and the server converges on the user's latest word. …and only AFTER the no-op check below: a verb with no
    // effects is about to be REJECTED, and a rejected verb supersedes nothing. Re-pressing a queued move (the
    // optimistic destination makes the repeat a no-op) must not retire the queued original — that entry may be the
    // only copy of an intent whose first attempt never reached the server.
    if (effects.length === 0) {
      const error = new MutationRejectedError(`mutation target not found (${m.kind})`, {
        status: 404, code: "not_found",
      });
      return { id, key, status: "rolled_back", seq: null, error };
    }
    const superseded = this.supersedeQueued(enriched);
    this.overlays.set(id, effects);
    this.overlayRev++;
    this.notify();

    /**
     * The verb is durable before it is sent — the outbox write ahead of the wire POST (INSTANT-ARCH §6.2(b)). The
     * order is the guarantee: a process killed between this line and the server's answer restarts with the entry
     * still in the mirror store, replays it under the SAME Idempotency-Key, and the verb lands exactly once. When the
     * write is refused, the verb decides: for almost everything the failure is swallowed and the verb goes on the
     * wire — a `triage_set` sent twice sets the same state twice, and refusing would cost a real action to protect
     * nothing. A SEND is not that verb: its key is the only thing between "retry" and a second message in someone's
     * inbox, and the key lives in the row that just failed — dispatch anyway and a death before the answer leaves the
     * next boot with no record, the user resends, and the server delivers twice with no key to match.
     */

    /**
     * So a send whose durable record was refused is rolled back and says so; the composer still holds the text.
     */
    const pending: PendingMutation = {
      id, key, mutation: enriched, at: this.now().getTime(), n: this.outboxSeq++,
      ...(superseded.retired.length > 0 ? { retire: superseded.retired } : {}),
    };
    // ONE TRANSACTION: the newer row in, the rows it supersedes out. See `supersedeQueued` for
    // why the removal may not be a separate best-effort delete.
    // Before the wire: a stale record must not be retryable while this verb is in flight.
    const markers = await superseded.marked;
    /**
     * A MARKER THAT DID NOT LAND IS A WRITE THIS DEVICE COULD NOT RECORD, so the same rule
     * applies as to any other: no write, no wire. The record it failed to mark is still retryable
     * and can later overwrite the state this verb is about to establish — the newer intent losing
     * to the older one, with both requests reporting success. Whatever DID land goes back, so the
     * refusal leaves nothing marked stale on behalf of a verb that never happened.
     */
    if (markers.failed > 0) {
      await this.undoMarkers(markers.marked);
      this.undoSupersede(superseded);
      this.overlays.delete(id);
      this.overlayRev++;
      this.notify();
      return {
        id, key, status: "rolled_back", seq: null,
        error: new MutationRejectedError(
          "this device could not record the change, and it replaces others that are still queued",
          { status: null, code: "storage_refused", retryable: true },
        ),
      };
    }
    const persisted = await this.putOutbox(pending, superseded.narrowed);
    if (!persisted && superseded.retired.length > 0) {
      /**
       * NO WRITE, NO WIRE — the supersession half of the rule stated in this module's header. This verb replaces
       * queued verbs. Its durable write was refused, so the store still holds the ones it would have retired, and
       * they are still the truth. Sending it anyway would put a change on the wire that this device has no record of,
       * over intents it has not managed to withdraw — and a kill would then replay those older verbs on top of it. So
       * nothing is dispatched, everything the supersession changed goes back, and the person is told the action was
       * refused rather than being shown it succeed and silently lose.
       */
      // The markers this verb wrote go back too: they were marked stale on behalf of a
      // replacement that is not happening, and leaving them would take away a Retry for a reason
      // that turned out not to exist.
      await this.undoMarkers(markers.marked);
      this.undoSupersede(superseded);
      this.overlays.delete(id);
      this.overlayRev++;
      this.notify();
      return {
        id, key, status: "rolled_back", seq: null,
        error: new MutationRejectedError(
          "this device could not record the change, and it replaces others that are still queued",
          { status: null, code: "storage_refused", retryable: true },
        ),
      };
    }
    if (!persisted && enriched.kind === "mail_send") {
      this.overlays.delete(id);
      this.overlayRev++;
      this.notify();
      return {
        id, key, status: "rolled_back", seq: null,
        error: new MutationRejectedError(
          "this device could not record the send, and sending without a record risks delivering it twice",
          { status: null, code: "storage_refused", retryable: true },
        ),
      };
    }

    /**
     * The fresh verb takes the same gate as every other road. It was the last dispatch outside {@link outboxGate},
     * waiting on a private `replayActive` deferred — serialized against the drive's replay and nothing else, so two
     * dispatches could be on the wire together; for the read verbs, whose supersession key is `null`, ordering IS the
     * contract (a newer unread landing before an older read leaves the server at the older value, silently). Joining
     * the chain is what "wait out whatever is in flight" means, bounded through {@link dispatchWithDeadline}. The
     * hold is still read synchronously FIRST, deliberately: it may stand for minutes and a person pressing Send must
     * not sit through it — the verb waits in the QUEUE (expressed, painted, persisted) and the hold's settle chains
     * the drive.
     */

    /**
     * The one exception is the caller-settled create (`draft_save`, draftId null): its caller adopts `entityId` from
     * THIS result and has no retry path, so it joins the gate and waits — a late-adopted draft id is correct; an
     * orphaned `queued` create is a twin factory.
     */
    const awaitsHold = enriched.kind === "draft_save" && enriched.draftId === null;
    const queued = (): MutationResult => {
      this.queue.push(pending);
      return { id, key, status: "queued", seq: null };
    };

    for (;;) {
      // The create that must not be orphaned waits the hold out BEFORE joining the chain, never
      // while holding it: a caller that sat on the gate for the length of a hung request would
      // stall every other road behind it, which is the stranding the deadline exists to end
      // wearing a different hat.
      if (this.outboxHold) {
        if (!awaitsHold) return queued();
        await this.outboxHold;
        continue;
      }

      // Deadline-bounded like every other road. A timeout leaves the attempt owning its entry
      // and arms the hold; the verb is answered `queued` rather than left on a hung request.
      const out = await this.outboxGate(() => this.dispatchOnLane(pending));
      if (out.held) {
        if (!awaitsHold) return queued();
        continue; // the create re-reads the hold at the top and waits it out off the chain
      }
      if (out.timedOut) {
        /**
         * ONE OWNER, NOT TWO. The request is still running and owns this entry: it will settle it,
         * re-queue it, or leave it persisted for the next boot, and its late answer now reaches
         * `flushPending`. Putting the verb back on the queue as well gave it a second owner, and a
         * later flush dispatched it AGAIN — for a draft create, whose route ignores the key, that
         * is a second draft on the server for one the client already asked for.
         */
        return { id, key, status: "queued", seq: null };
      }
      if (out.result === null) return queued();
      // OFF THE CHAIN NOW, so concurrent verbs coalesce onto one drive exactly as they did before
      // this road was gated: `syncFresh` joins an in-flight drain rather than starting a second.
      await this.settleReconcile(out.owed);
      return out.result;
    }
  }

  /**
   * ONE OUTBOX DISPATCH AT A TIME, WHATEVER ROAD IT CAME IN BY: `replayOutbox` had a single-flight of its own;
   * `flushPending` had none, and the per-record retry added a third road. Two surfaces could therefore start
   * concurrent flushes — press Try again on A, press it on B while A's request is still open — and for the read-flag
   * verbs, whose supersession key is `null`, ordering is the whole contract: a newer unread landing before an older
   * read leaves the server at the older value. A promise chain rather than a boolean, so callers QUEUE instead of
   * being refused: a person who pressed twice gets both attempts, in the order they pressed. `then(fn, fn)` because a
   * rejected predecessor must not cancel the successor — `dispatch` never throws, but this gate has no business
   * assuming that about a future caller.
   */
  private outboxChain: Promise<unknown> = Promise.resolve();

  private outboxGate<T>(fn: () => Promise<T>): Promise<T> {
    /**
     * THE GATE SERIALIZES; IT DOES NOT WAIT OUT A HOLD: A caller joins the chain when it calls, and is released when
     * everything ahead has settled. A hold can be armed in between — by the very dispatch this caller is queued
     * behind, which timed out with its request still in the air. So every body re-reads {@link outboxHold} at its
     * start, which is release time, and that is the "consult before release" the roads need. The gate deliberately
     * does NOT `await` the hold on the caller's behalf. It stands for as long as a hung request does, which can be
     * minutes, and the whole point of the deadline is that nobody is suspended past it: a fresh verb answers
     * `queued`, a flush answers `queued` per entry, a drive skips its replay and goes on to drain.
     */

    /**
     * Waiting here would put every one of them back on the unbounded promise the deadline exists to escape —
     * measured, once: a fresh verb behind a hung replay hung with it.
     */
    const release = async (): Promise<T> => {
      this.inOutboxGate = true;
      try {
        return await fn();
      } finally {
        this.inOutboxGate = false;
      }
    };
    const run = this.outboxChain.then(release, release);
    this.outboxChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * True while a gated body is running. NOT a re-entrancy token, and it must not be used as one: it stays true while
   * the holder is suspended at an await, so a genuinely concurrent caller arriving in that window would read it as "I
   * am nested" and run beside the holder — which is the single-flight defeated, silently, in exactly the concurrent
   * case it exists for. It was written that way for one run and three of this file's own serialization guards caught
   * it. Its one job is to let {@link replayOutbox} recognise that a drive was reached from INSIDE a dispatch, where
   * the replay must be skipped rather than queued behind its own holder.
   */
  private inOutboxGate = false;

  /**
   * ONE DISPATCH, DEADLINE-BOUNDED, WITH THE SAME BARRIER SEMANTICS THE BOOT REPLAY USES. Extracted from
   * `replayOutbox`'s loop so the per-record retry cannot be the one road without a deadline. Without it, a half-open
   * request leaves `retryAbandoned()` — and the surface promise a person is watching a spinner on — pending for ever.
   * On timeout the in-flight attempt still OWNS its entry (it settles, re-queues, or leaves it persisted for the next
   * boot), and becomes the order barrier {@link outboxHold} names, so no other outbox dispatch may start behind it.
   */
  /**
   * The one dispatch every road takes. Round four found the gate global but two riders not: `retryAbandoned` and
   * `flushPendingInner` had neither the release-time hold check nor `deferReconcile`, because both were added to
   * `mutate` by hand — this method makes that shape impossible, and a source census asserts nothing calls {@link
   * dispatchWithDeadline} except this. It owns two rules: the RELEASE-TIME hold check — a hold can be armed by the
   * very dispatch a caller queued behind, so checking on entry would release into the race the barrier prevents
   * (`held` says so; each road answers its own way); and `deferReconcile`, ALWAYS — the reconcile drain must not run
   * while the lane is held, else the deadline times the DRAIN and a completed POST reports `queued`; the caller gets
   * `owed` back.
   */

  /**
   * Deliberately NOT the gate: the unit of work owns that — batches hold it whole (a fresh verb landing between two
   * replayed ones puts a newer write ahead of older ones), singles take it themselves; taking it here would have each
   * batch queue behind itself, a deadlock a nested-flag cannot fix.
   */
  private async dispatchOnLane(
    p: PendingMutation,
  ): Promise<{
    result: MutationResult | null;
    timedOut: boolean;
    held: boolean;
    owed: "await" | "background" | null;
  }> {
    if (this.outboxHold) return { result: null, timedOut: false, held: true, owed: null };
    let owed: "await" | "background" | null = null;
    const { result, timedOut } = await this.dispatchWithDeadline(p, {
      deferReconcile: true,
      onReconcileDeferred: (mode) => { owed = mode; },
    });
    return { result, timedOut, held: false, owed };
  }

  /** Issue the drain a dispatch deferred. OFF THE LANE — see {@link dispatchOnLane}. */
  private settleReconcile(owed: "await" | "background" | null): Promise<void> {
    if (owed === "await") {
      return this.syncFresh().catch(() => { /* the overlay stands until a drain proves the echo */ });
    }
    if (owed === "background") {
      void this.syncFresh().catch(() => { /* the write landed; the next poll catches up */ });
    }
    return Promise.resolve();
  }

  private async dispatchWithDeadline(
    p: PendingMutation,
    opts: { deferReconcile?: boolean; onReconcileDeferred?: (mode: "await" | "background") => void } = {},
  ): Promise<{ result: MutationResult | null; timedOut: boolean }> {
    // NO SEPARATE "ACTIVE" DEFERRED. Every caller of this method reaches it through
    // {@link outboxGate}, and the chain does not release the next one until this returns — so
    // being on the chain IS the in-flight barrier, and it is bounded by the deadline below.
    /**
     * IN FLIGHT FOR THE LIFE OF THE REQUEST, NOT OF THIS CALL.
     *
     * This method RETURNS at the deadline while the request keeps running — that is the whole
     * point of the deadline. Tracking the verb around the call therefore un-tracked it at exactly
     * the moment it most needs to be visible: still on the wire, in no collection, and about to
     * come back and re-queue itself. The entry is removed when the ATTEMPT settles.
     */
    const attempt = this.dispatch(p, opts);
    this.inFlight.set(p.id, p);
    void attempt.then(() => this.inFlight.delete(p.id), () => this.inFlight.delete(p.id));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const raced = await Promise.race([
      attempt.then((r) => ({ r })),
      new Promise<{ r: null }>((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve({ r: null }); }, this.replayDeadlineMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);

    if (timedOut) {
      /**
       * THE LATE ANSWER IS KEPT, NOT THROWN AWAY: The attempt goes on and becomes the barrier; its eventual result
       * used to be discarded entirely, because the caller had already been told `queued`. That is fine for a verb the
       * drive owns and wrong for the two families a SURFACE is waiting on:
       * · a send. Its settlement reaches the composer only through a result `flushPending` returns. The verb is not
       *   on the queue — the in-flight attempt owns it — so no later flush produces one, and the composer stays
       *   locked after the message has gone.
       * · a first `draft_save`. The server's `entityId` exists in exactly one place, that result. Lose it and the
       *   next edit creates a SECOND draft, because nothing adopted the first one's id.
       */

      /**
       * So a late settle is recorded and handed to the next `flushPending`, which is the road every owner-settled
       * result already travels. Nothing is re-dispatched: this is the answer to a request that did go out, arriving
       * after the deadline said it might not.
       */
      const hold: Promise<void> = attempt.then(
        (late) => { this.lateResults.set(p.id, late); this.notify(); },
        () => undefined,
      ).finally(() => {
        if (this.outboxHold === hold) this.outboxHold = null;
        void this.syncFresh().catch(() => { /* the scheduler's cadence retries */ });
      });
      this.outboxHold = hold;
      return { result: null, timedOut: true };
    }
    return { result: raced.r, timedOut: false };
  }

  /**
   * Persist one outbox entry. ANSWERS WHETHER IT LANDED — see the call in {@link OhmailEngine.mutate}.
   *
   * It used to answer `void` and swallow every failure, with the reasoning that "a verb that
   * cannot be persisted must still be SENT". That is right for almost every verb and wrong for
   * exactly one, so the caller now gets to decide instead of this method deciding for all of them.
   */
  private async putOutbox(p: PendingMutation, alsoPut: readonly PendingMutation[] = []): Promise<boolean> {
    const entry = outboxEntryOf(p);
    try {
      await this.store.commitLocal(
        [
          { type: OUTBOX_TYPE, id: p.id, entity: entry },
          ...alsoPut.map((q) => ({ type: OUTBOX_TYPE, id: q.id, entity: outboxEntryOf(q) })),
        ],
        (p.retire ?? []).map((id) => ({ type: OUTBOX_TYPE, id })),
      );
      // Only now: a commit that did not happen has retired nothing, and the next write of this
      // verb must carry them again.
      delete p.retire;
      return true;
    } catch {
      return false; // storage refused — what that costs depends on the verb; see `mutate`.
    }
  }

  /**
   * Hard-delete one outbox entry on its terminal outcome (best-effort). It stayed on `prune` when the rest of the
   * outbox moved to `commitLocal`: three callers are synchronous `void` functions that read the store immediately
   * after, which works only because `prune` evicts from `records` BEFORE its first await — moving it to `commitLocal`
   * pushed the eviction two microtasks later and the row was still readable after the sweep that retired it (seven
   * kill-restart failures in `durable-outbox.test.ts`). Supersession's delete is NOT here any more: it is one half of
   * a replacement, and gone-from-memory/still-on-disk is exactly the wrong failure there — it rides the newer verb's
   * own transaction. A LONE delete has nothing to be atomic with and memory-first fails safe: a row that outlives its
   * delete replays under its original key.
   */

  /**
   * `prune` is also the only primitive that evicts `unflushed` (`store.ts`), which a bare `transact` would leave to
   * the next carry-forward.
   */
  private async dropOutbox(id: string): Promise<void> {
    try {
      // THROUGH THE STORE'S OWN WRITE LANE, like every other durable outbox write. `prune` is
      // memory-first by design and that is still right here, but its PERSISTED half raced the
      // re-bootstrap exactly as `commitLocal` used to: the reset snapshots the rows to keep, the
      // purge lands, and the wipe re-writes a row the purge had just removed — a verb that
      // reached its terminal outcome coming back to life on the next boot. `prune` now runs on
      // the lane, so it and the reset take turns.
      await this.store.pruneSerialized([{ type: OUTBOX_TYPE, id }]);
    } catch { /* an undeleted entry replays idempotently — the safe direction */ }
  }

  /**
   * DID THE SERVER LOOK AT THIS VERB AND FAIL IN A WAY NOBODY MODELLED? Only a `true` here spends the give-up
   * ceiling, so this test decides whether a verb can ever be abandoned. It is written to say NO whenever it is
   * unsure, because the two mistakes are not symmetric: a false negative costs one more retry, and a false positive
   * throws away a user's work that would have landed. Three families answer no.
   * · **`network` / `timeout`.** The adapter raises these when the request never got an answer — `code: "network"`
   *   from a rejected fetch, `code: "timeout"` from `withDeadline`. An offline laptop must retry for ever; the verb
   *   is fine and the wire is not.
   */

  /**
   * · **A refusal carrying `Retry-After`.** The server declined work it knows it cannot do yet (`503 db_busy` from
   *   a starved pool) and said when to come back. Counting that would abandon every legitimate verb in flight during
   *   a pool outage — a far bigger loss than the loop this ceiling closes.
   * · **No status at all.** Nothing reached an HTTP response, so nothing attributes the failure to the server.
   */
  private static serverAnswered(err: MutationRejectedError): boolean {
    if (err.code === "network" || err.code === "timeout") return false;
    if (err.retryAfterMs !== null) return false;
    if (MODELLED_WAIT_CODES.has(err.code ?? "")) return false;
    // A BARE 429 — an edge or proxy rate limit with no JSON body and no `Retry-After`, so it
    // arrives with no code at all. Rate limiting is a wait by definition; counting it means a
    // throttle abandons work rather than delaying it, and the caller has no way to say otherwise.
    if (err.status === 429) return false;
    return typeof err.status === "number";
  }

  /**
   * GIVE UP ON ONE VERB, VISIBLY. The visible half reuses the explicit-refusal arm exactly — overlay dropped, echo
   * forgotten, `overlayRev++`, `notify()` — because from the user's side this IS a refusal: the row reverts and what
   * they asked for did not happen. Presenting it as anything softer would leave a change on screen that no longer
   * exists anywhere. What differs is where the record goes. An explicit refusal calls `dropOutbox` and the verb is
   * gone; this MOVES it to {@link OUTBOX_ABANDONED_TYPE}, so the work survives, a person can read what the server
   * said, and "Try again" is possible. Dropping it would make the ceiling a silent data-loss feature, which is worse
   * than the unbounded loop it replaces.
   */

  /**
   * The write happens BEFORE the delete, and the order is load-bearing: a crash between the two leaves the verb in
   * both collections, which replays a verb the user can also see and retry — recoverable, and idempotent under its
   * unchanged key. The other order loses it outright.
   */
  private async abandon(
    p: PendingMutation, attempts: number, err: MutationRejectedError,
  ): Promise<MutationResult> {
    /**
     * Giving up on a send is not proof it did not leave: eight answers this client could not model are eight
     * unknowns, and reporting a `mail_send` as a generic `rolled_back` says the opposite — the composer treats it as
     * failure and the next press mints a FRESH key, a second delivery of mail the reservation may already have sent.
     * So a send is recoded to `send_unverified`, the gated send's own terminal ambiguity, which the compose surface
     * already renders ("check your Sent folder before retrying"). The recode applies to BOTH the returned result and
     * the persisted `lastError` — the two are read by different people at different times, and either saying "failed"
     * is enough to buy a duplicate. Try again then means "ask the server what happened under this key": the same-key
     * replay is verify-before-resend, never a second message.
     */
    const isSend = p.mutation.kind === "mail_send";
    const reported = isSend
      ? new MutationRejectedError(
        "We could not confirm this send. Check your Sent folder before retrying.",
        {
          status: err.status,
          code: "send_unverified",
          retryable: false,
          retryAfterMs: err.retryAfterMs,
        },
      )
      : err;

    const record: PersistedOutboxEntry = {
      v: 3, id: p.id, key: p.key, n: p.n, at: p.at, mutation: p.mutation,
      attempts,
      lastError: { message: reported.message, code: reported.code, status: reported.status },
    };
    /**
     * TWO WRITES, TWO FAILURE MODES, AND NEITHER MAY BE SWALLOWED: This used to be one `try` around both calls with
     * an empty `catch`, and the comment claimed the verb "stays queued". It did not: `dispatch` has already removed
     * `p` from the queue by the time it calls here, so a failed write left the verb in NEITHER collection and nowhere
     * in memory — gone, silently, which is precisely the loss the abandoned collection exists to prevent. WRITE FAILS
     * ⇒ stay queued, for real. Put `p` back on the queue and re-persist it. The verb keeps its (exhausted) attempt
     * count, so it will try to abandon again on the next drive and succeed once storage recovers; until then it is a
     * live verb, which is recoverable, rather than a lost one, which is not.
     */

    /**
     * DELETE FAILS ⇒ both rows persist, and that is the tolerable half: the boot resolver (`restoreOutbox`) deletes
     * an abandoned twin of anything still queued, so the pair converges on the LIVE row — a verb that runs again
     * rather than one that vanished. The order here is chosen for exactly that: write first, delete second, so a
     * crash between them lands in the recoverable state.
     */
    /**
     * ONE TRANSACTION, BOTH KEYS: When this resolves, disk, memory, `this.queue`, `overlays`, `awaitingEcho` and
     * `abandoned()` all agree that `p` is abandoned. When it rejects, NONE of them has changed and `p` is back on the
     * queue with its attempts intact — so no interleaving of abort, process death or a concurrent flush can leave a
     * verb in both collections, in neither, or in one on disk and the other in memory. This was two best-effort
     * writes with an ordering argument between them ("write first, so a crash lands on the recoverable side"). The
     * argument was sound and the premise was not: `putLocal` publishes to memory BEFORE its flush can reject, so a
     * refused write left the row live in memory and in the unflushed set, where the next flush persisted it — twins
     * on disk, and a strip offering Retry on a verb still executing.
     */

    /**
     * `commitLocal` removes the window rather than reasoning about which side of it is safer.
     */
    try {
      await this.store.commitLocal(
        [{ type: OUTBOX_ABANDONED_TYPE, id: p.id, entity: record }],
        [{ type: OUTBOX_TYPE, id: p.id }],
      );
    } catch {
      // Nothing moved. The verb goes back on the queue where it was, with its attempts, and waits
      // out a full cap before trying again — a store that just refused will not accept the next
      // write a millisecond later either.
      p.nextAt = this.now().getTime() + OUTBOX_BACKOFF_CAP_MS;
      this.queue.push(p);
      return { id: p.id, key: p.key, status: "queued", seq: null, error: reported };
    }

    this.overlays.delete(p.id);
    this.awaitingEcho.delete(p.id);
    this.overlayRev++;
    this.notify();
    return { id: p.id, key: p.key, status: "rolled_back", seq: null, error: reported };
  }

  /**
   * THE VERBS THIS CLIENT GAVE UP ON — newest first, for the status strip and its sheet.
   *
   * Read straight from the mirror rather than from memory, so it is correct on the first render
   * after a boot, when nothing has been dispatched yet and the only evidence is on disk.
   */
  abandoned(): AbandonedMutation[] {
    /**
     * KEYED ON THE STORE'S VERSION, NOT INVALIDATED BY HAND: Value-cached because `useSyncExternalStore` compares
     * snapshots by identity: a method that allocates a fresh array per call re-renders for ever. But the invalidation
     * used to be eleven `abandonedCache = null` lines placed by hand, and one of them was a boot-path line that moved
     * THREE times — each move answered by a review finding an earlier return in front of it. That is not a bug that
     * gets fixed by a fourth move; it is a rule that cannot be maintained by placement. Every store write bumps `ver`
     * — `putLocal`, `commitLocal`, `prune`, `applyResponse`, `resetForBootstrap`, `adoptWipedBaseline`, `load()` — so
     * keying on it means a boot latch, a 410, a cross-tab adoption or a rejected commit can never leave this stale,
     * and there is no line left to position wrongly. The same pattern `bucketsOf` and `search()` already use.
     */

    /**
     * The previous array's identity is kept when the rebuilt list is field-equal, so an ordinary /sync page — which
     * bumps `ver` without touching this collection — does not re-render the strip.
     */
    // The store's version AND the session-local refusals: a refusal the store would not accept
    // changes no row and no version, so keying on `ver` alone would serve the pre-refusal row for
    // ever. See {@link refusedLocally}.
    const v = this.store.version() * 1_000_003 + this.localRefusalRev;
    if (this.abandonedCache !== null && this.abandonedCache.v === v) return this.abandonedCache.out;
    const out: AbandonedMutation[] = [];
    // The store's rows, plus any terminal outcome this session could not write — see
    // {@link abandonedLocally}. A row that later reached disk wins over the memory copy.
    const stored = this.store.entries<unknown>(OUTBOX_ABANDONED_TYPE);
    const storedIds = new Set(stored.map((r) => r.id));
    const rowsToRead = [
      ...stored,
      ...[...this.abandonedLocally.entries()]
        .filter(([id]) => !storedIds.has(id))
        .map(([id, entity]) => ({ id, entity: entity as unknown })),
    ];
    for (const row of rowsToRead) {
      const e = row.entity;
      if (!isPersistedOutboxEntry(e)) continue;
      out.push({
        id: e.id, key: e.key, mutation: e.mutation, at: e.at,
        attempts: e.attempts ?? OUTBOX_MAX_SERVER_FAILURES,
        error: e.lastError ?? { message: "the server did not accept this change", code: null, status: null },
        superseded: e.superseded === true,
        retryable: e.superseded !== true
          && e.retryRefused === undefined
          && !this.refusedLocally.has(row.id),
        refusedCode: e.retryRefused
          ?? this.refusedLocally.get(row.id)
          ?? (e.superseded === true ? "outbox_superseded" : null),
      });
    }
    const next = out.sort((a, b) => b.at - a.at);
    const prev = this.abandonedCache?.out;
    const same = prev !== undefined
      && prev.length === next.length
      && prev.every((p, i) => {
        const n = next[i]!;
        return p.id === n.id && p.superseded === n.superseded && p.retryable === n.retryable
          && p.attempts === n.attempts && p.error.code === n.error.code
          && p.error.message === n.error.message;
      });
    this.abandonedCache = { v, out: same ? prev : next };
    return this.abandonedCache.out;
  }

  /**
   * Put one given-up verb back — under its ORIGINAL Idempotency-Key, through the one dispatch road. It RETURNS the
   * result: it answered a boolean once, and a retried send answering `send_unverified` showed nothing — no warning,
   * no record, a person free to press send again on mail that may already have left; the sheet row is the only thing
   * waiting, so the row is where the answer lands. One record, and only this record: queue-wide `flushPending()`
   * ignored every client backoff, so retrying A dispatched unrelated Q early and could spend Q's last attempt — a
   * foreground press compressing another verb's hour of patience into seconds; now it dispatches exactly `p` under
   * the same `outboxGate`.
   */

  /**
   * Order of operations, each step chosen for its failure: refuse first (record flagged un-retryable so the button
   * stops lying); rebuild the overlay (intent visible while the request is open); `putOutbox`, which THROWS here (the
   * abandoned row is about to be deleted, and losing both has no recovery); only then prune, then dispatch.
   */
  async retryAbandoned(id: string): Promise<MutationResult> {
    const refuse = async (
      e: PersistedOutboxEntry | null, code: string, message: string,
    ): Promise<MutationResult> => {
      if (e) {
        // Flagged on disk: a refusal that leaves the control offering itself is a button whose
        // every press is a silent no-op, which is worse than no button.
        try {
          await this.store.commitLocal(
            [{ type: OUTBOX_ABANDONED_TYPE, id: e.id, entity: { ...e, retryRefused: code } }], []);
          this.notify();
        } catch {
          /**
           * THE DURABLE MARKER WAS REFUSED, SO HOLD IT IN MEMORY INSTEAD.
           *
           * This catch used to say "the in-memory refusal below still stands for this session"
           * and there was no such thing: `abandoned()` derives from the store's version, a
           * refused commit changes neither the record nor the version, and the next read returned
           * the same cached row with `retryable: true`. The control the refusal exists to disable
           * stayed enabled, and every press was another silent no-op — the exact thing the line
           * above calls worse than no button. A comment is a claim, and this one was false.
           */
          this.refusedLocally.set(e.id, code);
          this.localRefusalRev++;
          this.notify();
        }
      }
      return {
        id, key: e?.key ?? id, status: "rolled_back", seq: null,
        error: new MutationRejectedError(message, { code, retryable: false }),
      };
    };

    // Disk OR the session-local fallback — see `abandonedRecordOf`. Reading disk alone meant a
    // record whose terminal transition could not be written was listed with a Retry that answered
    // "this build cannot retry that", because the row it looked for was only ever in memory.
    const e = this.abandonedRecordOf(id);
    if (e === null) {
      return refuse(null, "outbox_unknown_kind", "This change cannot be retried by this version.");
    }
    if (e.superseded === true) {
      return refuse(e, "outbox_superseded", "A newer change to the same thing has since been saved.");
    }
    if (pastCreateDedupe(e, this.now().getTime())) {
      return refuse(e, "outbox_expired", "This change is too old to send safely — it would be created twice.");
    }

    const p: PendingMutation = {
      id: e.id, key: e.key, mutation: e.mutation, at: e.at, n: e.n,
      restored: true, attempts: 0,
    };

    /**
     * The overlay, rebuilt AT THE INSTANT THE VERB WAS EXPRESSED — not now — so a re-applied triage or read state
     * carries its original stamp rather than pretending to be fresh. WRAPPED, BECAUSE A KIND THIS BUILD DOES NOT KNOW
     * REACHES HERE. The persisted-shape gate accepts any string as a kind — deliberately, so a row written by a NEWER
     * build survives rather than being discarded — and `mutationEffects` has no runtime default, so it answers
     * `undefined` and the next line reads `.length` off it. The row is then unretryable by crashing rather than by
     * saying so, which is the one outcome the coded refusal exists to prevent. The version guard nearby only covers
     * unknown VERSIONS; this is a known version carrying an unknown verb, and nothing was checking it.
     */
    let built: MutationEffect[] | undefined;
    try {
      // The cast is the point: the signature promises an array because the switch is exhaustive
      // over the KNOWN union, and a persisted row's kind is a plain string that need not be in it.
      built = mutationEffects(this.read(), e.mutation, {
        now: () => new Date(e.at), uuid: this.uuid,
      }) as MutationEffect[] | undefined;
    } catch {
      return refuse(e, "outbox_unknown_kind", "This change cannot be retried by this version.");
    }
    // BEFORE any default. Writing `?? []` here — which the first cut did — masks the exact
    // condition being detected: the verb then produces no overlay, no refusal and no crash, and
    // goes to the wire as though it were an ordinary no-effect mutation.
    if (built === undefined) {
      return refuse(e, "outbox_unknown_kind", "This change cannot be retried by this version.");
    }
    const effects = built;
    if (effects.length > 0) this.overlays.set(p.id, effects);
    this.overlayRev++;
    this.notify();

    /**
     * ONE TRANSACTION, the other way round: the live row appears and the abandoned row goes, or
     * neither happens. A rejection leaves the record exactly where the person can still see it —
     * which is what makes `storage_refused` an honest answer rather than a hopeful one.
     *
     * The previous shape wrote the live row, then pruned the abandoned one, and reported refusal
     * if the write threw. But the write had already installed the row in memory and in the
     * unflushed set, so a later unrelated flush persisted a verb the person had been told could
     * not be saved — and a reboot replayed it.
     */
    try {
      await this.store.commitLocal(
        [{
          type: OUTBOX_TYPE,
          id: p.id,
          entity: {
            v: OUTBOX_ENTRY_VERSION, id: p.id, key: p.key, n: p.n, at: p.at, mutation: p.mutation,
            attempts: 0,
          } satisfies PersistedOutboxEntry,
        }],
        [{ type: OUTBOX_ABANDONED_TYPE, id: p.id }],
      );
    } catch {
      this.overlays.delete(p.id);
      this.overlayRev++;
      this.notify();
      return {
        id, key: e.key, status: "rolled_back", seq: null,
        error: new MutationRejectedError(
          "This change could not be saved on this device. Try again once there is room.",
          { code: "storage_refused", retryable: false },
        ),
      };
    }

    const out = await this.outboxGate(() => this.dispatchOnLane(p));
    if (out.held) {
      /**
       * A hold was armed while this press waited its turn. Dispatching behind a request still on the wire is the
       * reordering the barrier exists to stop, so the press answers instead of joining the race. AND THE VERB GOES ON
       * THE QUEUE, which the first cut of this branch forgot. By this point the record has already moved to the live
       * collection on disk — that happens before the dispatch — so returning `queued` without queueing it left the
       * verb in no collection this session held: not on the wire, not in `this.queue`, not in `abandoned()`. It would
       * have come back on the next boot from its durable row, which is exactly the kind of "not really lost" that
       * means a person watches their action do nothing until they restart the app.
       */
      this.queue.push(p);
      return { id: p.id, key: p.key, status: "queued", seq: null };
    }
    if (out.timedOut || out.result === null) {
      // The in-flight attempt owns the entry from here; `outboxHold` is the barrier.
      return { id: p.id, key: p.key, status: "queued", seq: null };
    }
    await this.settleReconcile(out.owed);
    return out.result;
  }

  /** Throw an abandoned verb away for good. The overlay is long gone; this only clears the record. */
  async discardAbandoned(id: string): Promise<void> {
    try {
      await this.store.commitLocal([], [{ type: OUTBOX_ABANDONED_TYPE, id }]);
    } catch { /* best-effort, exactly like every other outbox write */ }
    /**
     * AND THE SESSION-LOCAL COPY, or Discard is a control that visibly does nothing.
     *
     * A record whose terminal transition could not be written lives only in `abandonedLocally`.
     * Deleting from the durable collection alone left it listed exactly as before — the person
     * presses Discard, the row stays, and there is no reason on screen why. The live row on disk
     * is a separate matter and is deliberately left: it is what a reboot replays, and discarding
     * a record this session could not even record is not a statement about that.
     */
    if (this.abandonedLocally.delete(id)) this.localRefusalRev++;
    this.notify();
  }

  /**
   * A newer verb retires the queued older verb it supersedes — user-always-wins applied to the outbox itself: a
   * queued `mark_seen(read)` replayed after the user's newer `mark_seen(unread)` committed would put the SERVER back
   * at the older value, so retiring it IS honoring their latest word — for the drive's replay and `flushPending`
   * alike.
   */

  /**
   * What "supersedes" may mean, deliberately narrow: SAME KIND, SAME SCALAR TARGET ({@link supersedeKey}) —
   * absolute-valued verbs where the newer value is the whole intent (`tag_assign` keys on the MESSAGE alone: its
   * enriched `labels` already carries the union); READ-FLAG ID SUBTRACTION — a newer `mark_seen` subtracts its ids
   * from queued `mark_seen` AND `feed_mark_seen`, a newer `feed_mark_seen` only from `feed_mark_seen` (a glance must
   * never cancel a queued deliberate unread) — rewriting a narrowed body under the SAME key is safe on exactly these
   * routes (`PATCH /messages` stores no idempotency row); and NOTHING ELSE — cross-kind conflicts converge through
   * the server's write ownership, `mail_send` is never touched, creates supersede nothing.
   */
  /**
   * A NEWER VERB ALSO RETIRES AN ABANDONED RECORD FOR THE SAME TARGET — marked, never deleted. `supersedeQueued`
   * protects the QUEUE from a stale replay. The abandoned list needed the same protection and did not have it: draft
   * body B is abandoned, body C saves successfully, and pressing Try again on B re-queues it under its original key
   * and overwrites C. The user asked to retry something they could not see was stale, and lost the newer text. MARKED
   * rather than deleted, and that is the whole judgement here. Deleting would silently throw away work a person can
   * still see listed — the failure this collection exists to prevent. So the record stays, `retryAbandoned` refuses
   * it, and the surface says a newer change to the same thing has since been saved, leaving Discard as the honest
   * remaining answer.
   */

  /**
   * Same key rule as the queue's (`supersedeKey`), so the two cannot come to disagree about what "the same target"
   * means. `null` keys — creates, sends, the read-flag list verbs — never participate, exactly as they do not in the
   * queue.
   */
  private async supersedeAbandoned(m: EngineMutation): Promise<MarkerOutcome> {
    const key = targetOf(m);
    const readIds = m.kind === "mark_seen" || m.kind === "feed_mark_seen"
      ? new Set(m.messageIds ?? [])
      : null;
    /** Records this call actually changed on disk, so a refused replacement can put them back. */
    const marked: Array<{ id: string; before: PersistedOutboxEntry }> = [];
    if (key === null && readIds === null) return { marked, failed: 0 };

    let changed = false;
    const writes: Array<Promise<unknown>> = [];
    for (const row of this.store.entries<unknown>(OUTBOX_ABANDONED_TYPE)) {
      const e = row.entity;
      if (!isPersistedOutboxEntry(e) || e.superseded === true) continue;

      let next: PersistedOutboxEntry | null = null;
      if (readIds !== null) {
        /**
         * A newer read-flag verb SUBTRACTS ids, exactly as the queue's version does — it does not
         * merely retire on total coverage. A record covering Giulia and Petra, met by a newer
         * verb naming Giulia alone, used to be left completely untouched: pressing Try again then
         * re-applied the newer verb's own id along with the one it still owed, undoing what the
         * person had just done. Narrowing keeps the part nothing else will deliver and drops the
         * part that is now stale.
         */
        const om = e.mutation;
        const older = om.kind === "mark_seen" || om.kind === "feed_mark_seen"
          ? (om.messageIds ?? [])
          : null;
        if (older === null || older.length === 0) continue;
        /**
         * THE EXPLICIT/GLANCE RULE, WHICH THIS BRANCH USED TO SKIP ENTIRELY. The queue's own supersession has always
         * applied it: an EXPLICIT read verb outranks both queued read verbs, while a glance — an involuntary read,
         * the dwell commit or a feed departure — outranks only other involuntary reads. It must never cancel a
         * deliberate unread, because a person marking something unread has said something a passing glance did not.
         * Abandoned rows were subtracted by ANY newer read verb regardless. So a deliberate `mark_seen(unread: true)`
         * that had been given up on could be narrowed to nothing — and marked superseded, taking its Retry with it —
         * by a later glance over the same message. The record vanished, and the state the person actually asked for
         * was never delivered.
         */

        /**
         * A glance can only ever READ, so the VALUE takes part in the classification and not the label alone: a
         * mislabelled mark-unread still outranks a queued stale read.
         */
        const newerExplicit = m.kind === "mark_seen" && (m.via !== "glance" || m.unread === true);
        const olderInvoluntary = om.kind === "feed_mark_seen"
          || (om.kind === "mark_seen" && om.via === "glance" && om.unread === false);
        if (!newerExplicit && !olderInvoluntary) continue;
        const remaining = older.filter((id) => !readIds.has(id));
        if (remaining.length === older.length) continue; // no overlap at all
        next = remaining.length === 0
          ? { ...e, superseded: true }
          : { ...e, mutation: { ...e.mutation, messageIds: remaining } as EngineMutation };
      } else if (retiresAbandoned(m, e.mutation)) {
        next = { ...e, superseded: true };
      }
      if (next === null) continue;

      changed = true;
      const before = e;
      writes.push(this.store.commitLocal(
        [{ type: OUTBOX_ABANDONED_TYPE, id: e.id, entity: next }], [])
        .then(() => { marked.push({ id: e.id, before }); }));
    }
    /**
     * AWAITED, and a FAILURE IS A FAILURE. Every rejection used to be swallowed into success. `mutate` then awaited a
     * promise that could not reject, and went on to persist and dispatch — while the record it believed it had marked
     * was still retryable, and could later overwrite the very state the newer verb was establishing. Rethrowing turns
     * that into the no-write-no-wire case, which is what it always was: a change this device could not fully record
     * does not go out. `allSettled`, not `all`: with several markers, some can land while others do not, and the ones
     * that landed have to be known so they can be rolled back.
     */
    const results = await Promise.allSettled(writes);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (changed) {
      this.notify();
    }
    return { marked, failed };
  }

  /**
   * PUT BACK THE ABANDONED RECORDS A REFUSED REPLACEMENT HAD MARKED STALE.
   *
   * `undoSupersede` restored the queue and the overlays and never touched these, so a replacement
   * refused under no-write-no-wire left records marked superseded on behalf of a verb that never
   * happened — their Retry gone for good, for a reason that turned out not to exist.
   */
  private async undoMarkers(marked: ReadonlyArray<{ id: string; before: PersistedOutboxEntry }>): Promise<void> {
    if (marked.length === 0) return;
    for (const { id, before } of marked) {
      try {
        await this.store.commitLocal([{ type: OUTBOX_ABANDONED_TYPE, id, entity: before }], []);
      } catch { /* the store is refusing everything; the record is rebuilt from disk on the next boot */ }
    }
    this.localRefusalRev++;
    this.notify();
  }

  /**
   * THE STALE ROWS ARE RETIRED BY THE NEWER VERB'S OWN TRANSACTION: This used to call `dropOutbox` per retired entry
   * — a memory-first `prune` whose failure is swallowed. Round four found what that costs: memory drops the older
   * verb, the newer verb goes on the wire, the purge fails, the newer row's own write fails too, the process dies,
   * and disk holds ONLY the stale verb. The next boot replays it over the state the newer one established, and both
   * requests reported success. The carve-out that let `dropOutbox` stay on `prune` was argued for a LONE TERMINAL
   * DELETE, where memory-first fails safe: gone from memory, still on disk, replayed under the same key. Supersession
   * is not that. Its delete is one half of a replacement, and the direction that fails safe for a terminal delete is
   * exactly the wrong one here.
   */

  /**
   * So the ids are returned instead, and the caller retires them in the SAME transaction that writes the newer row —
   * the durable set holds both, or the newer one, and never the stale one alone. If that transaction is refused,
   * nothing was removed and the stale rows simply replay, which is the behaviour a storage-refused verb already has.
   */
  private supersedeQueued(m: EngineMutation): SupersedeEffect {
    const retired: string[] = [];
    const narrowed: PendingMutation[] = [];
    /** Everything this call changed, kept so a refused replacement can put it all back. */
    const undo: Array<{ entry: PendingMutation; index: number; mutation: EngineMutation }> = [];
    /**
     * THE MARKER'S PROMISE IS HANDED BACK, NOT DISCARDED.
     *
     * This was `void this.supersedeAbandoned(m)`. The method awaits its own writes internally —
     * deliberately, so a marker still in flight cannot be raced — and then the caller threw that
     * away, which put the window straight back: between this line and the verb reaching the wire,
     * another tab or a fast second press could retry a record that is already stale. `mutate`
     * awaits it before it dispatches.
     */
    const marked = this.supersedeAbandoned(m);
    const key = supersedeKey(m);
    const readIds = m.kind === "mark_seen" || m.kind === "feed_mark_seen"
      ? new Set(m.messageIds ?? [])
      : null;
    /**
     * A verb on the wire is MARKED, not removed — there is nothing to remove it from: its request is running, and the
     * newer verb cannot un-send it. What the mark does is keep the older verb from rejoining the queue when its
     * request comes back retryable — replaying it would put the older value over the newer one that has since landed.
     * The wire is scanned BEFORE the empty-queue return, and that order is the rule: a verb whose request outran its
     * deadline belongs to NO collection but {@link inFlight}, so the queue is EMPTY exactly while a verb is on the
     * wire — the scan below that return was unreachable in the one case it was written for, and the first
     * move-then-move-back read `queue.length === 0`, marked nothing, and the older destination replayed over the
     * newer intent with both requests reporting success.
     */
    const markedInFlight: PendingMutation[] = [];
    for (const q of this.inFlight.values()) {
      if (q.mutation.kind === m.kind && key !== null && supersedeKey(q.mutation) === key
        && q.supersededInFlight !== true) {
        q.supersededInFlight = true;
        // Only what THIS call marked. An entry an EARLIER supersession marked is superseded by a
        // verb that is still standing (it is in the queue, and a refused replacement puts it
        // back), so clearing it on this refusal would resurrect a verb the queue already replaces.
        markedInFlight.push(q);
      }
    }
    if (this.queue.length === 0) return { retired, narrowed, undo, marked, markedInFlight };
    let changed = false;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i]!;
      const qm = q.mutation;
      // Whole-entry replacement: same kind, same scalar target.
      if (key !== null && supersedeKey(qm) === key) {
        undo.push({ entry: q, index: i, mutation: qm });
        this.queue.splice(i, 1);
        this.overlays.delete(q.id);
        retired.push(q.id);
        changed = true;
        continue;
      }
      // Read-flag subtraction. The allowed pairs, and only these: an EXPLICIT `mark_seen`
      // (no glance label — the read pill, ⇧I, bulk; `via` is the verb's own involuntary
      // marker, so a dwell commit's `mark_seen` counts as a glance here too) outranks BOTH
      // queued read verbs; a glance of either kind outranks only queued involuntary reads —
      // it must never cancel a queued deliberate unread. Entered whenever the newer verb is a
      // read verb at all, id overlap or not, because a newer same-view leave-commit with an
      // EMPTY id list (the ordinary waterline commit) still supersedes the older line.
      if (readIds && (qm.kind === "mark_seen" || qm.kind === "feed_mark_seen")) {
        // A glance can only ever READ — `unread: true` is a deliberate act whatever label a
        // caller stuck on it, so the value participates in the classification, not the label
        // alone: a mislabelled mark-unread must still outrank a queued stale read.
        const newerExplicit = m.kind === "mark_seen" && (m.via !== "glance" || m.unread === true);
        const olderInvoluntary = qm.kind === "feed_mark_seen"
          || (qm.kind === "mark_seen" && qm.via === "glance" && qm.unread === false);
        const pairAllowed = newerExplicit || olderInvoluntary;
        const qids = qm.messageIds ?? [];
        // A newer same-view glance also replaces the older glance's waterline: the newer
        // departure IS the later line.
        const lineSuperseded = m.kind === "feed_mark_seen" && qm.kind === "feed_mark_seen"
          && (m.view ?? "reads") === (qm.view ?? "reads") && m.upToId !== undefined;
        const overlaps = qids.some((mid) => readIds.has(mid));
        if (!pairAllowed || (!overlaps && !lineSuperseded)) continue;
        const remaining = qids.filter((mid) => !readIds.has(mid));
        const keepsLine = qm.kind === "feed_mark_seen" && qm.upToId !== undefined && !lineSuperseded;
        if (remaining.length === 0 && !keepsLine) {
          undo.push({ entry: q, index: i, mutation: qm });
          this.queue.splice(i, 1);
          this.overlays.delete(q.id);
          retired.push(q.id);
        } else {
          undo.push({ entry: q, index: i, mutation: qm });
          const narrowedMutation = { ...qm, messageIds: remaining } as EngineMutation;
          if (lineSuperseded && narrowedMutation.kind === "feed_mark_seen") delete narrowedMutation.upToId;
          q.mutation = narrowedMutation;
          try {
            const effects = mutationEffects(this.read(), q.mutation, {
              now: () => new Date(q.at), uuid: this.uuid,
            });
            if (effects.length > 0) this.overlays.set(q.id, effects);
            else this.overlays.delete(q.id);
          } catch { this.overlays.delete(q.id); }
          // NOT a separate best-effort write any more — see `SupersedeEffect.narrowed`. It rides
          // the replacement's transaction, so disk cannot hold one without the other.
          narrowed.push(q);
        }
        changed = true;
      }
    }
    if (changed) {
      this.overlayRev++;
      this.notify();
    }
    return { retired, narrowed, undo, marked, markedInFlight };
  }

  /**
   * PUT BACK EVERYTHING A SUPERSESSION CHANGED — see the no-write-no-wire rule in the header. A replacement whose
   * durable write was refused never happens: it does not reach the wire, and the verbs it would have retired are
   * still the truth. Disk already agrees, because the refused transaction removed nothing; this is memory catching up
   * with it, so the two do not disagree for the rest of the session. Overlays are rebuilt at the verb's ORIGINAL
   * stamp rather than now, for the reason `retryAbandoned` rebuilds them that way: a restored triage or read state
   * carries the moment it was expressed, not the moment the store happened to fail.
   */
  private undoSupersede(effect: SupersedeEffect): void {
    /**
     * THE WIRE'S MARKS GO BACK TOO, AND BEFORE THE EARLY RETURN BELOW.
     *
     * `undo` is EMPTY whenever the queue was empty, and an empty queue is exactly the state the
     * wire scan above it exists for — so a `return` on `undo.length === 0` would skip the only
     * case where a mark is the sole thing this supersession changed. That road is reachable and
     * built: `abandoned-marker refusal with a verb on the wire` in `outbox-lifecycle.test.ts`.
     */
    for (const q of effect.markedInFlight) q.supersededInFlight = false;
    if (effect.undo.length === 0) return;
    for (const { entry, mutation } of effect.undo) {
      entry.mutation = mutation;
      if (!this.queue.includes(entry)) this.queue.push(entry);
      const effects = mutationEffects(this.read(), mutation, {
        now: () => new Date(entry.at), uuid: this.uuid,
      });
      if (effects.length > 0) this.overlays.set(entry.id, effects);
    }
    this.queue.sort((a, b) => (a.at - b.at) || (a.n - b.n));
    this.overlayRev++;
    this.notify();
  }

  /**
   * `deferReconcile` is the boot replay's mode ({@link OhmailEngine.replayOutbox}): the caller
   * is INSIDE the single-flight drive, so the per-mutation `syncFresh()` would deadlock on the
   * drive's own promise — and is redundant anyway, because the drain that follows the replay in
   * the same drive begins after every replayed POST returned and therefore carries every echo.
   * In this mode a confirmed no-echo mutation registers in {@link awaitingEcho} instead of
   * draining, and that following drain's success is what retires its overlay.
   */
  private async dispatch(
    p: PendingMutation,
    opts: { deferReconcile?: boolean; onReconcileDeferred?: (mode: "await" | "background") => void } = {},
  ): Promise<MutationResult> {
    try {
      const outcome = await this.adapter.mutate(p.mutation, { idempotencyKey: p.key });
      /**
       * The happens-before token for {@link awaitingEcho}: any drain whose page loop begins
       * AFTER this line reads a change log that already holds this mutation's rows (the seq
       * argument in {@link OhmailEngine.syncFresh}). Captured HERE — not where a failure is
       * later handled — because `drainEpoch` may have advanced in between, and an epoch read
       * late would let a drain that began BEFORE the POST returned retire the overlay.
       */
      const epochAtConfirm = this.drainEpoch;
      /** Whether the overlay must OUTLIVE this dispatch — set by the two no-echo-yet arms below. */
      let echoPending = false;
      /**
       * The Sent copy is materialised on the server's word and nothing else's — HERE, the line after that word
       * arrives, not below the reconciliation branch. The invariant is unchanged: a send's optimistic effect cannot
       * be taken back, so its Sent row may only ever be a statement the server has already made — `outcome` IS that
       * statement, acted on immediately. It used to sit after `await this.syncFresh()`, so the
       * show-it-in-under-a-second mechanism was gated behind a full drain that can never carry the message it was
       * delaying (the Sent MESSAGE enters the feed minutes later, when the Sent folder is read back) — the symptom
       * was a sent message appearing in the Ohbox a minute late. `notify` fires on its own overlay bump because the
       * whole point is the row on screen before the branch below is entered.
       */
      if (this.materializeSentOverlay(p.mutation, outcome)) {
        this.overlayRev++;
        this.notify();
      }
      if (outcome.changes.length > 0) {
        // Read-your-writes echo (§3.4): idempotent apply — converges with the
        // delta that will arrive at the same seq.
        try {
          await this.store.applyChanges(outcome.changes);
        } catch {
          // The SERVER took the write; only the LOCAL apply failed (a torn sqlite flush, a
          // refused IndexedDB transaction). Reporting rolled_back here would be a lie about a
          // committed mutation — the exact inversion this file's send path documents — so the
          // overlay stands as awaiting-echo instead, and the next successful drain (over a
          // store whose own recovery is a reload) retires it.
          this.awaitingEcho.set(p.id, epochAtConfirm);
          echoPending = true;
        }
      } else if (p.mutation.kind === "mail_send") {
        /**
         * A send reconciles in the background, and it is the one kind that may. Every other no-echo mutation needs
         * the drain before it can confirm — its overlay drops on confirm, and the settled row that replaces it comes
         * from that drain. A send has no such row: its overlay is a `sending` DRAFT nothing renders, the message the
         * reader waits for is the Sent copy materialised above, and the delta this drain carries is the draft's flip
         * to `sent`, which changes no list either way. Awaiting it buys nothing and costs the whole drain latency on
         * the one gesture where the user is watching — `mutate()` resolves into `useMailSend`, which closes the
         * compose; that navigation may not be hostage to a poll. Still ISSUED (the flip has to land) and its failure
         * swallowed for the awaited branch's own reason: the write succeeded, the next poll catches the mirror up.
         */
        // In the boot replay's deferred mode the drive's own drain follows immediately and
        // carries the flip, so no background drain is issued — one drain, not two.
        // BACKGROUND, never awaited: this branch already materialised the sent copy, and the
        // gesture the person is watching — the compose closing — may not be hostage to a poll.
        if (opts.deferReconcile) opts.onReconcileDeferred?.("background");
        else void this.syncFresh().catch(() => { /* see above — the write landed */ });
      } else {
        /**
         * No echo body — pull the authoritative delta from a drain that STARTED after this POST returned (see {@link
         * OhmailEngine.syncFresh} for why "a drain" is not enough). Every mutation kind can reach this branch: most
         * answer `changes: []` unconditionally, and the rest degrade to it when `X-Sync-Seq` is stripped by a proxy.
         * The drain's failure is NOT the mutation's failure: `adapter.mutate` resolved — the server committed its
         * `change_log` row — and a failed drain used to report `rolled_back` for a write that had succeeded. For
         * `mail_send` that is a delivered email reported as failed, and worse: `useMailSend.absorb` runs `settle` on
         * `confirmed` only, so the draft survived and the next press minted a NEW Idempotency-Key — a second
         * delivery, which the send path exists to make impossible ("press Send, then switch apps" reached it).
         */

        /**
         * So the drain's failure is swallowed — strictly more truthful: the overlay is dropped
         * either way, and `confirmed` is the true statement about a write the server took; what is
         * NOT swallowed is a rejection from `adapter.mutate` itself, which still rolls back or
         * queues below. The residual is closed: this branch used to drop the overlay even on a
         * failed drain, so the row REVERTED on screen until the next poll and users re-did the act
         * (INSTANT-ARCH §4.2 seam 2). A failed drain now registers the overlay in
         * {@link awaitingEcho}: the intent stays on screen, and the overlay retires when the next
         * drain that began after this POST completes — bounded by the scheduler's ordinary cadence.
         */
        if (opts.deferReconcile) {
          this.awaitingEcho.set(p.id, epochAtConfirm);
          echoPending = true;
          opts.onReconcileDeferred?.("await");
        } else {
          try {
            await this.syncFresh();
          } catch {
            // The write landed; the mirror catches up on the next successful drain, and the
            // overlay stands until that drain proves the echo applied.
            this.awaitingEcho.set(p.id, epochAtConfirm);
            echoPending = true;
          }
        }
      }
      /**
       * `view_meta` EFFECTS OUTLIVE THE OVERLAY — written into the mirror before the overlay drops, because nothing
       * else will ever write them: `/sync` has no `view_meta` entity type at all (a Cloud account can never receive
       * such a row — `fixtures-adapter.ts` documents the same fact from the other side). Without this, a waterline
       * committed by `feed_mark_seen` existed only for the milliseconds its own mutation was in flight — on a live
       * account the line evaporated on every confirm, which is why Reads' "seen up to here" never held still outside
       * the demo. `putLocal` (seq 0, outside the seq guard) is the channel local-only rows already use
       * (`message_body`); on the fixtures adapter the same entity also arrived authoritatively via the echo, so this
       * write is value-identical there and idempotent.
       */
      const confirmed = this.overlays.get(p.id);
      if (confirmed) {
        for (const e of confirmed) {
          if (e.type === "view_meta") await this.store.putLocal("view_meta", e.id, e.entity);
        }
      }
      // BOTH the overlay AND the durable entry are retired HERE only when the echo is provably
      // in the mirror (the echo body applied, or the awaited drain succeeded). An `echoPending`
      // verb keeps both: the overlay for the screen, the entry for a kill — confirmed
      // server-side but not yet in the local mirror, a restart would otherwise boot into the
      // stale pre-verb state with nothing to re-apply — the exact flash this slice retires.
      // Both are released together by {@link OhmailEngine.drain}'s sweep, and
      // a kill before that sweep replays the entry under its original key — the server's
      // idempotency machinery answers with the stored response, never a second effect.
      if (!echoPending) {
        this.overlays.delete(p.id);
        await this.dropOutbox(p.id);
      }
      // The Sent copy was materialised the instant the server confirmed, above — a rejection
      // reaches the `catch` below and never gets here, which is the "DROP on send rejection"
      // half, unchanged by moving the call up.
      // Sweep the confirm's own drain-side reconcile (a real Sent row for an EARLIER send may have
      // just landed) and any expired copies, so the map cannot accumulate across a long session.
      this.reconcileOptimisticSent();
      this.overlayRev++;
      this.notify();
      // `entityId` rides the CONFIRMED result here. The queued arm below carries its own, taken
      // from the refusal that produced it, and the two are different claims: this one says "a row
      // was created and it is yours to write to", the queued one says "a row exists and this send
      // is about it". Handing the first back for a mutation that was NOT confirmed would be the
      // worst kind of wrong answer — a compose surface would adopt it and go on PATCHing a draft
      // that may not be there, or send it — which is why the queued arm names rather than adopts.
      // `pendingWith` rides the same way, and for the reason it exists: the server took the
      // decision and did NOT act on it, and this result is the only thing that can say so. It is
      // on the CONFIRMED result because the mutation genuinely succeeded — a queued or
      // rolled-back one has no answer from the organizer to report.
      return {
        id: p.id, key: p.key, status: "confirmed", seq: outcome.seq,
        ...(outcome.entityId ? { entityId: outcome.entityId } : {}),
        ...(outcome.pendingWith ? { pendingWith: outcome.pendingWith } : {}),
      };
    } catch (err) {
      const rejection = err instanceof MutationRejectedError
        ? err
        : new MutationRejectedError(String(err), { retryable: false });
      if (rejection.retryable) {
        /**
         * ── COUNT IT, DELAY IT, OR GIVE UP ON IT ────────────────────────────────────────────
         *
         * Three outcomes, and which one applies turns entirely on WHO failed. See
         * {@link OUTBOX_MAX_SERVER_FAILURES}: a transport failure or a refusal that named its own
         * interval buys the verb another go for free, and only an unmodelled server answer spends
         * the ceiling. `serverAnswered` is the test, and it is deliberately conservative — anything
         * this client cannot positively attribute to the server is treated as transport, because
         * abandoning a verb that would have landed is the worse of the two mistakes.
         */
        const counts = OhmailEngine.serverAnswered(rejection);
        const attempts = (p.attempts ?? 0) + (counts ? 1 : 0);

        if (counts && attempts >= OUTBOX_MAX_SERVER_FAILURES) {
          return await this.abandon(p, attempts, rejection);
        }

        /**
         * A TRANSPORT FAILURE WAITS FOR NOTHING, AND THAT IS NOT AN OPTIMISATION: Only a failure the SERVER answered
         * earns a delay. An offline laptop re-queues with no `nextAt` at all and is retried by the very next drive,
         * exactly as it always was — the drive's own cadence is the only pacing that case ever needed or had.
         * Delaying it instead was a real defect for the length of one commit: it made every verb queued by a network
         * failure sit out a 30 s backoff, which is the behaviour the durable outbox is built on top of, and eighteen
         * kill-restart guards went red at once saying so. The lesson is the same one `serverAnswered` encodes — the
         * queue's patience is spent on evidence about the SERVER, and a wire that dropped tells you nothing about the
         * verb.
         */

        /**
         * `Math.min` on the cap and on the named interval both: a proxy is free to send a `Retry-After` of a week,
         * and a queue that honours it has stopped being a queue.
         */
        const wait = rejection.retryAfterMs !== null
          ? Math.min(rejection.retryAfterMs, OUTBOX_BACKOFF_CAP_MS)
          : counts
            ? Math.min(OUTBOX_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), OUTBOX_BACKOFF_CAP_MS)
            : null;

        // Keep the overlay (the user's intent stands) + queue for a retry with
        // the SAME Idempotency-Key — the server dedupes a half-landed attempt.
        p.attempts = attempts;
        if (wait !== null) {
          p.nextAt = this.now().getTime() + wait;
          p.waitIsServerNamed = rejection.retryAfterMs !== null;
        }
        p.lastError = { message: rejection.message, code: rejection.code, status: rejection.status };
        if (p.supersededInFlight === true) {
          // A newer verb for the same target was expressed while this was on the wire. Re-queuing
          // it would replay the older value over the newer state — see `supersededInFlight`.
          await this.dropOutbox(p.id);
          this.overlays.delete(p.id);
          this.overlayRev++;
          this.notify();
          return { id: p.id, key: p.key, status: "rolled_back", seq: null, error: rejection };
        }
        this.queue.push(p);
        // NAMED, not adopted — see {@link MutationResult.entityId}. The adapter created a row for
        // a press that carried none and the send is on the wire about it; the durable send record
        // binds the row so a reload does not read it as an ordinary draft and mint a second one.
        // Re-assert the durable entry. Normally redundant with `mutate()`'s write, but it is
        // the belt for the one window where it is not: a 410 reset wiped the store while this
        // request was in flight, and without this line the queued verb would be memory-only
        // again — the exact state the durable outbox exists to retire. It also persists the
        // counter and the delay, which is what makes the bound survive a restart.
        await this.putOutbox(p);
        return {
          id: p.id, key: p.key, status: "queued", seq: null, error: rejection,
          ...(rejection.entityId ? { entityId: rejection.entityId } : {}),
        };
      }
      // EXPLICIT REFUSAL: the local effect rolls back VISIBLY, once — the overlay drops, the
      // row reverts, and the rejection (with the server's own sentence) rides the result for
      // the surface to say.
      this.overlays.delete(p.id);
      this.awaitingEcho.delete(p.id);
      /**
       * WHERE THE REFUSAL GOES WHEN NOBODY IS WAITING FOR IT: The result carries the server's sentence, and for a
       * verb the user is watching that is enough: the composer is open, the strip is on screen, someone reads it. A
       * RESTORED VERB HAS NO SUCH READER. Its owner died with the previous session — that is what `restored` means —
       * so returning the sentence to a caller that is a drive loop throws it away, and dropping the row with it
       * leaves the person's work gone and unexplained: they queued something, closed the app, and it is simply not
       * there. The record is the only home an outcome has that outlives the retry, so the refusal is WRITTEN INTO IT,
       * one transaction, and the list shows what happened and why. `send_unverified` is the exception to
       * `retryRefused` and keeps its Retry.
       */

      /**
       * The adapter emits it `retryable: false`, and it is right that no automatic drive replays it — a send whose
       * answer was lost must never be re-POSTed blindly. But Try again on it is verify-under-the-same-key, not a
       * second message, and that is exactly the action a person with an unverified send needs. Hiding the control
       * would leave them with a row that says something went wrong and no way to find out.
       */
      if (p.restored === true) {
        const code = rejection.code;
        const record: PersistedOutboxEntry = {
          v: OUTBOX_ENTRY_VERSION, id: p.id, key: p.key, n: p.n, at: p.at, mutation: p.mutation,
          attempts: p.attempts ?? 0,
          lastError: { message: rejection.message, code, status: rejection.status },
          ...(code === "send_unverified" ? {} : { retryRefused: code ?? "refused" }),
        };
        try {
          await this.store.commitLocal(
            [{ type: OUTBOX_ABANDONED_TYPE, id: p.id, entity: record }],
            [{ type: OUTBOX_TYPE, id: p.id }],
          );
        } catch {
          /**
           * THE TRANSITION WAS REFUSED, SO HOLD THE RECORD IN MEMORY. Nothing moved on disk: the row is still a LIVE
           * outbox entry there. But the replay that dispatched it has already taken it out of the queue, and the boot
           * latch stops the store being read again this session — so without this the verb is in the queue, in
           * `abandoned()`, and on the screen exactly nowhere, while its durable row sits there unreferenced. A person
           * who has just had a send come back "this may have gone, check Sent" would see that warning appear and then
           * have nothing to act on, with no way to reach it again short of restarting the app. Held in memory
           * instead, so the record is listed and its controls work for the rest of the session. A reboot reads the
           * live row and replays it, which is honest: on disk the verb genuinely never reached its terminal state.
           */
          this.abandonedLocally.set(p.id, record);
          this.localRefusalRev++;
          this.notify();
        }
      } else {
        // The durable entry goes with it: a refused verb whose owner read the sentence must not
        // replay, and must not sit in a list claiming to be unfinished work.
        await this.dropOutbox(p.id);
      }
      this.overlayRev++;
      this.notify();
      // The refusal's own row rides the result for the same reason the queued arm's does: an
      // `unverified` send names the row the server marked, and nothing else in this client can.
      return {
        id: p.id, key: p.key, status: "rolled_back", seq: null, error: rejection,
        ...(rejection.entityId ? { entityId: rejection.entityId } : {}),
      };
    }
  }

  /**
   * ADD THE OPTIMISTIC SENT COPY of a confirmed send. A no-op for anything else. Gated on `mail_send` AND a
   * `providerMessageId`: the id is the server's word that the message left and was appended to Sent, and its absence
   * (the FixturesAdapter, an older server) means no overlay rather than a fabricated one. The copy goes into {@link
   * overlays} under a dedicated key so the {@link OverlayReader} merges it into every message read — the conversation
   * and the Ohbox see it with no change of their own — and its `messageIdHeader`/expiry are recorded in {@link
   * optimisticSent} for {@link reconcileOptimisticSent} to retire it by. Answers whether a copy was added, so the
   * caller can paint immediately and only then — a bare `notify()` on every mutation would wake every subscriber for
   * the seven kinds that never produce one.
   */
  private materializeSentOverlay(m: EngineMutation, outcome: MutationOutcome): boolean {
    if (m.kind !== "mail_send") return false;
    const header = outcome.providerMessageId;
    if (!header) return false;
    const sent = sentOverlayMessage(this.read(), m, header, { now: this.now, uuid: this.uuid });
    if (!sent) return false;
    const overlayId = `sent:${sent.id}`;
    const expiresAtMs = this.now().getTime() + OPTIMISTIC_SENT_TTL_MS;
    this.overlays.set(overlayId, [{ type: "message", id: sent.id, entity: sent }]);
    this.optimisticSent.set(overlayId, { header, expiresAtMs });
    this.seedSentAttachments(sent.id, m.attachments ?? [], expiresAtMs, m.forwardOf ?? undefined);
    return true;
  }

  /**
   * Hold the sent copy's attachments as the list the reader will ask for. The copy claims `hasAttachments`, and the
   * reader that opens it asks `loadAttachments(copy.id)` — an id minted HERE, which no server has a row for, so that
   * read can only 404: the message a person is most likely to open next rendered its strip as a failure until the
   * REAL Sent row arrived (observed live). The engine holds the complete answer at this moment — `m.attachments` is
   * the exact set the server just confirmed — so the list is seeded `ready` from those bytes, and `loadAttachments`
   * answers from the held list, never putting the fabricated id on the wire. Seeded for the no-attachment send too —
   * an empty `ready` list, so opening a just-sent message without files renders the ordinary nothing instead of a 404
   * sentence. Lifecycle is {@link sentAttachmentSeeds}'s: alive while the copy stands, swept at its TTL.
   */

  /**
   * A minting failure (no `URL.createObjectURL`) degrades to items without byte-backing — the strip still names the
   * files.
   */
  private seedSentAttachments(
    messageId: string,
    attachments: readonly ComposeAttachment[],
    expiresAtMs: number,
    forwardOf?: string,
  ): void {
    const composeItems: AttachmentItem[] = attachments.map((a, i) => {
      const bytes = base64ToBytes(a.contentBase64);
      const mimeType = a.contentType || "application/octet-stream";
      const minted = bytes
        ? this.mintObjectUrl(new Blob([bytes as BlobPart], { type: mimeType }), mimeType)
        : undefined;
      return {
        // A local id, namespaced so it can never collide with a server row id. It is only ever
        // resolved against this held list; `openAttachment` short-circuits on `ready` + URL, so
        // the id reaches no wire while the bytes stand.
        id: `${messageId}:sent-att:${i}`,
        filename: a.filename?.trim() || `attachment-${i + 1}.bin`,
        mimeType,
        sizeBytes: bytes?.length ?? 0,
        state: "ready" as const,
        inline: false,
        contentId: null,
        ...(minted ? { objectUrl: minted.url, blob: minted.blob } : {}),
      };
    });
    this.sentAttachmentSeeds.set(messageId, { live: true, expiresAtMs, forwardOf, composeItems });

    if (!forwardOf) {
      // A compose or reply: the mutation's files ARE the delivered files, so the list is complete.
      this.attachmentLists.set(messageId, { state: "ready", items: composeItems });
      return;
    }

    /**
     * A FORWARD'S DELIVERED MESSAGE CARRIES MORE THAN THE MUTATION DID: the server streams the original's parts onto
     * the outgoing mail. Publishing `composeItems` alone as `ready` would be a complete-looking list missing every
     * inherited file — for the copy's whole lifetime, because a ready list is never re-read. So the copy's list is
     * COMPOSED from the parent's (compose files + the original's parts, under their real server ids): immediately
     * when the parent's metadata is already in hand — the common case, the forward was pressed on an open message —
     * and otherwise as one ordinary indexed read of the PARENT's list, whose answer recomposes the copy and notifies
     * the open view. Until it answers, the copy's list stays unpublished (`loading`, the silent state) rather than
     * confidently incomplete.
     */
    if (!this.recomposeForwardSeed(messageId)) {
      void this.loadAttachments(forwardOf).then(() => {
        if (this.recomposeForwardSeed(messageId)) this.notify();
      });
    }
  }

  /**
   * Compose a FORWARD copy's attachment list from its seed and its parent's held list. The parent's items ride in as
   * fresh `idle` rows under their REAL attachment ids — the byte routes resolve an attachment id alone (`GET
   * /attachments/:id`), and the forward streamed the SAME parts, so a press fetches exactly the delivered bytes.
   * Deliberately WITHOUT the parent's byte state: an object URL shared between two lists dies for both when either
   * message is released. A parent list held `failed` is carried over as that same failure — the true sentence, with
   * the server's own code — and a retry from the copy's strip delegates back to the parent (see {@link
   * OhmailEngine.loadAttachments}), the one id a server can answer for.
   */

  /**
   * Also settles the overlay row's own paperclip: a forward's `hasAttachments`/`attachmentCount` cannot be derived
   * from the mutation (the inherited parts are not in it), so they are written here, from the composed list, counting
   * real files the way ingest does. Returns whether the copy's list is now published (ready or failed).
   */
  private recomposeForwardSeed(messageId: string): boolean {
    const seed = this.sentAttachmentSeeds.get(messageId);
    if (!seed?.forwardOf) return false;
    const parent = this.attachmentLists.get(seed.forwardOf);
    if (parent?.state === "failed") {
      this.attachmentLists.set(messageId, parent);
      return true;
    }
    if (parent?.state !== "ready") return false;
    // AT MOST WHAT THE SEND STREAMED. The server bounds a forward's inherited parts
    // (`SENT_FORWARD_MAX_PARTS` mirrors `SendService.FORWARD_MAX_PARTS`), so projecting the
    // parent's whole list onto a >cap original would claim files the recipient never got. The
    // MEMBERSHIP matches too: the send's capped query and the metadata list are both ordered by
    // attachment id (`send-service.ts` says why from its side), so this prefix names exactly the
    // parts the send streamed, over-cap originals included.
    const inherited: AttachmentItem[] = parent.items.slice(0, SENT_FORWARD_MAX_PARTS).map((i) => ({
      id: i.id,
      filename: i.filename,
      mimeType: i.mimeType,
      sizeBytes: i.sizeBytes,
      state: "idle" as const,
      inline: i.inline,
      contentId: i.contentId,
    }));
    const items = [...seed.composeItems, ...inherited];
    this.attachmentLists.set(messageId, { state: "ready", items });

    // The paperclip on the overlay row itself — real files only, the ingest rule.
    const overlay = this.overlays.get(`sent:${messageId}`);
    const entity = overlay?.[0]?.entity as EngineMessage | undefined;
    if (overlay && entity) {
      const files = items.filter((i) => !i.inline).length;
      this.overlays.set(`sent:${messageId}`, [{
        type: "message",
        id: messageId,
        entity: { ...entity, hasAttachments: files > 0, attachmentCount: files },
      }]);
      this.overlayRev++;
    }
    return true;
  }

  /**
   * RETIRE optimistic Sent copies — by the real row arriving, or by the TTL.
   *
   * The real row is the authoritative one: once the mirror holds a message carrying the same
   * `messageIdHeader` the copy was minted under, the copy is a duplicate and is dropped, so the
   * conversation shows the ingested row alone. The TTL is the backstop for a copy whose real row
   * this session never sees. Cheap by construction — it scans the mirror only while at least one
   * copy is outstanding, which is the rare case.
   */
  private reconcileOptimisticSent(): void {
    const nowMs = this.now().getTime();
    // The seed sweep runs even with no copy outstanding: a seed outlives its copy by design (the
    // pane may still be rendering it off-mirror), and the TTL is what bounds one nobody released.
    this.sweepSentAttachmentSeeds(nowMs);
    if (this.optimisticSent.size === 0) return;
    // BOTH sides through `messageIdKey`: the confirmation carries `<id@domain>`, the ingested row
    // carries `id@domain`, and the raw compare that stood here retired copies by TTL alone — see
    // the helper's docblock in `mutations.ts`.
    const landed = new Set<string>();
    for (const { entity } of this.store.entries<EngineMessage>("message")) {
      const h = entity.messageIdHeader;
      if (h) landed.add(messageIdKey(h));
    }
    for (const [overlayId, meta] of this.optimisticSent) {
      if (landed.has(messageIdKey(meta.header)) || nowMs >= meta.expiresAtMs) {
        this.overlays.delete(overlayId);
        this.optimisticSent.delete(overlayId);
        // The copy is retired, so its attachment seed stops being load-bearing: clearing `live`
        // hands the seed to the ordinary release path (the pane frees it on unmount; the sweep
        // above frees one nobody opened). NOT released here — a reader may be looking at the
        // copy at this very moment, and yanking its strip mid-read is the defect's mirror image.
        const seed = this.sentAttachmentSeeds.get(overlayId.slice("sent:".length));
        if (seed) seed.live = false;
      }
    }
  }

  /** Free every sent-copy attachment seed whose TTL has passed. See {@link sentAttachmentSeeds}. */
  private sweepSentAttachmentSeeds(nowMs: number): void {
    if (this.sentAttachmentSeeds.size === 0) return;
    for (const [messageId, seed] of this.sentAttachmentSeeds) {
      if (nowMs >= seed.expiresAtMs) this.forceReleaseAttachments(messageId);
    }
  }

  pendingMutations(): ReadonlyArray<{ id: string; key: string; mutation: EngineMutation }> {
    return [...this.queue];
  }

  /**
   * Retry every queued mutation (reconnect path), preserving keys and order.
   *
   * Refuses to DISPATCH while {@link outboxHold} stands — a timed-out replay's request is
   * still in the air, and dispatching behind it could land an older value after a newer one —
   * but it still ANSWERS, one `queued` result per entry: `useMailSend.flush` re-arms its
   * backoff timer only when a result says its key is still queued, so an empty array here
   * would read as "nothing left" and stop the very retry loop that will deliver the send once
   * the hold clears. The entries stay queued and persisted; the hold's settle nudges a drive.
   */
  /**
   * IS THERE AN ANSWER WAITING WITH NO CALLER? — a non-destructive read, and the only one. `flushPending()` is the
   * road every such answer travels and it is DESTRUCTIVE by design: the entries it hands back are removed, so exactly
   * one consumer can have them. That makes it unusable as a question. A surface that wants to know whether there is
   * anything to collect had only two bad options — pull on every notification (a poll wearing a subscription's
   * clothes, and it takes the outbox gate each time) or infer it from the QUEUE, which cannot work for the case that
   * matters: a replayed entry is removed from the queue BEFORE it is dispatched, so "something is pending" is never
   * observable on a mount that did not issue it, and a rule armed on that transition never fires. Measured, not
   * reasoned: three pulls, all empty, and the answer still sitting in the map. So the question is asked directly.
   */

  /**
   * `notify()` fires immediately after a late answer is recorded, which makes "subscribe, then ask this" exact rather
   * than periodic.
   */
  hasLateResults(): boolean {
    return this.lateResults.size > 0;
  }

  async flushPending(): Promise<MutationResult[]> {
    // THE HOLD IS READ BEFORE JOINING, exactly as `mutate` reads it, and for the same reason:
    // the gate WAITS OUT a standing hold before releasing, so a check inside the gated body
    // could never see one and this method would sit for minutes instead of answering. Its
    // contract is to answer — `useMailSend.flush` re-arms its backoff only when a result says
    // the key is still queued, and an empty array reads as "nothing left".
    /**
     * LATE ANSWERS FIRST, AND ABOVE THE HOLD CHECK.
     *
     * A late answer is the answer to the very request that armed the hold. Draining it below the
     * check meant it was never handed over while the barrier stood — which is exactly when it
     * exists — so a composer waiting on a send's settlement stayed locked until something else
     * happened to flush, and a create's server id sat in a map nobody read.
     */
    /**
     * TAKEN BY ID AND REMOVED INDIVIDUALLY, never cleared wholesale.
     *
     * `clear()` threw away every late answer, including ones that arrived while this flush was
     * being prepared and ones no surface here was going to read — so a settlement could be
     * removed by an unrelated consumer and then dropped on the floor. Only the entries actually
     * handed back are deleted; anything that lands afterwards is still there for the next flush.
     */
    const lateIds = [...this.lateResults.keys()];
    const late = lateIds.map((k) => this.lateResults.get(k)!);
    for (const k of lateIds) this.lateResults.delete(k);
    if (this.outboxHold) {
      return [
        ...late,
        ...this.queue.map((p) => ({ id: p.id, key: p.key, status: "queued" as const, seq: null })),
      ];
    }
    // THE SAME SINGLE-FLIGHT every other outbox road takes — see {@link outboxGate}. Without it
    // two surfaces could flush concurrently and, for the null-key read verbs, land newer-then-older.
    const results = await this.outboxGate(() => this.flushPendingInner());
    if (late.length > 0) results.unshift(...late);
    // OFF THE LANE. One drain covers the whole batch: they all finished before this line, so a
    // single drive that starts now began after every one of their POSTs returned and carries
    // every echo — the same happens-before the boot replay relies on.
    const owed = this.owedReconciles.splice(0);
    if (owed.length > 0) await this.settleReconcile(owed.includes("await") ? "await" : "background");
    return results;
  }

  /**
   * Reconciles a batch deferred, drained after the lane is released. A field rather than a return
   * value because `flushPendingInner` already answers one result per entry, and a second channel
   * through that signature would be a shape every future caller has to remember to unpack.
   */
  private readonly owedReconciles: Array<"await" | "background"> = [];

  private async flushPendingInner(): Promise<MutationResult[]> {
    // No in-flight wait and no hold check here: this body runs INSIDE {@link outboxGate}, which
    // does not release it until everything ahead has settled and no hold stands. A hold armed
    // while this was queued is therefore waited out by the gate — which is right for a caller
    // already committed to flushing. The hold that must NOT be waited out is one standing when
    // the host calls; `flushPending` reads that one before joining.
    if (this.outboxHold) {
      return this.queue.map((p) => ({ id: p.id, key: p.key, status: "queued" as const, seq: null }));
    }
    /**
     * NO BACKOFF GATE HERE, AND THAT IS DELIBERATE: `flushPending` is an EXPLICIT "try now" — a host calling it has
     * just done something (finished an action, regained a connection, watched a person press Send) and is asking for
     * this queue to go out. The backoff paces the AUTOMATIC drive, which retries on its own schedule with nobody
     * watching; applying it to a deliberate request means a person pressing a button and nothing happening for thirty
     * seconds, with no way to tell that from a hang. This gate WAS here for one commit, on the reasoning that a bound
     * should hold on every road out of the queue. Three mobile guards said otherwise within a minute: on that
     * platform `outboxAutoReplay` is false, so `flushPending` is the ONLY road, and gating it turned "one 500, then
     * an immediate in-place flush lands the send" into a silent queued state.
     */

    /**
     * The intuition was right about the shape and wrong about which road — the ceiling is what bounds this path, not
     * the delay, and it still applies: eight server-answered failures abandon the verb whether they arrived through
     * the drive or through here.
     */
    // A wait the SERVER named is honoured even here — see `waitIsServerNamed`. Our own backoff is
    // not: this is the explicit try-now road, and on mobile it is the only road.
    const ready = this.now().getTime();
    const held = this.queue.filter((p) => p.waitIsServerNamed === true && (p.nextAt ?? 0) > ready);
    const batch = this.queue.filter((p) => !(p.waitIsServerNamed === true && (p.nextAt ?? 0) > ready))
      .sort((a, b) => (a.at - b.at) || (a.n - b.n));
    this.queue.length = 0;
    this.queue.push(...held);
    // A verb waiting out the server's own interval is reported as queued rather than omitted, so a
    // caller gets one result per verb it is holding.
    const results: MutationResult[] = held.map((p) => ({
      id: p.id, key: p.key, status: "queued" as const, seq: null,
    }));
    /**
     * DEADLINE-BOUNDED, like every other dispatch road. This loop awaited `dispatch` directly, so one half-open
     * request held the flush — and every caller awaiting it, including a surface's spinner — open indefinitely. The
     * boot replay and the per-record retry both bound their attempts; this was the road that did not, which made
     * "every send has a time limit" false in the one place a host calls most often. A timed-out attempt still OWNS
     * its entry and becomes the order barrier, so the remaining batch is left queued rather than dispatched behind it
     * — the same rule the replay follows, for the same reason: a newer verb must not land before an older one that
     * may yet commit.
     */
    // Reconciles owed by this batch, issued AFTER the lane is released — see `dispatchOnLane`.
    // Held inside, a slow drain would time the dispatch that already succeeded and arm a barrier
    // that has nothing to do with the wire.
    const owedHere: Array<"await" | "background"> = [];
    for (let i = 0; i < batch.length; i++) {
      const p = batch[i]!;
      const out = await this.dispatchOnLane(p);
      if (out.held || out.timedOut || out.result === null) {
        results.push({ id: p.id, key: p.key, status: "queued", seq: null });
        for (const rest of batch.slice(i + 1)) {
          this.queue.push(rest);
          results.push({ id: rest.id, key: rest.key, status: "queued", seq: null });
        }
        break;
      }
      if (out.owed !== null) owedHere.push(out.owed);
      results.push(out.result);
    }
    this.owedReconciles.push(...owedHere);
    return results;
  }

  // ── local search ─────────────────────────────────────────────────────────

  /**
   * THE FAST PATH, and it stays the fast path.
   *
   * Synchronous, no round trip, answers from the mirror on every keystroke. It reads
   * subject, sender, the ≤200-character snippet and whatever body text this device holds —
   * `LocalSearchResult.coverage` says how much of the corpus that was, and the surface is
   * required to say so rather than let the count of hits imply completeness.
   */
  search(query: string, opts: { limit?: number } = {}): LocalSearchResult {
    const version = this.readerView.version();
    if (!this.searchCache || this.searchCache.version !== version) {
      this.searchCache = { version, index: SearchIndex.build(this.readerView) };
    }
    return this.searchCache.index.search(query, opts);
  }

  /**
   * EVERY MESSAGE ON THIS DEVICE INVOLVING ONE ADDRESS — the address view's device half. The same cached {@link
   * SearchIndex} {@link OhmailEngine.search} uses, and sharing it is not merely thrift: the index is rebuilt when the
   * mirror's version moves, so two caches would mean the address view and the search box could disagree about what
   * the mirror holds — one of them showing a message the other says is gone. Synchronous and total, like `search`:
   * the answer is a map lookup over the mirror already in memory. The ARCHIVE half is a separate, later pass — see
   * {@link OhmailEngine.searchServer} and, for the address query, `apps/webapp/app/shell/address-view.ts`, which is
   * where the two halves are composed and where the device's answer is labelled as the device's.
   */
  messagesWith(address: string, direction: AddressDirection = "any"): AddressResult {
    const version = this.readerView.version();
    if (!this.searchCache || this.searchCache.version !== version) {
      this.searchCache = { version, index: SearchIndex.build(this.readerView) };
    }
    return this.searchCache.index.messagesWith(address, direction);
  }

  // ── the archive pass ─────────────────────────────────────────────────────

  /**
   * Is there a server archive behind this client at all?
   *
   * `false` for the demo (`?demo=1` is fixtures and zero network) and for
   * the desktop tier, whose master is the IMAP mailbox and which has no Cloud API. Both are
   * states the UI must be able to STATE, not states it should hide: "there is no archive
   * here" and "the archive has not answered yet" are different sentences.
   */
  serverSearchAvailable(): boolean {
    return this.serverSearchFn !== null;
  }

  /**
   * Search the whole corpus — `GET /search`, the RRF-ranked hybrid that had zero callers. The SECOND answer, never
   * the first: {@link OhmailEngine.search} has already painted, and a surface that awaited this before rendering
   * would trade an instant local result for a round trip. The result does not go in the mirror: a search hit has no
   * seq, and a written row would outlive its own deletion in a store whose contract is convergence — items are
   * RETURNED and gone when the query changes; the caller should prefer its own mirror entity by id (it carries the
   * overlay) and fall back to the wire item. Single-flight per query, never rejects: the caller is a debounced React
   * effect, so the outcome is a value (`unavailable` / `ready` / `failed` with the server's sentence) — a 402 arrives
   * as its message.
   */

  /**
   * `cost: "read"` on the server; one request per settled query, never per keystroke — a paid request needs somebody
   * behind it.
   */
  async searchServer(query: string, opts: ServerSearchOpts = {}): Promise<ServerSearchOutcome> {
    const fn = this.serverSearchFn;
    if (fn === null) return { state: "unavailable" };
    const q = query.trim();
    if (q === "") return { state: "ready", items: [], total: 0, tier: "exact" };

    /**
     * THE SORT IS PART OF THE KEY, and omitting it would be a defect rather than a missed
     * optimisation. Single-flight joins concurrent callers onto ONE request, so a `date_desc`
     * pass issued while a `relevance` pass for the same query is still open would be handed the
     * relevance answer and render it under the newly-chosen control. Changing the order would
     * appear to do nothing — but only inside the debounce window, which is the shape that gets
     * filed as flakiness and never reproduced.
     */
    const key = `${opts.limit ?? ""}\u0000${opts.sort ?? ""}\u0000${q}`;
    const inFlight = this.serverSearches.get(key);
    if (inFlight) return inFlight;

    const request = fn(q, opts)
      .then((wire): ServerSearchOutcome => {
        // `null` ⇒ this transport serves no archive. Same shape as `fetchBody`'s `null`, and
        // it must not become an empty `ready`: "we searched everything and found nothing" is
        // a claim, and this is the case where we searched nothing at all.
        if (wire === null) return { state: "unavailable" };
        return {
          state: "ready",
          items: Array.isArray(wire.items) ? wire.items : [],
          total: typeof wire.total === "number" ? wire.total : (wire.items?.length ?? 0),
          // Absent ⇒ `exact`, and anything the wire says that is not one of the two tiers is
          // treated the same way. See {@link ServerSearchWire.tier}: the unknown case must not
          // file a real hit under a "Similar" heading.
          tier: wire.tier === "similar" ? "similar" : "exact",
        };
      })
      .catch((err: unknown): ServerSearchOutcome => ({
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
      }))
      .finally(() => {
        this.serverSearches.delete(key);
      });

    this.serverSearches.set(key, request);
    return request;
  }

  /**
   * Is there an archive behind this client that can be asked about an ADDRESS?
   *
   * Separate from {@link OhmailEngine.serverSearchAvailable} because the two capabilities are
   * resolved separately — see the constructor. `false` for the demo and the desktop tier, and
   * for a client whose adapter wrapper forwards the text search and not this one; all three are
   * "there is no archive here", which the view states rather than hides.
   */
  serverAddressSearchAvailable(): boolean {
    return this.serverAddressSearchFn !== null;
  }

  /**
   * ASK THE ARCHIVE ABOUT ONE ADDRESS — `GET /search?address=&direction=from`. The SECOND answer, never the first,
   * exactly as {@link OhmailEngine.searchServer} is: {@link OhmailEngine.messagesWith} has already painted from the
   * mirror and this extends it. THE DIRECTION IS NOT A PARAMETER, AND THAT IS DELIBERATE: The server answers `from`
   * and refuses the other two by name, so a `direction` argument here would be a choice with one legal value and two
   * ways to get a 400 — and the view's toggle must NOT reach the wire: switching to "To them" is a change to what is
   * SHOWN, not a new question for an archive that cannot answer it. So this asks `from` always, and the outcome
   * carries the direction back for the view to label. The day the recipient index lands, this grows an argument and
   * the view stops discarding the toggle; nothing else moves.
   */

  /**
   * Single-flight on the address, so a view that re-renders while a pass is open joins it instead of issuing a
   * second. THE RESULT DOES NOT GO IN THE MIRROR — `/sync` owns that, and a row from this route has no seq; the
   * reasoning is written out in full at `searchServer`.
   */
  async searchAddressServer(
    address: string, opts: ServerAddressOpts = {},
  ): Promise<ServerAddressOutcome> {
    const fn = this.serverAddressSearchFn;
    if (fn === null) return { state: "unavailable" };
    // An empty address is not a question. The server answers it empty too, so this is a saved
    // round trip rather than a divergence — and `ready` with no items is the honest shape: this
    // client did ask and there is nothing, which is what the count line reports.
    if (address.trim() === "") {
      return { state: "ready", items: [], total: 0, direction: "from" };
    }
    // `JSON.stringify` over a tuple, not a `\u0000`-joined string: it is unambiguous for any
    // address a header can carry, and this repository has twice paid for a control byte used
    // as a separator (a raw NUL in a source file makes every `grep` skip the whole file in
    // silence). The text arm one method up still joins on the escape; this is the form to copy.
    const key = JSON.stringify([opts.limit ?? null, address]);
    const inFlight = this.serverAddressSearches.get(key);
    if (inFlight) return inFlight;

    const request = fn(address, opts)
      .then((wire): ServerAddressOutcome => {
        // `null` ⇒ this transport serves no archive, and it must not become an empty `ready`:
        // "we searched the archive and there is nothing" is a claim, and this is the case where
        // nothing was searched. Same rule as `searchServer`'s and `fetchBody`'s `null`.
        if (wire === null) return { state: "unavailable" };
        return {
          state: "ready",
          items: Array.isArray(wire.items) ? wire.items : [],
          total: typeof wire.total === "number" ? wire.total : (wire.items?.length ?? 0),
          // Absent ⇒ `from`: it is the only direction the route serves, so a server that
          // predates the field answered `from` whatever it said. Anything the wire says that is
          // not a known direction takes the same reading rather than being carried through — a
          // view labelling its list with a word it does not understand is worse than the
          // conservative one.
          direction: (SERVER_ADDRESS_DIRECTIONS as readonly string[]).includes(wire.direction ?? "")
            ? (wire.direction as ServerAddressDirection)
            : "from",
        };
      })
      .catch((err: unknown): ServerAddressOutcome => ({
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
      }))
      .finally(() => {
        this.serverAddressSearches.delete(key);
      });

    this.serverAddressSearches.set(key, request);
    return request;
  }

  // ── reading past the end of the window ───────────────────────────────────

  /**
   * Is there anything BEHIND the end of this client's lists?
   *
   * `false` for the demo (`?demo=1` is fixtures and zero network) and for the
   * desktop tier, whose master is the IMAP mailbox and which keeps the whole of it on the device.
   * Both are states a list must be able to STATE: "you have reached the end of your mail" and "you
   * have reached the end of what this device keeps" are different sentences, and only one of them
   * has a control under it.
   */
  listOlderAvailable(): boolean {
    return this.listOlderFn !== null;
  }

  /**
   * One page of mail older than this device kept — `GET /messages?view=&cursor=`, the companion to {@link
   * StorePolicy}'s `windowed` mode: the rest of the mailbox is on the Cloud, reached a keyset page at a time, on an
   * explicit act, never speculatively. The result does not go in the mirror ({@link OhmailEngine.searchServer}'s
   * rule, sharper here): a row from this route has no seq, so writing it in creates a record no delta can update or
   * remove — and the next prune pass would evict it anyway. Items are RETURNED and gone when the view changes; the
   * caller should prefer its own mirror row by id (it carries the overlay and this device's triage). Single- flight
   * per view+cursor, so a bottom-effect firing twice issues one request; never rejects — the outcome is a value the
   * UI renders, a 402 arriving as its sentence. `cost: "read"`: no cost class changes.
   */
  async listOlder(
    view: OhmailView | "folder",
    opts: { cursor?: string; limit?: number; folderId?: string; startBelow?: { date: string | null; id: string } } = {},
  ): Promise<ListOlderOutcome> {
    const fn = this.listOlderFn;
    if (fn === null) return { state: "unavailable" };

    // JSON rather than a joined string: the three parts have no shared alphabet to separate them
    // with, and a hand-picked delimiter is how two different pages come to share one key. It also
    // keeps the separator out of the SOURCE. A single invisible control character here is a
    // file-wide hazard: it makes tooling classify this whole file as binary and skip it.
    const key = JSON.stringify([
      view, opts.cursor ?? null, opts.limit ?? null, opts.folderId ?? null,
      opts.startBelow ? [opts.startBelow.date, opts.startBelow.id] : null,
    ]);
    const inFlight = this.olderPages.get(key);
    if (inFlight) return inFlight;

    const request = fn(view, opts)
      .then((wire): ListOlderOutcome => {
        // `null` ⇒ this transport serves no older mail. Same shape as `fetchBody`'s and
        // `searchServer`'s `null`, and it must not become an empty `ready`: "the server answered
        // and there is nothing older" is a claim, and this is the case where nothing was asked.
        if (wire === null) return { state: "unavailable" };
        return {
          state: "ready",
          items: Array.isArray(wire.items) ? wire.items : [],
          nextCursor: typeof wire.nextCursor === "string" && wire.nextCursor !== "" ? wire.nextCursor : null,
        };
      })
      .catch((err: unknown): ListOlderOutcome => ({
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
        // The code travels with the sentence so the surface can decide whether the sentence is
        // one a person should be shown. `null` for anything that never reached a server.
        code: err instanceof MutationRejectedError ? err.code : null,
      }))
      .finally(() => {
        this.olderPages.delete(key);
      });

    this.olderPages.set(key, request);
    return request;
  }

  // ── Trash: mail this account deleted, and putting one back ───────────────

  /**
   * Can this client see and restore deleted mail at all? BOTH capabilities, deliberately. A Trash view whose Restore
   * button cannot work is not the feature — it is a list of mail with one dead control on every row — so the palette
   * row, the chord and the rail entry are gated on the pair. `false` for the demo (`?demo=1` is fixtures and zero
   * network), which must read as "Trash is not available here" and not as an empty Trash. Resolved from the adapter's
   * own optional capabilities, so it cannot disagree with what the two methods below will do.
   */
  trashAvailable(): boolean {
    return this.listTrashFn !== null && this.restoreFromTrashFn !== null;
  }

  /**
   * One page of mail this account deleted — `GET /messages?view=trash&cursor=`. The result does not
   * go in the mirror, and here that is structural: a delete TOMBSTONES the row (`apply.ts` rule 4),
   * so writing these rows in would resurrect them into every pile — deleted mail back in somebody's
   * Ohbox while the mail server has it in Trash. The items are RETURNED, the view holds them, and
   * they are gone when the view changes; there is no "prefer your own mirror row" advice, unlike
   * `listOlder` — the mirror has no row to prefer. Single-flight per page, never rejects (the
   * caller is a React effect; the outcome is a value the UI renders). `cost: "read"` on the
   * server, so this caller changes no cost class.
   */
  async listTrash(opts: { cursor?: string; limit?: number } = {}): Promise<ListTrashOutcome> {
    const fn = this.listTrashFn;
    if (fn === null) return { state: "unavailable" };

    // JSON rather than a joined string, for `listOlder`'s reason: no hand-picked delimiter, and
    // no control character in this file (a single one makes tooling classify the whole file as
    // binary and skip it).
    const key = JSON.stringify([opts.cursor ?? null, opts.limit ?? null]);
    const inFlight = this.trashPages.get(key);
    if (inFlight) return inFlight;

    const request = fn(opts)
      .then((wire): ListTrashOutcome => {
        // `null` ⇒ this transport serves no Trash. It must NOT become an empty `ready`: "there
        // is nothing in Trash" is a claim, and this is the case where nothing was asked.
        if (wire === null) return { state: "unavailable" };
        return {
          state: "ready",
          items: Array.isArray(wire.items) ? wire.items : [],
          nextCursor: typeof wire.nextCursor === "string" && wire.nextCursor !== "" ? wire.nextCursor : null,
        };
      })
      .catch((err: unknown): ListTrashOutcome => ({
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof MutationRejectedError ? err.code : null,
      }))
      .finally(() => {
        this.trashPages.delete(key);
      });

    this.trashPages.set(key, request);
    return request;
  }

  /**
   * Put one deleted message back where it was — `POST /messages/:id/restore`. Not an `EngineMutation`, and it could
   * not be: {@link OhmailEngine.mutate} rejects a mutation whose local effects are empty, and a mutation over a
   * tombstoned message has none — so this is a plain call with no overlay and no outbox entry; the durable record of
   * a pressed restore is the SURFACE's journal (`delete-intents.ts`), whose entries carry which verb they are. It
   * does not claim the mail is back: `pending` comes back true — the mail server performs the move on the organizer's
   * next turn, the tombstone clears when the message is OBSERVED in the target folder, and a surface that read the
   * 200 as "restored" would show mail in a place the server does not have it. `restoreTo` is the server's answer and
   * may differ from the row's rendered one, so the toast names THIS value.
   */

  /**
   * Single-flight per message id: a double press is one request.
   */
  async restoreFromTrash(
    messageId: string,
    /**
     * WHICH PRESS THIS IS, from the surface's own durable journal — the one thing that tells a
     * REPLAY from a second press. The key is composed here rather than by the surface so one
     * place owns what goes in the header; a caller without a journal passes nothing and the
     * request carries no key, exactly as before.
     */
    opts: { intentId?: string } = {},
  ): Promise<RestoreOutcome> {
    const fn = this.restoreFromTrashFn;
    if (fn === null) return { state: "unavailable" };
    const inFlight = this.restoreCalls.get(messageId);
    if (inFlight) return inFlight;

    const key = opts.intentId === undefined || opts.intentId === ""
      ? undefined
      : `restore:${opts.intentId}:${messageId}`;
    const request = fn(messageId, key === undefined ? {} : { idempotencyKey: key })
      .then((wire): RestoreOutcome => {
        // `null` ⇒ no restore route behind this transport. Same rule as the page above: it is
        // not a refusal and must not be reported as one.
        if (wire === null) return { state: "unavailable" };
        return {
          state: "restored",
          restoreTo: typeof wire.restoreTo === "string" && wire.restoreTo !== "" ? wire.restoreTo : "INBOX",
          pending: wire.pending !== false,
        };
      })
      .catch((err: unknown): RestoreOutcome => ({
        state: "rolled_back",
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof MutationRejectedError ? err.code : null,
      }))
      .finally(() => {
        this.restoreCalls.delete(messageId);
      });

    this.restoreCalls.set(messageId, request);
    return request;
  }

  // ── attachments ──────────────────────────────────────────────────────────

  /**
   * Can this client open attachments at all?
   *
   * `false` for the demo (`?demo=1` is fixtures and zero network), where the
   * paperclip must not offer a control that cannot work. Resolved from the adapter's own optional
   * capability, so it cannot disagree with what the methods below will do.
   */
  attachmentsAvailable(): boolean {
    return typeof this.adapter.listAttachments === "function"
      && typeof this.adapter.fetchAttachment === "function";
  }

  /**
   * What the surface renders RIGHT NOW for one message. Synchronous, no side effects — separate from {@link
   * OhmailEngine.loadAttachments} because React renders far more often than it should fetch: the render path reads
   * state, the effect path asks. `includeInlineImages`: the default is FILES ONLY, what every caller has always got —
   * a `cid:` logo listed beside a real invoice, in a rendering that already paints that logo, is the same picture
   * named twice. The exception is the rendering that paints NO pictures (the app's own typography over the text
   * part): there an inline image was in the message and reachable from nowhere. A caller that knows it is drawing the
   * frameless rendering asks and gets them as ordinary items — same fetch, size ceiling, preview gate and download;
   * the flag widens what is LISTED and nothing else.
   */

  /**
   * Filtering here rather than at ingest keeps both answers available at once.
   */
  attachmentsOf(messageId: string, opts: { includeInlineImages?: boolean } = {}): AttachmentsOutcome {
    if (!this.attachmentsAvailable()) return { state: "unavailable" };
    const held = this.attachmentLists.get(messageId) ?? { state: "loading" as const };
    if (held.state !== "ready") return held;
    const shown = held.items.filter(
      (item) => !item.inline || (opts.includeInlineImages === true && isPictureItem(item)),
    );
    // Identity preserved when nothing is withheld — the common case is a message with no inline
    // parts at all, and a fresh object per render for it would be churn with no reader.
    return shown.length === held.items.length ? held : { state: "ready", items: shown };
  }

  /**
   * The FETCHED BYTES of one ready attachment — the type-downgraded Blob the object URL was
   * minted from — or `undefined` when it has not been fetched yet.
   *
   * A preview surface reads this to parse a PDF (`blob.arrayBuffer()`) or a text part
   * (`blob.text()`) WITHOUT re-fetching the object URL. See {@link AttachmentItem.blob} for why
   * a re-fetch is not an option and why this is the post-downgrade blob, not the wire one.
   */
  attachmentBlobOf(messageId: string, attachmentId: string): Blob | undefined {
    return this.itemOf(messageId, attachmentId)?.blob;
  }

  /**
   * Read one message's attachment METADATA — filenames, types, sizes; no bytes, no IMAP (`cost: "read"`, an indexed
   * row read, which is what makes it acceptable on open). Inline parts are kept here and withheld at the read: `cid:`
   * images the html references used to be dropped in this method — right about what a FILE is, wrong about what a
   * picture is, because the frameless rendering draws no images at all and the drop made a sent picture unreachable
   * from anywhere in the product. The list keeps every part and {@link OhmailEngine.attachmentsOf} decides. The
   * paperclip agrees: `hasAttachments` derives from REAL FILES at ingest (`mime.ts` `isRealFile`), the backfill
   * corrected old rows, and the residual is a pre-signal row whose signature logo sits under `multipart/mixed` — a
   * fact about stored rows, not this method.
   */

  /**
   * Every return goes through `attachmentsOf` with no options, so an untaught caller gets exactly the old list. Never
   * rejects: single-flight per message, the failure a value the UI renders.
   */
  async loadAttachments(messageId: string, opts: { retry?: boolean } = {}): Promise<AttachmentsOutcome> {
    const list = this.adapter.listAttachments;
    if (!list || !this.attachmentsAvailable()) return { state: "unavailable" };

    /*
     * A FORWARD'S SENT COPY DELEGATES TO ITS PARENT. The copy's id was minted client-side and
     * exists on no server — a wire read against it can only 404 — while the parent's id is real
     * and its list names the exact parts the forward streamed. So the copy's read (the pane's
     * mount effect, and its strip's own Retry) is answered by reading the PARENT and composing:
     * a held-ready copy answers directly, a retry re-asks the parent under the same human-press
     * rule every retry obeys, and the composed outcome — including a carried failure — is what
     * the copy's surface renders. See {@link recomposeForwardSeed}.
     */
    const seed = this.sentAttachmentSeeds.get(messageId);
    if (seed?.forwardOf) {
      const held = this.attachmentLists.get(messageId);
      if (held?.state !== "ready") {
        await this.loadAttachments(seed.forwardOf, opts);
        if (this.recomposeForwardSeed(messageId)) this.notify();
      }
      return this.attachmentsOf(messageId);
    }

    const inFlight = this.attachmentListRequests.get(messageId);
    if (inFlight) return inFlight.then(() => this.attachmentsOf(messageId));

    const held = this.attachmentLists.get(messageId);
    // Already answered. Re-reading would discard the per-item byte state (`ready` object URLs and
    // all) for a list that cannot have changed — attachments are immutable parts of a stored message.
    if (held && held.state === "ready") return this.attachmentsOf(messageId);
    // See `hydrateBody`'s `retry` note: an automatic trigger must not re-ask a server that refused,
    // or a React effect whose identity changes per render loops against it for as long as the view
    // is open. A human pressing Retry passes `retry`.
    if (held && held.state === "failed" && !opts.retry) return held;

    // `retrying` marks a HUMAN re-ask over a failure, and nothing else: the first ask of a
    // message must stay `{ state: "loading" }` with the field absent, because that is the state
    // the surface renders as silence.
    const retrying = opts.retry === true && held?.state === "failed";
    this.attachmentLists.set(messageId, retrying ? { state: "loading", retrying: true } : { state: "loading" });
    this.notify();

    const request = list.call(this.adapter, messageId)
      .then((wire): AttachmentsOutcome => {
        return { state: "ready", items: wire.map(toAttachmentItem) };
      })
      // The adapter's own classification, kept. `MutationRejectedError` is the one thing `HttpAdapter` throws, and it
      // throws it for THREE reasons: a non-2xx (`rejectionOf`: the server's code, and `retryable` defaulted from the
      // status), a fetch that rejected outright (`code: "network"`), and — since the read was given a deadline — a
      // request that answered nothing at all inside `ATTACHMENT_LIST_TIMEOUT_MS` (`code: "timeout"`, `retryable:
      // true`, raised by `HttpAdapter.withDeadline`, which aborts the request as it throws). That third one is why
      // this catch exists at all now: before it, a hung read never reached here, the outcome stayed `loading`, and
      // the surface drew nothing for ever. Anything else reaching here is unclassified, and unclassified means we
      // never established that the server refused, so asking again is honest. See {@link AttachmentsOutcome}.
      .catch((err: unknown): AttachmentsOutcome => ({
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof MutationRejectedError ? err.code : null,
        retryable: err instanceof MutationRejectedError ? err.retryable : true,
      }))
      .then((outcome) => {
        this.attachmentLists.set(messageId, outcome);
        this.notify();
        return outcome;
      })
      .finally(() => {
        this.attachmentListRequests.delete(messageId);
      });

    this.attachmentListRequests.set(messageId, request);
    // The RECORD keeps every part (`request` resolves to it); what this returns is the files view.
    return request.then(() => this.attachmentsOf(messageId));
  }

  /**
   * FETCH ONE ATTACHMENT'S BYTES from the user's IMAP mailbox and mint a Blob URL for it. `cost: "connection"` — this
   * opens a real IMAP connection to somebody's mail server, which is the most expensive read in the product. So it
   * fires on an explicit human act only: a click on that file. Never on render, never on selection, never
   * speculatively for a strip. Never rejects (the caller is a click handler). The outcome is the item's `state`:
   * · `too_large` — the server refused at its size ceiling (`payload_too_large`). A distinct state, not a failure,
   *   because the answer is permanent and a Retry button would be a lie.
   * · `failed`    — anything else, carrying the server's own sentence.
   * Single-flight per message and attachment: a double-click is one fetch, not two IMAP connections.
   */

  /**
   * (Per MESSAGE, because a forward's copy lists its parent's parts under the same ids — see the note at the flight
   * key.)
   */
  async openAttachment(messageId: string, attachmentId: string, opts: { retry?: boolean } = {}): Promise<void> {
    const fetchOne = this.adapter.fetchAttachment;
    if (!fetchOne) return;

    // PER MESSAGE, not per attachment id alone: a forward's sent copy lists the parent's parts
    // under their own ids, so the same id legitimately stands in two message lists at once. A
    // flight keyed by the bare id would hand the second list the FIRST list's promise — whose
    // completion patches only the first list — and the press on the copy would silently move
    // nothing out of `idle`. The cost is one possible duplicate fetch of the same part across
    // two messages, which is the rare case; the double-click on one message stays one fetch.
    const flightKey = `${messageId}:${attachmentId}`;
    const inFlight = this.attachmentRequests.get(flightKey);
    if (inFlight) return inFlight;

    const current = this.itemOf(messageId, attachmentId);
    if (!current) return;
    // Already fetched, and the URL is still live — the bytes are in the tab, nothing to ask for.
    if (current.state === "ready" && current.objectUrl) return;
    // A refusal at the ceiling cannot become a success by asking again.
    if (current.state === "too_large") return;
    if (current.state === "failed" && !opts.retry) return;

    this.patchAttachment(messageId, attachmentId, { state: "loading", error: undefined });

    const request = fetchOne.call(this.adapter, attachmentId)
      .then((blob) => {
        // REVOKE BEFORE RE-MINTING. A retry over a `failed` item that had somehow minted a URL,
        // or any second pass, would otherwise leak the old one for the life of the document.
        this.revokeItem(messageId, attachmentId);
        const minted = this.mintObjectUrl(blob, current.mimeType);
        // The URL and the typed Blob are stored together: a preview parses the Blob (no
        // `fetch(blob:)`, which `connect-src 'self'` refuses on the live host), the strip and
        // `<a download>` use the URL, and both are dropped by `releaseAttachments` at once.
        this.patchAttachment(messageId, attachmentId, {
          state: "ready",
          ...(minted ? { objectUrl: minted.url, blob: minted.blob } : {}),
        });
      })
      .catch((err: unknown) => {
        const code = (err as { code?: unknown } | null)?.code;
        const message = err instanceof Error ? err.message : String(err);
        this.patchAttachment(messageId, attachmentId, {
          state: code === "payload_too_large" ? "too_large" : "failed",
          error: message,
        });
      })
      .finally(() => {
        this.attachmentRequests.delete(flightKey);
      });

    this.attachmentRequests.set(flightKey, request);
    return request;
  }

  /**
   * Fetch every non-inline attachment on a message as ONE zip, assembled server-side: one request and one IMAP
   * connection for the whole set — N `openAttachment` calls would be N logins, the pattern providers throttle.
   * Returns the Blob for the caller to save, or `null`. The failure is the CALLER's to report and the list is left
   * alone: a failed zip says nothing about the metadata — a list-level failure row here would claim the files are
   * unknown while they are on screen (an earlier shape wrote `{state: "failed"}` over the list, blanking a strip the
   * user was looking at). The zip may legitimately be missing files — the server skips a part it cannot fetch and
   * names it in `_errors.txt` inside the archive — so a non-null answer is not a promise that every file is present.
   */
  async downloadAllAttachments(messageId: string): Promise<Blob | null> {
    const fetchAll = this.adapter.fetchAllAttachments;
    if (!fetchAll) return null;
    try {
      return await fetchAll.call(this.adapter, messageId);
    } catch {
      return null;
    }
  }

  /**
   * The embedded images already minted for one message: `contentId → data: URI`, the map a
   * renderer resolves the html body's `cid:` references against. Synchronous, no side effects —
   * the render path reads, {@link OhmailEngine.loadInlineImages} is what asks.
   *
   * The identity is stable between mints and changes exactly when an image arrives, so it is
   * safe to use as a memo dependency around an expensive sanitize pass.
   */
  inlineImagesOf(messageId: string): ReadonlyMap<string, string> {
    return this.inlineImages.get(messageId) ?? NO_INLINE_IMAGES;
  }

  /**
   * Fetch the embedded images a message's html actually references, and mint each as a `data:` URI for the mail
   * frame. `contentIds` comes from the renderer's own pass over the sanitized document — parts nothing references are
   * never fetched. What this spends: one `cost: "connection"` fetch per part through {@link
   * OhmailEngine.openAttachment} (single-flight, never re-asked after a refusal); the reader OPENED this message and
   * the document names these parts — a signature logo as a grey box in every mail from a colleague is the defect, not
   * thrift. Bounds: only `Content-ID`-referenced parts; only declared raster images within {@link
   * INLINE_IMAGE_MAX_BYTES}, at most {@link INLINE_IMAGE_MAX_PARTS} parts / {@link INLINE_IMAGE_MAX_TOTAL_BYTES} per
   * message; fetched SEQUENTIALLY; a failed part stays failed, so a re-render cannot loop a connection-cost fetch.
   */

  /**
   * Never rejects; single-flight per message — the pane is mounted twice and both mounts ask for the same document.
   */
  async loadInlineImages(messageId: string, contentIds: readonly string[]): Promise<void> {
    if (!this.attachmentsAvailable() || contentIds.length === 0) return;

    const inFlight = this.inlineImageRequests.get(messageId);
    if (inFlight) return inFlight;

    const request = this.fetchInlineImages(messageId, contentIds)
      .catch(() => {})
      .finally(() => {
        this.inlineImageRequests.delete(messageId);
      });
    this.inlineImageRequests.set(messageId, request);
    return request;
  }

  /** The working half of {@link OhmailEngine.loadInlineImages}, behind its single-flight gate. */
  private async fetchInlineImages(messageId: string, contentIds: readonly string[]): Promise<void> {
    await this.loadAttachments(messageId);
    const held = this.attachmentLists.get(messageId);
    if (held?.state !== "ready") return;

    const have = this.inlineImages.get(messageId);
    const wanted: AttachmentItem[] = [];
    const seen = new Set<string>();
    let budget = INLINE_IMAGE_MAX_TOTAL_BYTES;
    // Reference order — the order the reader meets the images — so the budget is spent on what
    // is nearest the top of the document, not on whatever sorts first.
    for (const cid of contentIds) {
      if (wanted.length >= INLINE_IMAGE_MAX_PARTS) break;
      if (seen.has(cid) || have?.has(cid)) continue;
      seen.add(cid);
      const item = held.items.find((i) => i.contentId === cid);
      if (!item) continue;
      // The declared-type/size gate: don't pay a connection for a part the mint below would
      // refuse anyway. The declaration is the sender's claim; the REAL gates are post-fetch.
      if (!INLINE_IMAGE_MIME.has(item.mimeType.toLowerCase())) continue;
      if (item.sizeBytes > INLINE_IMAGE_MAX_BYTES || item.sizeBytes > budget) continue;
      budget -= item.sizeBytes;
      wanted.push(item);
    }

    const minted: Array<[string, string]> = [];
    for (const item of wanted) {
      await this.openAttachment(messageId, item.id);
      const blob = this.attachmentBlobOf(messageId, item.id);
      if (!blob) continue;
      const url = await mintInlineDataUrl(blob);
      if (url) minted.push([item.contentId!, url]);
    }
    if (minted.length === 0) return;

    // Re-checked AFTER the awaits: a message released mid-pass (the reader moved on) must not
    // have its map re-created to outlive the byte state it belongs with.
    if (this.attachmentLists.get(messageId)?.state !== "ready") return;
    const next = new Map(this.inlineImages.get(messageId) ?? NO_INLINE_IMAGES);
    for (const [cid, url] of minted) next.set(cid, url);
    // ONE replacement and ONE notification for the whole pass, not one per image: every map
    // identity change re-sanitizes and re-measures the mail document downstream.
    this.inlineImages.set(messageId, next);
    this.notify();
  }

  /**
   * The decoded text of a message's calendar parts already in hand: `attachmentId → ics text`,
   * what an event-preview surface parses ({@link import("@trafficflow/core/ics").parseIcsEvent})
   * and renders. Synchronous, no side effects — the render path reads,
   * {@link OhmailEngine.loadCalendarTexts} is what asks. Identity-stable between fills, so a
   * memoized parse can key on the map.
   */
  calendarTextsOf(messageId: string): ReadonlyMap<string, string> {
    return this.calendarTexts.get(messageId) ?? NO_CALENDAR_TEXTS;
  }

  /**
   * FETCH THE CALENDAR PARTS a message carries and hold their decoded text for the event preview. The third
   * legitimate automatic act on the `cost: "connection"` path, and it stands on {@link
   * OhmailEngine.loadInlineImages}'s argument verbatim: the reader OPENED this message, a meeting invitation drawn as
   * an opaque tile named `invite.ics` is the defect rather than thrift, and what keeps an automatic trigger bounded
   * where a press is bounded by the pressing:
   * · only parts DECLARED as calendar data ({@link isCalendarItem}) within {@link CALENDAR_TEXT_MAX_BYTES}, at most
   *   {@link CALENDAR_TEXT_MAX_PARTS} per message — real meeting mail carries exactly one, 1–4 KB;
   * · the real byte count is re-checked post-fetch — the declaration is the sender's claim;
   */

  /**
   * · SEQUENTIALLY, through {@link OhmailEngine.openAttachment} — single-flight per part, and a part that failed
   *   stays failed (no automatic re-ask against a server that refused);
   * · the bytes were being fetched for the tile anyway on the first press — this pass just spends them on a card
   *   the reader can read instead of a name they can only save.
   * Never rejects; the caller is a render effect. Single-flight per message (the pane is mounted twice while the
   * reader is open, and both mounts ask).
   */
  async loadCalendarTexts(messageId: string): Promise<void> {
    if (!this.attachmentsAvailable()) return;

    const inFlight = this.calendarTextRequests.get(messageId);
    if (inFlight) return inFlight;

    const request = this.fetchCalendarTexts(messageId)
      .catch(() => {})
      .finally(() => {
        this.calendarTextRequests.delete(messageId);
      });
    this.calendarTextRequests.set(messageId, request);
    return request;
  }

  /** The working half of {@link OhmailEngine.loadCalendarTexts}, behind its single-flight gate. */
  private async fetchCalendarTexts(messageId: string): Promise<void> {
    await this.loadAttachments(messageId);
    const held = this.attachmentLists.get(messageId);
    if (held?.state !== "ready") return;

    const have = this.calendarTexts.get(messageId);
    const wanted = held.items
      .filter((i) => isCalendarItem(i) && !have?.has(i.id) && i.sizeBytes <= CALENDAR_TEXT_MAX_BYTES)
      .slice(0, CALENDAR_TEXT_MAX_PARTS);
    if (wanted.length === 0) return;

    const decoded: Array<[string, string]> = [];
    for (const item of wanted) {
      await this.openAttachment(messageId, item.id);
      const blob = this.attachmentBlobOf(messageId, item.id);
      // The REAL byte gate — `sizeBytes` above was only the sender's claim.
      if (!blob || blob.size === 0 || blob.size > CALENDAR_TEXT_MAX_BYTES) continue;
      try {
        decoded.push([item.id, await blob.text()]);
      } catch {
        // Undecodable bytes: the tile stands, the card simply never appears.
      }
    }
    if (decoded.length === 0) return;

    // Re-checked AFTER the awaits: a message released mid-pass (the reader moved on) must not
    // have its map re-created to outlive the byte state it belongs with.
    if (this.attachmentLists.get(messageId)?.state !== "ready") return;
    const next = new Map(this.calendarTexts.get(messageId) ?? NO_CALENDAR_TEXTS);
    for (const [id, text] of decoded) next.set(id, text);
    // ONE replacement and ONE notification for the whole pass — a map identity change re-parses
    // and re-renders the card downstream.
    this.calendarTexts.set(messageId, next);
    this.notify();
  }

  /**
   * Revoke every object URL held for a message and forget its byte state. MUST be called when the surface stops
   * rendering the message (a pane unmount, a different message selected). A `blob:` URL pins its bytes in memory
   * until it is revoked or the document dies, so a session spent opening PDFs in a long-lived tab would otherwise
   * accumulate every one of them — the exact cost the "nothing is stored" design exists to avoid, reintroduced in the
   * browser instead of the database. The minted `data:` URIs go with it — they pin the same bytes as base64 in a
   * string instead of behind a URL. The calendar texts too: they are decodings of the same released bytes.
   */
  releaseAttachments(messageId: string): void {
    // A LIVE sent-copy seed declines the release: the optimistic Sent copy is still standing in
    // the mirror, its id exists on no server, and dropping the seed would turn the next open of
    // that copy back into the 404 the seed exists to answer. The seed's own lifecycle frees it —
    // `reconcileOptimisticSent` clears `live` when the copy retires (after which this release
    // works normally) and sweeps it at the copy's TTL. See {@link sentAttachmentSeeds}.
    const seed = this.sentAttachmentSeeds.get(messageId);
    if (seed?.live) {
      // …but a CARRIED FAILURE must not survive the release. A release followed by a re-load is
      // the one gesture surfaces use to mean "the refusal's cause is gone — ask again" (the
      // session-revival seam re-asks an auth-failed list exactly this way), and a forward copy's
      // failure is the PARENT read's, which expires with whatever refused it there. So the
      // failed states are dropped on both ids — the seeded bytes stay, and the next delegated
      // read recomposes from the parent's fresh answer.
      const held = this.attachmentLists.get(messageId);
      if (held?.state === "failed") {
        this.attachmentLists.delete(messageId);
        if (seed.forwardOf && this.attachmentLists.get(seed.forwardOf)?.state === "failed") {
          this.attachmentLists.delete(seed.forwardOf);
        }
        this.notify();
      }
      return;
    }
    this.forceReleaseAttachments(messageId);
  }

  /** Revoke everything, for a teardown that is losing the whole engine. Live seeds included —
   *  and seeds whose copy list was never published (a forward still waiting on its parent hold
   *  minted compose URLs with no `attachmentLists` entry to find them under). */
  releaseAllAttachments(): void {
    const ids = new Set([...this.attachmentLists.keys(), ...this.sentAttachmentSeeds.keys()]);
    for (const messageId of ids) this.forceReleaseAttachments(messageId);
  }

  /** The unconditional half of {@link OhmailEngine.releaseAttachments}. */
  private forceReleaseAttachments(messageId: string): void {
    const seed = this.sentAttachmentSeeds.get(messageId);
    if (seed) {
      // The seed's compose items hold minted URLs even when the copy's list was never published
      // (a forward still waiting on its parent) — revoke them here or they outlive everything.
      // Revoking one twice is a no-op, so the held-list pass below stays as it is.
      for (const item of seed.composeItems) this.revokeUrl(item.objectUrl);
      this.sentAttachmentSeeds.delete(messageId);
    }
    const held = this.attachmentLists.get(messageId);
    if (held?.state === "ready") {
      for (const item of held.items) this.revokeUrl(item.objectUrl);
    }
    this.attachmentLists.delete(messageId);
    this.inlineImages.delete(messageId);
    this.calendarTexts.delete(messageId);
    this.notify();
  }

  private itemOf(messageId: string, attachmentId: string): AttachmentItem | undefined {
    const held = this.attachmentLists.get(messageId);
    if (held?.state !== "ready") return undefined;
    return held.items.find((i) => i.id === attachmentId);
  }

  /** Replace one item in a message's list and re-render. */
  private patchAttachment(messageId: string, attachmentId: string, patch: Partial<AttachmentItem>): void {
    const held = this.attachmentLists.get(messageId);
    if (held?.state !== "ready") return;
    this.attachmentLists.set(messageId, {
      state: "ready",
      items: held.items.map((i) => (i.id === attachmentId ? { ...i, ...patch } : i)),
    });
    this.notify();
  }

  private revokeItem(messageId: string, attachmentId: string): void {
    this.revokeUrl(this.itemOf(messageId, attachmentId)?.objectUrl);
  }

  private revokeUrl(url: string | undefined): void {
    if (!url) return;
    const U = (globalThis as { URL?: { revokeObjectURL?: (u: string) => void } }).URL;
    U?.revokeObjectURL?.(url);
  }

  /**
   * Mint a Blob URL, DOWNGRADING the content type of anything a browser would render as a document. See {@link
   * RENDERABLE_MIME}. The re-typing happens at construction because that is the only point that governs every
   * consumer: a call site can forget to check a type, and the two the server sets (`Content-Disposition`, `nosniff`)
   * describe the RESPONSE and do not survive into a Blob made from its body. Returns `undefined` where there is no
   * `URL.createObjectURL` — SSR and the node test environment — so a `ready` item there simply carries no URL rather
   * than throwing inside a render. It returns the typed Blob ALONGSIDE the URL, not just the URL, so the two cannot
   * diverge: the bytes a preview parses are byte-for-byte the ones the browser would render or save, at the same
   * downgraded type. Minting and retention are one act for exactly that reason.
   */
  private mintObjectUrl(blob: Blob, declaredMime: string): { url: string; blob: Blob } | undefined {
    const U = (globalThis as {
      URL?: { createObjectURL?: (b: Blob) => string };
    }).URL;
    if (typeof U?.createObjectURL !== "function") return undefined;
    const safeType = RENDERABLE_MIME.has(declaredMime.toLowerCase()) ? declaredMime : "application/octet-stream";
    const typed = blob.type === safeType ? blob : new Blob([blob], { type: safeType });
    return { url: U.createObjectURL(typed), blob: typed };
  }
}
