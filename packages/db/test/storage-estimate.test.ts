import { describe, expect, it } from "vitest";
import {
  DEFAULT_LETTER_TEXT_BYTES, ESTIMATE_MEASURED_MIN_LETTERS, storageEstimateOf, storageSharesOf, type EstimateMailbox,
} from "@trafficflow/db/cloud";

/** THE STORAGE ESTIMATE (cloud 0057): what the mailboxes need once every letter is in, from cheap facts. */

const box = (over: Partial<EstimateMailbox> = {}): EstimateMailbox => ({
  id: "m1", serverLetters: null, counted: false, imported: false, stats: null, ...over,
});

describe("the storage estimate", () => {
  it("before any snapshot: the folder counts at the default 25 KB a letter, complete once every folder is counted", () => {
    const e = storageEstimateOf([box({ serverLetters: 500_000, counted: true })]);
    expect(e).toEqual({
      mailboxes: [{ id: "m1", letters: 0, expectedLetters: 500_000, expectedBytes: 500_000 * DEFAULT_LETTER_TEXT_BYTES, complete: true }],
      expectedLetters: 500_000, expectedBytes: 12_500_000_000, storedLetters: 0,
      avgLetterBytes: 25_000, avgMeasured: false, complete: true,
    });
    expect(storageEstimateOf([box({ serverLetters: 500_000, counted: false })]).complete).toBe(false);
    expect(storageEstimateOf([box({ serverLetters: null })]).expectedLetters).toBe(0);
  });

  it("the server's copies over places per letter, once a mailbox holds 1,000 letters; one place before that", () => {
    // 2,000 letters held in 3,000 places: 30,000 copies on the server are 20,000 letters.
    const stats = { letters: 2_000, textLetters: 0, textBytes: 0, instances: 3_000, imported: false };
    expect(storageEstimateOf([box({ serverLetters: 30_000, stats })]).expectedLetters).toBe(20_000);
    const few = { letters: ESTIMATE_MEASURED_MIN_LETTERS - 1, textLetters: 0, textBytes: 0, instances: 1_998, imported: false };
    expect(storageEstimateOf([box({ serverLetters: 30_000, stats: few })]).expectedLetters).toBe(30_000);
  });

  it("never fewer than the letters held, and exactly those once a snapshot is taken after the first import", () => {
    const stats = { letters: 40_000, textLetters: 0, textBytes: 0, instances: 40_000, imported: false };
    expect(storageEstimateOf([box({ serverLetters: 10_000, stats })]).expectedLetters).toBe(40_000);
    expect(storageEstimateOf([box({ serverLetters: 90_000, stats: { ...stats, imported: true }, imported: true })]).mailboxes[0])
      .toMatchObject({ expectedLetters: 40_000, complete: true });
    // An import finished before the first snapshot: the server still says.
    expect(storageEstimateOf([box({ serverLetters: 90_000, imported: true })]).expectedLetters).toBe(90_000);
    // An import finished after the snapshot was taken: what it held then is not the whole mailbox.
    expect(storageEstimateOf([box({ serverLetters: 90_000, counted: true, stats, imported: true })]).mailboxes[0])
      .toMatchObject({ expectedLetters: 90_000, complete: true });
    const none = { letters: 0, textLetters: 0, textBytes: 0, instances: 0, imported: false };
    expect(storageEstimateOf([box({ serverLetters: 40, stats: none, imported: true })]))
      .toMatchObject({ expectedLetters: 40, expectedBytes: 40 * DEFAULT_LETTER_TEXT_BYTES, complete: false });
  });

  it("the account's own average once 1,000 letters hold text, across its mailboxes", () => {
    const held = { letters: 600, instances: 600, imported: false };
    const a = box({ id: "a", serverLetters: 1_000, stats: { ...held, textLetters: 600, textBytes: 6_000_000 } });
    const b = box({ id: "b", serverLetters: 1_000, stats: { ...held, textLetters: 400, textBytes: 2_000_000 } });
    const e = storageEstimateOf([a, b]);
    expect(e).toMatchObject({ avgMeasured: true, avgLetterBytes: 8_000, storedLetters: 1_200, expectedLetters: 2_000 });
    expect(e.expectedBytes).toBe(2_000 * 8_000);
    expect(e.mailboxes.map((m) => m.expectedBytes)).toEqual([8_000_000, 8_000_000]);
    // 999 letters with text are not enough to measure.
    const thin = box({ stats: { letters: 999, textLetters: 999, textBytes: 999, instances: 999, imported: false } });
    expect(storageEstimateOf([thin])).toMatchObject({ avgMeasured: false, avgLetterBytes: DEFAULT_LETTER_TEXT_BYTES });
  });

  it("an account with no mailbox expects nothing, completely", () => {
    expect(storageEstimateOf([])).toMatchObject({ expectedBytes: 0, expectedLetters: 0, complete: true });
  });

  it("splits the live counter by the snapshot's text bytes, the remainder to the largest", () => {
    const shares = storageSharesOf(1_000, [{ id: "a", textBytes: 1 }, { id: "b", textBytes: 2 }]);
    expect([shares.get("a"), shares.get("b")]).toEqual([333, 667]);
    expect([...storageSharesOf(500, [{ id: "a", textBytes: 0 }]).values()]).toEqual([0]);
  });
});
