// THE SHARED DRAIN POLICY — the staleness threshold, the dense-page limit and the two
// derivations over the drain stamp, held in one module with the desktop sidecar's mirror
// (INSTANT-ARCH §6.7). A dependency-free core subpath, like `./ics` above; imported for local
// use AND re-exported below, so this engine's public surface is unchanged while there is
// exactly one definition of each.
import { type MirrorFreshness, STALE_RESUME_MS } from "@trafficflow/core/drain-policy";
import type { CreatedDraftRow, EngineAdapter, WithdrawSendOutcome } from "../adapters/adapter.js";
import type { KeptDecision } from "../kept-decisions.js";
import type { MutationEffect } from "../mutations.js";
import { ObjectUrlLedger } from "../object-urls.js";
import { PartLane } from "../part-lane.js";
import type { SearchIndex } from "../search.js";
import { oneSourceReader } from "../selectors.js";
import type { ShadowKey } from "../shadow.js";
import {
  HISTORY_PAGE_CACHE_ROWS, StorePageCache, type StorePageOutcome, type StoreTimeline, type StoreTimelineFn,
  type StoreTimelineOutcome,
} from "../store-pages.js";
import { type EntityReader, MemoryMirrorStore, type MirrorStore, type OutboxNotices } from "../store.js";
import { type EngineMutation, OUTBOX_ABANDONED_TYPE, type WaitingRequestWire } from "../types.js";
import type { AttachmentItem, AttachmentsOutcome } from "./attachment-items.js";
import type { KeptAsNewDraft, MutationResult, PendingMutation } from "./mutation-views.js";
import {
  defaultEngineLocks, DRAIN_REQUEST_CEILING_MS, type EngineLocks, type EngineOptions, OUTBOX_HOLD_CEILING_MS,
  OUTBOX_REPLAY_DEADLINE_MS,
} from "./options.js";
import {
  type AbandonedMutation, isPersistedOutboxEntry, NO_QUEUED, NO_WAITING, type PersistedOutboxEntry,
  type QueuedChange, type WaitingSend,
} from "./outbox-record.js";
import { OverlayReader, PageFallbackReader } from "./overlay-reader.js";
import {
  type BodyAsk, DEFAULT_STORE_POLICY, type FetchBodiesCapableAdapter, type FetchBodiesFn, type FetchMessageOutcome,
  type ListMessagesCapableAdapter, type ListOlderFn, type ListOlderOutcome, type ListTrashCapableAdapter,
  type ListTrashFn, type ListTrashOutcome, type MessageByIdCapableAdapter, type MessageByIdFn,
  type RestoreFromTrashCapableAdapter, type RestoreFromTrashFn, type RestoreOutcome, type ServerAddressOutcome,
  type ServerAddressSearchCapableAdapter, type ServerAddressSearchFn, type ServerEstimateOutcome,
  type ServerSearchCapableAdapter, type ServerSearchFn, type ServerSearchOutcome, type SnapshotCapableAdapter,
  type SnapshotFn, type StoreCoverage, type StorePolicy, type TimelineCapableAdapter,
} from "./server-wire.js";

export abstract class EngineState {
  readonly store: MirrorStore;
  protected readonly adapter: EngineAdapter;
  protected readonly types: string[] | undefined;
  protected readonly syncLimit: number | undefined;
  protected readonly now: () => Date;
  protected readonly uuid: () => string;
  /** See {@link EngineOptions.locks}. */
  protected readonly locks: EngineLocks | null;
  /** This engine's lock name, set only once the lock is HELD — an entry stamped earlier could be adopted from a live tab. */
  protected ownerName: string | null = null;

  protected readonly overlays = new Map<string, MutationEffect[]>();
  protected overlayRev = 0;
  /** The row being read, held in "New for you" until it is left or answered — {@link holdOpenRow}. */
  protected openRow: string | null = null;
  /** The held row an act just took out of New — what {@link restoreOpenRow} may put back. */
  protected actedAwayRow: string | null = null;
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
  protected readonly optimisticSent = new Map<string, { header: string; expiresAtMs: number }>();
  /** See {@link sentFolderAsks}. */
  protected sentFolderAskCount = 0;
  protected readonly queue: PendingMutation[] = [];
  /**
   * See {@link OhmailEngine.abandoned} — a stable snapshot for `useSyncExternalStore`, keyed on
   * the store's own version rather than invalidated by hand.
   */
  protected abandonedCache: { v: number; out: AbandonedMutation[] } | null = null;
  /** See {@link OhmailEngine.queuedDiscards} — the previous snapshot, kept while it is still true. */
  protected queuedDiscardsCache: readonly QueuedChange[] = NO_QUEUED;
  /** See {@link OhmailEngine.queuedChanges}, kept the same way. */
  protected queuedChangesCache: readonly QueuedChange[] = NO_QUEUED;
  /** See {@link OhmailEngine.waitingSends}, kept the same way. */
  protected waitingSendsCache: readonly WaitingSend[] = NO_WAITING;
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
  protected readonly awaitingEcho = new Map<string, { epoch: number; m: EngineMutation; shadow: boolean }>();
  /**
   * CONFIRMED VERBS WHOSE ROWS THE MIRROR HAS NOT SHOWN YET — overlay id → the rows it masks
   * (`shadow.ts`). A successful drain is not proof: a door can answer /sync from a copy behind the
   * server that took the write (the Cloud-paired desktop's mirror, measured). The overlay stands
   * until the mirror agrees, a newer verb on one of its rows replaces it, or the drain bound passes.
   */
  protected readonly shadows = new Map<string, { keys: ShadowKey[]; epoch: number; drains: number }>();
  /** Confirmed decisions whose rules this copy does not hold yet, by overlay id ({@link keepDecision}). */
  protected readonly kept = new Map<string, KeptDecision>();
  /** The mirror alone, park fact resolved — what a shadow is compared against. */
  protected readonly storeTruth: EntityReader;
  /** {@link storeTruth}, and a page's row for a message the mirror has no record of. */
  protected readonly shadowTruth: EntityReader;
  /**
   * MUTATIONS THE SERVER QUEUED FOR ANOTHER INSTALL — kept until a CHANGE confirms them.
   *
   * Nothing in this client moves them: there is no retry (the request is stored server-side under
   * its Idempotency-Key and a second POST only re-reads the same 202), no overlay (the server's
   * own answer carries the row unmoved) and no drain that can settle one by being empty. A drain
   * carrying no news is not the organizer acting, and reading it as one is how a reader's Move
   * came to report "Moved" over mail nobody had moved.
   */
  protected readonly organizerQueue = new Map<string, {
    id: string; key: string; mutation: EngineMutation;
    queuedWith: { name: string | null }; requestId: string | null; requestIds: string[]; at: number;
  }>();
  /** When the waiting list was last asked for (engine clock), and whether that read was refused. */
  protected lastWaitingReadAt = Number.NEGATIVE_INFINITY;
  protected waitingRefused = false;
  /** The server's waiting list, last read — see {@link waitingOnOrganizer}. `null` until asked. */
  protected waitingServer: WaitingRequestWire[] | null = null;
  protected waitingAsk: Promise<void> | null = null;
  protected waitingAgain = false;
  protected waitingAsked = false;
  /** Count of drains whose page loop has BEGUN — the happens-before token {@link awaitingEcho} compares. */
  protected drainEpoch = 0;
  /** {@link OhmailEngine.restoreOutbox}'s latch. */
  protected outboxRestored = false;
  /** A load the store refused — see {@link OhmailEngine.outboxUnreadable}. */
  protected loadFailed = false;
  /**
   * Restored verbs whose target was not in the mirror at the restore — the desktop window's mirror
   * is empty until its first drain. Painted at a drain's settle once the rows are there, so a
   * delete queued before a relaunch does not show the message again while it waits.
   */
  protected readonly unpaintedRestored = new Set<string>();
  /**
   * TRUE once the store is known to hold what disk holds — `hydrate()` resolved, or a host called
   * `restoreOutbox()` after loading it itself. {@link restoreOutboxIfLoaded} reads this so the
   * drive cannot latch the restore over a store that has not been read.
   */
  protected storeLoaded = false;
  /** See {@link OUTBOX_REPLAY_DEADLINE_MS}; overridable only through the test seam. */
  protected readonly replayDeadlineMs: number;
  /** See {@link OUTBOX_HOLD_CEILING_MS} and {@link DRAIN_REQUEST_CEILING_MS}; overridable only through the seams. */
  protected readonly holdCeilingMs: number;
  protected readonly drainCeilingMs: number;
  /** The entry whose timed-out attempt armed {@link outboxHold}; set and cleared with it. */
  protected holdOwner: string | null = null;
  /** Lets {@link outboxHold} go before its owner settles: a send's ceiling, or a press on one. */
  protected holdRelease: (() => void) | null = null;
  /**
   * Each attempt on the wire, by entry id: when its request started, and what ends its wait as its
   * ceiling would ({@link endHold}). A send's end lets its barrier go and nothing else.
   */
  protected readonly endWait = new Map<string, { readonly since: number; readonly end: () => void }>();
  /**
   * THE GATE'S OWN STATE: THE ORDER BARRIER A TIMED-OUT DISPATCH LEAVES BEHIND: The still-in-flight dispatch, held
   * until it settles. While it stands, NO further outbox dispatch may start on ANY road, because the hung request may
   * yet commit and a verb dispatched behind it could land an older value after a newer one on the server. It clears
   * itself on settle, at the latest at the attempt's {@link OUTBOX_HOLD_CEILING_MS} (a person's Try again past
   * {@link OUTBOX_TRY_AGAIN_ENDS_HOLD_MS} ends it sooner, {@link endHold}); a send's lets go there while its request
   * runs on; a process death clears it the honest way — every still-owed verb is persisted and replays in
   * order next boot. It used to be called `replayHold` and to have a short-lived twin, `replayActive`, which armed
   * for the whole of each attempt so that a fresh verb WAITED rather than queued.
   */

  /**
   * The twin is gone: {@link outboxGate} is a promise chain, so joining it IS waiting out whatever is in flight, and
   * every dispatch on that chain is deadline-bounded — a waiter can no longer inherit a hung request's unboundedness,
   * which was the only reason the twin needed to exist separately. What is left is the one distinction that is real:
   * a bounded wait you JOIN, and a hold that may stand for most of a minute, which a person pressing Send must never be made
   * to sit through. The gate honours this before releasing a queued caller; `mutate` reads it synchronously first,
   * and queues the verb rather than joining at all.
   */
  protected outboxHold: Promise<void> | null = null;

  /** Does a timed-out dispatch's barrier stand, so new verbs wait in the queue? */
  outboxHeld(): boolean {
    return this.outboxHold !== null;
  }
  /**
   * Retries refused THIS SESSION whose durable marker could not be written — id to reason.
   *
   * Not a cache and not an optimisation: it is the only place the refusal exists when storage
   * would not take it. `abandoned()` merges it, so the control is disabled for the rest of the
   * session even though a reboot will offer it again — which is honest, because after a reboot
   * the store genuinely does not know.
   */
  protected readonly refusedLocally = new Map<string, string>();
  /**
   * Terminal outcomes this session could not WRITE — id to the record it wanted to store.
   *
   * The durable row is still live on disk, so a reboot replays the verb; this is what keeps it
   * visible and operable until then, rather than leaving it referenced by nothing.
   */
  protected readonly abandonedLocally = new Map<string, PersistedOutboxEntry>();
  /**
   * Answers that arrived AFTER their dispatch deadline, waiting for the next `flushPending`.
   *
   * A verb whose request outlived its deadline is owned by that in-flight attempt and is not on
   * the queue, so nothing else would ever produce a result for it — and the two families a
   * surface waits on (a send's settlement, a create's server id) exist nowhere else.
   */
  protected readonly lateResults = new Map<string, MutationResult>();
  /** See {@link keptAsNewDrafts}: newest last, bounded, replaced (never mutated) on each change. */
  protected keptAsNew: readonly KeptAsNewDraft[] = [];
  /** The create a kept edit became, by its key → the edit's key. */
  protected readonly keptCreates = new Map<string, string>();
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
  protected readonly inFlight = new Map<string, PendingMutation>();
  /**
   * THE READS FROM THEIR PRESS TO THEIR DISPATCH, the app's and a person's: waiting for their write or
   * their turn at the gate, they are in no queue and not on the wire, and a newer read or unread must
   * still reach them ({@link PendingMutation.readsTaken}).
   */
  protected readonly freshReads = new Set<PendingMutation>();

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
  protected abandonedRecordOf(id: string): PersistedOutboxEntry | null {
    return this.abandonedRows().find((r) => r.id === id)?.entry ?? null;
  }

  /**
   * THE ONE SOURCE OF ABANDONED RECORDS — the disk rows, plus the session-local fallbacks.
   *
   * Three readers used to build this list three ways: `abandoned()` merged the fallbacks,
   * `abandonedRecordOf` preferred disk, and the supersession scanned DISK ALONE. So a record whose
   * terminal write was refused was listed, retryable, and invisible to the rule that protects it:
   * a newer verb for the same target left it standing, and Try again then replayed the older
   * intent over the state the newer verb had just established, with both requests reporting
   * success. One reader, so a row cannot be visible to a surface and invisible to supersession.
   */
  protected abandonedRows(): Array<{ id: string; entry: PersistedOutboxEntry; durable: boolean }> {
    const out: Array<{ id: string; entry: PersistedOutboxEntry; durable: boolean }> = [];
    const onDisk = new Set<string>();
    for (const row of this.store.entries<unknown>(OUTBOX_ABANDONED_TYPE)) {
      if (!isPersistedOutboxEntry(row.entity)) continue;
      onDisk.add(row.id);
      out.push({ id: row.id, entry: row.entity, durable: true });
    }
    // A row that later reached disk wins over the memory copy.
    for (const [id, entry] of this.abandonedLocally) {
      if (onDisk.has(id)) continue;
      out.push({ id, entry, durable: false });
    }
    return out;
  }
  /** Bumped whenever {@link refusedLocally} changes, so the snapshot below cannot serve a stale row. */
  protected localRefusalRev = 0;
  /** {@link EngineOptions.outboxAutoReplay}, resolved once. */
  protected readonly autoReplayOn: boolean;
  /** {@link EngineOptions.outboxTransportIsUnreachable}, resolved once. */
  protected readonly transportIsUnreachable: boolean;
  /** {@link EngineOptions.onWithdrawUnsupported}, and the keys it was called for (bounded). */
  protected readonly withdrawUnsupported: (() => void) | null;
  protected readonly unsupportedSaidFor = new Set<string>();
  /** Session-monotonic outbox tiebreak; seeded past every restored entry's `n`. */
  protected outboxSeq = 0;

  /**
   * Idempotency-Keys WITHDRAWN in this session — read at the moment of sending. A durable mark
   * alone cannot stop a fresh verb waiting its turn at the gate, because that verb is in no
   * collection this call can reach; the key is. Cleared in {@link OhmailEngine.mutate}: a
   * fresh expression of intent under a reused key is not withdrawn.
   */
  protected readonly withdrawnKeys = new Set<string>();
  /** Fresh `draft_save` creates from their paint until their dispatch starts, by key. */
  protected readonly awaitingTurn = new Map<string, PendingMutation>();
  /**
   * SENDS WHOSE CANCEL THE SERVER HAS NOT ANSWERED, by entry id: off the queue (they are never sent)
   * and on disk marked withdrawn and owed. Every drive and every flush asks again, on the backoff.
   */
  protected readonly owedWithdraws = new Map<string, PendingMutation>();
  /** Ids an ask is out for, so a drive and a flush never ask about one send twice at once. */
  protected readonly askingWithdraw = new Set<string>();
  /** The server's last answer to a Cancel, by key — {@link OhmailEngine.withdrawAnswerOf}. Bounded. */
  protected readonly withdrawAnswers = new Map<string, WithdrawSendOutcome>();
  /** The shared disk's notice channel, once this engine listens to it — see {@link listenToDisk}. */
  protected notices: OutboxNotices | null = null;
  /** How the sends other windows dropped ended, by key, as their owners said it (bounded). */
  protected readonly foreignEndings = new Map<string, "confirmed" | "refused" | "withdrawn">();
  /** Releases this engine's owner lock — see {@link OhmailEngine.dispose}. */
  protected releaseOwnerLock: (() => void) | null = null;
  protected disposed = false;
  protected unlistenDisk: (() => void) | null = null;
  protected following: Promise<void> | null = null;
  protected followAgain = false;
  protected readonly listeners = new Set<() => void>();
  /** See {@link OhmailEngine.onMessagesRemoved} — told BEFORE the page is written. */
  protected readonly removalListeners = new Set<(ids: readonly string[]) => void>();
  protected readonly readerView: OverlayReader;
  /** {@link oneSourceReader} over the overlay — what {@link OhmailEngine.read} hands out. */
  protected readonly resolvedView: EntityReader;
  /** {@link resolvedView} with the page rows behind it — what {@link OhmailEngine.verbRead} hands out. */
  protected readonly verbView: EntityReader;
  /**
   * THE INSTANT INDEX AND THE MIRROR IT IS AN INDEX OF. `version` is reassigned as the index is
   * refreshed in place, so the pair stays one fact — see {@link OhmailEngine.searchIndex}.
   */
  protected searchCache: { version: number; index: SearchIndex } | null = null;
  /** The build in flight, with the token that abandons it. One at a time — see {@link OhmailEngine.startSearchBuild}. */
  protected searchBuild: { version: number; cancelled: boolean; done: Promise<void> } | null = null;
  protected syncing: Promise<void> | null = null;
  protected driveStartedAt = 0;
  /**
   * The held-release offer's freshness, kept beside its one door ({@link refreshHeldReleases}).
   * `armed`: a surface asked, so the offer is shown in this process. `stamp`: the settings stamp
   * the last ANSWER was asked under. `owed`: a re-bootstrap wiped that answer. `seq`: the newest
   * ask issued. `bell`: the settle's re-ask in flight. `arrivals`: senders of mail that landed at
   * the gate since the last settle; `rang`: settles that found held mail among them, and
   * `answered` the count the last answer was asked under.
   */
  protected heldRelease: {
    armed: boolean; stamp: string | null; owed: boolean; seq: number; bell: Promise<void> | null;
    arrivals: Set<string>; rang: number; answered: number;
  } = { armed: false, stamp: null, owed: false, seq: 0, bell: null, arrivals: new Set(), rang: 0, answered: 0 };
  /**
   * The store's waiting queue, beside its one door ({@link refreshScreenerWaiting}). `armed`: a
   * surface asked. `dirty`: a page since the last ask touched the gate, a rule, the settings or a
   * mailbox, so the settle asks again. `seq`: the newest ask, so an older answer never lands last.
   * `asking`: asks in the air. `caughtUpAt`: the {@link drainEpoch} at which an answer first stopped
   * saying the door's copy is behind, while the page still holds for it ({@link queueStaysBehind}).
   * `settled`: the newest ask has answered or been refused at least once ({@link screenerWaitingSettled}).
   */
  protected screenerWait: {
    armed: boolean; dirty: boolean; seq: number; asking: number; caughtUpAt: number | null; settled: boolean;
  } = { armed: false, dirty: false, seq: 0, asking: 0, caughtUpAt: null, settled: false };
  /**
   * The undecided-sender offer's freshness ({@link refreshUnscreened}). `armed`: a surface asked.
   * `owed`: a page changed what it counts (a rule's walk ended, a mailbox or the settings changed),
   * so the settle asks again. `ohboxDue`: Ohbox mail came or went, asked at most once per
   * {@link UNSCREENED_REASK_MS} from `askedAt` and kept until a settle makes it. `bell`: the ask in flight.
   */
  protected unscreenedAsk: {
    armed: boolean; owed: boolean; ohboxDue: boolean; askedAt: number | null; bell: Promise<void> | null;
  } = { armed: false, owed: false, ohboxDue: false, askedAt: null, bell: null };
  /** Representatives served on pages past the first, which the mirror never holds (capped). */
  protected readonly screenerPageReps = new Set<string>();
  /** Which index answered — see {@link OhmailEngine.searchIndexRevision}. */
  protected searchIndexRev = 0;
  /** The in-flight mirror read, so concurrent callers coalesce. See {@link OhmailEngine.hydrate}. */
  protected hydrating: Promise<void> | null = null;
  /** {@link EngineOptions.eagerBodies}, resolved once. */
  protected readonly eagerBodiesOn: boolean;
  /** The in-flight eager pass — single-flight; a kick during a pass queues exactly one more. */
  protected eagerRun: Promise<void> | null = null;
  protected eagerAgain = false;
  /** Bumped by {@link OhmailEngine.stopEagerBodies}; a running pass checks it between steps. */
  protected eagerGen = 0;
  /** In-flight body fetches by message id — see {@link OhmailEngine.hydrateBody}. */
  protected readonly bodyRequests = new Map<string, Promise<void>>();
  /** What each of those reads is, with the same lifetime — see {@link BodyAsk} and {@link hurryBody}. */
  protected readonly bodyAsks = new Map<string, BodyAsk>();
  /**
   * The messages a surface has most recently asked to render, oldest first, capped at
   * {@link RENDERED_PINS}. Read by {@link OhmailEngine.pinnedMessageIds}; written by
   * {@link OhmailEngine.hydrateBody}, which is the call every reading surface already makes.
   */
  protected readonly renderedIds = new Set<string>();

  /**
   * THE IDS WHOSE BODIES THIS SESSION HOLDS — the set {@link BODY_CACHE_MAX} bounds and
   * {@link OhmailEngine.trimBodyCache} evicts from. A membership set and deliberately not an
   * order: the order that decides an eviction is the MESSAGE DATE, read from the mirror at the
   * trim. Separate from `renderedIds`, which is the 64-deep hold of what a surface is showing.
   */
  protected readonly heldBodies = new Set<string>();

  /**
   * One trim at a time. Body batches run concurrently (four slots), so two `putBodies` can reach
   * the trim together, read the same `held` list and both choose the same victims — the second
   * commit would then delete rows the first already took and over-evict by its whole batch.
   */
  protected trimmingBodies = false;
  /**
   * In-flight body fetches, and the ones waiting for a slot. See {@link bodySlot}.
   *
   * A waiting entry carries the message ids it is FOR, because "urgent jumps the queue" has to
   * hold for a message that is already queued: an open arriving after a background pass has
   * registered that id finds the in-flight promise and would otherwise wait behind the backlog.
   * See {@link promoteBodyRequest}.
   */
  protected bodyActive = 0;
  protected readonly bodyQueue: Array<{ ids: readonly string[]; start: (promoted?: boolean) => void }> = [];
  /**
   * WHEN THIS ENGINE STARTED, epoch ms — the line a `failed` body record is compared against.
   *
   * See {@link MessageBodyRecord.failedAt}: "never re-ask a server that refused" is a rule about
   * one session, and these records are persisted, so without a boot stamp it was a rule about for
   * ever. Read from `this.now` rather than `Date.now` so a test with a fixed clock gets the
   * in-session behaviour (`failedAt === bootedAt` is not "before"), which is the arm that must not
   * change.
   */
  protected readonly bootedAt: number;
  /**
   * The ids whose stale `failed` record this session has ALREADY re-asked once.
   *
   * In memory, never persisted, and it is what makes the heal terminate as a property of the
   * ENGINE rather than of the mirror. `failBody`'s write can itself be refused — a full quota, a
   * private window — which would leave the old stamp-less record in place and put the re-ask
   * straight back on the table for the next render. One entry here closes that, the same way
   * `fetchBodyInto` normalising `html` closes the re-read loop.
   */
  protected readonly bodyHealed = new Set<string>();
  /** The batch body read, or `null` when this adapter has none — see {@link FetchBodiesCapableAdapter}. */
  protected readonly fetchBodiesFn: FetchBodiesFn | null;
  /** See {@link placementStamp}. */
  protected placementBodyVersion = 0;
  /** The archive transport, or `null` when this client has no server behind it. */
  protected readonly serverSearchFn: ServerSearchFn | null;
  /** The archive's ADDRESS transport, or `null` — resolved by the same rule, independently. */
  protected readonly serverAddressSearchFn: ServerAddressSearchFn | null;
  /** `GET /sync/snapshot`, or `null` when this adapter has no such route — see {@link SnapshotCapableAdapter}. */
  protected readonly snapshotFn: SnapshotFn | null;
  /**
   * Latched TRUE once the snapshot route has proven unusable on its FIRST page — see
   * {@link OhmailEngine.runSnapshot}. It bounds the cost of a client that ships ahead of the
   * server to exactly one wasted request per engine, rather than one per drain forever.
   */
  protected snapshotUnavailable = false;
  /** Consecutive snapshots whose own cursor the door refused on the next pull; 0 after an accepted pull. */
  protected snapshotCursorRefusals = 0;
  /** Until this instant a 410 is surfaced, the mirror kept, and no re-snapshot is taken. */
  protected resnapshotHeldUntilMs = 0;
  /**
   * HOW MANY MESSAGE ROWS THIS READER HAS TAKEN IN — see {@link OhmailEngine.receivedMessages}.
   * Counted where the rows ARRIVE, so eviction cannot move it, and written to {@link
   * RECEIVED_MESSAGES_META} after every page that moves it.
   */
  protected receivedMessageRows = 0;
  /** What {@link RECEIVED_MESSAGES_META} already holds, so a page that moved nothing writes nothing. */
  protected persistedMessageRows = 0;
  /** {@link OhmailEngine.restoreReceivedCount}'s latch: memory owns the count from then on. */
  protected receivedRestored = false;
  /** How much of the mailbox to keep. Resolved once; `full` when the host said nothing. */
  protected readonly storePolicy: StorePolicy;
  /** Did the last COMPLETED drain settle inside one page? See {@link prefetchRecentBodies}. */
  protected caughtUpInOnePage = true;
  /**
   * Did THIS drain's policy re-hydration fail to reach the end of the tail? Reset per drain. The
   * generation stamp is what stops the walk running again, so a walk that did not finish must not
   * be stamped — see {@link OhmailEngine.rehydrateForPolicy}.
   */
  protected policyWalkFailed = false;
  /**
   * THE ACCOUNT'S SCREENING CUTLINE, as the client was told it — see {@link OhmailEngine.setCutline}.
   * `null` until a host says otherwise, which is every embedder that has nothing to say and is
   * today's window exactly.
   */
  protected cutlineDays: number | null = null;
  protected cutlineAllTime = false;
  /** This engine's last {@link OhmailEngine.setSentFolders} statement, as `[id, path]` pairs sorted by id. */
  protected sentFoldersStated = "[]";
  /** A mailbox read (or a removal receipt) has stated them in this engine: the stored copy never overrides it. */
  protected sentFoldersLive = false;
  /**
   * WHAT THE WINDOWED PRUNE LAST RAN OVER — the stamp of everything but bodies, and the cutline
   * generation it ran under. The pass reads the whole mirror and SORTS it; on a settled client
   * that is a mailbox-sized derivation once per poll for the answer "nothing to evict". `-1` has
   * no stamp equal to it, so a client that has never pruned always runs.
   */
  protected prunedAtStamp = -1;
  protected prunedAtCutline = -1;
  /**
   * The cutline's own generation, bumped by {@link OhmailEngine.setCutline}. The age term is the
   * one input to the prune that is NOT a record write, so a new answer has to be able to
   * invalidate the stamp above on its own.
   */
  protected cutlineGen = 0;
  /**
   * The store version the last COMPLETED eager pass ranked at. The pass sorts the whole mirror to
   * pick the newest window; between two ticks that changed nothing it picks the same window, asks
   * the same admission and is refused by it, every time.
   */
  protected eagerRankedAt = -1;
  /** See {@link STALE_RESUME_MS}; the option exists for tests. */
  protected readonly staleResumeMs: number;
  /** In-flight archive passes by query key — see {@link OhmailEngine.searchServer}. */
  protected readonly serverSearches = new Map<string, Promise<ServerSearchOutcome | ServerEstimateOutcome>>();
  /** In-flight archive ADDRESS passes, keyed as `searchServer`'s are — see that method. */
  protected readonly serverAddressSearches = new Map<string, Promise<ServerAddressOutcome>>();
  /** `GET /messages`, or `null` when this adapter has none — see {@link ListMessagesCapableAdapter}. */
  protected readonly listOlderFn: ListOlderFn | null;
  /** The Trash page transport, bound once in the constructor. See {@link ListTrashFn}. */
  protected readonly listTrashFn: ListTrashFn | null;
  /** The restore verb's transport, bound once in the constructor. See {@link RestoreFromTrashFn}. */
  protected readonly restoreFromTrashFn: RestoreFromTrashFn | null;
  /** In-flight Trash pages by cursor+limit — single-flight, {@link OhmailEngine.listOlder}'s rule. */
  protected readonly trashPages = new Map<string, Promise<ListTrashOutcome>>();
  /** In-flight restores by message id, so a double press is one request. */
  protected readonly restoreCalls = new Map<string, Promise<RestoreOutcome>>();
  /** In-flight out-of-window pages by view+cursor — see {@link OhmailEngine.listOlder}. */
  protected readonly olderPages = new Map<string, Promise<ListOlderOutcome>>();
  /** `GET /messages/timeline`, or `null` when this adapter has none. */
  protected readonly timelineFn: StoreTimelineFn | null;
  /** `GET /messages/:id`, or `null` when this adapter has none — see {@link fetchMessage}. */
  protected readonly messageByIdFn: MessageByIdFn | null;
  protected readonly messageCalls = new Map<string, Promise<FetchMessageOutcome>>();
  /** The store's History and Search pages — the one bound on page rows in memory ({@link HISTORY_PAGE_CACHE_ROWS}). */
  protected readonly storePages = new StorePageCache(HISTORY_PAGE_CACHE_ROWS);
  /** In-flight store pages by key, and the one in-flight timeline read. */
  protected readonly storePageCalls = new Map<string, Promise<StorePageOutcome>>();
  protected timelineCall: Promise<StoreTimelineOutcome> | null = null;
  /** Moves with every applied page that changes the store's list — {@link storeChanges}. */
  protected storeChangesRev = 0;
  /** Drains that reached the settle — {@link drainsCompleted}. */
  protected drainsDone = 0;
  /** The {@link drainEpoch} of the last drain that reached the settle. */
  protected settledEpoch = 0;
  /** The store's last timeline answer and whether this mirror held all of it then — {@link storeCoverage}. */
  protected coverageRead: { timeline: StoreTimeline; wasWhole: boolean } | null = null;
  /** The last ask found no timeline (`unavailable`, or a refusal): the store cannot say. */
  protected coverageUnknown = false;
  protected coverageMemo: { stamp: number; read: object | null; value: StoreCoverage } | null = null;

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
  protected readonly attachmentLists = new Map<string, AttachmentsOutcome>();
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
  protected readonly sentAttachmentSeeds = new Map<string, {
    live: boolean;
    expiresAtMs: number;
    forwardOf?: string;
    /** The parts the forward named (`forwardParts`); absent, every part the server streams. */
    forwardParts?: readonly string[];
    composeItems: AttachmentItem[];
  }>();
  /** In-flight metadata reads by message id — single-flight, see {@link OhmailEngine.loadAttachments}. */
  protected readonly attachmentListRequests = new Map<string, Promise<AttachmentsOutcome>>();
  /** In-flight byte fetches by `messageId:attachmentId` — see {@link OhmailEngine.openAttachment}. */
  protected readonly attachmentRequests = new Map<string, Promise<void>>();
  /** The flights above that are desktop saves ({@link OhmailEngine.deliverAttachment}), not fetches. */
  protected readonly attachmentDeliveries = new Set<string>();
  /**
   * Every `blob:` URL this engine has minted and not yet revoked, owned by the message it was
   * minted for. The debt is recorded at the MINT, not in the attachment entry a release is
   * allowed to delete first — see {@link ObjectUrlLedger}.
   */
  protected readonly objectUrls = new ObjectUrlLedger();
  /**
   * `contentId → URL` per message — the embedded images ready for the reader's frame: the part's
   * own object URL under `inlineImageUrls: "object"` (a value lives exactly as long as its URL,
   * {@link revokeUrl}), else a `data:` URI. Dropped with the rest of the message's byte state by
   * {@link OhmailEngine.releaseAttachments}. The held map is REPLACED on every change, never
   * mutated, so a React memo keyed on its identity re-renders exactly when an image arrives.
   */
  protected readonly inlineImages = new Map<string, ReadonlyMap<string, string>>();
  /** {@link EngineOptions.inlineImageUrls}, resolved once: anything but `"object"` is `"data"`. */
  protected readonly inlineImageUrls: "object" | "data";
  /** In-flight inline-image passes by message id — single-flight, see {@link OhmailEngine.loadInlineImages}. */
  protected readonly inlineImageRequests = new Map<string, Promise<void>>();
  /**
   * WHAT AN OPEN LETTER'S DOCUMENT ASKED TO DRAW — `loadInlineImages`' last list — with the wire
   * re-asks each part has spent and whether a pass is owed after the one in flight. It lives with
   * the reader: the release that drops the byte state drops it, {@link OhmailEngine.reaskAttachments}
   * keeps it. It is what lets a list or a part that answers LATER draw the picture in place.
   */
  protected readonly inlineImageAsks = new Map<string, { cids: readonly string[]; reasks: Map<string, number>; again: boolean }>();
  /**
   * `messageId:attachmentId` of the part a pass is fetching now. Its own arrival owes no second
   * pass: one would spend the per-pass budget again on the parts past {@link INLINE_IMAGE_MAX_PARTS}.
   */
  protected readonly inlinePassParts = new Set<string>();
  /** Every byte ask this engine makes, in line per mailbox ({@link PartLane}). */
  protected readonly partLane = new PartLane();
  /** A letter's due re-ask of its embedded pictures ({@link PART_REASK_DELAYS_MS}): when, and which parts. */
  protected readonly partReasksDue = new Map<string, { at: number; parts: string[] }>();
  /**
   * `attachmentId → decoded ics text` per message — what an event-preview surface parses and
   * renders. Text, not a parsed structure: the engine holds bytes and their decodings, and the
   * ics grammar belongs to `@trafficflow/core/ics` at the render site. Replaced on every fill,
   * never mutated, and dropped with the rest of the message's byte state by
   * {@link OhmailEngine.releaseAttachments} — the same lifecycle as {@link inlineImages}.
   */
  protected readonly calendarTexts = new Map<string, ReadonlyMap<string, string>>();
  /** In-flight calendar passes by message id — single-flight, see {@link OhmailEngine.loadCalendarTexts}. */
  protected readonly calendarTextRequests = new Map<string, Promise<void>>();

  constructor(opts: EngineOptions) {
    this.adapter = opts.adapter;
    this.inlineImageUrls = opts.inlineImageUrls === "object" ? "object" : "data";
    // The adapter's own capability is the shipped path; the option is the override. Resolved
    // ONCE, here, so `serverSearchAvailable()` cannot answer differently from what
    // `searchServer` will do a moment later.
    this.searchWarms = opts.warmSearch === true;
    this.searchSupersede = opts.searchSupersede === true;
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
    this.timelineFn = (opts.adapter as TimelineCapableAdapter).timeline?.bind(opts.adapter) ?? null;
    this.messageByIdFn = (opts.adapter as MessageByIdCapableAdapter).getMessage?.bind(opts.adapter) ?? null;
    // The Trash pair, bound by the SAME rule and INDEPENDENTLY of each other and of the list
    // above: an adapter wrapper forwards structural capabilities one at a time, so deriving
    // either from another would make a control call a method that is not there.
    this.listTrashFn = (opts.adapter as ListTrashCapableAdapter).listTrash?.bind(opts.adapter) ?? null;
    this.restoreFromTrashFn =
      (opts.adapter as RestoreFromTrashCapableAdapter).restoreFromTrash?.bind(opts.adapter) ?? null;
    // And a fourth time, same rule: bound ONCE here so `hydrateThread` cannot decide it has a
    // batch route and then call something else.
    this.fetchBodiesFn = (opts.adapter as FetchBodiesCapableAdapter).fetchBodies?.bind(opts.adapter) ?? null;
    // NO UNLIMITED DEFAULT. See {@link DEFAULT_STORE_POLICY}: a host that configures nothing gets
    // a window, and `{ mode: "full" }` is a thing a host says rather than one it gets by silence.
    this.storePolicy = opts.storePolicy ?? DEFAULT_STORE_POLICY;
    // A ceiling under the floor is a misconfiguration, not a narrower window: the eviction loop
    // starts at `minRows`, so it would read as "the floor won" and the window it names would never
    // be the window it keeps. Refused here rather than clamped — a silent reorder is the shape
    // that makes a wrong constant survive a release.
    if (this.storePolicy.mode === "windowed"
        && this.storePolicy.maxRows !== undefined
        && this.storePolicy.maxRows < this.storePolicy.minRows) {
      throw new Error(
        `storePolicy.maxRows (${this.storePolicy.maxRows}) is below minRows (${this.storePolicy.minRows})`,
      );
    }
    this.eagerBodiesOn = opts.eagerBodies === true;
    this.store = opts.store ?? new MemoryMirrorStore();
    this.types = opts.types;
    this.syncLimit = opts.syncLimit;
    this.staleResumeMs = opts.staleResumeMs ?? STALE_RESUME_MS;
    this.replayDeadlineMs = opts.outboxReplayDeadlineMs ?? OUTBOX_REPLAY_DEADLINE_MS;
    const positive = (ms: number | undefined, fallback: number): number =>
      typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : fallback;
    // Never below the deadline it follows: a send's ceiling lets go of a hold, which exists only from there.
    this.holdCeilingMs = Math.max(positive(opts.outboxHoldCeilingMs, OUTBOX_HOLD_CEILING_MS), this.replayDeadlineMs);
    this.drainCeilingMs = positive(opts.drainRequestCeilingMs, DRAIN_REQUEST_CEILING_MS);
    this.autoReplayOn = opts.outboxAutoReplay !== false;
    this.transportIsUnreachable = opts.outboxTransportIsUnreachable === true;
    this.withdrawUnsupported = opts.onWithdrawUnsupported ?? null;
    this.now = opts.now ?? (() => new Date());
    this.bootedAt = this.now().getTime();
    this.uuid = opts.uuid ?? (() => crypto.randomUUID());
    this.locks = opts.locks === undefined ? defaultEngineLocks() : opts.locks;
    this.holdOwnerLock();
    this.listenToDisk();
    this.readerView = new OverlayReader(this.store, this.overlays, () => this.overlayRev, this.kept);
    this.resolvedView = oneSourceReader(this.readerView);
    this.storeTruth = oneSourceReader(this.store);
    this.verbView = new PageFallbackReader(this.resolvedView, this.readerView, this.store, this.storePages);
    this.shadowTruth = new PageFallbackReader(this.storeTruth, null, this.store, this.storePages);
  }

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
  protected static ownerSettled(m: EngineMutation): boolean {
    return m.kind === "mail_send" || (m.kind === "draft_save" && m.draftId === null);
  }

  /** The last {@link MirrorFreshness} handed out — identity-stable while its value stands. */
  protected freshnessCache: MirrorFreshness = { state: "unknown", asOf: null };

  /** What this turn has filed out of the Ohbox, and the Resurfaced rows of the letters that carried their pin. */
  protected filingTurn: { filed: Set<string>; rows: Set<string> } | null = null;

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
  protected outboxChain: Promise<unknown> = Promise.resolve();

  /**
   * True while a gated body is running. NOT a re-entrancy token, and it must not be used as one: it stays true while
   * the holder is suspended at an await, so a genuinely concurrent caller arriving in that window would read it as "I
   * am nested" and run beside the holder — which is the single-flight defeated, silently, in exactly the concurrent
   * case it exists for. It was written that way for one run and three of this file's own serialization guards caught
   * it. Its one job is to let {@link replayOutbox} recognise that a drive was reached from INSIDE a dispatch, where
   * the replay must be skipped rather than queued behind its own holder.
   */
  protected inOutboxGate = false;

  /**
   * ONE DOOR PER ID. Two presses — a double tap, two surfaces listing the same record, a retry
   * armed while one is open — both read the record before either had moved it, and both
   * dispatched: for a draft create, whose route ignores the idempotency key, that is a second row
   * on the server. The second press JOINS the first and gets its answer.
   */
  protected readonly retrying = new Map<string, Promise<MutationResult>>();

  /**
   * REPLACEMENTS WHOSE WRITE HAS NOT DECIDED YET, by entry id — the confirm phase of
   * {@link PendingMutation.supersededBy}. Opened before a verb marks anything on the wire, settled
   * once its marks are final (kept, or put back by {@link undoSupersede}).
   */
  protected readonly replacementWrites = new Map<string, Promise<void>>();

  /**
   * The engine's own durable-write lane for the outbox replacement transaction — see
   * {@link commitReplacement}. NOT the store's (`serializeWrite`), which orders the transactions
   * but not the READS that decide what goes in them, which is where the lost update lived.
   */
  protected outboxWriteLane: Promise<unknown> = Promise.resolve();

  /**
   * CONFIRMATIONS A NEWER PRESS UNDER THE SAME KEY WILL SPEAK FOR, by that press's entry id. Memory
   * only: a kill loses it, and the newer press then says only its own sentence (a gap row).
   */
  protected readonly silencedConfirms = new Map<string, { result: MutationResult; mutation: EngineMutation }>();

  /**
   * THE ROW EACH RECENTLY CONFIRMED SEND MADE, by key. A press resumed under a key whose send
   * confirmed between the press and its dispatch has nothing standing to carry the row from, and a
   * create under that key with newer words is the middleware's `idempotency_replay`: the press would
   * end refused, unsaid. Bounded; the oldest goes first.
   */
  protected readonly confirmedRows = new Map<string, CreatedDraftRow>();

  /** Late answers a flush has claimed and not yet handed over — see {@link flushPending}. */
  protected readonly lateClaimed = new Set<string>();

  /**
   * Reconciles a batch deferred, drained after the lane is released. A field rather than a return
   * value because `flushPendingInner` already answers one result per entry, and a second channel
   * through that signature would be a shape every future caller has to remember to unpack.
   */
  protected readonly owedReconciles: Array<"await" | "background"> = [];

  /** When the last search left for the store, `performance.now()`; see {@link warmSearch}. */
  protected lastSearchSentAt = Number.NEGATIVE_INFINITY;
  /** {@link EngineOptions.warmSearch}. */
  protected readonly searchWarms: boolean;
  /** {@link EngineOptions.searchSupersede}. */
  protected readonly searchSupersede: boolean;

  protected readonly createdDrafts = new Map<string, { id: string; revision: string | null }>();

  /** The staged previews this window holds, oldest first ({@link STAGED_PREVIEWS_KEPT}). */
  protected stagedPreviews: Array<{ messageId: string; attachmentId: string; url: string }> = [];

  /** Insertion-ordered, so the oldest kept refusal is the one evicted. */
  protected readonly keptListFailures = new Set<string>();

  // Written in a later file of the engine; named here because this one calls them.
  protected abstract holdOwnerLock(): void;
  protected abstract listenToDisk(): void;
}
