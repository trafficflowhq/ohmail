import {
  MutationRejectedError,
  type EngineAdapter,
  type ListOlderFn,
  type MessageBodyWire,
  type MutationOutcome,
  type OhmailEngine,
  type SnapshotFn,
  type SyncParams,
  type SyncResponse,
} from "@ohmail/client-engine";

/**
 * THE WAKE SIGNAL THIS APP DID NOT HAVE.
 *
 * `EngineProvider` used to call `engine.start()` once and that was every drain the tab would
 * ever perform. Three failures followed from the one omission, all of them observed in real
 * use: new mail never arrived without a manual reload; a single transient throw left a
 * permanently empty mailbox, because there was no second attempt; and a ~37-page bootstrap
 * spent twelve to fifteen seconds rendering "0 unread of 0", which is indistinguishable from
 * a broken account.
 *
 * ── WHY A POLL AND NOT AN EventSource ───────────────────────────────────────────────────
 *
 * `/events` exists and the engine has `attachWakeSignal()` for exactly this. It is not used
 * here because SSE is OFF in production: the Cloud API's own default for it is `false` and
 * the `TF_SSE` that would turn it on is absent from the deployed environment. (An
 * unauthenticated `GET /events` answers 401 rather than 503, because the route reads the
 * session before it checks the flag — so probing it proves nothing about whether it is on.)
 *
 * The cost shape also favours polling for this product. A visible tab is ~450 short `/sync`
 * calls an hour; one SSE connection is sixty minutes of open serverless function per hour,
 * multiplied by the per-account connection cap, and billed for abandoned tabs too. Polling
 * scales with attention, which is the whole argument for it: no API cost without somebody behind
 * it. SSE stays behind `TF_SSE`
 * for after the beta.
 *
 * ── WHAT THIS MODULE IS NOT ─────────────────────────────────────────────────────────────
 *
 * It is deliberately not part of `OhmailEngine`. Scheduling lives with the thing that has a
 * lifecycle to hang it on, which is the React effect.
 *
 * This used to add "and the engine owns no timers, so a live→demo navigation drops the reference
 * and there is nothing to cancel". That was the false half, and it cost two critical findings:
 * `syncOnce()` pages internally until `hasMore` is false, so a discarded engine can very much
 * have a ~37-page drain running inside it, and dropping the reference cancels none of it. What
 * makes the teardown correct is now {@link SyncGate}, which refuses the next page — see the
 * block above it.
 *
 * It is also not in `engine.tsx`. That file is a `"use client"` React module, and a loop
 * whose contract is "a hidden tab issues zero requests" has to be driven by fake timers to be
 * believed. Same reason `engine-config.ts` was carved out of the same file, and its header
 * says so: a structural assertion proves the code SAYS the right thing, not that it does it.
 */

/** What the shell may tell the user about the sync loop. Nothing else is exposed. */
export interface SyncStatus {
  /** No drain has yet completed for this engine — the mirror on screen may be partial. */
  bootstrapping: boolean;
  /** Consecutive failed drains. Zero after any success. */
  failures: number;
  /**
   * The loop has STOPPED and will not retry: the server refused this session in a way no
   * amount of waiting fixes (a revoked or deleted account, a 401/403) **and then refused it
   * again when asked**. Distinct from `failures > 0`, which is a mailbox that is still being
   * retried, and distinct from {@link SyncStatus.refused}, which is the same refusal before it
   * has been confirmed.
   */
  terminal: boolean;
  /**
   * OUR api refused this session ONCE, and the claim has not yet been re-made.
   *
   * The shell must not tell a signed-in user to sign in on this. It is published so the strip can
   * say the weaker true thing ("Sync failed. Retrying.") instead of the stronger unverified one,
   * and so that it says SOMETHING: a refusal answered with silence is how the 32 minutes of
   * 2026-08-03 happened. Mutually exclusive with `terminal` by construction — confirmation moves
   * the fact from one field to the other. See {@link REFUSAL_CONFIRM_MS}.
   *
   * ── AN INVARIANT THIS FIELD DEPENDS ON, AND CANNOT ENFORCE ──────────────────────────────
   *
   * **Every publish that changes `refused` must also change `failures` or `terminal`.**
   * `engine.tsx`'s status dedup compares `bootstrapping`, `failures` and `terminal` and CANNOT
   * see this field, so a transition that moved only `refused` would be swallowed and the strip
   * would never appear. It holds today for the same reason the comment there says `terminal`
   * held before it was compared: `refused` is only ever set in the publish that increments
   * `failures`, and only ever cleared in one that zeroes `failures` or sets `terminal`. That is a
   * coincidence until something enforces it — `sync-liveness.test.ts` asserts it over adjacent
   * published pairs, and the real fix is to widen that dedup, which is owed.
   */
  refused: boolean;
}

/** A live engine before its first tick, and the permanent value for the demo. */
export const SYNC_SETTLED: SyncStatus = {
  bootstrapping: false, failures: 0, terminal: false, refused: false,
};
export const SYNC_BOOTSTRAPPING: SyncStatus = {
  bootstrapping: true, failures: 0, terminal: false, refused: false,
};

/**
 * How many consecutive failures the user hears about.
 *
 * One is a blip — a dropped packet, a cold serverless function, a wifi handover — and the
 * loop is back inside two seconds; saying so would train people to ignore the strip. Three
 * is ~7 s at the 1 s/2 s/4 s ceilings and well inside one backoff cap, which is the promise
 * the gap was written against: with the network down, the UI SAYS so within a cap.
 *
 * It lives here rather than in the surface because two surfaces read it — the strip that
 * reports the failure and the bootstrap counter that has to stop claiming progress at the
 * same moment. Two literals would let those drift into a window where the count is frozen
 * and nothing explains why.
 *
 * A CODED REFUSAL IS NOT SUBJECT TO IT, and used to skip it in the other direction. This said
 * "`terminal` is NOT subject to it. A refusal no retry can fix is reported on the first one",
 * and that was true of the STRONG claim: one coded 401 announced a revoked session. The strong
 * claim moved behind one confirmation ({@link REFUSAL_CONFIRM_MS}) and left the WEAK one
 * where the strong one was — {@link SyncStatus.refused} is published on the first refusal, so
 * the strip says "Sync failed. Retrying." immediately rather than waiting out three drains.
 * A statement our own API made about this identity is not a dropped packet, and the streak's
 * "one is a blip" argument does not cover it.
 */
export const SYNC_FAILURE_STREAK = 3;

/**
 * Eight seconds, and only while the tab is visible.
 *
 * Short enough that mail arriving while somebody is reading feels present, long enough that
 * a person who leaves the app open all day costs ~450 requests an hour rather than a
 * connection held open for sixty minutes of billed function time.
 */
export const POLL_MS = 8_000;
/** First retry ceiling. Doubles per consecutive failure. */
export const BACKOFF_BASE_MS = 1_000;
/**
 * The degraded steady state, not an exhaustion point. A visible tab keeps retrying at up to
 * a minute apart forever: "gave up" is a state a mail client must never enter silently, and
 * the alternative to a slow retry is a mailbox that stays wrong until someone reloads.
 */
export const BACKOFF_CAP_MS = 60_000;

/**
 * How long a coded refusal must stand before the app will call it a revoked session.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────
 *
 * Reported from real use: "Sync stopped — this session is no longer authorized" appears and
 * then clears by itself. It appeared because ONE coded 401 latched `terminal`, and it cleared because the
 * next successful probe withdrew it. Everything in between was `role="alert"` telling a
 * signed-in user to sign in, on evidence that was one request old.
 *
 * ── WHAT IS BOUGHT, AND WHAT IS NOT ─────────────────────────────────────────────────────
 *
 * The first coded refusal now stops the poll and arms exactly ONE further ask, this far out. If
 * that ask succeeds the user is never told anything about signing in; if it is refused the same
 * way, the server has re-made the claim and the app may repeat it. So the class of false alarms
 * this removes is precisely *refusals shorter than a minute* — and it must be said plainly that
 * a multi-minute alias window still reaches STOPPED. The wake probe is what covers that one,
 * and it already does: a hide/show clears a false latch with no reload.
 *
 * ── WHY IT IS `BACKOFF_CAP_MS` AND NOT A NUMBER OF ITS OWN ──────────────────────────────
 *
 * Sixty seconds is already this module's one bounded unit of retry: it is the ceiling the
 * backoff walks up to and sits at forever, and it is the floor {@link SyncStatus.refused}'s
 * sibling `lastProbeAt` uses for the same purpose. Reusing it means one number to reason about
 * rather than two that must be kept in a relation nobody wrote down. Longer would be worse, not
 * safer: it buys a slightly larger class of suppressed false positives and charges a genuinely
 * revoked user that much longer before the one action that works.
 *
 * ── AND WHY THIS IS NOT THE TIMER `U-AUTHLATCH-BRIEF.md:70-71` FORBIDS ──────────────────
 *
 * That ban is on a timer that runs WHILE `terminal` and recurs — it would re-open the
 * abandoned-visible-tab hole the latch exists to close. This one is PRE-terminal and arms at
 * most once per refusal episode: it either recovers into the ordinary poll or latches `terminal`,
 * after which there is no timer at all. The cost of a genuine revocation goes from one request to
 * two, once, and then to zero.
 */
export const REFUSAL_CONFIRM_MS = BACKOFF_CAP_MS;

/**
 * The smallest delay any retry may draw, whatever the jitter says. See {@link backoffDelay}.
 */
export const BACKOFF_MIN_MS = 250;
/**
 * The floor as a fraction of the current ceiling. A quarter keeps the useful half of full
 * jitter (a wide, decorrelated window) while making the floor grow with the outage.
 */
export const BACKOFF_FLOOR_RATIO = 0.25;

/**
 * Jitter over a doubling ceiling, with a FLOOR — `floor + random() * (ceiling - floor)`.
 *
 * ── WHY THE ZERO FLOOR HAD TO GO ─────────────────────────────────────────────────────────
 *
 * This was plain full jitter, `random() * ceiling`, and the comment claimed "a run of low draws
 * cannot become a tight loop — it can only spend the first few (sub-second) steps quickly".
 * That is false at the far end, which is the end that matters. The floor was zero at EVERY
 * ceiling, so a permanently failing drain sitting at the 60-second cap could still draw 0 ms,
 * and again, and again: the expected delay is 30 s but nothing bounds a run of small draws, and
 * the ceiling never becomes a minimum. With a permanent `410 CursorExpired` each drain costs
 * two requests (the engine re-bootstraps once, then surfaces the second), so the degraded state
 * a mail client is supposed to be able to sit in forever could instead spin at whatever rate
 * the network allows — paid API calls with nobody behind them, billed to an abandoned tab.
 *
 * The floor is `max(250 ms, ceiling / 4)`, so the window widens with the outage: [250 ms, 1 s]
 * at the first failure, [15 s, 60 s] at the cap. What full jitter buys is kept — N tabs, or N
 * accounts knocked offline by the same upstream blip, still do not come back in a synchronised
 * wave — because the draw is still spread across three quarters of the ceiling.
 */
export function backoffDelay(
  failures: number,
  opts: { base?: number; cap?: number; random?: () => number; min?: number } = {},
): number {
  const base = opts.base ?? BACKOFF_BASE_MS;
  const cap = opts.cap ?? BACKOFF_CAP_MS;
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(base * 2 ** Math.max(0, failures - 1), cap);
  const floor = Math.min(ceiling, Math.max(opts.min ?? BACKOFF_MIN_MS, ceiling * BACKOFF_FLOOR_RATIO));
  return Math.floor(floor + random() * (ceiling - floor));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   ABORTING A DRAIN BETWEEN PAGES
   ══════════════════════════════════════════════════════════════════════════════════════════

   `engine.syncOnce()` is not one request. It loops internally while `hasMore` is true, and a
   cold Cloud account's first drain is ~37 pages. The visibility gate below decides whether a
   drain STARTS; nothing decided whether it CONTINUES, so hiding or closing a tab thirty seconds
   into a bootstrap left every remaining page to be issued anyway — a background tab issuing
   paid `/sync` calls, which is the one thing that must not happen: no API cost without somebody
   behind it. Teardown had
   the same hole: `stopped` stops the timer, not the loop already inside the engine.

   The page boundary is the ENGINE'S TRANSPORT — `adapter.sync()`, called once per page — so
   that is where the check belongs. A gate wraps the adapter at construction and refuses the
   next page while the tab is hidden or the scheduler is gone; the refusal throws out of
   `drain()` and the loop stops with the pages it already applied persisted, exactly as a
   network failure mid-drain already does. The cursor is per-page, so the next drain resumes
   rather than restarts.

   `mutate()` is DELIBERATELY NOT GATED. A mutation is the user's own intent and must reach the
   server whatever the tab is doing; the cost objection is about polling, not about the click
   somebody just made. */

/**
 * A drain was cancelled between pages. Not a failure: it must not count against the backoff,
 * must not be reported as an error, and must not arm a retry — the wake that follows the tab
 * coming back is what resumes it.
 */
export class SyncAbortedError extends Error {
  readonly code = "sync_aborted";
  constructor(reason: string) {
    super(`ohmail: sync aborted before the next page (${reason})`);
    this.name = "SyncAbortedError";
  }
}

const isAborted = (err: unknown): err is SyncAbortedError => err instanceof SyncAbortedError;

/**
 * The per-page continuation gate. Built beside the engine's adapter, claimed by the scheduler.
 *
 * A gate NOBODY has claimed never refuses, so the demo engine, the desktop bundle and a bare
 * `engine.start()` are unaffected — the gate only ever narrows a surface a scheduler is
 * actively driving.
 */
/**
 * THE TWO CAPABILITIES `EngineAdapter` DOES NOT DECLARE.
 *
 * `snapshot` and `listMessages` are STRUCTURAL in `@ohmail/client-engine` — the engine reaches
 * for them on the adapter it was handed and treats absence as a real answer, so neither is a
 * member of the interface. That is what makes them droppable HERE: an object literal that omits
 * one still satisfies `EngineAdapter` and still compiles, and the demo is never wrapped, so the
 * loss shows up on the live path alone. Naming them in the gate's own signature is what turns
 * "the wrapper forgot" from a silent behaviour change into something a reader can check against
 * a list — and the imported types are the package's own, so a rename over there fails here.
 */
type GatedAdapter = EngineAdapter & { snapshot?: SnapshotFn; listMessages?: ListOlderFn };

export interface SyncGate {
  /** Wrap the engine's transport. Call once, at construction, on the adapter you pass in. */
  guard(adapter: GatedAdapter): GatedAdapter;
  /**
   * Claim the gate for a scheduler's lifetime. There is deliberately no `release`: the
   * predicate a scheduler installs closes ITSELF once that scheduler is stopped (it reads the
   * scheduler's own `stopped` flag), so a teardown aborts its in-flight drain instead of
   * un-gating it. A remount simply claims again and its fresh predicate takes over.
   */
  claim(mayContinue: () => boolean): void;
}

export function createSyncGate(): SyncGate {
  let mayContinue: (() => boolean) | null = null;
  return {
    claim(next) {
      mayContinue = next;
    },
    guard(adapter) {
      return {
        // Kept reachable so "the live engine talks HTTP, the demo talks fixtures" stays an
        // assertion a test can make about the ENGINE rather than about this wrapper —
        // `engine-armed.test.ts` and `demo-zero-network.test.ts` both check exactly that, and a
        // gate that hid the transport would have quietly turned their control cases into
        // tautologies. See {@link transportOf}.
        transport: adapter,
        sync: async (params: SyncParams): Promise<SyncResponse> => {
          if (mayContinue && !mayContinue()) {
            throw new SyncAbortedError("the tab is hidden or its sync loop was torn down");
          }
          return adapter.sync(params);
        },
        mutate: (m, opts): Promise<MutationOutcome> => adapter.mutate(m, opts),
        /**
         * FORWARDED, AND NOT GATED — the same rule `mutate` follows, for the same reason.
         *
         * A body fetch happens because somebody selected a message, expanded a card, or
         * opened a Screener row. It is the user's own intent, in a tab they are looking at,
         * and it is bounded by that act: one request per message opened. The gate exists to
         * stop a HIDDEN tab paging through a thirty-seven page bootstrap nobody asked for
         * — API cost with nobody behind it — which is a different shape of cost entirely.
         *
         * It must be forwarded rather than omitted: a wrapper that dropped it would leave
         * the engine with `adapter.fetchBody` undefined on the LIVE path only — the demo is
         * unwrapped — so every live account would render snippets again while the whole
         * suite stayed green. This is exactly the class of wiring bug the `transport` field
         * below exists to keep visible.
         */
        fetchBody: (messageId: string): Promise<MessageBodyWire | null> => adapter.fetchBody(messageId),

        /*
         * ── THE THREAD OPEN — FORWARDED, NOT GATED, AND SPREAD ────────────────────────────
         *
         * `GET /messages/bodies?ids=…`: every sibling of the conversation being opened, in one
         * request instead of one per message.
         *
         * NOT GATED, on `fetchBody`'s own argument — it fires because somebody opened a thread,
         * in a tab they are looking at, and it is bounded by that act. It is in fact the LEAST
         * speculative call on this list: one request for what used to be N.
         *
         * SPREAD, and this is the line that decides whether the batch ever happens outside the
         * demo. `OhmailEngine.hydrateThread` reads the capability structurally and falls back
         * to asking per message when it is absent — a fallback that works, converges, and renders
         * correctly, which is exactly what would make the omission invisible. The demo is never
         * wrapped, so a missing line here is N requests per thread on the LIVE PATH ONLY, with
         * the whole suite green. Sixth capability, same trap, same shape of guard:
         * `thread-bodies-wired.test.ts` builds the real engine through `createEngine` and counts
         * the requests.
         *
         * Unconditionally would be the opposite failure: a `FixturesAdapter` behind this gate
         * claiming a batch endpoint it has no server for, and `?demo=1` issuing a request on the
         * first thread anybody opens.
         */
        ...(adapter.fetchBodies ? { fetchBodies: adapter.fetchBodies.bind(adapter) } : {}),

        /*
         * FORWARDED, NOT GATED — the same rule as `fetchBody` above: one request per settled
         * query, from a tab the user is looking at, bounded by the act of typing. The rule
         * against API cost with nobody behind it is about a HIDDEN tab paging through a
         * bootstrap nobody asked for, which this is not.
         *
         * SPREAD rather than always defined, and that is the whole point: an adapter WITHOUT
         * the capability must keep not having it, because the surface reads absence as "this
         * client cannot reach the archive" and says so. Defining it unconditionally would
         * make the demo claim an archive it has no server for — and would do it on the live
         * path only, which is the wiring bug `transport` exists to keep visible.
         */
        ...(adapter.searchServer ? { searchServer: adapter.searchServer.bind(adapter) } : {}),

        /*
         * ── THE COLD-START READ — FORWARDED, AND THIS ONE **IS** THE GATED PAGE ────────────
         *
         * `GET /sync/snapshot` is not a sibling of `fetchBody` and `searchServer`; it is
         * `sync()`'s own first page under another name. The engine takes it INSTEAD of
         * `since=0` whenever the mirror's cursor is "0" — a first-ever start, a bootstrap that
         * crashed before its last page, or the 410 branch. So the visibility argument that
         * exempts the others points the other way here: a hidden tab paging through a whole
         * snapshot is exactly the cost-with-nobody-behind-it this gate exists to refuse.
         *
         * It is nevertheless NOT gated in this literal, and that is deliberate rather than an
         * omission. The engine calls `snapshot()` from `runSnapshot()`, whose page-1 failure
         * path LATCHES "this route is unusable" and silently falls back to `since=0`; a
         * `SyncAbortedError` thrown from here on page 1 would be swallowed as that latch and
         * the tab would spend the rest of its life on the old bootstrap path. Page 2 onwards
         * would be worse — `runSnapshot` rethrows there, which is correct for a network
         * failure and wrong for a cancellation, and the drain would count it against the
         * backoff. The gate on `sync()` already bounds the drain: the delta pages that follow
         * the snapshot refuse, and a torn-down or hidden tab stops there.
         *
         * SPREAD, for the third time and the usual reason: defining it unconditionally would
         * make a `FixturesAdapter` behind a gate claim a snapshot endpoint it has no server
         * for, and `?demo=1` would issue a request on its first drain — the demo is fixtures,
         * and a self-contained surface makes no external request at all.
         *
         * FORWARDED AT ALL: this literal is the whole surface the engine sees, and the demo is
         * never wrapped — so a capability missing from this list is missing on the LIVE PATH
         * ONLY. Every live account would fall back to replaying the log from seq zero, forever,
         * with every test in the repo green because they build engines from bare adapters.
         * `snapshot-wired.test.ts` builds the real live engine through `createEngine` so that
         * deleting this line goes red.
         */
        ...(adapter.snapshot ? { snapshot: adapter.snapshot.bind(adapter) } : {}),

        /*
         * ── READING PAST THE END OF THE WINDOW — FORWARDED, NOT GATED, AND SPREAD ──────────
         *
         * `GET /messages?view=&cursor=`, the companion to the windowed store: a page of the mail
         * this client chose not to keep on disk. Same rule as `fetchBody` and `searchServer` on
         * all three counts.
         *
         * NOT GATED: it fires when somebody scrolls to the bottom of a pile, in a tab they are
         * looking at, and it is bounded by that act — one page per scroll, never speculative.
         * The rule against API cost with nobody behind it is about a hidden tab paging
         * through a bootstrap nobody asked for.
         *
         * SPREAD: `OhmailEngine.listOlderAvailable()` decides whether the end of a list offers a
         * control at all. Defining this unconditionally would put "there is more, older mail" at
         * the bottom of the demo's Ohbox, over fixtures that are the whole of Mila's world.
         *
         * FORWARDED AT ALL: without the line, a live windowed account reaches the end of its
         * ninety-day window and is told that is the end of their mail — which is the falsest
         * sentence this app could put on a screen, and it would say it only in production.
         */
        ...(adapter.listMessages ? { listMessages: adapter.listMessages.bind(adapter) } : {}),

        /*
         * ── ATTACHMENTS — FORWARDED, NOT GATED, AND SPREAD ────────────────────────────────
         *
         * Three capabilities, one rule, and it is `searchServer`'s rule for the third time.
         *
         * NOT GATED: `listAttachments` is one indexed row read when a message is opened, and
         * the two byte methods fire on a click on a named file. All three are the user's own
         * intent in a tab they are looking at. The rule against API cost with nobody behind
         * it is about a HIDDEN tab paging
         * through a bootstrap nobody asked for; a person pressing a PDF is the opposite of
         * that. Gating them would mean a file that silently refuses to open whenever the
         * predicate happens to be false.
         *
         * SPREAD, NOT ALWAYS-DEFINED: `OhmailEngine.attachmentsAvailable()` is `typeof
         * adapter.listAttachments === "function" && typeof adapter.fetchAttachment ===
         * "function"`, and the strip renders NOTHING when that is false. Defining these
         * unconditionally would make a `FixturesAdapter` behind a gate claim an attachment
         * service it has no server for — and `fetchAllAttachments` in particular would put a
         * "Download all" button over an archive nothing can build.
         *
         * FORWARDED AT ALL: this object literal is the whole surface the engine sees. It is
         * not a Proxy, and the demo engine is never wrapped (`engine-config.ts` returns before
         * `guard`) — so a capability missing from THIS list is missing on the LIVE PATH ONLY.
         * `attachmentsAvailable()` would answer false for every paying account, the strip
         * would render nothing at all, and every unit test in the repo would stay green
         * because they construct engines from bare adapters. That is the exact shape of the
         * bug `transport` exists to keep visible, and `attachments-wired.test.ts` builds the
         * real live engine through `createEngine` so that deleting any one of these three
         * lines goes red.
         */
        ...(adapter.listAttachments ? { listAttachments: adapter.listAttachments.bind(adapter) } : {}),
        ...(adapter.fetchAttachment ? { fetchAttachment: adapter.fetchAttachment.bind(adapter) } : {}),
        ...(adapter.fetchAllAttachments ? { fetchAllAttachments: adapter.fetchAllAttachments.bind(adapter) } : {}),
      } satisfies GatedAdapter & { transport: EngineAdapter };
    },
  };
}

/** The real transport behind a gate, or the adapter itself when it was never wrapped. */
export function transportOf(adapter: unknown): unknown {
  return (adapter as { transport?: unknown } | null)?.transport ?? adapter;
}

/**
 * Which gate belongs to which engine.
 *
 * The gate has to be built BEFORE the engine (it wraps the adapter the constructor takes) and
 * is needed AFTER it (the scheduler claims it), and `OhmailEngine` keeps its adapter private —
 * correctly; `packages/client-engine` is not the place to know about tabs. A `WeakMap` beside
 * the scheduler keeps the association without widening either boundary or threading the gate
 * through `createEngine`'s return type and every caller of it. Weak, so an abandoned engine and
 * its gate are collected together.
 */
const GATES = new WeakMap<OhmailEngine, SyncGate>();

/** Register the gate an engine was built with, and hand the engine back. */
export function registerSyncGate(engine: OhmailEngine, gate: SyncGate): OhmailEngine {
  GATES.set(engine, gate);
  return engine;
}

/** The two globals this loop reads, narrowed so a test can hand it neither. */
interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}
interface OnlineSource {
  addEventListener(type: "online", listener: () => void): void;
  removeEventListener(type: "online", listener: () => void): void;
}

export interface SyncSchedulerOptions {
  /** Called on every settled tick and on the first one, with the value the UI renders. */
  onStatus?: (status: SyncStatus) => void;
  pollMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  random?: () => number;
  /** Defaults to `document` / `window`; `null` means "this environment has neither". */
  visibility?: VisibilitySource | null;
  online?: OnlineSource | null;
  /** Where a failed drain is reported. Defaults to `console.error`. */
  report?: (message: string, err: unknown) => void;
  /**
   * The engine's per-page abort gate. Defaults to the one `createEngine` registered for this
   * engine; pass it explicitly in a test that builds its own engine.
   */
  gate?: SyncGate | null;
}

/**
 * Is this refusal PERMANENT — will no retry ever succeed?
 *
 * The adapter already knows: `HttpAdapter.rejectionOf` reads the wire's `retryable`, defaulting
 * to `status >= 500 || status === 429`, so a 401 or 403 arrives as `retryable: false` and the
 * loop ignored it. "Never gives up while the tab is visible" is the right rule for a mailbox
 * that is merely unreachable and the wrong one for a session that has been revoked or an
 * account that has been deleted: that tab can no longer be served AT ALL, and every retry it
 * makes is an invocation billed against an account with no entitlement behind it (#10).
 *
 * Anything that is not a typed refusal — a network error, a parse failure, an unknown throw —
 * stays retryable. Terminal is a positive claim, made only when the server made it.
 *
 * ── CORRECTED 2026-08-04: THAT LAST SENTENCE WAS FALSE AS WRITTEN ───────────────────────
 *
 * `retryable === false` alone caught far more than a revoked session. `HttpAdapter.rejectionOf`
 * defaults `retryable` to `status >= 500 || status === 429`, so **anything** else non-5xx latched:
 * a platform 401 from deployment protection (HTML body ⇒ no envelope ⇒ `code: null`), a
 * `DEPLOYMENT_NOT_FOUND` 404 mid-alias, any 400 from deploy skew, and a 403
 * `enrollment_incomplete` whose own middleware comment says the client must NOT discard the
 * session. Observed live: `ohmail.app` told a signed-in user "Sign in" while `/api/auth/session`,
 * `/api/sync` and `/api/mailboxes` all answered 200.
 *
 * So the claim is now checked rather than asserted. `code !== null` is the proof the refusal came
 * from OUR envelope and not from the platform, and 401/403 is the only pair that means "this
 * identity cannot be served". Everything else goes back to being retryable, which is what the
 * paragraph above always said.
 *
 * This narrowing is NOT sufficient on its own, and that is deliberate — see `revalidating` and
 * `refusedAt` below. The live recurrence was an APP-shaped 401 on `/api/sync?since=…` that was
 * merely TRANSIENT, and no classifier can tell a transient 401 from a permanent one at the moment
 * it arrives. Only asking again can — which is now done TWICE, at two different moments and for
 * two different reasons: once before the claim is ever made ({@link REFUSAL_CONFIRM_MS}), and
 * once on every wake after it has been (`lastProbeAt`). The first stops a short
 * refusal from being announced at all; the second stops a long one from outliving the transient.
 */
function isTerminalRefusal(err: unknown): boolean {
  return err instanceof MutationRejectedError
    && err.retryable === false
    && (err.status === 401 || err.status === 403)
    && err.code !== null;
}

/**
 * Start the sync loop for one engine. Returns the teardown.
 *
 * ── ONE TIMER, ARMED ONLY AFTER THE PREVIOUS DRAIN HAS SETTLED ──────────────────────────
 *
 * `setInterval` is the trap the Cloud API's `/events` route documents for the server side and
 * it is the same trap here: under latency the ticks stack, and what you get is not a faster
 * sync but a queue of drains that each observe a cursor the one before them was about to
 * move. This loop awaits the drain and only then arms the next timeout, so the cadence is
 * "eight seconds of quiet", never "eight seconds since the last attempt began".
 *
 * ── A HIDDEN TAB PERFORMS ZERO SYNCS ────────────────────────────────────────────────────
 *
 * Not "fewer" and not "cheaper ones": the timer is disarmed and no request is issued, because
 * a background tab that keeps a mailbox warm is API cost with no revenue attached to it.
 * Coming back is instant — `visibilitychange` drains immediately rather than
 * waiting out a period — and so is regaining the network, via `online`.
 *
 * It is asked at all THREE points where the answer can have changed, which is the correction
 * this loop needed: before a drain starts, again after hydration's await and before the first
 * request, and — via {@link SyncGate} — before every page of a drain already in flight. The
 * middle one covers a tab that mounts visible and is hidden while IndexedDB opens; the last one
 * covers the ~37-page bootstrap that used to run to completion behind a tab nobody was looking
 * at. The same predicate also reads `stopped`, so teardown cancels rather than merely stops
 * caring: a live→demo navigation aborts the discarded live engine's drain instead of letting it
 * finish paging from behind a page that promises zero egress — the demo is fictional data, and
 * a surface that claims to be self-contained must make no external request at all.
 *
 * ── EVERYTHING FUNNELS THROUGH `syncOnce()` ─────────────────────────────────────────────
 *
 * Its single-flight (`engine.ts`) returns the in-flight promise to a second caller, so a wake,
 * a retry and a mutation's read-your-writes drain can never stack into two concurrent
 * `/sync` requests. The 410 re-bootstrap stays where it belongs, inside the engine's own
 * `drain()`; this loop never touches the cursor and never calls `resetForBootstrap`.
 *
 * `engine.hydrate()` is the one thing here that is not `syncOnce()`. It is the other half of
 * `engine.start()`, split out because the retry path must not re-read the whole IndexedDB
 * mirror on every backoff step while the network is down. It is called through the ENGINE
 * rather than through `engine.store`, and that is not tidying: only the engine holds the
 * listeners, so a bare `store.load()` hydrates the mirror without publishing it and the
 * cached mail stays invisible until a network round trip completes.
 */
export function startSyncScheduler(
  engine: OhmailEngine,
  options: SyncSchedulerOptions = {},
): () => void {
  const pollMs = options.pollMs ?? POLL_MS;
  const base = options.backoffBaseMs ?? BACKOFF_BASE_MS;
  const cap = options.backoffCapMs ?? BACKOFF_CAP_MS;
  const random = options.random ?? Math.random;
  const report = options.report
    ?? ((message: string, err: unknown) => { console.error(message, err); });
  const visibility = options.visibility !== undefined
    ? options.visibility
    : (typeof document === "undefined" ? null : document);
  const online = options.online !== undefined
    ? options.online
    : (typeof window === "undefined" ? null : window);

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** A drain is in flight. Guards the timer arithmetic, not the request — see `syncOnce()`. */
  let running = false;
  let hydrated = false;
  let bootstrapping = true;
  let failures = 0;
  /**
   * Set by a refusal the server made about this identity **and then re-made**. NO TIMER runs
   * while it is true.
   *
   * It is no longer "set once and never cleared": a single transient 401 bought permanent sync
   * death for the tab's lifetime, and a reload was the only recovery, while the banner told a
   * signed-in user to sign in. It is cleared by a successful probe (`revalidating`).
   *
   * And it is no longer set by the FIRST refusal either — that is `refusedAt`.
   */
  let terminal = false;
  /**
   * WHEN a coded refusal arrived that has not been confirmed. Null when there is none.
   *
   * This is where the fact lives between the two asks. The poll is stopped (a refusal is believed
   * that far immediately: continuing to poll an identity the server just refused is exactly the
   * invocation the latch exists to prevent), one confirm drain is armed at
   * {@link REFUSAL_CONFIRM_MS}, and the published status carries `refused: true` so the strip says
   * the weaker true sentence rather than nothing and rather than "sign in".
   *
   * This replaces the claim `revalidating`'s doc used to make — *"Latching stays IMMEDIATE — say
   * so rather than go quiet"*. Latching the STRONG claim is no longer immediate. The half of that
   * sentence which still stands, and is the half that mattered, is "rather than go quiet": the
   * first refusal is still spoken about, in the same tick, in the sentence that is true of it.
   */
  let refusedAt: number | null = null;
  /**
   * A single probe drain, permitted while `terminal`, to test whether the refusal still holds.
   *
   * A wake may ask once more, floored at one probe per {@link BACKOFF_CAP_MS}. Distinct from
   * `refusedAt`'s confirm drain in both direction and purpose: this one tries to DISPROVE a claim
   * already on screen, the confirm tries to establish one that is not.
   */
  let revalidating = false;
  /**
   * When the last probe was issued. The bound that keeps a revoked tab from becoming API cost
   * with nobody behind it: at most one probe per
   * `BACKOFF_CAP_MS`, shared by BOTH wake sources, because `online` can fire repeatedly on a flaky
   * network. Worst case for a revoked, visible, focus-flapped tab is ~60 req/hr against a healthy
   * tab's ~450. A hidden tab issues zero (the `visible()` gate holds), and an abandoned visible tab
   * issues zero after the first — probes fire on wake EVENTS, never on a timer. A terminal-mode
   * timer would re-open the abandoned-tab hole this latch exists to close.
   *
   * That last sentence is about the TERMINAL-MODE probe and is unchanged. `refusedAt`'s confirm
   * drain does run on a timer, and it is not the thing being forbidden here: it is pre-terminal,
   * it arms at most once per refusal episode, and it ends in either a healthy poll or `terminal`
   * with no timer at all. An abandoned visible tab pays one extra request, once, for ever.
   */
  let lastProbeAt = 0;

  // No `document` at all (SSR, a non-browser host) is treated as visible: the gate exists to
  // stop hidden TABS, and something with no visibility model has none to hide.
  const visible = (): boolean => visibility === null || visibility.visibilityState === "visible";

  /**
   * "May a request be issued right now?" — the ONE predicate, read at every await boundary.
   *
   * `tick()` checked it once, before an `await` that can last as long as an IndexedDB open, and
   * the engine's page loop never checked it at all. Both holes are the same missing question.
   */
  const mayRequest = (): boolean => !stopped && (!terminal || revalidating) && visible();

  // The gate refuses the engine's NEXT page whenever this scheduler would refuse a new drain.
  // Claimed and never released: the predicate closes itself via `stopped`, so a torn-down
  // scheduler cancels the drain it left behind rather than freeing it to keep paging.
  const gate = options.gate !== undefined ? options.gate : (GATES.get(engine) ?? null);
  gate?.claim(mayRequest);

  const publish = (): void => {
    if (stopped) return;
    options.onStatus?.({ bootstrapping, failures, terminal, refused: refusedAt !== null });
  };

  const disarm = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const arm = (ms: number): void => {
    disarm();
    if (stopped || terminal) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, ms);
  };

  async function tick(): Promise<void> {
    if (stopped || running) return;
    if (terminal && !revalidating) return;
    if (!visible()) {
      // Nothing armed while hidden. `visibilitychange` is what restarts the loop.
      disarm();
      return;
    }
    running = true;
    try {
      if (!hydrated) {
        // `engine.hydrate()` and NOT `engine.store.load()`, which is what stood here. The two
        // read the same bytes; only one of them TELLS the UI. `load()` fires no listener, so the
        // device's copy of the mailbox landed in memory and the screen went on saying "Nothing in
        // your Ohbox." until the first `/sync` page arrived — the second of two serial round
        // trips, and the whole of what a slow connection makes visible. See `OhmailEngine.hydrate`.
        //
        // It also stops this loop reaching through the engine into its store, which was the seam
        // violation that made the omission possible in the first place.
        await engine.hydrate();
        hydrated = true;
        // ── RE-ASK AFTER THE AWAIT, BEFORE THE FIRST PAID REQUEST ──────────────────────
        //
        // `store.load()` opens IndexedDB and reads the whole mirror; on a cold, large account
        // that is hundreds of milliseconds to seconds, and it is the ONE await this loop makes
        // before its first `/sync`. Two things could change underneath it and neither was
        // re-checked:
        //
        //  · the tab was hidden while it ran — so a tab nobody ever looked at still issued a
        //    paid drain, and my "0 syncs while hidden" measurement could not have caught it
        //    because it was taken on an already-hydrated tab — a paid request with nobody
        //    behind it;
        //  · the scheduler was TORN DOWN — a live→demo navigation swaps the engine and runs
        //    this cleanup, and the discarded LIVE engine then called `/sync` from behind a
        //    page whose whole promise is that nothing leaves the tab, which is a promise a
        //    self-contained surface has to keep exactly.
        //
        // Hydration is kept (`hydrated` stays true) — the mirror is loaded and re-reading it
        // on the next wake would be pure waste. Only the REQUEST is withheld.
        if (!mayRequest()) {
          disarm();
          return;
        }
      }
      await engine.syncOnce();
      if (stopped) return;
      // A drain that SUCCEEDED disproves the refusal, so the claim is withdrawn. `arm()` refuses
      // to set a timer while `terminal`, which is why this clears it BEFORE arming.
      terminal = false;
      revalidating = false;
      // …and an UNCONFIRMED refusal is withdrawn here too, or the next transient one an hour later
      // would find `refusedAt` still set, read itself as the confirmation, and latch on the first
      // request — the same defect, resurrected on the second occurrence and invisible to any test
      // that only drives one.
      refusedAt = null;
      failures = 0;
      bootstrapping = false;
      arm(pollMs);
    } catch (err) {
      if (stopped) return;
      if (isAborted(err)) {
        // The gate cancelled this drain between pages, because the tab went away. Not a
        // failure: no count, no report, no retry armed. `visibilitychange` resumes from the
        // cursor the applied pages already advanced.
        disarm();
        return;
      }
      failures += 1;
      if (isTerminalRefusal(err)) {
        if (terminal || refusedAt !== null) {
          // CONFIRMED. We asked again — either the confirm drain `refusedAt` armed, or the wake
          // probe — and the server made the same refusal. No amount of waiting fixes a revoked
          // session or a deleted account, so stop, hold no timer, and SAY so: `terminal` is what
          // lets the shell tell the difference between "your mailbox is having a bad minute" and
          // "this tab can no longer be served". `role="alert"` re-announcing on a re-latch is
          // correct — the claim was re-made by the server, not repeated by us.
          terminal = true;
          refusedAt = null;
          revalidating = false;
          disarm();
          report("ohmail: this session can no longer sync — sign in again", err);
          return;
        }
        // THE FIRST ONE — believed enough to stop polling, NOT enough to tell a signed-in user
        // that they are signed out. One further ask is armed at `REFUSAL_CONFIRM_MS`; the
        // published status carries `refused`, so the strip says "Sync failed. Retrying.", which is
        // true — that retry is the timer on the next line. It must NOT fall through to the
        // ordinary backoff below: at `failures === 1` that is a ~1 s retry, and a ladder of them
        // inside the confirm window is exactly the "buys N−1 invocations" objection once used
        // to reject confirming at all.
        refusedAt = Date.now();
        report("ohmail: the server refused this session — asking once more before saying so", err);
        arm(REFUSAL_CONFIRM_MS);
        return;
      }
      // Anything that is not a coded refusal is not evidence ABOUT AUTHORIZATION, so it cannot
      // confirm one: a network error during the confirm window says nothing about whether the
      // session is still good, and reading it as corroboration is how a flaky connection would
      // start signing people out.
      refusedAt = null;
      // AUDIBLE, EVERY TIME. The predecessor of this loop swallowed the first rejection and
      // called it "the HTTP path retries on the next wake signal", with no wake signal in the
      // app — one throw, no request, no console entry, no error state.
      report(`ohmail: mailbox sync failed (attempt ${failures}) — retrying`, err);
      arm(backoffDelay(failures, { base, cap, random }));
    } finally {
      running = false;
      publish();
    }
  }

  /**
   * A drain NOW: the tab came back, or the network did. Coalesced into any drain in flight.
   *
   * It does NOT re-check visibility. `tick()` owns that decision and there is exactly one
   * copy of it, deliberately: a second `!visible()` here read as belt-and-braces and was
   * dead weight — removing `tick()`'s gate left every hidden-tab assertion in
   * `sync-liveness.test.ts` red, and removing this one left them all green.
   */
  const wake = (): void => {
    if (stopped || running) return;
    if (terminal) {
      // One bounded probe per wake. A transient refusal must not outlive the
      // transient, and a genuine one must not buy invocations (#10) — hence the floor.
      const at = Date.now();
      if (at - lastProbeAt < BACKOFF_CAP_MS) return;
      lastProbeAt = at;
      revalidating = true;
      void tick().finally(() => { revalidating = false; });
      return;
    }
    if (refusedAt !== null) {
      // A coded refusal is waiting to be confirmed, and a wake does not get to ask early. The
      // confirmation is a SECOND ask, spaced by `REFUSAL_CONFIRM_MS`; a tab somebody flips away
      // from and back must not be able to shorten it, or a two-second transient latches whenever
      // the user happens to switch windows — and it must not be able to buy invocations either
      // (#10), which a wake-triggered drain per flip is exactly.
      //
      // So this only RESTORES the timer, because going hidden disarmed it: `refusedAt` survives
      // the hide, the strip keeps saying "Retrying." in a tab nobody is looking at (correct — the
      // fact did not change), and coming back re-arms whatever is left of the window. Clamped at
      // zero so a tab that was away longer than the window asks immediately.
      arm(Math.max(0, refusedAt + REFUSAL_CONFIRM_MS - Date.now()));
      return;
    }
    void tick();
  };

  // Going hidden disarms IMMEDIATELY rather than letting the pending timeout fire into a
  // gate that will refuse it. Same request count either way; the difference is that a
  // backgrounded tab holds no timer, which is the property `vi.getTimerCount()` can see.
  const onVisibility = (): void => {
    if (visible()) wake();
    else disarm();
  };

  visibility?.addEventListener("visibilitychange", onVisibility);
  online?.addEventListener("online", wake);

  publish();
  void tick();

  return () => {
    stopped = true;
    disarm();
    visibility?.removeEventListener("visibilitychange", onVisibility);
    online?.removeEventListener("online", wake);
  };
}
