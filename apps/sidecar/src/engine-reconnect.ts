// The desktop's engine: the poll's and the reconnect's constants and clocks, and the two errors a dial ends on.

import { WORKER_NET_TIMEOUTS, type NetTimeouts } from "@trafficflow/core/adapters/imap";
import type { OrganizerKind } from "@trafficflow/core/adapters/organizer-lease";
import type { AdapterDialContext } from "./engine-types.js";

export const DEFAULT_POLL_INTERVAL_MS = 15_000;

/**
 * ══ THE CEILING AN IDLE MAILBOX RESTS AT ══
 *
 * Two minutes. It is an eighth of `DEFAULT_STALE_AFTER_MS` (10 min), which is the bound that
 * decides when another install may take a mailbox whose organizer stopped renewing — so a claim
 * renewed once a ceiling still has four missed renewals of room. It is the same order as the
 * shell's own belt behind its wake stream (`WAKE_SAFETY_POLL_MS`, 90 s). Freshness is not what
 * this trades: the rest is taken ONLY while the mailbox's own IDLE is carrying arrivals.
 */
export const IDLE_POLL_CEILING_MS = 120_000;

/**
 * The next delay after a drain that found nothing — geometric, clamped, and a pure function so
 * the ladder can be watched on a fake clock. `base` floors it (a configured poll interval above
 * the ceiling is honoured rather than shortened), and doubling from `current` means the ladder
 * climbs 15 → 30 → 60 → 120 and then stays.
 */
export function nextIdlePollMs(current: number, base: number, ceiling: number): number {
  const floor = Math.max(1, base);
  const cap = Math.max(floor, ceiling);
  return Math.min(Math.max(current, floor) * 2, cap);
}

/**
 * The dial context for a connection nobody keeps — a probe and a send. Both open a login, do one
 * thing and close it inside the call that made them: no poll timer, no runtime to mark, so "the
 * connection died between calls" describes nothing — either the call is in flight and the
 * failure comes back as a throw, or the connection is closed and its death is what we asked for.
 * A named constant rather than an inline `() => {}` at each site, because the empty body is a
 * claim — "there is nothing to heal here" — stated once with the reason attached.
 */
export const ONE_SHOT_DIAL: AdapterDialContext = { onConnectionError: () => { /* see above */ } };

/**
 * The dial context of a runtime's connection to a CANDIDATE server while a mailbox moves there
 * (`claimOnCandidate`). Its life is the move's: every call on it is awaited inside the move, so a
 * death between calls reaches the move as a throw and there is no poll of its own to mark.
 */
export const CANDIDATE_DIAL: AdapterDialContext = { onConnectionError: () => { /* the move awaits its calls */ } };

/**
 * A DIAL REFUSED BECAUSE THIS INSTALL HAS SIGNED OUT. The mailbox password is gone from the store
 * and the copy this attachment holds in memory may not be used to open a login: every dial reads
 * the sign-out epoch (`signout-fence.ts`) and this is what it throws when the epoch has moved.
 */
export class SignedOutError extends Error {
  readonly code = "ESIGNEDOUT";
  constructor() {
    super(
      "this install signed out, so the password this mailbox resolved is not dialled with; " +
      "the mirror is served and signing in again opens a connection",
    );
    this.name = "SignedOutError";
  }
}

/**
 * The drain was gated on a connection that no longer exists — a coded refusal, not a fault. The
 * organizer lease is read once per drain, on one connection; if that connection is replaced
 * mid-drain, every later step would run against a connection whose lease it never read — on a
 * mailbox that changed hands during the outage, two organizers writing. So the drain carries the
 * generation it gated under and refuses the moment that stops being current. Nothing is wrong
 * with the mailbox, credential or server: the pass is stale, and the very next drain re-reads
 * the lease on the new connection. It carries a `code` so a caller can tell it from a real fault
 * without matching on a message.
 */
export class ConnectionReplacedError extends Error {
  readonly code = "ECONNGEN";
  constructor(readonly gatedGeneration: number, readonly currentGeneration: number) {
    super(
      `this pass read the organizer lease on connection generation ${gatedGeneration}, and the ` +
      `mailbox is now on generation ${currentGeneration}; it is abandoned rather than continued ` +
      "on a connection it never gated",
    );
    this.name = "ConnectionReplacedError";
  }
}

/**
 * How long the organizer lease may go on being unreadable before the connection is called dead.
 * `LeaseUnavailableError` is exempt from every failure counter by class, correctly — "I could
 * not look" must never be recorded as "this mailbox is broken" — but with nothing else bounding
 * the exempt arm, a permanently dead connection is retried for ever: the measured wedge, the
 * same failure every poll interval, healed only by a restart. The hosted worker reached this
 * number first (`DEFAULT_LEASE_UNAVAILABLE_DETACH_MS`), and its argument for a duration over a
 * cycle count holds here: "after N cycles" is a proxy for time that silently retunes itself the
 * day somebody changes `pollIntervalMs`.
 */
export const LOCAL_CONNECTION_DEAD_AFTER_MS = 120_000;

/**
 * …and the cycle count beside it, which is not a second opinion. Whichever comes first: the duration is
 * the product property; this is the arm that cannot be bypassed by a composition that owns the clock —
 * an injected `now`, or a test driving drains by hand. Without it the bound would be provable only by a
 * test that sleeps two minutes, and a guard nobody can afford to run is one nobody runs. Eight, because
 * eight polls at the shipped 15 s interval IS two minutes: on the shipped configuration the arms fire
 * together and the count adds nothing. It bites only where the poll is faster, and there an early
 * re-dial costs one process-owned socket — the asymmetry that makes the union safe here and not in the
 * hosted worker, where the same shape would be a re-attach storm across every account on a shard.
 */
export const LOCAL_CONNECTION_DEAD_AFTER_CYCLES = 8;

/**
 * How long a heartbeat may go unanswered before the connection is called dead.
 *
 * The event detector needs the driver to report; the duration bound
 * ({@link LOCAL_CONNECTION_DEAD_AFTER_MS}) needs cycles that ran and threw. A half-open link
 * produces neither, so the fastest thing left is the socket's own inactivity timer at 120 s.
 * Thirty seconds is set against what a NOOP costs — one round trip — and what a false positive
 * costs: one re-dial of one socket this process owns.
 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;

/**
 * The heartbeat window for this launch. A value that is not a positive number refuses the boot
 * rather than falling back to the default: a zero or unreadable window would report every mailbox
 * unreachable on every poll, which is indistinguishable from the mail server being down. The
 * refusal names the variable, and reports the TYPE of a non-number rather than echoing it.
 */
export function resolveHeartbeatTimeoutMs(config: { heartbeatTimeoutMs?: number }): number {
  const raw: unknown = config.heartbeatTimeoutMs;
  if (raw === undefined) return DEFAULT_HEARTBEAT_TIMEOUT_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    const said = typeof raw === "number"
      ? (Number.isNaN(raw) ? "not a number (NaN — the value supplied is not numeric)" : String(raw))
      : `not a number (${typeof raw})`;
    throw new Error(
      "OHMAIL_HEARTBEAT_MS must be a positive number of milliseconds — the window a connection " +
      `has to answer an IMAP NOOP in before it is treated as dead. It is ${said}. Refused at ` +
      "startup rather than replaced by the default: a zero or unreadable window would make every " +
      "poll declare this mailbox unreachable and re-dial it, which is indistinguishable from the " +
      "mail server being down.",
    );
  }
  return raw;
}

/**
 * How often the roster route says it answered, at rest.
 *
 * A line per answer is four a minute while Settings is open. A line only on change is worse: an
 * answer that never changes and a question that stopped arriving then produce the same nothing,
 * which is the pair this instrument exists to separate. On a change or once a minute, so the
 * reading is the trail and a gap in it is the silence.
 */
export const LOCAL_CONNECTIONS_LOG_EVERY_MS = 60_000;

/**
 * The deadlines this process dials with — the persistent-process set, never the serverless one.
 * `DEFAULT_NET_TIMEOUTS.socketMs` is 25 s, chosen against a 60-second serverless ceiling; the sidecar passed
 * no `timeouts`, so a desktop holding connections for the life of the window inherited it. `socketMs` is
 * Node's socket inactivity timer, and imapflow only auto-idles 15 s after the last command with a mailbox
 * selected — the fatal window is a long quiet stretch mid first sync (measured: `NoConnection` at 31 s and 69
 * s, growing with mailbox size — a property of the link, not the platform). The same values as {@link
 * WORKER_NET_TIMEOUTS}, not a second literal (the dial test asserts equality). Sync dial only: probes keep
 * short deadlines, sends resolve per mailbox (`makeSendAdapter`).
 */
export const SIDECAR_NET_TIMEOUTS: NetTimeouts = WORKER_NET_TIMEOUTS;

/** First wait after a dial that failed for a reason that may pass. Doubles to
 *  {@link REDIAL_BACKOFF_MAX_MS}; {@link DESKTOP_RECONNECT}'s ladder IS that doubling, and the
 *  code reads the ladder — these two stay the authority on its shape and the test compares them. */
export const REDIAL_BACKOFF_BASE_MS = 15_000;
/**
 * THE CEILING ON THAT WAIT.
 *
 * Without a backoff at all, a server that accepts TCP and refuses everything got a fresh dial
 * every poll — FOUR LOGIN ATTEMPTS A MINUTE, for as long as the app stayed open. Providers
 * throttle that, and some lock the account; the person's mail then stops for a reason the app
 * caused. Five minutes is short enough that a real outage heals without anybody pressing
 * anything and long enough that a broken server sees single figures per hour.
 */
export const REDIAL_BACKOFF_MAX_MS = 5 * 60_000;

/**
 * How long this composition waits before calling a connection dead, and how it re-dials.
 * The four bounds above suit a desktop that runs for days, where a dead socket is rare and a
 * counted login is the costly mistake. A phone organizes only while ohmail is open and drops its
 * route for seconds, so the same numbers read as a broken app. The bounds therefore become a
 * PROFILE selected by {@link OrganizerKind} — no new flag: the discriminator is already in the
 * claim, and `composition-passes.ts` is the prior art for an exhaustive record over it, so a
 * fourth kind cannot reach the claim without an answer here.
 */
export interface ReconnectProfile {
  /** The duration bound over failing cycles — see {@link LOCAL_CONNECTION_DEAD_AFTER_MS}. */
  readonly deadAfterMs: number;
  /** The cycle bound beside it, whichever comes first — {@link LOCAL_CONNECTION_DEAD_AFTER_CYCLES}. */
  readonly deadAfterCycles: number;
  /**
   * THE WAIT BEFORE EACH RE-DIAL, step by step, THE LAST ONE REPEATING FOR EVER.
   *
   * An explicit ladder rather than a base and a cap, because the two profiles do not share one
   * curve: the desktop's is the shipped doubling (and the desktop entry below is exactly what
   * that doubling produces — `reconnect-after-close.test.ts` proves it against
   * {@link REDIAL_BACKOFF_BASE_MS} and {@link REDIAL_BACKOFF_MAX_MS} rather than retyping it),
   * and the phone's is a ruled sequence that is not one. `ladderMs[0]` is also the floor under a
   * person's press, so a press is never rationed slower than the automatic ladder it skips.
   */
  readonly ladderMs: readonly number[];
}

/** The shipped desktop and Cloud numbers, unchanged — see the four constants above. */
export const DESKTOP_RECONNECT: ReconnectProfile = {
  deadAfterMs: LOCAL_CONNECTION_DEAD_AFTER_MS,
  deadAfterCycles: LOCAL_CONNECTION_DEAD_AFTER_CYCLES,
  ladderMs: [15_000, 30_000, 60_000, 120_000, 240_000, 300_000],
};

/**
 * A PHONE. Detection at 3 cycles or 45 s — a phone's session is
 * minutes, so two minutes of silence is most of it — and a ladder of 5/15/30/60 s with the last
 * step repeating. The ladder never runs out, which is why the sentence a person reads keys on the
 * wall clock and not on an exhausted ladder.
 */
export const PHONE_RECONNECT: ReconnectProfile = {
  deadAfterMs: 45_000,
  deadAfterCycles: 3,
  ladderMs: [5_000, 15_000, 30_000, 60_000],
};

export const RECONNECT_PROFILES: Readonly<Record<OrganizerKind, ReconnectProfile>> = {
  local: DESKTOP_RECONNECT,
  cloud: DESKTOP_RECONNECT,
  mobile: PHONE_RECONNECT,
};

/** Which bounds this install runs on. Exhaustive over the claim kinds by the record's type. */
export const reconnectProfile = (kind: OrganizerKind): ReconnectProfile =>
  RECONNECT_PROFILES[kind];

/**
 * A WAIT ON THE WALL CLOCK THAT A BACKWARD STEP CANNOT LENGTHEN. Armed with its length; a reading
 * that finds more than that length left (the clock went back after the arm) re-arms it at
 * `now + ms`, so a step costs at most one wait, never the step. A forward step ends it early, as
 * every wall-clock wait here always did. FIRST-PAGE-GATE-WAITS-OUT-A-CLOCK-STEP.
 */
export class WallWait {
  private due = 0;
  private ms = 0;
  private armed = false;
  arm(ms: number, now: number = Date.now()): void {
    this.ms = Math.max(0, ms);
    this.due = now + this.ms;
    this.armed = true;
  }
  clear(): void { this.armed = false; }
  /** What is left, never more than the length it was armed with; 0 when spent or never armed. */
  left(now: number = Date.now()): number {
    if (!this.armed) return 0;
    if (this.due - now > this.ms) this.due = now + this.ms;
    return Math.max(0, this.due - now);
  }
}

/** The wait before attempt `n` (1-based). Past the ladder's end the last step repeats. */
export const redialStepMs = (profile: ReconnectProfile, attempt: number): number =>
  profile.ladderMs[Math.min(Math.max(attempt, 1), profile.ladderMs.length) - 1]!;

/**
 * ══ AWAIT A PROMISE, OR GIVE UP — the whole of what makes a stop finish on a wedged link ══
 *
 * Answers whether it SETTLED, and a rejection counts as settled: the caller's question is "is the
 * work over", and a failure is over. The timer is unref'd and cleared on both paths, so a bounded
 * wait can never be the thing that holds a process open.
 */
export async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  /* THE DEADLINE IS A MONOTONIC INSTANT, AND THE TIMER IS RE-ARMED AGAINST IT.
   * `setTimeout` schedules against the event loop's cached clock, which is not refreshed while
   * synchronous work runs, so a single-shot timer can fire up to a millisecond before the clock
   * reaches the deadline — `detach()` measured a 299 against the 300 ms it promises. Monotonic,
   * because a wall clock stepped back inside the wait re-armed it for the length of the step. */
  const deadline = performance.now() + Math.max(0, ms);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<false>((resolve) => {
    const arm = (): void => {
      const left = deadline - performance.now();
      if (left <= 0) { resolve(false); return; }
      timer = setTimeout(arm, left);
      timer.unref?.();
    };
    arm();
  });
  try {
    return await Promise.race([work.then(() => true, () => true), elapsed]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
