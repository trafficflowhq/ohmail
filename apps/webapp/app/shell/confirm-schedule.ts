/**
 * ═══ HOW LONG TO WAIT BEFORE ASKING "WHOSE MAILBOX IS THIS?" AGAIN ════════════════════════
 *
 * The session confirm is one `GET /auth/session`, and until this module existed a single
 * failure of it was rendered as a verdict about the account: "You are signed out." over a
 * live session, measured in production as a `503 db_busy` — the API's own name for a pooled
 * connection it could not get within its ceiling. That answer carries
 * `retryable: true` and `Retry-After: 5` and a message ending *"retry shortly"*, and the
 * shell answered it by telling the user they were signed out. `AUTH-FLICKER-DIAGNOSIS.md`
 * has the failing request and the eleven-case reproduction.
 *
 * So the shell retries. This file is the whole of WHEN, kept pure — no timers, no React, no
 * transport — so the arithmetic is testable without a clock and identical everywhere it is
 * read.
 *
 * ── THE CONSTANTS ARE CONSTANTS, AND THAT IS A DECISION ─────────────────────────────────────
 *
 * There is deliberately no injectable schedule: `EngineProvider` takes no `schedule` prop and
 * no `Partial<Schedule>` override. A configurable schedule with defaults means the shipped
 * numbers are the ones no test ever drives — the tests exercise the fast injected values and
 * the product runs the untested branch. This repository has already paid for that shape
 * (`failure-looks-like-healthy`: three reliability features shipped broken, each rendering as
 * its own healthy state). Tests here use fake timers against THESE numbers and assert the
 * bounds the jitter allows.
 *
 * ── FOUR ATTEMPTS, NOT "UNTIL IT WORKS" ────────────────────────────────────────────────────
 *
 * The confirm sits in front of the first paint of the product's front door, so the ladder has
 * to end. Four asks — one plus three retries — spans roughly 1–20 s of real waiting against
 * an unseeded schedule and up to ~30 s when the server named a long `Retry-After`. After the
 * fourth the shell says what is true (the check did not finish) rather than what is false
 * (the session ended). A person who is willing to wait longer presses Try again.
 */

/** Asks in one ladder: the first, plus three retries. */
export const CONFIRM_ATTEMPTS = 4;

/**
 * The base wait when the server named none.
 *
 * Short on purpose. The commonest transient this absorbs is a single starved connection or a
 * gateway blink, both of which are over in well under a second, and a first retry that lands
 * inside ~600 ms is invisible: the warm mirror is still painting and nothing on screen has
 * changed. It is the same judgement `SessionScreen`'s loading grace makes — a message that
 * flashes for a third of a second is worse than a quiet frame.
 */
export const CONFIRM_SEED_MS = 600;

/**
 * The ceiling on one wait, `Retry-After` included.
 *
 * The server's `Retry-After` is ADVICE about the server and this is a bound about the person
 * in front of the screen. `db_busy` names five seconds and a future refusal could name sixty;
 * holding a blank front door for a minute because a header said so would be obeying the
 * wrong constituency. So the header seeds the wait and this clamps it, which is the same
 * split `session-gate.ts` makes at the edge with its own 1.5 s budget.
 */
export const CONFIRM_CAP_MS = 8_000;

/**
 * How long to wait before retry number `attempt` (1 = the first retry).
 *
 * `retryAfterMs` is the server's own advice when it sent a `Retry-After`, and `null` when it
 * did not. It SEEDS the backoff rather than replacing it: a server that is busy now is likely
 * to be busy on the next ask too, so the doubling still applies on top of what it asked for,
 * and {@link CONFIRM_CAP_MS} still bounds the result.
 *
 * FULL JITTER on the whole delay — `× (0.5 + 0.5·random)`, so the answer is always in
 * `[delay/2, delay]`. Not decoration: every tab that woke together, or every tab reloaded
 * after an API deploy, is running this ladder against the same instance, and a fixed backoff
 * makes them all return at the same instant — which is the shape that keeps a starved pool
 * starved. `sync-scheduler.ts` jitters its own backoff for the same reason and records the
 * measurement behind it.
 *
 * Never returns 0: a caller that treats 0 as "ask immediately" would turn a clamped-to-zero
 * schedule into a hot loop against a server that just refused.
 */
export function nextConfirmDelay(attempt: number, retryAfterMs: number | null): number {
  const base = retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : CONFIRM_SEED_MS;
  // `attempt` is clamped low as well as high. A caller that passes 0 or a negative would
  // otherwise get a FRACTION of the base through `2^(attempt-1)`, i.e. a faster retry the
  // less it was owed — the opposite of a backoff, and silent.
  const step = Math.max(1, Math.floor(attempt));
  const raw = Math.min(CONFIRM_CAP_MS, base * 2 ** (step - 1));
  return Math.max(1, Math.round(raw * (0.5 + 0.5 * Math.random())));
}
