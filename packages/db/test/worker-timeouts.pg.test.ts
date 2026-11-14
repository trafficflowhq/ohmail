import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { makeOwnedDb, POOLED_TIMEOUTS, WORKER_TIMEOUTS } from "../src/client.js";
import { HANDLE_TABLE } from "../src/handle-table.js";
import { sql } from "drizzle-orm";

/**
 * THE OUTAGE THESE PREVENT, AND IT ALREADY HAPPENED.
 *
 * 2026-08-01, production: Neon storage filled while backfilling a real mailbox.
 * A transaction that could not commit left a backend `idle in transaction` holding row locks
 * on `messages`. Every worker that restarted took the leader advisory lock, began ingesting,
 * and blocked on `transactionid` — FOREVER, because a Postgres lock wait has no default
 * ceiling. It held the advisory lock while wedged, so no standby could take over; it never
 * finished a cycle, so it never wrote a heartbeat; and `sync_lag` could not page because the
 * alert pass runs inside the worker that was dark. Two restarts and a full redeploy wedged
 * identically. The shard was down and the only evidence was an absence.
 *
 * Nothing in the application could have escaped that: it is a server-side wait, so only a
 * server-side deadline ends it. Hence three, each aimed at a different half of the deadlock —
 * and this file exists because "we set some timeouts" is a claim, and the claim is that they
 * reach a real connection.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const AVAILABLE = await realPgAvailable();

describe("WORKER_TIMEOUTS — the values", () => {
  it("bounds all three of the waits that can hang a shard", () => {
    // Named individually so removing one is a visible edit rather than a smaller object.
    expect(WORKER_TIMEOUTS.lock_timeout).toBeGreaterThan(0);
    expect(WORKER_TIMEOUTS.statement_timeout).toBeGreaterThan(0);
    expect(WORKER_TIMEOUTS.idle_in_transaction_session_timeout).toBeGreaterThan(0);
    // A lock wait must give up BEFORE a statement does, or `statement_timeout` masks it and
    // the error names the wrong cause.
    expect(WORKER_TIMEOUTS.lock_timeout).toBeLessThanOrEqual(WORKER_TIMEOUTS.statement_timeout);
    // …and every ceiling must be well under the 15-minute sync-lag alert, or the alert fires
    // before the database has finished rescuing itself.
    for (const v of Object.values(WORKER_TIMEOUTS)) expect(v).toBeLessThan(15 * 60_000);
  });

  it("is applied to the factory every worker entry uses, and NOT to the others", () => {
    // `makeOwnedDb` is what `apps/worker`'s index and all four crons construct: the worker's cell
    // of the handle's table (its connections are read live below).
    expect(HANDLE_TABLE.worker.session.connection).toBe(WORKER_TIMEOUTS);
    // The leader-lock session is deliberately exempt: its only statement is a non-blocking
    // `pg_try_advisory_lock` and it MUST stay open and idle for the lock's whole lifetime —
    // `idle_in_transaction_session_timeout` would end the lock it exists to hold.
    const lock = readFileSync(`${HERE}../../../apps/worker/src/leader-lock.ts`, "utf8");
    expect(lock).not.toMatch(/WORKER_TIMEOUTS/);
    // ── THIS ASSERTION USED TO PIN A DEFECT, AND ITS PURPOSE IS UNCHANGED ─────────────────
    //
    // It read "…and NOT to the serverless handle, which has the platform's own maxDuration",
    // and that reasoning cost hundreds of production gateway timeouts (see `POOLED_TIMEOUTS`). What is
    // still true — and still worth forbidding — is that the WORKER's numbers must not be reused
    // there: a 60 s `statement_timeout` behind a 60 s platform kill is a race the platform wins,
    // so copying them would look like a fix and change nothing.
    //
    // The consumer is NAMED rather than the check relaxed: every pooled cell must carry its own
    // set, sized against the platform ceiling instead of the sync-lag alert.
    for (const role of ["api", "staff", "roster"] as const) {
      const pooled = HANDLE_TABLE[role].pooler;
      expect(pooled.prepare, role).toBe(false);
      expect(pooled.connection, role).not.toBe(WORKER_TIMEOUTS);
      expect(pooled.connection, role).toBe(POOLED_TIMEOUTS);
    }
  });
});

describe.skipIf(!AVAILABLE)("WORKER_TIMEOUTS — against a real backend", () => {
  beforeAll(() => { /* no migrations needed: these assert session settings, not schema */ });

  it("the settings actually reach the session (a comment is not a connection option)", async () => {
    const owned = makeOwnedDb(PG_TEST_URL);
    try {
      const rows = await owned.db.execute(sql`select current_setting('lock_timeout') as lock,
        current_setting('statement_timeout') as stmt,
        current_setting('idle_in_transaction_session_timeout') as idle`);
      const r = ((rows as { rows?: unknown[] }).rows ?? (rows as unknown[]))[0] as Record<string, string>;
      // Postgres reports these as strings with units: NOT "0" (no limit), and the worker's own.
      expect(r.lock).not.toBe("0");
      expect(r.stmt).not.toBe("0");
      expect(r.idle).not.toBe("0");
      expect([r.lock, r.stmt, r.idle]).toEqual(["30s", "1min", "1min"]);
    } finally {
      await owned.close();
    }
  }, 60_000);

  it("THE REGRESSION: a blocked row lock GIVES UP instead of waiting for ever", async () => {
    // The production shape, reproduced: one session holds a row lock inside an open
    // transaction, a worker connection tries to touch the same row. Before the ceiling that
    // second statement never returned, and the whole shard stopped behind it.
    const holder = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    const owned = makeOwnedDb(PG_TEST_URL);
    try {
      await holder`create table if not exists tf_lock_probe (id int primary key, n int)`;
      await holder`insert into tf_lock_probe (id, n) values (1, 0) on conflict (id) do update set n = 0`;
      // Hold the row and DO NOT commit — exactly the zombie's state.
      const held = holder.begin(async (tx) => {
        await tx`update tf_lock_probe set n = n + 1 where id = 1`;
        await new Promise((r) => setTimeout(r, 40_000));   // outlives the 30s lock_timeout
      });

      await new Promise((r) => setTimeout(r, 400));        // let the lock land
      const started = Date.now();
      const err = await owned.db
        .execute(sql`update tf_lock_probe set n = n + 1 where id = 1`)
        .then(() => null)
        .catch((e: unknown) => e as { code?: string });

      // 55P03 = lock_not_available. The wait ENDED, and it ended for the right reason.
      expect(err, "the blocked statement must fail, not hang").not.toBeNull();
      expect(err?.code).toBe("55P03");
      // …and it ended near the ceiling rather than at some unrelated timeout.
      expect(Date.now() - started).toBeLessThan(WORKER_TIMEOUTS.lock_timeout + 15_000);

      await held.catch(() => { /* the holder is torn down below */ });
    } finally {
      await owned.close();
      await holder`drop table if exists tf_lock_probe`.catch(() => {});
      await holder.end({ timeout: 5 });
    }
  }, 120_000);
});
