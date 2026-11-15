import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { mailboxes, messages, folderState, messageStates, changeLog, recordChange } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { messageService, syncService } from "@trafficflow/services";
import type { MessageDTO, ServiceContext } from "@trafficflow/services";
import { pgTestUrl } from "@trafficflow/db/testing";

/**
 * READ ORDER, END TO END, ON REAL POSTGRES.
 *
 * The claim: a read-state write stamps `messages.last_read_at`, and that stamp reaches the client
 * through EVERY route a message row travels — the write's own answer, the `/sync` delta the
 * change row produces, and the bootstrap snapshot. If any one of them dropped the field, the
 * client's "Earlier" order would be right on a freshly-loaded tab and wrong after a delta, or the
 * other way round, which is the kind of defect nobody reproduces on demand.
 *
 * ── WHY THIS IS A REAL-POSTGRES TEST AND NOT A PGlite ONE ───────────────────────────────────
 *
 * **A PGlite green would mean nothing here, and that is stated rather than assumed.** Two of the
 * three things under test are properties of the DATABASE and not of the TypeScript: that the
 * column exists at all after the migration journal is replayed against a real server, and that a
 * `timestamptz` written inside a transaction comes back as the same instant through drizzle's
 * postgres-js path. PGlite has been blind to three production defects in exactly this area, so a
 * projection asserted only against it is asserted against a simulator of the thing that matters.
 * The batch path additionally writes N rows in ONE transaction and reads them back afterwards,
 * which is a real transactional boundary.
 *
 * MUTATION-WATCHED: drop `lastReadAt` from `messageRowToDTO` in `services/src/dto/materialize.ts`
 * and every assertion below goes red; drop the stamp from either writer in `message-service.ts`
 * and the ones naming that writer go red.
 */
const URL = pgTestUrl(import.meta.url);
const client = postgres(URL, { max: 5 });
const db = brandDialect(drizzle(client, { schema }), "pg");

const NOW = new Date("2026-08-07T12:00:00.000Z");
const LATER = new Date("2026-08-07T12:05:00.000Z");
const ACCOUNT = randomUUID();
let mailboxId = "";

function ctx(now: Date = NOW): ServiceContext {
  return { db, accountId: ACCOUNT, userId: null, now: () => now, requestId: "read-order" };
}

/** A message that has arrived and never been read — `last_read_at` NULL, as ingest leaves it. */
async function freshMessage(tag: string): Promise<string> {
  return db.transaction(async (tx) => {
    const [m] = await tx.insert(messages).values({
      accountId: ACCOUNT, mailboxId, bodyHash: "h", dedupKey: `read-order:${tag}:${randomUUID()}`,
      subject: `subject ${tag}`, fromAddress: "anna@example.com",
      date: new Date("2026-08-01T09:00:00.000Z"),
      nativeLocator: { folder: "INBOX", ref: `1:${tag}` },
    }).returning();
    await tx.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
    });
    await recordChange(tx, {
      accountId: ACCOUNT, entityType: "message", entityId: m!.id, op: "create", meta: null,
    });
    return m!.id;
  });
}

const columnOf = async (id: string): Promise<Date | null> => {
  const [row] = await db.select({ lastReadAt: messages.lastReadAt }).from(messages)
    .where(and(eq(messages.id, id), eq(messages.accountId, ACCOUNT)));
  return row?.lastReadAt ?? null;
};

describe("read order reaches the client on every route (real Postgres)", () => {
  beforeAll(async () => {
    await runMigrations(URL);
    const [mb] = await db.insert(mailboxes).values({
      accountId: ACCOUNT, provider: "imap", address: `read-order-${ACCOUNT}@tf.example`,
    }).returning();
    mailboxId = mb!.id;
  }, 120_000);

  afterAll(async () => { await client.end({ timeout: 5 }); });

  it("ingest leaves it NULL — arriving is not reading", async () => {
    const id = await freshMessage("ingest");
    expect(await columnOf(id)).toBeNull();
    const dto = await messageService.get(ctx(), id);
    expect(dto.lastReadAt).toBeNull();
  });

  it("the single PATCH stamps it, and the DTO it answers with carries the stamp", async () => {
    const id = await freshMessage("patch");
    const { dto } = await messageService.patch(ctx(), id, { unread: false });
    expect(dto.unread).toBe(false);
    expect(dto.lastReadAt).toBe(NOW.toISOString());
    // …and it is genuinely in the column, not only in the projection's imagination.
    expect(await columnOf(id)).toEqual(NOW);
  });

  it("marking UNREAD again clears it — there is no reading left to be ordered by", async () => {
    const id = await freshMessage("unread");
    await messageService.patch(ctx(), id, { unread: false });
    const { dto } = await messageService.patch(ctx(LATER), id, { unread: true });
    expect(dto.unread).toBe(true);
    expect(dto.lastReadAt).toBeNull();
    expect(await columnOf(id)).toBeNull();
  });

  it("a re-read RESTAMPS — the order follows the LATEST reading, not the first", async () => {
    const id = await freshMessage("restamp");
    await messageService.patch(ctx(), id, { unread: false });
    await messageService.patch(ctx(LATER), id, { unread: true });
    const { dto } = await messageService.patch(ctx(LATER), id, { unread: false });
    expect(dto.lastReadAt).toBe(LATER.toISOString());
  });

  it("the BATCH markSeen stamps every member with ONE instant, in one transaction", async () => {
    // A selection marked read in a single gesture is one reading event. Read the clock per row
    // inside the loop and the members spread themselves across the order by however long the
    // transaction took — a set the user treated as one thing arriving as N.
    const ids = [await freshMessage("bulk1"), await freshMessage("bulk2"), await freshMessage("bulk3")];
    const { items } = await messageService.markSeen(ctx(), { ids, unread: false });
    expect(items).toHaveLength(3);
    expect(items.map((m) => m.lastReadAt)).toEqual([
      NOW.toISOString(), NOW.toISOString(), NOW.toISOString(),
    ]);
    for (const id of ids) expect(await columnOf(id)).toEqual(NOW);
  });

  it("the batch UNREAD direction clears every member", async () => {
    const ids = [await freshMessage("bulkoff1"), await freshMessage("bulkoff2")];
    await messageService.markSeen(ctx(), { ids, unread: false });
    const { items } = await messageService.markSeen(ctx(LATER), { ids, unread: true });
    expect(items.map((m) => m.lastReadAt)).toEqual([null, null]);
  });

  it("THE DELTA FEED CARRIES IT — the change row a markSeen produces materialises the stamp", async () => {
    // The route that matters most and the one a projection change can silently break: every
    // other tab and every other device learns about this read through `/sync`, so a delta that
    // dropped the field would leave two clients sorting "Earlier" differently from each other.
    const before = await syncService.getChanges(ctx(), { since: "0", limit: 1000 });
    const since = before.cursor;

    const id = await freshMessage("delta");
    await messageService.markSeen(ctx(), { ids: [id], unread: false });

    const page = await syncService.getChanges(ctx(), { since, limit: 1000 });
    const rows = [...page.changes.creates, ...page.changes.updates]
      .filter((c) => c.id === id)
      .map((c) => c.entity as MessageDTO);
    expect(rows.length).toBeGreaterThan(0);
    // The LAST change for this id is the read — the create came first and carried NULL.
    expect(rows[rows.length - 1]!.lastReadAt).toBe(NOW.toISOString());
    expect(rows[rows.length - 1]!.unread).toBe(false);
  });

  it("THE SNAPSHOT CARRIES IT — a cold client sorts Earlier correctly on its first paint", async () => {
    const id = await freshMessage("snapshot");
    await messageService.markSeen(ctx(LATER), { ids: [id], unread: false });

    const snap = await syncService.getSnapshot(ctx(), { limit: 1000 });
    const row = snap.changes
      .filter((c) => c.type === "message")
      .map((c) => c.entity as MessageDTO)
      .find((m) => m.id === id);
    expect(row).toBeTruthy();
    expect(row!.lastReadAt).toBe(LATER.toISOString());
  });

  it("reading a RESURFACED row clears it to `none` and emits a message_state update; marking unread leaves it", async () => {
    // The worker flips a due `bubbled_up` state to `resurfaced` (bubbleUpPass), pinning the row at
    // the top of the Ohbox. Reading it — a plain markSeen(read) — spends the resurface, in the same
    // transaction, so "Resurfaced" cannot outlive the read that answered it. A reply reaches this
    // same path when it marks the parent read, which is how a settled reply closes a resurface too.
    const readId = await freshMessage("resurf-read");
    const [st] = await db.insert(messageStates)
      .values({ accountId: ACCOUNT, messageId: readId, state: "resurfaced" }).returning();
    await messageService.markSeen(ctx(), { ids: [readId], unread: false });
    const [afterRead] = await db.select().from(messageStates).where(eq(messageStates.id, st!.id));
    expect(afterRead!.state).toBe("none");
    const emitted = await db.select().from(changeLog).where(and(
      eq(changeLog.accountId, ACCOUNT), eq(changeLog.entityType, "message_state"), eq(changeLog.entityId, st!.id),
    ));
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.every((c) => c.op === "update")).toBe(true);

    // Putting a message BACK to unread is not answering the resurface — triage is untouched.
    const keepId = await freshMessage("resurf-keep");
    const [st2] = await db.insert(messageStates)
      .values({ accountId: ACCOUNT, messageId: keepId, state: "resurfaced" }).returning();
    await messageService.markSeen(ctx(), { ids: [keepId], unread: true });
    const [afterUnread] = await db.select().from(messageStates).where(eq(messageStates.id, st2!.id));
    expect(afterUnread!.state).toBe("resurfaced");
  });
});
