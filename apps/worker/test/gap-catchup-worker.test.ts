import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { accounts, folderState, mailboxCredentials, mailboxes, messages, rules } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage, profileFingerprint,
} from "@trafficflow/core/adapters/organizer-profile";
import { applyOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { carryDialect } from "@trafficflow/db/dialect";
import { startWorker } from "../src/index.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * LETTERS FROM A GAP, ON THE HOSTED WORKER (review HIGH-1). The reader's peek opens
 * the window when the desktop's claim goes and a look at a live claim closes it; a letter arrives
 * and the reader adopts it at the inbox (`'peer'`); a press promotes the worker, whose cycle tail
 * COUNTS the letter and moves nothing; the person's File press files it, once.
 */

type Db = ReturnType<typeof makeDb>;
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
let DB = "";
const closers: Array<() => Promise<void>> = [];

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
  await db.insert(accounts).values({ id: accountId, name: "gap" });
  const [row] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`,
    organizerRole: "organizer", organizeConsentedAt: new Date(Date.now() - 60 * 60 * 1000),
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

const rowOf = async (db: Db, mailboxId: string) =>
  (await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)))[0]!;

describe("the hosted worker rules the mail that arrived while nothing organized", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_gap_catchup"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("notes the gap, adopts the letter as a reader, and files it once promoted", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedConsentedMailbox(db);
    fleet.seedClaim(mb.mailboxId, formatClaim({
      authorizedAt: null, capabilities: [], installId: "a-desktop-install", kind: "local",
      displayName: "the laptop", heartbeat: new Date(), claimedAt: new Date(), nonce: "n1",
    }));
    await db.insert(rules).values({
      accountId: mb.accountId, kind: "domain", match: "feed.example", destination: "ohmail/News", priority: 5,
      createdAt: new Date(Date.now() - 60 * 60 * 1000), updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      // The press is written while the worker runs, so the roster must re-read the row promptly.
      rosterIntervalMs: 200,
      adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerState === "held"),
      "the premise is a reader beside a live desktop").toBe(true);
    expect((await rowOf(db, mb.mailboxId)).gapSince, "a look at a LIVE holder noted a gap").toBeNull();

    // THE DESKTOP LETS GO: the reader's next look opens the window.
    const meta = fleet.metaFor(mb.mailboxId);
    await meta.removeClaims(meta.messages.map((m) => m.ref));
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).gapSince !== null),
      "the reader never noted the gap").toBe(true);
    // IT COMES BACK: a look at its live claim CLOSES the window — a held look is evidence.
    fleet.seedClaim(mb.mailboxId, formatClaim({
      authorizedAt: null, capabilities: [], installId: "a-desktop-install", kind: "local",
      displayName: "the laptop", heartbeat: new Date(), claimedAt: new Date(), nonce: "n2",
    }));
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).gapSince === null),
      "a held look left the window open").toBe(true);
    await meta.removeClaims(meta.messages.map((m) => m.ref));
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).gapSince !== null),
      "the next gap was not noted").toBe(true);

    // A LETTER ARRIVES WHILE NOTHING ORGANIZES, and the reader adopts it at the inbox.
    fleet.behave(mb.mailboxId, {
      deliver: [{ from: "digest@feed.example", subject: "a newsletter", messageId: `gap-${randomUUID()}@feed.example`, internalDate: new Date() }],
    });
    const adopted = async () => (await db.select({ by: folderState.lastSetBy, d: folderState.desiredFolder })
      .from(folderState).innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(eq(messages.mailboxId, mb.mailboxId), eq(messages.fromAddress, "digest@feed.example"))))[0];
    expect(await waitFor(async () => (await adopted())?.by === "peer"), "the reader did not adopt the letter").toBe(true);
    expect(fleet.movesFor(mb.mailboxId), "a reader filed mail").toEqual([]);

    // THE PRESS: Cloud is asked to organize, and the gate promotes it.
    await db.update(mailboxes).set({ takeoverAuthorizedAt: new Date(), takeoverIntent: "takeover" })
      .where(eq(mailboxes.id, mb.mailboxId));
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerRole === "organizer"),
      "the press did not promote the worker").toBe(true);

    // THE PROMOTION COUNTS AND MOVES NOTHING: the person is asked first.
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).gapLetters === 1),
      "the gap letter was never offered").toBe(true);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(fleet.movesFor(mb.mailboxId), "a promotion moved mail unasked").toEqual([]);

    // THE PERSON'S FILE PRESS, for the count shown.
    await db.update(mailboxes).set({ gapPressedAt: new Date() }).where(eq(mailboxes.id, mb.mailboxId));
    expect(await waitFor(async () => fleet.movesFor(mb.mailboxId).includes("ohmail/News")),
      "the gap letter was never filed").toBe(true);
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).gapSince === null),
      "the window stayed open after its mail was filed").toBe(true);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(fleet.movesFor(mb.mailboxId), "the letter was filed more than once").toEqual(["ohmail/News"]);
  }, 60_000);

  it("the cross-install case: promoted with the desktop's settings unanswered and no rules, it waits; the import offers the letter", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedConsentedMailbox(db);
    fleet.seedClaim(mb.mailboxId, formatClaim({
      authorizedAt: null, capabilities: ["profile"], installId: "a-desktop-install", kind: "local",
      displayName: "the laptop", heartbeat: new Date(), claimedAt: new Date(), nonce: "n1",
    }));
    // THE DESKTOP'S SETTINGS, its News rule an hour old; Cloud has no rules of its own.
    const written = makeProfileDoc({
      screener: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null,
      rules: [{
        kind: "domain", match: "feed.example", destination: "ohmail/News", priority: 5, enabled: true,
        provenance: "manual", updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }],
    }, { updatedAt: new Date(Date.now() - 60 * 60 * 1000), producer: { kind: "local", version: "dev" } });
    await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(written, { installId: "a-desktop-install" }));
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test", rosterIntervalMs: 200,
      adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerState === "held"),
      "the premise is a reader beside a live desktop").toBe(true);

    // THE DESKTOP LETS GO; a letter arrives while nothing organizes, adopted at the inbox.
    const meta = fleet.metaFor(mb.mailboxId);
    // The claim only: the folder keeps the desktop's settings.
    await meta.removeClaims(meta.messages.filter((m) => !m.raw.includes("X-Ohmail-Profile: 1")).map((m) => m.ref));
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).gapSince !== null),
      "the reader never noted the gap").toBe(true);
    fleet.behave(mb.mailboxId, {
      deliver: [{ from: "digest@feed.example", subject: "a newsletter", messageId: `gap-${randomUUID()}@feed.example`, internalDate: new Date() }],
    });
    expect(await waitFor(async () => (await db.select({ by: folderState.lastSetBy }).from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(eq(messages.mailboxId, mb.mailboxId), eq(messages.fromAddress, "digest@feed.example"))))[0]?.by === "peer"),
    "the reader did not adopt the letter").toBe(true);

    // THE PRESS: Cloud organizes next with the desktop's settings unanswered.
    await db.update(mailboxes).set({ takeoverAuthorizedAt: new Date(), takeoverIntent: "takeover" })
      .where(eq(mailboxes.id, mb.mailboxId));
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerRole === "organizer"),
      "the press did not promote the worker").toBe(true);
    await new Promise((r) => setTimeout(r, 1_500));
    const waiting = await rowOf(db, mb.mailboxId);
    expect(waiting.gapSince, "the open import question closed the window").not.toBeNull();
    expect(waiting.gapLetters, "the gap was counted by rules about to change").toBeNull();

    // THE IMPORT, recorded as the person's answer.
    const parsed = parseProfileMessage(formatProfileMessage(written, { installId: "a-desktop-install" }));
    if (parsed === null || isMalformedProfile(parsed) || !parsed.doc) throw new Error("expected a readable copy");
    const doc = parsed.doc;
    await db.transaction((tx) => applyOrganizerProfile(carryDialect(db, tx) as never, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, doc, fingerprint: profileFingerprint(doc), now: new Date(),
    }));
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).gapLetters === 1),
      "the imported rule's letter was never offered").toBe(true);
    expect(fleet.movesFor(mb.mailboxId), "an offer moved mail").toEqual([]);
    await db.update(mailboxes).set({ gapPressedAt: new Date() }).where(eq(mailboxes.id, mb.mailboxId));
    expect(await waitFor(async () => fleet.movesFor(mb.mailboxId).includes("ohmail/News")),
      "the gap letter was never filed").toBe(true);
  }, 60_000);
});
