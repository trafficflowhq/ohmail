import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import type { HeartbeatInput } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, mailboxes, MAILBOX_SYNC_BLOCK_REASONS, ClosedSetViolation } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { workerHeartbeats, writeHeartbeat, clearHeartbeat } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import {
  markMailboxFailed, markMailboxReadLimited, markMailboxConnected, markMailboxStoodDown,
  markMailboxSyncBlocked, clearMailboxSyncBlock, type LeaderFence,
} from "../src/mailboxes.js";

/**
 * THE TWO MAILBOX LIFECYCLE WRITES ARE FENCED — asserted against a real Postgres.
 *
 * Both were `UPDATE mailboxes SET … WHERE id = ?` and nothing else: last-writer-wins across a
 * leader handoff and across the user's own disconnect. An external `max`-effort review found
 * all three shapes (and the boundary below), and PGlite is blind to this class —
 * three production bugs in this repository were invisible to it and appeared only here. What
 * makes these assertions worth anything is that the predicate is evaluated by the same planner,
 * against the same `worker_heartbeats` row, with the same driver as production.
 *
 * ── WHY THE FENCE IS `worker_heartbeats` AND NOT A NEW COLUMN ────────────────────────────
 *
 * The heartbeat row already IS the leader epoch: `writeHeartbeat` claims it atomically on
 * takeover (upsert on `shard_index`, overwriting `instance_id`), and `refreshHeartbeat` already
 * refuses a surrendered leader's late pulse against exactly `(shard, instance, leader = true)`.
 * Reusing that predicate means one definition of "am I still the leader of this shard" rather
 * than a second one to keep in step — and no migration, which matters because a fence that has
 * to ship behind a schema change is a fence that is absent for the duration of the deploy.
 */

const AVAILABLE = await realPgAvailable();

const beatOf = (shardIndex: number, instanceId: string): HeartbeatInput => ({
  shardIndex, instanceId, shards: 1,
  mailboxes: 1, expected: 1, accounts: 1, quarantined: 0,
  /* REQUIRED, and it was missing: every `writeHeartbeat(db, beatOf(...))` in this file was a
     TS2345 the test-dir ratchet was pinning, seventeen of them, because the fixture is not a
     `HeartbeatInput`. `null` is the closed circuit, which is what a fenced-write fixture wants to
     say about the AI provider — the classifier is not what these cases are about. Typed on the
     return so the next field added to the input lands here as one error rather than seventeen. */
  aiCircuitOpenSince: null,
  degraded: false, lastCycleAt: null, startedAt: new Date(),
});

describe.skipIf(!AVAILABLE)("mailbox lifecycle writes are fenced", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;
  /** A shard index of this file's own, so a parallel worker test's beats cannot collide. */
  const SHARD = 97;
  const A: LeaderFence = { shardIndex: SHARD, instanceId: "wkr-A" };
  const B: LeaderFence = { shardIndex: SHARD, instanceId: "wkr-B" };

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  beforeEach(async () => {
    await db.delete(workerHeartbeats).where(eq(workerHeartbeats.shardIndex, SHARD));
  });

  const seed = async (status: string): Promise<string> => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `fence-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `fence-${accountId.slice(0, 8)}@example.test`, status,
    }).returning();
    return mb!.id;
  };

  const rowOf = async (id: string) =>
    (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;

  // ── · the user's disconnect outranks a lifecycle write that started before it ────────

  it("a recovery in flight cannot resurrect a mailbox the user disconnected", async () => {
    // The sequence from the finding: a quarantined mailbox begins a long recovery from an
    // `error` snapshot — connect + lease + folders + IDLE, and then a completed sync cycle, which
    // since that change is where the recovery write actually happens and is still minutes on a real
    // provider. Mid-flight the user disconnects it: `status='disabled'`, credentials deleted.
    // Unfenced, the recovery then wrote `connected` by id and the mailbox was back on the
    // roster — `loadEnabledMailboxes` selects everything that is not `disabled` — with its
    // runtime still attached, permanently.
    const id = await seed("error");
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-A"));

    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, id));

    const written = await markMailboxConnected(db, id, { fence: A });
    expect(written, "the fenced write reported success").toBe(false);
    expect((await rowOf(id)).status, "a disconnected mailbox was re-attached").toBe("disabled");
  });

  it("a failure write cannot quarantine — and so re-roster — a disconnected mailbox", async () => {
    // The mirror image, and it is not cosmetic: `status='error'` is ON the roster (quarantine
    // is a retry state), so an unfenced failure write puts a disconnected mailbox back into the
    // worker's duty and keeps it there behind a backoff.
    const id = await seed("disabled");
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-A"));

    const written = await markMailboxFailed(db, id, { code: "auth", detail: null }, { fence: A });
    expect(written).toBe(false);
    expect((await rowOf(id)).status).toBe("disabled");
  });

  // ── · a leader handoff must not persist the loser's view of the world ────────────────

  it("an outgoing leader's late failure write loses to the instance that took the shard", async () => {
    // Worker A loses its session advisory lock with an attach still in flight; worker B
    // acquires the shard, attaches the same mailbox and records a verified recovery. A's
    // attach then fails and writes. Unfenced, COMPLETION ORDER decided the persisted truth and
    // a healthy mailbox was reported broken.
    const id = await seed("error");
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-A"));

    // B takes over: one upsert on `shard_index`, its own `instance_id`. This is the whole
    // handoff — no extra bookkeeping, which is why the fence can be free.
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-B"));
    expect(await markMailboxConnected(db, id, { fence: B })).toBe(true);

    const written = await markMailboxFailed(db, id, { code: "auth", detail: "AUTHENTICATIONFAILED" }, { fence: A });
    expect(written, "the outgoing leader's write landed").toBe(false);

    const row = await rowOf(id);
    expect(row.status, "a stale instance quarantined a mailbox the live leader is serving").toBe("connected");
    expect(row.errorCode).toBeNull();
    expect(row.errorDetail).toBeNull();
  });

  it("and the reverse: a stale recovery cannot clear the live leader's quarantine", async () => {
    const id = await seed("connected");
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-A"));
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-B"));
    expect(await markMailboxFailed(db, id, { code: "tls", detail: "CERT_HAS_EXPIRED" }, { fence: B })).toBe(true);

    expect(await markMailboxConnected(db, id, { fence: A })).toBe(false);
    const row = await rowOf(id);
    expect(row.status).toBe("error");
    expect(row.errorCode).toBe("tls");
    expect(row.errorDetail).toBe("CERT_HAS_EXPIRED");
  });

  it("a SURRENDERED leader writes nothing — `leader = false` closes the fence too", async () => {
    // The lock-loss path clears the heartbeat and then quiesces on the serial queue. Anything
    // that was already in flight when the lock went must not land afterwards: this instance has
    // no evidence it still serves the shard, and a standby may already be attaching.
    const id = await seed("connected");
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-A"));
    await clearHeartbeat(db as unknown as Tx, A);

    expect(await markMailboxFailed(db, id, { code: "sync", detail: null }, { fence: A })).toBe(false);
    expect((await rowOf(id)).status).toBe("connected");
  });

  it("the CONTROL: the live leader's writes go through, both directions", async () => {
    // Without this the four refusals above would be satisfied by a function that never writes.
    const id = await seed("connected");
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-A"));

    expect(await markMailboxFailed(db, id, { code: "storage", detail: "53100" }, { fence: A })).toBe(true);
    let row = await rowOf(id);
    expect(row.status).toBe("error");
    expect(row.errorCode).toBe("storage");
    expect(row.errorDetail).toBe("53100");
    expect(row.failedAt).not.toBeNull();
    expect(row.retryCount).toBe(1);

    expect(await markMailboxConnected(db, id, { fence: A })).toBe(true);
    row = await rowOf(id);
    expect(row.status).toBe("connected");
    expect(row.failedAt).toBeNull();
    expect(row.retryCount).toBe(0);
  });

  // ── · the write site enforces the allowlist, so "single safe write site" is TRUE ──────

  it("markMailboxFailed drops an unsafe `detail` to NULL at the boundary, not at the caller", async () => {
    // `detail` is a `string | null`, so `{ detail: err.message }` TYPECHECKS, there is no
    // database constraint behind the column, and until this clamp existed the "single safe
    // write site" was a convention every caller had to remember. These are the three real
    // shapes from `mailbox-error-redaction.test.ts`, passed straight in as a caller who forgot
    // `mailboxErrorDetail` would pass them.
    const leaky = [
      "new row for relation \"message_bodies\" violates check constraint " +
        "\"message_bodies_html_cap\" DETAIL: Failing row contains (Re: Q3 invoice from anna@example.com",
      "invalid header: From: \"Anna Müller\" <anna.mueller@example.com> Subject: Payroll",
      "LOGIN failed for user mila@lichtgrat.example: invalid credentials",
      // And the attacker-chosen atom that passed the old SHAPE test, handed in directly.
      "SECRETPASSWORD123",
    ];

    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-A"));
    for (const detail of leaky) {
      const id = await seed("connected");
      expect(await markMailboxFailed(db, id, { code: "sync", detail }, { fence: A })).toBe(true);
      const row = await rowOf(id);
      expect(row.status, "the mailbox must still be quarantined — an unsafe reason is dropped, not refused").toBe("error");
      expect(row.errorCode).toBe("sync");
      expect(row.errorDetail, detail).toBeNull();
    }
  });

  it("an UNFENCED call still works — the crons and the tests have no leadership to prove", async () => {
    const id = await seed("connected");
    expect(await markMailboxFailed(db, id, { code: "connect", detail: "ECONNREFUSED" })).toBe(true);
    expect((await rowOf(id)).errorDetail).toBe("ECONNREFUSED");
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     MAIL 0029 — THE SYNC-BLOCK PAIR IS FENCED THE SAME WAY, AND THE SET IS CLOSED AT REST
     ══════════════════════════════════════════════════════════════════════════════════════════

     These two writes carry no `status`, which makes it tempting to treat them as harmless
     bookkeeping that needs no fence. They are not. The columns describe THIS PROCESS's
     relationship to the mailbox — "I am not serving it, and here is why" — so a surrendered
     leader's late note about a mailbox a successor is now happily syncing is exactly as stale as
     its late failure write would be, and it lands on a row the account owner reads. Both arms of
     the argument above apply verbatim, which is why they are asserted here rather than
     assumed to be covered.

     And the CHECK is asserted against a REAL catalog for `organizer-lease.pg.test.ts`'s reason:
     the question is "did the migration's DDL actually take", which PGlite cannot answer about a
     database built by the real migrator. */

  it("a sync-block note cannot be written to a mailbox the user disconnected", async () => {
    // The mailbox was unserved (an unreadable lease, say) and the user disconnected it while the
    // roster pass was in flight. `status='disabled'` outranks every worker write, whenever it
    // happened — and this one in particular would leave a tombstone explaining why the worker was
    // not syncing a mailbox nobody asked it to sync.
    const id = await seed("disabled");
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-A"));

    expect(await markMailboxSyncBlocked(db, id, "lease_unreadable", { fence: A })).toBe(false);
    expect((await rowOf(id)).syncBlockedReason).toBeNull();
  });

  it("a SURRENDERED leader writes no sync-block note either", async () => {
    // A standby may already be attaching this mailbox successfully. A note from the instance that
    // has just given up the shard would say "not being served" about a mailbox that is.
    const id = await seed("connected");
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-A"));
    await clearHeartbeat(db as unknown as Tx, A);

    expect(await markMailboxSyncBlocked(db, id, "at_capacity", { fence: A })).toBe(false);
    expect((await rowOf(id)).syncBlockedReason).toBeNull();
    expect(await clearMailboxSyncBlock(db, id, { fence: A })).toBe(false);
  });

  it("an outgoing leader cannot report a mailbox unserved that the new leader is serving", async () => {
    // The sequence, on these columns. A's roster pass decided the lease was unreadable; B took
    // the shard and attached the mailbox; A's write lands afterwards. Unfenced, completion ORDER
    // would decide whether the user sees "not syncing".
    const id = await seed("connected");
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-A"));
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-B"));

    expect(await markMailboxSyncBlocked(db, id, "lease_unreadable", { fence: A })).toBe(false);
    expect((await rowOf(id)).syncBlockedReason).toBeNull();
  });

  it("the CONTROL: the live leader writes it, COALESCEs `since`, and clears both", async () => {
    // Without this the three refusals above are satisfied by a function that never writes.
    const id = await seed("connected");
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-A"));

    const first = new Date("2026-08-03T12:00:00.000Z");
    expect(await markMailboxSyncBlocked(db, id, "lease_unreadable", { fence: A, now: first })).toBe(true);
    let row = await rowOf(id);
    expect(row.syncBlockedReason).toBe("lease_unreadable");
    expect(row.syncBlockedSince!.toISOString()).toBe(first.toISOString());

    // ── `status` AND THE FOUR FAILURE COLUMNS ARE UNTOUCHED ──────────────────────────────
    //
    // The whole slice rests on this. `status='error'` would put the mailbox in the retry rotation
    // with an exponential backoff and tell the user their mailbox is broken about a fault that is
    // OURS; `failed_at` would start an outage episode the next real failure would inherit.
    expect(row.status).toBe("connected");
    expect(row.errorCode).toBeNull();
    expect(row.errorDetail).toBeNull();
    expect(row.failedAt).toBeNull();
    expect(row.retryCount).toBe(0);

    // The REPEAT — `reconcileRoster` writes this every pass while the block lasts, and `coalesce`
    // is what keeps the column answering "since when" rather than "as of the last pass". A moving
    // `since` would make a three-day block report "just now" for ever.
    const later = new Date("2026-08-03T12:30:00.000Z");
    expect(await markMailboxSyncBlocked(db, id, "lease_unreadable", { fence: A, now: later })).toBe(true);
    row = await rowOf(id);
    expect(row.syncBlockedSince!.toISOString(),
      "sync_blocked_since MOVED — a re-observation restarted the clock").toBe(first.toISOString());

    expect(await clearMailboxSyncBlock(db, id, { fence: A })).toBe(true);
    row = await rowOf(id);
    expect(row.syncBlockedReason).toBeNull();
    expect(row.syncBlockedSince).toBeNull();
    expect(row.status).toBe("connected");
  });

  it("REFUSES a reason the set does not name — the write door, before the catalog", async () => {
    // Enumerated FROM THE EXPORTED SET rather than re-typed, so a member added to
    // `MAILBOX_SYNC_BLOCK_REASONS` without being added to the door's set fails HERE with the value
    // named. `sync_blocked_reason` is a widenable set (mail 0029/0102), for which the device store
    // carries no CHECK, so the door — `closedSetValue`, shared by both dialects — is the refusal
    // and it fires BEFORE the write reaches the catalog. The next case proves the server CHECK is
    // still there behind a write that bypasses the door.
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-A"));
    for (const reason of MAILBOX_SYNC_BLOCK_REASONS) {
      const id = await seed("connected");
      expect(await markMailboxSyncBlocked(db, id, reason, { fence: A }),
        `${reason} must be storable`).toBe(true);
      expect((await rowOf(id)).syncBlockedReason).toBe(reason);
    }

    // …and one foreign string, cast past the compiler exactly as a `curl` or a future call site
    // would reach it. Each is a value a SHAPE test would admit: a plausible fourth member, the
    // `no_organizer` the constant's header refuses, a case variant, and the token itself.
    for (const bad of [
      "no_organizer", "lease_unreadable ", "LEASE_UNREADABLE", "SECRETPASSWORD123", "",
    ]) {
      const id = await seed("connected");
      const err = await markMailboxSyncBlocked(db, id, bad as never, { fence: A })
        .then(() => null, (e: unknown) => e);
      expect(err, `${JSON.stringify(bad)} must be refused`).toBeInstanceOf(ClosedSetViolation);
      expect((err as ClosedSetViolation).code).toBe("closed_set_violation");
      expect((err as ClosedSetViolation).set.constraint).toBe("mailboxes_sync_blocked_reason_shape");
      expect((await rowOf(id)).syncBlockedReason, `${JSON.stringify(bad)} reached the row`).toBeNull();
    }
  }, 30_000);

  /** {@link beatOf} typed at the port it is handed to — a new untyped call site would add a
   *  ratchet error of the class every existing one here already carries. */
  const beatFor = (instanceId: string): Parameters<typeof writeHeartbeat>[1] =>
    beatOf(SHARD, instanceId) as unknown as Parameters<typeof writeHeartbeat>[1];

  it("a BOUNDED READ REFUSAL blocks softly: the pair and the backoff, and `error` untouched", async () => {
    /**
     * end to end on a real catalog. A ceiling this codebase sets ended the cycle;
     * the mailbox authenticated and answered. So the row must say `connected` with a reason,
     * carry the next-attempt instant mail 0039 exists for, and record NO error.
     *
     * `markMailboxFailed`'s columns are asserted ABSENT one by one rather than by comparing the
     * whole row: the point of the narrow writer is precisely which columns it does not touch, and
     * a row comparison would pass a writer that cleared them instead of leaving them.
     */
    await writeHeartbeat(db as unknown as Tx, beatFor("wkr-A"));
    const id = await seed("connected");
    // A mailbox with a genuine failure history, so "left alone" is distinguishable from "cleared":
    // both read as absent on a fresh row, which is how a writer that wipes them would pass.
    await markMailboxFailed(db, id, { code: "auth", detail: null }, { fence: A });
    await markMailboxConnected(db, id, { fence: A });
    await db.update(mailboxes).set({ retryCount: 3, errorCode: "timeout" }).where(eq(mailboxes.id, id));

    const due = new Date(Date.now() + 120_000);
    expect(await markMailboxReadLimited(db, id, { fence: A, retryAfter: due })).toBe(true);
    const row = await rowOf(id);
    expect(row.syncBlockedReason, "the soft reason was not written").toBe("read_limited");
    expect(row.syncBlockedSince, "the block has no start").not.toBeNull();
    expect(row.retryAfter?.getTime(), "the backoff did not persist").toBe(due.getTime());
    // …and the four `markMailboxFailed` columns are as they were.
    expect(row.status, "a bounded refusal moved the status").toBe("connected");
    expect(row.errorCode, "a bounded refusal rewrote error_code").toBe("timeout");
    expect(row.failedAt, "a bounded refusal stamped failed_at").toBeNull();
    expect(row.retryCount, "a bounded refusal counted a failure").toBe(3);

    // `since` is COALESCEd, so a repeat while the block lasts keeps the block's own start.
    const first = row.syncBlockedSince!.getTime();
    expect(await markMailboxReadLimited(db, id, { fence: A, retryAfter: due })).toBe(true);
    expect((await rowOf(id)).syncBlockedSince?.getTime(), "a repeat restarted `since`").toBe(first);

    // THE CLEAR, which is the half that makes the block temporary: the next healthy cycle drops
    // the bucket entry and the roster's clear runs — modelled here by its own function, which is
    // the statement `reconcileSyncBlocks` issues.
    expect(await clearMailboxSyncBlock(db, id, { fence: A })).toBe(true);
    const cleared = await rowOf(id);
    expect(cleared.syncBlockedReason, "the reason survived the clear").toBeNull();
    expect(cleared.syncBlockedSince, "the start survived the clear").toBeNull();
    expect(cleared.status, "the clear moved the status").toBe("connected");
  });

  it("names itself in the refusal, so an operator can find the migration", async () => {
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-A"));
    const id = await seed("connected");
    const constraint = await markMailboxSyncBlocked(db, id, "nope" as never, { fence: A })
      .then(() => "", (err: unknown) =>
        err instanceof ClosedSetViolation ? err.set.constraint : "");
    expect(constraint).toBe("mailboxes_sync_blocked_reason_shape");
  });

  it("the server CHECK still refuses what is no reason word, for a write that bypasses the door — 23514, on a real catalog", async () => {
    // The door refuses every non-member for every caller of `markMailboxSyncBlocked`. Since mail
    // 0202 the SERVER's CHECK holds the SHAPE (one lower-case word), not the members: a write that
    // reaches the table another way — a `curl`, a future call site, a migration — cannot store a
    // line a mail server chose, and meets 23514 with the constraint named. Bypassing the door
    // here with raw SQL keeps the constraint a guarded invariant and not a dead one the door
    // hides, and it is a question PGlite cannot answer: did the migration's DDL actually take
    // against the real catalog.
    for (const line of ["Mailbox is full: over quota", "postmaster@provider.test", "LEASE_UNREADABLE", ""]) {
      const id = await seed("connected");
      const err = await sql`update mailboxes set sync_blocked_reason = ${line} where id = ${id}`
        .then(() => null, (e: unknown) => e as { code?: unknown; constraint_name?: unknown; constraint?: unknown });
      expect(String(err?.code ?? "unknown"), `${JSON.stringify(line)} must be refused by the catalog`).toBe("23514");
      expect(String(err?.constraint_name ?? err?.constraint ?? "")).toBe("mailboxes_sync_blocked_reason_shape");
      expect((await rowOf(id)).syncBlockedReason, "the refused write still landed").toBeNull();
    }
    // A word of the right shape that is no member is the door's to refuse, and the catalog takes
    // it: that is what lets a new member arrive without altering this table.
    const id = await seed("connected");
    await sql`update mailboxes set sync_blocked_reason = ${"a_reason_of_next_year"} where id = ${id}`;
    expect((await rowOf(id)).syncBlockedReason).toBe("a_reason_of_next_year");
  });

  it("the three status writers each CLEAR the pair, enumerated from the exported set", async () => {
    // The worker's half of that change. `MailboxService.update` is the fourth writer and is asserted in
    // `packages/services/test/mailbox-failure-state.test.ts`, because it is a service.
    //
    // Enumerated over the reason set rather than one hardcoded reason: a member added to
    // `MAILBOX_SYNC_BLOCK_REASONS` gets all three clears checked for free, which is the only way
    // "every writer clears it" stays true of a set that can grow.
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-A"));
    const writers: Array<[string, (id: string) => Promise<boolean>]> = [
      ["markMailboxFailed", (id) => markMailboxFailed(db, id, { code: "auth", detail: null }, { fence: A })],
      ["markMailboxConnected", (id) => markMailboxConnected(db, id, { fence: A })],
      ["markMailboxStoodDown", (id) => markMailboxStoodDown(db, id, "organized_elsewhere:local", { fence: A })],
    ];

    for (const reason of MAILBOX_SYNC_BLOCK_REASONS) {
      for (const [name, write] of writers) {
        const id = await seed("connected");
        expect(await markMailboxSyncBlocked(db, id, reason, { fence: A })).toBe(true);
        expect(await write(id), `${name} was fenced out`).toBe(true);
        const row = await rowOf(id);
        expect(row.syncBlockedReason, `${name} left ${reason} on the row`).toBeNull();
        expect(row.syncBlockedSince, `${name} left sync_blocked_since on the row`).toBeNull();
      }
    }
  }, 30_000);

  /* ── THE DEMOTION AND ITS HANDOVER ARE ONE TRANSACTION, OR NEITHER HAPPENS ──────────────── */

  /**
   * THE STAND-DOWN'S HANDOVER RIDES THE DEMOTION, AND THE PAIR IS ALL-OR-NOTHING.
   *
   * The gate handed the pending local moves over in a transaction of its OWN, ahead of the
   * demotion, and swallowed its failure. So a demotion could be recorded with an export that did
   * not happen: this install becomes a reader, every not-yet-exported move stays on it, a reader's
   * reconciler skips them, and the install that CAN perform them has never heard of them. The
   * near side shows moves that never reach the mail server, and nothing anywhere failed.
   *
   * `markMailboxStoodDown` takes the consequence as `also` and `applyFenced` runs it inside the
   * same transaction, so the two land together or not at all — which is a claim about a real
   * transaction and therefore belongs in this file rather than beside PGlite.
   *
   * Mutation-checked: running `also` outside the transaction (or after the UPDATE has committed)
   * leaves `organizer_role = 'reader'` with the consequence missing, which is the first assertion.
   */
  it("a handover that THROWS leaves no demotion on the row", async () => {
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-A"));
    const id = await seed("connected");
    const before = await rowOf(id);
    expect(before.organizerRole, "the fixture must start as the organizer").toBe("organizer");

    const landed = await markMailboxStoodDown(db, id, "organized_elsewhere:local", {
      fence: A,
      also: async () => { throw new Error("the handover could not be written"); },
    }).then(() => "landed", (err: unknown) => (err instanceof Error ? err.message : "?"));

    expect(landed, "the failure was swallowed").toBe("the handover could not be written");
    const after = await rowOf(id);
    expect(after.organizerRole, "the demotion was recorded with its handover missing")
      .toBe("organizer");
    expect(after.organizedByKind, "the holder columns landed without the handover").toBeNull();
  }, 30_000);

  it("…and a handover that SUCCEEDS lands with the demotion — the positive control", async () => {
    /* The half that makes the case above mean something: a rule whose only evidence is a refusal
       has none that it admits the ordinary case, and here the ordinary case is every stand-down. */
    await writeHeartbeat(db as unknown as Tx, beatOf(SHARD, "wkr-A"));
    const id = await seed("connected");
    let ran = 0;
    const written = await markMailboxStoodDown(db, id, "organized_elsewhere:local", {
      fence: A,
      also: async () => { ran += 1; },
    });
    expect(written).toBe(true);
    expect(ran, "the consequence did not run").toBe(1);
    expect((await rowOf(id)).organizerRole).toBe("reader");
  }, 30_000);
});
