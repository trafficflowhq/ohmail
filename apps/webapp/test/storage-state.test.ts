import { describe, it, expect } from "vitest";
import {
  formatStorageBytes, storageDayName, storageFactsOf, storageKeptLine, storageLevelOf, storageMonthName, storageNoticeCap,
  storageNoticeDue, storageNoticeKey, storageNoticeKeyBefore, storageNoticeOffers, storagePlanOf, storageState,
  STORAGE_NEAR_CAP_RATIO,
} from "../app/shell/storage-state";

/**
 * THE STORAGE SENTENCE'S DERIVATION — pure over `GET /account/access`'s `storage` block. An absent or
 * malformed block says nothing, never "0 of 0"; mail is never said to stop at the cap.
 */
const block = (over: Record<string, unknown> = {}) => ({
  usedBytes: 1_000, limitBytes: 5_000_000_000, emptiedForSpace: 0, firstEmptiedAt: null, keptFrom: null, withheldOnArrival: 0, ...over,
});

describe("storageFactsOf", () => {
  it("narrows a well-formed block and drops what it cannot read", () => {
    expect(storageFactsOf(block({
      emptiedForSpace: 80_000, keptFrom: "2019-04", firstEmptiedAt: "2026-10-20T03:00:00.000Z", withheldOnArrival: 12,
    }))).toEqual({
      usedBytes: 1_000, limitBytes: 5_000_000_000, emptiedForSpace: 80_000, firstEmptiedAt: "2026-10-20T03:00:00.000Z",
      keptFrom: "2019-04", withheldOnArrival: 12, upgrade: "plan", emptyingNow: false, planLimitBytes: null, limitDropsAt: null,
    });
    expect(storageFactsOf(block({ keptFrom: "April" }))?.keptFrom).toBeNull();
    expect(storageFactsOf(block({ upgrade: "addon" }))?.upgrade).toBe("addon");
  });

  it("an older server's block has no arrivals; never more of them than letters emptied", () => {
    const older = { usedBytes: 1_000, limitBytes: 5_000_000_000, emptiedForSpace: 5, firstEmptiedAt: null, keptFrom: null };
    expect(storageFactsOf(older)?.withheldOnArrival).toBe(0);
    // No upgrade named, or one this client does not know: a bigger plan, as before.
    expect(storageFactsOf(older)?.upgrade).toBe("plan");
    expect(storageFactsOf(block({ upgrade: "gold" }))?.upgrade).toBe("plan");
    expect(storageFactsOf(block({ emptiedForSpace: 5, withheldOnArrival: 9 }))?.withheldOnArrival).toBe(5);
    // No word on whether the cap empties text now: only at the cap.
    expect(storageFactsOf({ ...older, usedBytes: 4_900_000_000 })?.emptyingNow).toBe(false);
    expect(storageFactsOf({ ...older, usedBytes: 5_000_000_000 })?.emptyingNow).toBe(true);
    expect(storageFactsOf(block({ emptyingNow: true }))?.emptyingNow).toBe(true);
  });

  it("the trial's floor: the plan's lower limit and the instant it applies again, or nothing", () => {
    const carry = { limitBytes: 4_000_000_000, planLimitBytes: 2_000_000_000 };
    expect(storageFactsOf(block({ ...carry, limitDropsAt: "2026-11-08T12:00:00.000Z" })))
      .toMatchObject({ planLimitBytes: 2_000_000_000, limitDropsAt: "2026-11-08T12:00:00.000Z" });
    expect(storageFactsOf(block({ ...carry, limitDropsAt: null }))).toMatchObject({ planLimitBytes: 2_000_000_000, limitDropsAt: null });
    expect(storageFactsOf(block({ ...carry, limitDropsAt: "soon" }))?.limitDropsAt).toBeNull();
    // A plan limit that does not lower the cap is no carry.
    expect(storageFactsOf(block({ ...carry, planLimitBytes: 4_000_000_000 }))?.planLimitBytes).toBeNull();
    expect(storageFactsOf(block({ ...carry, planLimitBytes: "2" }))?.planLimitBytes).toBeNull();
  });

  it("an absent block, a missing figure or a zero cap is no block at all", () => {
    expect(storageFactsOf(undefined)).toBeNull();
    expect(storageFactsOf(block({ usedBytes: undefined }))).toBeNull();
    expect(storageFactsOf(block({ emptiedForSpace: "3" }))).toBeNull();
    expect(storageFactsOf(block({ limitBytes: 0 }))).toBeNull();
  });
});

describe("storageState", () => {
  const cap = 5_000_000_000;
  it("says nothing below ninety percent — the row's numbers are the whole statement", () => {
    expect(storageState(storageFactsOf(block({ usedBytes: 0 })))).toBeNull();
    expect(storageState(storageFactsOf(block({ usedBytes: cap * STORAGE_NEAR_CAP_RATIO - 1 })))).toBeNull();
    expect(storageState(null)).toBeNull();
  });

  it("near from ninety percent, full at the cap, and emptied letters outrank both", () => {
    expect(storageState(storageFactsOf(block({ usedBytes: Math.ceil(cap * STORAGE_NEAR_CAP_RATIO) })))).toEqual({ kind: "near" });
    expect(storageState(storageFactsOf(block({ usedBytes: cap + 999 })))).toEqual({ kind: "full" });
    expect(storageState(storageFactsOf(block({ usedBytes: cap - 1, emptiedForSpace: 7, emptyingNow: true }))))
      .toEqual({ kind: "emptied", count: 7, current: true });
    // The count is of the oldest letters: those that arrived while the storage was full are not among them.
    expect(storageState(storageFactsOf(block({ usedBytes: cap - 1, emptiedForSpace: 7, withheldOnArrival: 2, emptyingNow: true }))))
      .toEqual({ kind: "emptied", count: 5, current: true });
  });

  it("whether the current cap empties text is the server's word, not a share of the cap", () => {
    expect(storageState(storageFactsOf(block({ usedBytes: 10, emptiedForSpace: 7 }))))
      .toEqual({ kind: "emptied", count: 7, current: false });
    expect(storageState(storageFactsOf(block({ usedBytes: cap * 0.92, emptiedForSpace: 7, emptyingNow: false }))))
      .toEqual({ kind: "emptied", count: 7, current: false });
    expect(storageState(storageFactsOf(block({ usedBytes: cap * 0.9, emptiedForSpace: 7, emptyingNow: true }))))
      .toEqual({ kind: "emptied", count: 7, current: true });
  });

  it("the notice's level: near from ninety percent, full at the cap or while text is emptied, past below", () => {
    expect(storageLevelOf(storageFactsOf(block())!)).toBeNull();
    expect(storageLevelOf(storageFactsOf(block({ usedBytes: Math.ceil(cap * STORAGE_NEAR_CAP_RATIO) }))!)).toBe("near");
    expect(storageLevelOf(storageFactsOf(block({ usedBytes: cap }))!)).toBe("full");
    expect(storageLevelOf(storageFactsOf(block({ usedBytes: cap * 0.9, emptiedForSpace: 7, emptyingNow: true }))!)).toBe("full");
    expect(storageLevelOf(storageFactsOf(block({ usedBytes: 10, emptiedForSpace: 7 }))!)).toBe("past");
    // Emptied under a smaller cap, then a bigger plan: nearing the new cap is near, never full.
    for (const share of [0.86, 0.92]) {
      expect(storageLevelOf(storageFactsOf(block({ usedBytes: cap * share, emptiedForSpace: 7, emptyingNow: false }))!), String(share))
        .toBe(share >= STORAGE_NEAR_CAP_RATIO ? "near" : "past");
    }
  });

  it("inside the trial's floor, nearing the plan's own limit is the carry level, put away apart from after it", () => {
    const carry = (usedBytes: number) =>
      storageFactsOf(block({ usedBytes, limitBytes: 4_000_000_000, planLimitBytes: 2_000_000_000, limitDropsAt: null }))!;
    expect(storageLevelOf(carry(3_500_000_000))).toBe("carry");
    expect(storageLevelOf(carry(1_800_000_000))).toBe("carry");
    expect(storageLevelOf(carry(1_700_000_000))).toBeNull();
    expect(storageLevelOf(carry(4_000_000_000))).toBe("full");
    // Put away inside the floor, it comes back once the plan's limit applies, and once a payment dates it.
    const held = new Set([storageNoticeKey("a", "full", storageNoticeCap(carry(4_000_000_000)))]);
    const after = storageFactsOf(block({ usedBytes: 2_000_000_000, limitBytes: 2_000_000_000, emptiedForSpace: 9, emptyingNow: true }));
    expect(storageNoticeDue(after, "a", (k) => held.has(k))).toBe("full");
    const dated = storageFactsOf(block({
      usedBytes: 3_500_000_000, limitBytes: 4_000_000_000, planLimitBytes: 2_000_000_000, limitDropsAt: "2026-11-08T12:00:00.000Z",
    }));
    held.add(storageNoticeKey("a", "carry", storageNoticeCap(carry(3_500_000_000))));
    expect(storageNoticeDue(carry(3_500_000_000), "a", (k) => held.has(k))).toBeNull();
    expect(storageNoticeDue(dated, "a", (k) => held.has(k))).toBe("carry");
    expect(storageDayName("2026-11-08T12:00:00.000Z", "en")).toBe("November 8, 2026");
  });

  it("put away at a level, the notice comes back at a worse one or under another cap", () => {
    const near = storageFactsOf(block({ usedBytes: Math.ceil(cap * STORAGE_NEAR_CAP_RATIO) }));
    const full = storageFactsOf(block({ usedBytes: cap * 0.9, emptiedForSpace: 7, emptyingNow: true }));
    const held = new Set<string>();
    const putAway = (key: string) => held.has(key);
    expect(storageNoticeDue(near, "a", putAway)).toBe("near");
    held.add(storageNoticeKey("a", "near", cap));
    expect(storageNoticeDue(near, "a", putAway)).toBeNull();
    expect(storageNoticeDue(near, "b", putAway)).toBe("near");
    expect(storageNoticeDue(full, "a", putAway)).toBe("full");
    held.add(storageNoticeKey("a", "full", cap));
    expect(storageNoticeDue(full, "a", putAway)).toBeNull();
    // Put away at the cap, nearing it again is not worse.
    held.delete(storageNoticeKey("a", "near", cap));
    expect(storageNoticeDue(near, "a", putAway)).toBeNull();
    // A bigger plan since: nearing the new cap is news.
    expect(storageNoticeDue(storageFactsOf(block({ limitBytes: 2 * cap, usedBytes: 1.9 * cap })), "a", putAway)).toBe("near");
    expect(storageNoticeDue(storageFactsOf(block()), "a", putAway)).toBeNull();
    expect(storageNoticeDue(null, "a", putAway)).toBeNull();
  });

  it("a trial is offered a bigger plan, an active subscription the plan or the add-on, nothing else anything", () => {
    expect(storagePlanOf("trialing")).toBe("trial");
    expect(storagePlanOf("active")).toBe("active");
    for (const state of ["past_due", "grace", "closed", undefined]) expect(storagePlanOf(state), String(state)).toBeNull();
  });

  it("names the kept-from month in the reader's language, in any zone", () => {
    expect(storageMonthName("2019-04", "en")).toBe("April 2019");
    expect(storageMonthName("2019-01", "de")).toBe("Januar 2019");
  });

  it("the month's sentence excepts the letters that arrived while the storage was full", () => {
    const facts = (over: Record<string, unknown>) => storageFactsOf(block({ emptiedForSpace: 9, ...over }))!;
    expect(storageKeptLine(facts({ keptFrom: "2019-04" }), "en"))
      .toEqual({ key: "storageNoticeKeptFrom", values: { month: "April 2019" } });
    expect(storageKeptLine(facts({ keptFrom: "2019-04", withheldOnArrival: 2 }), "en"))
      .toEqual({ key: "storageNoticeKeptFromExcept", values: { month: "April 2019", count: 2 } });
    expect(storageKeptLine(facts({ withheldOnArrival: 2 }), "en"))
      .toEqual({ key: "storageNoticeOnArrival", values: { count: 2 } });
    expect(storageKeptLine(facts({}), "en")).toBeNull();
  });
});

describe("formatStorageBytes", () => {
  it("is DECIMAL, so the card's number is the enforced number", () => {
    expect(formatStorageBytes(5_000_000_000, "en")).toBe("5 GB");
    expect(formatStorageBytes(15_000_000_000, "en")).toBe("15 GB");
    expect(formatStorageBytes(50_000_000_000, "en")).toBe("50 GB");
  });

  it("one decimal under 10 GB, steps down below 1 GB — a fresh account never reads '0 GB'", () => {
    expect(formatStorageBytes(1_230_000_000, "en")).toBe("1.2 GB");
    expect(formatStorageBytes(12_000_000, "en")).toBe("12 MB");
    expect(formatStorageBytes(3_400, "en")).toBe("3 KB");
    expect(formatStorageBytes(12, "en")).toBe("12 B");
  });

  /**
   * THE SEPARATOR FOLLOWS THE READER'S LANGUAGE, and the locale is an argument rather than a
   * default so it cannot quietly become the computer's.
   *
   * A size with a decimal point in a German pane reads ten times larger — a decimal point is a thousands
   * separator there — and it sat directly beside an email count the catalogue grouped
   * correctly, so one row carried two conventions. Both locales are asserted explicitly: a
   * case that passed no locale would agree with whatever machine happened to run it.
   */
  it("follows the reader's language, both ways", () => {
    expect(formatStorageBytes(1_500_000_000, "de")).toBe("1,5 GB");
    expect(formatStorageBytes(1_500_000_000, "en")).toBe("1.5 GB");
    // Whole numbers are the same word in both, which is why the decimal case is the one to pin.
    expect(formatStorageBytes(2_000_000_000, "de")).toBe("2 GB");
    // …and a large sub-gigabyte figure groups: in megabytes it has no separator, in kilobytes it would.
    expect(formatStorageBytes(999_000_000, "de")).toBe("999 MB");
  });
});

describe("back-filled counts with no trim recorded", () => {
  const cap = 5_000_000_000;
  const A = storageFactsOf({
    usedBytes: 1_000_000, limitBytes: 4_000_000_000, emptiedForSpace: 3, firstEmptiedAt: null, keptFrom: null,
    withheldOnArrival: 0, upgrade: "plan", emptyingNow: false,
  })!;
  const B = storageFactsOf({
    usedBytes: 1_900_000_000, limitBytes: 4_000_000_000, emptiedForSpace: 75_000, firstEmptiedAt: null, keptFrom: null,
    withheldOnArrival: 0, upgrade: "plan", emptyingNow: false, planLimitBytes: 2_000_000_000, limitDropsAt: null,
  })!;

  it("A is past and offers nothing; B is carry and offers", () => {
    expect(storageLevelOf(A)).toBe("past");
    expect(storageNoticeOffers(A, "past")).toBe(false);
    expect(storageLevelOf(B)).toBe("carry");
    expect(storageNoticeOffers(B, "carry")).toBe(true);
  });

  it("below the near threshold no level offers, emptying now included", () => {
    const now = storageFactsOf(block({ usedBytes: cap * 0.5, emptiedForSpace: 7, emptyingNow: true }))!;
    expect(storageLevelOf(now)).toBe("full");
    expect(storageNoticeOffers(now, "full")).toBe(false);
    expect(storageNoticeOffers(storageFactsOf(block({ usedBytes: cap * 0.9 }))!, "near")).toBe(true);
  });

  it("put away under the earlier release: away at the same state, back at a worse level", () => {
    const held = new Set([storageNoticeKeyBefore(null)]);
    const putAway = (k: string) => held.has(k);
    expect(storageNoticeKeyBefore(null)).toBe("ohmail.storage.local.emptiedNotice");
    expect(storageNoticeDue(A, null, putAway)).toBeNull();
    expect(storageNoticeDue(storageFactsOf(block({ usedBytes: 10, emptiedForSpace: 7, limitBytes: 2 * cap }))!, null, putAway)).toBeNull();
    expect(storageNoticeDue({ ...A, usedBytes: A.limitBytes }, null, putAway)).toBe("full");
    expect(storageNoticeDue(A, "someone-else", putAway)).toBe("past");
  });
});
