/* @postpush: alone — this file observes the deployment-wide legacy cursor before and after the acts it drives.
 * The post-push driver runs it by itself so any write to that row belongs to these cases. */
import { accountOfMessage } from "@trafficflow/db";
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { learningSignals,
  accounts, mailboxes, messages, messageBodies, folderState, rules,
  unsubscribeDrainState, unsubscribeExamined, unsubscribeRecords,
  readDrainCursor, writeDrainCursor, UNSUB_DRAIN_PASS,
} from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  dbFor, makeUnsubscribeService, UNSUB_DRAIN_SCAN_PAGE,
  type HostResolver, type OneClickPost,
} from "@trafficflow/services";

/**
 * PostgreSQL still enforces the legacy cursor pair and the foreign key linking a mark and its record.
 * Confirmed requests can settle their own records and do not use the old deployment-wide cursor.
 */
const PG_UP = await realPgAvailable();

let owned: OwnedDb | undefined;
let db: OwnedDb["db"];

const PUBLIC_DNS: HostResolver = { async resolve() { return ["93.184.216.34"]; } };
/**
 * The position a Gmail-held mailbox trusts (`providerAuthservIds`). The eligible rows carry that
 * provider's confirmation of their sender: the drain asks a list only for a confirmed sender.
 */
const GMAIL: ReadonlySet<string> = new Set(["mx.google.com"]);

function spy(): OneClickPost & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async post(url: string) { calls.push(url); return { status: 200 }; } };
}

const svcWith = (post: OneClickPost) =>
  makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => GMAIL });

const NOW = new Date("2026-07-28T12:00:00Z");
/** Inside the drain's window, oldest first, one second apart. */
const at = (i: number): Date => new Date(NOW.getTime() - 3_600_000 + i * 1000);

const ONE_CLICK = {
  "list-unsubscribe": ["<https://sender.example/u?t=abc>"],
  "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
  "authentication-results": ["mx.google.com; dmarc=pass"],
};

interface World { accountId: string; mailboxId: string }

/** The fixture tears down only the accounts and data it created. */
const made: World[] = [];

async function newWorld(): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `uc-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `uc-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  const w = { accountId, mailboxId: mb!.id };
  made.push(w);
  // A person screened `sender.example` out — the licence every row this file seeds acts under.
  await db.insert(rules).values({
    accountId, kind: "domain", match: "sender.example", destination: "ohmail/Screened",
    provenance: "promoted", personDecidedAt: NOW,
  });
  await db.insert(learningSignals).values({
    accountId, triggeringActionId: `screener:${randomUUID()}`, kind: "screener",
    senderDomain: "sender.example", destination: "ohmail/Screened", label: "positive",
  });
  return w;
}

async function tearDown(): Promise<void> {
  for (const w of made.splice(0)) {
    const own = db.select({ id: messages.id }).from(messages).where(eq(messages.mailboxId, w.mailboxId));
    await db.delete(unsubscribeExamined).where(inArray(unsubscribeExamined.messageId, own));
    await db.delete(unsubscribeRecords).where(eq(unsubscribeRecords.mailboxId, w.mailboxId));
    await db.delete(messageBodies).where(inArray(messageBodies.messageId, own));
    await db.delete(folderState).where(inArray(folderState.messageId, own));
    await db.delete(messages).where(eq(messages.mailboxId, w.mailboxId));
    await db.delete(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    await db.delete(rules).where(eq(rules.accountId, w.accountId));
    await db.delete(accounts).where(eq(accounts.id, w.accountId));
  }
}

/** N screened-out rows at consecutive positions; only those given headers are eligible. */
async function seedWindow(
  w: World, n: number, withHeaders: (i: number) => Record<string, string[]> | null,
): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; from < n; from += 500) {
    const batch = Array.from({ length: Math.min(500, n - from) }, (_, k) => {
      const i = from + k;
      return {
        id: randomUUID(), accountId: w.accountId, mailboxId: w.mailboxId,
        bodyHash: `h${i}`, dedupKey: `uc:${randomUUID()}`, subject: `N ${i}`,
        fromAddress: `news-${i}-${randomUUID().slice(0, 8)}@sender.example`,
        nativeLocator: { folder: "ohmail/Screened", ref: `1:${i}` },
      };
    });
    await db.insert(messages).values(batch);
    await db.insert(folderState).values(batch.map((m, k) => ({
      messageId: m.id, accountId: accountOfMessage(m.id), desiredFolder: "ohmail/Screened", observedFolder: "ohmail/Screened",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false, updatedAt: at(from + k),
    })));
    const bodies = batch.flatMap((m, k) => {
      const h = withHeaders(from + k);
      return h === null ? [] : [{ messageId: m.id, accountId: accountOfMessage(m.id), text: "", headers: h }];
    });
    if (bodies.length > 0) await db.insert(messageBodies).values(bodies);
    ids.push(...batch.map((m) => m.id));
  }
  return ids;
}

const stateRow = async () => (await db.select().from(unsubscribeDrainState)
  .where(eq(unsubscribeDrainState.pass, UNSUB_DRAIN_PASS)))[0];

describe.skipIf(!PG_UP)("the drain's cursor and its mark, on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // The factory's handle: the drain binds each account it acts for, and the binder takes a server
    // handle only from the factory that registered its door.
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db;
  }, 180_000);
  afterAll(async () => { await tearDown(); await owned?.close(); });
  beforeEach(async () => { await tearDown(); });
  afterEach(async () => { await tearDown(); });

  it("refuses half a cursor — the pair is whole or it is absent", async () => {
    const tx = db as never;
    const probe = `ck-probe-${randomUUID()}`;
    try {
      // Both absent: the position every store starts from.
      await writeDrainCursor(tx, probe, null, NOW);
      expect(await readDrainCursor(tx, probe)).toBeNull();
      // Both present: a position, and it survives the timestamptz round trip exactly.
      const id = randomUUID();
      await writeDrainCursor(tx, probe, { at: at(7), messageId: id }, NOW);
      expect(await readDrainCursor(tx, probe)).toEqual({ messageId: id, at: at(7) });
      // One of the two: refused by the database, not by the program.
      await expect(db.execute(sql`
        update "unsubscribe_drain_state" set "cursor_message_id" = null where "pass" = ${probe}
      `)).rejects.toThrow(/unsubscribe_drain_state_cursor_pair/);
    } finally {
      await db.delete(unsubscribeDrainState).where(eq(unsubscribeDrainState.pass, probe));
    }
  });

  it("a mark cannot outlive the record it was judged against", async () => {
    const w = await newWorld();
    const [id] = await seedWindow(w, 1, () => ONE_CLICK);
    const post = spy();
    const ctx = { db: dbFor(db as never, w.accountId), accountId: w.accountId, userId: null, now: () => NOW, requestId: "fk" };
    expect(await svcWith(post).onScreenOut(ctx, [id!])).toMatchObject({ posted: 1 });
    expect(post.calls).toHaveLength(1);
    const [record] = await db.select().from(unsubscribeRecords)
      .where(eq(unsubscribeRecords.accountId, w.accountId));
    const marks = await db.select().from(unsubscribeExamined)
      .where(eq(unsubscribeExamined.accountId, w.accountId));
    expect(marks.map((m) => [m.messageId, m.recordId])).toEqual([[id, record!.id]]);

    // THE REASON BOTH ERASURE SWEEPS DELETE THE CHILD FIRST. Without that line this is what the
    // sweep meets — a refusal, not a silent orphan.
    await expect(db.delete(unsubscribeRecords).where(eq(unsubscribeRecords.id, record!.id)))
      .rejects.toThrow(/unsubscribe_examined/);
  });

  it("a stored pass at a mailbox no provider entry names is posted for and kept", async () => {
    // The sender's own signature, checked at ingest: the request re-reads nothing that could
    // confirm it at this mailbox, so it keeps the stored pass rather than overwrite it.
    const w = await newWorld();
    const [id] = await seedWindow(w, 1, () => ({
      "list-unsubscribe": ["<https://sender.example/u?t=signed>"],
      "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
    }));
    await db.update(messages).set({ authVerdict: "pass" }).where(eq(messages.id, id!));
    const post = spy();
    const svc = makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => new Set<string>() });
    const ctx = { db: dbFor(db as never, w.accountId), accountId: w.accountId, userId: null, now: () => NOW, requestId: "signed" };
    expect(await svc.onScreenOut(ctx, [id!])).toMatchObject({ considered: 1, posted: 1, skipped: 0 });
    expect(post.calls).toEqual(["https://sender.example/u?t=signed"]);
    const [row] = await db.select({ v: messages.authVerdict }).from(messages).where(eq(messages.id, id!));
    expect(row!.v).toBe("pass");
  });

  it("a full retired window cannot hide a later confirmation or move the stored cursor", async () => {
    const before = await stateRow();
    const w = await newWorld();
    const count = UNSUB_DRAIN_SCAN_PAGE + 1;
    const ids = await seedWindow(w, count, (i) => i === count - 1 ? ONE_CLICK : null);
    const target = ids.at(-1)!;
    const post = spy();
    const svc = svcWith(post);

    const noReads = new Proxy(db, { get() { throw new Error("a scheduled poll touched the database"); } });
    const tick = () => svc.drainScreenedOut(noReads as never, {
      now: () => NOW, requestId: "poll", accounts: 1, perAccount: 1,
    });
    const empty = { accounts: 0, sweep: { considered: 0, posted: 0, skipped: 0, failed: 0, remaining: 0 }, remaining: 0, elapsedMs: 0 };
    expect(await tick()).toEqual(empty);
    expect(post.calls).toEqual([]);
    expect(await stateRow()).toEqual(before);

    const ctx = { db: dbFor(db as never, w.accountId), accountId: w.accountId, userId: null, now: () => NOW, requestId: "confirmed" };
    expect(await svc.onScreenOut(ctx, [target])).toEqual({ considered: 1, posted: 1, skipped: 0, failed: 0, remaining: 0 });
    expect(post.calls).toEqual([ONE_CLICK["list-unsubscribe"][0]!.slice(1, -1)]);
    const records = await db.select({ messageId: unsubscribeRecords.messageId, state: unsubscribeRecords.state })
      .from(unsubscribeRecords).where(eq(unsubscribeRecords.accountId, w.accountId));
    expect(records).toEqual([{ messageId: target, state: "sent" }]);

    expect(await tick()).toEqual(empty);
    expect(post.calls).toHaveLength(1);
    expect(await stateRow()).toEqual(before);
  }, 180_000);

  it("a failed second delivery leaves the first settled and writes no cursor", async () => {
    const before = await stateRow();
    const w = await newWorld();
    const [first, second] = await seedWindow(w, 2, (i) => ({ ...ONE_CLICK, "list-id": [`<list-${i}.sender.example>`] }));
    let attempted = 0;
    const svc = svcWith({
      async post() {
        attempted += 1;
        if (attempted === 2) throw new Error("the second delivery died");
        return { status: 200 };
      },
    });
    const ctx = { db: dbFor(db as never, w.accountId), accountId: w.accountId, userId: null, now: () => NOW, requestId: "confirmed" };
    expect(await svc.onScreenOut(ctx, [first!, second!])).toEqual({ considered: 2, posted: 1, skipped: 0, failed: 1, remaining: 0 });
    const records = await db.select({ messageId: unsubscribeRecords.messageId, state: unsubscribeRecords.state })
      .from(unsubscribeRecords).where(eq(unsubscribeRecords.accountId, w.accountId));
    expect(records.sort((a, b) => a.state.localeCompare(b.state))).toEqual([
      { messageId: second, state: "failed" },
      { messageId: first, state: "sent" },
    ]);
    const tick = await svc.drainScreenedOut(db as never, { now: () => NOW, requestId: "poll" });
    expect(tick.sweep.posted).toBe(0);
    expect(attempted).toBe(2);
    expect(await stateRow()).toEqual(before);
  }, 180_000);
});
