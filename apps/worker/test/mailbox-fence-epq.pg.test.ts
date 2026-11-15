import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, mailboxes, mailboxFolders, messages, changeLog, folderState } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { workerHeartbeats, writeHeartbeat } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { MailboxAdapter, ChangeBatch } from "@trafficflow/core/adapters/imap";
import type { NativeLocator } from "@trafficflow/core";
import { markMailboxFailed, makeSyncWriteFence, type LeaderFence } from "../src/mailboxes.js";
import { runSyncCycle, LeaderFencedError, type SyncDeps } from "../src/sync.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ══ THE LEADER FENCE, WHEN THE TAKEOVER COMMITS INSIDE THE LOCK WAIT ══════════════════════
 *
 * `lifecycleWhere` fences both mailbox lifecycle writes with an uncorrelated `EXISTS` over
 * `worker_heartbeats` for `(shard, instance, leader = true)`. `mailbox-fence.pg.test.ts` proves
 * the predicate's LOGIC — but every one of its cases is SEQUENTIAL: the takeover is awaited to
 * completion, and therefore committed, before the fenced statement is issued. Nothing there ever
 * waits on a row lock.
 *
 * The window this file is about is the other one, and it is the window a handoff actually opens:
 *
 *   1. worker A issues its fenced `UPDATE mailboxes … WHERE id = X AND … AND EXISTS(A is leader)`;
 *   2. the statement blocks, because somebody else holds a lock on that mailbox row;
 *   3. worker B takes the shard over WHILE A IS PARKED — `writeHeartbeat` upserts on
 *      `shard_index`, so the row now names B and A is no longer the leader of anything;
 *   4. the lock is released and A wakes up.
 *
 * Postgres' READ COMMITTED rule for that wake-up is explicit, and it was the whole defect: an
 * updating command *"can see the effects of concurrent updating commands on the same rows it is
 * trying to update, but it does not see effects of those commands on other rows in the
 * database."* `worker_heartbeats` is another row. So whichever way the planner treats the
 * subquery — an `InitPlan` evaluated once before the scan, or a qual re-evaluated by EvalPlanQual
 * against the ORIGINAL snapshot — A's fence was answered with the leadership A held when its
 * statement began, and the fenced-out worker's write landed anyway. The fence FAILED OPEN in
 * exactly the case it exists for.
 *
 * MEASURED HERE before the fix: `markMailboxFailed` returned `true` and the mailbox was left
 * `status='error'` by a worker that had already lost the shard — quarantined, in the retry
 * rotation, and reported broken to its owner, by a process with no authority over it.
 *
 * `applyFenced` (`mailboxes.ts`) is the repair: one transaction, a bare `SELECT … FOR UPDATE`
 * that absorbs the lock wait and asserts nothing, then the fenced `UPDATE` — whose snapshot is
 * therefore taken AFTER the wait, and which cannot block, because the row is already held.
 *
 * ── WHAT THIS FILE ESTABLISHES ────────────────────────────────────────────────────────────
 *
 * The interleave, driven by the parked-lock idiom `screener-evalplanqual.pg.test.ts` uses: a
 * reserved connection takes `FOR UPDATE` on the mailbox row before the fenced write is issued,
 * the write is confirmed to be genuinely PARKED on a heavyweight lock (`pg_stat_activity`), the
 * takeover is committed on a third connection inside that window, and only then is the lock
 * released.
 *
 * The CONTROL is the sequential order — the same takeover, committed BEFORE the statement is
 * issued — which the fence always refused correctly, and which is the whole of what
 * `mailbox-fence.pg.test.ts` could reach. Two runs of one write differing only in WHEN the
 * takeover commits is what makes the first attributable to the window rather than to the fixture.
 *
 * ── AND THE SAME WINDOW OVER THE MAIL-BEARING WRITES (second describe) ──────────────
 *
 * The lifecycle fence above covered `mailboxes.status` and NOTHING that carries mail: a worker
 * that had lost its shard kept committing `messages`, advancing `mailbox_folders` cursors,
 * appending `change_log` rows and issuing IMAP moves for the rest of its cycle.
 * `makeSyncWriteFence` extends the fence to those writes with the same claim-then-verify shape,
 * and the second describe proves it under the same parked-lock interleave — driven through the
 * REAL `runSyncCycle` write sites, not only through the fence in isolation, so removing the
 * fence from an ingest or a move site turns these red. PGlite proves nothing here: the whole
 * defect is what a parked statement's subquery sees after a lock wait, which only real Postgres
 * exhibits.
 */

const AVAILABLE = await realPgAvailable();

/** A shard index of this file's own, so a parallel worker test's beats cannot collide. */
const SHARD = 96;
const A: LeaderFence = { shardIndex: SHARD, instanceId: "epq-A" };
const B: LeaderFence = { shardIndex: SHARD, instanceId: "epq-B" };

const beatOf = (fence: LeaderFence) => ({
  shardIndex: fence.shardIndex, instanceId: fence.instanceId, shards: 1,
  mailboxes: 1, expected: 1, accounts: 1, quarantined: 0,
  degraded: false, lastCycleAt: null, startedAt: new Date(),
});

let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

// FILE-level, not per-describe: both describes share one pool, and a per-describe `afterAll`
// would end it before the second describe runs.
beforeAll(async () => {
  if (!AVAILABLE) return;
  await runMigrations(PG_TEST_URL);
  sql = postgres(PG_TEST_URL, { max: 5, onnotice: () => {} });
  db = brandDialect(drizzle(sql, { schema }), "pg");
}, 120_000);
afterAll(async () => { await sql?.end({ timeout: 5 }); });

/**
 * Block until a backend is genuinely PARKED on a heavyweight lock over `mailboxes`, or give up.
 *
 * Every assertion about the window is gated on this: without it the fenced write might finish
 * before the lock is ever contended, which is the sequential case again wearing this file's name.
 */
async function waitForLockWait(deadlineMs = 10_000): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const [row] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database()
         and wait_event_type = 'Lock'
         and state = 'active'
         and query ilike '%mailboxes%'`;
    if ((row?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe.skipIf(!AVAILABLE)("the leader fence across a takeover that commits in the lock wait", () => {
  beforeEach(async () => {
    await db.delete(workerHeartbeats).where(eq(workerHeartbeats.shardIndex, SHARD));
  });

  const seed = async (): Promise<string> => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `epq-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `epq-${accountId.slice(0, 8)}@example.test`,
      status: "connected",
    }).returning();
    return mb!.id;
  };

  const rowOf = async (id: string) =>
    (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;

  /**
   * THE CONTROL, and it must stay green: the same takeover, committed BEFORE the fenced write is
   * issued. This is `mailbox-fence.pg.test.ts`'s schedule, restated here so the reproduction
   * below is a difference of one variable rather than a claim about a different fixture.
   */
  it("(control) a takeover committed BEFORE the write is issued fences it out", async () => {
    const id = await seed();
    await writeHeartbeat(db as unknown as Tx, beatOf(A));
    await writeHeartbeat(db as unknown as Tx, beatOf(B));

    const wrote = await markMailboxFailed(
      db as never, id, { code: "auth", detail: null }, { fence: A },
    );

    expect(wrote, "the surrendered leader's write was accepted on a sequential schedule").toBe(false);
    expect((await rowOf(id)).status).toBe("connected");
  });

  /**
   * THE CASE THE SEQUENTIAL SUITE CANNOT REACH. Red before `applyFenced`, with `wrote === true`
   * and the mailbox left quarantined by a worker that no longer led its shard.
   */
  it("a takeover committed INSIDE the lock wait fences the parked write out", async () => {
    const id = await seed();
    await writeHeartbeat(db as unknown as Tx, beatOf(A));

    const holder = await sql.reserve();
    const taker = await sql.reserve();
    let blocked = false;
    let wrote: boolean | null = null;
    try {
      // Somebody else holds this mailbox row — the reconciler's own status write, a roster pass,
      // the account's PATCH. The fenced write is guaranteed to arrive at a locked row rather than
      // racing for it.
      await holder`begin`;
      await holder`select 1 from mailboxes where id = ${id}::uuid for update`;

      // A's fenced write. Its snapshot is taken now, while A IS still the leader.
      const pending = markMailboxFailed(
        db as never, id, { code: "auth", detail: null }, { fence: A },
      );

      blocked = await waitForLockWait();

      // THE TAKEOVER, committed while A is parked. `writeHeartbeat` upserts on `shard_index`, so
      // after this there is no row naming A at all: A is the leader of nothing.
      await taker`begin`;
      await taker`insert into worker_heartbeats
                    (shard_index, instance_id, leader, shards, mailboxes, expected, accounts,
                     quarantined, degraded, last_cycle_at, started_at, beat_at)
                  values (${SHARD}, ${B.instanceId}, true, 1, 1, 1, 1, 0, false, null, now(), now())
                  on conflict (shard_index) do update
                     set instance_id = ${B.instanceId}, leader = true, beat_at = now()`;
      await taker`commit`;

      // …and only now does the lock go.
      await holder`commit`;
      wrote = await pending;
    } finally {
      await holder.release();
      await taker.release();
    }

    expect(blocked, "no backend ever parked on the mailbox row lock — this test proved nothing").toBe(true);

    // The heartbeat says B, and it said B before the parked statement was allowed to proceed.
    const [beat] = await db.select().from(workerHeartbeats)
      .where(eq(workerHeartbeats.shardIndex, SHARD));
    expect(beat!.instanceId, "the takeover did not land — the window was not reproduced").toBe(B.instanceId);

    // THE PROPERTY. A is not the leader of this shard by the time its write is applied, so the
    // write must be refused — the same refusal the control gets, for the same reason.
    expect(wrote, "a surrendered leader's write landed because the fence was answered from a stale snapshot").toBe(false);
    expect(
      (await rowOf(id)).status,
      "the mailbox was quarantined by a worker that had already lost the shard",
    ).toBe("connected");
  }, 60_000);
});

/* ════════════════════════════════════════════════════════════════════════════════════════════
   THE SYNC WRITE FENCE — the same takeover window, over the writes that CARRY MAIL
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/** A shard of this block's own, so the lifecycle block's beats cannot collide with these. */
const SHARD_SYNC = 97;
const SA: LeaderFence = { shardIndex: SHARD_SYNC, instanceId: "epq-sync-A" };
const SB: LeaderFence = { shardIndex: SHARD_SYNC, instanceId: "epq-sync-B" };

/**
 * The minimum of an adapter `runSyncCycle` touches: one controllable batch, a move recorder.
 * `fetchByUid` and `moveMany` are deliberately absent — the retry pass stands down and the
 * filing path takes `fileOne`, which is where the per-move fence check lives.
 */
function fakeAdapter(opts: {
  batch?: () => ChangeBatch;
  moves?: Array<{ ref: string; to: string }>;
}): MailboxAdapter {
  const empty: ChangeBatch = { creates: [], moves: [], deletes: [], flagChanges: [], newCursor: { folders: {} } };
  return {
    async changesSince(): Promise<ChangeBatch> { return opts.batch ? opts.batch() : empty; },
    async move(locator: NativeLocator, toFolder: string): Promise<NativeLocator> {
      opts.moves?.push({ ref: locator.ref, to: toFolder });
      return { folder: toFolder, ref: locator.ref };
    },
    async setFlags(): Promise<void> { /* no pending flags in these fixtures */ },
  } as unknown as MailboxAdapter;
}

const rawEml = (subject: string): Buffer => Buffer.from([
  `Message-ID: <${randomUUID()}@fence.test>`,
  "From: someone@fence.test",
  "To: owner@fence.test",
  `Subject: ${subject}`,
  "Content-Type: text/plain",
  "",
  "body",
].join("\r\n"));

/** One create in INBOX plus the advanced cursor a real drain would publish. */
const oneCreateBatch = (): ChangeBatch => ({
  creates: [{ type: "create", locator: { folder: "INBOX", ref: "1:1001" }, seen: false, raw: rawEml("fence probe") }],
  moves: [], deletes: [], flagChanges: [],
  newCursor: { folders: { INBOX: { uidValidity: "1", uidNext: 1002, highestModseq: "0", known: [] } } },
});

describe.skipIf(!AVAILABLE)("the sync write fence over mail-bearing writes", () => {
  beforeEach(async () => {
    await db.delete(workerHeartbeats).where(eq(workerHeartbeats.shardIndex, SHARD_SYNC));
  });

  const seedMailbox = async (): Promise<{ accountId: string; mailboxId: string }> => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `epq-sync-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `epq-sync-${accountId.slice(0, 8)}@example.test`,
      status: "connected",
    }).returning();
    return { accountId, mailboxId: mb!.id };
  };

  const beat = (fence: LeaderFence) => writeHeartbeat(db as unknown as Tx, beatOf(fence));

  const depsFor = (
    seeded: { accountId: string; mailboxId: string },
    adapter: MailboxAdapter,
    lost?: () => boolean,
  ): SyncDeps => ({ writeAuthority: FIXTURE_LEASE,
    repo: makeDrizzleRepo(db as unknown as Tx), adapter,
    accountId: seeded.accountId, mailboxId: seeded.mailboxId,
    trustedAuthservIds: new Set<string>(),
    storageCap: UNMETERED_STORAGE_CAP,
    fence: makeSyncWriteFence(db as never, seeded.mailboxId, SA, lost),
  });

  /** Commit worker B's takeover of {@link SHARD_SYNC} on its own connection, mid-window. */
  async function commitTakeover(taker: Awaited<ReturnType<typeof sql.reserve>>): Promise<void> {
    await taker`begin`;
    await taker`insert into worker_heartbeats
                  (shard_index, instance_id, leader, shards, mailboxes, expected, accounts,
                   quarantined, degraded, last_cycle_at, started_at, beat_at)
                values (${SHARD_SYNC}, ${SB.instanceId}, true, 1, 1, 1, 1, 0, false, null, now(), now())
                on conflict (shard_index) do update
                   set instance_id = ${SB.instanceId}, leader = true, beat_at = now()`;
    await taker`commit`;
  }

  it("(control) a takeover committed BEFORE a cursor write fences it out with nothing written", async () => {
    const s = await seedMailbox();
    await beat(SA);
    await beat(SB);
    const fence = makeSyncWriteFence(db as never, s.mailboxId, SA);

    const out = await fence.transaction((r) =>
      r.upsertMailboxFolder(s.mailboxId, "INBOX", { uidValidity: "1", uidNext: 41, highestModseq: "0" }));

    expect(out.fenced, "a surrendered leader's cursor write was accepted on a sequential schedule").toBe(true);
    expect(await db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, s.mailboxId))).toHaveLength(0);
  });

  it("a takeover committed INSIDE the lock wait fences the parked cursor write out", async () => {
    const s = await seedMailbox();
    await beat(SA);
    const fence = makeSyncWriteFence(db as never, s.mailboxId, SA);

    const holder = await sql.reserve();
    const taker = await sql.reserve();
    let blocked = false;
    let out: { fenced: boolean } | null = null;
    try {
      await holder`begin`;
      await holder`select 1 from mailboxes where id = ${s.mailboxId}::uuid for update`;

      // A's fenced write. Its transaction begins now, while A IS still the leader; the claim parks.
      const pending = fence.transaction((r) =>
        r.upsertMailboxFolder(s.mailboxId, "INBOX", { uidValidity: "1", uidNext: 41, highestModseq: "0" }));

      blocked = await waitForLockWait();
      await commitTakeover(taker);
      await holder`commit`;
      out = await pending;
    } finally {
      await holder.release();
      await taker.release();
    }

    expect(blocked, "no backend ever parked on the mailbox row lock — this test proved nothing").toBe(true);
    expect(out!.fenced, "a surrendered leader's cursor write landed from a stale snapshot").toBe(true);
    expect(await db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, s.mailboxId))).toHaveLength(0);
  }, 60_000);

  it("the live leader's cursor write lands through the fence", async () => {
    const s = await seedMailbox();
    await beat(SA);
    const fence = makeSyncWriteFence(db as never, s.mailboxId, SA);

    const out = await fence.transaction((r) =>
      r.upsertMailboxFolder(s.mailboxId, "INBOX", { uidValidity: "1", uidNext: 41, highestModseq: "0" }));

    expect(out.fenced, "the fence refused the instance the heartbeat names — it would refuse everyone").toBe(false);
    expect(await db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, s.mailboxId))).toHaveLength(1);
  });

  it("a takeover committed while an INGEST is parked refuses the whole commit: no message, no change_log, no cursor", async () => {
    const s = await seedMailbox();
    await beat(SA);
    const deps = depsFor(s, fakeAdapter({ batch: oneCreateBatch }));

    const holder = await sql.reserve();
    const taker = await sql.reserve();
    let blocked = false;
    let settled: unknown;
    try {
      await holder`begin`;
      await holder`select 1 from mailboxes where id = ${s.mailboxId}::uuid for update`;

      // The REAL write site: runSyncCycle plans the message and its fenced commit parks on the
      // claim. Settled into a value up front so the rejection cannot fire unhandled between the
      // lock release and the assertion below.
      const pending = runSyncCycle(deps).then(() => "resolved" as const, (e: unknown) => e);

      blocked = await waitForLockWait();
      await commitTakeover(taker);
      await holder`commit`;
      settled = await pending;
    } finally {
      await holder.release();
      await taker.release();
    }

    expect(blocked, "no backend ever parked on the mailbox row lock — this test proved nothing").toBe(true);
    expect(settled, "the fenced-out cycle reported success").toBeInstanceOf(LeaderFencedError);
    expect(await db.select().from(messages).where(eq(messages.mailboxId, s.mailboxId)),
      "a message was committed by a worker that had already lost the shard").toHaveLength(0);
    expect(await db.select().from(changeLog).where(eq(changeLog.accountId, s.accountId)),
      "a change_log row was appended by a worker that had already lost the shard").toHaveLength(0);
    expect(await db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, s.mailboxId)),
      "a cursor was advanced past mail the new leader now owns").toHaveLength(0);
  }, 60_000);

  it("(control) the live leader's ingest lands through the fence: message, change_log and cursor all present", async () => {
    const s = await seedMailbox();
    await beat(SA);
    const moves: Array<{ ref: string; to: string }> = [];
    const deps = depsFor(s, fakeAdapter({ batch: oneCreateBatch, moves }));

    await runSyncCycle(deps);

    expect(await db.select().from(messages).where(eq(messages.mailboxId, s.mailboxId))).toHaveLength(1);
    expect((await db.select().from(changeLog).where(eq(changeLog.accountId, s.accountId))).length).toBeGreaterThan(0);
    expect(await db.select().from(mailboxFolders).where(
      and(eq(mailboxFolders.mailboxId, s.mailboxId), eq(mailboxFolders.folder, "INBOX")))).toHaveLength(1);
  });

  it("a surrendered leader's IMAP move is never issued, and the filing intent is left untouched", async () => {
    const s = await seedMailbox();
    await beat(SA);
    await beat(SB); // sequential surrender: the heartbeat now names B before A's cycle runs

    const [msg] = await db.insert(messages).values({
      accountId: s.accountId, mailboxId: s.mailboxId,
      bodyHash: "h", dedupKey: `dk-${randomUUID()}`,
      nativeLocator: { folder: "INBOX", ref: "1:7" },
    }).returning();
    await db.insert(folderState).values({
      messageId: msg!.id, accountId: msg!.accountId, desiredFolder: "ohmail/Feed", observedFolder: "INBOX",
      lastSetBy: "us", reconcileStatus: "pending", conflict: false,
    });

    const moves: Array<{ ref: string; to: string }> = [];
    const deps = depsFor(s, fakeAdapter({ moves }));

    await expect(runSyncCycle(deps)).rejects.toBeInstanceOf(LeaderFencedError);
    expect(moves, "an IMAP move was issued by a worker that no longer leads its shard").toHaveLength(0);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, msg!.id));
    expect(fs!.reconcileStatus, "the filing intent must stay pending for the new leader to file").toBe("pending");
    expect(fs!.observedFolder).toBe("INBOX");
  });

  it("(control) the live leader's move goes out and its bookkeeping lands through the fence", async () => {
    const s = await seedMailbox();
    await beat(SA);

    const [msg] = await db.insert(messages).values({
      accountId: s.accountId, mailboxId: s.mailboxId,
      bodyHash: "h", dedupKey: `dk-${randomUUID()}`,
      nativeLocator: { folder: "INBOX", ref: "1:7" },
    }).returning();
    await db.insert(folderState).values({
      messageId: msg!.id, accountId: msg!.accountId, desiredFolder: "ohmail/Feed", observedFolder: "INBOX",
      lastSetBy: "us", reconcileStatus: "pending", conflict: false,
    });

    const moves: Array<{ ref: string; to: string }> = [];
    const deps = depsFor(s, fakeAdapter({ moves }));

    await runSyncCycle(deps);

    expect(moves).toEqual([{ ref: "1:7", to: "ohmail/Feed" }]);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, msg!.id));
    expect(fs!.reconcileStatus).toBe("reconciled");
  });

  /* THE FENCE'S THIRD OUTCOME — the mailbox is not there to write into.

     The opening `SELECT … FOR UPDATE` took the mailbox row and read nothing off it, so every
     fenced writer asked a SECOND statement (`mailboxStatusForWrite`) for a fact the first one was
     already holding. It reads `status` now and answers `removed`: the removal ORDERS against the
     fence rather than racing it, and the second question is gone rather than moved. PGlite cannot
     reach the middle case — its whole content is what a parked `FOR UPDATE` sees after the wait. */

  it("(positive control) a live mailbox answers neither fenced nor removed, and the write lands", async () => {
    const s = await seedMailbox();
    await beat(SA);
    const fence = makeSyncWriteFence(db as never, s.mailboxId, SA);

    const out = await fence.transaction((r) =>
      r.upsertMailboxFolder(s.mailboxId, "INBOX", { uidValidity: "1", uidNext: 61, highestModseq: "0" }));

    expect({ fenced: out.fenced, removed: out.removed },
      "a live mailbox was refused by the fence").toEqual({ fenced: false, removed: undefined });
    expect(await db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, s.mailboxId)))
      .toHaveLength(1);
  });

  it("(control) a removal committed BEFORE the write answers `removed`, not `fenced`", async () => {
    /* The sequential schedule, and the half a zero-row read used to get WRONG: a mailbox whose row
       is gone was reported as a LOST LEASE — `LeaderFencedError`, which quiesces the instance —
       rather than as a mailbox that has gone. Both arms are asserted: the tombstone and the
       deletion. */
    const s = await seedMailbox();
    await beat(SA);
    const fence = makeSyncWriteFence(db as never, s.mailboxId, SA);
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, s.mailboxId));

    const out = await fence.transaction((r) =>
      r.upsertMailboxFolder(s.mailboxId, "INBOX", { uidValidity: "1", uidNext: 62, highestModseq: "0" }));

    expect({ fenced: out.fenced, removed: out.removed },
      "a tombstoned mailbox was not reported as removed").toEqual({ fenced: false, removed: "disabled" });
    expect(await db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, s.mailboxId)),
      "a removed mailbox gained a cursor").toHaveLength(0);

    const gone = makeSyncWriteFence(db as never, randomUUID(), SA);
    const out2 = await gone.transaction(async () => "unreachable");
    expect({ fenced: out2.fenced, removed: out2.removed },
      "a mailbox with no row at all was reported as a lost lease").toEqual({ fenced: false, removed: null });
  });

  it("a removal committed INSIDE the lock wait is read by the parked fence, and nothing is written", async () => {
    /* THE WINDOW. The fence's statement is ISSUED while the mailbox is still live and parks on the
       row the remover is holding; the removal then commits; EvalPlanQual re-evaluates the row at
       the latest version and the fence answers `removed`. A status read taken outside this
       statement could not make that claim — it would be a fact about a moment, not about the
       transaction that is about to write. MUTATION WATCHED: ignore the third outcome in
       `underFence` and the callback runs, cursor and all, inside a mailbox that is gone. */
    const s = await seedMailbox();
    await beat(SA);
    const fence = makeSyncWriteFence(db as never, s.mailboxId, SA);

    const remover = await sql.reserve();
    let blocked = false;
    let ran = 0;
    let out: Awaited<ReturnType<typeof fence.transaction>> | null = null;
    try {
      await remover`begin`;
      await remover`update mailboxes set status = 'disabled' where id = ${s.mailboxId}::uuid`;

      const pending = fence.transaction(async (r) => {
        ran++;
        return r.upsertMailboxFolder(s.mailboxId, "INBOX", { uidValidity: "1", uidNext: 63, highestModseq: "0" });
      });
      blocked = await waitForLockWait();
      await remover`commit`;
      out = await pending;
    } finally {
      await remover.release();
    }

    expect(blocked, "the fence never parked on the row — this is the sequential case again").toBe(true);
    expect({ fenced: out!.fenced, removed: out!.removed },
      "the parked fence read the mailbox as live after a removal committed under it")
      .toEqual({ fenced: false, removed: "disabled" });
    expect(ran, "the write group ran inside a mailbox that had gone").toBe(0);
    expect(await db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, s.mailboxId)),
      "a removed mailbox gained a cursor").toHaveLength(0);
  }, 30_000);

  it("costs the fenced cycle ZERO second questions, and the unfenced one keeps its own", async () => {
    /* THE POINT OF THE CHANGE, measured rather than argued. `mailboxStatusForWrite` IS the second
       statement: one per fenced write group and one per ingest commit, for a fact the fence's own
       opening `FOR UPDATE` was already holding. A cycle with a fence must ask it ZERO times; the
       same cycle WITHOUT one must keep asking, because there is no other read of that row. */
    const counted = (): { repo: ReturnType<typeof makeDrizzleRepo>; asks: () => number } => {
      let n = 0;
      const wrap = (t: object): ReturnType<typeof makeDrizzleRepo> => new Proxy(t, {
        get(obj, prop, receiver): unknown {
          const value = Reflect.get(obj, prop, receiver);
          if (prop === "transaction" && typeof value === "function") {
            return (fn: (r: object) => Promise<unknown>): Promise<unknown> =>
              (value as (f: (r: object) => Promise<unknown>) => Promise<unknown>)
                .call(obj, (tx) => fn(wrap(tx)));
          }
          if (prop !== "mailboxStatusForWrite" || typeof value !== "function") return value;
          return (...args: unknown[]): Promise<unknown> => {
            n++;
            return (value as (...a: unknown[]) => Promise<unknown>).apply(obj, args);
          };
        },
      }) as ReturnType<typeof makeDrizzleRepo>;
      return { repo: wrap(makeDrizzleRepo(db as unknown as Tx) as object), asks: () => n };
    };

    const fenced = await seedMailbox();
    await beat(SA);
    const a = counted();
    await runSyncCycle({
      ...depsFor(fenced, fakeAdapter({ batch: oneCreateBatch })), repo: a.repo,
    });

    const plain = await seedMailbox();
    const b = counted();
    const { fence: _drop, ...unfenced } = depsFor(plain, fakeAdapter({ batch: oneCreateBatch }));
    await runSyncCycle({ ...unfenced, repo: b.repo } as SyncDeps);

    expect({ withFence: a.asks(), withoutFence: b.asks() > 0 },
      "the fenced cycle still pays for the question its own lock already answered, or the "
      + "unfenced one stopped asking it at all")
      .toEqual({ withFence: 0, withoutFence: true });
    expect(await db.select().from(messages).where(eq(messages.mailboxId, fenced.mailboxId)),
      "the fenced cycle wrote nothing — a count of zero questions from a cycle that never ran")
      .toHaveLength(1);
  }, 30_000);

  it("the lost() tripwire stops the cycle before any write is attempted", async () => {
    const s = await seedMailbox();
    await beat(SA); // the heartbeat still names A — the tripwire alone must stop the cycle
    const deps = depsFor(s, fakeAdapter({ batch: oneCreateBatch }), () => true);

    await expect(runSyncCycle(deps)).rejects.toBeInstanceOf(LeaderFencedError);
    expect(await db.select().from(messages).where(eq(messages.mailboxId, s.mailboxId))).toHaveLength(0);
    expect(await db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, s.mailboxId))).toHaveLength(0);
  });
});
