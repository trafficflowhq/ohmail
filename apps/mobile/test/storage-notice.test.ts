import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  accessFeedFor, accessOf, loadLiveBody, readAccess, resetAccessFeedForTests, setStorageChoice, storagePutAwayOf,
  type AccessFeed,
} from "../src/net/account";
import { resetAccessLockForTests } from "../src/net/access-lock";
import type { ConnectedSession } from "../src/net/pairing";
import {
  grouped, storageCardOf, storagePaneOf, storageRowValue, storageSize,
} from "../src/ui/storage-notice";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import { formatStorageBytes } from "../../webapp/app/shell/storage-state";

/**
 * STORAGE ON THE PHONE: the access answer's storage block as the phone narrows it, the card the
 * server decided, said in the person's words for why the cap is what it is, the Storage screen's
 * numbers, and the two doors (a storage choice, an emptied letter's text). No price is even read;
 * the store face states the numbers and names no plan to move to and no page to buy on.
 */

const GB = 1_000_000_000;
const OFFER = {
  currency: "usd", interval: "month",
  plans: [
    { plan: "solo", mailboxes: 2, roomBytes: 2 * GB, amount: 900 },
    { plan: "plus", mailboxes: 5, roomBytes: 5 * GB, amount: 1500 },
    { plan: "pro", mailboxes: 10, roomBytes: 10 * GB, amount: 2900 },
  ],
  addon: { unitBytes: 10 * GB, amount: 1000, maxUnits: 10 },
  current: { plan: "solo", addonUnits: 0, roomBytes: 2 * GB, roomFrom: "now" },
  fit: { plan: "plus", addonUnits: 1, roomBytes: 15 * GB, amount: 2500, keepsAll: true },
  canChange: true, reason: null,
};
/** A Solo trial at 3.2 of its 4 GB trial room, its first import running toward about 12.5 GB. */
const NEAR = {
  usedBytes: 3.2 * GB, limitBytes: 4 * GB, emptiedForSpace: 0, firstEmptiedAt: null, keptFrom: null,
  withheldOnArrival: 0, upgrade: "plan", emptyingNow: false, planLimitBytes: 2 * GB, limitDropsAt: null,
  limitReason: "trial", importing: true, card: "near", mail: true,
  estimate: {
    expectedBytes: 12.5 * GB, expectedLetters: 500_000, storedLetters: 128_000, avgLetterBytes: 25_000,
    avgMeasured: true, complete: true, at: "2026-11-07T08:00:00.000Z",
  },
  mailboxes: [
    { id: "mb-1", usedBytes: 2.6 * GB, letters: 104_000, expectedLetters: 400_000, expectedBytes: 10 * GB, importing: true },
    { id: "mb-2", usedBytes: 0.6 * GB, letters: 24_000, expectedLetters: 100_000, expectedBytes: 2.5 * GB, importing: true },
  ],
  offer: OFFER,
};
/** A small trial account as the wire carried it: 1.2 MB of 4 GB, 4,080 letters averaging 223 B. */
const SMALL = {
  ...NEAR, usedBytes: 1_208_935, importing: false, card: null,
  estimate: {
    expectedBytes: 909_840, expectedLetters: 4_080, storedLetters: 4_080, avgLetterBytes: 223,
    avgMeasured: true, complete: true, at: "2026-11-08T02:00:00.000Z",
  },
  mailboxes: [
    { id: "mb-1", usedBytes: 1_064_422, letters: 3_182, expectedLetters: 3_182, expectedBytes: 709_586, importing: false },
    { id: "mb-2", usedBytes: 144_513, letters: 898, expectedLetters: 898, expectedBytes: 200_254, importing: false },
  ],
};
const FULL = { ...NEAR, usedBytes: 4 * GB, card: "full", emptyingNow: true, emptiedForSpace: 286_000, keptFrom: "2019-03" };
const open = (storage: unknown, state = "trialing") => ({
  metered: true, access: "open", lifecycle: { state, closedReason: null }, storage,
});
const feed = (storage: unknown): AccessFeed => ({ answer: accessOf(open(storage))!, caughtUp: null, at: 0 });
/** Any amount or currency a store face must never draw. */
const PRICE = /[$€£]|\b(usd|eur|chf)\b|\/month|per month|pro Monat|\b(9|15|25|29)\.00\b/i;

describe("the storage block, as the phone narrows it", () => {
  it("reads the new fields, and keeps no amount or currency from the offer", () => {
    const s = accessOf(open(NEAR))!.storage!;
    expect(s).toMatchObject({ limitReason: "trial", importing: true, card: "near", mail: true });
    expect(s.estimate).toEqual({
      expectedBytes: 12.5 * GB, expectedLetters: 500_000, storedLetters: 128_000, avgLetterBytes: 25_000, complete: true,
    });
    expect(s.mailboxes).toEqual([
      { id: "mb-1", usedBytes: 2.6 * GB, expectedBytes: 10 * GB, importing: true },
      { id: "mb-2", usedBytes: 0.6 * GB, expectedBytes: 2.5 * GB, importing: true },
    ]);
    expect(s.offer).toEqual({
      plans: [{ plan: "solo", roomBytes: 2 * GB }, { plan: "plus", roomBytes: 5 * GB }, { plan: "pro", roomBytes: 10 * GB }],
      addon: { unitBytes: 10 * GB, maxUnits: 10 },
      current: { plan: "solo", addonUnits: 0, roomBytes: 2 * GB },
      fit: { plan: "plus", addonUnits: 1, roomBytes: 15 * GB, keepsAll: true },
    });
    expect(JSON.stringify(s)).not.toMatch(/amount|currency|usd|interval/);
  });

  it("an older server sends no card (not the server's none); an offer the program may not change, or a malformed one: no offer", () => {
    const older = accessOf(open({ usedBytes: 3.2 * GB, limitBytes: 4 * GB, emptiedForSpace: 0 }))!.storage!;
    expect(older).toMatchObject({ limitReason: null, card: undefined, mail: null, estimate: null, mailboxes: [], offer: null });
    expect(accessOf(open({ ...NEAR, card: null }))!.storage!.card).toBeNull();
    expect(accessOf(open({ ...NEAR, offer: { ...OFFER, canChange: false } }))!.storage!.offer).toBeNull();
    expect(accessOf(open({ ...NEAR, offer: { ...OFFER, fit: { plan: "gold" } } }))!.storage!.offer).toBeNull();
    expect(accessOf(open({ ...NEAR, card: "soon", limitReason: "gift" }))!.storage).toMatchObject({ card: null, limitReason: null });
    expect(accessOf({ metered: false, storage: NEAR })).toEqual({ metered: false });
  });
});

describe("the card", () => {
  it("near, on the store face: the numbers and the expected size, no plan to move to and nothing to manage", () => {
    expect(storageCardOf(feed(NEAR), EN, "en", "store")).toEqual({
      level: "near",
      head: "Storage is 80% full",
      ratio: 0.8,
      lines: ["3.2 GB of your trial room of 4 GB used. Expected about 12.5 GB when the import finishes."],
      fit: null,
      manage: "none",
    });
  });

  it("a sideload build adds the fitted plan named with its room, and the press", () => {
    const side = storageCardOf(feed(NEAR), EN, "en", "sideload")!;
    expect(side.manage).toBe("press");
    expect(side.fit).toBe("Plus + 10 GB storage keeps all your mail: 15 GB.");
    expect(side.lines).toEqual(storageCardOf(feed(NEAR), EN, "en", "store")!.lines);
  });

  it("is worded by why the cap is what it is: the trial's room, the plan's own, a lower limit held to its date", () => {
    const used = (storage: Record<string, unknown>) => storageCardOf(feed(storage), EN, "en", "store")!.lines[0];
    expect(used(NEAR)).toMatch(/^3\.2 GB of your trial room of 4 GB used\./);
    expect(used({ ...NEAR, limitBytes: 2 * GB, usedBytes: 1.7 * GB, planLimitBytes: null, limitReason: "plan" }))
      .toMatch(/^1\.7 GB of your plan's 2 GB used\./);
    expect(used({ ...NEAR, limitBytes: 15 * GB, usedBytes: 13 * GB, planLimitBytes: 5 * GB, limitDropsAt: "2026-11-21T12:00:00.000Z", limitReason: "held" }))
      .toMatch(/^13 GB used of the 15 GB you keep until November 21, 2026\./);
    expect(storageCardOf(feed(NEAR), DE, "de", "store")!.lines[0])
      .toBe("3,2 GB von 4 GB Platz deiner Testphase belegt. Erwartet etwa 12,5 GB, wenn der Import fertig ist.");
  });

  it("full: the month text is kept from; drop: the plan's own limit and when it applies", () => {
    const full = storageCardOf(feed(FULL), EN, "en", "store")!;
    expect(full.head).toBe("Storage is full");
    expect(full.lines[1]).toBe("Text kept for letters from March 2019 on; older ones stay on your mail server.");
    const drop = { ...NEAR, usedBytes: 3.1 * GB, card: "drop" };
    expect(storageCardOf(feed(drop), EN, "en", "sideload")).toMatchObject({
      head: "Your storage drops to 2 GB",
      lines: [expect.any(String), "From 14 days after your first payment your plan keeps 2 GB, and ohmail keeps the text of your newest letters within it."],
    });
    /* The store face says no payment, and still says when the drop comes and what it keeps. */
    expect(storageCardOf(feed(drop), EN, "en", "store")).toMatchObject({
      head: "Your storage drops to 2 GB",
      lines: ["3.1 GB of your trial room of 4 GB used. Expected about 12.5 GB when the import finishes.",
        "After your trial your plan keeps 2 GB; ohmail keeps the text of your newest letters within it, and older letters stay on your mail server."],
    });
    expect(storageCardOf(feed(drop), DE, "de", "store")!.lines[1]).toBe(
      "Nach deiner Testphase umfasst dein Tarif 2 GB; ohmail behält darin den Text deiner neuesten Nachrichten, ältere bleiben auf deinem Mailserver.");
    expect(storageCardOf(feed({ ...drop, limitDropsAt: "2026-11-21T12:00:00.000Z" }), EN, "en", "store")!.lines[1])
      .toBe("From November 21, 2026 your plan keeps 2 GB, and ohmail keeps the text of your newest letters within it.");
  });

  it("no fitted plan without an offer, or when the plan held is the fit; the largest named when nothing keeps it all", () => {
    expect(storageCardOf(feed({ ...NEAR, offer: undefined }), EN, "en", "sideload")!.fit).toBeNull();
    expect(storageCardOf(feed({ ...NEAR, offer: { ...OFFER, fit: { ...OFFER.fit, plan: "solo", addonUnits: 0 } } }), EN, "en", "sideload")!.fit).toBeNull();
    const most = { ...OFFER, fit: { plan: "pro", addonUnits: 10, roomBytes: 110 * GB, amount: 12900, keepsAll: false } };
    expect(storageCardOf(feed({ ...NEAR, offer: most }), EN, "en", "sideload")!.fit).toBe("Pro + 100 GB storage keeps the most: 110 GB.");
  });

  it("none when the server decided none, or with no feed", () => {
    expect(storageCardOf(feed({ ...NEAR, card: null }), EN, "en", "store")).toBeNull();
    expect(storageCardOf(feed({ ...FULL, card: null }), EN, "en", "store")).toBeNull();
    expect(storageCardOf(null, EN, "en", "store")).toBeNull();
  });

  it("an older server decides none: the phone decides it from the numbers it sends", () => {
    const older = (s: Record<string, unknown>) => storageCardOf(feed({ limitBytes: 4 * GB, emptiedForSpace: 0, ...s }), EN, "en", "store");
    expect(older({ usedBytes: 4 * GB, emptiedForSpace: 286_000, emptyingNow: true, keptFrom: "2019-03" })).toEqual({
      level: "full", head: "Storage is full", ratio: 1,
      lines: ["4 GB of your plan's 4 GB used.", "Text kept for letters from March 2019 on; older ones stay on your mail server."],
      fit: null, manage: "none",
    });
    expect(older({ usedBytes: 3 * GB, emptiedForSpace: 12, emptyingNow: true })?.head).toBe("Storage is full");
    expect(older({ usedBytes: 3.2 * GB })).toMatchObject({ level: "near", head: "Storage is 80% full", lines: ["3.2 GB of your plan's 4 GB used."] });
    expect(older({ usedBytes: 3.1 * GB })).toBeNull();
    expect(older({ usedBytes: 2 * GB, planLimitBytes: 2 * GB })).toMatchObject({
      level: "drop", head: "Your storage drops to 2 GB", lines: ["2 GB of your trial room of 4 GB used.",
        "After your trial your plan keeps 2 GB; ohmail keeps the text of your newest letters within it, and older letters stay on your mail server."],
    });
    expect(older({ usedBytes: 3 * GB, planLimitBytes: 2 * GB, limitDropsAt: "2026-11-21T12:00:00.000Z" })!.lines[0])
      .toBe("3 GB used of the 4 GB you keep until November 21, 2026.");
    const pane = (s: Record<string, unknown>) => storagePaneOf(accessOf(open({ limitBytes: 4 * GB, emptiedForSpace: 0, ...s }))!.storage!, EN, "en", "store");
    expect(pane({ usedBytes: 2 * GB, planLimitBytes: 2 * GB }).sub).toBe("used, your trial room");
    expect(pane({ usedBytes: 2 * GB }).sub).toBe(storagePaneOf(accessOf(open({ ...NEAR, limitReason: "plan", planLimitBytes: null }))!.storage!, EN, "en", "store").sub);
  });

  it("no amount, payment or page to buy on reaches any sentence the store face draws, in either language", () => {
    const pointer = /ohmail\.app|payment|Zahlung|add-on|Zusatz|keeps all your mail|alle deine Mails/i;
    for (const [deck, locale] of [[EN, "en"], [DE, "de"]] as const) {
      for (const storage of [NEAR, FULL, { ...NEAR, card: "drop" }]) {
        const card = storageCardOf(feed(storage), deck, locale, "store")!;
        const pane = storagePaneOf(accessOf(open(storage))!.storage!, deck, locale, "store");
        const said = [card.head, ...card.lines, card.fit, pane.figure, pane.plan, ...pane.estimate,
          ...pane.plans.flatMap((r) => [r.name, r.room])].join(" ");
        expect(said, locale).not.toMatch(PRICE);
        expect(said, locale).not.toMatch(pointer);
        expect([card.manage, pane.manage, pane.plans.length]).toEqual(["none", "none", 0]);
        /* What the trial's room becomes is said all the same, on the card at the drop and in the pane. */
        if (card.level === "drop") expect(card.lines[1], locale).toBe(deck.storageDropPlain("2 GB"));
        expect(pane.plan, locale).toBe(deck.storagePlanTrialPlain("4 GB", "2 GB"));
      }
    }
  });
});

describe("the Storage screen", () => {
  it("draws the numbers: used of the cap, per mailbox, expected in GB and letters; a sideload build the plans with their rooms", () => {
    const pane = storagePaneOf(accessOf(open(NEAR))!.storage!, EN, "en", "sideload");
    expect(pane).toMatchObject({
      figure: "3.2 GB of 4 GB", tag: "80%", sub: "used, your trial room",
      mailboxes: [{ id: "mb-1", said: "2.6 GB kept · 10 GB expected" }, { id: "mb-2", said: "600 MB kept · 2.5 GB expected" }],
      estimate: [
        "Expected when the import finishes: about 12.5 GB, 500,000 letters.",
        "First import running: 128,000 of 500,000 letters.",
        "Your letters average about 25 KB of text.",
      ],
      kept: null,
      plan: "Your trial keeps up to 4 GB. On Solo, 2 GB from 14 days after your first payment.",
      manage: "press",
      mail: true,
    });
    expect(pane.plans).toEqual([
      { name: "Solo · your plan", room: "2 GB · about 80,000 letters", fitted: null },
      { name: "Plus", room: "5 GB · about 200,000 letters", fitted: null },
      { name: "Pro", room: "10 GB · about 400,000 letters", fitted: null },
      { name: "Storage add-on", room: "+10 GB · about 400,000 letters each", fitted: null },
      { name: "Plus + 10 GB storage", room: "15 GB · about 600,000 letters", fitted: "all" },
    ]);
    expect(pane.bar).toEqual({
      scaleBytes: 12.5 * GB, parts: [{ id: "mb-1", bytes: 2.6 * GB }, { id: "mb-2", bytes: 0.6 * GB }],
      limitBytes: 4 * GB, expectedBytes: 12.5 * GB,
    });
    expect(storageRowValue(accessOf(open(NEAR))!.storage!, EN, "en")).toBe("3.2 GB of 4 GB");
    /* The store face: the same numbers; no plans, no add-on, the trial's line without the payment, nothing to manage. */
    const store = storagePaneOf(accessOf(open(NEAR))!.storage!, EN, "en", "store");
    expect(store).toMatchObject({
      figure: pane.figure, sub: pane.sub, mailboxes: pane.mailboxes, estimate: pane.estimate, plans: [], manage: "none",
      plan: "Your trial keeps up to 4 GB. After it, your plan keeps 2 GB.",
    });
    expect(storagePaneOf(accessOf(open(NEAR))!.storage!, DE, "de", "store").plan)
      .toBe("Deine Testphase speichert bis zu 4 GB. Danach umfasst dein Tarif 2 GB.");
    const held = { ...NEAR, limitBytes: 15 * GB, usedBytes: 13 * GB, planLimitBytes: 5 * GB, limitDropsAt: "2026-11-21T12:00:00.000Z", limitReason: "held" };
    expect(storagePaneOf(accessOf(open(held))!.storage!, EN, "en", "store").plan)
      .toBe("You keep up to 15 GB until November 21, 2026. Then Solo keeps 5 GB.");
  });

  it("full: the kept month; an estimate still growing says so; no offer, no plans", () => {
    const pane = storagePaneOf(accessOf(open({ ...FULL, offer: undefined, estimate: { ...NEAR.estimate, complete: false } }))!.storage!, EN, "en", "store");
    expect(pane.tag).toBe("Full");
    expect(pane.kept).toBe("Text kept for letters from March 2019 on. Older letters are complete on your mail server, and still listed and findable here.");
    expect(pane.estimate).toContain("The figure grows as ohmail opens more of your folders.");
    expect(pane.plans).toEqual([]);
    expect(pane.plan).toBeNull();
    const de = storagePaneOf(accessOf(open(NEAR))!.storage!, DE, "de", "sideload");
    expect(de.figure).toBe("3,2 GB von 4 GB");
    expect(de.plans[0]).toEqual({ name: "Solo · dein Tarif", room: "2 GB · etwa 80.000 Nachrichten", fitted: null });
  });

  it("a small account reads the web's figures: MB, KB and B, letters counted exactly, the average in bytes", () => {
    const facts = accessOf(open(SMALL))!.storage!;
    expect(storagePaneOf(facts, EN, "en", "store")).toMatchObject({
      figure: "1 MB of 4 GB",
      mailboxes: [{ id: "mb-1", said: "1 MB kept · 710 KB expected" }, { id: "mb-2", said: "145 KB kept · 200 KB expected" }],
      estimate: ["All your mail: about 910 KB, 4,080 letters.", "Your letters average about 223 B of text."],
    });
    expect(storageRowValue(facts, EN, "en")).toBe("1 MB of 4 GB");
    expect(storageCardOf(feed({ ...SMALL, card: "near" }), EN, "en", "store")!.lines[0]).toBe("1 MB of your trial room of 4 GB used.");
    expect(storagePaneOf(facts, DE, "de", "store")).toMatchObject({
      figure: "1 MB von 4 GB",
      mailboxes: [{ id: "mb-1", said: "1 MB gespeichert · 710 KB erwartet" }, { id: "mb-2", said: "145 KB gespeichert · 200 KB erwartet" }],
      estimate: ["Alle deine Mails: etwa 910 KB, 4.080 Nachrichten.", "Deine Nachrichten haben im Schnitt etwa 223 B Text."],
    });
    expect(storageRowValue(facts, DE, "de")).toBe("1 MB von 4 GB");
  });

  it("a plan's room in letters is the web's count, whatever this account's average", () => {
    expect(storagePaneOf(accessOf(open({ ...SMALL, offer: OFFER }))!.storage!, EN, "en", "sideload").plans[0])
      .toEqual({ name: "Solo · your plan", room: "2 GB · about 80,000 letters", fitted: null });
  });

  it("prints every size and count as the web does, in both languages", () => {
    const sizes = [0, 1, 223, 999, 1_000, 144_513, 909_840, 999_499, 999_500, 1_208_935, 999_999_999, GB, 3.2 * GB,
      9.94 * GB, 9.96 * GB, 12.5 * GB, 99.94 * GB, 99.96 * GB, 110 * GB, 1_234 * GB, 12_345_678 * GB];
    for (const locale of ["en", "de"]) {
      for (const bytes of sizes) {
        for (const fine of [true, false]) {
          expect(storageSize(bytes, locale, fine), `${bytes} ${locale} ${fine}`).toBe(formatStorageBytes(bytes, locale, fine));
        }
      }
      for (const n of [0, 42, 898, 4_080, 500_000, 1_234_567]) {
        expect(grouped(n, locale), `${n} ${locale}`).toBe(new Intl.NumberFormat(locale).format(n));
      }
    }
  });
});

/** A paired Cloud session whose door answers per route, recording every request. */
function door(answers: Record<string, () => Response>) {
  const asked: Array<{ method: string; path: string; body: string | null }> = [];
  const s = {
    standalone: false,
    ownerKey: "owner-1",
    profile: { id: "pairing-1", origin: "https://cloud.test", apiBase: null, flavor: "managed" },
    fetch: async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      asked.push({ method: init.method ?? "GET", path, body: typeof init.body === "string" ? init.body : null });
      const answer = answers[`${init.method ?? "GET"} ${path}`];
      return answer ? answer() : new Response("no", { status: 404 });
    },
  } as unknown as ConnectedSession;
  return { s, asked };
}
const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the doors", () => {
  beforeEach(() => {
    resetAccessLockForTests();
    resetAccessFeedForTests();
    vi.restoreAllMocks();
  });

  it("Dismiss tells the server the level, and the card leaves this phone's feed at once", async () => {
    const { s, asked } = door({ "GET /account/access": json(open(NEAR)), "PATCH /account/storage": json({ dismissed: "near" }) });
    await readAccess(s);
    expect(storageCardOf(accessFeedFor("pairing-1"), EN, "en", "store")?.level).toBe("near");
    expect(await setStorageChoice(s, { dismiss: "near" })).toBe(true);
    expect(asked.at(-1)).toEqual({ method: "PATCH", path: "/account/storage", body: JSON.stringify({ dismiss: "near" }) });
    expect(storageCardOf(accessFeedFor("pairing-1"), EN, "en", "store")).toBeNull();
  });

  it("Dismiss against an older server asks it nothing and holds for this run, until a worse level or a new cap", async () => {
    /* A fresh session per read: one session's reads are debounced. */
    const read = async (usedBytes: number, limitBytes = 4 * GB) => {
      const d = door({ "GET /account/access": json(open({ usedBytes, limitBytes, emptiedForSpace: 0 })) });
      await readAccess(d.s);
      return d;
    };
    const card = () => storageCardOf(accessFeedFor("pairing-1"), EN, "en", "store", storagePutAwayOf("pairing-1"))?.level ?? null;
    const { s, asked } = await read(3.2 * GB);
    expect(card()).toBe("near");
    expect(await setStorageChoice(s, { dismiss: "near" })).toBe(true);
    expect(asked.map((a) => a.method)).toEqual(["GET"]);
    expect(card()).toBeNull();
    await read(3.3 * GB);
    expect(card()).toBeNull();
    await read(4 * GB);
    expect(card()).toBe("full");
    const bigger = await read(3.4 * GB, 4.2 * GB);
    expect(card()).toBe("near");
    await setStorageChoice(bigger.s, { dismiss: "near" });
    expect(card()).toBeNull();
    resetAccessFeedForTests();
    await read(3.4 * GB, 4.2 * GB);
    expect(card()).toBe("near");
  });

  it("a refused choice changes nothing here; the mail switch follows the server's yes", async () => {
    const refused = door({ "GET /account/access": json(open(NEAR)), "PATCH /account/storage": json({}, 503) });
    await readAccess(refused.s);
    expect(await setStorageChoice(refused.s, { dismiss: "near" })).toBe(false);
    expect(accessFeedFor("pairing-1")?.answer.storage?.card).toBe("near");
    const ok = door({ "PATCH /account/storage": json({ mail: false }) });
    expect(await setStorageChoice(ok.s, { mail: false })).toBe(true);
    expect(accessFeedFor("pairing-1")?.answer.storage?.mail).toBe(false);
  });

  it("Load it now asks for the letter once and hands its text back; each refusal by name", async () => {
    const { s, asked } = door({ "GET /messages/m-1/live-body": json({ text: "Hi Sam,", html: "<p>Hi Sam,</p>" }) });
    expect(await loadLiveBody(s, "m-1")).toEqual({ kind: "text", text: "Hi Sam," });
    expect(asked).toEqual([{ method: "GET", path: "/messages/m-1/live-body", body: null }]);
    for (const [status, kind] of [[410, "gone"], [413, "too_large"], [429, "busy"], [424, "failed"], [409, "failed"]] as const) {
      const d = door({ "GET /messages/m-1/live-body": json({ error: { code: "x" } }, status) });
      expect(await loadLiveBody(d.s, "m-1"), String(status)).toEqual({ kind });
    }
  });
});
