/**
 * A CLIENT WHOSE SESSION IS OVER STOPS ASKING — the gate, and the bounded way back.
 *
 * Measured in production: one browser with a dead session asked three routes about twice a second
 * for more than eight minutes, ~990 refusals each, and every one of those refusals started a
 * refresh that was refused the same way. Nothing was broken; nothing had a bound. Two rules end
 * it, and both live here so every client — browser, desktop, phone — gets the same one.
 */

/**
 * Rule one: while the death is CONFIRMED, a door answers what the server would have answered
 * without asking it ({@link sessionEndedResponse}). Confirmed means the server itself refused the
 * refresh, never one request's evidence — that judgement belongs to whoever owns the session
 * client, and this module only carries it.
 */

/**
 * Rule two: the heal is a SCHEDULE, not a reflex ({@link createSessionHeal}). One refresh attempt
 * per step of a widening backoff, so a tab left open on a signed-out session costs a handful of
 * requests an hour instead of a hundred a minute — and a person who signs in somewhere else is
 * picked up within five minutes without touching anything.
 */

/** No imports, deliberately: a build with no Cloud session links this and pays a few bytes. */

/**
 * THE WAIT BEFORE EACH HEAL ATTEMPT, in order; the LAST ENTRY REPEATS for as long as the session
 * stays dead.
 *
 * Five seconds catches the ordinary case — a session that lapsed while the tab was backgrounded
 * and a refresh cookie that is still good — fast enough that nobody reads a sentence about it.
 * The rest widen because every later attempt is asking the same question of a server that has
 * already answered it once: thirty seconds, two minutes, then one attempt every five minutes for
 * ever. Twelve requests an hour against ~7 000 measured.
 */
export const SESSION_HEAL_BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000, 300_000];

/** The timer pair, injectable so a guard can drive the whole schedule on a virtual clock. */
export interface SessionHealTimers {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface SessionHeal {
  /**
   * The session is confirmed dead: arm the schedule at its first step. IDEMPOTENT — a second
   * confirmation of a death already being healed must not start a second schedule, which is the
   * hot loop in a hat.
   */
  arm(): void;
  /** Stop and reset to the first step. Called on a revival, and on teardown. */
  disarm(): void;
  /** Is a step waiting to fire? */
  armed(): boolean;
  /** How many attempts this module has made since the last {@link disarm} — for assertions. */
  attempts(): number;
  /** The wait the step now pending will take, in ms; `0` when nothing is armed. */
  pendingWaitMs(): number;
}

/**
 * @param attempt what one heal costs — a single-flight refresh. It is called at most once per
 * step and its answer is not read here: a success is published by whoever owns the session truth
 * (which calls {@link SessionHeal.disarm}), and a failure simply leaves the schedule running.
 */
export function createSessionHeal(
  attempt: () => void,
  timers: Partial<SessionHealTimers> = {},
): SessionHeal {
  const setTimer = timers.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = timers.clearTimer ?? ((h) => { clearTimeout(h as ReturnType<typeof setTimeout>); });

  let handle: unknown = null;
  let step = 0;
  let made = 0;

  const waitFor = (i: number): number =>
    SESSION_HEAL_BACKOFF_MS[Math.min(i, SESSION_HEAL_BACKOFF_MS.length - 1)]!;

  const schedule = (): void => {
    const wait = waitFor(step);
    handle = setTimer(() => {
      // Cleared BEFORE the attempt, not after: `attempt` may disarm this schedule synchronously
      // (a refresh that succeeds against a fake wire does), and a write afterwards would put a
      // live handle back on a gate somebody had just opened.
      handle = null;
      made += 1;
      step += 1;
      attempt();
      // `handle === null` is the test that the attempt did not disarm us — see above.
      if (handle === null && step > 0) schedule();
    }, wait);
  };

  return {
    arm() {
      if (handle !== null) return;
      schedule();
    },
    disarm() {
      if (handle !== null) clearTimer(handle);
      handle = null;
      step = 0;
      made = 0;
    },
    armed() {
      return handle !== null;
    },
    attempts() {
      return made;
    },
    pendingWaitMs() {
      return handle === null ? 0 : waitFor(step);
    },
  };
}

/**
 * The code a gated door answers with. It is the API's own word for a session that is over, so a
 * surface reading this refusal reads exactly what it reads when the server says it — the gate
 * must be invisible to every classifier above it, or it becomes a second taxonomy nobody renders.
 */
export const SESSION_ENDED_CODE = "session_ended";

/**
 * WHAT A CLOSED DOOR ANSWERS — a 401 in ohmail's own envelope, built here, no wire touched.
 *
 * Not a thrown error: every caller of a transport already handles the server's 401 (that is the
 * whole point of answering in its shape), and a throw would take a different path through code
 * written for a network fault.
 */
export function sessionEndedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: SESSION_ENDED_CODE,
        message: "this browser's session has ended",
        retryable: false,
      },
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}
