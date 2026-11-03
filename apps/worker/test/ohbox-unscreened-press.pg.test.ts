import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, contacts, folderState, mailboxes, messageBodies, messages, rules,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { planChange } from "@trafficflow/core/mail";
import { organizeDecisionCount, screenUnscreened, unscreenedSummary } from "@trafficflow/services/mail";
import { ScreenerService, type Db, type ServiceContext } from "@trafficflow/services";

/**
 * THE PRESS HANDS THE MAIL TO THE ORGANIZER — and to nothing else.
 *
 * The service writes an INTENT and stops: `folder_state` desired `ohmail/Screener`, observed
 * untouched, so `reconcile_status` derives `pending`. What that is worth is one sentence — the
 * organizer's own filing queue picks the rows up, which is the same queue every other placement in
 * the product goes through, and no second mover opens a connection to somebody's mailbox.
 *
 * `.pg.test.ts` because the queue is `listPendingFolderStates`' own statement over real columns,
 * and because the press's page is taken `FOR UPDATE OF folder_state` — a no-op that always
 * succeeds under a single-connection engine.
 */

const AVAILABLE = await realPgAvailable();
const OHBOX = "INBOX";
const GATE = "ohmail/Screener";
const NOW = new Date("2026-09-22T09:00:00.000Z");
// Inside the default window; OLD is outside it.
const ARRIVED = new Date("2026-09-17T08:00:00.000Z");
const OLD = new Date("2024-03-01T08:00:00.000Z");

let sql: ReturnType<typeof postgres>;
let db: Db;

interface World { accountId: string; mailboxId: string }

const ctxOf = (w: World): ServiceContext => ({
  db: db as never, accountId: w.accountId, userId: null,
  now: () => NOW, requestId: `oup-${randomUUID().slice(0, 8)}`,
});

async function newWorld(): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `oup-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `oup-${accountId.slice(0, 8)}@example.test`,
    organizerRole: "organizer",
  }).returning();
  return { accountId, mailboxId: mb!.id };
}

let n = 0;

async function seedOhbox(w: World, from: string, arrivedAt = ARRIVED): Promise<string> {
  const i = n++;
  const [m] = await db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `h${i}`,
    dedupKey: `oup:${randomUUID()}`, subject: `Note ${i}`, fromAddress: from,
    date: arrivedAt, createdAt: arrivedAt, arrivedAt, unread: false,
    nativeLocator: { folder: OHBOX, ref: `1:${i}` },
  }).returning();
  await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: OHBOX, observedFolder: OHBOX,
    lastSetBy: "external", reconcileStatus: "reconciled", conflict: false,
  });
  return m!.id;
}

/** A letter a pass or an old release placed in News, nobody's decision. */
async function seedNews(w: World, from: string, arrivedAt: Date | null): Promise<string> {
  const i = n++;
  const [m] = await db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `h${i}`,
    dedupKey: `oup:${randomUUID()}`, subject: `Letter ${i}`, fromAddress: from,
    date: arrivedAt ?? OLD, createdAt: arrivedAt ?? OLD, arrivedAt, unread: true,
    nativeLocator: { folder: NEWS, ref: `2:${i}` },
  }).returning();
  await db.insert(messageBodies).values({
    messageId: m!.id, text: "", html: null, headers: { "list-unsubscribe": ["<https://x.test/u>"] },
  });
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: NEWS, observedFolder: NEWS,
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  return m!.id;
}

const NEWS = "ohmail/News";

describe.skipIf(!AVAILABLE)("the pressed mail joins the organizer's filing queue", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Db;
  }, 120_000);
  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  it("the press queues exactly the offered messages, and nothing else", async () => {
    const w = await newWorld();
    await db.insert(contacts).values({ accountId: w.accountId, address: "pal@x.test" });
    const stranger = await seedOhbox(w, "stranger@x.test");
    const second = await seedOhbox(w, "stranger@x.test");
    const contact = await seedOhbox(w, "pal@x.test");
    const old = await seedOhbox(w, "stranger@x.test", OLD);

    const repo = makeDrizzleRepo(db as never);
    // NOTHING IS OWED BEFORE THE PRESS — the read moved no row, which is the Ohbox's own rule.
    expect(await unscreenedSummary(db as never, w.accountId, NOW)).toMatchObject({ total: 2 });
    expect(await repo.listPendingFolderStates(w.mailboxId)).toEqual([]);

    await screenUnscreened(ctxOf(w));

    const owed = await repo.listPendingFolderStates(w.mailboxId);
    expect(owed.map((r) => r.messageId).sort()).toEqual([stranger, second].sort());
    for (const row of owed) {
      // What the reconciler reads: move it FROM where it is TO the gate, on our own intent.
      expect(row.desiredFolder).toBe(GATE);
      expect(row.observedFolder).toBe(OHBOX);
      expect(row.lastSetBy).toBe("us");
      expect(row.nativeLocator).toMatchObject({ folder: OHBOX });
    }
    for (const id of [contact, old]) {
      const [still] = await db.select({ d: folderState.desiredFolder })
        .from(folderState).where(eq(folderState.messageId, id));
      expect(still!.d).toBe(OHBOX);
    }
  });

  it("a letter gone from the server is not offered, pressed or counted; its live twin is", async () => {
    const w = await newWorld();
    const live = await seedOhbox(w, "stranger@x.test");
    const gone = await seedOhbox(w, "stranger@x.test");
    const missing = await seedOhbox(w, "stranger@x.test");
    await db.update(messages).set({ arrivedAt: ARRIVED }).where(eq(messages.accountId, w.accountId));
    await db.update(messages).set({ deletedAt: NOW }).where(eq(messages.id, gone));
    await db.update(messages).set({ serverMissingAt: NOW }).where(eq(messages.id, missing));

    expect(await unscreenedSummary(db as never, w.accountId, NOW)).toMatchObject({ total: 1 });
    expect(await organizeDecisionCount(ctxOf(w), w.mailboxId, { scope: "all_time" })).toMatchObject({ letters: 1, total: 1 });
    await screenUnscreened(ctxOf(w));
    const owed = await makeDrizzleRepo(db as never).listPendingFolderStates(w.mailboxId);
    expect(owed.map((r) => r.messageId)).toEqual([live]);
  });

  it("a second press adds nothing to the queue — the first one emptied the set", async () => {
    const w = await newWorld();
    await seedOhbox(w, "stranger@x.test");
    await screenUnscreened(ctxOf(w));
    const repo = makeDrizzleRepo(db as never);
    const after = await repo.listPendingFolderStates(w.mailboxId);
    expect(after).toHaveLength(1);

    await screenUnscreened(ctxOf(w));
    expect(await repo.listPendingFolderStates(w.mailboxId)).toHaveLength(1);
  });

  /* THE NOTE ON NEWS (owner report 2026-11-02): letters there from a sender nobody let in. Its
     press queues them for the gate like the Ohbox's, the Screener asks about the sender, the press
     wrote nothing that lets them in, so their next letter is held at the arrival, and a second
     press finds nothing. */
  it("the News note's press queues the stranger's letters for the gate, the Screener asks, and the next letter is held", async () => {
    const w = await newWorld();
    await db.insert(contacts).values({ accountId: w.accountId, address: "pal@x.test" });
    const fresh = await seedNews(w, "stranger@x.test", ARRIVED);
    const undated = await seedNews(w, "stranger@x.test", null);
    const pal = await seedNews(w, "pal@x.test", ARRIVED);
    const door = await seedOhbox(w, "door@x.test");
    const repo = makeDrizzleRepo(db as never);
    expect(await unscreenedSummary(db as never, w.accountId, NOW, "news")).toMatchObject({ total: 2 });
    expect(await repo.listPendingFolderStates(w.mailboxId), "the note's read moved a letter").toEqual([]);

    expect(await screenUnscreened(ctxOf(w), { pile: "news" })).toMatchObject({ total: 2 });

    const owed = await repo.listPendingFolderStates(w.mailboxId);
    expect(owed.map((r) => r.messageId).sort()).toEqual([fresh, undated].sort());
    for (const row of owed) {
      expect(row.desiredFolder).toBe(GATE);
      expect(row.observedFolder).toBe(NEWS);
      expect(row.lastSetBy).toBe("us");
      expect(row.nativeLocator).toMatchObject({ folder: NEWS });
    }
    for (const [id, at] of [[pal, NEWS], [door, OHBOX]] as const) {
      const [still] = await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id));
      expect(still!.d).toBe(at);
    }

    const waiting = await new ScreenerService({}).list(ctxOf(w));
    expect(waiting.items.map((i) => i.sender.address), "GET /screener does not ask about the sender").toEqual(["stranger@x.test"]);

    expect(await db.select().from(rules).where(eq(rules.accountId, w.accountId)), "the press wrote a rule").toEqual([]);
    const raw = Buffer.from([
      "Message-ID: <next@x.test>", "From: stranger@x.test", `To: oup@example.test`, "Subject: Again",
      "List-Unsubscribe: <https://x.test/u>", "Content-Type: text/plain; charset=utf-8", "", "Hello again.",
    ].join("\r\n"));
    const next = await planChange({ type: "create", locator: { folder: OHBOX, ref: "1:900" }, raw }, {
      repo, accountId: w.accountId, mailboxId: w.mailboxId, readerMode: false,
    });
    expect(next.new?.desired, "their next letter was let in").toBe(GATE);

    expect(await screenUnscreened(ctxOf(w), { pile: "news" })).toEqual({ screened: [], total: 0 });
    expect(await repo.listPendingFolderStates(w.mailboxId)).toHaveLength(2);
  });
});
