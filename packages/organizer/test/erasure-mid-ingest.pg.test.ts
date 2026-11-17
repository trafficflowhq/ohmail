import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, mailboxes, messages, MailboxErasedError } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { makeDrizzleRepo, type DrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * AN ERASURE RACING A PENDING INGEST — the new message's question rides the allocation, so the
 * stamp is read AFTER the `messages` INSERT rather than before it. Three things have to hold for
 * that to be the same guarantee, and a store with one serialized writer can measure none of them:
 * the fold must SEE an erasure that commits in the gap, HOLD the row against one arriving after
 * it, and not turn the insert's own foreign-key lock into a deadlock. `erased_at` is stamped
 * ALONE in every case, with `status` left `connected`: the real erasure disables the mailbox in
 * the same transaction and the removal fence would answer first.
 */
const PG_UP = await realPgAvailable();

describe.skipIf(!PG_UP)("an erasure racing a pending ingest", () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 120_000);

  afterAll(async () => { await sql.end({ timeout: 5 }); });

  async function seed(tag: string): Promise<{ accountId: string; mailboxId: string }> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `${tag}-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `${tag}-${accountId.slice(0, 8)}@ohmail.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

  /** The state that could have answered instead of the fence. Read, never assumed. */
  async function statusStillConnected(mailboxId: string): Promise<void> {
    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(mb!.status, "the removal fence could have answered this").toBe("connected");
  }

  const messageFor = (s: { accountId: string; mailboxId: string }) => ({ senderCheck: null,
    accountId: s.accountId, mailboxId: s.mailboxId,
    canonical: { messageIdHeader: `<${randomUUID()}@x.test>`, bodyHash: randomUUID() },
    dedupKey: randomUUID(), subject: "the roof", fromAddress: "them@x.test", date: new Date(),
    nativeLocator: { folder: "INBOX", ref: "1:1" },
    flags: { no_ai: false, no_forward: false, no_kb: false, priority: false },
  });

  it("THE CYCLE — an erasure between two of its commits takes everything after it", async () => {
    const { accountId, mailboxId } = await seed("emc");
    const real = makeDrizzleRepo(db as never);
    let erased = false;
    const erasing = new Proxy(real, {
      get(target, prop, recv) {
        const value = Reflect.get(target, prop, recv) as unknown;
        if (prop !== "transaction" || typeof value !== "function") return value;
        return async (fn: (r: DrizzleRepo) => Promise<unknown>): Promise<unknown> => {
          const out = await (value as (f: (r: DrizzleRepo) => Promise<unknown>) => Promise<unknown>)
            .call(target, fn);
          const n = (await db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).length;
          if (!erased && n === 1) {
            erased = true;
            // ANOTHER HOST'S REQUEST, on its own connection — not a statement of this pass.
            await sql`update mailboxes set erased_at = now() where id = ${mailboxId}`;
          }
          return out;
        };
      },
    }) as DrizzleRepo;

    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId, mailboxId, onConnectionError: () => { /* nothing dials here */ } },
    );
    fleet.behave(mailboxId, {
      deliver: Array.from({ length: 4 }, (_, i) => ({
        from: `s${i}@x.example`, subject: `msg ${i}`, messageId: `emc-${i}@x`,
      })),
    });
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE,
      repo: erasing, adapter, accountId, mailboxId,
      storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    }).catch((e: unknown) => e);

    expect(erased, "the erasure never landed — the case measures nothing").toBe(true);
    expect((await db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).length,
      "mail landed in a mailbox erased earlier in the same cycle").toBe(1);
    await statusStillConnected(mailboxId);
  }, 60_000);

  it("THE WINDOW — an erasure committing between the insert and the fold is still seen", async () => {
    /* The gap the hand-over opens, and why the fold's `share` is what closes it: a bare erasing
       UPDATE takes the row at `no key update`, which the INSERT's foreign key does NOT conflict
       with, so it commits in the middle of this transaction. The fold reads the row at `share`,
       which sees the latest committed value rather than this transaction's snapshot, and the
       refusal takes the message back out with it. */
    const { accountId, mailboxId } = await seed("emw");
    const repo = makeDrizzleRepo(db as never);
    const carrier = { mailboxId, answer: (): void => { /* status is not this case's question */ } };

    const refused = await repo.transaction(async (tx) => {
      await tx.insertMessage({ ...messageFor({ accountId, mailboxId }), mailboxMustBeLive: carrier });
      await sql`update mailboxes set erased_at = now() where id = ${mailboxId}`;
      await tx.recordChanges([{
        accountId, entityType: "message", entityId: randomUUID(), op: "create",
      }], carrier);
      return null;
    }).then(() => null, (e: unknown) => e);

    expect(refused, "the erasure landed mid-transaction and the commit went through")
      .toBeInstanceOf(MailboxErasedError);
    expect(await db.select().from(messages).where(eq(messages.mailboxId, mailboxId)),
      "the insert stayed behind — the refusal did not take its transaction with it").toHaveLength(0);
    await statusStillConnected(mailboxId);
  }, 60_000);

  it("THE OTHER ORDER — once the fold has read the row, the erasure waits for the commit", async () => {
    const { accountId, mailboxId } = await seed("emo");
    const repo = makeDrizzleRepo(db as never);
    const carrier = { mailboxId, answer: (): void => { /* nothing to decide */ } };
    const HELD_MS = 400;
    let blocked: unknown = "the erasure was not attempted";

    await repo.transaction(async (tx) => {
      await tx.insertMessage({ ...messageFor({ accountId, mailboxId }), mailboxMustBeLive: carrier });
      await tx.recordChanges([{
        accountId, entityType: "message", entityId: randomUUID(), op: "create",
      }], carrier);
      // The erasure's OWN first statement, with a bound of its own: the pool's would be a wait.
      blocked = await sql.begin(async (t) => {
        await t`set local lock_timeout = '300ms'`;
        await t`select id from mailboxes where id = ${mailboxId} for update`;
      }).then(() => null, (e: unknown) => e);
      await sleep(HELD_MS);
    });

    expect(blocked, "the erasure took the row while the fold was holding it").not.toBeNull();
    expect(String((blocked as Error).message)).toMatch(/lock timeout|canceling statement/i);
    expect(await db.select().from(messages).where(eq(messages.mailboxId, mailboxId)))
      .toHaveLength(1);
  }, 60_000);

  it("AND NOT A DEADLOCK — the erasure queued between the insert and the fold", async () => {
    /* The one thing the hand-over could have cost: the INSERT's foreign key takes the mailbox row
       at `key share`, so the fold's `share` is a STRENGTHENING while an erasure may already be
       queued for `for update` behind it. Measured rather than argued — a transaction that already
       holds the row is granted the stronger mode without joining the queue, so the erasure waits
       for the commit and neither is a 40P01 victim. */
    const { accountId, mailboxId } = await seed("emd");
    const repo = makeDrizzleRepo(db as never);
    const carrier = { mailboxId, answer: (): void => { /* nothing to decide */ } };

    const ingest = repo.transaction(async (tx) => {
      await tx.insertMessage({ ...messageFor({ accountId, mailboxId }), mailboxMustBeLive: carrier });
      await sleep(250);
      await tx.recordChanges([{
        accountId, entityType: "message", entityId: randomUUID(), op: "create",
      }], carrier);
    }).then(() => "committed", (e: unknown) => `${(e as { code?: string }).code ?? "?"}`);

    await sleep(80);
    const erasure = sql.begin(async (t) => {
      await t`set local lock_timeout = '5000ms'`;
      await t`select id from mailboxes where id = ${mailboxId} for update`;
      await t`update mailboxes set erased_at = now() where id = ${mailboxId}`;
    }).then(() => "committed", (e: unknown) => `${(e as { code?: string }).code ?? "?"}`);

    expect(await ingest, "the ingest was a deadlock victim (40P01) instead of committing")
      .toBe("committed");
    expect(await erasure, "the erasure was a deadlock victim instead of waiting").toBe("committed");
    expect(await db.select().from(messages).where(eq(messages.mailboxId, mailboxId)),
      "the ingest committed before the erasure took the row, which is the order it waited for")
      .toHaveLength(1);
  }, 60_000);
});
