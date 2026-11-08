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
    const e = storageEstimateOf([box({ serverLetters: 500_000, counted: true })], 0);
    expect(e).toEqual({
      mailboxes: [{
        id: "m1", letters: 0, usedBytes: 0, expectedLetters: 500_000, expectedBytes: 500_000 * DEFAULT_LETTER_TEXT_BYTES, complete: true,
      }],
      expectedLetters: 500_000, expectedBytes: 12_500_000_000, storedLetters: 0,
      avgLetterBytes: 25_000, avgMeasured: false, complete: true,
    });
    expect(storageEstimateOf([box({ serverLetters: 500_000, counted: false })], 0).complete).toBe(false);
    expect(storageEstimateOf([box({ serverLetters: null })], 0).expectedLetters).toBe(0);
  });

  it("the server's copies over places per letter, once a mailbox holds 1,000 letters; one place before that", () => {
    // 2,000 letters held in 3,000 places: 30,000 copies on the server are 20,000 letters.
    const stats = { letters: 2_000, textLetters: 0, textBytes: 0, instances: 3_000, imported: false };
    expect(storageEstimateOf([box({ serverLetters: 30_000, stats })], 0).expectedLetters).toBe(20_000);
    const few = { letters: ESTIMATE_MEASURED_MIN_LETTERS - 1, textLetters: 0, textBytes: 0, instances: 1_998, imported: false };
    expect(storageEstimateOf([box({ serverLetters: 30_000, stats: few })], 0).expectedLetters).toBe(30_000);
  });

  it("never fewer than the letters held, and exactly those once a snapshot is taken after the first import", () => {
    const stats = { letters: 40_000, textLetters: 0, textBytes: 0, instances: 40_000, imported: false };
    expect(storageEstimateOf([box({ serverLetters: 10_000, stats })], 0).expectedLetters).toBe(40_000);
    expect(storageEstimateOf([box({ serverLetters: 90_000, stats: { ...stats, imported: true }, imported: true })], 0).mailboxes[0])
      .toMatchObject({ expectedLetters: 40_000, complete: true });
    // An import finished before the first snapshot: the server still says.
    expect(storageEstimateOf([box({ serverLetters: 90_000, imported: true })], 0).expectedLetters).toBe(90_000);
    // An import finished after the snapshot was taken: what it held then is not the whole mailbox.
    expect(storageEstimateOf([box({ serverLetters: 90_000, counted: true, stats, imported: true })], 0).mailboxes[0])
      .toMatchObject({ expectedLetters: 90_000, complete: true });
    const none = { letters: 0, textLetters: 0, textBytes: 0, instances: 0, imported: false };
    expect(storageEstimateOf([box({ serverLetters: 40, stats: none, imported: true })], 0))
      .toMatchObject({ expectedLetters: 40, expectedBytes: 40 * DEFAULT_LETTER_TEXT_BYTES, complete: false });
  });

  it("the account's own average once 1,000 letters hold text, across its mailboxes", () => {
    const held = { letters: 600, instances: 600, imported: false };
    const a = box({ id: "a", serverLetters: 1_000, stats: { ...held, textLetters: 600, textBytes: 6_000_000 } });
    const b = box({ id: "b", serverLetters: 1_000, stats: { ...held, textLetters: 400, textBytes: 2_000_000 } });
    const e = storageEstimateOf([a, b], 8_000_000);
    expect(e).toMatchObject({ avgMeasured: true, avgLetterBytes: 8_000, storedLetters: 1_200, expectedLetters: 2_000 });
    expect(e.expectedBytes).toBe(2_000 * 8_000);
    // Each holds fewer than 1,000 letters with text: the text it holds, and its other letters at the account's.
    expect(e.mailboxes.map((m) => m.expectedBytes)).toEqual([6_000_000 + 400 * 8_000, 2_000_000 + 600 * 8_000]);
    // 999 letters with text are not enough to measure.
    const thin = box({ stats: { letters: 999, textLetters: 999, textBytes: 999, instances: 999, imported: false } });
    expect(storageEstimateOf([thin], 999)).toMatchObject({ avgMeasured: false, avgLetterBytes: DEFAULT_LETTER_TEXT_BYTES });
  });

  /** A mailbox whose every letter is in and holds text. */
  const whole = (id: string, letters: number, textBytes: number): EstimateMailbox => box({
    id, serverLetters: letters, counted: true, imported: true,
    stats: { letters, textLetters: letters, textBytes, instances: letters, imported: true },
  });

  it("every letter in and the counter equal to the snapshot: exactly what is kept, whatever each mailbox's letters weigh", () => {
    // 30,000 letters of 40 KB and 120,000 of 5 KB: 1.8 GB, so the plan that holds 1.8 GB fits, not a dearer one.
    const e = storageEstimateOf([whole("a", 30_000, 1_200_000_000), whole("b", 120_000, 600_000_000)], 1_800_000_000);
    expect(e.mailboxes.map((m) => [m.usedBytes, m.expectedBytes]))
      .toEqual([[1_200_000_000, 1_200_000_000], [600_000_000, 600_000_000]]);
    expect(e).toMatchObject({ expectedLetters: 150_000, expectedBytes: 1_800_000_000 });
    // 50,000 of 40 KB and 200,000 of 10 KB: 4 GB.
    expect(storageEstimateOf([whole("a", 50_000, 2_000_000_000), whole("b", 200_000, 2_000_000_000)], 4_000_000_000))
      .toMatchObject({ expectedBytes: 4_000_000_000 });
  });

  it("never less than is kept, and no more once every letter is in, a mailbox of fewer than 1,000 letters included", () => {
    // 4,080 letters averaging 223 bytes; the counter holds a third more than the snapshot's text (letters
    // deleted and not yet emptied), and the 898 letters of b are smaller than the account's average.
    const e = storageEstimateOf([whole("a", 3_182, 801_079), whole("b", 898, 108_761)], 1_208_935);
    expect(e).toMatchObject({ avgLetterBytes: 223, expectedLetters: 4_080 });
    expect(e.mailboxes.map((m) => [m.usedBytes, m.expectedBytes])).toEqual([[1_064_421, 1_064_421], [144_514, 144_514]]);
    expect(e.expectedBytes).toBe(1_208_935);
  });

  it("a mailbox still importing needs its letters to come at its own average once 1,000 of its letters hold text", () => {
    // a holds 2,000 of its 10,000 letters, at 40 KB; b is whole, at 5 KB. The account's 22.5 KB is neither's.
    const a = box({ id: "a", serverLetters: 10_000, counted: true,
      stats: { letters: 2_000, textLetters: 2_000, textBytes: 80_000_000, instances: 2_000, imported: false } });
    const e = storageEstimateOf([a, whole("b", 2_000, 10_000_000)], 90_000_000);
    expect(e.avgLetterBytes).toBe(22_500);
    expect(e.mailboxes.map((m) => [m.usedBytes, m.expectedBytes])).toEqual([[80_000_000, 10_000 * 40_000], [10_000_000, 10_000_000]]);
    expect(e.expectedBytes).toBe(410_000_000);
  });

  it("never less than the counter in total, though no snapshot holds text yet; an account with no mailbox expects nothing", () => {
    // The first row is taken at connect, before a letter is in: no mailbox holds a share of the counter.
    const first = box({ serverLetters: 50_000, counted: true, stats: { letters: 0, textLetters: 0, textBytes: 0, instances: 0, imported: false } });
    const e = storageEstimateOf([first], 1_500_000_000);
    expect(e.mailboxes[0]).toMatchObject({ usedBytes: 0, expectedBytes: 50_000 * DEFAULT_LETTER_TEXT_BYTES });
    expect(e.expectedBytes).toBe(1_500_000_000);
    expect(storageEstimateOf([], 0)).toMatchObject({ expectedBytes: 0, expectedLetters: 0, complete: true });
    expect(storageEstimateOf([], 1_500_000_000)).toMatchObject({ expectedBytes: 0, expectedLetters: 0, complete: true });
  });

  it("splits the live counter by the snapshot's text bytes, the remainder to the largest", () => {
    const shares = storageSharesOf(1_000, [{ id: "a", textBytes: 1 }, { id: "b", textBytes: 2 }]);
    expect([shares.get("a"), shares.get("b")]).toEqual([333, 667]);
    expect([...storageSharesOf(500, [{ id: "a", textBytes: 0 }]).values()]).toEqual([0]);
  });
});
