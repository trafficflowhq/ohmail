import {
  MutationRejectedError,
  type EngineAdapter,
  type ListOlderFn,
  type ListTrashFn,
  type MessageBodyWire,
  type MutationOutcome,
  type OhmailEngine,
  type RestoreFromTrashFn,
  type SnapshotFn,
  type SyncParams,
  type SyncResponse,
} from "@ohmail/client-engine";
import { readOwnerMarker, type OwnerMarker } from "./owner-cookie";

/**
 * The wake signal this app did not have — `engine.start()` once was every drain a tab ever performed (new mail needed a reload; one transient throw left an empty mailbox; a 37-page
 * bootstrap rendered "0 unread of 0"). Three states: VISIBLE with a healthy SSE stream — the stream is the wake (a `sync` frame drains through the same serialized path), the poll drops to
 * a slow safety cadence ({@link WAKE_SAFETY_POLL_MS}) bounding what a silently dead stream could cost; HIDDEN — no stream held, one drain a minute ({@link HIDDEN_POLL_MS}); stream REFUSED
 * or failing — the 8 s poll ({@link POLL_MS}), with a terminal stream refusal falling back permanently for the session (no reconnect storm). The poll cadence is a FLOOR that may only be
 * pulled earlier (`armFloor`): re-arming on every failed reconnect once left a live tab issuing one `/api/sync` in 210 seconds. Push is a hint, never a data path: every wake funnels into
 * the same `tick()` → `engine.syncOnce()`, and with SSE dead the behaviour is byte-identical to poll-only (`test/sync-wake.test.ts`). Not part of `OhmailEngine` (scheduling hangs on the
 * React effect's lifecycle; `attachWakeSignal()` is deliberately unused — it bypasses the failure counting and gate claim), and not in `engine.tsx` (this loop is believed under fake
 * timers). Teardown correctness is {@link SyncGate}: `syncOnce` pages internally, and dropping the reference cancels nothing.
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
   * Our API refused this session ONCE, and the claim has not been re-made. The shell must not
   * tell a signed-in user to sign in on this; it is published so the strip says the weaker true
   * thing ("Sync failed. Retrying.") instead of the stronger unverified one — and says
   * SOMETHING: a refusal answered with silence was once a half-hour silent outage. Mutually
   * exclusive with `terminal` by construction ({@link REFUSAL_CONFIRM_MS}). The status dedup
   * compares all four fields through {@link sameSyncStatus} — it used to miss this one and
   * survived only because `refused` happened to move with `failures`;
   * `test/sync-liveness.test.ts` guards both halves.
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
 * How many consecutive failures the user hears about. One is a blip and the loop is back inside
 * two seconds; three is ~7 s at the 1/2/4 s ceilings, inside one backoff cap — with the network
 * down, the UI says so within a cap. It lives here because two surfaces read it: the strip and
 * the bootstrap counter, which must stop claiming progress at the same moment. A coded refusal
 * is not subject to it: {@link SyncStatus.refused} is published on the FIRST refusal, so the
 * strip speaks immediately — a statement our own API made about this identity is not a dropped
 * packet — while the strong claim (`terminal`) waits behind confirmation ({@link
 * REFUSAL_CONFIRM_MS}).
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
 * The hidden cadence: one drain a minute, no stream held. Replaces "a
 * hidden tab performs ZERO syncs" on purpose — zero was the right floor
 * when every request was unaccompanied cost, and it bought a mailbox always
 * stale at the moment of return. A minute is the compromise: ~60
 * requests/hour keeps the mirror warm for the tab-switch that is coming,
 * an order of magnitude under a visible tab. The stream is closed while
 * hidden: a background tab must not pin a server connection whose whole
 * justification is somebody watching the screen.
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
 * How long a coded refusal must stand before the app calls it a revoked session. One coded 401 used to latch
 * `terminal` — a `role="alert"` telling a signed-in user to sign in on evidence one request old, which then
 * cleared itself. The first refusal now stops the poll and arms exactly one further ask this far out: success ⇒
 * nobody is told anything; the same refusal ⇒ the server re-made the claim. What this removes is refusals shorter
 * than a minute; a multi-minute alias window still reaches STOPPED, and the wake probe covers that one (a
 * hide/show clears a false latch). It is `BACKOFF_CAP_MS`, not a number of its own: one bounded retry unit to
 * reason about. And it is not the timer the terminal rule forbids: this is PRE-terminal and arms at most once per
 * episode — after the latch there is no timer at all.
 */
export const REFUSAL_CONFIRM_MS = BACKOFF_CAP_MS;

/**
 * How long a coded refusal must be SUSTAINED — re-made on every confirm ask — before `terminal` latches. Set
 * by an incident (live install, 2026-08-21): a ~6-minute deploy window answered coded 401s, the single
 * confirm ask landed inside it, and a valid subscriber sat behind "Sync stopped. Quit and reopen ohmail." — a
 * minute of corroboration cannot distinguish "revoked" from "mid-deploy". Ten minutes is past every deploy
 * blip measured here (5–6 min) with the genuine-revocation cost bounded: a revoked visible tab asks 1 +
 * sustain/confirm = 11 times over ten minutes, once per episode, then zero for ever (a healthy tab asks
 * ~450/h). Unchanged: `terminal` holds no timer, the wake probe disproves a stale latch, and non-coded
 * failures ride the ordinary backoff, which never gives up.
 */
export const REFUSAL_SUSTAIN_MS = 10 * 60_000;

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
 * Jitter over a doubling ceiling, with a FLOOR — `floor + random() * (ceiling - floor)`. Plain
 * full jitter (`random() * ceiling`) is false at the far end: the floor was zero at every
 * ceiling, so a permanently failing drain at the 60 s cap could draw 0 ms repeatedly — with a
 * permanent `410 CursorExpired` each drain costs two requests, so the degraded state a mail
 * client should sit in forever could spin at whatever rate the network allows, billed to an
 * abandoned tab. The floor is `max(250 ms, ceiling / 4)`, widening with the outage: [250 ms, 1
 * s] at first failure, [15 s, 60 s] at the cap. Full jitter's benefit is kept — N
 * knocked-offline tabs still do not return in a wave.
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

/* Aborting a drain between pages. `engine.syncOnce()` loops internally
   while `hasMore` (a cold account's first drain is ~37 pages); the    scheduler decides whether a drain STARTS, and nothing decided whether it
   CONTINUES — a live→demo navigation swapped the engine and the discarded
   one kept paging behind a page that promises nothing leaves the tab. The    page boundary is the engine's transport (`adapter.sync()`, once per
   page), so a gate wraps the adapter at construction and refuses the next
   page once the scheduler is gone or terminally refused; the refusal throws    out of `drain()` with applied pages persisted, and the per-page cursor
   resumes. The gate no longer reads visibility: a hidden tab is entitled to    its once-a-minute drain, so the start and continue predicates must agree.
   `mutate()` is NOT gated on cadence (a mutation is the user's own intent)    but IS gated on identity: sending A's archive under B's session acts on
   the wrong account AND writes the answer into A's mirror — `guard().mutate`
   refuses it RETRYABLY so the verb is flushed later, not discarded. */

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
 * A READ was refused because this browser's session belongs to a different account than the
 * mirror on screen. Not a cancellation and not a network failure: a positive refusal.
 *
 * ── WHY IT IS ITS OWN CLASS AND NOT {@link SyncAbortedError} ────────────────────────────────
 *
 * `SyncAbortedError` means "the drain stopped between pages", and the scheduler's own catch
 * reads it that way — no failure count, no report, no retry armed. A body fetch, a search or a
 * page of older mail is none of those things: it is one request a person made, and it has to
 * surface to that person as a failure they can see rather than be swallowed as a cancellation
 * of a loop they never started. Reusing the sync class here would make the scheduler's catch
 * silently correct for the wrong reason and would put a false sentence ("aborted before the
 * next page") on a request that has no pages.
 *
 * Every consumer already has a path for a rejected read — these are HTTP calls that can 500 —
 * so this arrives as the failure state that path already renders.
 */
export class ForeignSessionError extends Error {
  readonly code = "foreign_session";
  constructor(what: string) {
    super(`ohmail: refused ${what} — this browser's session now belongs to another account`);
    this.name = "ForeignSessionError";
  }
}

/**
 * The per-page continuation gate — built beside the engine's adapter,
 * claimed by the scheduler. A gate nobody has claimed never refuses ON
 * CADENCE, so the demo engine, the desktop bundle and a bare
 * `engine.start()` keep their timing. IDENTITY is the exception, and has to
 * be: a gate built for a NAMED mirror refuses to sync or mutate until
 * somebody says whose mailbox it is, claimed or not — the claim is about
 * when a loop may run, identity is about whose bytes these are. An
 * unclaimed gate that merged freely would leave `engine.start()` an ungated drain into a named mirror.
 */
/**
 * The two capabilities `EngineAdapter` does not declare. `snapshot` and
 * `listMessages` are structural in `@ohmail/client-engine` — the engine
 * reaches for them on the adapter and treats absence as a real answer — so
 * an object literal that omits one still compiles, and the demo is never
 * wrapped, so the loss shows up on the live path alone. Naming them in the
 * gate's own signature turns "the wrapper forgot" from a silent behaviour
 * change into something a reader checks against a list; the imported types
 * are the package's own, so a rename over there fails here.
 */
type GatedAdapter = EngineAdapter & {
  snapshot?: SnapshotFn;
  listMessages?: ListOlderFn;
  /* The Trash pair, named here for the reason above and NOT as one field: the engine binds them
     independently, so an object literal that forwards the list and forgets the verb produces a
     Trash view whose every Restore button is dead — on the live path only. */
  listTrash?: ListTrashFn;
  restoreFromTrash?: RestoreFromTrashFn;
};

/**
 * Whose mirror is this, and may it merge? `SyncResponse` carries no account identity, so whatever session the jar holds decided what landed in the mirror
 * NAMED for the remembered account — and the confirm's comparison never re-ran at `ready`, so a tab confirmed for A whose jar was rewritten to B merged
 * B's log into A's mirror for as long as it lived. Answers: `holds` — may merge (no name, or confirmed and the jar agrees); `unconfirmed` — built CLOSED,
 * nobody has said whose mailbox this is; a forgetting path syncs nothing rather than everything, and reads are still allowed (the ordinary warm open);
 * `revoked` — was confirmed and the marker has since CHANGED: reads refuse too, the loop disarms quietly; `contradicted` — the jar positively names
 * somebody else or records an unconfirmed sign-out: latches terminal. Absence is not a contradiction — but it ENDS a confirmation (any change revokes,
 * A→B→A included): a failed sign-out's local half once erased the marker and the tab read silence as permission. A refused sign-out now writes {@link
 * OWNER_SIGNED_OUT}, which contradicts instead of being indistinguishable from silence.
 */
export type SyncIdentity = "holds" | "unconfirmed" | "revoked" | "contradicted";

/**
 * May a reader ask the server for this account's bytes, given an identity? — the rule as one
 * function, so every door is the same door. There were two copies (the adapter's inline test
 * and `syncMayRead`), they agreed, and nothing made them agree — which is how `revoked` arrived
 * in one and not the other, and how the reach-past body door and the mailbox-facts poll kept
 * reading through a lapsed grant while the adapter refused. `unconfirmed` reads TRUE, the whole
 * subtlety: it is the ordinary warm open, the mail is the person's own, and refusing would
 * blank a mailbox already on screen for the length of a round trip.
 */
export function mayReadIdentity(state: SyncIdentity): boolean {
  return state !== "contradicted" && state !== "revoked";
}

export interface SyncGate {
  /** Wrap the engine's transport. Call once, at construction, on the adapter you pass in. */
  guard(adapter: GatedAdapter): GatedAdapter;
  /** May this engine merge right now? Read before every request and at every page boundary. */
  identity(): SyncIdentity;
  /**
   * The server named this mailbox's account. Opens the gate when the name matches the mirror
   * the engine was built for, and wakes whatever registered through {@link SyncGate.onOpen}.
   */
  confirm(accountId: string): void;
  /** Run `cb` when the gate opens — the scheduler registers its `wake` here. */
  onOpen(cb: () => void): void;
  /**
   * Run `cb` when a REVOKED gate could plausibly be confirmed again — the marker has come back
   * to naming this mirror's account. The shell registers the session confirm here.
   *
   * Without it a revoked gate is a dead end: revocation is monotonic (by design — it must not
   * oscillate), `confirm` is the only way out, and nothing on a `ready` binding ever calls it,
   * because `ready` carries no owner and the confirm effect has long since finished. The tab
   * cleared its terminal strip when the contradiction went away and then sat there: no reads, no
   * sync, no mutations, no stream, and nothing on screen saying so.
   */
  onNeedsConfirm(cb: () => void): void;
  /**
   * Claim the gate for a scheduler's lifetime. There is deliberately no `release`: the
   * predicate a scheduler installs closes ITSELF once that scheduler is stopped (it reads the
   * scheduler's own `stopped` flag), so a teardown aborts its in-flight drain instead of
   * un-gating it. A remount simply claims again and its fresh predicate takes over.
   */
  claim(mayContinue: () => boolean): void;
}

/**
 * @param mirrorOwner the account this engine's mirror is NAMED for, or `null` for an
 * un-named, in-memory engine. There is deliberately NO DEFAULT: a defaulted owner would make
 * the permissive branch the one every caller gets by omission, which is the shape of failure
 * this repository keeps paying for — the shipped path becomes the one no test drives.
 */
export function createSyncGate(mirrorOwner: string | null): SyncGate {
  let mayContinue: (() => boolean) | null = null;
  /** The account the server named for this engine, or `null` while nobody has said. */
  let confirmedFor: string | null = null;
  /**
   * Has a confirmation been TAKEN BACK? The difference between "nobody has said yet" and
   * "somebody said, and then the world changed", which is the difference between a warm mirror
   * that may still answer its own reader and one that may not. Cleared only by a fresh confirm.
   */
  let revoked = false;
  const openers = new Set<() => void>();
  const reconfirmers = new Set<() => void>();
  /** Fired at most once per revocation, so a poll cannot turn into a confirm ladder per tick. */
  let askedToReconfirm = false;

  /**
   * What the marker said last time anybody looked. `undefined` means
   * nothing observed yet — not the same as `absent`: the first observation
   * establishes a baseline and cannot itself be a transition, or a gate
   * would revoke a confirmation it had just been given. Seeded at
   * construction for a named mirror, and the window that closes is real:
   * the gate is built in the same act that chooses which mirror to open,
   * so construction is when "what it said" is known — left to the first
   * `identity()` call, a change between those moments read as baseline rather than transition.
   */
  let lastSeen: OwnerMarker | undefined = mirrorOwner === null ? undefined : readOwnerMarker();

  /** Two markers, same meaning? The comparison a transition is defined against. */
  const sameMarker = (a: OwnerMarker, b: OwnerMarker): boolean =>
    a.kind === b.kind && (a.kind !== "account" || b.kind !== "account" || a.id === b.id);

  const identity = (): SyncIdentity => {
    // An un-named engine has no mirror on disk to pollute. The source guard pins that the
    // live path never passes `null`; this arm is the demo's and the desktop's.
    if (mirrorOwner === null) return "holds";

    const marker = readOwnerMarker();
    /*
     * The transition is the event, and reading is when it is noticed. A
     * cookie has no change event, so the only moment this gate can observe
     * the jar is when somebody asks it a question — and it is asked before
     * every request, at every page boundary and on every tick: exactly the
     * set of moments a stale answer could do damage. Revoking is a side
     * effect of a read, deliberately: the alternative is a separate
     * `poll()` somebody has to remember to call — the wiring-bug shape this
     * file's history is full of. Idempotent, and monotone (a revocation is undone only by `confirm`).
     */
    if (lastSeen !== undefined && !sameMarker(lastSeen, marker)) {
      lastSeen = marker;
      /*
       * ANY change revokes, including one arriving back at the confirmed
       * account: an A→B→A round trip leaves the marker reading as before, and a comparison against the mirror's name cannot see anything
       * happened — precisely the window in which a response issued under B
       * lands in A's tab. What was confirmed was "this browser is A's, NOW". And it does not wait for a confirmation to exist:
       * `if (confirmedFor !== null)` sounds tidy and is a hole — the gate
       * spends the whole confirm ladder with `confirmedFor` null while a warm mirror's reads are allowed; another tab establishes B, the
       * marker is then removed, and the change was seen and discarded while `refuseIfForeign` kept letting bodies through. So a marker change
       * latches `revoked` on a named mirror whether or not anybody confirmed it yet.
       */
      confirmedFor = null;
      revoked = true;
      askedToReconfirm = false;
    } else if (lastSeen === undefined) {
      lastSeen = marker;
    }

    // A sign-out this browser asked for and the server did not confirm. Not silence: a session
    // may still be live and it is not this window's to use. See `OWNER_SIGNED_OUT`.
    if (marker.kind === "signed-out") return "contradicted";
    if (marker.kind === "account" && marker.id !== mirrorOwner) return "contradicted";
    if (confirmedFor !== mirrorOwner) {
      if (!revoked) return "unconfirmed";
      /*
       * A REVOKED GATE WHOSE MARKER NAMES THIS MIRROR AGAIN CAN BE ASKED ABOUT.
       *
       * Revocation stays monotonic — this does not reopen anything, and only a server-confirmed
       * `confirm` does. What it does is wake the one thing that can ask, because on a `ready`
       * binding nothing else ever will: the confirm effect finished long ago and `ready` carries
       * no owner to re-compare. Once per revocation, so a tick cannot become a ladder.
       */
      if (marker.kind === "account" && marker.id === mirrorOwner && !askedToReconfirm) {
        askedToReconfirm = true;
        for (const cb of reconfirmers) cb();
      }
      return "revoked";
    }
    return "holds";
  };

  /**
   * The second rule: a contradicted browser reads nothing either. `sync`/`snapshot`/`mutate` require `holds` to
   * protect the DISK; the reads were left ungated on "A's ids 404 under B" — and the ids are the hole: a stopped
   * tab stays interactive, Search and Load-older ask for a LIST keyed on no id, B's session answers with B's rows,
   * and opening one supplies a valid B id to the body route — every byte on screen, nothing on disk (`POST
   * /sync/pull` is the same shape with a bill attached). So reads are gated on a DIFFERENT predicate:
   * `contradicted` — refuse (a present cookie naming somebody else is positive evidence); `unconfirmed` — allow
   * (absence is silence, the person is looking at their own mail, and refusing would dim the mirror — the flicker
   * this slice removes). @param what named so a console line says which door.
   */
  const refuseIfForeign = (what: string): void => {
    /*
     * `revoked` refuses alongside `contradicted`, and `unconfirmed` still does not. The three
     * are one question asked at three strengths: nobody has said yet (the warm open — the mail
     * is the person's own and refusing would blank it for a round trip); somebody said and the
     * world has since changed (the grant has lapsed, and what a read returns now is not this
     * window's business); the jar positively names somebody else or a refused sign-out.
     */
    // {@link mayReadIdentity} — the SAME function the non-adapter doors reach through
    // `syncMayRead`, not a second spelling of it. It was two spellings; they agreed, and nothing
    // held them together, which is how the fourth state ended up in one of them and not the other.
    if (!mayReadIdentity(identity())) throw new ForeignSessionError(what);
  };

  /**
   * One capability, wrapped so it asks {@link refuseIfForeign} before the
   * wire. `async` rather than a bare synchronous throw, not a style choice:
   * `adapter.fetchBody(id).catch(…)` without a surrounding `try` lets a
   * synchronous throw escape past its own error handling, so the refusal
   * would crash some call sites and be handled at others; an async wrapper
   * rejects, the one shape every consumer has a path for. Generic over the
   * signature so the capability's own types survive the wrap — a rename in
   * `@ohmail/client-engine` fails here rather than being erased into `any`.
   */
  const gatedRead = <A extends unknown[], R>(
    fn: (...args: A) => Promise<R>,
    what: string,
  ): ((...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    refuseIfForeign(what);
    const answer = await fn(...args);
    /*
     * And again when the answer lands: the check above is at REQUEST time,
     * and between it and the server reading the jar another tab can rewrite
     * it — the response belongs to whoever the jar named then, and nothing in the body says which. One check, not two: capturing the marker at
     * issue and comparing at arrival was written and removed — for a named mirror every change it could detect is one `identity()` has already
     * turned into `contradicted`/`revoked` on this same line, and for an un-named engine it must not fire at all: a guard whose verdict is
     * always somebody else's is a guard nobody can watch fail. What it does
     * NOT catch: a round trip entirely inside one flight (A→B→A) — no client-side check closes that; it needs the server to name the
     * account it answered for (a `packages/api` change, filed as its own gap row).
     */
    refuseIfForeign(what);
    return answer;
  };

  /**
   * A page of the log, wrapped — `sync`'s own rule rather than
   * {@link gatedRead}'s. Two differences, both load-bearing: it requires
   * `holds`, not merely "not contradicted", because a page of the log is
   * written straight into the mirror on disk — the one thing an unconfirmed
   * engine may never do; and it rejects with {@link SyncAbortedError},
   * which the scheduler's catch reads as "the gate cancelled this drain" —
   * no failure count, no retry armed. A {@link ForeignSessionError} there
   * would be counted as a network failure and arm a backoff for a tab that has already stopped.
   */
  const gatedPage = <A extends unknown[], R>(
    fn: (...args: A) => Promise<R>,
    what: string,
  ): ((...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    const refuse = (why: string): never => {
      throw new SyncAbortedError(`${what}: ${why}`);
    };
    if (identity() !== "holds") {
      refuse("this mirror's account is not the one this browser's session belongs to");
    }
    const page = await fn(...args);
    // {@link gatedRead}'s arrival rule, and a page needs it more than a read does: this one is
    // written STRAIGHT INTO the mirror on disk, where there is no tombstone for a row that
    // should never have arrived. Same question as the departure check, asked again — see
    // `gatedRead` for why a marker comparison beside it would be a guard that never decides.
    if (identity() !== "holds") refuse("the session changed while the page was in flight");
    return page;
  };

  return {
    identity,
    confirm(accountId) {
      confirmedFor = accountId;
      // A fresh server answer is what a revocation was waiting for. Cleared BEFORE `identity()`
      // is consulted below, or the gate would report `revoked` over the confirmation that had
      // just arrived and never wake anybody.
      revoked = false;
      // The marker as it stands at the moment of the confirmation IS the baseline this grant is
      // measured against. Without this the next read compares against a marker from before the
      // sign-in and revokes the confirmation on the spot.
      lastSeen = readOwnerMarker();
      // Only wake anybody if the confirmation actually opened the gate. A confirm naming
      // somebody else leaves it closed, which is the defence in depth behind that comparison:
      // the gate on
      // A's engine never opens for B even if the binding logic above it were ever softened.
      if (identity() === "holds") for (const cb of openers) cb();
    },
    onOpen(cb) {
      openers.add(cb);
    },
    onNeedsConfirm(cb) {
      reconfirmers.add(cb);
    },
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
          /*
           * IDENTITY FIRST, BEFORE THE CLAIM — and the order is the point. This refusal is
           * independent of whether any scheduler has claimed the gate, so the sentence above
           * ("a gate NOBODY has claimed never refuses") holds for the CADENCE predicate and
           * not for this one. An unclaimed gate on a named mirror still refuses to merge
           * another account's log; that is not a cadence question.
           */
          if (identity() !== "holds") {
            throw new SyncAbortedError(
              "this mirror's account is not the one this browser's session belongs to",
            );
          }
          if (mayContinue && !mayContinue()) {
            throw new SyncAbortedError("its sync loop was torn down or its session terminally refused");
          }
          const page = await adapter.sync(params);
          // {@link gatedRead}'s arrival rule. A delta page is written straight into the mirror on
          // disk, so an answer that turns out to have been issued under another session must not
          // be applied — and the mirror keeps no tombstone for a row that never belonged.
          if (identity() !== "holds") {
            throw new SyncAbortedError("the session changed while the page was in flight");
          }
          return page;
        },
        /**
         * GATED ON IDENTITY, AND ONLY ON IDENTITY — which reverses one sentence of the rule
         * above and leaves the rest of it standing.
         *
         * "A mutation is the user's own intent and must reach the server whatever the tab is
         * doing" is still true of CADENCE: a hidden tab, a torn-down loop, a backoff — none of
         * those may swallow a click. It is not true of identity. A mutation's outcome is
         * applied to the mirror when it returns, so sending A's archive under B's session both
         * acts on the wrong account's server state and writes the answer into A's mirror.
         *
         * REJECTED AS RETRYABLE, deliberately: the engine keeps a retryable rejection queued
         * under the same idempotency key and flushes it once the gate opens, so the verb the
         * person pressed happens exactly once, under the right session, later. A plain `Error`
         * here would be read as non-retryable and the overlay rolled back — the click silently
         * discarded, which is the worse failure of the two.
         */
        mutate: async (m, opts): Promise<MutationOutcome> => {
          const refuse = (): never => {
            throw new MutationRejectedError(
              "ohmail: this mailbox is not the account this browser is signed in to",
              { retryable: true },
            );
          };
          if (identity() !== "holds") refuse();
          const outcome = await adapter.mutate(m, opts);
          /*
           * AND AGAIN ON THE WAY BACK, which matters more here than anywhere else on this list.
           * A mutation's outcome is APPLIED to the mirror, so an answer issued under another
           * session both acted on the wrong account's server state and would write the result
           * into this one's. Retryable, as at the top: the verb stays queued under the same
           * idempotency key and is flushed once the gate opens, so the click happens exactly
           * once, under the right session, later.
           */
          if (identity() !== "holds") refuse();
          return outcome;
        },
        /**
         * FORWARDED, NOT GATED ON CADENCE, REFUSED WHEN CONTRADICTED.
         *
         * A body fetch happens because somebody selected a message, expanded a card, or
         * opened a Screener row. It is the user's own intent, in a tab they are looking at,
         * and it is bounded by that act: one request per message opened. The cadence gate
         * exists to stop a DISCARDED engine paging through a thirty-seven page bootstrap on
         * behalf of nobody — which is a different shape of cost entirely.
         *
         * Identity is the other question, and the answer here is `refuseIfForeign`'s: the id
         * this request carries is only trustworthy while the session answering it belongs to
         * the mirror that supplied the id. Once the jar names somebody else, a list this tab
         * has already rendered can hand the body route an id that IS valid — for them — and
         * the reply is their mail, in full, on this screen. See {@link refuseIfForeign}.
         *
         * It must be forwarded rather than omitted: a wrapper that dropped it would leave
         * the engine with `adapter.fetchBody` undefined on the LIVE path only — the demo is
         * unwrapped — so every live account would render snippets again while the whole
         * suite stayed green. This is exactly the class of wiring bug the `transport` field
         * below exists to keep visible.
         */
        fetchBody: gatedRead(
          (messageId: string): Promise<MessageBodyWire | null> => adapter.fetchBody(messageId),
          "a message body",
        ),

        /*
         * ── THE THREAD OPEN — FORWARDED, NOT GATED, AND SPREAD ────────────────────────────
         *
         * `GET /messages/bodies?ids=…`: every sibling of the conversation being opened, in one
         * request instead of one per message.
         *
         * NOT GATED ON CADENCE, on `fetchBody`'s own argument — it fires because somebody
         * opened a thread, in a tab they are looking at, and it is bounded by that act. It is
         * in fact the LEAST speculative call on this list: one request for what used to be N.
         * REFUSED WHEN CONTRADICTED, on `fetchBody`'s other argument, and more sharply: this
         * one returns N bodies per call rather than one.
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
        ...(adapter.fetchBodies
          ? { fetchBodies: gatedRead(adapter.fetchBodies.bind(adapter), "a thread's message bodies") }
          : {}),

        /*
         * FORWARDED, NOT GATED ON CADENCE, REFUSED WHEN CONTRADICTED — `fetchBody`'s rule,
         * both halves. One request per settled query, from a tab the user is looking at,
         * bounded by the act of typing; the cadence gate is about a DISCARDED engine paging
         * through a bootstrap on behalf of nobody, which this is not.
         *
         * And this is the door the identity half was WRITTEN for. A search is the one read
         * whose result is not keyed on anything this mirror already holds: it asks the server
         * for a list, so a foreign session answers it with a foreign list, and the ids in that
         * list then unlock every other read. See {@link refuseIfForeign}.
         *
         * SPREAD rather than always defined, and that is the whole point: an adapter WITHOUT
         * the capability must keep not having it, because the surface reads absence as "this
         * client cannot reach the archive" and says so. Defining it unconditionally would
         * make the demo claim an archive it has no server for — and would do it on the live
         * path only, which is the wiring bug `transport` exists to keep visible.
         */
        ...(adapter.searchServer
          ? { searchServer: gatedRead(adapter.searchServer.bind(adapter), "a server-side search") }
          : {}),

        /*
         * ── THE ARCHIVE'S ADDRESS ARM — the same door, forwarded on the same terms ─────────
         *
         * `GET /search?address=&direction=from`, behind the address view. Every argument the
         * paragraph above makes applies unchanged: one request per opened view, from a tab the
         * user is looking at; and the same identity half, because this too asks the server for a
         * LIST of ids rather than for something keyed on what the mirror already holds.
         *
         * SPREAD, and forwarded SEPARATELY from `searchServer` rather than beside it in one
         * condition. Two capabilities, resolved independently by the engine, and an adapter can
         * legitimately have one: pairing them here would define this one on the strength of the
         * other being present, which is exactly the shape that makes a surface claim an archive
         * it cannot reach — and it would do it only on the live path.
         */
        ...(adapter.searchAddressServer
          ? {
            searchAddressServer: gatedRead(
              adapter.searchAddressServer.bind(adapter), "a server-side address search",
            ),
          }
          : {}),

        /*
         * ── THE WORKER DOORBELL — FORWARDED, NOT GATED, AND SPREAD ────────────────────────
         *
         * `POST /sync/pull`: the "Pull new mail" press asking the worker to scan IMAP now.
         *
         * NOT GATED ON CADENCE, on `fetchBody`'s own argument sharpened: it fires on a
         * deliberate press, in a tab the user is looking at, and it is bounded twice over —
         * once by the act, and once by the route's own 5 s per-mailbox rate limit. The cadence
         * gate is about a DISCARDED engine paging through a bootstrap on behalf of nobody; a
         * person pressing "Pull new mail" is the opposite of that.
         *
         * REFUSED WHEN CONTRADICTED, and this one is not about bytes at all. Every read on this
         * list can only show the wrong account's mail; this WRITES — the route stamps every
         * mailbox on the answering session's account and wakes worker-side IMAP work for it. A
         * press in a stale tab therefore bills and acts on an account nobody in this tab is,
         * and the person pressing it cannot see that they did. The strip already says this
         * mailbox has stopped syncing; the button behind it must not be the exception.
         *
         * SPREAD, NOT ALWAYS-DEFINED: `OhmailEngine.pullAvailable()` is how the control decides
         * to render at all, and it reads the adapter's own optional capability. Defining this
         * unconditionally would make a `FixturesAdapter` behind a gate claim a doorbell it has
         * no worker for.
         *
         * FORWARDED AT ALL — and this line is a REPAIR, not a precaution: the pull affordance
         * shipped (2026-08-26) without it, and `OhmailEngine.requestPull` reads an absent
         * capability as "this world has no worker to hurry" and returns null WITHOUT touching
         * the wire. So on the live path — the only path this wrapper exists on — the button
         * rendered, the click ran, no request left the browser, no state changed and nothing
         * errored: a dead control indistinguishable from a broken one, with every suite green
         * because every suite builds engines from bare adapters. The exact failure shape this
         * literal's own header predicts, measured live on ohmail.app before this line existed.
         * `test/pull-wired.test.ts` builds the real live engine through `createEngine` so that
         * deleting this line goes red.
         */
        ...(adapter.requestPull
          ? { requestPull: gatedRead(adapter.requestPull.bind(adapter), "a worker pull") }
          : {}),

        /*
         * ── THE ONE-CLICK UNSUBSCRIBE — FORWARDED, REFUSED WHEN CONTRADICTED, AND SPREAD ───
         *
         * `POST /messages/:id/unsubscribe`: RFC 8058, performed server-side so the reader's IP
         * and reading time never reach the sender.
         *
         * FORWARDED AT ALL — and this line is a REPAIR, not a precaution, the third on this
         * list to be one. `OhmailEngine.unsubscribe` reads the capability structurally and
         * answers `null` when the adapter has none, which a surface is entitled to read as
         * "this client cannot unsubscribe". The gate is an explicit object literal and this
         * method was not in it, so on the LIVE PATH — the only path this wrapper exists on —
         * every account got `null`. `ScreenerView` maps that answer to the SUCCESS sentence:
         * the control rendered, the press ran, no request left the browser, no unsubscribe was
         * ever asked for, and the person was told it had been. A silent failure wearing the
         * face of a completed action, with every suite green because they build engines from
         * bare adapters. `test/sync-owner-gate.test.ts` builds the real engine through the gate
         * and counts the request, so deleting this line goes red.
         *
         * REFUSED WHEN CONTRADICTED, on `requestPull`'s argument rather than `fetchBody`'s:
         * this does not read, it ACTS, and it acts at a third party in the answering account's
         * name. Under a foreign session it would unsubscribe somebody else's mail from
         * somebody else's list, irreversibly, on a press made in a window that is not theirs.
         *
         * SPREAD, for the usual reason: the FixturesAdapter has no server, the demo makes no
         * external request, and a wrapper that defined this unconditionally would put a live
         * control over fixtures.
         */
        ...(adapter.unsubscribe
          ? { unsubscribe: gatedRead(adapter.unsubscribe.bind(adapter), "an unsubscribe") }
          : {}),

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
         * It IS gated, on IDENTITY ONLY, through {@link gatedPage} — and the paragraph that
         * used to stand here said the opposite, so read what it argued before trusting the
         * reversal. It said a `SyncAbortedError` from page 1 would be swallowed by
         * `runSnapshot`'s "this route is unusable" latch, and that page 2 onwards would be
         * counted against the backoff. Half of that is still true and the other half was
         * measured wrong.
         *
         * Page 1: the latch is real, and it is unreachable in practice. The scheduler re-reads
         * identity BEFORE `syncOnce()` on every tick, so a drain only starts while the gate
         * holds; reaching page 1 with a foreign jar needs the cookie to change inside the
         * microtask between that check and the request. If it ever does happen the tab is
         * `contradicted` and terminal anyway, and the cost is that a later healed session
         * replays the log from seq zero instead of taking the snapshot — slower, never wrong.
         *
         * Pages 2..n: this is the window that matters and the reason the old paragraph was a
         * defect rather than a trade-off. A cold account's bootstrap is ~37 pages over several
         * seconds; a sign-in as somebody else in another tab of the same profile rewrites the
         * jar in the middle of it, and every remaining page was selected from the NEW session
         * and written into the mirror named for the old one — durably, because the mirror has
         * no tombstones for ids it never should have held. `runSnapshot` rethrows from page 2
         * onwards, and the scheduler's catch reads `SyncAbortedError` as a cancellation, which
         * is exactly what this is: no failure count, no report, no retry.
         *
         * NOT gated on the CADENCE claim, deliberately: `mayContinue` is what a teardown moves,
         * and refusing page 1 for a teardown WOULD hit the latch above for a reason that has
         * nothing to do with identity. The gate on `sync()` still bounds the drain there — the
         * delta pages that follow the snapshot refuse, and a torn-down loop stops.
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
        ...(adapter.snapshot
          ? {
            snapshot: gatedPage(
              adapter.snapshot.bind(adapter),
              "the cold-start snapshot",
            ),
          }
          : {}),

        /*
         * ── READING PAST THE END OF THE WINDOW — FORWARDED, NOT GATED, AND SPREAD ──────────
         *
         * `GET /messages?view=&cursor=`, the companion to the windowed store: a page of the mail
         * this client chose not to keep on disk. Same rule as `fetchBody` and `searchServer` on
         * all three counts.
         *
         * NOT GATED ON CADENCE: it fires when somebody scrolls to the bottom of a pile, in a
         * tab they are looking at, and it is bounded by that act — one page per scroll, never
         * speculative. The cadence gate is about a DISCARDED engine paging through a bootstrap
         * on behalf of nobody.
         *
         * REFUSED WHEN CONTRADICTED, for `searchServer`'s reason exactly: this is the second
         * read that returns a LIST rather than an answer about an id this mirror already holds,
         * so a foreign session answers it with a foreign page of mail — rendered in the pile,
         * and every id in it usable against the body route.
         *
         * SPREAD: `OhmailEngine.listOlderAvailable()` decides whether the end of a list offers a
         * control at all. Defining this unconditionally would put "there is more, older mail" at
         * the bottom of the demo's Ohbox, over fixtures that are the whole of Mila's world.
         *
         * FORWARDED AT ALL: without the line, a live windowed account reaches the end of its
         * ninety-day window and is told that is the end of their mail — which is the falsest
         * sentence this app could put on a screen, and it would say it only in production.
         */
        ...(adapter.listMessages
          ? { listMessages: gatedRead(adapter.listMessages.bind(adapter), "a page of older mail") }
          : {}),

        /*
         * ── TRASH — FORWARDED, GATED, AND SPREAD, both of them ────────────────────────────
         *
         * `listMessages`' rule three times over, and the reasons are the same three:
         *
         * SPREAD: `OhmailEngine.trashAvailable()` decides whether the palette offers the row and
         * whether the chord works at all. Defining these unconditionally would put a Trash
         * destination in the demo's palette over fixtures that have no server to ask.
         *
         * GATED: a Trash page is somebody's deleted mail — the most private list in the product
         * — and the restore MOVES it. A foreign session must reach neither.
         *
         * TWO LINES: the engine binds the pair independently, so forwarding one and not the
         * other is a coherent program. `trashAvailable()` asks for both, so a half-forward
         * turns the feature off rather than half on — which is the safe direction and is why the
         * gate reports the pair.
         */
        ...(adapter.listTrash
          ? { listTrash: gatedRead(adapter.listTrash.bind(adapter), "your deleted mail") }
          : {}),
        ...(adapter.restoreFromTrash
          ? { restoreFromTrash: gatedRead(adapter.restoreFromTrash.bind(adapter), "restoring a message") }
          : {}),

        /*
         * ── ATTACHMENTS — FORWARDED, NOT GATED, AND SPREAD ────────────────────────────────
         *
         * Three capabilities, one rule, and it is `searchServer`'s rule for the third time.
         *
         * NOT GATED ON CADENCE: `listAttachments` is one indexed row read when a message is
         * opened, and the two byte methods fire on a click on a named file. All three are the
         * user's own intent in a tab they are looking at. The cadence gate is about a DISCARDED
         * engine paging through a bootstrap on behalf of nobody; a person pressing a PDF is the
         * opposite of that, and gating them on cadence would mean a file that silently refuses
         * to open whenever the predicate happens to be false.
         *
         * REFUSED WHEN CONTRADICTED: an id reached through a foreign list opens a foreign
         * file, and these three hand back its BYTES. `fetchAllAttachments` builds an archive of
         * them.
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
        ...(adapter.listAttachments
          ? { listAttachments: gatedRead(adapter.listAttachments.bind(adapter), "an attachment list") }
          : {}),
        ...(adapter.fetchAttachment
          ? { fetchAttachment: gatedRead(adapter.fetchAttachment.bind(adapter), "an attachment") }
          : {}),
        ...(adapter.fetchAllAttachments
          ? { fetchAllAttachments: gatedRead(adapter.fetchAllAttachments.bind(adapter), "every attachment") }
          : {}),
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

/**
 * THE SERVER NAMED THIS MAILBOX'S ACCOUNT — the one call that opens a named mirror's gate.
 *
 * Called from the confirm effect's `owner` arm with the id `GET /auth/session` returned, for
 * the warm engine once that comparison passes and for the freshly built cold engine. Both
 * BEFORE `setBinding`, so the first tick of the scheduler that binding starts already sees an
 * open gate rather than racing it.
 *
 * A no-op on an engine with no gate — the demo, the desktop's host-built engine, a bare
 * `new OhmailEngine`. Those have nothing to open and nothing on disk to protect.
 */
export function confirmSyncOwner(engine: OhmailEngine, accountId: string): void {
  GATES.get(engine)?.confirm(accountId);
}

/**
 * MAY THIS ENGINE STILL BE TRUSTED? — the same answer the gate gives its own adapter, for the
 * doors that do not go through an adapter at all.
 *
 * Two Cloud readers reach the API without touching `EngineAdapter`, so wrapping the adapter
 * cannot reach them: the reach-past body door (`older-body.ts`, a session-held fetch for rows
 * beyond the mirror window) and the mailbox-facts poll (`MailStateProvider`, `GET /mailboxes`
 * every thirty seconds). Both keep asking under whatever cookie the jar holds, and both publish
 * what comes back — a foreign body rendered into the pane, a foreign account's mailbox
 * addresses and errors rendered into the strip and the From selector.
 *
 * One predicate rather than a second spelling of it, deliberately: two ways to ask "is this
 * still my account" is how the two come to disagree, and the disagreement is invisible.
 *
 * `holds` for an engine with no gate — the demo, the desktop's host-built engine, a bare
 * `new OhmailEngine`. None of them has a Cloud session to be wrong about.
 */
export function syncIdentityOf(engine: OhmailEngine | null | undefined): SyncIdentity {
  if (!engine) return "holds";
  return GATES.get(engine)?.identity() ?? "holds";
}

/**
 * MAY A DIRECT READER ASK THE SERVER FOR THIS ACCOUNT'S BYTES? — the adapter's own rule, exported
 * so the two doors that do not go through an adapter cannot drift from it.
 *
 * They did drift. Both were written when the gate had three states and tested
 * `=== "contradicted"`; the fourth state arrived and neither moved, so a REVOKED gate — one whose
 * confirmation the marker has already outlived — went on being readable through the reach-past
 * body door and the mailbox-facts poll while the adapter beside them refused. Three spellings of
 * one question is how two of them come to disagree, which is the argument this file makes about
 * `identity()` itself; this is the same argument applied one layer out.
 *
 * `unconfirmed` reads TRUE, deliberately and for the last time in this file: that is the ordinary
 * warm open, the mail is the person's own, and refusing there would blank a mailbox that is
 * already on screen for the length of a round trip.
 */
/**
 * ASK ME AGAIN WHEN A REVOKED MIRROR COULD BE CONFIRMED. The shell's own re-entry into the
 * session confirm; a no-op on an engine with no gate. See {@link SyncGate.onNeedsConfirm}.
 */
export function onSyncNeedsConfirm(engine: OhmailEngine | null | undefined, cb: () => void): void {
  if (!engine) return;
  GATES.get(engine)?.onNeedsConfirm(cb);
}

export function syncMayRead(engine: OhmailEngine | null | undefined): boolean {
  return mayReadIdentity(syncIdentityOf(engine));
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
   * WHY the loop is terminal, as two INDEPENDENT bits rather than one flag naming a winner.
   *
   * `terminal` is the union of them, and both causes are real and unrelated: the SERVER refused
   * this session (sustained, and its own statement about this account), or the cookie jar names
   * somebody else (this browser's own state, which can change back).
   *
   * One flag could not compose. It said "the current terminal is a contradiction's", so a server
   * refusal that latched first and a contradiction observed afterwards overwrote it — and when
   * the contradiction cleared, the release took the SERVER's verdict with it. The gate stayed
   * shut and no bytes flowed, so nothing leaked; what disappeared was a true sentence the person
   * needed. Two bits, and a contradiction can only ever clear its own.
   *
   * ── AND THE SEQUENCE THAT DISTINGUISHES THEM IS REAL, WHICH I CLAIMED IT WAS NOT ───────────
   *
   * This shipped with no test and a recorded argument that none was possible: a terminal loop
   * holds NO TIMER, so the only thing that can drive a tick — and therefore observe a marker
   * change — is `wake()`'s probe, floored at `BACKOFF_CAP_MS` and guarded by `visible()`.
   *
   * The argument was wrong, and the way it was wrong is worth keeping. The floor is real; my
   * attempt to drive two observations through it advanced past the cap before the SECOND wake and
   * not before the FIRST, so the probe that was meant to OBSERVE the contradiction was itself
   * throttled and the gate never saw the other account at all. Two identical published sequences
   * came back and I read that as "no sequence exists" rather than "my sequence did not run".
   *
   * `sync-owner-gate.test.ts`'s "a contradiction that comes and goes does not erase the server's
   * own refusal" is that sequence, with the cap before BOTH wakes. Measured: with one flag it goes
   * red, with two bits green. A guard nobody has watched fail is not evidence — and neither is an
   * argument that it cannot.
   */
  let terminalByServer = false;
  let terminalByIdentity = false;
  /** Re-derive the union after either bit moves. Never assign `terminal` any other way. */
  const settleTerminal = (): void => { terminal = terminalByServer || terminalByIdentity; };
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
   * WHEN the next confirm ask is due, while a refusal episode is open. A wake may re-arm what is
   * LEFT of the current window and never shorten it (#10); with the confirm now a cadence rather
   * than a single ask, "what is left" has to be tracked here — computing it from `refusedAt`
   * (the EPISODE's start) goes negative after the first confirm, and `Math.max(0, …)` of a
   * negative is an immediate ask, i.e. a wake that buys an invocation per window-flip.
   */
  let confirmDueAt = 0;
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
  // The gate refuses the engine's NEXT page whenever this scheduler would refuse a new drain.
  // Claimed and never released: the predicate closes itself via `stopped`, so a torn-down
  // scheduler cancels the drain it left behind rather than freeing it to keep paging.
  //
  // Looked up HERE rather than below `mayRequest`, because `mayRequest` now reads it.
  const gate = options.gate !== undefined ? options.gate : (GATES.get(engine) ?? null);

  /**
   * The CADENCE half: is this loop still entitled to make a request at all? Teardown and a
   * terminally refused session, exactly as before identity existed.
   *
   * Split out because the two halves need different ANSWERS. A caller that only wants to know
   * "am I still alive" must not be told "no" for an identity reason and silently return — the
   * identity cases have their own branch in `tick()`, which reports the contradiction and
   * quietly stands down for the unconfirmed one. Folding identity in here is what made the
   * unconfirmed case return from inside the hydration block with `bootstrapping` still true,
   * so the strip claimed a bootstrap that was never going to happen.
   */
  const mayRunNow = (): boolean => !stopped && (!terminal || revalidating);

  const mayRequest = (): boolean =>
    mayRunNow() && (gate?.identity() ?? "holds") === "holds";

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

  /**
   * MAY THIS WINDOW HOLD A SESSION-AUTHENTICATED STREAM RIGHT NOW? One spelling, read at four
   * points in the stream's life, because the stream is the one thing in this loop that keeps
   * acting after the moment it was created.
   */
  const identityHolds = (): boolean => (gate?.identity() ?? "holds") === "holds";

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
    /*
     * ── AND NOT WHILE THIS MIRROR'S IDENTITY DOES NOT HOLD ────────────────────────────────
     *
     * `/events` is a SESSION-authenticated stream and the server emits the answering account's
     * sequence on it. Opened without asking, a stale shell for A held a live subscription to B's
     * activity: content-free as mail goes, and still that account's metadata arriving in a window
     * that is not theirs, on a connection nobody in it opened.
     *
     * The gated tick downstream is what stops the mail being merged, which is why this is a
     * narrowing rather than a repair of a leak. It is also why it belongs here: the stream is the
     * one thing in this loop that is not a request, so nothing else in the file was ever going to
     * ask the question for it.
     */
    if (!identityHolds()) return;
    try {
      const s = wakeFactory();
      stream = s;
      s.addEventListener("open", () => {
        if (stream !== s || stopped) return;
        /*
         * ── ASKED AGAIN ON EVERY OPEN, BECAUSE NOT EVERY OPEN IS ONE WE ASKED FOR ──────────
         *
         * `connectStream` checks identity once, at construction. `EventSource` then reconnects
         * BY ITSELF after a transient failure — that is the whole of what the object does — and
         * the reconnect carries whatever cookies the jar holds at that moment, not the ones it
         * was opened with. So an open here can be a connection to another account's stream that
         * nothing in this window requested.
         */
        if (!identityHolds()) { closeStream(); return; }
        streamOpen = true;
        // Drain once on every open, not only the first: a reconnect (the server cycles streams
        // before its platform ceiling; a network blip) is a window in which wakes were missed,
        // and this is what closes it. Bounded by the server's retry hint, so it cannot storm.
        wake();
      });
      s.addEventListener("sync", () => {
        if (stream !== s || stopped) return;
        // A frame can arrive on a connection the browser re-established under a jar that has
        // since changed; the open check above is the first line and this is the second.
        if (!identityHolds()) { closeStream(); return; }
        wake();
      });
      s.addEventListener("error", () => {
        if (stream !== s || stopped) return;
        streamOpen = false;
        /*
         * ── AND THIS IS WHERE THE RECONNECT IS ACTUALLY PREVENTED ─────────────────────────
         *
         * The error arm below deliberately leaves a CONNECTING stream alive, because that is
         * the ordinary transient failure and `EventSource` recovers from it on its own. That
         * recovery is exactly the hazard when the jar has changed in the meantime: the object
         * re-dials with the new session and the server binds the connection to that account.
         *
         * The safety poll's tick closes a contradicted stream, but it runs on the relaxed
         * cadence a tab with a live stream keeps — the reconnect lands long before it. So the
         * question is asked at the moment the reconnect is about to be armed. Closing here is
         * what makes the two checks above defence in depth rather than the only defence.
         */
        if (!identityHolds()) {
          closeStream();
          armFloor();
          return;
        }
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
        // The CADENCE half only — identity is answered below, where it can say which of its
        // two closed states this is.
        if (!mayRunNow()) {
          disarm();
          return;
        }
      }
      /* ── WHOSE MAILBOX IS THIS, ASKED BEFORE EVERY DRAIN ─────────────────────────────
       *
       * On EVERY tick, not only the first. The check above runs inside `if (!hydrated)`, so
       * from the second tick onward nothing stood between the timer and `syncOnce()` — and
       * `syncOnce` reaches for `/sync/snapshot` first, which is deliberately UNGATED (a page-1
       * throw latches the route unusable), so page one would leave the browser whatever the
       * per-page gate said afterwards.
       *
       * The two closed answers are told apart because they mean different things to a person:
       *
       *  · `contradicted` — the jar names another account. That is positive evidence this tab
       *    is no longer the one it was, so the loop LATCHES terminal and the strip says so.
       *    This is the only cover for a `ready` tab whose browser signs into another account
       *    mid-use: the confirm's comparison answers once, and nothing re-runs it on a live binding.
       *    `wake()`'s terminal probe re-reads identity, so restoring the cookie self-heals.
       *  · `unconfirmed` — nobody has said yet. Nothing is wrong, nothing is syncing, and the
       *    strip may not claim either: it disarms QUIETLY and waits for `onOpen`.
       */
      const owns = gate?.identity() ?? "holds";
      if (owns === "contradicted") {
        // The wake stream goes with it: it is session-authenticated, and a subscription this tab
        // opened for A must not go on receiving B's sequence. `connectStream` refuses to reopen
        // it while identity does not hold, so this is the close and that is the latch.
        closeStream();
        terminalByIdentity = true;
        settleTerminal();
        bootstrapping = false;
        disarm();
        publish();
        report(
          "ohmail: this browser now holds another account's session — this mailbox has stopped syncing; sign in again",
          new SyncAbortedError("the cookie jar names a different account than this mirror"),
        );
        return;
      }
      /*
       * `revoked` rides with `unconfirmed` HERE and not with `contradicted`, which is the
       * opposite of how the read gate treats it — deliberately, and the two are answering
       * different questions. The read gate asks "may this window act on the answer?" and a
       * lapsed grant means no. The strip asks "what should the person be told?" and a lapsed
       * grant is not a claim about the account: the marker changed, which happens on a sign-in
       * elsewhere, a sign-out, a rotation. Saying "this mailbox has stopped syncing; sign in
       * again" over that would be the slice's own defect in a new place — a sentence stronger
       * than the evidence. So it disarms QUIETLY and waits for `onOpen`, exactly as an
       * un-confirmed gate does.
       */
      if (owns === "unconfirmed" || owns === "revoked") {
        // Same as the contradiction arm: a lapsed grant is not a licence to keep listening.
        closeStream();
        /*
         * AND THE CONTRADICTION'S OWN LATCH IS RELEASED, because its cause is gone.
         *
         * `terminal` says "this tab can no longer be served" and the strip says so out loud.
         * When that claim was made because the jar named somebody else, and the jar has since
         * stopped naming them, the claim has outlived its evidence — and a sentence stronger
         * than its evidence is the defect this whole slice exists to remove. What is NOT
         * released is a `terminal` the SERVER caused: a sustained refusal is the server's own
         * statement about this account, and a marker changing underneath it does not withdraw
         * it. Hence two cause bits rather than one flag: a contradiction clears only its own, and
         * a server refusal underneath it survives — which is what the single flag got wrong.
         *
         * Nothing resumes here either way. The loop stays disarmed and quiet until a fresh
         * confirmation opens the gate; this only stops it announcing a stop it can no longer
         * support.
         */
        terminalByIdentity = false;
        settleTerminal();
        bootstrapping = false;
        disarm();
        publish();
        return;
      }
      await engine.syncOnce();
      if (stopped) return;
      // A drain that SUCCEEDED disproves the refusal, so the claim is withdrawn. `arm()` refuses
      // to set a timer while `terminal`, which is why this clears it BEFORE arming. A drain can
      // only have run with the gate holding, so there is no identity cause left to clear —
      // cleared anyway, because a bit whose invariant is "already false here" is a bit somebody
      // will make true one refactor from now.
      terminalByServer = false;
      terminalByIdentity = false;
      settleTerminal();
      revalidating = false;
      // …and an UNCONFIRMED refusal is withdrawn here too, or the next transient one an hour later
      // would find `refusedAt` still set, read itself as the confirmation, and latch on the first
      // request — the same defect, resurrected on the second occurrence and invisible to any test
      // that only drives one.
      refusedAt = null;
      failures = 0;
      bootstrapping = false;
      arm(steadyDelay());
      // THE EAGER BODY PASS, kicked from the one place that knows a drain just SETTLED cleanly.
      // Fire-and-forget: the settle must publish and re-arm without waiting on background
      // fetches, and the engine's pass never rejects (failures become per-id records). It lives
      // here and not inside `drain()` so a bare `syncOnce()` — a test, an embedder's own loop, a
      // discarded engine settling after teardown — never issues requests nobody asked for; and
      // it is a no-op on any engine that did not opt in (`eagerBodies`), which is every demo and
      // every embedder that has not adopted it.
      if (!stopped) void engine.prefetchRecentBodies();
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
        if (terminal || (refusedAt !== null && Date.now() - refusedAt >= REFUSAL_SUSTAIN_MS)) {
          // SUSTAINED (or a terminal-mode probe re-refused). The server has re-made this claim
          // on every confirm ask across {@link REFUSAL_SUSTAIN_MS} — longer than any deploy
          // window measured here — so it is believed: stop, hold no timer, and SAY so.
          // `terminal` is what lets the shell tell the difference between "your mailbox is
          // having a bad minute" and "this tab can no longer be served". `role="alert"`
          // re-announcing on a re-latch is correct — the claim was re-made by the server, not
          // repeated by us.
          terminalByServer = true;
          settleTerminal();
          refusedAt = null;
          revalidating = false;
          disarm();
          report("ohmail: this session can no longer sync — sign in again", err);
          return;
        }
        if (refusedAt !== null) {
          // RE-MADE, NOT YET SUSTAINED. A minute of corroboration cannot tell "revoked" from
          // "mid-deploy" — see {@link REFUSAL_SUSTAIN_MS} for the incident where it could not —
          // so the confirm cadence continues, bounded by the sustain window, and the strip keeps
          // saying "Sync failed. Retrying.", which stays true of every one of these asks.
          // Deliberately NOT re-reported: it is the same episode the first report named, and a
          // console line per confirm would be ten copies of one fact.
          confirmDueAt = Date.now() + REFUSAL_CONFIRM_MS;
          arm(REFUSAL_CONFIRM_MS);
          return;
        }
        // THE FIRST ONE — believed enough to stop polling, NOT enough to tell a signed-in user
        // that they are signed out. Confirm asks are armed at `REFUSAL_CONFIRM_MS` cadence until
        // the refusal has been sustained; the published status carries `refused`, so the strip
        // says "Sync failed. Retrying.", which is true — that retry is the timer below. It must
        // NOT fall through to the ordinary backoff: at `failures === 1` that is a ~1 s retry,
        // and a ladder of sub-minute asks inside the window is the unbounded-cost shape the
        // latch design rejected — every ask would be an invocation billed against an account
        // that may have no entitlement. The bounded cadence is priced in `REFUSAL_SUSTAIN_MS`'s doc.
        refusedAt = Date.now();
        confirmDueAt = Date.now() + REFUSAL_CONFIRM_MS;
        report("ohmail: the server refused this session — asking again before saying so", err);
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
      // confirmation is a cadence of asks spaced by `REFUSAL_CONFIRM_MS`; a tab somebody flips
      // away from and back must not be able to shorten the current window, or a two-second
      // transient latches whenever the user happens to switch windows — and it must not be able
      // to buy invocations either (#10), which a wake-triggered drain per flip is exactly.
      //
      // So this only RE-ARMS what is left of the CURRENT window — `confirmDueAt`, not
      // `refusedAt + REFUSAL_CONFIRM_MS`, which names only the FIRST window and goes negative
      // after it, turning every later wake into an immediate ask. (The timer normally survives
      // a hide — the hidden state holds timers — but a stream `open` or an `online` flap still
      // lands here and must not move the ask.) Clamped at zero so a window that has already
      // elapsed asks immediately.
      arm(Math.max(0, confirmDueAt - Date.now()));
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
  /*
   * THE GATE OPENING IS A WAKE, and it is registered HERE rather than beside the `claim` above
   * for one mechanical reason: `wake` is a `const` declared further down, so a registration at
   * the claim site would read it in its temporal dead zone and throw on the first
   * `startSyncScheduler`. That is the "built, tested, unreachable" shape — the gate would open
   * and nothing would ever notice, and only a test that confirms AFTER the first tick could
   * see it. `sync-owner-gate.test.ts` case 1 is that test.
   */
  gate?.onOpen(wake);

  connectStream();
  publish();
  void tick();

  return () => {
    stopped = true;
    disarm();
    closeStream();
    // The eager body pass is fire-and-forget behind the drain and NOT gated (fetchBodies is a
    // deliberately ungated capability), so teardown has to stop it explicitly — a live→demo
    // navigation discards this engine, and a discarded engine prefetching a thousand bodies on
    // behalf of nobody is exactly the cost shape the gate exists to prevent on the sync side.
    engine.stopEagerBodies();
    visibility?.removeEventListener("visibilitychange", onVisibility);
    online?.removeEventListener("online", wake);
  };
}
