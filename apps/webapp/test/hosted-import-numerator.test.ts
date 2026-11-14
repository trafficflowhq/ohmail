import { describe, expect, it } from "vitest";
import {
  deriveMailState,
  firstRunProgress,
  growthStep,
  seedGrowth,
  type MailStateInputs,
  type MailboxFacts,
} from "@ohmail/app-logic/mail-state/mail-state";
import { pullEtaMs, pullRate, pullRemaining, pullSampleStep } from "../app/shell/pull-rate";

/**
 * ═══ THE HOSTED FIRST RUN'S NUMERATOR ══════════════════════════════════════════════════════
 *
 * A browser mirror is a cache in front of a server that holds everything, and it is WINDOWED:
 * `BROWSER_WINDOW` keeps a span of days or a floor of rows, whichever is larger, and the engine evicts the
 * rest as the pages land. The first-run surfaces published that row count as an import's
 * progress, so on any mailbox bigger than the window the sentence climbed to the floor and
 * stopped — measured in `packages/client-engine/test/received-messages-windowed.test.ts` at
 * the floor's rows held for twenty consecutive pages while many times as many were taken in.
 *
 * The numerator is {@link firstRunProgress} over the reader's own count. Every guard below was
 * watched RED against a named mutation, then the implementation was restored.
 */

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

/** The window's floor, spelled as `store-windows.ts` spells it — the number the mirror pins at. */
const FLOOR = 5_000;
/** What the account actually holds. */
const ACCOUNT = 15_000;

const mailbox = (over: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id: "mb1",
  address: "desk@trafficflow.invalid",
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: new Date(NOW - 30_000).toISOString(),
  initialImportCompletedAt: null, // an import is open
  createdAt: new Date(NOW - 600_000).toISOString(),
  hostedMessageCount: ACCOUNT,
  ...over,
});

/** A latched import episode: two rises inside the window, which is what `isImporting` needs. */
function importingTo(to: number): ReturnType<typeof seedGrowth> {
  let g = seedGrowth(0);
  g = growthStep(g, Math.max(1, Math.floor(to / 2)), NOW - 8_000);
  return growthStep(g, to, NOW);
}

const inputs = (over: Partial<MailStateInputs> = {}): MailStateInputs => ({
  sync: { bootstrapping: false, failures: 0, terminal: false, refused: false, ownerLost: false },
  failureStreak: 3,
  freshness: { state: "current" as const, asOf: new Date(NOW - 30_000).toISOString() },
  engineFreshness: { state: "current" as const, asOf: new Date(NOW - 30_000).toISOString() },
  mailboxes: [mailbox()],
  mirrored: FLOOR,
  growth: importingTo(FLOOR),
  now: NOW,
  demo: false,
  ...over,
  pulled: over.pulled ?? over.mirrored ?? FLOOR,
});

describe("firstRunProgress — one selector, and what each producer contributes", () => {
  /**
   * THE HOSTED PRODUCER. WATCHED RED by `return mirrored;` in place of the `Math.max` (the base
   * behaviour this lane replaces): the floor, not the reader's count.
   */
  it("takes the reader's count over a mirror pinned at the window's floor", () => {
    expect(firstRunProgress({ mirrored: FLOOR, received: 12_400 })).toBe(12_400);
  });

  /**
   * THE FLOOR, WHICH IS NOT A PRODUCER. A reader that has not counted — a tab reloaded part-way
   * through an import, an engine older than the counter — must leave the number where it stands
   * rather than take it backwards to zero.
   *
   * WATCHED RED by `return received ?? 0;`: 0, not the count on screen.
   */
  it("never reads below what is already on screen", () => {
    expect(firstRunProgress({ mirrored: FLOOR, received: null })).toBe(FLOOR);
    expect(firstRunProgress({ mirrored: FLOOR, received: 120 })).toBe(FLOOR);
  });

  /**
   * THE DOOR THIS LANE DOES NOT TOUCH. Where no producer answers, the selector is the identity on
   * the mirror's count — which is what every surface published before this lane, so a door that
   * gains no producer cannot change behaviour by this change alone.
   *
   * WATCHED RED by `return Math.max(mirrored, received ?? mirrored) + 1;` (a contrived drift):
   * one more than the identity, not the identity.
   */
  it("is the identity where nothing counted", () => {
    for (const n of [0, 1, 495, FLOOR, ACCOUNT]) {
      expect(firstRunProgress({ mirrored: n, received: null })).toBe(n);
    }
  });
});

describe("the strip's importing arm", () => {
  /**
   * THE FALSE STATE, AND THE TRUE ONE. `count` is what the sentence says; the base quoted the
   * mirror and said "N of M" with N stuck at the floor for hours.
   *
   * WATCHED RED by `count: mirrored` in both `importing` arms of `climb`: the floor, not the pulled count.
   */
  it("quotes what has been pulled, not what the device holds", () => {
    const state = deriveMailState(inputs({ mirrored: FLOOR, pulled: 12_400, growth: importingTo(12_400) }));
    expect(state.key).toBe("importing");
    expect(state.count).toBe(12_400);
    expect(state.total).toBe(ACCOUNT);
  });

  /**
   * AND IT STOPS QUOTING A PAIR IT HAS PASSED. `deviceHoldings` withholds the total once the
   * numerator reaches it, so a finished import reads as a count and not as a fraction stuck at
   * the floor — the difference between a count and an "N of M" for ever.
   *
   * WATCHED RED by `deviceHoldings(mailboxes, mirrored)` for `totalIfAhead`: the total comes back
   * as a total behind its numerator, which is the fraction the guard exists to refuse.
   */
  it("withholds the total once the import has reached it", () => {
    const state = deriveMailState(inputs({
      mirrored: FLOOR, pulled: ACCOUNT, growth: importingTo(ACCOUNT),
    }));
    expect(state.key).toBe("importing");
    expect(state.count).toBe(ACCOUNT);
    expect(state.total).toBeNull();
  });
});

describe("the first-run pull stage's rate and estimate", () => {
  /**
   * A FINISHED IMPORT IS NOT "N STILL TO READ". `pullRemaining`'s numerator is the same
   * selector, so the remainder closes when the import does; on the base it stayed put for
   * ever, and the bar sat at a third.
   *
   * WATCHED RED by passing the mirror's count instead: 10 000, not null.
   */
  it("closes the remainder when the import finishes", () => {
    const pulled = firstRunProgress({ mirrored: FLOOR, received: ACCOUNT });
    expect(pullRemaining(ACCOUNT, pulled)).toBeNull();
    // The base's reading, kept as the control that the two differ at all.
    expect(pullRemaining(ACCOUNT, FLOOR)).toBe(ACCOUNT - FLOOR);
  });

  /**
   * AND A RATE EXISTS AT ALL. The sampler folds the numerator; a number that stops moving folds
   * a rate of zero and `pullEtaMs` then has nothing to divide by, so no estimate ever appeared.
   *
   * WATCHED RED by folding `FLOOR` into both samples: the rate is null and so is the estimate.
   */
  it("folds a rate the pinned number could not", () => {
    let samples = pullSampleStep([], firstRunProgress({ mirrored: FLOOR, received: 6_000 }), NOW);
    samples = pullSampleStep(samples, firstRunProgress({ mirrored: FLOOR, received: 9_000 }), NOW + 180_000);
    const rate = pullRate(samples);
    expect(rate).not.toBeNull();
    expect(rate!).toBeGreaterThan(0);
    expect(pullEtaMs(pullRemaining(ACCOUNT, 9_000), rate)).not.toBeNull();

    // The pinned number, side by side: two samples of one value is no rate and no estimate.
    let pinned = pullSampleStep([], FLOOR, NOW);
    pinned = pullSampleStep(pinned, FLOOR, NOW + 180_000);
    expect(pullRate(pinned)).toBeNull();
    expect(pullEtaMs(pullRemaining(ACCOUNT, FLOOR), pullRate(pinned))).toBeNull();
  });
});
