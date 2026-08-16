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
 * ── THE THREE-STATE MODEL: PUSH-FED WHEN LOOKED AT, QUIET WHEN NOT, POLLING WHEN PUSH DIES ─
 *
 * This header used to argue "why a poll and not an EventSource", and that decision is
 * REVERSED — deliberately, by the realtime-wake slice, with the server's half (`GET /events`
 * fan-out off the `change_log` NOTIFY) landing in the same change. What survives of the old
 * argument is its cost logic, which is why the result is three states and not one stream:
 *
 *  · **Visible, stream healthy** — the held SSE stream is the wake signal (a `sync` frame ⇒
 *    drain now, through the same serialized path every other wake takes), and the poll drops
 *    to a slow SAFETY cadence ({@link WAKE_SAFETY_POLL_MS}) whose only job is to bound the
 *    staleness a silently dead stream could cost. New mail is on screen in the time a commit
 *    takes to fan out — ~1 s — instead of up to a poll period.
 *  · **Hidden** — NO stream is held (a background tab must not pin a server connection), and
 *    the tab polls at {@link HIDDEN_POLL_MS}. This is also a reversal, of "a hidden tab
 *    performs ZERO syncs": zero was the right floor when every request was paid attention,
 *    but it meant returning to a tab always began with a stale mailbox. One drain a minute is
 *    the cheap end of warm — ~60 requests/hour against a visible tab's ~450 — and it is the
 *    deliberate price of a mailbox that is current when you come back to it.
 *  · **Stream refused, absent, or failing** — the 8 s poll ({@link POLL_MS}), exactly as this
 *    module always behaved. A terminal stream refusal (the server's flag is off, capacity, an
 *    auth refusal — `EventSource` exposes no status, so they are indistinguishable here and the
 *    poll path's coded-envelope classification is what decides anything about auth) falls
 *    back PERMANENTLY for the session: zero reconnect attempts, no storm. A transient stream
 *    error keeps `EventSource`'s own native reconnect and the fast poll carries the gap.
 *
 * THAT LAST SENTENCE WAS A CLAIM, AND IT WAS FALSE. The fast poll did not carry the gap: a
 * stream dying at the TRANSPORT layer rather than by status re-armed the poll on every failed
 * reconnect, three seconds apart against an eight second period, and a re-arm restarted the
 * countdown — so a live tab issued one `/api/sync` in 210 seconds and then went silent. The
 * cadence is now a FLOOR that may only ever be pulled earlier (see `armFloor`), which is what
 * makes the sentence true. The state is reached by the ordinary route too, with no fault
 * anywhere: the server cycles its streams before the platform ceiling, and a reconnect that
 * cannot land leaves the tab exactly here.
 *
 * Push is a HINT, never a data path and never a dependency: every wake funnels into the same
 * `tick()` → `engine.syncOnce()` drain the timer fires, and with SSE completely dead the
 * behaviour is byte-identical to the poll-only module this used to be — `test/sync-wake.test.ts`
 * holds that equivalence directly.
 *
 * ── WHAT THIS MODULE IS NOT ─────────────────────────────────────────────────────────────
 *
 * It is deliberately not part of `OhmailEngine`. Scheduling lives with the thing that has a
 * lifecycle to hang it on, which is the React effect. (`OhmailEngine.attachWakeSignal()` still
 * exists and is deliberately NOT used here: it nudges `syncOnce()` directly, behind the back of
 * this module's failure counting, refusal confirmation and gate claim — the wake must go
 * through the same bookkeeping as every other drain.)
 *
 * This used to add "and the engine owns no timers, so a live→demo navigation drops the reference
 * and there is nothing to cancel". That was the false half, and it cost two critical findings:
 * `syncOnce()` pages internally until `hasMore` is false, so a discarded engine can very much
 * have a ~37-page drain running inside it, and dropping the reference cancels none of it. What
 * makes the teardown correct is now {@link SyncGate}, which refuses the next page — see the
 * block above it.
 *
 * It is also not in `engine.tsx`. That file is a `"use client"` React module, and a loop
 * whose contract is "a hidden tab holds no stream and drains once a minute" has to be driven
 * by fake timers to be believed. Same reason `engine-config.ts` was carved out of the same
 * file, and its header says so: a structural assertion proves the code SAYS the right thing,
 * not that it does it.
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
   * and so that it says SOMETHING: a refusal answered with silence is how a half-hour silent
   * outage happened once. Mutually exclusive with `terminal` by construction — confirmation moves
   * the fact from one field to the other. See {@link REFUSAL_CONFIRM_MS}.
   *
   * ── AN INVARIANT THIS FIELD ONCE DEPENDED ON, NOW ENFORCED ──────────────────────────────
   *
   * `engine.tsx`'s status dedup used to compare `bootstrapping`, `failures` and `terminal` only,
   * and could not see this field, so a transition that moved ONLY `refused` would have been
   * swallowed and the strip would never appear. That was safe by coincidence alone: `refused` is
   * only ever set in the publish that increments `failures`, and only ever cleared in one that
   * zeroes `failures` or sets `terminal`. The dedup now compares all four fields through
   * {@link sameSyncStatus}, so a `refused`-only transition is no longer dropped and that
   * coincidence no longer has to hold. `test/sync-liveness.test.ts` guards both halves — the
   * comparator over a `refused`-only pair, and the scheduler's own adjacent published pairs.
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
 * Do two published statuses say the SAME thing to the shell? This is the dedup `engine.tsx`
 * uses to bail out of re-rendering the whole shell every eight seconds on a healthy tab, which
 * publishes an identical status on every settled drain.
 *
 * ALL FOUR FIELDS, deliberately. Comparing only `bootstrapping`, `failures` and `terminal` — as
 * `engine.tsx` once did inline — swallows a transition that moves only {@link SyncStatus.refused},
 * and the strip that reports an unconfirmed refusal would never appear. See that field's doc for
 * why the safety of the narrower comparison was a coincidence rather than a guarantee.
 */
export function sameSyncStatus(a: SyncStatus, b: SyncStatus): boolean {
  return a.bootstrapping === b.bootstrapping
    && a.failures === b.failures
    && a.terminal === b.terminal
    && a.refused === b.refused;
}

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
 * Eight seconds — the visible-tab cadence when NO wake stream is carrying the tab.
 *
 * Short enough that mail arriving while somebody is reading feels present, long enough that
 * a person who leaves the app open all day costs ~450 requests an hour rather than a
 * connection held open for sixty minutes of billed function time. With a healthy wake stream
 * the cadence relaxes to {@link WAKE_SAFETY_POLL_MS}; with the stream dead it is exactly this,
 * which is the "reliability unchanged with SSE dead" half of the wake slice's contract.
 */
export const POLL_MS = 8_000;

/**
 * The HIDDEN cadence: one drain a minute, no stream held.
 *
 * This replaces "a hidden tab performs ZERO syncs", on purpose. Zero was the correct floor
 * while every request was unaccompanied cost; what it bought was a mailbox that is always
 * stale at the moment of return. A minute is the deliberate compromise: ~60 requests/hour
 * keeps the mirror warm for the tab-switch that is coming, and a tab nobody ever returns to
 * still costs an order of magnitude less than a visible one. The stream is CLOSED while
 * hidden — a background tab must not pin a server connection whose whole justification is
 * somebody watching the screen.
 */
export const HIDDEN_POLL_MS = 60_000;

/**
 * The SAFETY cadence while a wake stream is open and healthy.
 *
 * Not a data path — the stream's `sync` frames are what make mail prompt — and not
 * decorative either: a stream can die silently (a proxy buffering, a suspended instance whose
 * LISTEN went with it), and the server's own push source is explicitly lossy. This poll bounds
 * how stale that worst case can get to ninety seconds, for ~40 requests/hour. It is what
 * makes the push a HINT rather than a dependency.
 */
export const WAKE_SAFETY_POLL_MS = 90_000;
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
   cold Cloud account's first drain is ~37 pages. The scheduler decides whether a drain STARTS;
   nothing decided whether it CONTINUES, so closing this loop down thirty seconds into a
   bootstrap left every remaining page to be issued anyway. Teardown had the hole in its purest
   form: `stopped` stops the timer, not the loop already inside the engine — a live→demo
   navigation swapped the engine and the DISCARDED one kept paging from behind a page whose
   whole promise is that nothing leaves the tab.

   The page boundary is the ENGINE'S TRANSPORT — `adapter.sync()`, called once per page — so
   that is where the check belongs. A gate wraps the adapter at construction and refuses the
   next page once the scheduler is gone (or its session is terminally refused); the refusal
   throws out of `drain()` and the loop stops with the pages it already applied persisted,
   exactly as a network failure mid-drain already does. The cursor is per-page, so the next
   drain resumes rather than restarts.

   THE GATE NO LONGER READS VISIBILITY, and that is the wake slice's reversal carried to its
   consequence: a hidden tab is entitled to its once-a-minute drain, so "hidden" cannot also
   mean "abort between pages" — the predicate that starts a hidden drain and the predicate that
   continues one have to agree, or the hidden cadence would start drains only to cancel their
   second page. What the gate still refuses — teardown, terminal — it refuses identically.

   `mutate()` is DELIBERATELY NOT GATED. A mutation is the user's own intent and must reach the
   server whatever the tab is doing; the cost objection is about polling, not about the click
   somebody just made. */

/**
 * A drain was cancelled between pages. Not a failure: it must not count against the backoff,
 * must not be reported as an error, and must not arm a retry — a torn-down scheduler has
 * nothing to resume, and a replacement scheduler's first tick resumes from the cursor.
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
        // `test/engine-armed.test.ts` and `test/demo-zero-network.test.ts` both check exactly that, and a
        // gate that hid the transport would have quietly turned their control cases into
        // tautologies. See {@link transportOf}.
        transport: adapter,
        sync: async (params: SyncParams): Promise<SyncResponse> => {
          if (mayContinue && !mayContinue()) {
            throw new SyncAbortedError("its sync loop was torn down or its session terminally refused");
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
         * stop a DISCARDED engine paging through a thirty-seven page bootstrap on behalf of
         * nobody — which is a different shape of cost entirely.
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
         * `test/thread-bodies-wired.test.ts` builds the real engine through `createEngine` and counts
         * the requests.
         *
         * Unconditionally would be the opposite failure: a `FixturesAdapter` behind this gate
         * claiming a batch endpoint it has no server for, and `?demo=1` issuing a request on the
         * first thread anybody opens.
         */
        ...(adapter.fetchBodies ? { fetchBodies: adapter.fetchBodies.bind(adapter) } : {}),

        /*
         * FORWARDED, NOT GATED — the same rule as `fetchBody` above: one request per settled
         * query, from a tab the user is looking at, bounded by the act of typing. The gate is
         * about a DISCARDED engine paging through a bootstrap on behalf of nobody, which this
         * is not.
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
         * crashed before its last page, or the 410 branch. So the user's-own-intent argument
         * that exempts the others points the other way here: a DISCARDED engine paging through
         * a whole snapshot is exactly what this gate exists to refuse.
         *
         * It is nevertheless NOT gated in this literal, and that is deliberate rather than an
         * omission. The engine calls `snapshot()` from `runSnapshot()`, whose page-1 failure
         * path LATCHES "this route is unusable" and silently falls back to `since=0`; a
         * `SyncAbortedError` thrown from here on page 1 would be swallowed as that latch and
         * the tab would spend the rest of its life on the old bootstrap path. Page 2 onwards
         * would be worse — `runSnapshot` rethrows there, which is correct for a network
         * failure and wrong for a cancellation, and the drain would count it against the
         * backoff. The gate on `sync()` already bounds the drain: the delta pages that follow
         * the snapshot refuse, and a torn-down loop stops there.
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
         * `test/snapshot-wired.test.ts` builds the real live engine through `createEngine` so that
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
         * The gate is about a DISCARDED engine paging through a bootstrap on behalf of nobody.
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
         * intent in a tab they are looking at. The gate is about a DISCARDED engine paging
         * through a bootstrap on behalf of nobody; a person pressing a PDF is the opposite of
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
         * bug `transport` exists to keep visible, and `test/attachments-wired.test.ts` builds the
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

/**
 * What the scheduler needs of an `EventSource`, and nothing it does not — a browser
 * `EventSource` satisfies this structurally, and a test drives a hand-made one with fake
 * timers, which is the only way "no stream held while hidden" can be believed.
 *
 * The three events read are the protocol's own: `open` (the stream is live — relax the poll,
 * and drain once to cover whatever committed while disconnected), `sync` (the server's
 * content-free wake frame: drain now), and `error`, whose meaning splits on `readyState` —
 * {@link WAKE_STREAM_CLOSED} is a terminal refusal (`EventSource` stops reconnecting on any
 * non-200, and so does this module, permanently for the session), anything else is a transient
 * the browser is already retrying natively.
 */
export interface WakeStreamLike {
  readonly readyState: number;
  addEventListener(type: "open" | "sync" | "error", listener: () => void): void;
  close(): void;
}

/** `EventSource.CLOSED` — the readyState after a terminal (non-200) failure. */
export const WAKE_STREAM_CLOSED = 2;

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
  /**
   * Opens the wake stream — `() => new EventSource("/api/events")` on the live web build
   * (`engine-config.ts` decides). Absent or `null` ⇒ this scheduler is poll-only, which is
   * the desktop build (its API is the local sidecar, which serves no `/events`), the demo
   * (never scheduled at all), and every environment with no `EventSource`. Called on start
   * and again on each return to visibility; never again after a terminal refusal.
   */
  wake?: (() => WakeStreamLike) | null;
  /** The hidden cadence; {@link HIDDEN_POLL_MS} unless a test shrinks it. */
  hiddenPollMs?: number;
  /** The safety cadence under a healthy stream; {@link WAKE_SAFETY_POLL_MS} unless a test shrinks it. */
  wakeSafetyPollMs?: number;
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
 * ── CORRECTED: THAT LAST SENTENCE WAS FALSE AS WRITTEN ──────────────────────────────────
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
 * ── A HIDDEN TAB HOLDS NO STREAM AND DRAINS ONCE A MINUTE ───────────────────────────────
 *
 * This section said "a hidden tab performs ZERO syncs — not 'fewer' and not 'cheaper ones'",
 * and the wake slice reversed it: hiding the tab now closes the wake stream (a background tab
 * must not pin a server connection) and slows the timer to {@link HIDDEN_POLL_MS}, so the
 * mailbox is at most a minute stale when somebody comes back to it. Coming back is still
 * instant — `visibilitychange` drains immediately and reopens the stream — and so is regaining
 * the network, via `online`; neither wake accelerates a HIDDEN tab past its cadence.
 *
 * What did NOT move is teardown, and the {@link SyncGate} exists for it: `stopped` cancels a
 * drain between pages rather than merely stopping to care — a live→demo navigation aborts the
 * discarded live engine's drain instead of letting it finish paging from behind a page that
 * promises zero egress. The gate deliberately no longer reads visibility: the loop that STARTS
 * a hidden drain cannot share a predicate with one that would cancel its second page.
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
  const hiddenPollMs = options.hiddenPollMs ?? HIDDEN_POLL_MS;
  const wakeSafetyPollMs = options.wakeSafetyPollMs ?? WAKE_SAFETY_POLL_MS;
  const wakeFactory = options.wake ?? null;
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
  /**
   * WHEN the armed timer is due to fire. Meaningless while `timer === null`.
   *
   * It exists so {@link armFloor} can tell "nothing is coming" from "something sooner is already
   * coming", which `timer !== null` cannot. See the floor's own block for what that cost.
   */
  let timerDueAt = 0;
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
   * `BACKOFF_CAP_MS`, shared by ALL wake sources, because `online` can fire repeatedly on a flaky
   * network and a wake stream's `open` fires on every reconnect. Worst case for a revoked,
   * visible, focus-flapped tab is ~60 req/hr against a healthy tab's ~450. A hidden tab issues
   * zero (`wake()` refuses to probe a tab nobody is looking at — and terminal tabs hold no
   * hidden-cadence timer either, so nothing else asks), and an abandoned visible tab issues
   * zero after the first — probes fire on wake EVENTS, never on a timer. A terminal-mode
   * timer would re-open the abandoned-tab hole this latch exists to close.
   *
   * That last sentence is about the TERMINAL-MODE probe and is unchanged. `refusedAt`'s confirm
   * drain does run on a timer, and it is not the thing being forbidden here: it is pre-terminal,
   * it arms at most once per refusal episode, and it ends in either a healthy poll or `terminal`
   * with no timer at all. An abandoned visible tab pays one extra request, once, for ever.
   */
  let lastProbeAt = 0;

  // No `document` at all (SSR, a non-browser host) is treated as visible: the hidden cadence
  // exists for hidden TABS, and something with no visibility model has none to hide.
  const visible = (): boolean => visibility === null || visibility.visibilityState === "visible";

  /**
   * "May a request be issued right now?" — the ONE predicate, read at every await boundary:
   * before a drain starts, after hydration's await, and — via {@link SyncGate} — before every
   * page of a drain already in flight.
   *
   * It DELIBERATELY does not read visibility any more (the wake slice's reversal): a hidden
   * tab is entitled to its once-a-minute drain, so hidden cannot also mean "refuse the next
   * page". What it still refuses is a torn-down scheduler and a terminally refused session,
   * for which no cadence is the right cadence.
   */
  const mayRequest = (): boolean => !stopped && (!terminal || revalidating);

  /** The wake stream, when this build has one and the tab is visible. */
  let stream: WakeStreamLike | null = null;
  /** The stream has OPENED and not since errored — the state that relaxes the poll. */
  let streamOpen = false;
  /**
   * The stream was refused TERMINALLY (`readyState` CLOSED after `error`: any non-200 — the
   * flag off, capacity, an auth refusal; `EventSource` exposes no status so they are one case
   * here). Permanent for the session: zero reconnect attempts, no storm, and nothing about
   * auth is concluded from it — the poll path's coded envelopes decide that, and only they.
   */
  let streamDead = false;
  /**
   * A wake arrived while a drain was in flight. Exactly ONE follow-up drain is armed when the
   * drain settles cleanly — a commit that landed after the in-flight drain's read would
   * otherwise wait out the whole safety cadence. One, not N: the follow-up reads everything.
   */
  let pendingWake = false;

  const closeStream = (): void => {
    const s = stream;
    stream = null;
    streamOpen = false;
    try {
      s?.close();
    } catch {
      /* closing a stream twice is not an event */
    }
  };

  const connectStream = (): void => {
    if (!wakeFactory || streamDead || stopped || stream !== null || !visible()) return;
    try {
      const s = wakeFactory();
      stream = s;
      s.addEventListener("open", () => {
        if (stream !== s || stopped) return;
        streamOpen = true;
        // Drain once on every open, not only the first: a reconnect (the server cycles streams
        // before its platform ceiling; a network blip) is a window in which wakes were missed,
        // and this is what closes it. Bounded by the server's retry hint, so it cannot storm.
        wake();
      });
      s.addEventListener("sync", () => {
        if (stream !== s || stopped) return;
        wake();
      });
      s.addEventListener("error", () => {
        if (stream !== s || stopped) return;
        streamOpen = false;
        if (s.readyState === WAKE_STREAM_CLOSED) {
          // Non-200: EventSource will not reconnect, and neither will this module — permanent
          // fallback to polling for the session. WHICH refusal it was is deliberately not asked
          // (no status is exposed); an auth-dead session is detected by the poll path's coded
          // envelopes, never inferred from a stream failure.
          closeStream();
          streamDead = true;
        }
        // WHATEVER THE FAILURE — coded refusal, transport death, a reconnect that cannot land,
        // a mid-stream abort — the floor comes back to the cadence for the CURRENT state: a
        // timer armed at the safety cadence would otherwise honour a stream that is no longer
        // listening. Through `armFloor`, and never `arm`, because this fires once per reconnect
        // attempt and `arm` would restart the countdown each time — see the floor's block.
        armFloor();
      });
    } catch {
      // No EventSource in this environment, or a factory that cannot build a listenable
      // stream: this session is poll-only. The whole construction is inside the try so a
      // half-built stream cannot crash the scheduler that was promised push is only a hint.
      closeStream();
      streamDead = true;
    }
  };

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
    timerDueAt = Date.now() + ms;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, ms);
  };

  /** The cadence a SETTLED, healthy drain arms: the three-state model in one expression. */
  const steadyDelay = (): number => {
    if (!visible()) return hiddenPollMs;
    return streamOpen ? wakeSafetyPollMs : pollMs;
  };

  /* ════════════════════════════════════════════════════════════════════════════════════════
     THE POLL FLOOR, AND WHY IT MAY ONLY EVER BE PULLED EARLIER
     ════════════════════════════════════════════════════════════════════════════════════════

     A floor is a BOUND ON STALENESS. Every other timer in this loop is a schedule — a cadence,
     a backoff step, a confirm window — and `arm()` is right for those: it disarms and re-sets,
     because the new schedule replaces the old one. Re-arming a floor with it is a category
     error, and one that shipped: `arm()` throws away the countdown that was already running, so
     a floor re-armed more often than its own period NEVER FIRES.

     ── MEASURED IN PRODUCTION, NOT REASONED ABOUT ──────────────────────────────────────────

     The stream's `error` handler used to re-arm the fast poll directly. With `/api/events`
     killed at the TRANSPORT layer (a proxy dropping SSE, a dead network, a blocked request),
     `EventSource` retries on the server's `retry: 3000` hint and fires `error` on every failed
     attempt — three seconds apart, against an eight second poll. The live tab issued EXACTLY
     ONE `/api/sync` in 210 seconds and then none, through ~100 reconnect attempts, with a
     127-second-old mutation still not on screen and nothing in the UI saying so. The same tab
     reached the same state without any network fault at all, by the ordinary route: the server
     cycles a stream at 270 s, and if the reconnect cannot land, the poll is starved from there.

     The defect was NOT that the handler failed to re-arm. It re-armed about seventy times. It
     is that "re-arm" meant "restart the countdown", so the sicker the stream got, the harder
     the floor was held down — precisely backwards, and invisible to a test that fires one
     `error` and waits, which is what the suite had.

     ── THE RULE ────────────────────────────────────────────────────────────────────────────

     `armFloor()` GUARANTEES a drain is pending no later than the current state's cadence and is
     otherwise a no-op. It never delays a drain that is already sooner, so it is safe to call on
     every stream event, however many arrive, and the caller does not have to know what else the
     machine has armed. What it will not do is override the paths that own their own timing for
     reasons stronger than staleness: a backoff (`failures > 0`) is already a bounded retry and
     stomping it would turn one dead stream into an 8-second hammer on a mailbox that is failing
     anyway; a refusal window is a contract with a claim the server made; `terminal` deliberately
     holds no timer; and a running drain arms from its own settle, one line later, at the same
     cadence this would have chosen. */
  const armFloor = (): void => {
    if (stopped || terminal || running || refusedAt !== null || failures > 0) return;
    const ms = steadyDelay();
    if (timer !== null && timerDueAt <= Date.now() + ms) return;
    arm(ms);
  };

  /** A hidden tab never retries FASTER than its own cadence, whatever the backoff drew. */
  const pacedBackoff = (): number => {
    const d = backoffDelay(failures, { base, cap, random });
    return visible() ? d : Math.max(d, hiddenPollMs);
  };

  async function tick(): Promise<void> {
    if (stopped || running) return;
    if (terminal && !revalidating) return;
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
        // before its first `/sync`. The scheduler can be TORN DOWN underneath it — a live→demo
        // navigation swaps the engine and runs this cleanup, and the discarded LIVE engine
        // then called `/sync` from behind a page whose whole promise is that nothing leaves
        // the tab. (This check used to cover a mid-hydration HIDE as well; a hidden tab is
        // now entitled to its drain, so teardown and terminal are what remain.)
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
      arm(steadyDelay());
    } catch (err) {
      if (stopped) return;
      if (isAborted(err)) {
        // The gate cancelled this drain between pages — a teardown racing the loop, or a
        // terminal latch landing mid-drain. Not a failure: no count, no report, no retry
        // armed; whatever cancelled it owns what happens next.
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
      arm(pacedBackoff());
    } finally {
      running = false;
      publish();
      if (pendingWake) {
        pendingWake = false;
        // The queued follow-up, and only after a CLEAN settle in a state where an immediate
        // drain is legitimate: a failure's backoff owns the retry (honouring a wake there
        // would let a wake burst defeat the backoff), a refusal window owns its confirm, and
        // a hidden tab owns its cadence. The follow-up reads everything, so one is enough.
        if (!stopped && !terminal && refusedAt === null && failures === 0 && visible()) {
          arm(0);
        }
      }
    }
  }

  /**
   * A drain NOW: the tab came back, the network did, or the stream said something committed.
   *
   * Every wake source funnels here — `visibilitychange`, `online`, the stream's `open` and
   * `sync` events — so the bookkeeping (refusal windows, terminal probes, the hidden cadence)
   * is applied once, identically, whatever woke us. A wake DURING a drain queues exactly one
   * follow-up (see `pendingWake`); a wake on a HIDDEN tab never accelerates it past its own
   * cadence — the hidden state's whole contract is "once a minute, whatever happens".
   */
  const wake = (): void => {
    if (stopped) return;
    if (running) {
      pendingWake = true;
      return;
    }
    if (terminal) {
      if (!visible()) return;                 // probes are for tabs somebody is looking at
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
      // So this only RE-ARMS what is left of the window (the timer now survives a hide — the
      // hidden state holds timers — but a stream `open` or an `online` flap still lands here
      // and must not move the ask). Clamped at zero so a window that has already elapsed asks
      // immediately.
      arm(Math.max(0, refusedAt + REFUSAL_CONFIRM_MS - Date.now()));
      return;
    }
    if (!visible()) {
      // A hidden tab advances on its own cadence and nothing accelerates it: `online` firing
      // behind a hidden tab (a laptop rejoining wifi in a bag) must not buy a drain nobody is
      // there for. The timer is normally already armed; this only repairs the edge where a
      // wake finds a hidden tab with nothing armed at all.
      if (timer === null) arm(hiddenPollMs);
      return;
    }
    void tick();
  };

  /**
   * Going hidden CLOSES THE STREAM and slows the pending poll to the hidden cadence; coming
   * back reopens the stream and drains at once. The refusal-confirm window is deliberately
   * left alone in both directions — its timing is a contract with the server's claim — and a
   * terminal tab holds no timer whatever the visibility does.
   */
  const onVisibility = (): void => {
    if (visible()) {
      connectStream();
      wake();
    } else {
      closeStream();
      // The hidden cadence is the one re-arm that legitimately pushes a drain OUT (8 s → 60 s),
      // so it cannot go through `armFloor`. It is no longer conditional on a timer already
      // being armed, though: that read as "slow down whatever is pending" and silently meant
      // "and if nothing is pending, leave the tab with no timer at all" — the same assumption
      // that starved the stream-error path. Hiding a tab must LEAVE it on a cadence, not
      // depend on having found one.
      if (!running && !terminal && refusedAt === null) arm(hiddenPollMs);
    }
  };

  visibility?.addEventListener("visibilitychange", onVisibility);
  online?.addEventListener("online", wake);

  connectStream();
  publish();
  void tick();

  return () => {
    stopped = true;
    disarm();
    closeStream();
    visibility?.removeEventListener("visibilitychange", onVisibility);
    online?.removeEventListener("online", wake);
  };
}
