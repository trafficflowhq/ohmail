import { beforeEach, describe, expect, it } from "vitest";
import { accessOf, type AccessFeed } from "../src/net/account";
import {
  capGigabytes, storageNoticeCap, storageNoticeHeld, storageNoticeKey, storageNoticeOf, storageNoticeText, storageRefillOf,
  type StorageLevel, type StorageRefill,
} from "../src/ui/storage-notice";
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
 * what it offers on each face, that putting it away outlives a launch, and that it says emptied text
 * comes back only where the storage refill runs, never that all of it does.
 */

const EMPTIED = {
  usedBytes: 1_868_000_000, limitBytes: 2_000_000_000, emptiedForSpace: 80_000,
  firstEmptiedAt: "2026-10-20T03:00:00.000Z", keptFrom: "2019-04", withheldOnArrival: 0, emptyingNow: true,
};
const FACTS = { ...EMPTIED, upgrade: "plan", planLimitBytes: null, limitDropsAt: null };
const NEAR = { ...EMPTIED, usedBytes: 1_820_000_000, emptiedForSpace: 0, keptFrom: null };
const none = (): boolean => false;
const feed = (body: Record<string, unknown>): AccessFeed => ({ answer: accessOf(body)!, caughtUp: null, at: 0 });
const open = (storage: unknown, state = "trialing") => ({
  metered: true, access: "open", lifecycle: { state, closedReason: null }, storage,
});
/** The two refill sentences and the one that says an offer brings nothing back. */
const REFILL = "With more room, ohmail fetches the text of emptied letters back from your mail server, newest first, for the mailboxes it still reads.";
const REFILLING =
  "There is room again: for the mailboxes ohmail still reads, it fetches the text of emptied letters back from your mail server, newest first, as far as the room allows.";
const NO_RESTORE = "It does not bring back text that was already emptied.";

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
    expect(accessOf(open(EMPTIED))!.storage).toEqual(FACTS);
    // An older server does not say whether the cap empties text now: only at the cap.
    const { emptyingNow: _said, ...older } = EMPTIED;
    expect(accessOf(open(older))!.storage?.emptyingNow).toBe(false);
    expect(accessOf(open({ ...older, usedBytes: 2_000_000_000 }))!.storage?.emptyingNow).toBe(true);
    // The trial's floor: the plan's lower limit and when it applies, or nothing.
    const carry = { ...EMPTIED, limitBytes: 4_000_000_000, planLimitBytes: 2_000_000_000 };
    expect(accessOf(open({ ...carry, limitDropsAt: "2026-11-08T12:00:00.000Z" }))!.storage)
      .toMatchObject({ planLimitBytes: 2_000_000_000, limitDropsAt: "2026-11-08T12:00:00.000Z" });
    expect(accessOf(open({ ...carry, limitDropsAt: "soon" }))!.storage?.limitDropsAt).toBeNull();
    expect(accessOf(open({ ...carry, planLimitBytes: 4_000_000_000 }))!.storage?.planLimitBytes).toBeNull();
    expect(accessOf(open({ ...EMPTIED, upgrade: "addon" }))!.storage?.upgrade).toBe("addon");
    expect(accessOf(open({ ...EMPTIED, upgrade: "gold" }))!.storage?.upgrade).toBe("plan");
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
    expect(storageNoticeOf(feed(open(EMPTIED)), none, "sideload"))
      .toEqual({ facts: FACTS, level: "full", current: true, plan: "trial", manage: true });
    expect(storageNoticeOf(feed(open(EMPTIED, "active")), none, "sideload")?.plan).toBe("active");
  });

  it("the store face names no plan and offers no press", () => {
    expect(storageNoticeOf(feed(open(EMPTIED)), none, "store"))
      .toEqual({ facts: FACTS, level: "full", current: true, plan: null, manage: false });
    // Near the cap the store face says so, with no purchase.
    const near = storageNoticeOf(feed(open(NEAR, "active")), none, "store")!;
    expect(storageNoticeText(near, EN, "en", "runs")).toContain("Storage is nearly full.");
    expect(storageNoticeText(near, EN, "en", "runs")).not.toMatch(/bigger plan|add-on/);
  });

  it("past due or in grace: the press stays, no plan and no add-on is offered", () => {
    for (const state of ["past_due", "grace"]) {
      const n = storageNoticeOf(feed(open(EMPTIED, state)), none, "sideload")!;
      expect({ plan: n.plan, manage: n.manage }, state).toEqual({ plan: null, manage: true });
      expect(storageNoticeText(n, EN, "en", "runs"), state).not.toMatch(/bigger plan|add-on|fetches|bring back/);
    }
  });

  it("upgraded to 10 GB, 19% used: what happened then, that the text is coming back, without the cap and without an offer", () => {
    const below = { ...EMPTIED, limitBytes: 10_000_000_000, emptyingNow: false };
    const n = storageNoticeOf(feed(open(below, "active")), none, "sideload")!;
    expect({ current: n.current, plan: n.plan }).toEqual({ current: false, plan: null });
    const said = storageNoticeText(n, EN, "en", "runs");
    expect(said).toContain("To stay within your plan's storage at the time, ohmail stopped storing the text of your 80,000 oldest letters.");
    expect(said).toContain(REFILLING);
    expect(said).not.toContain("10 GB");
    expect(said).not.toMatch(/bigger plan|add-on/);
    const de = storageNoticeText(n, DE, "de", "runs");
    expect(de).toContain("hat ohmail den Text deiner 80.000 ältesten Nachrichten nicht mehr gespeichert.");
    expect(de).toContain("Es ist wieder Platz frei: Für die Postfächer, die ohmail noch liest, holt es den Text entfernter Nachrichten");
    // The store face says it too: it names no plan and offers no press.
    const store = storageNoticeOf(feed(open(below, "active")), none, "store")!;
    expect(storageNoticeText(store, EN, "en", "runs")).toContain("There is room again");
  });

  it("at the cap of a trial: the cap, the month, a bigger plan, and the text back with more room", () => {
    const said = storageNoticeText(storageNoticeOf(feed(open(EMPTIED)), none, "sideload")!, EN, "en", "runs");
    expect(said).toContain("To stay within your plan's 2 GB, ohmail no longer stores the text of your 80,000 oldest letters.");
    expect(said).toContain("Text is kept for letters from April 2019 on.");
    expect(said).toContain("A bigger plan keeps more text from now on.");
    expect(said).toContain(REFILL);
    expect(said).not.toContain("There is room again");
    expect(said).not.toContain(NO_RESTORE);
    expect(storageNoticeText(storageNoticeOf(feed(open(EMPTIED)), none, "sideload")!, DE, "de", "runs"))
      .toContain("Für Nachrichten ab April 2019 bleibt der Text gespeichert.");
  });

  it("letters that arrived while the storage was full are counted apart, never as the oldest", () => {
    const said = storageNoticeText(storageNoticeOf(feed(open({ ...EMPTIED, withheldOnArrival: 12 })), none, "sideload")!, EN, "en", "runs");
    expect(said).toContain("ohmail no longer stores the text of your 79,988 oldest letters.");
    expect(said).toContain("Text is kept for letters from April 2019 on, apart from 12 letters that arrived while your storage was full.");
    const only = storageNoticeOf(feed(open({ ...EMPTIED, emptiedForSpace: 2, withheldOnArrival: 2, keptFrom: null })), none, "sideload")!;
    expect(storageNoticeText(only, EN, "en", "runs")).toContain("2 letters that arrived while your storage was full are stored without their text.");
    expect(storageNoticeText(only, EN, "en", "runs")).not.toContain("oldest");
    expect(storageNoticeText(only, DE, "de", "runs"))
      .toContain("2 Nachrichten, die ankamen, als dein Speicher voll war, sind ohne ihren Text gespeichert.");
  });

  /*
   * ONE RULE: the refill sentence where the refill runs (a mailbox ohmail reads, room under its mark),
   * the "does not bring back" sentence only where it never can (every mailbox removed), neither while it
   * waits for a first import or before the mailbox read lands.
   */
  it("with the offer: the text back with more room where the refill runs, never also that it does not come back", () => {
    for (const storage of [EMPTIED, { ...EMPTIED, limitBytes: 10_000_000_000, usedBytes: 9_200_000_000, upgrade: "addon" }]) {
      const n = storageNoticeOf(feed(open(storage, "active")), none, "sideload")!;
      for (const [deck, locale] of [[EN, "en"], [DE, "de"]] as const) {
        const said = storageNoticeText(n, deck, locale, "runs");
        expect(said).toContain(deck.storageNoticeRefill);
        expect(said).not.toContain(deck.storageNoticeNoRestore);
        expect(said).not.toContain(deck.storageNoticeRefilling);
      }
    }
  });

  it("every mailbox removed: the offer brings nothing back, and nothing is said to come back", () => {
    const n = storageNoticeOf(feed(open(EMPTIED, "active")), none, "sideload")!;
    const said = storageNoticeText(n, EN, "en", "never");
    expect(said).toContain("A bigger plan or the storage add-on keeps more text from now on.");
    expect(said).toContain(NO_RESTORE);
    expect(said).not.toMatch(/fetches|room again/);
    expect(storageNoticeText(n, DE, "de", "never")).toContain("Bereits entfernten Text bringt das nicht zurück.");
    // Below the band there is no offer for the sentence to follow, and no text comes back.
    const below = storageNoticeOf(feed(open({ ...EMPTIED, limitBytes: 10_000_000_000, emptyingNow: false }, "active")), none, "sideload")!;
    expect(storageNoticeText(below, EN, "en", "never")).not.toMatch(/fetches|room again|bring back/);
  });

  it("a mailbox still on its first import, or no mailbox read yet: neither that the text comes back nor that it does not", () => {
    for (const storage of [EMPTIED, { ...EMPTIED, limitBytes: 10_000_000_000, emptyingNow: false }]) {
      const n = storageNoticeOf(feed(open(storage, "active")), none, "sideload")!;
      for (const refill of ["waits", null] as const) {
        for (const [deck, locale] of [[EN, "en"], [DE, "de"]] as const) {
          const said = storageNoticeText(n, deck, locale, refill);
          expect(said, `${refill} ${locale}`).not.toMatch(/fetches|room again|bring back|holt|wieder Platz|nicht zurück/);
          expect(said).toContain(deck.storageNoticeSafe);
        }
      }
    }
  });

  it("inside the trial's floor the room is under the plan's own limit: no 'room again' above its mark", () => {
    // Emptied under an earlier cap; the floor is 4 GB, the plan keeps 2 GB.
    const floor = { ...EMPTIED, limitBytes: 4_000_000_000, planLimitBytes: 2_000_000_000, limitDropsAt: null, emptyingNow: false };
    const under = storageNoticeOf(feed(open({ ...floor, usedBytes: 1_700_000_000 }, "trialing")), none, "sideload")!;
    expect(under.level).toBe("past");
    expect(storageNoticeText(under, EN, "en", "runs")).toContain(REFILLING);
    // 1.8 GB is nine tenths of the plan's 2 GB and well under the floor's: the refill has no room.
    const atMark = storageNoticeOf(feed(open({ ...floor, usedBytes: 1_800_000_000 }, "trialing")), none, "sideload")!;
    const said = storageNoticeText(atMark, EN, "en", "runs");
    expect(said).not.toContain("There is room again");
    expect(said).toContain(REFILL);
  });

  it("the refill's place: runs, waits for a first import, never with every mailbox removed, unknown before the read", () => {
    const live = { status: "connected", initialImportCompletedAt: "2026-10-01T00:00:00.000Z" };
    const cases: Array<[Parameters<typeof storageRefillOf>[0], StorageRefill | null]> = [
      [[live, { status: "disabled", initialImportCompletedAt: null }], "runs"],
      [[{ status: "connected" }], "runs"],
      [[live, { status: "error", initialImportCompletedAt: null }], "waits"],
      [[{ ...live, status: "disabled" }], "never"],
      [[], "never"],
      [null, null],
    ];
    for (const [rows, want] of cases) expect(storageRefillOf(rows), JSON.stringify(rows)).toBe(want);
  });

  it("nothing emptied, no block, put away, or no feed: nothing drawn", () => {
    expect(storageNoticeOf(feed(open({ ...EMPTIED, emptiedForSpace: 0, usedBytes: 1_000 })), none, "sideload")).toBeNull();
    expect(storageNoticeOf(feed(open(undefined)), none, "sideload")).toBeNull();
    expect(storageNoticeOf(feed(open(EMPTIED)), () => true, "sideload")).toBeNull();
    expect(storageNoticeOf(null, none, "sideload")).toBeNull();
  });
});

describe("the upgrade message at ninety percent and at the cap, by plan", () => {
  const said = (storage: Record<string, unknown>, state: string, refill: StorageRefill | null = "runs"): string =>
    storageNoticeText(storageNoticeOf(feed(open(storage, state)), none, "sideload")!, EN, "en", refill);

  it("near the cap: what will happen and what keeps more, before any text is emptied", () => {
    const trial = said(NEAR, "trialing");
    expect(trial).toContain("Storage is nearly full.");
    expect(trial).toContain("A bigger plan keeps more text from now on.");
    expect(trial).not.toMatch(/bring back|fetches/);
    expect(said({ ...NEAR, usedBytes: 2_000_000_000 }, "active")).toContain("Storage is full.");
  });

  it("Solo and Plus: a bigger plan or the add-on; Pro: the add-on alone; a Pro trial: once paid", () => {
    for (const limitBytes of [2_000_000_000, 5_000_000_000]) {
      expect(said({ ...EMPTIED, limitBytes, usedBytes: limitBytes * 0.9 }, "active"), String(limitBytes))
        .toContain("A bigger plan or the storage add-on keeps more text from now on.");
    }
    const pro = { ...EMPTIED, limitBytes: 10_000_000_000, usedBytes: 9_000_000_000, upgrade: "addon" };
    expect(said(pro, "active")).toContain("The storage add-on keeps more text from now on.");
    expect(said(pro, "active")).not.toContain("bigger plan");
    expect(said(pro, "active")).toContain(REFILL);
    expect(said(pro, "active", "never")).toContain(NO_RESTORE);
    expect(said({ ...NEAR, limitBytes: 10_000_000_000, usedBytes: 9_500_000_000, upgrade: "addon" }, "trialing"))
      .toContain("Once your subscription is paid, the storage add-on keeps more text from now on.");
    expect(storageNoticeText(storageNoticeOf(feed(open({ ...EMPTIED, upgrade: "addon" }, "active")), none, "sideload")!, DE, "de", "runs"))
      .toContain("Das Speicher-Add-on speichert ab jetzt mehr Text.");
  });

  it("text emptied under the old cap, then a bigger plan: nearing the new cap is near, never the new cap emptying", () => {
    const upgraded = { ...EMPTIED, limitBytes: 5_000_000_000, emptyingNow: false };
    const n = storageNoticeOf(feed(open({ ...upgraded, usedBytes: 4_600_000_000 }, "active")), none, "sideload")!;
    expect(n.level).toBe("near");
    const near = storageNoticeText(n, EN, "en", "runs");
    expect(near).toContain("To stay within your plan's storage at the time, ohmail stopped storing the text of your 80,000 oldest letters.");
    expect(near).toContain("Storage is nearly full.");
    expect(near).not.toContain("To stay within your plan's 5 GB");
    expect(near).not.toContain("There is room again");
    expect(storageNoticeOf(feed(open({ ...upgraded, usedBytes: 4_300_000_000 }, "active")), none, "sideload")?.level).toBe("past");
  });

  it("put away at a level, it comes back at a worse one or under a new cap", () => {
    const held = new Set([storageNoticeKey("a", "near", 2_000_000_000)]);
    const putAway = (level: StorageLevel, cap: number | string) => held.has(storageNoticeKey("a", level, cap));
    expect(storageNoticeOf(feed(open(NEAR, "active")), putAway, "sideload")).toBeNull();
    expect(storageNoticeOf(feed(open(EMPTIED, "active")), putAway, "sideload")?.level).toBe("full");
    held.add(storageNoticeKey("a", "full", 2_000_000_000));
    held.delete(storageNoticeKey("a", "near", 2_000_000_000));
    expect(storageNoticeOf(feed(open(NEAR, "active")), putAway, "sideload")).toBeNull();
    expect(storageNoticeOf(feed(open({ ...NEAR, limitBytes: 5_000_000_000, usedBytes: 4_600_000_000 }, "active")), putAway, "sideload")?.level)
      .toBe("near");
  });
});

describe("inside the trial's 4 GB floor, before the plan's own limit applies", () => {
  const CARRY = {
    usedBytes: 3_500_000_000, limitBytes: 4_000_000_000, emptiedForSpace: 0, firstEmptiedAt: null, keptFrom: null,
    withheldOnArrival: 0, emptyingNow: false, planLimitBytes: 2_000_000_000,
  };
  const said = (storage: Record<string, unknown>, state: string, deck = EN, locale = "en"): string =>
    storageNoticeText(storageNoticeOf(feed(open(storage, state)), none, "sideload")!, deck, locale, "runs");

  it("a Solo trial at 3.5 of 4 GB is told before anything is emptied, and offered a bigger plan", () => {
    const trial = said({ ...CARRY, limitDropsAt: null }, "trialing");
    expect(trial).toContain(
      "Until 14 days after your first payment, ohmail keeps up to 4 GB of letter text. From then on your plan keeps 2 GB, "
      + "and ohmail stops storing the text of your oldest letters beyond it.");
    expect(trial).toContain("A bigger plan keeps more text from now on.");
    expect(trial).not.toMatch(/Storage is (nearly )?full/);
    expect(storageNoticeOf(feed(open({ ...CARRY, usedBytes: 1_700_000_000, limitDropsAt: null })), none, "sideload")).toBeNull();
  });

  it("a paid Solo inside the 14 days is told the date, and offered the plan or the add-on", () => {
    const paid = said({ ...CARRY, limitDropsAt: "2026-11-08T12:00:00.000Z" }, "active");
    expect(paid).toContain("Until November 8, 2026, ohmail keeps up to 4 GB of letter text. From then on your plan keeps 2 GB");
    expect(paid).toContain("A bigger plan or the storage add-on keeps more text from now on.");
    expect(said({ ...CARRY, limitDropsAt: "2026-11-08T12:00:00.000Z" }, "active", DE, "de"))
      .toContain("Bis zum 8. November 2026 speichert ohmail bis zu 4 GB Nachrichtentext. Danach umfasst dein Tarif 2 GB");
  });

  it("put away inside the floor, it comes back once a payment dates it and once the plan's limit applies", () => {
    const held = new Set<string>();
    const putAway = (level: StorageLevel, cap: number | string) => held.has(storageNoticeKey("a", level, cap));
    const n = storageNoticeOf(feed(open({ ...CARRY, limitDropsAt: null })), putAway, "sideload")!;
    expect(n.level).toBe("carry");
    held.add(storageNoticeKey("a", n.level, storageNoticeCap(n.facts)));
    expect(storageNoticeOf(feed(open({ ...CARRY, limitDropsAt: null })), putAway, "sideload")).toBeNull();
    expect(storageNoticeOf(feed(open({ ...CARRY, limitDropsAt: "2026-11-08T12:00:00.000Z" }, "active")), putAway, "sideload")?.level)
      .toBe("carry");
    expect(storageNoticeOf(feed(open({ ...EMPTIED, usedBytes: 1_800_000_000 }, "active")), putAway, "sideload")?.level).toBe("full");
  });
});

describe("putting it away", () => {
  it("is kept in the keystore, so the next launch reads it back", async () => {
    const kv = memoryKV();
    await bindStorageNotices(kv);
    const key = storageNoticeKey("owner-a", "full", 2_000_000_000);
    putAwayStorageNotice(key);
    await storageNoticeWritesSettled();
    expect(JSON.parse(kv.map.get(STORAGE_NOTICE_KEY)!)).toEqual([key]);
    resetStorageNoticesForTests();
    expect(storageNoticePutAway(key)).toBe(false);
    await bindStorageNotices(kv);
    expect(storageNoticePutAway(key)).toBe(true);
    expect(storageNoticePutAway(storageNoticeKey("owner-b", "full", 2_000_000_000))).toBe(false);
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

  it("the reader's note covers both cases and says the text comes back once there is room", () => {
    for (const deck of [EN, DE]) {
      expect(deck.liveBodyWithheld).not.toMatch(/adds storage|mehr Speicherplatz/);
      // The offers say what keeps more text; whether text comes back is said apart.
      expect(`${deck.liveBodyWithheld} ${deck.storageOfferTrial} ${deck.storageOfferActive}`).not.toMatch(/bring back|bringt .*nicht zurück/);
    }
    expect(EN.liveBodyWithheld).toContain("stopped storing the text of older letters");
    expect(EN.liveBodyWithheld).toContain("space was full when it arrived");
    expect(EN.liveBodyWithheld).toContain("When there is room again, ohmail fetches this text back from your mail server.");
    expect(DE.liveBodyWithheld).toContain("Sobald wieder Platz frei ist, holt ohmail diesen Text von deinem Mailserver zurück.");
    expect(EN.storageNoticeNoRestore).toContain("does not bring back");
    expect(DE.storageNoticeNoRestore).toContain("nicht zurück");
  });
});

/**
 * TWO STATES WITH A COUNT BACK-FILLED WITHOUT DATES: (A) an account far below its cap with three letters
 * stored without their text, (B) a trial past its plan's size inside the trial floor. No trim is
 * recorded, so neither is told "oldest" or "at the time".
 */
describe("back-filled counts with no trim recorded", () => {
  const A = {
    usedBytes: 1_000_000, limitBytes: 4_000_000_000, emptiedForSpace: 3, firstEmptiedAt: null, keptFrom: null,
    withheldOnArrival: 0, upgrade: "plan", emptyingNow: false,
  };
  const B = {
    usedBytes: 1_900_000_000, limitBytes: 4_000_000_000, emptiedForSpace: 75_000, firstEmptiedAt: null, keptFrom: null,
    withheldOnArrival: 0, upgrade: "plan", emptyingNow: false, planLimitBytes: 2_000_000_000, limitDropsAt: null,
  };

  it("A: past, the plain count, no offer and no press", () => {
    const n = storageNoticeOf(feed(open(A, "active")), none, "sideload")!;
    expect({ level: n.level, plan: n.plan, manage: n.manage }).toEqual({ level: "past", plan: null, manage: false });
    const said = storageNoticeText(n, EN, "en", "runs");
    expect(said).toContain("The text of 3 letters is not stored here.");
    expect(said).toContain("stay complete in your mailbox on your mail server, and stay listed and findable here");
    expect(said).not.toMatch(/oldest|at the time|bigger plan|add-on|bring back/);
    const de = storageNoticeText(n, DE, "de", "runs");
    expect(de).toContain("Der Text von 3 Nachrichten ist hier nicht gespeichert.");
    expect(de).not.toMatch(/ältesten|damals/);
  });

  it("B: carry, the plain count, the floor, the offer and the press, no restore line", () => {
    const n = storageNoticeOf(feed(open(B, "trialing")), none, "sideload")!;
    expect({ level: n.level, plan: n.plan, manage: n.manage }).toEqual({ level: "carry", plan: "trial", manage: true });
    for (const refill of ["runs", "never"] as const) {
      const said = storageNoticeText(n, EN, "en", refill);
      expect(said).toContain("The text of 75,000 letters is not stored here.");
      expect(said, refill).not.toMatch(/your 75,000 oldest|at the time|bring back/);
      expect(said).toContain("Until 14 days after your first payment, ohmail keeps up to 4 GB of letter text.");
      expect(said).toContain("A bigger plan keeps more text from now on.");
    }
    // The refill brings back any letter emptied for space, dated or not.
    expect(storageNoticeText(n, EN, "en", "runs")).toContain(REFILL);
  });

  it("below the near threshold no press, emptying now included", () => {
    const n = storageNoticeOf(feed(open({ ...EMPTIED, usedBytes: 1_000_000_000, emptyingNow: true }, "active")), none, "sideload")!;
    expect({ level: n.level, plan: n.plan, manage: n.manage }).toEqual({ level: "full", plan: null, manage: false });
    const past = storageNoticeOf(feed(open({ ...EMPTIED, limitBytes: 10_000_000_000, emptyingNow: false }, "active")), none, "sideload")!;
    expect(past.manage).toBe(false);
  });

  it("put away under the earlier release: away at the same state, back at a worse level", async () => {
    const kv = memoryKV();
    kv.map.set(STORAGE_NOTICE_KEY, JSON.stringify(["owner-1.emptied"]));
    await bindStorageNotices(kv);
    const held = (level: StorageLevel, cap: string) => storageNoticeHeld("owner-1", level, cap, storageNoticePutAway);
    expect(storageNoticeOf(feed(open(A, "active")), held, "sideload")).toBeNull();
    expect(storageNoticeOf(feed(open({ ...A, usedBytes: 4_000_000_000 }, "active")), held, "sideload")?.level).toBe("full");
    const other = (level: StorageLevel, cap: string) => storageNoticeHeld("owner-2", level, cap, storageNoticePutAway);
    expect(storageNoticeOf(feed(open(A, "active")), other, "sideload")?.level).toBe("past");
  });
});
