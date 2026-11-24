import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq, inArray } from "drizzle-orm";
import { accounts, mailboxes, messages, folderState, changeLog } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { ScreenerService, type ServiceContext } from "@trafficflow/services";

/**
 * ══ EvalPlanQual ON THE SCREENER'S CLOBBER GUARD ══════════════════════════════════════════
 *
 * `decide`'s re-route is `INSERT … ON CONFLICT (message_id) DO UPDATE SET … WHERE
 * desired_folder = 'ohmail/Screener'` (`screener-service.ts#decide`). The `WHERE` is the SCR-READ
 * guard: a row that has already left the gate belongs to whoever moved it, so this decision must
 * decline it and must NOT emit a `change_log` move for it.
 *
 * ## Why this file exists next to `screener-destination.pg.test.ts`
 *
 * That file's clobber case builds its rival write like this:
 *
 *     transaction = async (cb) => { await db.update(folderState)…; return realTransaction(cb); }
 *
 * — the rival `UPDATE` is **awaited to completion, and therefore COMMITTED, before the service's
 * transaction is even opened**. So the guard is evaluated once, against a row version that was
 * already visible in the deciding transaction's own snapshot. That proves the predicate's LOGIC,
 * and it is a real second connection, but it is a SEQUENTIAL schedule: no statement ever waits on
 * a row lock, so Postgres' re-check path is never entered.
 *
 * The path that production actually takes is the other one. `heldMail` is read OUTSIDE the
 * transaction, so the rival can still be IN FLIGHT when the upsert arrives. Then the upsert
 * blocks on the rival's row lock, and when the rival commits Postgres runs **EvalPlanQual**: it
 * re-fetches the NEW row version and re-evaluates the `DO UPDATE … WHERE` against it
 * (`ExecOnConflictUpdate`). Everything the guard promises depends on that re-evaluation, and
 * nothing in the suite had ever made it happen.
 *
 * ## The two properties, and why BOTH are needed
 *
 *  1. **Re-checked and now FALSE ⇒ the row is skipped.** The rival moved it out of the gate while
 *     holding the lock; the woken upsert must leave it alone and emit no move change.
 *  2. **Re-checked and still TRUE ⇒ the row is re-routed.** The rival touched the row under the
 *     lock without moving it out of the gate. This is the assertion that distinguishes "the
 *     predicate was re-evaluated against the new version" from "anything concurrently updated is
 *     bailed on" — an implementation with the second behaviour passes (1) and silently DROPS a
 *     user's decision under ordinary contention. (1) alone cannot see that.
 *
 * Both are unreachable on PGlite (single connection: no lock ever waits) and unreachable on the
 * sequential construction above (nothing is in flight to wait for).
 *
 * `max: 4` and a RESERVED connection for the rival, so the service and the rival can never be
 * scheduled onto the same socket — which would serialise them in the client and reproduce the
 * blind spot this file exists to remove.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => new Date(),
  requestId: `epq-${randomUUID().slice(0, 8)}`,
});

interface World {
  accountId: string;
  held: string[];
  address: string;
}

/** One waiting first-contact sender with `each` held messages, all at the gate. */
async function newWorld(each = 3): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `epq-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `epq-${accountId.slice(0, 8)}@example.test`,
  }).returning();

  const address = `post@ledgerandloom.test`;
  const held: string[] = [];
  for (let i = 0; i < each; i += 1) {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `epq${i}`, dedupKey: `epq:${randomUUID()}`,
      subject: `Bulletin ${i}`, fromAddress: address,
      nativeLocator: { folder: "ohmail/Screener", ref: `1:${i}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    held.push(m!.id);
  }
  return { accountId, held, address };
}

const stateOf = async (ids: string[]) =>
  db.select({ id: folderState.messageId, desired: folderState.desiredFolder })
    .from(folderState).where(inArray(folderState.messageId, ids));

const movesOf = async (accountId: string) =>
  (await db.select().from(changeLog)
    .where(and(eq(changeLog.accountId, accountId), eq(changeLog.op, "move")))
    .orderBy(asc(changeLog.seq))).map((r) => r.entityId);

/**
 * Block until a backend is genuinely PARKED on a heavyweight lock, or give up.
 *
 * Without this the test could pass by scheduling luck — the service might finish its upsert
 * before the rival's lock is ever contended, which is the sequential case again wearing this
 * file's name. Every assertion below is therefore gated on this returning `true`.
 */
async function waitForLockWait(deadlineMs = 10_000): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const [row] = await client<Array<{ n: number }>>`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database()
         and wait_event_type = 'Lock'
         and state = 'active'
         and query ilike '%folder_state%'`;
    if ((row?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe.skipIf(!PG_UP)("EvalPlanQual — the Screener's re-route guard re-checked under a real lock wait", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("(1) a rival that moves the row out of the gate WHILE the upsert waits is not clobbered", async () => {
    const w = await newWorld(3);
    const victim = w.held[1]!;

    const rival = await client.reserve();
    let blocked = false;
    try {
      await rival`begin`;
      // The lock is taken BEFORE the service starts, so the upsert is guaranteed to arrive at a
      // row somebody else owns rather than racing for it.
      await rival`select 1 from folder_state where message_id = ${victim}::uuid for update`;

      // `heldMail` is read outside the transaction and still sees the OLD version, so the victim
      // IS in the bag this decision believes it is re-routing. That is the production shape.
      const decided = new ScreenerService({}).decide(
        ctx(w.accountId), w.held[0]!, { decision: "yes", dest: "INBOX" },
      );

      blocked = await waitForLockWait();
      // The rival's write, committed under the lock the upsert is parked on.
      await rival`update folder_state
                     set desired_folder = 'ohmail/News', last_set_by = 'us', reconcile_status = 'pending'
                   where message_id = ${victim}::uuid`;
      await rival`commit`;

      await decided;
    } finally {
      await rival.release();
    }

    expect(blocked, "no backend ever parked on the row lock — the upsert never waited, so this test proved nothing").toBe(true);

    const byId = new Map((await stateOf(w.held)).map((r) => [r.id, r.desired]));
    // Re-evaluated against the COMMITTED new version: the predicate is false, the row is skipped.
    expect(byId.get(victim), "the woken upsert clobbered a row that had left the gate").toBe("ohmail/News");
    // …and the guard is not a blanket skip: the uncontended rows were re-routed normally.
    for (const id of w.held.filter((x) => x !== victim)) expect(byId.get(id)).toBe("INBOX");

    // A skipped row must not appear in the delta stream, or every client paints it into INBOX.
    expect((await movesOf(w.accountId)).sort()).toEqual(w.held.filter((x) => x !== victim).sort());
  }, 60_000);

  it("(2) a rival that TOUCHES the row without moving it out of the gate does not lose the decision", async () => {
    const w = await newWorld(3);
    const touched = w.held[1]!;

    const rival = await client.reserve();
    let blocked = false;
    try {
      await rival`begin`;
      await rival`select 1 from folder_state where message_id = ${touched}::uuid for update`;

      const decided = new ScreenerService({}).decide(
        ctx(w.accountId), w.held[0]!, { decision: "yes", dest: "INBOX" },
      );

      blocked = await waitForLockWait();
      // A concurrent writer that does NOT answer the consent question — the reconciler stamping
      // what it observed, a conflict flag, a status change. `desired_folder` stays at the gate.
      await rival`update folder_state
                     set reconcile_status = 'pending', conflict = true
                   where message_id = ${touched}::uuid`;
      await rival`commit`;

      await decided;
    } finally {
      await rival.release();
    }

    expect(blocked, "no backend ever parked on the row lock — the upsert never waited, so this test proved nothing").toBe(true);

    const byId = new Map((await stateOf(w.held)).map((r) => [r.id, r.desired]));
    // THE DISTINGUISHING ASSERTION. The predicate still holds on the new version, so the row is
    // re-routed. An implementation that bailed on any concurrent update would leave this at the
    // gate — a user's decision silently dropped, with the toast still claiming it landed.
    expect(byId.get(touched), "a concurrent touch that did not leave the gate lost the user's decision").toBe("INBOX");
    for (const id of w.held) expect(byId.get(id)).toBe("INBOX");

    expect((await movesOf(w.accountId)).sort()).toEqual([...w.held].sort());
  }, 60_000);

  /**
   * THE CONTROL — the mutation, run as a test instead of as an edit. `screener-service.ts` may
   * not be touched while it is being worked on, so the usual "delete the guard and watch this
   * go red" runs on a HAND-WRITTEN COPY of the same upsert with `setWhere` removed, driven
   * through the identical interleave. It clobbers — which makes case (1) evidence rather than
   * coincidence: the two statements differ in exactly one clause, so the surviving
   * `ohmail/News` in (1) is attributable to `WHERE desired_folder = 'ohmail/Screener'` being
   * RE-EVALUATED against the version the rival committed. Without the re-check, (1) would read
   * `INBOX`, exactly as this control does.
   */
  it("(control) the SAME interleave with the guard clause removed DOES clobber", async () => {
    const w = await newWorld(1);
    const victim = w.held[0]!;

    const rival = await client.reserve();
    let blocked = false;
    try {
      await rival`begin`;
      await rival`select 1 from folder_state where message_id = ${victim}::uuid for update`;

      // The upsert `decide` runs, minus `setWhere` — the pre-SCR-READ statement, verbatim in
      // shape. Its own connection and its own transaction, so it parks on the rival's row lock.
      const unguarded = client.begin(async (tx) => {
        await tx`insert into folder_state
                   (message_id, account_id, desired_folder, observed_folder, last_set_by, reconcile_status, conflict)
                 select id, account_id, 'INBOX', 'ohmail/Screener', 'us', 'pending', false from messages where id = ${victim}::uuid
                 on conflict (message_id) do update
                    set desired_folder = 'INBOX', last_set_by = 'us',
                        reconcile_status = 'pending', conflict = false`;
      });

      blocked = await waitForLockWait();
      await rival`update folder_state
                     set desired_folder = 'ohmail/News', last_set_by = 'us', reconcile_status = 'pending'
                   where message_id = ${victim}::uuid`;
      await rival`commit`;

      await unguarded;
    } finally {
      await rival.release();
    }

    expect(blocked, "no backend ever parked on the row lock — the control proved nothing").toBe(true);

    const byId = new Map((await stateOf(w.held)).map((r) => [r.id, r.desired]));
    // The rival's placement is gone. This is SCR-READ's production state, reproduced.
    expect(byId.get(victim), "the unguarded upsert did NOT clobber — the interleave is not reaching the re-check").toBe("INBOX");
  }, 60_000);
});
