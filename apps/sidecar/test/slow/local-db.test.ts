import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir, uptime as osUptime } from "node:os";
import { join } from "node:path";
import { eq, getTableName } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
// `cloudSchema` is imported HERE on purpose: a test may name what the engine must not create.
// `apps/sidecar/src` may not — it reaches the mail half through `@trafficflow/db/mail`, and
// `packages/db/test/schema-split.test.ts` is what holds it to that.
import { accounts, mailboxFolders, mailboxes, messageBodies, messages, sessions, users } from "@trafficflow/db";
import { cloudSchema } from "@trafficflow/db/cloud";
import { DataDirLockedError, LOCK_FILE, openLocalDb, type OpenLocalDb } from "../../src/db.js";
import { inStoreLane } from "../../src/store-lanes.js";
import { ensureLocalWorld, mintLaunchSession } from "../../src/identity.js";

/**
 * THE LOCAL MIRROR ON REAL DISK.
 *
 * The standing warning is that PGlite green means nothing for transactional code — three
 * production bugs were invisible to it. That warning is about PGlite standing in for Postgres. Here
 * PGlite IS the production target for this tier, so the things worth asserting are the ones a
 * Postgres-backed test could never have covered: that a directory survives a restart, that the
 * migrate sequence is idempotent against a populated one, and that two processes cannot open the
 * same one.
 */

/**
 * THE CRASH CHILD — `openLocalDb` in a process of its own, because a crash test has to be a real
 * process; it runs the source through tsx, so a stale `dist` cannot measure old code. It writes the
 * mirror's own shape: one transaction per message,
 * carrying the row AND the folder cursor that names it. Nothing here may be clever — a `finally`,
 * a flush on exit or a clean close would defeat the whole cell.
 */
const SIDECAR_DIR = fileURLToPath(new URL("../..", import.meta.url));
const SIDECAR_DB_ENTRY = fileURLToPath(new URL("../../src/db.ts", import.meta.url));
/* The child names its lane the way the engine does (`engine.ts` wraps the cycle in it), because
   the relaxation this cell measures lives inside the ingest's transaction and nowhere else. */
const SIDECAR_LANES_ENTRY = fileURLToPath(new URL("../../src/store-lanes.ts", import.meta.url));
const CRASH_ACCOUNT = "00000000-0000-4000-8000-0000000c7a54";

const CRASH_CHILD = `
import { openLocalDb } from "__DB__";
import { inStoreLane } from "__LANES__";
// PRODUCTION'S checkpointer, at a test's pace: the same timer openLocalDb arms for every launch
// ({@link CHECKPOINT_INTERVAL_MS}, five minutes), shortened so a cell of a few seconds contains
// several. Without it nothing after the setup is ever durable and the cell asks nothing.
const h = await openLocalDb("__DIR__", { checkpointIntervalMs: 750 });
// READ FROM INSIDE AN INGEST TRANSACTION, which is the only place it is ever off: a session read
// answers "on" by design now, and a child reporting the session would say nothing about the write
// this cell then kills.
await inStoreLane("ingest", () => h.db.transaction(async (tx) => {
  const g = await tx.execute("show synchronous_commit");
  process.stdout.write("synchronous_commit " + String(Object.values((g.rows ?? g)[0])[0]) + "\\n");
}));
const acct = "${CRASH_ACCOUNT}";
await h.db.execute("insert into accounts (id, name) values ('" + acct + "', 'crash')");
const mb = await h.db.execute(
  "insert into mailboxes (account_id, provider, address) values ('" + acct + "', 'imap', 'me@ohmail.test') returning id");
const mailboxId = String(Object.values((mb.rows ?? mb)[0])[0]);
const fd = await h.db.execute(
  "insert into mailbox_folders (mailbox_id, folder, uidnext) values ('" + mailboxId + "', 'INBOX', 1) returning id");
const folderId = String(Object.values((fd.rows ?? fd)[0])[0]);
// The fixture is made durable BEFORE the ingest, because the checkpoint is the boundary the whole
// cell is about: what is behind it must survive the kill, what is in front of it need not.
await h.checkpoint();
process.stdout.write("checkpointed\\n");
await inStoreLane("ingest", async () => {
for (let uid = 1; ; uid += 1) {
  // THE SYNC CYCLE'S OWN ORDER (apps/worker/src/sync.ts): one transaction per message, and the
  // folder cursor written AFTER a batch of them, in a transaction of its own. That order is the
  // deciding line — crash recovery replays a PREFIX of the log, so a cursor committed after the
  // rows it acknowledges can be lost with them but can never outlive them. The whole loop runs in
  // the ingest lane, as the engine runs a cycle, so every one of these commits is the relaxed one.
  await h.db.transaction(async (tx) => {
    await tx.execute(
      "insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, native_locator) values ('"
      + acct + "', '" + mailboxId + "', 'h" + uid + "', 'crash:" + uid + "', 's" + uid
      + "', 'a@mail.example', '{\\"folder\\":\\"INBOX\\",\\"ref\\":\\"1:" + uid + "\\"}'::jsonb)");
  });
  if (uid % 10 === 0) {
    await h.db.transaction(async (tx) => {
      await tx.execute("update mailbox_folders set uidnext = " + (uid + 1) + " where id = '" + folderId + "'");
    });
    // A TURN OF THE EVENT LOOP, which the real cycle takes between batches and a bare loop over
    // an in-process store never does: PGlite answers from WASM, so an unbroken chain of awaited
    // statements is an unbroken chain of MICROTASKS and the timer phase never runs. Without this
    // the checkpointer above is starved for the whole run and nothing is ever made durable.
    await new Promise((r) => setTimeout(r, 0));
  }
  process.stdout.write("committed " + uid + "\\n");
}
});
`;

const dirs: string[] = [];
const open: OpenLocalDb[] = [];

/**
 * The two readings the lock record is built from, re-derived HERE rather than imported.
 *
 * Deliberately a second implementation, which is the opposite of this repository's usual rule and
 * is right for exactly this case: a planted lock must be built from the OPERATING SYSTEM, not
 * from the function under test. Importing `selfLockRecord` would make the "matches" case assert
 * that a function agrees with itself, and it would pass over an implementation that read the
 * wrong `/proc` field consistently in both places.
 */
function bootIdOrUndefined(): string | undefined {
  try {
    const raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return raw === "" ? undefined : raw;
  } catch {
    return undefined;
  }
}

function selfStartTicks(): number | undefined {
  try {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    const ticks = Number.parseInt(after[19] ?? "", 10);
    return Number.isInteger(ticks) ? ticks : undefined;
  } catch {
    return undefined;
  }
}

function tempDir(): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-sidecar-db-"));
  dirs.push(d);
  return d;
}
async function openTracked(dir: string): Promise<OpenLocalDb> {
  const o = await openLocalDb(dir);
  open.push(o);
  return o;
}

/** WAL segment files on disk. `pg_wal` also holds `archive_status/`, which is not one. */
function walSegments(pgDataDir: string): number {
  return readdirSync(join(pgDataDir, "pg_wal")).filter((f) => /^[0-9A-F]{24}$/.test(f)).length;
}

/**
 * THE LOG IN SEGMENTS, by the store's own settings and INSERT pointer (never the write pointer,
 * which sits still in `wal_buffers` under the ingest's relaxed commit — `walGrownSince` in db.ts).
 * PGlite runs min_wal_size above max_wal_size, so a checkpoint RECYCLES old segments into future
 * names up to max_wal_size and deletes nothing below it: `pg_wal` is a high-water mark of the log
 * between two checkpoints, which one late checkpoint raises and nothing lowers.
 */
async function walLog(o: OpenLocalDb, since = "0/0"): Promise<{ at: string; generated: number; maxSegments: number }> {
  const seg = "pg_size_bytes(current_setting('wal_segment_size'))";
  const r = await o.db.execute(`select pg_current_wal_insert_lsn()::text as at, ((pg_current_wal_insert_lsn() - `
    + `'${since}'::pg_lsn) / ${seg})::int as generated, (pg_size_bytes(current_setting('max_wal_size')) / ${seg})::int as max`);
  const row = r.rows[0] as { at: string; generated: number | string; max: number | string };
  return { at: row.at, generated: Number(row.generated), maxSegments: Number(row.max) };
}

/**
 * Open, and answer a ONE-WORD VERDICT — never the handle, and never the raw error.
 *
 * Two traps, both measured while mutating the lock rule, and the second is the nastier:
 *
 *  1. when a refusal breaks, `openLocalDb` RESOLVES, and a handle nothing tracks is left live
 *     while `afterEach` removes its directory. So the handle is tracked here before anything
 *     else happens.
 *  2. `expect(handle).toBeInstanceOf(DataDirLockedError)` then fails — and to render that
 *     failure vitest must pretty-print the RECEIVED value, which is a live PGlite instance: a
 *     deep, cyclic object graph over a WASM heap. Walking it allocated four gigabytes and the
 *     worker died with `FATAL ERROR: Reached heap limit` and `Worker exited unexpectedly`,
 *     twice, on two different mutations. That is indistinguishable from a flake, it names
 *     nothing, and it is exactly the shape to fear — a failure that reports as
 *     something else.
 *
 * So nothing large ever reaches an assertion: this answers a string.
 */
async function openOutcome(dir: string): Promise<"refused" | "opened"> {
  return openLocalDb(dir).then(
    (o) => { open.push(o); return "opened" as const; },
    (e: unknown) => (e instanceof DataDirLockedError ? "refused" as const : Promise.reject(e)),
  );
}

afterEach(async () => {
  for (const o of open.splice(0)) await o.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("openLocalDb", () => {
  it("creates, migrates and persists across a close/reopen", async () => {
    const dir = tempDir();
    const first = await openTracked(dir);
    const world = await ensureLocalWorld(first.db, { address: "me@ohmail.test", now: new Date() });
    await first.close();

    // The whole point of on-disk: a relaunch finds the mailbox it left.
    const second = await openTracked(dir);
    const rows = await second.db.select().from(mailboxes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(world.mailboxId);
    expect(rows[0]!.address).toBe("me@ohmail.test");
  }, 120_000);

  /**
   * THE STORE'S OWN MEMORY IS A FLOOR, NOT A PER-MESSAGE COST.
   *
   * `storeBytes` exists so a rise in the engine's `rss` can be attributed rather than argued
   * about, and the property that makes it worth reporting is the one asserted here: the WASM heap
   * Postgres runs inside does not scale with the mailbox: it measured constant from an empty
   * store through a mailbox five times the one seeded here, where a per-message cost would
   * already be plain.
   *
   * The `> 0` arm is the other half: a reader that answers 0 puts a fabricated floor on every log
   * line, which reads as a measurement.
   */
  it("reports the STORE's own heap, and it does not grow with the mailbox", async () => {
    const dir = tempDir();
    const opened = await openTracked(dir);
    const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date() });

    const empty = opened.storeBytes();
    expect(empty, "the store reports no heap at all — the reading is not a measurement").toBeGreaterThan(0);

    const text = "x".repeat(2048);
    for (let written = 0; written < 5000; written += 500) {
      const ids = await opened.db.insert(messages).values(
        Array.from({ length: 500 }, (_, i) => ({
          accountId: world.accountId, mailboxId: world.mailboxId, bodyHash: `h${written + i}`,
          dedupKey: `store:${written + i}`, subject: `msg ${written + i}`,
          fromAddress: `s${(written + i) % 40}@mail.example`, unread: true,
          nativeLocator: { folder: "INBOX", ref: `1:${1000 + written + i}` },
        })),
      ).returning({ id: messages.id });
      await opened.db.insert(messageBodies).values(ids.map((r) => ({ messageId: r.id, text })));
    }
    // A read over the whole pile, so the reading covers a query as well as the writes.
    expect(await opened.db.select({ id: messages.id }).from(messages)).toHaveLength(5000);

    const full = opened.storeBytes();
    /* A QUARTER, and the band is generous on purpose: the claim is "not proportional to the
       mail", so an allocator that grows a little must not redden this, and a per-message cost
       cannot hide under it — the seeded bodies are ~10 MB of text alone. */
    expect(
      full,
      `the store's heap grew with the mailbox: ${empty} → ${full} bytes over the seeded mailbox`,
    ).toBeLessThanOrEqual(Math.round(empty * 1.25));
  }, 300_000);

  /**
   * Write enough to grow `pg_wal` past its `min_wal_size` pool, so that reclaiming a segment means
   * DELETING one rather than merely recycling it and the count on disk moves.
   *
   * Per-row hex, not a repeated character: Postgres compresses a large uniform value down to almost
   * nothing before it reaches the log, so a `repeat('x', …)` fixture generates a fraction of the
   * write-ahead log its size suggests and quietly understates the churn.
   */
  async function churnWal(o: OpenLocalDb, rounds: number): Promise<void> {
    await o.db.execute("create table if not exists wal_churn (id int primary key, blob text)");
    for (let round = 0; round < rounds; round++) {
      await o.db.execute(
        "insert into wal_churn (id, blob) select g, (select string_agg(md5(g::text || s::text || " +
        `${round}), '') from generate_series(1, 200) s) from generate_series(1, 400) g ` +
        "on conflict (id) do update set blob = excluded.blob",
      );
    }
  }

  /**
   * THE WRITE-AHEAD LOG, WHILE THE APP IS RUNNING.
   *
   * PGlite runs Postgres as a single-user standalone backend, so there is no postmaster and
   * therefore no checkpointer process. `max_wal_size` and `checkpoint_timeout` are both instructions
   * TO that process, so with it absent no checkpoint is taken for as long as the process lives and
   * every segment ever written stays on disk. Measured before this guard was written: 200 MB of
   * churn left `pg_control_checkpoint()` still naming initdb's redo segment, one 1 MB file per
   * megabyte written, none recycled.
   *
   * The two ENDS of a run are already covered by Postgres itself, and are deliberately not asserted
   * here as if this code did them: a clean close takes the shutdown checkpoint and a start over a
   * crashed directory takes the end-of-recovery one — both measured at 170 segments down to 64. What
   * nothing covered was the middle, which on a mail app open for days is the entire exposure. So the
   * assertion is made INSIDE one open handle, and it is the segment count, because the count is what
   * fills a disk.
   */
  it("reclaims write-ahead log segments WITHOUT closing, because nothing else does while it is open", async () => {
    const dir = tempDir();
    const o = await openTracked(dir);
    await churnWal(o, 60);

    const grown = walSegments(o.pgDataDir);
    expect(grown, "the churn produced no write-ahead log to reclaim").toBeGreaterThan(100);

    const dropped = await o.checkpoint();
    const after = walSegments(o.pgDataDir);
    expect(dropped, "the checkpoint reclaimed nothing").toBeGreaterThan(0);
    expect(
      after,
      `pg_wal still holds ${after} segments in a session that never ends — this is how a data ` +
        "directory ends up mostly write-ahead log",
    ).toBeLessThan(grown);
  }, 300_000);

  /**
   * THE PROPERTY THE INTERVAL EXISTS FOR: sustained writing does not grow the log without end, and
   * the quit that follows still fits in the shell's grace.
   *
   * The method above proves a checkpoint reclaims; this proves something CALLS it, and that what it
   * bounds stays bounded across repeated cycles rather than being reclaimed once and then growing
   * again. Both halves matter — a checkpoint taken exactly once at open would pass the first test
   * and leave an app that is open for days exactly where it started.
   *
   * The ceiling is expressed against what ONE cycle grows the log by, so it is a statement about
   * boundedness rather than a magic number: four cycles of identical churn must not leave four
   * cycles' worth of segments on disk.
   */
  it("keeps the log bounded across sustained writing, and still closes inside the quit grace", async () => {
    /**
     * THE UNBOUNDED FIGURE IS MEASURED HERE, NOT PINNED AT 100 — and it had to be, because the
     * number moved under a fix in another file.
     *
     * This read `oneCycle > 100` from the handle below, whose checkpointer is set to 100 ms and
     * never actually ran: a churn loop is an unbroken chain of microtasks and PGlite answers from
     * WASM in this process, so the loop's timer phase never got a turn. `store-lanes.ts` hands out
     * every admission on the check phase, the timer fires, the checkpointer keeps up — and one
     * cycle now grows the log to about ten segments, which is this case's own claim arriving as a
     * failed precondition. So the growth is read from a handle whose checkpointer is out of the way.
     */
    const unreclaimedDir = tempDir();
    const unreclaimed = await openLocalDb(unreclaimedDir, { checkpointIntervalMs: 10 * 60_000 });
    open.push(unreclaimed);
    await churnWal(unreclaimed, 60);
    expect(
      walSegments(unreclaimed.pgDataDir),
      "the churn produced no write-ahead log to bound, even with nothing reclaiming it",
    ).toBeGreaterThan(100);

    // A production interval is five minutes; this one is short enough to observe.
    const dir = tempDir();
    const o = await openLocalDb(dir, { checkpointIntervalMs: 100 });
    open.push(o);

    await churnWal(o, 60);
    const oneCycle = walSegments(o.pgDataDir);

    let peak = oneCycle;
    for (let cycle = 0; cycle < 3; cycle++) {
      await churnWal(o, 60);
      // Give the timer a tick to land; it shares PGlite's queue with the churn above.
      const deadline = Date.now() + 20_000;
      while (walSegments(o.pgDataDir) > oneCycle && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      peak = Math.max(peak, walSegments(o.pgDataDir));
    }

    expect(
      peak,
      `pg_wal reached ${peak} segments over four cycles of churn that one cycle grows to ` +
        `${oneCycle} — nothing is reclaiming it, so the log grows for the life of the process`,
    ).toBeLessThanOrEqual(oneCycle);

    // AND THE QUIT. `close()` takes Postgres' own shutdown checkpoint, which is only fast because
    // the log above it is bounded; `apps/desktop/src-tauri/src/engine.rs` kills the engine after
    // this long, so a close that does not fit is a process killed mid-write.
    const STOP_GRACE_MS = 5_000;
    const began = Date.now();
    await o.close();
    expect(Date.now() - began, "closing the database did not fit inside the shell's quit grace")
      .toBeLessThan(STOP_GRACE_MS);
  }, 600_000);

  /**
   * THE SAME PROPERTY IN THE OTHER COMMIT MODE — the one mail actually arrives in.
   *
   * The case above churns the way everything-but-the-ingest writes: the session waits for every
   * flush, so the log is drained at each commit and the checkpointer only has to reclaim segments.
   * Inside the ingest's transaction nothing waits ({@link INGEST_SYNCHRONOUS_COMMIT} in `db.ts`),
   * and there the checkpoint is the only flush there is — which is the mode in which an unbounded
   * log would go unnoticed until a disk filled. So the claim is made again with the drain's own
   * shape: many small transactions, named as `engine.ts` names them, against the same checkpointer.
   *
   * Measured while it was written: 60 such rounds leave 41 segments with nothing reclaiming, 14
   * with the checkpointer running, and four cycles of the same churn stay at 14.
   */
  it("keeps the log bounded while the INGEST is writing, where a commit does not wait", async () => {
    const ROUNDS = 60;
    /* The ingest's shape, not the statement above's: a hundred rows per TRANSACTION, in the lane
       the engine wraps a cycle in, so every commit here is the relaxed one. */
    async function churnAsIngest(o: OpenLocalDb): Promise<void> {
      await o.db.execute("create table if not exists wal_churn (id int primary key, blob text)");
      await inStoreLane("ingest", async () => {
        for (let round = 0; round < ROUNDS; round++) {
          await o.db.transaction(async (tx) => {
            await tx.execute(
              "insert into wal_churn (id, blob) select g, (select string_agg(md5(g::text || s::text || " +
              `${round}), '') from generate_series(1, 200) s) from generate_series(1, 100) g ` +
              "on conflict (id) do update set blob = excluded.blob");
          });
        }
      });
    }

    const dir = tempDir();
    const o = await openLocalDb(dir, { checkpointIntervalMs: 100 });
    open.push(o);

    /* THE MODE, FIRST AND FROM THE HANDLE UNDER TEST. A store that answered "on" here would pass
       everything below for the reason the case above already covers, and this cell would be a
       second copy of it. */
    const mode = await inStoreLane("ingest", () => o.db.transaction(async (tx) => {
      const r = await tx.execute("show synchronous_commit");
      return String(Object.values(r.rows[0] ?? {})[0]);
    }));
    expect(mode, "the ingest's transaction waits for the flush — this is the other mode again")
      .toBe("off");

    // What the same churn leaves with nothing reclaiming, so the bound below is a bound on
    // something: a production interval is five minutes and this handle never reaches one.
    const unreclaimedDir = tempDir();
    const unreclaimed = await openLocalDb(unreclaimedDir, { checkpointIntervalMs: 10 * 60_000 });
    open.push(unreclaimed);
    await churnAsIngest(unreclaimed);
    const grew = walSegments(unreclaimed.pgDataDir);
    expect(grew, "the ingest churn produced no write-ahead log to bound").toBeGreaterThan(30);

    const from = (await walLog(o)).at;
    await churnAsIngest(o);
    const oneCycle = walSegments(o.pgDataDir);
    expect(oneCycle, "the checkpointer reclaimed nothing at all while the ingest wrote")
      .toBeLessThan(grew);

    // Bounded by the store's setting and ONE unreclaimed cycle, never by the first cycle's reading:
    // that is a high-water mark a later checkpoint interval may raise (see `walLog`).
    let peak = oneCycle;
    for (let cycle = 0; cycle < 3; cycle++) {
      await churnAsIngest(o);
      peak = Math.max(peak, walSegments(o.pgDataDir));
    }
    const log = await walLog(o, from);
    const bound = Math.min(grew, log.maxSegments);
    expect(log.generated, `four cycles generated ${log.generated} segments, under twice the bound ${bound}`)
      .toBeGreaterThan(2 * bound);
    expect(
      peak,
      `pg_wal reached ${peak} segments over four cycles of ingest churn (${log.generated} generated); one ` +
        `cycle with nothing reclaiming leaves ${grew} and max_wal_size is ${log.maxSegments} — with ` +
        "commits that never flush, the checkpoint is the only thing that does",
    ).toBeLessThan(bound);

    const STOP_GRACE_MS = 5_000;
    const began = Date.now();
    await o.close();
    expect(Date.now() - began, "closing after an ingest run did not fit inside the quit grace")
      .toBeLessThan(STOP_GRACE_MS);
  }, 300_000);

  it("re-running the mail migrate against a populated directory applies nothing", async () => {
    // This is the desktop upgrade path: a new release ships new migrations, the first launch
    // replays only what is missing. If the sequence were not idempotent it would replay every mail
    // migration over a live local database — the exact failure `adoptBaseline` exists to prevent.
    const dir = tempDir();
    const first = await openTracked(dir);
    const before = await first.db.execute("select count(*)::int as c from drizzle_mail.__drizzle_migrations");
    await first.close();

    const second = await openTracked(dir);
    const after = await second.db.execute("select count(*)::int as c from drizzle_mail.__drizzle_migrations");
    expect((after.rows[0] as { c: number }).c).toBe((before.rows[0] as { c: number }).c);
    expect((after.rows[0] as { c: number }).c).toBeGreaterThan(0);
  }, 120_000);

  /**
   * **THE CLOUD HALF IS NOT HERE, AND THIS IS THE ASSERTION THAT SAYS SO.**
   *
   * The line above used to end with "…and the cloud journal is there too: the local schema is the
   * SHARED schema, not a subset" — the sidecar ran both journals because production does. What
   * that actually produced was `credentials`, `credit_ledger`, `billing_subscriptions` and
   * `staff_users` in the database of somebody with no account, no subscription and no operator,
   * and it required the private journal's SQL to be packaged inside the shipped application,
   * because the migrator reads those files off disk at runtime.
   *
   * So the claim is inverted, and it is asserted on the CATALOG rather than on the migrations
   * table: a table that arrived by any other route — a stray import, a future `createApp`
   * dependency that migrates on demand — fails here just the same.
   */
  it("creates NO Cloud table — the local database is the mail half and nothing else", async () => {
    const dir = tempDir();
    const opened = await openTracked(dir);

    const cloudSchemas = await opened.db.execute(
      "select count(*)::int as c from information_schema.schemata where schema_name = 'drizzle_cloud'");
    expect((cloudSchemas.rows[0] as { c: number }).c,
      "the cloud journal ran against a desktop install").toBe(0);

    const named = Object.keys(cloudSchema);
    const present = await opened.db.execute(
      "select table_name from information_schema.tables where table_schema = 'public'");
    const tables = new Set((present.rows as Array<{ table_name: string }>).map((r) => r.table_name));
    // Spelled from the cloud schema object rather than from a list written here, so a table added
    // to the private half is covered the day it is added.
    const leaked = named.map((k) => getTableName(cloudSchema[k as keyof typeof cloudSchema]))
      .filter((t) => tables.has(t));
    expect(leaked, "Cloud tables were created in a local install's database").toEqual([]);

    // …and the mail half really is there, so the check above is not passing on an empty database.
    expect(tables.has("messages") && tables.has("mailboxes")).toBe(true);
  }, 120_000);

  it("refuses a second opener while the first holds the directory", async () => {
    // PGlite has no cross-process locking. Two engines on one directory corrupt it, and the
    // symptom arrives long after the cause.
    const dir = tempDir();
    await openTracked(dir);
    await expect(openLocalDb(dir)).rejects.toBeInstanceOf(DataDirLockedError);
    await expect(openLocalDb(dir)).rejects.toThrow(/already open by pid/);
  }, 120_000);

  it("reclaims a lock left behind by a process that is gone", async () => {
    // A lock that outlived a crash would mean a user whose laptop lost power cannot open their
    // mail. `kill(pid, 0)` is the probe; a pid nobody holds releases it.
    const dir = tempDir();
    writeFileSync(join(dir, LOCK_FILE), "2147483600\n"); // a pid that cannot exist
    const o = await openTracked(dir);
    expect(o.dataDir).toBe(dir);
  }, 120_000);

  /**
   * ── A RECYCLED PID IS A LIVE PID, AND IT USED TO HOLD A MAILBOX SHUT FOR EVER ────────────
   *
   * "A pid that is gone releases it" was only half a rule. The other half is what a laptop
   * actually does: power is lost, the machine reboots, the pid counter starts again, and some
   * unrelated process is issued the number the dead engine wrote down. `kill(pid, 0)` says
   * "alive", so the directory was held by a process that has never heard of this mailbox — with
   * no way out except telling somebody to delete a file.
   *
   * THE PLANTED LOCK NAMES A PID THAT IS CERTAINLY ALIVE — this very test process. It is the only
   * pid a test can be sure of, and it is the exact shape of the defect: alive, and not ours.
   */
  it("takes over a lock whose pid is alive but is NOT the process that wrote it", async () => {
    const dir = tempDir();
    /* `startTicks` is the process's start in clock ticks since boot, and this one cannot be the
       running process's: 1 is a handful of milliseconds after boot, before any user process
       exists. So the record says "pid N, started at tick 1" and the live pid N did not. */
    writeFileSync(join(dir, LOCK_FILE), `${JSON.stringify({
      pid: process.pid,
      startTicks: 1,
      bootId: bootIdOrUndefined(),
      bootAtMs: Date.now() - osUptime() * 1000,
    })}\n`);
    const o = await openTracked(dir);
    expect(o.dataDir).toBe(dir);
  }, 120_000);

  /**
   * THE SAME MACHINE, THE SAME BOOT, THE SAME PROCESS — and it must still be refused.
   *
   * The case above must not be reachable by a rule that simply distrusts every lock. A record
   * that matches the live process in every respect is a running engine, and taking that
   * directory would put two PGlite instances on one file tree, which corrupts it.
   */
  it("still refuses a lock whose identity MATCHES the live process", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, LOCK_FILE), `${JSON.stringify({
      pid: process.pid,
      startTicks: selfStartTicks(),
      bootId: bootIdOrUndefined(),
      bootAtMs: Date.now() - osUptime() * 1000,
    })}\n`);
    expect(
      await openOutcome(dir),
      "a lock matching the live process in every respect was taken anyway — two engines on one directory",
    ).toBe("refused");
  }, 120_000);

  /**
   * ── A MOVED CLOCK IS NOT A REBOOT, AND TREATING IT AS ONE CORRUPTS THE DATABASE ──────────
   *
   * This case asserted the opposite for one revision, and the opposite was wrong. `bootAtMs` is
   * `Date.now() - os.uptime()`, so it moves whenever the WALL CLOCK moves: an NTP step after a
   * long suspend, a machine whose RTC battery is dead, a VM resuming, somebody correcting the
   * date. On a host with no `/proc` — macOS, Windows — that arithmetic was the only test being
   * applied, so a clock correction while an engine was LIVE let the next launch unlink its lock
   * and open a second PGlite instance on the same directory. That is the exact corruption the
   * lock exists to prevent, reached through the check meant to make the lock safer.
   *
   * `bootId` is evidence because the kernel issues a new one per boot. A clock reading is not.
   * With only the clock to go on the answer is I CANNOT TELL, and the rule this file exists to
   * hold — absence never decides anything — makes that a refusal.
   *
   * The cost is real and is the safe direction: after a genuine reboot on such a host, a lock
   * whose pid has been handed to an unrelated live process must be removed by hand, which is
   * what `DataDirLockedError` already tells the person to do.
   */
  it("REFUSES on a moved wall clock alone — a clock is not a boot", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, LOCK_FILE), `${JSON.stringify({
      pid: process.pid,
      // The non-Linux shape: no `startTicks`, no `bootId`. A year of apparent drift is far past
      // any tolerance a version of this code ever used, and it still must not release the lock.
      bootAtMs: Date.now() - 365 * 24 * 60 * 60_000,
    })}\n`);
    expect(
      await openOutcome(dir),
      "a wall-clock correction unlinked a LIVE engine's lock — two databases on one directory",
    ).toBe("refused");
  }, 120_000);

  /**
   * …AND A DIFFERENT BOOT ID STILL IS EVIDENCE, so the case above is a narrowing and not a
   * retreat. Without this the fix could be "never release anything", which would strand every
   * user whose machine lost power.
   */
  it("takes over a lock whose boot id is not this boot's", async () => {
    const dir = tempDir();
    const boot = bootIdOrUndefined();
    if (boot === undefined) return;            // no /proc: the case above is the whole story here
    writeFileSync(join(dir, LOCK_FILE), `${JSON.stringify({
      pid: process.pid,
      startTicks: selfStartTicks(),
      bootId: "00000000-0000-4000-8000-000000000000",
      bootAtMs: Date.now() - osUptime() * 1000,
    })}\n`);
    const o = await openTracked(dir);
    expect(o.dataDir).toBe(dir);
  }, 120_000);

  /**
   * AN OLDER BUILD'S LOCK IS NOT ONE THIS BUILD MAY STEAL ON A GUESS.
   *
   * A bare pid carries no identity, so nothing about it can be checked — and "cannot tell" must
   * resolve to the behaviour that was always correct, not to the new one. An install updating in
   * place finds exactly this file, and a rule that read an unparseable record as stale would open
   * a second engine on a live directory.
   */
  it("keeps refusing the LEGACY bare-pid lock while that pid is alive", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, LOCK_FILE), `${process.pid}\n`);
    expect(
      await openOutcome(dir),
      "a lock this build cannot read the identity of was taken on a guess",
    ).toBe("refused");
  }, 120_000);

  it("releases the lock on close, and leaves nothing behind that blocks the next launch", async () => {
    const dir = tempDir();
    const o = await openTracked(dir);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
    await o.close();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    expect(readdirSync(dir).length).toBeGreaterThan(0); // the database itself is still there
    await openTracked(dir);
  }, 120_000);
});

describe("the local world", () => {
  it("is created once and found thereafter — one account, one user, one mailbox", async () => {
    const dir = tempDir();
    const o = await openTracked(dir);
    const now = new Date("2026-08-01T09:00:00.000Z");
    const a = await ensureLocalWorld(o.db, { address: "me@ohmail.test", displayName: "This Mac", now });
    const b = await ensureLocalWorld(o.db, { address: "me@ohmail.test", now });
    expect(b).toEqual(a);
    expect(await o.db.select().from(accounts)).toHaveLength(1);
    expect(await o.db.select().from(users)).toHaveLength(1);
    expect(await o.db.select().from(mailboxes)).toHaveLength(1);
  }, 120_000);

  it("the user is verified and the session is stepped-up, because the API gates are NOT bypassed", async () => {
    // The desktop tier has no signup and no second factor, so these two columns are how the
    // sidecar satisfies `withVerifiedEmail` and `withStepUp` instead of running a laxer pipeline
    // than Cloud does. If either were null, every gated route would 403 on a local install.
    const o = await openTracked(tempDir());
    const now = new Date("2026-08-01T09:00:00.000Z");
    const world = await ensureLocalWorld(o.db, { address: "me@ohmail.test", now });
    await mintLaunchSession(o.db, world, now);

    const [u] = await o.db.select().from(users).where(eq(users.id, world.userId));
    expect(u!.emailVerifiedAt).not.toBeNull();
    const [s] = await o.db.select().from(sessions);
    expect(s!.lastTwofaAt).not.toBeNull();
    expect(s!.scope).toBe("full");
    expect(s!.revokedAt).toBeNull();
  }, 120_000);

  it("a new launch REVOKES every session the disk still holds", async () => {
    /**
     * Sessions are minted per launch and never persisted. On-disk PGlite
     * makes that something you have to do rather than something that is true by default — without
     * this, every token ever minted stays a live credential in a file. Only the hash is ever
     * written, and the previous launch's hash stops resolving here.
     */
    const dir = tempDir();
    const now = new Date("2026-08-01T09:00:00.000Z");
    const first = await openTracked(dir);
    const world = await ensureLocalWorld(first.db, { address: "me@ohmail.test", now });
    const older = await mintLaunchSession(first.db, world, now);
    await first.close();

    const second = await openTracked(dir);
    const fresh = await mintLaunchSession(second.db, world, new Date(now.getTime() + 60_000));
    expect(fresh.revoked).toBe(1);
    expect(fresh.token).not.toBe(older.token);

    const rows = await second.db.select().from(sessions);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.revokedAt === null).map((r) => r.id)).toEqual([fresh.sessionId]);
  }, 120_000);
  it("survives a hard kill mid-ingest: it reopens, and its cursor names no row that is gone", async () => {
    /**
     * THE DURABILITY TRADE, MEASURED THE ONLY WAY IT CAN BE — BY KILLING THE PROCESS.
     *
     * `openLocalDb` commits without waiting for the flush, and in PGlite there is no background
     * writer to do it later: the durability boundary is the CHECKPOINT, so a hard kill discards
     * everything committed since the last one. Measured here, both arms: with the setting the
     * child's 400-odd post-checkpoint commits are gone and its pre-checkpoint row is not; without
     * it, nothing is lost at all.
     *
     * That is safe for one reason, and it is a property of how the mirror writes rather than of
     * Postgres: a folder's cursor advances in the SAME transaction as the rows it names, so a lost
     * tail takes its cursor with it and the next cycle re-fetches from where the store actually is.
     * What this asserts is exactly that — the store reopens (a corrupt one would refuse, which is
     * the difference between `synchronous_commit = off` and `fsync = off`), what was checkpointed
     * is still there, and the cursor claims no message the crash took.
     */
    const dir = tempDir();
    const child = join(dir, "ingest-child.mjs");
    writeFileSync(child, CRASH_CHILD
      .replace("__DB__", pathToFileURL(SIDECAR_DB_ENTRY).href)
      .replace("__LANES__", pathToFileURL(SIDECAR_LANES_ENTRY).href)
      .replace("__DIR__", dir));

    const proc = spawn(process.execPath, ["--conditions=ohmail-source", "--import", "tsx", child], {
      cwd: SIDECAR_DIR, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (c: string) => { out += c; });
    proc.stderr.on("data", (c: string) => { stderr += c; });

    const committed = (): number => (out.match(/^committed \d+$/gm) ?? []).length;
    const end = Date.now() + 120_000;
    while (committed() < 40 && Date.now() < end && proc.exitCode === null) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // …and then a little longer, so several of the child's checkpoints have fired and the kill
    // lands with a durable prefix behind it AND uncommitted-to-disk work in front of it. Both
    // halves are the subject: a kill with nothing durable measures nothing.
    await new Promise((r) => setTimeout(r, 2_500));
    const announced = committed();
    proc.kill("SIGKILL");
    await new Promise((r) => proc.on("exit", r));
    const why = `; stderr: ${stderr.slice(0, 400)}`;

    // The child reports the setting IT observed, so a stale build — a child whose store still
    // waits for every flush — fails by name instead of passing for the wrong reason.
    expect(out, `the child never reported its durability setting${why}`)
      .toMatch(/^synchronous_commit off$/m);
    expect(out, `the child never reached its checkpoint${why}`).toMatch(/^checkpointed$/m);
    // Anti-vacuity: a kill that landed before any work is a test of nothing.
    expect(announced, `the child committed ${announced} transactions before the kill${why}`)
      .toBeGreaterThanOrEqual(40);

    // ── THE REOPEN ────────────────────────────────────────────────────────────────────────
    rmSync(join(dir, LOCK_FILE), { force: true });   // the killed process never released it
    const after = await openTracked(dir);            // a corrupt directory refuses HERE
    const rows = await after.db.select({ id: messages.id }).from(messages);
    const [folder] = await after.db.select().from(mailboxFolders);
    // What was checkpointed is still on disk: the fixture, and with it the fact that the reopen
    // recovered a real database rather than handing back a rebuilt empty one.
    expect(folder, "the checkpointed fixture did not survive the kill").toBeDefined();

    /* THE INVARIANT. uids run 1..n and `uidnext` is the next one to fetch, so `uidnext - 1` is how
       many messages the store CLAIMS to have taken. It may be BEHIND what is on disk — the cycle
       writes it once per batch, so the last partial batch is re-fetched — and behind what the
       child announced, which is the lost tail the mailbox still holds. What it may never be is
       AHEAD: recovery replays a prefix of the log and the cursor commits after its rows, so a
       crash that kept the cursor kept them too. Ahead by one is mail nobody would fetch again. */
    const claims = Number(folder!.uidnext ?? 1n) - 1;
    expect(claims, `the cursor claims ${claims} messages and the store holds ${rows.length}`)
      .toBeLessThanOrEqual(rows.length);
    // Anti-vacuity: a cursor that never moved satisfies "never ahead" for free.
    expect(claims, "the cursor never advanced at all").toBeGreaterThan(0);

    // …and the store is not merely readable: it still takes a write.
    await after.db.insert(messages).values({
      accountId: CRASH_ACCOUNT, mailboxId: folder!.mailboxId, bodyHash: "after-crash",
      dedupKey: `after-crash:${randomUUID()}`, subject: "after", fromAddress: "a@mail.example",
      nativeLocator: { folder: "INBOX", ref: "1:99999" },
    });
    expect((await after.db.select({ id: messages.id }).from(messages)).length).toBe(rows.length + 1);

    /**
     * ── AND THE RUN IS OVER, SAID WHERE A CLIENT CURSOR CAN BE REFUSED BY IT ──────────────────
     *
     * The rows the kill took come back from the mailbox, and they come back at the SAME
     * change-log seqs — the counter rolled back with them. A device parked above that point would
     * be served everything above its cursor and never the re-derived rows below it. So this open
     * mints the next generation, `/sync` stamps it into every cursor it hands out and refuses one
     * naming the run that just ended (`sync-cursor-store-generation.test.ts` drives that half).
     * The child opened a fresh directory, so its run was the first and this one is the second —
     * an exact number, because "greater than one" would also admit a store that mints a new
     * generation at every launch and re-bootstraps every device for nothing.
     */
    expect(after.storeGeneration, "the store that lost a committed tail is still handing out "
      + "cursors belonging to the run that lost it").toBe(2);

    // …and a CLEAN close does not move it. The other half of the same claim, and the half that
    // decides whether an ordinary quit costs every paired device a full re-bootstrap.
    await after.close();
    const reopened = await openTracked(dir);
    expect(reopened.storeGeneration, "a clean close minted a new generation, so every ordinary "
      + "quit refuses every client cursor and re-bootstraps every device").toBe(2);
  }, 240_000);
});
