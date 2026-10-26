import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { accounts, folderState, mailboxCredentials, mailboxes, messages, rules } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage, type OrganizerProfileDoc,
} from "@trafficflow/core/adapters/organizer-profile";
import { serializeOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { startWorker } from "../src/index.js";
import { GAP_CLOCK_ALLOWANCE_MS } from "../src/gap-window.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * THE GAP TRAVELS, ON THE HOSTED WORKER (RULING-026 lane A). Cloud's release writes its settings
 * first, a rule added since the debounced write and where the gap began included, then removes its
 * claim; a Cloud reader beside a desktop that handed back opens its window at the desktop's press,
 * read from the settings document, without writing to `_meta`, and offers the letter after Organize here.
 */

type Db = ReturnType<typeof makeDb>;
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
let DB = "";
const closers: Array<() => Promise<void>> = [];
const DESKTOP = "a-desktop-install";

async function waitFor(pred: () => Promise<boolean>, ms = 20_000, step = 100): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

async function seedConsentedMailbox(db: Db): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "gap-travels" });
  const [row] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`,
    organizerRole: "organizer", organizeConsentedAt: new Date(Date.now() - 60 * 60 * 1000),
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  await db.insert(rules).values({
    accountId, kind: "domain", match: "feed.example", destination: "ohmail/News", priority: 5,
    createdAt: new Date(Date.now() - 60 * 60 * 1000), updatedAt: new Date(Date.now() - 60 * 60 * 1000),
  });
  return { accountId, mailboxId: row!.id };
}

const rowOf = async (db: Db, mailboxId: string) =>
  (await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)))[0]!;

/** Every settings document in the folder, by the parser, oldest first. */
function documents(raws: string[]): Array<{ doc: OrganizerProfileDoc; installId: string | null }> {
  return raws.flatMap((raw) => {
    const p = parseProfileMessage(raw);
    return p === null || isMalformedProfile(p) || p.doc === undefined ? [] : [{ doc: p.doc, installId: p.installId }];
  });
}

describe("the gap travels on the hosted worker", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_gap_travels"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("the release writes the settings, a rule added since and the press included, before the claim leaves", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedConsentedMailbox(db);
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test", rosterIntervalMs: 200,
      adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());
    const meta = fleet.metaFor(mb.mailboxId);
    expect(await waitFor(async () => meta.profileAppends >= 1), "premise: the organizer published its settings").toBe(true);
    const before = meta.profileAppends;
    // A decision after the debounced write: only the release's flush can carry it.
    await db.insert(rules).values({
      accountId: mb.accountId, kind: "domain", match: "later.example", destination: "ohmail/News", priority: 5,
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(meta.profileAppends, "premise: the debounce held the new rule").toBe(before);

    const pressed = new Date();
    await db.update(mailboxes).set({ releaseRequestedAt: pressed }).where(eq(mailboxes.id, mb.mailboxId));
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerReleasedAt !== null),
      "the release was never recorded").toBe(true);

    const appends = fleet.indicesOf(mb.mailboxId, "profile_append");
    const removals = fleet.indicesOf(mb.mailboxId, "claim_remove");
    expect(appends.length, "the release wrote no settings").toBe(before + 1);
    expect(removals.length).toBeGreaterThan(0);
    expect(appends.at(-1)!, fleet.describeTrace()).toBeLessThan(removals.at(-1)!);
    const last = documents(meta.messages.map((m) => m.raw)).at(-1)!;
    expect(last.installId).toBe("cloud-test");
    expect(last.doc.rules.map((r) => r.match).sort()).toEqual(["feed.example", "later.example"]);
    // No claim here carries the server's stamp: the gap starts at the press less the clock allowance.
    expect(last.doc.gap, "the release left no gap")
      .toMatchObject({ since: new Date(pressed.getTime() - GAP_CLOCK_ALLOWANCE_MS).toISOString(), by: "cloud-test" });
    expect(Date.parse(last.doc.gap!.at)).toBeGreaterThanOrEqual(pressed.getTime());
    // Once per release: the reader cycles after it write nothing.
    await new Promise((r) => setTimeout(r, 800));
    expect(meta.profileAppends, "a reader wrote settings").toBe(before + 1);
  }, 60_000);

  it("a reader adopts the desktop's gap: no write to the folder, still a reader, then the letter is offered", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedConsentedMailbox(db);
    fleet.seedClaim(mb.mailboxId, formatClaim({
      authorizedAt: null, capabilities: ["profile"], installId: DESKTOP, kind: "local",
      displayName: "the laptop", heartbeat: new Date(), claimedAt: new Date(), nonce: "n1",
    }));
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test", rosterIntervalMs: 200,
      adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerState === "held"),
      "the premise is a reader beside a live desktop").toBe(true);
    const meta = fleet.metaFor(mb.mailboxId);

    // THE DESKTOP'S PRESS; a letter arrives before it lets go and the reader adopts it at the inbox.
    const pressed = new Date();
    await new Promise((r) => setTimeout(r, 50));
    fleet.behave(mb.mailboxId, {
      deliver: [{ from: "digest@feed.example", subject: "a newsletter", messageId: `gap-${randomUUID()}@feed.example`, internalDate: new Date() }],
    });
    expect(await waitFor(async () => (await db.select({ by: folderState.lastSetBy }).from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(eq(messages.mailboxId, mb.mailboxId), eq(messages.fromAddress, "digest@feed.example"))))[0]?.by === "peer"),
    "the reader did not adopt the letter").toBe(true);

    // THE DESKTOP LETS GO: its settings, saying what Cloud's say, carry where the gap began; its claim goes.
    const released = new Date();
    const payload = await serializeOrganizerProfile(db as never, mb.accountId, mb.mailboxId);
    const left = makeProfileDoc(payload, {
      updatedAt: released, producer: { kind: "local", version: "dev" },
      gap: { since: pressed.toISOString(), by: DESKTOP, at: released.toISOString() },
    });
    await meta.appendProfile(formatProfileMessage(left, { installId: DESKTOP }));
    const appendsBefore = meta.profileAppends;
    const claimsBefore = meta.appends;
    await meta.removeClaims(meta.messages.filter((m) => !m.raw.includes("X-Ohmail-Profile: 1")).map((m) => m.ref));
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).gapSince !== null),
      "the reader never noted the gap").toBe(true);
    const looked = await rowOf(db, mb.mailboxId);
    expect(looked.gapSince?.toISOString(), "the window opened at the look, not the press").toBe(pressed.toISOString());
    await new Promise((r) => setTimeout(r, 600));
    expect(meta.profileAppends, "a reader wrote settings").toBe(appendsBefore);
    expect(meta.appends, "a reader claimed").toBe(claimsBefore);
    expect((await rowOf(db, mb.mailboxId)).organizerRole).toBe("reader");

    // ORGANIZE HERE: the count, and nothing moved.
    await db.update(mailboxes).set({ takeoverAuthorizedAt: new Date(), takeoverIntent: "takeover" })
      .where(eq(mailboxes.id, mb.mailboxId));
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).gapLetters === 1),
      "the letter the hand-back let through was never offered").toBe(true);
    expect(fleet.movesFor(mb.mailboxId), "an offer moved mail").toEqual([]);
  }, 60_000);

  it("mail 0169: a cycle that took mail in keeps its claim's server stamp, and the stop starts the window and the key there", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedConsentedMailbox(db);
    const meta = fleet.metaFor(mb.mailboxId);
    // The server's clock, three seconds behind the worker's, in whole seconds as INTERNALDATE is.
    const stamps: number[] = [];
    meta.claimStamp = () => {
      const at = new Date(Math.floor((Date.now() - 3_000) / 1000) * 1000);
      stamps.push(at.getTime());
      return at;
    };
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test", rosterIntervalMs: 200,
      adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());
    expect(await waitFor(async () => meta.profileAppends >= 1), "premise: the organizer cycled").toBe(true);
    await new Promise((r) => setTimeout(r, 600));
    expect((await rowOf(db, mb.mailboxId)).organizedThrough, "a cycle that took no mail recorded a start").toBeNull();

    const organized = { from: "digest@feed.example", subject: "organized", messageId: `org-${randomUUID()}@feed.example`, internalDate: new Date() };
    fleet.behave(mb.mailboxId, { deliver: [organized] });
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizedThrough !== null),
      "the cycle that took the letter recorded nothing").toBe(true);
    const through = (await rowOf(db, mb.mailboxId)).organizedThrough!;
    expect(stamps, "the start is not a claim's server stamp").toContain(through.getTime());

    await db.update(mailboxes).set({ releaseRequestedAt: new Date() }).where(eq(mailboxes.id, mb.mailboxId));
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerReleasedAt !== null),
      "the release was never recorded").toBe(true);
    const released = await rowOf(db, mb.mailboxId);
    expect(released.gapSince?.getTime(), "the window did not start at the last finished cycle").toBe(through.getTime());
    expect(released.organizedThrough, "the release kept the tenure's start").toBeNull();
    const last = documents(meta.messages.map((m) => m.raw)).at(-1)!;
    expect(last.doc.gap?.since, "the key did not carry the last finished cycle").toBe(through.toISOString());

    // Two letters the reader takes in: one the server stamped after that cycle began, one before it.
    fleet.behave(mb.mailboxId, {
      deliver: [
        organized,
        { from: "digest@feed.example", subject: "inside", messageId: `in-${randomUUID()}@feed.example`, internalDate: new Date(through.getTime() + 1_000) },
        { from: "digest@feed.example", subject: "before", messageId: `out-${randomUUID()}@feed.example`, internalDate: new Date(through.getTime() - 2_000) },
      ],
    });
    expect(await waitFor(async () => (await db.select({ by: folderState.lastSetBy }).from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(eq(messages.mailboxId, mb.mailboxId), eq(folderState.lastSetBy, "peer")))).length === 2),
    "the reader did not adopt the letters").toBe(true);
    await db.update(mailboxes).set({ takeoverAuthorizedAt: new Date(), takeoverIntent: "takeover" })
      .where(eq(mailboxes.id, mb.mailboxId));
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).gapLetters !== null),
      "the window was never counted").toBe(true);
    expect((await rowOf(db, mb.mailboxId)).gapLetters, "the letter before the last finished cycle was counted, or the one after it not").toBe(1);
  }, 60_000);

  /** A reader whose window opened ten minutes ago, before the tenure it is about to find. */
  async function readerWithAnOldWindow(db: Db) {
    const mb = await seedConsentedMailbox(db);
    const opened = new Date(Date.now() - 10 * 60_000);
    await db.update(mailboxes).set({ organizerRole: "reader", gapSince: opened }).where(eq(mailboxes.id, mb.mailboxId));
    return { mb, opened };
  }

  const reader = (db: Db, fleet: FakeAdapterFleet) => startWorker({
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test", rosterIntervalMs: 200,
    adapterFactory: fleet.factory,
    organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
  });

  it("a stopped claim last renewed after the reader's window opened: the window moves to its last stamp", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const { mb } = await readerWithAnOldWindow(db);
    const heartbeat = new Date(Date.now() - 2 * 60_000);
    fleet.seedClaim(mb.mailboxId, formatClaim({
      authorizedAt: null, capabilities: ["profile"], installId: DESKTOP, kind: "local",
      displayName: "the laptop", heartbeat, claimedAt: new Date(Date.now() - 5 * 60_000), nonce: "n1",
    }));
    const worker = await reader(db, fleet);
    closers.push(() => worker.stop());
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerState === "stopped"),
      "premise: the reader saw the claim stopped").toBe(true);
    expect((await rowOf(db, mb.mailboxId)).gapSince?.toISOString(), "the window reached over the stopped tenure")
      .toBe(heartbeat.toISOString());
  }, 60_000);

  it("no key, settings another install wrote after the reader's window opened: the window moves to the look", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const { mb, opened } = await readerWithAnOldWindow(db);
    const payload = await serializeOrganizerProfile(db as never, mb.accountId, mb.mailboxId);
    const doc = makeProfileDoc(payload, { updatedAt: new Date(Date.now() - 5 * 60_000), producer: { kind: "local", version: "dev" } });
    await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(doc, { installId: DESKTOP }));
    const started = new Date();
    const worker = await reader(db, fleet);
    closers.push(() => worker.stop());
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).gapSince?.getTime() !== opened.getTime()),
      "the window reached over the other install's turn").toBe(true);
    expect((await rowOf(db, mb.mailboxId)).gapSince!.getTime()).toBeGreaterThanOrEqual(started.getTime() - 5);
    expect((await rowOf(db, mb.mailboxId)).organizerRole, "premise: still a reader").toBe("reader");
  }, 60_000);
});
