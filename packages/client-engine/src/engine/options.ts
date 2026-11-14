import type { EngineAdapter } from "../adapters/adapter.js";
import { UNJUDGED_WRITE_CODES, UPDATE_ANSWER_CODES } from "../adapters/refusal-shape.js";
import type { MirrorStore } from "../store.js";
import { MutationRejectedError } from "../types.js";
import { BODIES_IDS_MAX, type ServerAddressSearchFn, type ServerSearchFn, type StorePolicy } from "./server-wire.js";

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
 * WHICH RETENTION POLICY THIS MIRROR WAS BUILT UNDER. A windowed mirror is a record of what one
 * policy chose to keep, and a policy that later keeps MORE cannot un-delete what the old one
 * dropped: the pin stops the next eviction and resurrects nothing. A browser mirror persists
 * across sessions, so it carries that loss for ever; the desktop's is rebuilt in memory every
 * launch and never does.
 *
 * So the generation is written down, and a mirror whose stamp is behind the running one is owed
 * ONE bounded re-hydration — see {@link OhmailEngine.rehydrateForPolicy}. ABSENT means a mirror
 * older than the stamp, which is exactly the set that reported the symptom.
 */
export const STORE_POLICY_GENERATION_META = "storePolicyGeneration";

/**
 * Generation 1: TAGGED MAIL IS PINNED. Bump this only when a policy change makes the mirror keep
 * mail an older one evicted, and only alongside a re-hydration that can fetch that mail back —
 * a bump on its own is a wasted walk on every mirror in the field.
 */
export const STORE_POLICY_GENERATION = 1;

/**
 * A WINDOW A MAILBOX REMOVAL LEFT SHORT. A windowed mirror holds the newest rows of EVERY mailbox,
 * so a second mailbox's newer mail displaced the first's older rows; its receipt takes that mail
 * and nothing brings the displaced rows back — no delta names them, and the waiting count stood
 * below where it was before the mailbox was added. Set when a receipt is news to this mirror,
 * cleared by {@link OhmailEngine.refillWindow}; durable, so a reload in between still owes it.
 */
export const WINDOW_REFILL_OWED_META = "windowRefillOwed";

/**
 * HOW MUCH MAIL THIS READER HAS TAKEN IN, WRITTEN DOWN — the durable half of {@link
 * OhmailEngine.receivedMessages}. The count is a fact about the mirror and the door that fills it
 * is a process: a reloaded tab used to start it again, so the import's progress fell back to the
 * mirror's row count, which on a windowed mirror is the window. Written in the same store the
 * pages advance the cursor in, read back at boot — so a reload, and a second tab over one mirror,
 * start where the import stands rather than at what they can see.
 */
export const RECEIVED_MESSAGES_META = "receivedMessages";

/**
 * EACH MAILBOX'S RECORDED SENT FOLDER, KEPT WITH THE MIRROR: {@link OhmailEngine.setSentFolders}'s
 * statement as `[mailboxId, path]` pairs, read back by {@link OhmailEngine.hydrate} so the first
 * frame of a start knows 'Envoyés' before `GET /mailboxes` answers. A wipe of the mirror takes it.
 */
export const SENT_FOLDERS_META = "sentFolders";

/**
 * THE FRESHNESS CONTRACT'S THREE STATES, and the value a surface renders — re-exported from
 * `@trafficflow/core/drain-policy`, where the derivation that produces them lives beside them.
 *
 * `MirrorFreshness.asOf` is {@link LAST_DRAIN_AT_META} verbatim: the engine-clock instant of the
 * last COMPLETED drain, or `null` exactly when `state` is `"unknown"`. Surfaces format it; they
 * never parse meta themselves.
 */
export type { FreshnessState, MirrorFreshness } from "@trafficflow/core/drain-policy";

/**
 * The Web Locks surface an engine asks about outbox owners — `navigator.locks`, injected so a test
 * can model tabs closing. `null`: this engine stamps no owner and adopts nothing.
 */
export interface EngineLocks {
  request(name: string, options: { mode: "exclusive" }, callback: (lock: unknown) => Promise<unknown>): Promise<unknown>;
  query(): Promise<{ held?: ReadonlyArray<{ name?: string }> }>;
}

/** The browser's Web Locks, where it has them; `null` elsewhere (a webview without them, node). */
function defaultEngineLocks(): EngineLocks | null {
  const locks = (globalThis as { navigator?: { locks?: EngineLocks } }).navigator?.locks;
  return locks && typeof locks.request === "function" && typeof locks.query === "function" ? locks : null;
}

export interface EngineOptions {
  adapter: EngineAdapter;
  /**
   * The first key of a search warms the way to the store ({@link OhmailEngine.warmSearch}): the
   * desktop window, whose relay to a paired account drops an idle connection after 4 s. Omitted:
   * off (a browser keeps its connection for minutes).
   */
  warmSearch?: boolean;
  /**
   * Each search names its walker and question (`ServerSearchOpts.lane`), so the desktop's engine
   * can drop an older question's queued count when the question changes. Omitted: off, and the
   * request is what it always was (the web, the phone, Cloud).
   */
  searchSupersede?: boolean;
  /**
   * THE OUTBOX'S OWNERSHIP between tabs over one shared mirror — see {@link OhmailEngine.adoptOrphanedOutbox}. Omitted:
   * the browser's `navigator.locks`. `null`: no ownership, today's shape, and a store that no other engine shares
   * (memory, the phone's database) never uses it either way.
   */
  locks?: EngineLocks | null;
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
  /** Absent ⇒ {@link DEFAULT_STORE_POLICY}, a window. `{ mode: "full" }` is said, never assumed. */
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
  /** Override {@link OUTBOX_HOLD_CEILING_MS}: a test seam like the one above, a positive number, never below it. */
  outboxHoldCeilingMs?: number;
  /** Override {@link DRAIN_REQUEST_CEILING_MS}: a test seam, a positive number only. */
  drainRequestCeilingMs?: number;
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
  /**
   * A DROPPED WIRE IS THE SERVER OUT OF REACH. `true` where nothing stands between this page and
   * its server but the transport — the page a paired device opens from a desktop host — so a
   * `network` or `timeout` refusal is bounded by {@link OUTBOX_UNREACHABLE_CEILING_MS} exactly as
   * `offline_read_only` is. Absent, only `offline_read_only` is bounded: a laptop off the network
   * keeps its verbs queued at any age.
   */
  outboxTransportIsUnreachable?: boolean;
  /**
   * A SERVER WITHOUT THE WITHDRAW ROUTE answered a Cancel (`send_withdraw_unsupported`): called once
   * per key, on every road a Cancel is asked by, so a host can log it. Content-free.
   */
  onWithdrawUnsupported?: () => void;
  /**
   * WHAT AN EMBEDDED PICTURE IS DRAWN FROM ({@link OhmailEngine.inlineImagesOf}). `"object"`: the
   * part's own object URL, which the mail frame loads by reference — a browser door, whose frame
   * admits `blob:`. `"data"`, the default: the bytes as a `data:` URI, for the phone's WebView,
   * which cannot read a URL minted in the app's runtime. Said by the door, never detected: a
   * detected `createObjectURL` reads absent in a test and present live.
   */
  inlineImageUrls?: "object" | "data";
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
 * HOW LONG ONE WRITE MAY HOLD THE OUTBOX. A dispatch past {@link OUTBOX_REPLAY_DEADLINE_MS} becomes
 * the order barrier ({@link OhmailEngine.outboxHold}), and it stood for as long as its request did:
 * on a connection that died silently that was until a reload — every later change only queued, the
 * replay skipped, Try again sent nothing. Past this, counted from the request's start, the attempt
 * ends as a retryable `timeout` and goes back on the queue under its own key, first in line. Its
 * request is aborted as it ends: a transport still holding it (a renewal that outlasted it) sends
 * nothing more of it, beside a newer change or after a Discard. The
 * server's own limit is 60 s (`maxDuration`), so a request unanswered here is not being worked on;
 * every write route honours the key, and the replay is what a reload already did. A `timeout`
 * spends none of the give-up ceiling.
 *
 * A SEND IS NOT ENDED HERE, only its barrier goes. Its request carries its files (inline, or staged
 * to storage first), and on a slow uplink their upload alone outlasts this before the server reads
 * a byte. The cut request was not stopped: it delivered while the replay uploaded everything again,
 * cut in turn, or refused as a duplicate of a stored file and said "not sent". So the send's own
 * request stays the one owner of its entry until it settles, as before this ceiling existed.
 */
export const OUTBOX_HOLD_CEILING_MS = 75_000;

/**
 * HOW OLD A HUNG WRITE MUST BE BEFORE A PERSON'S TRY AGAIN MAY END ITS WAIT: the server's own limit
 * (`maxDuration`, 60 s), counted from the request's start. Younger, the server may still be working
 * on it, and a newer change sent beside it could land first and be overwritten by it (a move, a read
 * state, a draft's words). The press then waits its turn behind the barrier, which
 * {@link OUTBOX_HOLD_CEILING_MS} bounds.
 */
export const OUTBOX_TRY_AGAIN_ENDS_HOLD_MS = 60_000;

/**
 * NO DRAIN PAGE IS AWAITED PAST THIS, WHATEVER THE DOOR. The drive holds the single-flight while it
 * waits, so one page a dead connection never answered stopped every later drain and replay. The
 * doors bound their own reads (the browser's `SYNC_ANSWER_TIMEOUT_MS` and `SYNC_BODY_TIMEOUT_MS`,
 * the desktop bridge's request deadline); this is the belt for one that does not, set above them so
 * it fires only there. It races and gives up; it cannot abort a request it did not open.
 */
export const DRAIN_REQUEST_CEILING_MS = 120_000;

/** What a request past one of the two ceilings above ends as: retryable, and never the server's word. */
function noAnswerWithin(ms: number): MutationRejectedError {
  return new MutationRejectedError(`no answer within ${ms} ms`, { code: "timeout", retryable: true });
}

/** A write's own controller where the platform has one; without it the write goes out unsignalled. */
function abortControllerOrNull(): AbortController | null {
  const Ctor = (globalThis as { AbortController?: typeof AbortController }).AbortController;
  return Ctor ? new Ctor() : null;
}

/**
 * How long without a search before the first key of the next one warms the way to the store
 * ({@link OhmailEngine.warmSearch}): under Node's 4 s keep-alive, so a connection that is still
 * open is never warmed twice.
 */
export const SEARCH_WARM_IDLE_MS = 3_500;

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
  // The desktop sidecar's two answers nobody judged a write with, from ONE list: offline
  // (`cloud-auth.ts#offlineResponse`, 503, no `Retry-After`) and no session to send it in
  // (`409 not_signed_in`). Counting either would abandon a person's work for an outage or a
  // sign-out, which is the loss the `network` carve-out exists to prevent.
  ...UNJUDGED_WRITE_CODES,
  // "This app is too old for this server" and "the server is being updated": answers about the app
  // and the server, never about the verb. It waits for the update, however long that takes.
  ...UPDATE_ANSWER_CODES,
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
 * HOW LONG A VERB MAY WAIT ON AN UNREACHABLE SERVER BEFORE A PERSON IS SHOWN IT. `offline_read_only`
 * spends none of the ceiling above, because the verb is fine and the server is not there; without
 * a bound a change made on a desktop whose hosted account stays out of reach waited for ever with
 * nothing on screen saying so. Past a day it moves to the unsaved-changes list, where Try again
 * replays it under its original key and Discard drops it. Measured from when the verb was made.
 */
export const OUTBOX_UNREACHABLE_CEILING_MS = 24 * 60 * 60 * 1000;

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
 * HOW LONG A REQUEST WAITS BEFORE THE SURFACE SAYS SO OUT LOUD.
 *
 * The install that organizes the mailbox applies a recorded request on its next pass — "within a
 * minute, longer if that machine is asleep" is what the product already tells people. Past this
 * the wait deserves its own sentence ("Still waiting for the organizer"), and the request STAYS
 * PENDING: the bound changes what is SAID, never what is believed, because there is no evidence
 * either way and inventing some is the defect this whole path exists to end.
 */
export const ORGANIZER_REQUEST_SLOW_MS = 5 * 60_000;

/**
 * THE FLOOR BETWEEN TWO READS OF THE WAITING LIST from {@link OhmailEngine.pollWaitingOnOrganizer}.
 * The organizer's ack writes no change, so on a quiet mailbox no sync page would ever ask; the
 * surface's own cadence polls, and this bounds how often a poll reads. The engine owns no timer.
 */
export const ORGANIZER_REQUESTS_REREAD_MS = 30_000;

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
/**
 * HOW MANY BACKLOG PAGES SHARE ONE PUBLISH while a drain is catching up.
 *
 * A publish re-derives the whole mirror and re-renders, and during a first import that is the
 * renderer's whole cost: the same shell costs 660 MB mounted after the import and 950 MB
 * rendering through it a page at a time. Not the row ceiling, not the eager pass, not cadence.
 *
 * Eight is the largest step that still reads as mail arriving rather than a screen that jumps;
 * a catch-up ending mid-group publishes at the settle, so no row waits.
 */
export const BACKLOG_PUBLISH_PAGES = 8;

/**
 * HOW LONG A REFUSED SNAPSHOT CURSOR HOLDS OFF THE NEXT RE-SNAPSHOT. A door that refuses the
 * cursor its own snapshot just issued will refuse the next one too, and each attempt is a wipe
 * and the whole window again: the Windows rig paid that on every drain for eleven hours. The hold
 * doubles per consecutive refusal from the first figure to the second; an accepted pull ends it.
 */
export const SNAPSHOT_REFUSAL_HOLD_BASE_MS = 60_000;
export const SNAPSHOT_REFUSAL_HOLD_CAP_MS = 30 * 60_000;

/**
 * HOW MANY OF THE NEWEST MESSAGES THE EAGER PASS HYDRATES — 1 000, and it is now a measured number.
 *
 * The rule is fixed (2026-08-21): recent mail opens instantly. The number was not. Measured over a
 * large synthetic corpus with the windowed mirror this package ships, the first pass costs 975 ms
 * and 100 version bumps — roughly three seconds on an 8 GB machine, about a third of the visible
 * tab's eight-second sync cadence — and is paid once per mailbox per session. A pass over a mailbox
 * nothing arrived in costs 2.4 ms, because a ready body is never re-fetched. So the RECURRING cost
 * does not scale with this number: 100, 250 and 500 buy back that one cold pass and charge every
 * open above their own rank a round trip for it.
 *
 * What makes it affordable is the WINDOW rather than the number. With {@link EngineOptions.storePolicy}
 * absent — `full`, which evicts nothing — the same pass re-derives the whole mailbox a hundred times
 * and costs 7.5 s here, about three sync cadences on an 8 GB machine.
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

export {
  abortControllerOrNull, defaultEngineLocks, MODELLED_WAIT_CODES, noAnswerWithin,
};
