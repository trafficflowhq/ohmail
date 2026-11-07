import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accountStorage, accounts, users,
  type AccessReadOpts, type AccessVerdict, type EntitlementsPort, type StorageOffer,
} from "@trafficflow/db";
import { accountStoragePrefs, storageMailSent } from "@trafficflow/db/cloud";
import {
  makeMailService, makeTestAuthDeps, runStorageMailPass, SpyMailer, STORAGE_MAIL_GAP_MS, throttleKeysFor,
} from "../src/index.js";

/**
 * THE STORAGE MAILS (cloud 0057): one at 90% of the cap and one when storage is full, once per
 * (account, level, cap), never two in a week, none while turned off, and only with an offer the person
 * can take. The program is a port the test states; the mail service is the real one over a spy.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const GB = 1_000_000_000;
const DAY = 86_400_000;
const START = new Date("2026-11-07T12:00:00.000Z");

const OFFER: StorageOffer = {
  currency: "usd", interval: "month",
  plans: [
    { plan: "solo", mailboxes: 2, roomBytes: 2 * GB, amount: 900 },
    { plan: "plus", mailboxes: 5, roomBytes: 5 * GB, amount: 1_500 },
    { plan: "pro", mailboxes: 10, roomBytes: 10 * GB, amount: 2_900 },
  ],
  addon: { unitBytes: 10 * GB, amount: 1_000, maxUnits: 10 },
  current: { plan: "solo", addonUnits: 0, roomBytes: 4 * GB, roomFrom: "now" },
  fit: { plan: "plus", addonUnits: 1, roomBytes: 15 * GB, amount: 2_500, keepsAll: true },
  canChange: true, reason: null,
};

interface Plane {
  cap: number;
  state: "trialing" | "active" | "past_due";
  offer: StorageOffer | null;
  asked: AccessReadOpts[];
}

/** The program as the test states it: a trial room's cap, a lifecycle, and its offer when asked. */
function portOf(plane: Plane): EntitlementsPort {
  const access = async (_id: string, opts?: AccessReadOpts): Promise<AccessVerdict> => {
    if (opts) plane.asked.push(opts);
    return {
      ok: true, limits: { mailboxes: 2, storageBytes: plane.cap, canAddMailbox: true, aiEnabled: true },
      trialStorage: { planBytesLimit: 2 * GB, until: null },
      lifecycle: {
        state: plane.state, closedReason: null, trialEndsAt: null, graceUntil: null, closedAt: null,
        erasureAt: null, erasedAt: null, formerlyPaid: false,
      },
      ...(opts?.storageNeed && plane.offer ? { storageOffer: plane.offer } : {}),
    };
  };
  return {
    access, accessOrFault: access, spend: async () => ({ verdict: "fault" }), release: async () => "settled",
    manageLink: async () => null, releaseAccount: async () => "none",
  };
}

async function setup(o: { bytes: number; locale?: "en" | "de" }) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "Storage" });
  await db.insert(users).values({ accountId, email: `sam-${accountId.slice(0, 8)}@example.com` });
  if (o.locale) await db.insert(accountSettings).values({ accountId, locale: o.locale });
  await db.insert(accountStorage).values({ accountId, bytes: o.bytes });
  const spy = new SpyMailer();
  const mail = makeMailService({
    mailer: spy,
    config: { appUrl: "http://localhost:3001", siteUrl: "http://localhost:3000", supportEmail: "support@example.com" },
    throttleKeys: throttleKeysFor(makeTestAuthDeps().keyProvider),
  });
  const plane: Plane = { cap: 4 * GB, state: "trialing", offer: OFFER, asked: [] };
  let now = START;
  const run = () => runStorageMailPass(db, { port: portOf(plane), mail, now: () => now });
  return { db, accountId, spy, plane, run, at: (days: number) => { now = new Date(START.getTime() + days * DAY); } };
}

const setBytes = (db: Db, accountId: string, bytes: number, trimmedAt: Date | null = null) =>
  db.update(accountStorage).set({ bytes, lastHuskedAt: trimmedAt }).where(eq(accountStorage.accountId, accountId));

describe("the storage mails", () => {
  it("mails once at 90% of a cap: the numbers, the fitted choice with its price, Settings › Storage, no token", async () => {
    const w = await setup({ bytes: 3.6 * GB });
    const first = await w.run();
    expect(first.sent).toEqual({ near: 1, full: 0 });
    const mail = w.spy.only("storage_near");
    expect(mail.rendered.subject).toBe("Your ohmail storage is 90% full");
    expect(mail.rendered.text).toContain("3.6 GB of 4 GB used, your trial room.");
    expect(mail.rendered.text).toContain("Plus + 10 GB storage keeps all your mail: 15 GB for $25/month.");
    expect(mail.rendered.text).toContain("http://localhost:3001/#/settings/storage");
    expect(mail.rendered.text).toContain("To stop storage mails, turn them off in Settings → Storage.");
    expect(mail.rendered.html).not.toMatch(/token=|manage\?/);
    // The offer was asked with the mail's need, on a read of its own.
    expect(w.plane.asked.filter((o) => o.storageNeed)).toHaveLength(1);
    // Once: the next run, and the one after, send nothing more.
    expect((await w.run()).sent).toEqual({ near: 0, full: 0 });
    w.at(30);
    expect((await w.run()).sent).toEqual({ near: 0, full: 0 });
    expect(w.spy.sent).toHaveLength(1);
    expect(await w.db.select().from(storageMailSent)).toMatchObject([
      { accountId: w.accountId, level: "near", capBytes: 4 * GB, deliveredAt: START },
    ]);
  });

  it("never two within a week: full waits out the week the 90% mail began", async () => {
    const w = await setup({ bytes: 3.6 * GB });
    await w.run();
    w.at(2);
    await setBytes(w.db, w.accountId, 3.7 * GB, new Date(START.getTime() + 2 * DAY));
    expect((await w.run()).sent).toEqual({ near: 0, full: 0 });
    w.at(7 + 0.01);
    const later = await w.run();
    expect(later.sent).toEqual({ near: 0, full: 1 });
    const full = w.spy.only("storage_full");
    expect(full.rendered.subject).toBe("Your ohmail storage is full");
    expect(full.rendered.text).toContain("This is the last storage mail until something changes.");
    expect(STORAGE_MAIL_GAP_MS).toBe(7 * DAY);
  });

  it("a new cap is a new mail, a week on; none while the person turned them off", async () => {
    const w = await setup({ bytes: 3.6 * GB });
    await w.run();
    w.at(8);
    w.plane.cap = 3.9 * GB;
    await w.db.insert(accountStoragePrefs).values({ accountId: w.accountId, mailOffAt: new Date(START.getTime() + DAY) });
    const off = await w.run();
    expect(off).toMatchObject({ off: 1, sent: { near: 0, full: 0 } });
    await w.db.update(accountStoragePrefs).set({ mailOffAt: null }).where(eq(accountStoragePrefs.accountId, w.accountId));
    expect((await w.run()).sent).toEqual({ near: 1, full: 0 });
    expect(w.spy.ofTemplate("storage_near")).toHaveLength(2);
  });

  it("no offer the person can take, or a lifecycle that is not a trial or a paid month: no mail", async () => {
    const w = await setup({ bytes: 3.6 * GB });
    w.plane.offer = { ...OFFER, canChange: false, reason: "past_due" };
    expect(await w.run()).toMatchObject({ noOffer: 1, sent: { near: 0, full: 0 } });
    w.plane.offer = null;
    expect(await w.run()).toMatchObject({ noOffer: 1 });
    w.plane.offer = OFFER;
    w.plane.state = "past_due";
    expect(await w.run()).toMatchObject({ due: 0, sent: { near: 0, full: 0 } });
    expect(w.spy.sent).toEqual([]);
    expect(await w.db.select().from(storageMailSent), "nothing was claimed").toEqual([]);
  });

  it("below 90% nothing is owed; a failed send hands the claim back and the next run sends it", async () => {
    const quiet = await setup({ bytes: 3.5 * GB });
    expect(await quiet.run()).toMatchObject({ due: 0 });
    const w = await setup({ bytes: 3.6 * GB, locale: "de" });
    w.spy.failNext();
    expect(await w.run()).toMatchObject({ faults: 1, sent: { near: 0, full: 0 } });
    expect(await w.db.select().from(storageMailSent)).toEqual([]);
    expect((await w.run()).sent).toEqual({ near: 1, full: 0 });
    const de = w.spy.ofTemplate("storage_near").at(-1)!;
    expect(de.rendered.subject).toBe("Dein ohmail-Speicher ist zu 90 % voll");
    expect(de.rendered.text).toContain("3,6 GB von 4 GB belegt, der Speicher deiner Testphase.");
    expect(de.rendered.text).toContain("Plus + 10 GB Speicher behält alle deine Mails: 15 GB für $25 pro Monat.");
  });
});
