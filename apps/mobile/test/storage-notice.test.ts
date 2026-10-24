import { beforeEach, describe, expect, it } from "vitest";
import { accessOf, type AccessFeed } from "../src/net/account";
import { capGigabytes, storageNoticeKey, storageNoticeOf, storageNoticeText } from "../src/ui/storage-notice";
import { monthStamp } from "../src/ui/day-stamp";
import {
  bindStorageNotices, putAwayStorageNotice, resetStorageNoticesForTests, storageNoticePutAway,
  storageNoticeWritesSettled, STORAGE_NOTICE_KEY,
} from "../src/state/storage-notice";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import type { SecureKV } from "../src/state/servers";

/**
 * THE EMPTIED-TEXT NOTICE ON THE PHONE: the access answer's storage block, when the notice is due,
 * what it offers on each face, that putting it away outlives a launch, and that no sentence on any
 * face promises emptied text back.
 */

const EMPTIED = {
  usedBytes: 1_868_000_000, limitBytes: 2_000_000_000, emptiedForSpace: 80_000,
  firstEmptiedAt: "2026-10-20T03:00:00.000Z", keptFrom: "2019-04", withheldOnArrival: 0,
};
const feed = (body: Record<string, unknown>): AccessFeed => ({ answer: accessOf(body)!, caughtUp: null, at: 0 });
const open = (storage: unknown, state = "trialing") => ({
  metered: true, access: "open", lifecycle: { state, closedReason: null }, storage,
});

function memoryKV(): SecureKV & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
  };
}

beforeEach(() => { resetStorageNoticesForTests(); });

describe("the storage block", () => {
  it("is parsed from the access answer, and a malformed one is none", () => {
    expect(accessOf(open(EMPTIED))!.storage).toEqual(EMPTIED);
    expect(accessOf(open({ ...EMPTIED, keptFrom: "April" }))!.storage?.keptFrom).toBeNull();
    expect(accessOf(open({ ...EMPTIED, limitBytes: 0 }))!.storage).toBeUndefined();
    expect(accessOf(open(undefined))!.storage).toBeUndefined();
    expect(accessOf({ metered: false, storage: EMPTIED })).toEqual({ metered: false });
  });

  it("an older server sends no arrivals; never more of them than letters emptied", () => {
    const { usedBytes, limitBytes, emptiedForSpace, firstEmptiedAt, keptFrom } = EMPTIED;
    expect(accessOf(open({ usedBytes, limitBytes, emptiedForSpace, firstEmptiedAt, keptFrom }))!.storage?.withheldOnArrival).toBe(0);
    expect(accessOf(open({ ...EMPTIED, emptiedForSpace: 3, withheldOnArrival: 9 }))!.storage?.withheldOnArrival).toBe(3);
  });
});

describe("when the notice is due, and what it offers", () => {
  it("due while letters are emptied; a trial is offered a bigger plan, a paid account the add-on too", () => {
    expect(storageNoticeOf(feed(open(EMPTIED)), false, "sideload"))
      .toEqual({ facts: EMPTIED, current: true, plan: "trial", manage: true });
    expect(storageNoticeOf(feed(open(EMPTIED, "active")), false, "sideload")?.plan).toBe("active");
  });

  it("the store face names no plan and offers no press", () => {
    expect(storageNoticeOf(feed(open(EMPTIED)), false, "store"))
      .toEqual({ facts: EMPTIED, current: true, plan: null, manage: false });
  });

  it("past due or in grace: the press stays, no plan and no add-on is offered", () => {
    for (const state of ["past_due", "grace"]) {
      const n = storageNoticeOf(feed(open(EMPTIED, state)), false, "sideload")!;
      expect({ plan: n.plan, manage: n.manage }, state).toEqual({ plan: null, manage: true });
      expect(storageNoticeText(n, EN, "en"), state).not.toMatch(/bigger plan|add-on/);
    }
  });

  it("upgraded to 10 GB, 19% used: what happened then, without the cap and without an offer", () => {
    const n = storageNoticeOf(feed(open({ ...EMPTIED, limitBytes: 10_000_000_000 }, "active")), false, "sideload")!;
    expect({ current: n.current, plan: n.plan }).toEqual({ current: false, plan: null });
    const said = storageNoticeText(n, EN, "en");
    expect(said).toContain("To stay within your plan's storage at the time, ohmail stopped storing the text of your 80,000 oldest letters.");
    expect(said).not.toContain("10 GB");
    expect(said).not.toMatch(/bigger plan|add-on/);
    expect(storageNoticeText(n, DE, "de")).toContain("hat ohmail den Text deiner 80.000 ältesten Nachrichten nicht mehr gespeichert.");
  });

  it("at the cap of a trial: the cap, the month, and a bigger plan", () => {
    const said = storageNoticeText(storageNoticeOf(feed(open(EMPTIED)), false, "sideload")!, EN, "en");
    expect(said).toContain("To stay within your plan's 2 GB, ohmail no longer stores the text of your 80,000 oldest letters.");
    expect(said).toContain("Text is kept for letters from April 2019 on.");
    expect(said).toContain("A bigger plan keeps more text from now on.");
    expect(storageNoticeText(storageNoticeOf(feed(open(EMPTIED)), false, "sideload")!, DE, "de"))
      .toContain("Für Nachrichten ab April 2019 bleibt der Text gespeichert.");
  });

  it("letters that arrived while the storage was full are counted apart, never as the oldest", () => {
    const said = storageNoticeText(storageNoticeOf(feed(open({ ...EMPTIED, withheldOnArrival: 12 })), false, "sideload")!, EN, "en");
    expect(said).toContain("ohmail no longer stores the text of your 79,988 oldest letters.");
    expect(said).toContain("Text is kept for letters from April 2019 on, apart from 12 letters that arrived while your storage was full.");
    const only = storageNoticeOf(feed(open({ ...EMPTIED, emptiedForSpace: 2, withheldOnArrival: 2, keptFrom: null })), false, "sideload")!;
    expect(storageNoticeText(only, EN, "en")).toContain("2 letters that arrived while your storage was full are stored without their text.");
    expect(storageNoticeText(only, EN, "en")).not.toContain("oldest");
    expect(storageNoticeText(only, DE, "de"))
      .toContain("2 Nachrichten, die ankamen, als dein Speicher voll war, sind ohne ihren Text gespeichert.");
  });

  it("nothing emptied, no block, put away, or no feed: nothing drawn", () => {
    expect(storageNoticeOf(feed(open({ ...EMPTIED, emptiedForSpace: 0 })), false, "sideload")).toBeNull();
    expect(storageNoticeOf(feed(open(undefined)), false, "sideload")).toBeNull();
    expect(storageNoticeOf(feed(open(EMPTIED)), true, "sideload")).toBeNull();
    expect(storageNoticeOf(null, false, "sideload")).toBeNull();
  });
});

describe("putting it away", () => {
  it("is kept in the keystore, so the next launch reads it back", async () => {
    const kv = memoryKV();
    await bindStorageNotices(kv);
    const key = storageNoticeKey("owner-a");
    putAwayStorageNotice(key);
    await storageNoticeWritesSettled();
    expect(JSON.parse(kv.map.get(STORAGE_NOTICE_KEY)!)).toEqual([key]);
    resetStorageNoticesForTests();
    expect(storageNoticePutAway(key)).toBe(false);
    await bindStorageNotices(kv);
    expect(storageNoticePutAway(key)).toBe(true);
    expect(storageNoticePutAway(storageNoticeKey("owner-b"))).toBe(false);
  });

  it("a keystore that refuses keeps it for this run", async () => {
    await bindStorageNotices({ get: async () => null, set: async () => { throw new Error("locked"); }, remove: async () => {} });
    putAwayStorageNotice("k");
    await storageNoticeWritesSettled();
    expect(storageNoticePutAway("k")).toBe(true);
  });
});

describe("the copy", () => {
  it("says how many, the cap and the month, in both languages", () => {
    expect(EN.storageNoticeEmptied(capGigabytes(2_000_000_000, "en"), 80_000))
      .toBe("To stay within your plan's 2 GB, ohmail no longer stores the text of your 80,000 oldest letters.");
    expect(DE.storageNoticeEmptied(capGigabytes(1_500_000_000, "de"), 1))
      .toBe("Damit die 1,5 GB deines Tarifs reichen, speichert ohmail den Text deiner ältesten Nachricht nicht mehr.");
    expect(EN.storageNoticeKeptFrom(monthStamp("2019-04", "en"))).toBe("Text is kept for letters from April 2019 on.");
    expect(EN.storageNoticeKeptFromExcept(monthStamp("2019-04", "en"), 1))
      .toBe("Text is kept for letters from April 2019 on, apart from one letter that arrived while your storage was full.");
    expect(DE.storageNoticeKeptFromExcept(monthStamp("2019-04", "de"), 1_200))
      .toBe("Für Nachrichten ab April 2019 bleibt der Text gespeichert, außer bei 1.200 Nachrichten, die ankamen, als dein Speicher voll war.");
    expect(EN.storageNoticeOnArrival(1)).toBe("One letter that arrived while your storage was full is stored without its text.");
    expect(DE.storageNoticeOnArrival(1)).toBe("Eine Nachricht, die ankam, als dein Speicher voll war, ist ohne ihren Text gespeichert.");
  });

  it("the reader's note covers both cases and promises no restore", () => {
    for (const deck of [EN, DE]) {
      expect(deck.liveBodyWithheld).not.toMatch(/adds storage|mehr Speicherplatz/);
    }
    expect(EN.liveBodyWithheld).toContain("stopped storing the text of older letters");
    expect(EN.liveBodyWithheld).toContain("space was full when it arrived");
    expect(EN.liveBodyWithheld).toContain("it does not bring this text back");
    expect(DE.liveBodyWithheld).toContain("diesen bringt er nicht zurück");
    expect(EN.storageNoticeTrial).toContain("does not bring back");
    expect(DE.storageNoticeActive).toContain("nicht zurück");
  });
});
