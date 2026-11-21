/**
 * THE FIRST PULL'S RATE AND ETA — every rule that keeps this screen from inventing a number.
 *
 * The whole reason `pull-rate.ts` exists as a pure module is that its rules are REFUSALS, and a
 * refusal is invisible in a rendered screen: "working out how long this takes" looks identical
 * whether the gate is working or the arithmetic silently produced nothing. Each `null` below is
 * therefore asserted on its own, with the state that must produce it.
 *
 * The mutation contract, for the guards that are load-bearing:
 *
 *  · drop the `span < RATE_MIN_SPAN_MS` gate  → "a burst measured over 20 s is not the rate"
 *  · drop the `delta <= 0` gate               → "a mirror that stopped growing claims no rate"
 *  · make `pullRemaining` clamp at `>= 0`     → "a server total below the mirror says nothing"
 *  · drop the same-instant collapse           → "two reads in one millisecond are one sample"
 */
import { describe, expect, it } from "vitest";
import {
  RATE_MIN_SPAN_MS, RATE_WINDOW_MS,
  pullEtaMs, pullRate, pullRemaining, pullSampleStep,
} from "@ohmail/app-logic/mailboxes/first-run/pull-rate";

const t0 = 1_760_000_000_000;
/** Fold a list of `[msFromT0, count]` observations, oldest first. */
const fold = (obs: Array<[number, number]>) =>
  obs.reduce<Parameters<typeof pullRate>[0]>(
    (acc, [dt, n]) => pullSampleStep(acc, n, t0 + dt), [],
  );

describe("no rate is claimed before there is evidence for one", () => {
  it("one sample is not a rate", () => {
    expect(pullRate(fold([[0, 100]]))).toBeNull();
  });

  it("a burst measured over twenty seconds is not the rate — the gate is two minutes", () => {
    // A burst in 20 s reads as a high rate a minute, and the worker's cycle is 60 s: the next 40 s add
    // nothing. Announcing 900 would put an ETA on screen that is wrong by a factor of seven.
    const samples = fold([[0, 0], [20_000, 300]]);
    expect(pullRate(samples)).toBeNull();
  });

  it("the same span one millisecond past the gate DOES answer — the boundary is real", () => {
    const under = fold([[0, 0], [RATE_MIN_SPAN_MS - 1, 300]]);
    const over = fold([[0, 0], [RATE_MIN_SPAN_MS, 300]]);
    expect(pullRate(under)).toBeNull();
    expect(pullRate(over)).toBeCloseTo((300 / RATE_MIN_SPAN_MS) * 60_000, 6);
  });

  it("a mirror that has not grown across the window claims nothing", () => {
    expect(pullRate(fold([[0, 400], [RATE_MIN_SPAN_MS + 1_000, 400]]))).toBeNull();
  });

  it("a mirror that SHRANK claims nothing — a backfill moving mail out is not negative progress", () => {
    expect(pullRate(fold([[0, 400], [RATE_MIN_SPAN_MS + 1_000, 380]]))).toBeNull();
  });

  it("over a real window it is messages a minute", () => {
    // A steady stream of messages over four minutes.
    const samples = fold([[0, 0], [120_000, 210], [240_000, 420]]);
    expect(pullRate(samples)).toBeCloseTo(105, 6);
  });
});

describe("the sample window rolls", () => {
  it("samples older than the window are dropped", () => {
    const kept = pullSampleStep(
      [{ at: t0, count: 1 }, { at: t0 + 1_000, count: 2 }],
      3, t0 + RATE_WINDOW_MS + 2_000,
    );
    expect(kept.map((s) => s.count)).toEqual([3]);
  });

  it("the window is LONGER than the gate, so the rate does not flicker at the boundary", () => {
    // At exactly the minimum span every new sample would evict the one it needs to be measured
    // against, and the rate would appear and vanish on alternate observations.
    expect(RATE_WINDOW_MS).toBeGreaterThan(RATE_MIN_SPAN_MS);
    const samples = fold([[0, 0], [RATE_MIN_SPAN_MS, 200], [RATE_MIN_SPAN_MS + 5_000, 210]]);
    expect(pullRate(samples)).not.toBeNull();
  });

  it("two reads at the same instant are ONE sample, so no zero-length span enters the window", () => {
    const once = pullSampleStep([], 10, t0);
    const twice = pullSampleStep(once, 11, t0);
    expect(twice).toHaveLength(1);
    expect(twice[0]).toEqual({ at: t0, count: 11 });
  });
});

describe("what is still to come, and what may be said about it", () => {
  it("nothing at all when the server has not counted a folder", () => {
    expect(pullRemaining(undefined, 120)).toBeNull();
  });

  it("the difference, when it has", () => {
    expect(pullRemaining(2_285, 1_135)).toBe(1_150);
  });

  it("NULL and not zero when the mirror has caught up — a running pull may not say '0 left'", () => {
    expect(pullRemaining(2_285, 2_285)).toBeNull();
  });

  it("NULL and not a negative when the server total sits BELOW the mirror", () => {
    // The sum covers only the folders a cycle has OPENED, so early in a first pull the mirror
    // legitimately holds mail from folders nobody has counted. A negative "still to read" is
    // absurd; a confident "0" over a running pull is worse.
    expect(pullRemaining(500, 900)).toBeNull();
  });
});

describe("the ETA is the two of them and nothing else", () => {
  it("no remaining ⇒ no ETA", () => {
    expect(pullEtaMs(null, 210)).toBeNull();
  });

  it("no rate ⇒ no ETA, however well known the remainder is", () => {
    expect(pullEtaMs(1_150, null)).toBeNull();
  });

  it("a zero rate ⇒ no ETA rather than an infinite one", () => {
    expect(pullEtaMs(1_150, 0)).toBeNull();
  });

  it("remaining over rate, in milliseconds", () => {
    // 840 left at 210 a minute is four minutes.
    expect(pullEtaMs(840, 210)).toBe(4 * 60_000);
  });
});
