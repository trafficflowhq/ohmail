import { describe, it, expect } from "vitest";
import {
  formatStorageBytes, formatStoragePrice, storageFactsOf, storageFitExtraBytes, storageFitIsChange, storageMonthName,
  storageOfferOf, storagePercent, storageRefillOf, storageRoomLine,
} from "../app/shell/storage-state";

/**
 * THE STORAGE BLOCK'S NARROWING AND ITS SENTENCES — pure over `GET /account/access`'s `storage` block.
 * An absent or malformed block says nothing, never "0 of 0"; a malformed offer is no offer, so no
 * price is ever drawn from a guess.
 */
const block = (over: Record<string, unknown> = {}) => ({
  usedBytes: 1_000, limitBytes: 5_000_000_000, emptiedForSpace: 0, firstEmptiedAt: null, keptFrom: null, withheldOnArrival: 0, ...over,
});

const OFFER = {
  currency: "usd", interval: "month",
  plans: [
    { plan: "solo", mailboxes: 2, roomBytes: 2_000_000_000, amount: 900 },
    { plan: "plus", mailboxes: 5, roomBytes: 5_000_000_000, amount: 1500 },
    { plan: "pro", mailboxes: 10, roomBytes: 10_000_000_000, amount: 2900 },
  ],
  addon: { unitBytes: 10_000_000_000, amount: 1000, maxUnits: 10 },
  current: { plan: "solo", addonUnits: 0, roomBytes: 2_000_000_000, roomFrom: "now" },
  fit: { plan: "plus", addonUnits: 1, roomBytes: 15_000_000_000, amount: 2500, keepsAll: true },
  canChange: true, reason: null,
};

describe("storageFactsOf", () => {
  it("narrows the estimate's fields: reason, card, mail, estimate, mailboxes by id, and the offer", () => {
    const facts = storageFactsOf(block({
      limitReason: "trial", importing: true, card: "near", mail: false,
      estimate: { expectedBytes: 12_500_000_000, expectedLetters: 500_000, storedLetters: 128_000, avgLetterBytes: 25_000,
        avgMeasured: false, complete: true, at: null },
      mailboxes: [{ id: "mb_1", usedBytes: 600, letters: 400_000, expectedLetters: 400_000, expectedBytes: 10_000_000_000, importing: true },
        { id: "", usedBytes: 1 }],
      offer: OFFER,
    }))!;
    expect(facts).toMatchObject({ limitReason: "trial", importing: true, card: "near", mail: false });
    expect(facts.estimate).toEqual({ expectedBytes: 12_500_000_000, expectedLetters: 500_000, storedLetters: 128_000,
      avgLetterBytes: 25_000, avgMeasured: false, complete: true });
    expect(facts.mailboxes.map((m) => m.id)).toEqual(["mb_1"]);
    expect(facts.offer?.fit).toEqual({ plan: "plus", addonUnits: 1, roomBytes: 15_000_000_000, amount: 2500, keepsAll: true });
  });

  it("an older server's block: the plan's limit, no card, mails on, no estimate, no offer", () => {
    expect(storageFactsOf(block())).toMatchObject({
      limitReason: "plan", importing: false, card: null, mail: true, estimate: null, mailboxes: [], offer: null,
    });
    expect(storageFactsOf(block({ card: "soon", limitReason: "gift" }))).toMatchObject({ card: null, limitReason: "plan" });
  });

  it("an offer missing a field, or with a price that is not a whole count, is no offer", () => {
    expect(storageOfferOf(OFFER)?.canChange).toBe(true);
    expect(storageOfferOf({ ...OFFER, currency: "dollars" })).toBeNull();
    expect(storageOfferOf({ ...OFFER, plans: [{ ...OFFER.plans[0], amount: 9.5 }] })).toBeNull();
    expect(storageOfferOf({ ...OFFER, fit: { ...OFFER.fit, keepsAll: "yes" } })).toBeNull();
    expect(storageOfferOf({ ...OFFER, plans: [{ ...OFFER.plans[0], plan: "gold" }] })).toBeNull();
    expect(storageOfferOf({ ...OFFER, canChange: undefined })?.canChange).toBe(false);
  });

  it("the trial's floor: the plan's lower limit and the instant it applies, or nothing", () => {
    const carry = { limitBytes: 4_000_000_000, planLimitBytes: 2_000_000_000 };
    expect(storageFactsOf(block({ ...carry, limitDropsAt: "2026-11-08T12:00:00.000Z" })))
      .toMatchObject({ planLimitBytes: 2_000_000_000, limitDropsAt: "2026-11-08T12:00:00.000Z" });
    expect(storageFactsOf(block({ ...carry, limitDropsAt: "soon" }))?.limitDropsAt).toBeNull();
    expect(storageFactsOf(block({ ...carry, planLimitBytes: 4_000_000_000 }))?.planLimitBytes).toBeNull();
  });

  it("an absent block, a missing figure or a zero cap is no block at all", () => {
    expect(storageFactsOf(undefined)).toBeNull();
    expect(storageFactsOf(block({ usedBytes: undefined }))).toBeNull();
    expect(storageFactsOf(block({ emptiedForSpace: "3" }))).toBeNull();
    expect(storageFactsOf(block({ limitBytes: 0 }))).toBeNull();
  });
});

describe("the sentences' parts", () => {
  it("the room by the cap's reason: the trial's room, the plan's, the room kept until a date", () => {
    const facts = (over: Record<string, unknown>) => storageFactsOf(block({ limitBytes: 4_000_000_000, ...over }))!;
    expect(storageRoomLine(facts({ limitReason: "trial" }), "en")).toEqual({ key: "storageRoomTrial", values: { limit: "4 GB" } });
    expect(storageRoomLine(facts({ limitReason: "plan" }), "en")).toEqual({ key: "storageRoomPlan", values: { limit: "4 GB" } });
    expect(storageRoomLine(facts({
      limitReason: "held", limitBytes: 15_000_000_000, planLimitBytes: 5_000_000_000, limitDropsAt: "2026-11-21T12:00:00.000Z",
    }), "en")).toEqual({ key: "storageRoomHeld", values: { limit: "15 GB", date: "November 21, 2026" } });
    // A held drop with no date reads as the plan's.
    expect(storageRoomLine(facts({ limitReason: "held" }), "en").key).toBe("storageRoomPlan");
  });

  it("the share in use is whole, and only the cap itself reads 100", () => {
    expect(storagePercent({ usedBytes: 3_200_000_000, limitBytes: 4_000_000_000 })).toBe(80);
    expect(storagePercent({ usedBytes: 3_999_999_999, limitBytes: 4_000_000_000 })).toBe(99);
    expect(storagePercent({ usedBytes: 4_100_000_000, limitBytes: 4_000_000_000 })).toBe(100);
  });

  it("a price is the offer's minor units in the reader's language", () => {
    expect(formatStoragePrice(2500, "usd", "en")).toBe("$25");
    expect(formatStoragePrice(2550, "eur", "de")).toBe("25,50 €");
  });

  it("a fit that is the account's own plan and units is no change; the add-on's room is units times a unit", () => {
    const offer = storageOfferOf(OFFER)!;
    expect(storageFitIsChange(offer)).toBe(true);
    expect(storageFitExtraBytes(offer)).toBe(10_000_000_000);
    expect(storageFitIsChange({ ...offer, fit: { ...offer.fit, plan: "solo", addonUnits: 0 } })).toBe(false);
    expect(storageFitExtraBytes({ ...offer, fit: { ...offer.fit, addonUnits: 0 } })).toBeNull();
  });

  it("names the kept-from month in the reader's language, in any zone", () => {
    expect(storageMonthName("2019-04", "en")).toBe("April 2019");
    expect(storageMonthName("2019-01", "de")).toBe("Januar 2019");
  });

  it("the refill runs with a mailbox ohmail reads, waits for a first import, never runs with every mailbox removed", () => {
    const live = { id: "a", status: "connected", initialImportCompletedAt: "2026-10-01T00:00:00.000Z" };
    expect(storageRefillOf([live, { ...live, id: "b", status: "disabled", initialImportCompletedAt: null }])).toBe("runs");
    expect(storageRefillOf([{ ...live, status: "disabled" }])).toBe("never");
    expect(storageRefillOf([live, { ...live, id: "b", status: "error", initialImportCompletedAt: null }])).toBe("waits");
    expect(storageRefillOf([{ id: "a", status: "connected" }])).toBe("runs");
    expect(storageRefillOf([{ ...live, hostedImportCompletedAt: null }])).toBe("waits");
    expect(storageRefillOf([])).toBe("never");
    expect(storageRefillOf(null)).toBeNull();
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

  it("the storage screens keep the decimal to 100 GB: what the mail needs reads 12.5 GB, not 13", () => {
    expect(formatStorageBytes(12_500_000_000, "en", true)).toBe("12.5 GB");
    expect(formatStorageBytes(15_000_000_000, "en", true)).toBe("15 GB");
    expect(formatStorageBytes(12_500_000_000, "de", true)).toBe("12,5 GB");
    expect(formatStorageBytes(120_400_000_000, "en", true)).toBe("120 GB");
  });

  /** The separator follows the reader's language: a decimal point in a German pane reads ten times larger. */
  it("follows the reader's language, both ways", () => {
    expect(formatStorageBytes(1_500_000_000, "de")).toBe("1,5 GB");
    expect(formatStorageBytes(1_500_000_000, "en")).toBe("1.5 GB");
    expect(formatStorageBytes(2_000_000_000, "de")).toBe("2 GB");
    expect(formatStorageBytes(999_000_000, "de")).toBe("999 MB");
  });
});
