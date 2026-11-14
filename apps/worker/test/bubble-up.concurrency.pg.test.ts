import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq } from "drizzle-orm";
import { changeLog, mailboxes, mailboxCredentials, messages, messageStates, type Tx } from "@trafficflow/db";
import { schema, makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { runWorkerSupervised } from "../src/supervisor.js";
import { bubbleUpPass, runBubbleUpCron } from "../src/bubble-up-cron.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * THE NEW CONCURRENCY PAIR, AGAINST REAL POSTGRES ON :5433.
 *
 * Putting `bubbleUpPass` in `cycle()` creates a pair that did not exist before: the always-on
 * worker and the CLI backstop can both be pointed at the same rows. CLAUDE.md's standing rule
 * applies without argument — "PGlite green means nothing for transactional code; three
 * production bugs were invisible to PGlite and only appeared against real Postgres" — and the
 * mechanism at risk is exactly the one those three shared: `allocateSeq`'s row lock inside the
 * flip transaction. PGlite is single-connection, so it cannot host two allocators contending
 * for one `account_sync_state` row at all.
 *
 * Two properties, and they are different claims:
 *
 *  1. **THE PAIR IS MUTUALLY EXCLUSIVE BY THE LEADER LOCK.** `runBubbleUpCron` takes
 *     `acquireLeaderLock(leaderLockKeyFor(shardIndex))` — the SAME key the live worker holds —
 *     so while a worker is up the backstop is a no-op. This is why the pass went into the loop
 *     rather than onto a scheduler: a cron service on this shard could only ever fail to
 *     acquire and exit.
 *  2. **AND IF THE LOCK IS EVER BYPASSED, THE FLIP IS STILL EXACTLY-ONCE.** Property 1 is a
 *     property of today's callers; property 2 is a property of the SQL, and it is the one that
 *     survives a future caller nobody has written yet. Two passes on SEPARATE PHYSICAL
 *     CONNECTIONS race over the same due rows: the UPDATE re-asserts `state='bubbled_up'`, so
 *     the loser matches 0 rows, and every flip's `change_log` row carries its own gap-free seq.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
let DB = "";

type Db = ReturnType<typeof makeDb>;

async function seedMailbox(db: Db, accountId: string): Promise<string> {
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return row!.id;
}

async function seedDueSnooze(db: Db, accountId: string, mailboxId: string): Promise<string> {
  const dedup = `mid:${randomUUID()}`;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "later", fromAddress: "a@ex.example", nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  const [st] = await db.insert(messageStates).values({
    accountId, messageId: m!.id, state: "bubbled_up", bubbleUpAt: new Date("2020-01-01T00:00:00Z"),
  }).returning();
  return st!.id;
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start >= ms) throw new Error(`timed out after ${ms}ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe("bubble-up: the worker loop and the CLI backstop, on real Postgres", () => {
  const closers: Array<() => Promise<void>> = [];
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_bubbleup_conc"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);
  afterAll(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  });

  it("the backstop refuses to run while the worker holds the lock, and ONE change is emitted", async () => {
    const db = makeDb(DB);
    const accountId = randomUUID();
    const mailboxId = await seedMailbox(db, accountId);
    const stateId = await seedDueSnooze(db, accountId, mailboxId);

    const fleet = new FakeAdapterFleet();
    const w = await runWorkerSupervised({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 250, sentDomain: "trafficflow.test",
      rosterIntervalMs: 400, lockHeartbeatMs: 60_000, mailboxRetryMs: 500,
      healthPort: 0, standbyRetryMs: 400, adapterFactory: fleet.factory,
    });
    closers.push(() => w.stop());
    expect(w.state()).toBe("leader");

    // The backstop, launched WHILE the worker is live and racing its cycles.
    const cron = await runBubbleUpCron({
      databaseUrl: DB, pollIntervalMs: 1000, sentDomain: "trafficflow.test",
    });
    expect(cron).toEqual({ ran: false, flipped: 0 });

    await waitFor(async () => {
      const [row] = await db.select().from(messageStates).where(eq(messageStates.id, stateId));
      return row!.state === "resurfaced";
    }, 15000, "the worker's inline pass to do the work the backstop declined");

    // EXACTLY ONE resurfacing change. Two would mean both writers moved the row, which is the
    // double-emit `bubbleUpPass`'s re-asserted UPDATE exists to make impossible.
    const changes = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityId, stateId)));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.op).toBe("update");
    /* …AND THE PROJECTION BESIDE IT, PINNED AS A PAIR RATHER THAN COUNTED.
     *
     * The Ohbox pins on `message.triage.state`, so the flip emits a `message` update with its
     * `message_state` one. The obvious assertion — count the account's `message` changes and
     * expect one — is a FLAKE here and was one twice before this comment: a LIVE WORKER is running,
     * its cycles ingest the fake fleet's mail and write `message` changes of their own, so that
     * count really measures how much else the worker finished before the test looked.
     *
     * Scoping to this message's id fixes the ingest half but still leaves the count hostage to any
     * LATER write to the same row. So the claim is stated as what the code actually guarantees:
     * the two changes are allocated inside ONE transaction, back to back, so the projection's seq
     * is exactly one above the state's. That is stronger than a count — it proves the pairing, and
     * therefore that no `/sync` page boundary can carry the state without the projection — and it
     * cannot be perturbed by anything the worker does before or after. */
    const [flipped] = await db.select().from(messageStates).where(eq(messageStates.id, stateId));
    const projection = await db.select().from(changeLog)
      .where(and(
        eq(changeLog.accountId, accountId),
        eq(changeLog.entityId, flipped!.messageId),
        eq(changeLog.seq, changes[0]!.seq + 1n),
      ));
    expect(projection, "the flip emitted no `message` change in the seq slot after its state change")
      .toHaveLength(1);
    expect(projection[0]!.entityType).toBe("message");
    expect(projection[0]!.op).toBe("update");
  }, 60000);

  it("two passes on SEPARATE connections over the same due rows → exactly one flip each", async () => {
    const db = makeDb(DB);
    const accountId = randomUUID();
    const mailboxId = await seedMailbox(db, accountId);
    const stateIds: string[] = [];
    for (let i = 0; i < 12; i++) stateIds.push(await seedDueSnooze(db, accountId, mailboxId));

    // TWO PHYSICAL CONNECTIONS. `max: 5` each, so the two passes' transactions genuinely
    // interleave inside Postgres rather than being serialized by one client-side pool.
    const sqlA = postgres(DB, { max: 5 });
    const sqlB = postgres(DB, { max: 5 });
    closers.push(async () => { await sqlA.end({ timeout: 5 }); });
    closers.push(async () => { await sqlB.end({ timeout: 5 }); });
    const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
    const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");
    const now = new Date();

    const [a, b] = await Promise.all([
      bubbleUpPass(dbA as unknown as Tx, now, { accountId, mailboxIds: [mailboxId] }),
      bubbleUpPass(dbB as unknown as Tx, now, { accountId, mailboxIds: [mailboxId] }),
    ]);

    // Every row flipped, and each one exactly once — the totals, not "at least one ran".
    expect(a.flipped + b.flipped).toBe(stateIds.length);

    const rows = await db.select().from(messageStates).where(eq(messageStates.accountId, accountId));
    expect(rows).toHaveLength(stateIds.length);
    expect(rows.every((r) => r.state === "resurfaced" && r.bubbleUpAt === null)).toBe(true);

    // ── THE SEQ LEDGER, WHICH IS THE PART PGLITE CANNOT SEE ─────────────────────────────
    //
    // One `change_log` row per flip, and the seqs GAP-FREE and unique. A gap here means
    // `allocateSeq` handed out a number whose transaction later rolled back, and a `/sync`
    // cursor that lands in the gap stalls; a duplicate means the row lock did not serialize.
    const changes = await db.select().from(changeLog)
      .where(eq(changeLog.accountId, accountId)).orderBy(asc(changeLog.seq));
    /* TWO changes per flip, and the count is the assertion rather than a detail: each flip emits
       its `message_state` update and the `message` update whose `triage` projection is the only
       thing the Ohbox pins on. A pass that emitted one of them would halve this number, and a
       row flipped twice would double it — the two failures this file exists to tell apart. */
    expect(changes).toHaveLength(stateIds.length * 2);
    const states = changes.filter((c) => c.entityType === "message_state");
    const projections = changes.filter((c) => c.entityType === "message");
    expect(states).toHaveLength(stateIds.length);
    expect(projections).toHaveLength(stateIds.length);
    // Distinct within each kind: one announcement per row, never one row announced twice.
    expect(new Set(states.map((c) => c.entityId)).size).toBe(stateIds.length);
    expect(new Set(projections.map((c) => c.entityId)).size).toBe(stateIds.length);
    const seqs = changes.map((c) => c.seq);
    expect(new Set(seqs.map(String)).size).toBe(seqs.length);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]! - seqs[i - 1]!).toBe(1n);
    expect(changes.every((c) => c.op === "update")).toBe(true);
    /* THE PAIR IS ATOMIC PER FLIP, which is what makes the feed safe to apply page by page: the
       two changes of one flip are adjacent in seq order, so no `/sync` page boundary can carry the
       state without the projection that reads it. Two racing passes on separate connections must
       not interleave their pairs — that is a property of the per-flip transaction, and this is
       where it is observable. */
    for (let i = 0; i < changes.length; i += 2) {
      expect(changes[i]!.entityType).toBe("message_state");
      expect(changes[i + 1]!.entityType).toBe("message");
    }
  }, 60000);
});
