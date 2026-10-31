import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { accounts, mailboxes, messages, folderState, flagState, changeLog, messageStates, threads } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { MessageService, TriageService, type ServiceContext } from "@trafficflow/services";
import { OPEN_READ_SHAPES, type OpenReadRow } from "../../client-engine/test/fixtures/open-read-shapes.js";

/**
 * THE OPEN READ ON REAL POSTGRES — the twin of `mark-seen-open-read.test.ts`. What PGlite cannot
 * show: the read and the stamp are two statements in ONE transaction and land as one instant through
 * postgres-js, and a second application of the same body (the replay a retry makes) stamps nothing.
 * Reads are scoped to each case's own account; its rows go in `afterEach`.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
const made: string[] = [];

const t0 = Date.UTC(2031, 0, 1, 0, 0, 0);
function ctx(accountId: string): ServiceContext {
  let n = 0;
  return { db: db as ServiceContext["db"], accountId, userId: null, now: () => new Date(t0 + (n += 1000)), requestId: "open-read" };
}

async function seed(rows: readonly OpenReadRow[]): Promise<{ accountId: string; ids: Map<string, string> }> {
  const accountId = randomUUID();
  made.push(accountId);
  await db.insert(accounts).values({ id: accountId, name: `open-read-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `open-read-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  const threadIds = new Map<string, string>();
  const ids = new Map<string, string>();
  for (const [i, r] of rows.entries()) {
    if (!threadIds.has(r.thread)) {
      const [t] = await db.insert(threads).values({ accountId, subject: r.thread }).returning();
      threadIds.set(r.thread, t!.id);
    }
    const id = randomUUID();
    await db.insert(messages).values({
      id, accountId, mailboxId: mb!.id, bodyHash: `b${i}`, dedupKey: `open-read:${randomUUID()}`,
      subject: r.label, fromAddress: `${r.label}@corp.test`, unread: r.unread, threadId: threadIds.get(r.thread)!,
      date: new Date(r.arrived), nativeLocator: { folder: "INBOX", ref: `1:${i}` },
    });
    await db.insert(folderState).values({
      messageId: id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    ids.set(r.label, id);
  }
  return { accountId, ids };
}

type Stamps = Map<string, { openReadAt: number | null; lastReadAt: number | null; updatedAt: number }>;
async function stamps(accountId: string, ids: Map<string, string>): Promise<Stamps> {
  const rows = await db.select({
    id: messages.id, openReadAt: messages.openReadAt, lastReadAt: messages.lastReadAt, updatedAt: messages.updatedAt,
  }).from(messages).where(eq(messages.accountId, accountId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return new Map([...ids].map(([l, id]) => {
    const r = byId.get(id)!;
    return [l, { openReadAt: r.openReadAt?.getTime() ?? null, lastReadAt: r.lastReadAt?.getTime() ?? null, updatedAt: r.updatedAt.getTime() }];
  }));
}

describe.skipIf(!PG_UP)("the open read, on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterEach(async () => {
    for (const accountId of made.splice(0)) {
      const owned = db.select({ id: messages.id }).from(messages).where(eq(messages.accountId, accountId));
      await db.delete(changeLog).where(eq(changeLog.accountId, accountId));
      await db.delete(messageStates).where(inArray(messageStates.messageId, owned));
      await db.delete(flagState).where(inArray(flagState.messageId, owned));
      await db.delete(folderState).where(inArray(folderState.messageId, owned));
      await db.delete(messages).where(eq(messages.accountId, accountId));
      await db.delete(threads).where(eq(threads.accountId, accountId));
      await db.delete(mailboxes).where(eq(mailboxes.accountId, accountId));
      await db.delete(accounts).where(eq(accounts.id, accountId));
    }
  });
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  /**
   * THE READ AND A PARK FROM ANOTHER DEVICE, INTERLEAVED. markSeen's first select sees the row
   * unparked; a rival park commits before the stamp runs. The stamp's own UPDATE must see the park
   * (a NOT EXISTS in its WHERE), or a parked row carries an open read and Done files it at that slot.
   */
  async function waitForLockWait(deadlineMs = 10_000): Promise<boolean> {
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) {
      const [row] = await client<Array<{ n: number }>>`
        select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock' and state = 'active'
           and query ilike 'update "messages"%'`;
      if ((row?.n ?? 0) > 0) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }
  const ONE = [{ label: "f", thread: "F", arrived: "2026-07-24T00:15:00.000Z", unread: true }];
  const stampOf = async (accountId: string, ids: Map<string, string>) => (await stamps(accountId, ids)).get("f")!.openReadAt;

  it("RACE: a park that commits between the read's select and its stamp leaves the row unstamped", async () => {
    const { accountId, ids } = await seed(ONE);
    const id = ids.get("f")!;
    const rival = await client.reserve();
    let blocked = false;
    try {
      await rival`begin`;
      // The rival holds the message row, so markSeen's flip waits after its select has run.
      await rival`update messages set updated_at = now() where id = ${id}::uuid`;
      const read = new MessageService().markSeen(ctx(accountId), { ids: [id], unread: false, openRead: true });
      blocked = await waitForLockWait();
      // The park, as setState writes it: the pile row and the clear, committed while the read waits.
      await rival`insert into message_states (account_id, message_id, state, set_at, updated_at)
                  values (${accountId}::uuid, ${id}::uuid, 'reply_later', now(), now())`;
      await rival`update messages set open_read_at = null where id = ${id}::uuid`;
      await rival`commit`;
      await read;
    } finally {
      rival.release();
    }
    expect(blocked, "the read never waited on the rival: the interleaving was not driven").toBe(true);
    // MUTATION WATCHED: drop the NOT EXISTS from the stamp's WHERE and the parked row is stamped.
    expect(await stampOf(accountId, ids), "a parked row took the open read").toBeNull();
    // Above `waitForLockWait`'s 10 s, so an interleaving that never blocks fails on `blocked`.
  }, 30_000);

  it("RACE, the other order: the park commits first, then the read — unstamped, and the read lands", async () => {
    const { accountId, ids } = await seed(ONE);
    const id = ids.get("f")!;
    await new TriageService().setState(ctx(accountId), id, { state: "reply_later" });
    await new MessageService().markSeen(ctx(accountId), { ids: [id], unread: false, openRead: true });
    const [row] = await db.select({ unread: messages.unread }).from(messages).where(eq(messages.id, id));
    expect(row!.unread).toBe(false);
    expect(await stampOf(accountId, ids)).toBeNull();
  });

  it("CONTROL: the same read with no park stamps the row", async () => {
    const { accountId, ids } = await seed(ONE);
    await new MessageService().markSeen(ctx(accountId), { ids: [ids.get("f")!], unread: false, openRead: true });
    expect(await stampOf(accountId, ids)).toEqual(expect.any(Number));
  });

  it("Park, then Undo with the press-time open read: the stamp comes back through postgres-js, last_read_at unchanged", async () => {
    const { accountId, ids } = await seed(ONE);
    const id = ids.get("f")!;
    const c = ctx(accountId);
    await new MessageService().markSeen(c, { ids: [id], unread: false, openRead: true });
    const before = (await stamps(accountId, ids)).get("f")!;
    expect(before.openReadAt, "the premise: stamped").toEqual(expect.any(Number));
    const triage = new TriageService();
    await triage.setState(c, id, { state: "set_aside" });
    expect(await stampOf(accountId, ids)).toBeNull();
    await triage.setState(c, id, { state: "none", restoreOpenReadAt: new Date(before.openReadAt!).toISOString() });
    const after = (await stamps(accountId, ids)).get("f")!;
    expect(after.openReadAt).toBe(before.openReadAt);
    expect(after.lastReadAt).toBe(before.lastReadAt);
  });

  for (const shape of OPEN_READ_SHAPES) {
    it(`server parity: ${shape.name}`, async () => {
      const { accountId, ids } = await seed(shape.rows);
      const svc = new MessageService();
      const c = ctx(accountId);
      for (const r of shape.rows.filter((x) => x.openReadAt !== undefined)) {
        await svc.markSeen(c, { ids: [ids.get(r.label)!], unread: true });
        await svc.markSeen(c, { ids: [ids.get(r.label)!], unread: false, openRead: true });
      }
      const before = await stamps(accountId, ids);
      const body = { ids: shape.ids.map((l) => ids.get(l)!), unread: shape.unread, ...(shape.serverFlag ? { openRead: true } : {}) };
      await svc.markSeen(c, body);
      const after = await stamps(accountId, ids);
      const stamped = [...after].filter(([l, s]) => s.openReadAt !== null && s.openReadAt !== before.get(l)!.openReadAt).map(([l]) => l).sort();
      const cleared = [...after].filter(([l, s]) => before.get(l)!.openReadAt !== null && s.openReadAt === null).map(([l]) => l).sort();
      expect(stamped).toEqual([...shape.stamped].sort());
      expect(cleared).toEqual([...shape.cleared].sort());
      // One event: the stamp, the reading and the row's clock are the same instant.
      for (const l of shape.stamped) {
        expect(after.get(l)!.openReadAt).toBe(after.get(l)!.lastReadAt);
        expect(after.get(l)!.openReadAt).toBe(after.get(l)!.updatedAt);
      }
      // A second application of the same body stamps nothing new.
      await svc.markSeen(c, body);
      const again = await stamps(accountId, ids);
      for (const l of shape.stamped) expect(again.get(l)!.openReadAt, `${l} restamped`).toBe(after.get(l)!.openReadAt);
    });
  }
});
