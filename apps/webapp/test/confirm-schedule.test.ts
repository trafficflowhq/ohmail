/**
 * ═══ THE RETRY SCHEDULE'S ARITHMETIC ══════════════════════════════════════════════════════
 *
 * `confirm-schedule.ts` decides how long the shell waits before re-asking whose mailbox this
 * is. It is pure on purpose, and it is tested against the SHIPPED constants rather than
 * against injected ones — there is deliberately no `schedule` prop on `EngineProvider`,
 * because a configurable schedule with defaults means the numbers in production are the
 * numbers no test drives.
 *
 * Jitter means every assertion here is a WINDOW. So each is checked over many draws with the
 * generator left alone, which is what makes "always inside `[delay/2, delay]`" a claim about
 * the function rather than about one lucky number.
 */
import { describe, expect, it } from "vitest";
import {
  CONFIRM_ATTEMPTS, CONFIRM_CAP_MS, CONFIRM_SEED_MS, nextConfirmDelay,
} from "@ohmail/app-logic/session/confirm-schedule";

/** Every delay the function can produce for these arguments, over enough draws to bound it. */
function draws(attempt: number, retryAfterMs: number | null, n = 4_000): number[] {
  return Array.from({ length: n }, () => nextConfirmDelay(attempt, retryAfterMs));
}

const within = (values: number[], lo: number, hi: number): void => {
  expect(Math.min(...values), `a draw fell below ${lo}`).toBeGreaterThanOrEqual(lo);
  expect(Math.max(...values), `a draw rose above ${hi}`).toBeLessThanOrEqual(hi);
};

describe("the constants are the ones the product ships", () => {
  it("four asks, a 600 ms seed and an 8 s ceiling", () => {
    // Pinned rather than derived: these three numbers are the product's answer to "how long
    // is a person made to wait before being told the check did not finish", and a change to
    // any of them is a change to that answer.
    expect(CONFIRM_ATTEMPTS).toBe(4);
    expect(CONFIRM_SEED_MS).toBe(600);
    expect(CONFIRM_CAP_MS).toBe(8_000);
  });
});

describe("with no advice from the server, the seed doubles", () => {
  it("the first retry lands in [300, 600]", () => {
    within(draws(1, null), 300, 600);
  });

  it("the second in [600, 1200] and the third in [1200, 2400]", () => {
    within(draws(2, null), 600, 1_200);
    within(draws(3, null), 1_200, 2_400);
  });

  it("and it never exceeds the ceiling however far the ladder is pushed", () => {
    within(draws(9, null), 1, CONFIRM_CAP_MS);
    within(draws(40, null), 1, CONFIRM_CAP_MS);
  });
});

describe("Retry-After seeds the backoff rather than replacing it", () => {
  it("the API's own 5 s on db_busy gives a first retry in [2500, 5000]", () => {
    // The measured production case. `db503` sends `Retry-After: 5`, and this window is what
    // `session-confirm-retries.test.ts` asserts against the real wire.
    within(draws(1, 5_000), 2_500, 5_000);
  });

  it("the doubling still applies on top of it, up to the ceiling", () => {
    // The doubled delay past the cap is clamped to it, so the window is [4000, 8000] rather than
    // [5000, 10000]. A server that is busy now is likely busy on the next ask too.
    within(draws(2, 5_000), 4_000, CONFIRM_CAP_MS);
  });

  it("A SIXTY-SECOND Retry-After is clamped to the ceiling, not obeyed", () => {
    // How long a server wants to be left alone and how long a person will look at a blank
    // front door are different questions. The header is advice; this is the answer.
    within(draws(1, 60_000), CONFIRM_CAP_MS / 2, CONFIRM_CAP_MS);
    expect(Math.max(...draws(1, 60_000))).toBeLessThanOrEqual(CONFIRM_CAP_MS);
  });

  it("a zero or negative Retry-After falls back to the seed rather than to no wait", () => {
    // `api-client.ts` already refuses to parse these into `wire.retryAfterMs`, so this is the
    // second line: a caller that hands one straight through must not get a hot loop.
    within(draws(1, 0), 300, 600);
    within(draws(1, -5_000), 300, 600);
  });
});

describe("the jitter is full jitter, and it is really there", () => {
  it("draws spread across the lower half as well as the upper", () => {
    const values = draws(1, 5_000);
    const distinct = new Set(values).size;
    expect(distinct, "the delay is constant — N tabs would return in lockstep")
      .toBeGreaterThan(100);
    // Both halves of the window are reachable: a "jitter" that only ever shaved a few
    // milliseconds would pass a bounds check and buy nothing.
    expect(values.some((v) => v < 3_000), "no draw landed near the floor").toBe(true);
    expect(values.some((v) => v > 4_500), "no draw landed near the ceiling").toBe(true);
  });

  it("never returns zero, at any attempt", () => {
    for (const attempt of [0, 1, 2, 3, 4, 10]) {
      expect(Math.min(...draws(attempt, null, 500)), `attempt ${attempt} returned 0`)
        .toBeGreaterThan(0);
    }
  });
});

describe("a nonsense attempt number cannot buy a FASTER retry", () => {
  it("0 and negatives are clamped to the first retry", () => {
    // `2^(attempt-1)` with attempt 0 is 0.5 — a caller that got its indexing wrong would be
    // rewarded with half the wait, silently. The floor is the whole guard.
    within(draws(0, null), 300, 600);
    within(draws(-3, null), 300, 600);
  });

  it("a fractional attempt floors rather than interpolating", () => {
    within(draws(1.9, null), 300, 600);
  });
});
