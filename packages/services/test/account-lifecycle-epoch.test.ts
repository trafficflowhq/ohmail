import { describe, it, expect } from "vitest";
import type { AccessLifecycle } from "@trafficflow/db";
import {
  erasureDue, erasureClearsEpoch, erasureWarnedFrom, noticesDue, readLifecycleEpoch, ERASURE_SLACK_MS,
  ERASURE_REMINDER_AHEAD_MS,
} from "../src/account-lifecycle-pass.js";

/**
 * THE EPOCH BELT AT THE ERASURE DOOR (owner ruling 2026-09-22). The entitlements program derives
 * `erasureAt` from anchors that predate its own lifecycle half, so before it floored them an
 * account that closed earlier carried a date already in the past — and this pass would have
 * erased it on its first run, with no erasure-week notice ever sent. The program now floors the
 * forecast at the instant it went live and publishes that instant beside it; this asks the same
 * question here, because erasure is irreversible and does not rest on the other program keeping
 * its word.
 */
const DAY = 24 * 60 * 60 * 1000;
const EPOCH = "2026-09-22T00:00:00.000Z";
const epochMs = Date.parse(EPOCH);
const iso = (ms: number) => new Date(ms).toISOString();

/** A closed account whose dates the case names; every other field is the ordinary closure. */
function closed(over: Partial<AccessLifecycle> = {}): AccessLifecycle {
  return {
    state: "closed", closedReason: "trial_ended", trialEndsAt: null, graceUntil: null,
    closedAt: "2026-08-20T00:00:00.000Z", erasureAt: "2026-09-19T00:00:00.000Z",
    erasedAt: null, formerlyPaid: false, lifecycleEpoch: EPOCH, ...over,
  };
}

describe("erasureDue — the lifecycle epoch is a floor under an irreversible act", () => {
  it("a forecast from BEFORE the epoch is NOT due, however far past it reads", () => {
    // The shape FREEZE-022 measured: a trial that ended 2026-08-19 and never paid, its date
    // four days past on the day the program deploys. Without the belt this is the first erasure.
    const lc = closed();
    const now = new Date("2026-10-30T00:00:00.000Z");     // six weeks past the stale date
    expect(new Date(lc.erasureAt!).getTime() + ERASURE_SLACK_MS).toBeLessThan(now.getTime());
    expect(erasureClearsEpoch(lc)).toBe(false);
    expect(erasureDue(lc, now)).toBe(false);
  });

  it("THE POSITIVE CONTROL: the floored forecast, a day past, IS due", () => {
    // The same account read from a program that floors: 30 days from the epoch, then the slack.
    const erasureAt = iso(epochMs + 30 * DAY);
    const lc = closed({ erasureAt });
    expect(erasureClearsEpoch(lc)).toBe(true);
    expect(erasureDue(lc, new Date(Date.parse(erasureAt) + ERASURE_SLACK_MS))).toBe(true);
    // And an hour before the slack ends it is still not due — the belt did not move that edge.
    expect(erasureDue(lc, new Date(Date.parse(erasureAt) + ERASURE_SLACK_MS - 3_600_000)))
      .toBe(false);
  });

  it("the boundary is the epoch plus the same day of slack, not the epoch itself", () => {
    const far = new Date("2027-01-01T00:00:00.000Z");
    expect(erasureDue(closed({ erasureAt: iso(epochMs) }), far)).toBe(false);
    expect(erasureDue(closed({ erasureAt: iso(epochMs + ERASURE_SLACK_MS - 1) }), far)).toBe(false);
    expect(erasureDue(closed({ erasureAt: iso(epochMs + ERASURE_SLACK_MS) }), far)).toBe(true);
  });

  it("a hold is still refused first, epoch or no epoch", () => {
    const lc = closed({
      closedReason: "suspended", erasureAt: iso(epochMs + 30 * DAY), lifecycleEpoch: EPOCH,
    });
    expect(erasureClearsEpoch(lc)).toBe(true);
    expect(erasureDue(lc, new Date("2027-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("the notices follow the floored date: the erasure week is a week before THAT", () => {
    // The point of flooring rather than refusing: the account gets the same sequence a fresh
    // closure gets, a week's warning included.
    const erasureAt = iso(epochMs + 30 * DAY);
    const lc = closed({ erasureAt });
    const week = noticesDue(lc, new Date(Date.parse(erasureAt) - 3 * DAY));
    expect(week.map((n) => n.kind)).toEqual(["closed", "erasure_week"]);
    expect(week[1]!.anchor.toISOString()).toBe(erasureAt);
    // And nothing is warned about a stale date that this pass will never act on.
    const stale = noticesDue(closed(), new Date("2026-10-30T00:00:00.000Z"));
    expect(stale.map((n) => n.kind)).toEqual(["closed"]);
  });
});

describe("the belt FAILS CLOSED — a program that cannot state its epoch erases nothing", () => {
  // A floored-looking date, long past: with a readable epoch this account IS due, so each shape
  // below differs from the positive control by the epoch alone.
  const erasureAt = iso(epochMs + 30 * DAY);
  const far = new Date("2027-01-01T00:00:00.000Z");

  it("THE POSITIVE CONTROL: a stated epoch in the past clears the same date", () => {
    const lc = closed({ erasureAt });
    expect(readLifecycleEpoch(lc)).toEqual({ ms: epochMs });
    expect(erasureClearsEpoch(lc)).toBe(true);
    expect(erasureDue(lc, far)).toBe(true);
  });

  it("the field MISSING (a rollback to a program without the floor) clears nothing", () => {
    const { lifecycleEpoch: _drop, ...rest } = closed({ erasureAt });
    const lc = rest as AccessLifecycle;
    expect("lifecycleEpoch" in lc).toBe(false);
    expect(readLifecycleEpoch(lc)).toEqual({ absent: "not_stated" });
    expect(erasureClearsEpoch(lc)).toBe(false);
    expect(erasureDue(lc, far)).toBe(false);
  });

  it("an explicit NULL clears nothing", () => {
    const lc = closed({ erasureAt, lifecycleEpoch: null });
    expect(readLifecycleEpoch(lc)).toEqual({ absent: "not_stated" });
    expect(erasureClearsEpoch(lc)).toBe(false);
    expect(erasureDue(lc, far)).toBe(false);
  });

  it("a stamp that is not a date clears nothing", () => {
    const lc = closed({ erasureAt, lifecycleEpoch: "the day we deployed" });
    expect(readLifecycleEpoch(lc)).toEqual({ absent: "unparseable" });
    expect(erasureClearsEpoch(lc)).toBe(false);
    expect(erasureDue(lc, far)).toBe(false);
  });

  it("a stamp at or before 1970 floors nothing, so it clears nothing", () => {
    for (const stamp of ["1970-01-01T00:00:00.000Z", "1969-12-31T00:00:00.000Z"]) {
      const lc = closed({ erasureAt, lifecycleEpoch: stamp });
      expect(readLifecycleEpoch(lc)).toEqual({ absent: "not_positive" });
      expect(erasureClearsEpoch(lc)).toBe(false);
      expect(erasureDue(lc, far)).toBe(false);
    }
  });
});

describe("the notices read the epoch the way the erasure does (EPOCH-BELT-CLOSED-ERASURE-WEEK-STILL-SENT)", () => {
  const erasureAt = iso(epochMs + 30 * DAY);
  const inTheWeek = new Date(Date.parse(erasureAt) - 3 * DAY);
  const kinds = (lc: AccessLifecycle, now: Date) => noticesDue(lc, now).map((n) => [n.kind, n.erasureAt?.toISOString() ?? null]);

  it("THE POSITIVE CONTROL: a stated epoch sends the week's warning, and the closure names the date", () => {
    expect(kinds(closed({ erasureAt }), inTheWeek))
      .toEqual([["closed", erasureAt], ["erasure_week", erasureAt]]);
  });

  it("no readable epoch: no erasure week, and the closure names no date the belt then refuses", () => {
    const { lifecycleEpoch: _drop, ...missing } = closed({ erasureAt });
    for (const lc of [
      missing as AccessLifecycle,
      closed({ erasureAt, lifecycleEpoch: null }),
      closed({ erasureAt, lifecycleEpoch: "the day we deployed" }),
      closed({ erasureAt, lifecycleEpoch: "1970-01-01T00:00:00.000Z" }),
    ]) {
      expect(erasureDue(lc, new Date("2027-01-01T00:00:00.000Z"))).toBe(false);
      expect(kinds(lc, inTheWeek)).toEqual([["closed", null]]);
    }
  });

  it("a date short of the epoch's day of slack is not warned about either", () => {
    const early = iso(epochMs + ERASURE_SLACK_MS / 2);
    const lc = closed({ erasureAt: early });
    expect(erasureClearsEpoch(lc)).toBe(false);
    expect(kinds(lc, new Date(Date.parse(early) - 3 * DAY))).toEqual([["closed", null]]);
  });
});

describe("a warning that never went out is still owed, late, and names a new date (ERASURE-WEEK-MAIL-LEAVES-NO-TRACE)", () => {
  const erasureAt = iso(epochMs + 30 * DAY);
  const twoDaysLate = new Date(Date.parse(erasureAt) + 2 * DAY);

  it("two days past the date: the closure names no date, the week's warning names a week from now", () => {
    const due = noticesDue(closed({ erasureAt }), twoDaysLate);
    expect(due.map((n) => [n.kind, n.erasureAt?.toISOString() ?? null])).toEqual([
      ["closed", null],
      ["erasure_week", iso(twoDaysLate.getTime() + ERASURE_REMINDER_AHEAD_MS)],
    ]);
    // Still keyed on the plane's date, so the delivered row is the one the erasure door reads.
    expect(due[1]!.anchor.toISOString()).toBe(erasureAt);
  });

  it("the erasure counts from the date a delivered warning gave: none, the plane's, or a week after a late one", () => {
    const anchor = new Date(erasureAt);
    expect(erasureWarnedFrom(anchor, null)).toBeNull();
    expect(erasureWarnedFrom(anchor, new Date(Date.parse(erasureAt) - 7 * DAY))).toEqual(anchor);
    expect(erasureWarnedFrom(anchor, anchor)).toEqual(anchor);
    expect(erasureWarnedFrom(anchor, twoDaysLate))
      .toEqual(new Date(twoDaysLate.getTime() + ERASURE_REMINDER_AHEAD_MS));
  });
});
