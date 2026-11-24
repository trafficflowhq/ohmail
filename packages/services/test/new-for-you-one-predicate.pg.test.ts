import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { accounts, mailboxes, messages, folderState, messageStates } from "@trafficflow/db";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "../../../apps/worker/test/_isolateddb.js";
import { MessageService, TriageService, type ServiceContext } from "@trafficflow/services";

/**
 * THE "NEW FOR YOU" PREDICATE ON REAL POSTGRES — the twin the moved read owes.
 *
 * `newForYouFilters` is the one definition both the screen's list and Power Through call, and its
 * state arm is a CORRELATED `NOT EXISTS` over `message_states`. PGlite green says nothing about
 * that: it is a different engine behind the same client surface, and this repository has paid for
 * the assumption twice — a raw `sql` fragment PGlite binds happily that postgres-js refuses, and a
 * flattened array in a template. The subquery is built with `inArray`, not a template, so the
 * array trap does not apply; the correlation itself is what is asserted here.
 *
 * Narrow on purpose: the behaviour is measured in the PGlite twin over nine seeded states. This
 * asks the one question only a real server can answer — does the correlated subquery resolve the
 * outer `messages.id`, or does it filter everything / nothing?
 *
 * A PRIVATE DATABASE, never the shared `trafficflow_test`: the shared box's migration watermark
 * belongs to the release chain, and a co-tenant's rows in `message_states` are exactly the
 * poisoning that produces a product-looking red here.
 */
const DB_NAME = "trafficflow_new_for_you";

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;
/** The private database's URL, as `prepareIsolatedDb` handed it back — never reconstructed. */
let dbUrl: string;

const msgs = new MessageService();
const triage = new TriageService();

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => new Date("2026-08-02T12:00:00.000Z"),
  requestId: `nfy-pg-${randomUUID().slice(0, 8)}`,
});

/** One account, one mailbox, and N unread INBOX messages — the group before anything is said. */
async function world(n: number): Promise<{ accountId: string; ids: string[] }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `nfy-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `nfy-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `nfy:${randomUUID()}`,
      subject: `Message ${i}`, fromAddress: `sender-${i}@example.test`, unread: true,
      date: new Date(`2026-08-0${(i % 8) + 1}${"T"}09:00:00Z`),
      nativeLocator: { folder: "INBOX", ref: `1:${i}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    ids.push(m!.id);
  }
  return { accountId, ids };
}

describe("the New-for-you predicate on real Postgres", () => {
  beforeAll(async () => {
    dbUrl = await prepareIsolatedDb(DB_NAME);
    client = postgres(dbUrl, { max: 2 });
    db = brandDialect(drizzle(client), "pg");
  }, ISOLATED_DB_RESET_BUDGET_MS);
  afterAll(async () => { await client?.end({ timeout: 5 }); });
  /* Each case starts from an empty database: nothing else uses `DB_NAME`, and one case's
     `message_states` row in the next case's read is the co-tenancy this file exists to avoid. */
  beforeEach(async () => { await truncateAll(dbUrl); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("the correlated NOT EXISTS excludes the parked row and only that row", async () => {
    const w = await world(3);
    const [parked, plainA, plainB] = w.ids as [string, string, string];
    await db.insert(messageStates).values({
      accountId: w.accountId, messageId: parked, state: "reply_later",
    });

    const c = ctx(w.accountId);
    const page = await msgs.list(c, { view: "new_for_you", limit: 50 });
    const seen = page.items.map((m) => m.id).sort();

    // THE THREE ANSWERS A BROKEN CORRELATION GIVES, each refused by name: everything (the
    // subquery matched nothing), nothing (it matched every row), or the parked row present.
    expect(seen, "the subquery filtered every row — the correlation did not resolve")
      .not.toHaveLength(0);
    expect(seen, "the subquery filtered no row — the parked message is still in the group")
      .toEqual([plainA, plainB].sort());
    expect(seen).not.toContain(parked);

    // And the act reads the same set through the same import, on the same server.
    const walked: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const view = await triage.powerThrough(c, cursor ? { cursor } : {});
      if (!view.current) break;
      walked.push(view.current.id);
      if (!view.nextCursor) break;
      cursor = view.nextCursor;
    }
    expect(walked.sort()).toEqual(seen);
    expect((await triage.powerThrough(c, {})).remaining).toBe(2);
  });

  it("another account's states do not reach into this one's group", async () => {
    // The subquery is scoped by account as well as by message. A row keyed on the message alone
    // would be correct here only because ids are unique — so the case is the OTHER direction:
    // this account's own parked row must still be excluded while a stranger's is irrelevant.
    const mine = await world(2);
    const theirs = await world(1);
    await db.insert(messageStates).values({
      accountId: mine.accountId, messageId: mine.ids[0]!, state: "set_aside",
    });
    await db.insert(messageStates).values({
      accountId: theirs.accountId, messageId: theirs.ids[0]!, state: "set_aside",
    });

    const page = await msgs.list(ctx(mine.accountId), { view: "new_for_you", limit: 50 });
    expect(page.items.map((m) => m.id)).toEqual([mine.ids[1]!]);
  });
});
