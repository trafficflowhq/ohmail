import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { eq, inArray } from "drizzle-orm";
import { mailboxes, mailboxCredentials, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, type Logger } from "@trafficflow/core";
import { startWorkerWithLock } from "../src/index.js";
import { isDriverWriteRace } from "../src/driver-write-race.js";
import { acquireLeaderLock, leaderLockKeyFor, type LeaderLock } from "../src/leader-lock.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { byMessageId } from "./_workerdb.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A SHARED DATABASE FAULT IS NOT THIRTEEN MAILBOX FAULTS
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE DEFECT. `cycle()` exempted three classes — `LeaderFencedError`, `LeaseUnavailableError`,
 * `ClassifierFaultError` — and counted every other throw against the mailbox that happened to be
 * mid-cycle. Postgres failing is not selective: it fails the first mailbox, then the second, then
 * the rest, once per pass. At `maxSyncFailures` the whole shard walks into quarantine one mailbox
 * at a time, each with `status='error'` on a customer's row and an exponential backoff earned
 * against a provider that answered every request correctly — and the shard stays dark for the
 * length of that ladder AFTER the database comes back. The outage outlives its own cause.
 *
 * ── WHY THIS FILE IS ON REAL POSTGRES AND WHY IT DRIVES A TCP PROXY ──────────────────────────
 *
 * Because the defect is a question about what postgres.js THROWS, and a fake cannot answer it.
 * Measured on :5433 while this fix was designed (the table is in `db-fault.ts`): a Postgres that
 * is not listening produces `AggregateError` with `code: "ECONNREFUSED"` — the same `name` and the
 * same `code` a dead IMAP host produces. So the fix could not be a predicate over the error, and a
 * test that injects a hand-built `Error` would be testing the predicate against the author's own
 * guess about the driver rather than against the driver.
 *
 * `pg_terminate_backend` was tried first and DOES NOT WORK as an injection here: postgres.js@3.4.9
 * never settles the promise for the statement in flight, so the guard cannot report its own result
 * (the same finding an earlier review fix recorded when it removed its crash test). Cutting the transport is what
 * produces the real shape.
 *
 * ── THE LOCK CONNECTION IS DELIBERATELY *NOT* BEHIND THE PROXY ───────────────────────────────
 *
 * `acquireLeaderLock` holds a dedicated session whose `onclose` resolves `lost`, so cutting EVERY
 * connection would take the advisory lock down and quiesce the whole worker — a different code
 * path (the fence's), and one that would hide the behaviour under test. Splitting them is also the
 * PRODUCTION topology rather than a test convenience: the lock runs on the session-mode URL and
 * the sync loop on the transaction pooler, so "the pooler dropped our connections while the lock
 * session survived" is the exact shape of a pooler incident.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
let DB = "";

type Db = ReturnType<typeof makeDb>;

/**
 * Shard 0 of 1, the production default — and safe to share with every other worker test because
 * this file owns a DEDICATED database. Postgres advisory locks are scoped to the database, which
 * is the property `_isolateddb.ts` already relies on ("makes the per-shard advisory lock
 * uncontended by the rest of the suite"); the heartbeat row is likewise this database's own.
 */
const SHARD = 0;

/**
 * A TCP pass-through in front of Postgres, with a switch.
 *
 * `cut()` stops accepting AND destroys every live socket — the transport is simply gone, which is
 * what a pooler falling over looks like from the client: in-flight statements die with
 * `CONNECTION_CLOSED` and every reconnect is refused with a bare `ECONNREFUSED`.
 *
 * ── WHAT THIS FIXTURE MEASURED ABOUT postgres.js, WHICH THE ASSERTIONS BELOW DEPEND ON ───────
 *
 * The driver backs its reconnects off as `(0.5 + rand/2) · min(3^retries / 100, 20)` seconds
 * (`postgres@3.4.9/src/index.js#backoff`) on a counter SHARED across the pool, and resets it only
 * on a connect that completes. Five pooled connections therefore drive the delay to the twenty
 * second cap inside the first second of an outage: measured here, ONE cycle met the fault and the
 * next seventeen seconds were silent.
 *
 * That is why `maxSyncFailures` is 1 in this file — see `cfgFor`. It is not a shortcut. It is the
 * only way to make "no mailbox was quarantined" a claim about the CLASSIFICATION rather than a
 * claim about how many cycles happened to fit in the window.
 */
class DbProxy {
  private server: net.Server | null = null;
  private readonly live = new Set<net.Socket>();
  port = 0;

  constructor(private readonly host: string, private readonly target: number) {}

  async listen(port = 0): Promise<void> {
    const server = net.createServer((client) => {
      const upstream = net.createConnection({ host: this.host, port: this.target });
      this.live.add(client);
      this.live.add(upstream);
      const drop = (): void => { this.live.delete(client); this.live.delete(upstream); };
      const kill = (): void => { client.destroy(); upstream.destroy(); drop(); };
      client.on("error", kill);
      upstream.on("error", kill);
      client.on("close", kill);
      upstream.on("close", kill);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    const addr = server.address();
    this.port = typeof addr === "object" && addr !== null ? addr.port : port;
    this.server = server;
  }

  /**
   * The database goes away.
   *
   * `end()` (a FIN, after node has flushed whatever is buffered) rather than `destroy()`, and the
   * difference is not politeness. postgres.js@3.4.9 defers writes through
   * `setImmediate(nextWrite)` and `nextWrite` reads `socket.write` unguarded
   * (`src/connection.js:254`) — so a socket destroyed with a write still buffered makes the
   * driver throw `TypeError: Cannot read properties of null (reading 'write')` from a timer, as an
   * UNCAUGHT EXCEPTION with no query to attach it to. Measured here: it appeared in roughly one
   * run in three and failed the file with both tests green. Ending the socket lets the buffered
   * write flush first, which closes the race. The connection is destroyed a tick later so nothing
   * lingers.
   */
  cut(): void {
    this.server?.close();
    this.server = null;
    for (const s of this.live) {
      s.end();
      setTimeout(() => { s.destroy(); }, 50).unref();
    }
    this.live.clear();
  }

  /** …and comes back, on the same address. */
  async restore(): Promise<void> {
    if (!this.server) await this.listen(this.port);
  }

  async stop(): Promise<void> {
    this.cut();
  }
}

async function seedMailbox(db: Db, accountId = randomUUID()): Promise<{ accountId: string; mailboxId: string }> {
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

function urlVia(url: string, port: number): string {
  const u = new URL(url);
  u.hostname = "127.0.0.1";
  u.port = String(port);
  return u.toString();
}

function cfgFor(fleet: FakeAdapterFleet, databaseUrl: string, over: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl, keyProvider: KP, pollIntervalMs: 150, sentDomain: "trafficflow.test",
    adapterFactory: fleet.factory,
    // ONE, not the production three, and this is what makes the negative assertions mean
    // something. At one, a SINGLE counted failure is a quarantine — so "nothing was quarantined"
    // is a statement about how the fault was CLASSIFIED and cannot be satisfied by an outage that
    // was merely too short to reach a threshold. It has to be: postgres.js's shared reconnect
    // backoff delivers about one cycle-path fault per outage before it stalls for twenty seconds
    // (see `DbProxy`), so a threshold of three would be unreachable in any sane test window.
    //
    // It also raises the bar for the CONTROL below rather than lowering it: a provider fault gets
    // exactly one chance to be misread as shared before it must quarantine.
    maxSyncFailures: 1,
    mailboxRetryMs: 60_000, shardIndex: SHARD,
    rosterIntervalMs: 300, lockHeartbeatMs: 30_000, alertIntervalMs: 60_000,
    ...over,
  };
}

/**
 * A logger that counts events — the probe for "the window really was long enough".
 *
 * `fleet.syncs` cannot be that probe and the reason is itself part of the fix: `runSyncCycle`
 * rebuilds its cursor FROM THE DATABASE before it calls `changesSince`, so during the outage the
 * provider is never dialled at all and the fake's counter does not move. That is the correct
 * behaviour — an outage of ours must not spend a customer's provider round trips — but it means
 * "no quarantine happened" would otherwise be indistinguishable from "no cycle was attempted".
 * Counting the fault OBSERVATIONS ties the window directly to `maxSyncFailures`.
 */
function countingLogger(counts: Map<string, number>, ids?: Map<string, Set<string>>): Logger {
  /* The mailbox id is recorded beside the count because a COUNT cannot be attributed. `stats()`
     publishes numbers over the whole database, so on a box where anything else has left a mailbox
     row behind, "no mailbox was quarantined" is a claim about somebody else's rows as well as this
     run's — and it read 2 at every load and at both code tips. The id lets the assertion name the
     two rows this case created; the numbers are then read as DELTAS. */
  const note = (event: string, fields?: Record<string, unknown>): void => {
    counts.set(event, (counts.get(event) ?? 0) + 1);
    const id = fields?.["mailboxId"];
    if (ids && typeof id === "string") {
      const seen = ids.get(event) ?? new Set<string>();
      seen.add(id);
      ids.set(event, seen);
    }
  };
  const self: Logger = {
    level: "debug",
    child: () => self,
    debug: (event, fields) => note(event, fields),
    info: (event, fields) => note(event, fields),
    warn: (event, fields) => note(event, fields),
    error: (event, fields) => note(event, fields),
  };
  return self;
}

/**
 * A mailbox row this run did NOT create, parked behind a backoff — the co-tenant that flipped the
 * arm above. No credential row: the roster's restart-seed path reads `retry_after` before it ever
 * tries to attach, so a row is enough. Returned with its own deleter, which afterEach drains.
 */
async function seedForeignQuarantined(db: Db): Promise<{ mailboxId: string; remove: () => Promise<void> }> {
  const [row] = await db.insert(mailboxes).values({
    accountId: randomUUID(), provider: "imap", address: `${randomUUID()}@foreign.test`,
    status: "error", errorCode: "provider_refused", retryCount: 1,
    retryAfter: new Date(Date.now() + 60_000),
  }).returning();
  const mailboxId = row!.id;
  return { mailboxId, remove: async () => { await db.delete(mailboxes).where(eq(mailboxes.id, mailboxId)); } };
}

/**
 * THIS RUN'S quarantined mailboxes, read off its own rows.
 *
 * `stats().quarantined` counts mailbox rows across the whole DATABASE, and a delta over a
 * baseline still moves when a row nobody here created parks mid-case — this arm read 2 in a
 * full-suite run and 0 alone, with the classification correct both times. Quarantine is a ROW
 * state, so the scoped reading is the rows, by id, and nothing else can enter it.
 */
async function quarantinedOwn(db: Db, own: Iterable<string>): Promise<string[]> {
  const ids = [...own];
  if (ids.length === 0) return [];
  const rows = await db.select().from(mailboxes).where(inArray(mailboxes.id, ids));
  return rows
    .filter((r) => r.status === "error" || r.retryAfter !== null || r.retryCount > 0)
    .map((r) => r.id)
    .sort();
}

/**
 * Has the outage reached a sync cycle AT ALL — under the fix or without it?
 *
 * `worker_database_fault` is this fix's arm; `sync_cycle_failed` is the arm the throw lands on
 * when the exemption is removed. A probe that named only the first would make every assertion
 * after it unreachable under mutation, and a guard whose mutation run reports "timed out" instead
 * of naming the harm is a guard nobody has watched fail properly.
 */
const outageMet = (counts: Map<string, number>): boolean =>
  (counts.get("worker_database_fault") ?? 0) + (counts.get("worker_database_fault_repeat") ?? 0)
  + (counts.get("sync_cycle_failed") ?? 0) > 0;

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

/**
 * postgres.js@3.4.9 throws from a TIMER when a connection closes with a write still buffered.
 *
 * This file recognised the shape with a local predicate while it was somebody else's defect. It is
 * now closed: the matcher, the measurement and the reasons an upgrade and a vendor patch
 * were both declined live in `apps/worker/src/driver-write-race.ts`, and `index.ts` hands it to
 * `installCrashHandlers` as the one shape a worker survives. Imported rather than restated, so the
 * production match and this file's exemption cannot drift apart — if the matcher ever stops
 * recognising the driver's throw, THIS file goes red too.
 */

describe("a shared database fault never becomes a per-mailbox quarantine", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_dbfault"); }, 120_000);

  /**
   * Vitest's own `uncaughtException` listeners are PARKED for the length of each test and every
   * throw is re-offered to them EXCEPT the driver race above — so a genuine escape still fails the
   * run exactly as it would have, and the file cannot go green by suppressing the class of failure
   * it exists to detect. `escaped` is asserted empty by each test.
   */
  const escaped: unknown[] = [];
  let parked: Array<(err: Error, origin: NodeJS.UncaughtExceptionOrigin) => void> = [];

  beforeEach(async () => {
    await truncateAll(DB);
    escaped.length = 0;
    parked = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    process.on("uncaughtException", (err, origin) => {
      if (isDriverWriteRace(err)) return;
      escaped.push(err);
      for (const l of parked) l(err, origin);
    });
  }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  let live: DbProxy | null = null;
  afterEach(async () => {
    // FIRST, and unconditionally: a test that failed with the transport cut would otherwise be
    // torn down against a dead database, and `worker.stop()` waits on an in-flight cycle. The
    // shutdown would hang and the report would be a hook timeout instead of the real failure.
    if (live) { try { await live.restore(); } catch { /* ignore */ } }
    // LIFO — the worker stops before the lock is released and before the transport goes away.
    for (const c of closers.splice(0).reverse()) { try { await c(); } catch { /* ignore */ } }
    live = null;
    process.removeAllListeners("uncaughtException");
    for (const l of parked) process.on("uncaughtException", l);
    // The budget is the hook's, not the default ten seconds: a MUTATION run leaves the worker
    // holding quarantined mailboxes and a dead pool, and its shutdown is genuinely slower than a
    // green run's. A hook that times out there reports "Hook timed out" instead of the assertion
    // that named the defect, and it takes the next test's shard lock with it.
  }, 60_000);

  async function proxyToDb(): Promise<DbProxy> {
    const proxy = new DbProxy("127.0.0.1", Number(new URL(DB).port || 5432));
    await proxy.listen();
    closers.push(() => proxy.stop());
    live = proxy;
    return proxy;
  }

  /** Start a worker whose SYNC pool is behind `proxy` and whose leader lock is not. */
  async function startBehind(
    fleet: FakeAdapterFleet, proxy: DbProxy, over: Partial<WorkerConfig> = {},
  ): Promise<Awaited<ReturnType<typeof startWorkerWithLock>>> {
    const lock: LeaderLock | null = await acquireLeaderLock(DB, leaderLockKeyFor(SHARD));
    if (!lock) throw new Error("the shard lock was already held in this file's own database");
    closers.push(async () => { await lock.release(); });
    const worker = await startWorkerWithLock(cfgFor(fleet, urlVia(DB, proxy.port), over), lock);
    closers.push(() => worker.stop());
    return worker;
  }

  it("kills the database mid-cycle: nothing is quarantined, nothing backs off, and it resumes", async () => {
    const db = makeDb(DB);
    const proxy = await proxyToDb();

    const fleet = new FakeAdapterFleet();
    const counts = new Map<string, number>();
    const a = await seedMailbox(db);
    const b = await seedMailbox(db);
    fleet.behave(a.mailboxId, { deliver: [{ from: "anna@x.example", subject: "before", messageId: "dbf-a1@x" }] });

    const quarantinedIds = new Map<string, Set<string>>();
    const own = new Set([a.mailboxId, b.mailboxId]);
    /* THE CO-TENANT, present from the first roster pass: a parked mailbox row this case did not
       create, of the kind another run leaves behind. Seeded here rather than left to chance so
       the arm below is measured in the condition it used to fail in. `afterEach` drains it. */
    const foreign = await seedForeignQuarantined(db);
    closers.push(foreign.remove);
    const worker = await startBehind(fleet, proxy, { logger: countingLogger(counts, quarantinedIds) });
    /* `>=`, not `===`: the number counts every mailbox row in the database, and this file's
       database is shared with whatever else runs against it. That this run's own two are attached
       is proved by the two message waits below, which name their mailboxes. */
    await waitFor(() => worker.stats().mailboxes >= 2, 20_000, "both mailboxes attached");
    // Mail flows THROUGH THE PROXY first, so the cut below is a change of state rather than a
    // fixture that never worked.
    await waitFor(async () => (await db.select().from(messages)
      .where(byMessageId(a.mailboxId, "dbf-a1@x"))).length === 1, 20_000, "the first message to land");

    // ── THE DATABASE GOES AWAY MID-CYCLE ──────────────────────────────────────────────────
    //
    // This is the shape the ORIGIN TAG exists for: postgres.js reports it as a bare
    // `ECONNREFUSED` with no SQLSTATE, identical in `name` and in `code` to a dead IMAP host, so
    // no predicate over the error could tell the two apart. Measured, not assumed — the table is
    // in `db-fault.ts`.
    /* THE BASELINE, taken while the database is healthy and the roster has settled. B and A, on
       the same state: the database-wide count HAS the foreign parked row, the scoped read does
       not — so a scoped read that passed by seeing nothing at all would fail the first line. */
    await waitFor(() => worker.stats().quarantined >= 1, 20_000, "the foreign parked row to be seeded");
    expect(await quarantinedOwn(db, own), "a mailbox of this run was parked before the outage")
      .toEqual([]);
    const quarantinedBefore = worker.stats().quarantined;
    const attachedBefore = worker.stats().mailboxes;

    proxy.cut();

    // 1. Wait on a signal that exists in BOTH worlds — the fault reaching a cycle at all — rather
    //    than on this fix's own telemetry. Waiting on `databaseFaultSince` would make every
    //    assertion below unreachable the moment the exemption is removed, so the mutation run
    //    would report "the guard timed out" instead of naming the harm.
    //
    //    THIS WAIT CAUGHT AND THE FIRST DIAGNOSIS OF IT WAS WRONG — recorded because the
    //    wrong one is the tempting one. It began timing out in FULL-SUITE runs while passing in
    //    isolation, which is the exact signature of a flake, and the first fix attempted was to
    //    widen this budget past postgres.js's twenty-second reconnect backoff (the hazard step 5
    //    below genuinely does document). That was DISPROVED by raising it to 90 s and watching it
    //    fail identically: the events were not late, they were absent. Dumping `counts` on timeout
    //    named the cause in one run — `mailbox_sync_stamp_failed: 2` and no `sync_cycle_failed` at
    //    all, i.e. both mailboxes were PAST `runSyncCycle` when the cut landed (which a concurrent
    //    rotation makes a wide window) and every remaining write was inside a best-effort catch
    //    that swallowed the fault. `index.ts#noteIfSharedDatabaseFault` is the fix. The budget is
    //    unchanged at 30 s, which is the correct value and always was.
    await waitFor(() => outageMet(counts), 30_000, "the outage to reach a cycle");
    // One cycle's worth of settle. Under the defect the quarantine lands in the SAME cycle that
    // counted the failure — the `toQuarantine` pass runs immediately after the rotation loop —
    // so this window is generous rather than hopeful.
    await new Promise((r) => setTimeout(r, 1_500));

    // 2. THE HARM, asserted first. `maxSyncFailures` is ONE in this file, so the fault that was
    //    just delivered is by itself enough to quarantine anything it is counted against: this is
    //    a claim about how the fault was CLASSIFIED, not about how long the window was.
    //
    //    READ OFF THIS RUN'S OWN ROWS. A delta over `stats().quarantined` was the previous form
    //    and it is not scoped: the number counts every mailbox row in the database, so any row
    //    that parks between the baseline and here moves it, whoever owns it.
    expect(await quarantinedOwn(db, own), "our outage quarantined a customer's mailbox").toEqual([]);
    // B, beside A: the foreign parked row is still in the database-wide count, so the scoped
    // read above is narrow rather than blind.
    expect(worker.stats().quarantined, "the foreign parked row left the database-wide count")
      .toBeGreaterThanOrEqual(quarantinedBefore);
    expect(worker.stats().mailboxes, "our outage detached a healthy mailbox")
      .toBeGreaterThanOrEqual(attachedBefore);

    // 3. …and it is recognised as what it is, on the surface that still works when Postgres does
    //    not — `/health` reads this out of memory and touches no database.
    expect(worker.stats().databaseFaultSince, "the shard-wide condition was never named").not.toBeNull();
    expect(worker.stats().degraded, "a worker syncing nothing must not read as healthy").toBe(true);

    // 4. And it stays ONE incident: the loud line is edge-triggered, however many cycles meet the
    //    fault. One outage produced one `mailbox_quarantined` line PER MAILBOX before this fix;
    //    the requirement is one alert, not one per mailbox.
    expect(counts.get("worker_database_fault"), "the shard-wide condition was announced more than once").toBe(1);
    /* The lines are this worker's own — the logger is per instance — but the MAILBOX they name may
       not be, so the assertion is over the two rows this case created. */
    expect([...(quarantinedIds.get("mailbox_quarantined") ?? [])].filter((id) => own.has(id)),
      "a mailbox of this run was quarantined by our own outage").toEqual([]);

    // ── AND COMES BACK ────────────────────────────────────────────────────────────────────
    await proxy.restore();
    fleet.behave(b.mailboxId, { deliver: [{ from: "anna@x.example", subject: "after", messageId: "dbf-b1@x" }] });

    // 5. The condition CLEARS on the one thing that proves the database is writable again, and
    //    says so once.
    //
    // The budget is generous BECAUSE OF THE DRIVER rather than because recovery is vague:
    // postgres.js will not retry a connection until its own backoff elapses, and that delay is
    // capped at twenty randomised seconds (see `DbProxy`). So the worst case is one capped delay
    // plus a cycle — and a 30 s budget was measured flaking on exactly that.
    await waitFor(() => worker.stats().databaseFaultSince === null, 90_000, "the condition to clear");
    expect(counts.get("worker_database_recovered")).toBe(1);

    // 6. The rows were never touched. No `status='error'`, no error code, and — the field that
    //    outlives a restart and drives the backoff ladder — `retry_count` still zero.
    for (const mb of [a, b]) {
      const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.mailboxId));
      expect(row!.status, `mailbox ${mb.mailboxId} was quarantined by OUR outage`).not.toBe("error");
      expect(row!.errorCode).toBeNull();
      expect(row!.retryCount, "a backoff was earned against a provider that did nothing").toBe(0);
    }

    // 7. Recovery is real: mail that arrived during the outage is ingested once the DB is back,
    //    with no operator action and no re-attach. This is the assertion the quarantine ladder
    //    breaks — a mailbox parked behind `mailboxRetryMs` does not come back when Postgres does.
    await waitFor(async () => (await db.select().from(messages)
      .where(byMessageId(b.mailboxId, "dbf-b1@x"))).length === 1, 60_000, "mail to flow again");

    // 8. Nothing but the known driver race reached the process. A database outage must not be a
    //    crash — that is the 2026-08-02 failure with a different socket.
    expect(escaped, "an error escaped to the process during the outage").toEqual([]);
  }, 240_000);

  /**
   * THE CONTROL, and the assertion that keeps the exemption from becoming the inverse defect.
   *
   * Everything above is satisfied just as well by a worker that has stopped quarantining
   * ANYTHING, which would be the ground undone: a mailbox whose provider genuinely refuses us
   * has to leave the rotation, or a dead IDLE connection is retried for ever and `/health` keeps
   * counting it as if it were serving. Same fixture, same database, one difference — the failure
   * comes from the ADAPTER.
   *
   * THE THROWN VALUE IS `ECONNREFUSED` ON PURPOSE, and that is the whole point of this test rather
   * than a detail of it. It is the SAME `name` and the SAME `code` postgres.js produces when
   * Postgres is not listening (`db-fault.ts`), so this is the one case where the two answers are
   * indistinguishable from the error alone and the classification can only come from origin. A
   * `failSync: true` plain Error would prove nothing here: it carries no code, so it survives even
   * a predicate widened all the way to `classifyIngestFault(...).domain === "infrastructure"` —
   * the very mutation this test exists to redden.
   */
  it("still quarantines a genuine provider fault, with the database perfectly healthy", async () => {
    const db = makeDb(DB);
    const proxy = await proxyToDb();

    const fleet = new FakeAdapterFleet();
    const a = await seedMailbox(db);
    const b = await seedMailbox(db);

    const own = new Set([a.mailboxId, b.mailboxId]);
    const worker = await startBehind(fleet, proxy);
    // `>=` here and a scoped read below, for the reason the case above records: `stats()` counts
    // the whole database, and the quarantine this case DEMANDS is a state of its own two rows.
    await waitFor(() => worker.stats().mailboxes >= 2, 20_000, "both mailboxes attached");

    // One mailbox's provider starts refusing, in the shape a dead IMAP host actually produces.
    // The database is untouched throughout.
    fleet.behave(a.mailboxId, {
      syncError: Object.assign(new Error("the provider refused the connection"), { code: "ECONNREFUSED" }),
    });

    await waitFor(async () => {
      const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, a.mailboxId));
      return row!.status === "error";
    }, 30_000, "the failing mailbox to be quarantined");

    const [failed] = await db.select().from(mailboxes).where(eq(mailboxes.id, a.mailboxId));
    expect(failed!.retryCount, "a provider fault must still earn its backoff").toBeGreaterThanOrEqual(1);
    expect(await quarantinedOwn(db, own), "the provider fault quarantined nothing, or the wrong row")
      .toEqual([a.mailboxId]);
    // …and it was attributed to the mailbox, not to the shard.
    expect(worker.stats().databaseFaultSince, "a provider fault was read as a database fault").toBeNull();

    // The bystander is untouched — the isolation half of the same claim.
    const [ok] = await db.select().from(mailboxes).where(eq(mailboxes.id, b.mailboxId));
    expect(ok!.status).not.toBe("error");
    expect(escaped, "an error escaped to the process").toEqual([]);
  }, 120_000);

  /**
   * THE CO-TENANT, which is what made the arm above flip for a month.
   *
   * `stats().quarantined` counts mailbox rows across the DATABASE, and the roster seeds any row
   * whose `retry_after` is in the future into the quarantine map before it attaches anything. So
   * one mailbox row this file never created — left by another run, another checkout, another
   * lane's suite — makes an absolute `toBe(0)` read 2, at every load and at both code tips, while
   * the file's own positive control passes.
   *
   * This case seeds exactly that row and holds both readings side by side: the whole-database
   * number SEES it, and the two scoped readings — the delta and the per-mailbox log line — do not.
   * The database is never cut: the subject here is the reading, not the classification.
   */
  it("a foreign parked mailbox moves the database-wide count and neither scoped read", async () => {
    const db = makeDb(DB);
    const proxy = await proxyToDb();

    const fleet = new FakeAdapterFleet();
    const counts = new Map<string, number>();
    const quarantinedIds = new Map<string, Set<string>>();
    const a = await seedMailbox(db);
    const own = new Set([a.mailboxId]);
    const foreign = await seedForeignQuarantined(db);
    closers.push(foreign.remove);

    const worker = await startBehind(fleet, proxy, { logger: countingLogger(counts, quarantinedIds) });
    await waitFor(() => worker.stats().mailboxes >= 1, 20_000, "this run's mailbox to attach");
    await waitFor(() => worker.stats().quarantined >= 1, 20_000, "the foreign parked row to be seeded");

    // A — the unscoped reading. This is the assertion this file used to make, and the row it is
    // about belongs to nobody here: `toBe(0)` fails on it with the database perfectly healthy.
    expect(worker.stats().quarantined, "the foreign row is invisible to the database-wide count")
      .toBeGreaterThanOrEqual(1);

    // B — the scoped readings, on the same state. The delta over a baseline taken here is zero,
    // and no `mailbox_quarantined` line names the mailbox this case created.
    const quarantinedBefore = worker.stats().quarantined;
    await new Promise((r) => setTimeout(r, 1_500));
    expect(worker.stats().quarantined, "the count moved with no fault at all").toBe(quarantinedBefore);
    expect(await quarantinedOwn(db, own), "the foreign row entered this run's scoped read")
      .toEqual([]);
    expect([...(quarantinedIds.get("mailbox_quarantined") ?? [])].filter((id) => own.has(id)),
      "this run's mailbox was quarantined with the database healthy").toEqual([]);
    expect(worker.stats().databaseFaultSince, "a parked row was read as a database fault").toBeNull();
    expect(escaped, "an error escaped to the process").toEqual([]);
  }, 120_000);
});
