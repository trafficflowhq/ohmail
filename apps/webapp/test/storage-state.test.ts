import { describe, it, expect } from "vitest";
import {
  formatStorageBytes, storageFactsOf, storageKeptLine, storageMonthName, storageNoticeDue, storagePlanOf, storageState,
  STORAGE_NEAR_CAP_RATIO, STORAGE_TRIM_BAND_RATIO,
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
      keptFrom: "2019-04", withheldOnArrival: 12,
    });
    expect(storageFactsOf(block({ keptFrom: "April" }))?.keptFrom).toBeNull();
  });

  it("an older server's block has no arrivals; never more of them than letters emptied", () => {
    const older = { usedBytes: 1_000, limitBytes: 5_000_000_000, emptiedForSpace: 5, firstEmptiedAt: null, keptFrom: null };
    expect(storageFactsOf(older)?.withheldOnArrival).toBe(0);
    expect(storageFactsOf(block({ emptiedForSpace: 5, withheldOnArrival: 9 }))?.withheldOnArrival).toBe(5);
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
    expect(storageState(storageFactsOf(block({ usedBytes: cap - 1, emptiedForSpace: 7 }))))
      .toEqual({ kind: "emptied", count: 7, current: true });
    // The count is of the oldest letters: those that arrived while the storage was full are not among them.
    expect(storageState(storageFactsOf(block({ usedBytes: cap - 1, emptiedForSpace: 7, withheldOnArrival: 2 }))))
      .toEqual({ kind: "emptied", count: 5, current: true });
  });

  it("emptied letters below the trim band were emptied under an earlier state, not the current cap", () => {
    expect(storageState(storageFactsOf(block({ usedBytes: 10, emptiedForSpace: 7 }))))
      .toEqual({ kind: "emptied", count: 7, current: false });
    expect(storageState(storageFactsOf(block({ usedBytes: cap * STORAGE_TRIM_BAND_RATIO, emptiedForSpace: 7 }))))
      .toEqual({ kind: "emptied", count: 7, current: true });
  });

  it("the notice is due only while letters are emptied and the device has not put it away", () => {
    expect(storageNoticeDue(storageFactsOf(block({ emptiedForSpace: 1 })), false)).toBe(true);
    expect(storageNoticeDue(storageFactsOf(block({ emptiedForSpace: 1 })), true)).toBe(false);
    expect(storageNoticeDue(storageFactsOf(block()), false)).toBe(false);
    expect(storageNoticeDue(null, false)).toBe(false);
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
