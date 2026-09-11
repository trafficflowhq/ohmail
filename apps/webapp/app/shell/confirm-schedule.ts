/**
 * How long to wait before asking "whose mailbox is this?" again. A single failed
 * `GET /auth/session` used to render as a verdict — "You are signed out." over a live session,
 * measured in production as a `503 db_busy` that carried `retryable: true` and `Retry-After: 5`
 */

/**
 * (`AUTH-FLICKER-DIAGNOSIS.md`). So the shell retries, and this file is the whole of WHEN, kept
 * pure — no timers, no React — so the arithmetic is testable without a clock. The constants are
 * constants, deliberately: an injectable schedule means the shipped numbers are the ones no test
 * drives (`failure-looks-like-healthy` is the paid-for lesson); tests use fake timers against
 * THESE numbers. Four attempts, not "until it works": the confirm sits in front of first paint,
 * so the ladder ends (~1–20 s, up to ~30 s under a long `Retry-After`) and after the fourth the
 * shell says what is true — the check did not finish — with Try again for anybody willing to wait.
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
 * How long to wait before retry number `attempt` (1 = the first retry). `retryAfterMs` is the
 * server's own advice and SEEDS the backoff rather than replacing it: a server busy now is likely
 * busy on the next ask, so the doubling applies on top and {@link CONFIRM_CAP_MS} still bounds the
 * result. Full jitter on the whole delay (`× (0.5 + 0.5·random)`), not decoration: every tab that
 * woke together or reloaded after a deploy runs this ladder against the same instance, and a fixed
 * backoff returns them all at the same instant — the shape that keeps a starved pool starved
 * (`sync-scheduler.ts` records the measurement). Never returns 0: a caller treating 0 as "ask
 * immediately" would turn a clamped schedule into a hot loop against a server that just refused.
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
