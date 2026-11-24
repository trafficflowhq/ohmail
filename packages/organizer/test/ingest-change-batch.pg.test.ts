import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, changeLog, mailboxes, messages, rules, threads } from "@trafficflow/db";
import { CHANGE_LOG_CHANNEL } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ONE INGESTED MESSAGE, ONE APPEND — the seqs, the order and the wake, on real Postgres.
 *
 * `commitChange` collected its three deltas (the thread, the message, the optimistic move) and
 * wrote them in ONE `recordChanges` instead of three `recordChange`s. What the collapse must not
 * change is everything a client reads: the thread's seq below the message's, the message's below
 * the move's, dense and consecutive, and the wake naming the highest.
 *
 * PGlite cannot host it. The seqs come from a row lock, and LISTEN/NOTIFY delivery to another
 * physical connection — the thing a client's push path actually waits on — does not exist there.
 */
const PG_UP = await realPgAvailable();

const SENDER = "editor@example.com";
const DESTINATION = "ohmail/News";

describe.skipIf(!PG_UP)("the ingest's change rows, batched", () => {
  let sql: ReturnType<typeof postgres>;
  let listenSql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 3, onnotice: () => {} });
    listenSql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 120_000);

  afterAll(async () => {
    await listenSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  it("writes the thread, the message and the move at consecutive seqs, under ONE wake", async () => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `cb-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `cb-${accountId.slice(0, 8)}@ohmail.test`,
    }).returning();
    // The rule is what makes the arrival a THREE-entity message: a desired folder that is not the
    // one it arrived in is the optimistic `move` delta, on top of the thread and the message.
    await db.insert(rules).values({
      accountId, kind: "sender", match: SENDER, destination: DESTINATION,
      provenance: "manual", enabled: true,
    });

    // The wake, on a SECOND physical connection, exactly as a client's push path receives it.
    const wakes: string[] = [];
    await listenSql.listen(CHANGE_LOG_CHANNEL, (payload) => { wakes.push(payload); });

    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
    );
    fleet.behave(mb!.id, {
      deliver: [{ from: SENDER, subject: "Frischer Auftritt", messageId: `cb-${randomUUID()}@x` }],
    });

    const out = await runSyncCycle({
      // A FIXTURE HOLDS NO ORGANIZER LEASE, and `SyncDeps.writeAuthority` is required, so it
      // says so rather than leaving the field out — an omission is the shape that let a
      // hosted cycle write to a mailbox whose lease it had never asked about.
      writeAuthority: FIXTURE_LEASE,
      repo: makeDrizzleRepo(db as never), adapter, accountId, mailboxId: mb!.id,
      storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    });
    expect(out.hasBacklog, "the fixture did not hand the message over in one cycle").toBe(false);

    const [msg] = await db.select().from(messages).where(eq(messages.accountId, accountId));
    expect(msg, "nothing was ingested — every assertion below would pass on an empty log")
      .toBeDefined();
    const [thread] = await db.select().from(threads).where(eq(threads.accountId, accountId));
    expect(thread).toBeDefined();

    const rows = await db.select().from(changeLog)
      .where(eq(changeLog.accountId, accountId)).orderBy(asc(changeLog.seq));

    // ── 1. THE ORDER, which is the order the separate calls produced ──────────────────────
    expect(rows.map((r) => `${r.entityType}:${r.op}`)).toEqual([
      "thread:create", "message:create", "message:move",
    ]);
    expect(rows.map((r) => r.entityId)).toEqual([thread!.id, msg!.id, msg!.id]);

    // ── 2. DENSE AND CONSECUTIVE from 1 — the allocator reserved one block, not three ──────
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3]);

    // ── 3. THE MOVE'S META, which is the only delta carrying one ──────────────────────────
    expect(rows[2]!.meta).toEqual({ from: "INBOX", to: DESTINATION });

    // ── 4. ONE WAKE, naming the HIGHEST seq of the batch ──────────────────────────────────
    const end = Date.now() + 4_000;
    while (wakes.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(wakes, "three appends would ring three times; one batch rings once")
      .toEqual([`${accountId}:3`]);

    // ── 5. THE TRANSACTION BOUNDARY: the rows the deltas name are all there ───────────────
    // A change row that outlived its entity — or arrived before it — is the failure the append's
    // position inside the commit exists to prevent, and it is readable here as a dangling id.
    const ids = new Set([thread!.id, msg!.id]);
    expect(rows.every((r) => ids.has(r.entityId))).toBe(true);
  }, 60_000);

  it("a second message on the same thread appends its own block after the first's", async () => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `cb2-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `cb2-${accountId.slice(0, 8)}@ohmail.test`,
    }).returning();

    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
    );
    fleet.behave(mb!.id, {
      deliver: [
        { from: SENDER, subject: "Frischer Auftritt", messageId: `cb2a-${randomUUID()}@x` },
        { from: SENDER, subject: "Frischer Auftritt", messageId: `cb2b-${randomUUID()}@x` },
      ],
    });
    // Inline rather than hoisted: `UNMETERED_STORAGE_CAP` is a unique symbol, and a `const`
    // object literal widens it to `symbol`, which the typed cap refuses.
    const repo = makeDrizzleRepo(db as never);
    let cycles = 0;
    for (;;) {
      const out = await runSyncCycle({
        writeAuthority: FIXTURE_LEASE,
        repo, adapter, accountId, mailboxId: mb!.id,
        storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
      });
      cycles += 1;
      if (!out.hasBacklog) break;
      if (cycles > 20) throw new Error("the fixture never drained");
    }

    const rows = await db.select({ seq: changeLog.seq }).from(changeLog)
      .where(and(eq(changeLog.accountId, accountId))).orderBy(asc(changeLog.seq));
    // Whatever the two messages produced, the log is a dense 1..N: a per-message block that
    // reserved more than it wrote, or wrote outside what it reserved, shows here as a gap.
    expect(rows.map((r) => Number(r.seq)))
      .toEqual(Array.from({ length: rows.length }, (_, i) => i + 1));
    expect(rows.length, "nothing was appended").toBeGreaterThanOrEqual(3);
  }, 60_000);
});
