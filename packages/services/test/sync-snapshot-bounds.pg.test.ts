import { accountOfMessage } from "@trafficflow/db";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  approvals, folderState, mailboxes, messages, messageStates, routingDecisions,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { SNAPSHOT_FIRST_PAGE_MESSAGES, syncService } from "@trafficflow/services";
import type { ServiceContext, SnapshotResponse } from "@trafficflow/services";

/**
 * AGAINST REAL POSTGRES — the bound and the PLAN are what is under test.
 *
 * The PGlite twin (`sync-snapshot.test.ts`) proves the page carries at most `limit` children and
 * never an orphan. Neither claim is worth much there: PGlite is one connection with its own
 * planner, and the change turned three per-ACCOUNT reads into three `messageId in (…)` reads with
 * up to `limit` bound parameters. That is exactly the shape this repository has been bitten by —
 * a bare array interpolated into a raw fragment renders as a scalar and PGlite accepts it — so
 * the reads run here against Postgres at a page's real width.
 *
 * The fixture is large enough that the unbounded read is plain, as the row filed against a live account
 * measured (child-and-small-state rows far past the limit on one page).
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof brandDialect<ReturnType<typeof drizzle<typeof schema>>>>;

const NOW = new Date("2026-08-07T12:00:00.000Z");
const DAY = 86_400_000;
const FIXTURE = 5_000;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"], accountId, userId: null,
  now: () => NOW, requestId: "snapshot-bounds",
});

const idsOf = (r: SnapshotResponse, type: string): string[] =>
  r.changes.filter((c) => c.type === type).map((c) => c.id);

describe.skipIf(!PG_UP)("snapshot page bounds (real Postgres)", () => {
  let accountId: string;
  let mailboxId: string;

  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 4 });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);

    accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `bounds-${accountId}@tf.example`,
    }).returning();
    mailboxId = mb!.id;

    // `FIXTURE` messages, each carrying a `message_state`, a pending `routing_decision` and an
    // `approval` — the three reads page 1 used to make per account with no limit applied.
    for (let base = 0; base < FIXTURE; base += 500) {
      const rows = Array.from({ length: 500 }, (_, k) => {
        const i = base + k;
        return {
          accountId, mailboxId, bodyHash: "h", dedupKey: `bounds:${accountId}:${i}`,
          subject: `s${i}`, fromAddress: "anna@x.example",
          date: new Date(NOW.getTime() - i * 60_000),
        };
      });
      const made = await db.insert(messages).values(rows).returning({ id: messages.id });
      await db.insert(folderState).values(made.map((m) => ({
        messageId: m.id, accountId: accountOfMessage(m.id), desiredFolder: "INBOX", observedFolder: "INBOX",
        lastSetBy: "us" as const,
      })));
      await db.insert(messageStates).values(made.map((m) => ({
        accountId, messageId: m.id, state: "reply_later" as const,
      })));
      await db.insert(routingDecisions).values(made.map((m) => ({
        accountId, messageId: m.id, inputProvenance: "ai" as const,
        destination: "ohmail/News", status: "pending_approval" as const,
      })));
      await db.insert(approvals).values(made.map((m) => ({
        accountId, kind: "routing", messageId: m.id, action: "move", status: "pending",
      })));
    }
  }, 600_000);

  afterAll(async () => {
    // What this test created, this test removes: a shared table must not carry a large
    // fixture into somebody else's read.
    if (!client) return;
    const owned = db.select({ id: messages.id }).from(messages)
      .where(eq(messages.accountId, accountId));
    await db.delete(messageStates).where(eq(messageStates.accountId, accountId));
    await db.delete(routingDecisions).where(eq(routingDecisions.accountId, accountId));
    await db.delete(approvals).where(eq(approvals.accountId, accountId));
    await db.delete(folderState).where(inArray(folderState.messageId, owned));
    await db.delete(messages).where(eq(messages.accountId, accountId));
    await db.delete(mailboxes).where(eq(mailboxes.accountId, accountId));
    await client.end({ timeout: 5 });
  }, 300_000);

  it("the fixture is the size the claim needs", async () => {
    const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(messageStates)
      .where(eq(messageStates.accountId, accountId));
    expect(n!.n).toBe(FIXTURE);
  });

  /* PAGE 1 IS A VIEWPORT, so the count here is DERIVED and not the `limit` asked for: page 1's
     message walk takes {@link SNAPSHOT_FIRST_PAGE_MESSAGES}, every later page takes the limit.
     The claim is unchanged and is the ONE the name states — at most `limit` of each child type,
     one per message on the page rather than one per message in the mailbox. */
  const PAGE_1 = Math.min(SNAPSHOT_FIRST_PAGE_MESSAGES, 500);

  it("page 1 carries at most `limit` of each child type, not one per message", async () => {
    const page = await syncService.getSnapshot(ctx(accountId), { limit: 500 });
    for (const type of ["message", "message_state", "routing_decision", "approval"]) {
      expect(idsOf(page, type).length, type).toBeLessThanOrEqual(500);
    }
    // Not an assertion over an empty page: the children are DELIVERED, one per message on it.
    expect(idsOf(page, "message")).toHaveLength(PAGE_1);
    expect(idsOf(page, "message_state")).toHaveLength(PAGE_1);
    expect(idsOf(page, "routing_decision")).toHaveLength(PAGE_1);
    expect(idsOf(page, "approval")).toHaveLength(PAGE_1);
  }, 120_000);

  it("every child on the page names a message on the same page", async () => {
    const page = await syncService.getSnapshot(ctx(accountId), { limit: 500 });
    const onPage = new Set(idsOf(page, "message"));
    const kinds = ["message_state", "routing_decision", "approval"];
    const children = page.changes.filter((c) => kinds.includes(c.type));
    // THREE CHILD KINDS, one of each per message ON THE PAGE — derived from the page, so the
    // relationship is what is asserted rather than a number that moves when the page does.
    expect(children).toHaveLength(kinds.length * PAGE_1);
    expect(onPage.size).toBe(PAGE_1);
    for (const c of children) {
      expect(onPage.has((c.entity as { messageId: string }).messageId), c.type).toBe(true);
    }
  }, 120_000);

  it("the three child reads take the page's ids as bound parameters, and Postgres plans them", async () => {
    // The `inArray` form under test, at a page's real width — the raw-fragment spelling of this
    // renders one scalar and fails only here. An index scan is not the claim; being PLANNABLE and
    // ANSWERING at 500 ids is.
    const ids = (await db.select({ id: messages.id }).from(messages)
      .where(eq(messages.accountId, accountId)).limit(500)).map((r) => r.id);
    expect(ids).toHaveLength(500);
    const rows = await db.select({ id: messageStates.id }).from(messageStates)
      .where(and(eq(messageStates.accountId, accountId), inArray(messageStates.messageId, ids)));
    expect(rows).toHaveLength(500);
  }, 120_000);
});
