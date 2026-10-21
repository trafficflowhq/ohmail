import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, mailboxes, messages } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { MailboxService } from "../src/mailbox-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * HOW MANY MESSAGES ARE IN EACH MAILBOX, and the two things that number may not cost.
 *
 * Settings → Mailboxes could say everything about a mailbox except the one thing its owner
 * asked for: how much mail is in it. The row carries a status, a sync stamp, a block reason and
 * a filing backlog, and no count at all.
 *
 * ── WHY THE COUNT IS OPT-IN AND NOT SIMPLY ADDED TO THE DTO ─────────────────────────────
 *
 * `GET /mailboxes` is not a settings-only route. `MailStateProvider` polls it every 30 s in
 * every open Cloud tab to derive the shell's status strip, and this pane polls it every 10 s
 * while it is on screen. A count added unconditionally is therefore an aggregate over the
 * account's whole `messages` table, twice a minute, per tab, forever — for a number those
 * pollers do not read. So the aggregate runs only when the caller asks (`?counts=1`), and the
 * default path must be able to SHOW that it ran nothing, which is the second half of this file.
 *
 * ── WHY `.pg.test.ts` ───────────────────────────────────────────────────────────────────
 *
 * Two reasons, and the first is CLAUDE.md's rule about PGlite. The account-isolation case
 * below turns on a `GROUP BY` over a real planner and a real `count(*)`, and the statement
 * census turns on what the postgres-js driver actually SENDS — neither is a property of the
 * TypeScript. The second is that the index premise is a Postgres fact:
 * `messages_account_mailbox_unread_idx` is `(account_id, mailbox_id, unread)`, so its leading
 * column serves `WHERE account_id = $1` and the grouping key is the second. Measured on this
 * database with tens of thousands of rows across four mailboxes:
 *
 *   HashAggregate  (actual time=… rows=3)
 *     Group Key: mailbox_id
 *     ->  Bitmap Heap Scan on messages  (rows=60000)
 *           ->  Bitmap Index Scan on messages_account_mailbox_unread_idx
 *                 Index Cond: (account_id = …)
 *
 * The plan itself is deliberately NOT asserted here: on the handful of rows a test seeds the
 * planner will correctly choose a sequential scan, so an assertion on the plan would be a
 * statement about the fixture's size rather than about the query.
 */

const AVAILABLE = await realPgAvailable();

/** Every statement the driver actually sent, in order. See the census tests at the bottom. */
const sent: string[] = [];
/** The count's own shape: grouped over `messages` alone. The list's batched facts group too, over joins. */
const COUNTS_SHAPE = /\bfrom "messages" where\b[\s\S]*\bgroup by\b/i;

describe.skipIf(!AVAILABLE)("per-mailbox message counts", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sqlc: ReturnType<typeof postgres>;
  const service = new MailboxService();

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sqlc = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    /* THE CENSUS IS TAKEN AT THE DRIVER, not at the service. A test that asserted "the service
       did not call the counts helper" would be asserting its own knowledge of the
       implementation; this asserts the only thing that costs anything, which is what went down
       the wire. `logQuery` is drizzle's own hook and fires once per statement. */
    db = brandDialect(drizzle(sqlc, { schema, logger: { logQuery: (q) => { sent.push(q); } } }), "pg");
  }, 60_000);

  afterAll(async () => { await sqlc?.end({ timeout: 5 }); });

  beforeEach(() => { sent.length = 0; });

  const ctxFor = (accountId: string): ServiceContext =>
    ({ db, accountId, userId: null, now: () => new Date(), requestId: "r" });

  /** An account with `n` mailboxes; returns its id and its mailbox ids in `list` order. */
  async function seedAccount(label: string, addresses: string[]): Promise<{ id: string; mailboxIds: string[] }> {
    const [a] = await db.insert(accounts).values({ name: `${label}-${randomUUID().slice(0, 8)}` }).returning();
    const ids: string[] = [];
    for (const address of addresses) {
      const [mb] = await db.insert(mailboxes).values({
        accountId: a!.id, provider: "imap", address: `${address}-${randomUUID().slice(0, 8)}@example.test`,
      }).returning();
      ids.push(mb!.id);
    }
    return { id: a!.id, mailboxIds: ids };
  }

  /** `n` messages stamped with `accountId`, in `mailboxId`. The two are passed separately on purpose. */
  async function seedMessages(accountId: string, mailboxId: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await db.insert(messages).values({
        accountId, mailboxId,
        dedupKey: `m5:${randomUUID()}`,
        bodyHash: `m5-${randomUUID().slice(0, 8)}`,
        subject: `s${i}`,
        fromAddress: "sender@example.test",
      });
    }
  }

  const countOf = (dtos: Array<{ id: string; messageCount?: number }>, id: string): number | undefined =>
    dtos.find((d) => d.id === id)?.messageCount;

  it("counts each mailbox separately, and an empty mailbox reports 0 rather than nothing", async () => {
    const acct = await seedAccount("m5-a", ["busy", "quiet", "empty"]);
    await seedMessages(acct.id, acct.mailboxIds[0]!, 7);
    await seedMessages(acct.id, acct.mailboxIds[1]!, 2);

    const dtos = await service.list(ctxFor(acct.id), { counts: true });

    expect(countOf(dtos, acct.mailboxIds[0]!)).toBe(7);
    expect(countOf(dtos, acct.mailboxIds[1]!)).toBe(2);
    /* A mailbox with no mail produces NO GROUP ROW, so the map has no entry for it and the
       naive `map.get(id)` is `undefined` — which renders as an absent field, i.e. as "we did
       not ask", about a mailbox we did ask about. 0 is the answer and it has to be written. */
    expect(countOf(dtos, acct.mailboxIds[2]!), "an empty mailbox must say 0, not say nothing").toBe(0);
  });

  it("the DEFAULT list carries no count at all — an absent field, never a zero", async () => {
    const acct = await seedAccount("m5-b", ["one"]);
    await seedMessages(acct.id, acct.mailboxIds[0]!, 3);

    const [dto] = await service.list(ctxFor(acct.id));

    /* Not `toBeUndefined()`: the field must be ABSENT, because `0` and "not asked" are
       different answers and a client reading `typeof === "number"` has to be able to tell
       them apart. `JSON.stringify` drops an explicitly-undefined property too, so this is the
       assertion that would still fail if the DTO carried the key with an undefined value. */
    expect(Object.prototype.hasOwnProperty.call(dto!, "messageCount")).toBe(false);
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════
     INVARIANT #9 — ACCOUNT ISOLATION, ENFORCED BY THE STATEMENT AND NOT BY THE CALLER
     ══════════════════════════════════════════════════════════════════════════════════════ */

  it("THE DISAGREEING ROW CANNOT BE WRITTEN any more, and the counts stay this account's", async () => {
    /*
     * This case used to seed a row with THEIR `account_id` and OUR `mailbox_id` — the one shape
     * where dropping `WHERE account_id = $1` from the grouped query changes an answer. Mail 0116
     * gave `messages` a composite key to `mailboxes (id, account_id)`, so that row is refused at
     * the door and the mutation it existed to catch has nothing left to act on. The predicate
     * stays in the statement and this asserts what now enforces it, plus the counts themselves.
     */
    const ours = await seedAccount("m5-ours", ["mine"]);
    const theirs = await seedAccount("m5-theirs", ["yours"]);

    await seedMessages(ours.id, ours.mailboxIds[0]!, 4);
    await seedMessages(theirs.id, theirs.mailboxIds[0]!, 9);

    let code: string | null = null;
    try { await seedMessages(theirs.id, ours.mailboxIds[0]!, 1); }
    catch (err) { code = String((err as { code?: unknown }).code ?? "unknown"); }
    expect(code, "their account on our mailbox is no longer representable").toBe("23503");

    const dtos = await service.list(ctxFor(ours.id), { counts: true });
    expect(countOf(dtos, ours.mailboxIds[0]!)).toBe(4);
    // …and nothing of theirs appears as a row of ours either.
    expect(dtos.map((d) => d.id)).toEqual(ours.mailboxIds);
  });

  it("the account predicate is IN the grouped statement, not applied after it", async () => {
    const acct = await seedAccount("m5-c", ["one"]);
    await seedMessages(acct.id, acct.mailboxIds[0]!, 1);
    sent.length = 0;

    await service.list(ctxFor(acct.id), { counts: true });

    const grouped = sent.filter((q) => COUNTS_SHAPE.test(q));
    expect(grouped).toHaveLength(1);
    // Every statement that groups, the count and the list's facts, filters by the account.
    for (const q of sent.filter((x) => /\bgroup by\b/i.test(x))) expect(q).toMatch(/\baccount_id"? = \$\d+/);
    /* Both halves of the ruling, read off the statement itself: it groups by the mailbox and it
       filters by the account, and neither is a second round trip. */
    expect(grouped[0]!.toLowerCase()).toContain("account_id");
    expect(grouped[0]!.toLowerCase()).toContain("group by");
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════
     THE POLLED ROUTE PAYS NOTHING — the census, taken at the driver
     ══════════════════════════════════════════════════════════════════════════════════════ */

  it("the countless default runs ZERO message counts, and counts=1 adds exactly ONE statement", async () => {
    const acct = await seedAccount("m5-d", ["a", "b", "c"]);
    await seedMessages(acct.id, acct.mailboxIds[0]!, 2);
    await seedMessages(acct.id, acct.mailboxIds[1]!, 3);

    sent.length = 0;
    await service.list(ctxFor(acct.id));
    const bare = [...sent];

    sent.length = 0;
    await service.list(ctxFor(acct.id), { counts: true });
    const counted = [...sent];

    /**
     * THE COUNT'S OWN SHAPE IS THE DISCRIMINATOR, and it is chosen rather than `count(`.
     *
     * The default path counts too: the set-aside and filing facts are aggregates on it by
     * design, and since they are read for all mailboxes at once they GROUP as well, over joins
     * with `mailboxes`. So what is counted is the shape only the message count has: a grouped
     * statement over `messages` alone. And the one statement `counts=1` adds must be that one.
     */
    expect(
      bare.filter((q) => COUNTS_SHAPE.test(q)),
      "the 30-second poll paid for an aggregate nobody reads",
    ).toEqual([]);
    expect(counted.filter((q) => COUNTS_SHAPE.test(q))).toHaveLength(1);
    const added = counted.filter((q) => !bare.includes(q));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(COUNTS_SHAPE);

    /* ONE query for the whole account, not one per mailbox: three mailboxes, one extra
       statement. This is the assertion that fails if the counts variant is ever rewritten as a
       per-row lookup inside `toDTO`. */
    expect(
      counted.length - bare.length,
      "the counts variant must cost exactly one extra round trip regardless of mailbox count",
    ).toBe(1);
  });

  it("the count is the mailbox's whole mail, unread or not", async () => {
    /* The index this rides on is `(account_id, mailbox_id, unread)` and its third column is a
       tempting filter. The request was "how many mails", not "how many unread", and the row
       already carries no unread figure — so the aggregate counts rows and reads no flag. */
    const acct = await seedAccount("m5-e", ["mixed"]);
    await seedMessages(acct.id, acct.mailboxIds[0]!, 3);
    await db.update(messages).set({ unread: false })
      .where(eq(messages.mailboxId, acct.mailboxIds[0]!));
    await seedMessages(acct.id, acct.mailboxIds[0]!, 2);

    expect(countOf(await service.list(ctxFor(acct.id), { counts: true }), acct.mailboxIds[0]!)).toBe(5);
  });

  it("a deleted message is not counted — the count is what the person owns", async () => {
    /* A tombstone stays in `messages` for the expunge reaper; History leaves it out and so does
       this count. Seeded 3 living + 2 deleted in one mailbox, 1 deleted alone in another. */
    const acct = await seedAccount("m5-g", ["mixed", "gone"]);
    await seedMessages(acct.id, acct.mailboxIds[0]!, 2);
    await db.update(messages).set({ deletedAt: new Date() })
      .where(eq(messages.mailboxId, acct.mailboxIds[0]!));
    await seedMessages(acct.id, acct.mailboxIds[0]!, 3);
    await seedMessages(acct.id, acct.mailboxIds[1]!, 1);
    await db.update(messages).set({ deletedAt: new Date() })
      .where(eq(messages.mailboxId, acct.mailboxIds[1]!));

    const dtos = await service.list(ctxFor(acct.id), { counts: true });
    expect(countOf(dtos, acct.mailboxIds[0]!), "a deleted message was counted").toBe(3);
    expect(countOf(dtos, acct.mailboxIds[1]!), "a mailbox holding only deleted mail says 0").toBe(0);
  });

  it("the count is an integer on the wire, not a driver's bigint string", async () => {
    /* `count(*)` is `bigint`, which postgres-js returns as a STRING. A DTO field that is
       sometimes `"7"` and sometimes `7` is a client-side bug waiting on a mailbox big enough
       to notice; the cast is what stops it, and PGlite would not have shown this. */
    const acct = await seedAccount("m5-f", ["one"]);
    await seedMessages(acct.id, acct.mailboxIds[0]!, 2);
    const [dto] = await service.list(ctxFor(acct.id), { counts: true });
    expect(typeof dto!.messageCount).toBe("number");
    expect(dto!.messageCount).toBe(2);
  });
});
