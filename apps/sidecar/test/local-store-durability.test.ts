import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  INGEST_LOG_FLUSH_MS, StoreClientSplitError, StoreIntervalError, assertOneStoreClient,
  openLocalDb, type OpenLocalDb,
} from "../src/db.js";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { inStoreLane } from "../src/store-lanes.js";
import { startEngineVitals } from "../src/vitals.js";
import { freshDataDir } from "./_datadir.js";

/**
 * ═══ THE INGEST'S TRANSACTION DOES NOT WAIT FOR THE FLUSH, AND NOTHING ELSE INHERITS THAT ══════
 *
 * `openLocalDb` puts `set local synchronous_commit = off` inside the transactions the ingest
 * writes in. The data directory is Emscripten NODEFS, where every file operation is a synchronous
 * host call, so the commit flush is the most expensive thing an ingested message does — 29.99 to
 * 19.39 ms of wall per message on Linux, and on Windows that same flush is kernel CPU.
 *
 * FIVE things must be true and no two of them are visible from each other. The relaxation has to
 * be ON inside the ingest's transaction (a `set` that never ran costs nothing and says nothing);
 * it has to be OFF in the session, because with it gone session-wide the log is never drained and
 * a statement that dirties hundreds of buffers pays a flush at every eviction instead — 2 474 ms
 * against 77 ms for the same work, which is the store's own compaction and a mailbox erase; it has
 * to be OFF in every other database, since the Cloud's Postgres holds mail for people who are not
 * the one running this process; `fsync` has to stay on; and the LOG HAS TO BE SYNCED BY `fsync`.
 *
 * THE LAST ONE WAS UNASSERTED, and the log's commits rest on it: the store's `wal_sync_method` is
 * `fsync`, through the fsync PGlite's filesystem used to answer having synced nothing
 * (`local-store-fsync.test.ts` reads it). The relaxed commit does not make the write asynchronous:
 * it stops a commit forcing the partial page out and its sync, so a kill costs what is still in
 * `wal_buffers`, not everything since the last checkpoint.
 */

const dirs: string[] = [];
const open: OpenLocalDb[] = [];

afterAll(async () => {
  for (const h of open) await h.close().catch(() => { /* a closed handle is fine */ });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A setting as the SESSION sees it. */
async function guc(h: OpenLocalDb, name: string): Promise<string> {
  return gucIn(h.db, name);
}

/** The first column of the first row of a result, as text. */
function gucOf(res: unknown): string {
  const r = res as { rows?: Array<Record<string, unknown>> } & Array<Record<string, unknown>>;
  return String(Object.values((r.rows ?? r)[0] ?? {})[0]);
}

/** A few real turns of the loop — the scheduler hops on `setImmediate`, which is never faked here. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

/** …and as one handle sees it, which for a transaction is the only way to read a `SET LOCAL`. */
async function gucIn(runner: { execute: (q: string) => Promise<unknown> }, name: string): Promise<string> {
  const res = await runner.execute(`show ${name}`) as
    { rows?: Array<Record<string, string>> } & Array<Record<string, string>>;
  return String(Object.values((res.rows ?? res)[0] ?? {})[0]);
}

describe("the local store's durability", () => {
  /**
   * ── AND THE LOG IS SYNCED AT EACH COMMIT ────────────────────────────────────────────────────
   *
   * The one property the other four rest on, and the only one whose loss no other test could see:
   * a process kill leaves the page cache intact, so the kill guard in `slow/local-db.test.ts`
   * would stay green over a store that had quietly stopped surviving a power loss. Asserted from
   * the SERVER rather than from a config file, and the open itself refuses — `ForeignWalSyncMethodError`.
   * `fdatasync` would sync nothing here: PGlite's Emscripten answers it without a call.
   */
  it("syncs its log with fsync, the setting read back from the server", async () => {
    const dir = await freshDataDir("ohmail-walmethod-");
    dirs.push(dir);
    const h = await openLocalDb(dir);
    open.push(h);
    expect(await guc(h, "wal_sync_method"), "the log is not synced by the store's fsync, so a commit "
      + "no longer waits for its record").toBe("fsync");
    // Each 1 MB segment zero-filled cost the engine's turns a run of fsyncs; recycling saves them.
    expect(await guc(h, "wal_init_zero"), "a new log segment is zero-filled again").toBe("off");
    expect(await guc(h, "wal_recycle"), "a checkpoint deletes freed log segments instead of reusing them").toBe("on");
  });

  /* A segment created during a write is an fsync, a rename and a directory sync inside the commit
     that needs it; one a checkpoint recycled is already there. */
  it("writes a second batch after a checkpoint into the segments it freed, creating none", async () => {
    const dir = await freshDataDir("ohmail-wal-recycle-");
    dirs.push(dir);
    const h = await openLocalDb(dir);
    open.push(h);
    const at = async () => Number(gucOf(await h.db.execute("select (pg_current_wal_insert_lsn() - '0/0'::pg_lsn)::bigint::text")));
    const batch = async (bytes: number) => {
      const start = await at();
      while (await at() - start < bytes) {
        await inStoreLane("ingest", () => h.db.transaction(async (tx) => {
          await tx.execute("insert into churn select g, repeat('x', 400) from generate_series(1, 500) g");
        }));
      }
      await h.db.execute("insert into churn values (0, '')"); // a synchronous commit writes the log out
    };
    await h.db.execute("create table churn (n int, pad text)");
    await batch(6 * 1024 * 1024);
    await h.checkpoint();
    const wal = () => readdirSync(join(dir, "pgdata", "pg_wal")).filter((f) => /^[0-9A-F]{24}$/.test(f));
    const kept = new Set(wal());
    await batch(2 * 1024 * 1024);
    const made = wal().filter((f) => !kept.has(f));
    expect(made, `${made.length} log segments created by the second batch, each synced inside a commit`).toEqual([]);
  }, 120_000);

  it("relaxes the flush inside the ingest's transaction and nowhere else, and still fsyncs", async () => {
    const dir = await freshDataDir("ohmail-durability-");
    dirs.push(dir);
    const h = await openLocalDb(dir);
    open.push(h);

    // THE RELAXATION, where it belongs: the ingest's own transaction, whose rows the mailbox can
    // hand back. `inStoreLane` is how the drain names itself — see `store-lanes.ts`.
    expect(
      await inStoreLane("ingest", () => h.db.transaction((tx) => gucIn(tx, "synchronous_commit"))),
      "the ingest's transaction waits for the flush — the per-message cost is back",
    ).toBe("off");
    // …and NOT where it does not. A session-wide `off` is the shape that unbounded the log.
    expect(await guc(h, "synchronous_commit"), "the SESSION stopped waiting for the flush")
      .toBe("on");
    expect(
      await h.db.transaction((tx) => gucIn(tx, "synchronous_commit")),
      "an interactive transaction stopped waiting for the flush",
    ).toBe("on");
    // `SET LOCAL` ends with its transaction; a leak here would be a session-wide `off` arriving
    // by a slower route.
    expect(await guc(h, "synchronous_commit"), "the ingest's setting outlived its transaction")
      .toBe("on");
    // The safety half. `fsync = off` is a DIFFERENT setting with a different consequence — a
    // crash that can corrupt the store rather than lose its last transactions — and this store
    // must never be opened with it.
    expect(await guc(h, "fsync"), "the local store was opened with fsync off").toBe("on");

    // …and the handle still works, which is the anti-vacuity: a `show` against a store that
    // never migrated would answer the same two words.
    const rows = await h.db.execute("select count(*)::int as n from messages") as unknown as
      { rows?: Array<{ n: number }> } & Array<{ n: number }>;
    expect(Number((rows.rows ?? rows)[0]?.n)).toBe(0);
  }, 120_000);

  /**
   * ── THE LOG IS WRITTEN OUT ON THE STORE'S CLOCK, WHATEVER THE WRITER DOES ─────────────────────
   *
   * Forty relaxed ingest transactions and no durable commit from any writer: the FLUSH pointer has
   * to pass the INSERT pointer as the fortieth left it within INGEST_LOG_FLUSH_MS. The insert
   * pointer is the one read: under relaxed commit the write pointer sits still inside `wal_buffers`
   * and a reading of it passes under its own mutation. The clock held one millisecond short is the
   * control — nothing else writes the log out, so the pointer that moves is the timer's.
   */
  it("flushes the log within INGEST_LOG_FLUSH_MS of relaxed commits, and nothing else does", async () => {
    const dir = await freshDataDir("ohmail-log-flush-");
    dirs.push(dir);
    const h = await openLocalDb(dir);
    open.push(h);
    await h.db.execute("create table flush_probe (n int)");
    const lsn = async (fn: string): Promise<string> => gucOf(await h.db.execute(`select ${fn}::text as l`));
    const passed = async (a: string, b: string): Promise<boolean> =>
      gucOf(await h.db.execute(`select ('${a}'::pg_lsn >= '${b}'::pg_lsn)::text as ok`)) === "true";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await inStoreLane("ingest", async () => {
        for (let i = 1; i <= 40; i += 1) {
          await h.db.transaction(async (tx) => { await tx.execute(`insert into flush_probe values (${i})`); });
        }
      });
      const inserted = await lsn("pg_current_wal_insert_lsn()");
      const flushedAt40 = await lsn("pg_current_wal_flush_lsn()");
      expect(await passed(flushedAt40, inserted), "a writer's commit flushed the log, so this measures "
        + "nothing about the store's own flush").toBe(false);

      await vi.advanceTimersByTimeAsync(INGEST_LOG_FLUSH_MS - 1);
      await settle();
      expect(await lsn("pg_current_wal_flush_lsn()"), "the log moved before the deadline — "
        + "something other than the store's flush wrote it out").toBe(flushedAt40);

      await vi.advanceTimersByTimeAsync(1);
      let ok = false;
      for (let i = 0; i < 400 && !ok; i += 1) {
        await settle();
        ok = await passed(await lsn("pg_current_wal_flush_lsn()"), inserted);
      }
      expect(ok, "forty relaxed commits were still unflushed a whole INGEST_LOG_FLUSH_MS later — a kill "
        + "takes them, and the log is left to the evictions").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);

  /**
   * A flush that fails says so and is tried again one deadline later — with no commit behind it to
   * arm it, which is the case the retry is for. The first write is refused once by a trigger on the
   * flush's row (a sequence, so nothing else commits to lift it) and the relaxed write before it must
   * still reach the disk.
   */
  it("logs a failed flush and tries it again one deadline later", async () => {
    const dir = await freshDataDir("ohmail-log-flush-fail-");
    dirs.push(dir);
    const lines: string[] = [];
    const h = await openLocalDb(dir, { log: (event) => lines.push(event) });
    open.push(h);
    await h.db.execute("create table flush_retry_probe (n int)");
    await h.db.execute("create sequence flush_refusals");
    await h.db.execute(`create function refuse_first_flush() returns trigger language plpgsql as $$
      begin if nextval('flush_refusals') = 1 then raise exception 'refused once'; end if; return new; end $$`);
    await h.db.execute(`create trigger refuse_first before insert or update on local_store_flush
      for each row execute function refuse_first_flush()`);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await inStoreLane("ingest", () => h.db.transaction(async (tx) => { await tx.execute("insert into flush_retry_probe values (1)"); }));
      const inserted = gucOf(await h.db.execute("select pg_current_wal_insert_lsn()::text"));
      const passed = async (): Promise<boolean> =>
        gucOf(await h.db.execute(`select (pg_current_wal_flush_lsn() >= '${inserted}'::pg_lsn)::text`)) === "true";
      await vi.advanceTimersByTimeAsync(INGEST_LOG_FLUSH_MS);
      for (let i = 0; i < 200 && !lines.includes("local_db_flush_failed"); i += 1) await settle();
      expect(lines, "a flush that could not write said nothing").toContain("local_db_flush_failed");
      expect(await passed(), "something other than the store's flush wrote the log out").toBe(false);
      await vi.advanceTimersByTimeAsync(INGEST_LOG_FLUSH_MS);
      let flushed = false;
      for (let i = 0; i < 400 && !flushed; i += 1) { await settle(); flushed = await passed(); }
      expect(flushed, "the failed flush was never tried again, and the relaxed write is still in memory")
        .toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);

  /**
   * ── AND ON THE ONE CLIENT IT OPENED ──────────────────────────────────────────────────────────
   *
   * A relaxed commit on a client the flush was not installed on has nothing writing its log out,
   * and one outside the scheduler has nothing arbitrating it. The open asserts the three by
   * identity; this drives the assertion both ways and reads that the open makes it over the three.
   */
  it("installs the relaxed commits, the scheduler and the log flush on the client it opened", () => {
    const client = {};
    expect(() => assertOneStoreClient(client, { "relaxed commits": client, scheduler: client }))
      .not.toThrow();
    expect(() => assertOneStoreClient(client, { scheduler: client, "log flush": {} }))
      .toThrow(StoreClientSplitError);
    expect(() => assertOneStoreClient(client, { scheduler: client, "log flush": {} }))
      .toThrow(/log flush was installed on a different client/);
    const src = withoutComments(readFileSync(join(ROOT, "apps/sidecar/src/db.ts"), "utf8"));
    expect(src).toMatch(/const flush = createLogFlush\(client, /);
    expect(src).toMatch(/const relaxed = relaxIngestCommits\(client, flush\.noteRelaxed\);/);
    expect(src).toMatch(/const scheduled = scheduleStoreLanes\(client, lanes\);/);
    expect(src).toMatch(/const door = installCloseDoor\(client, log\);/);
    expect(src).toMatch(/assertOneStoreClient\(client, \{\s*"relaxed commits": relaxed, scheduler: scheduled, "log flush": flush\.client, "close door": door\.client,\s*\}\);/);
  });

  /** A 0 interval selected a tight loop; it is refused by the option's name before the lock. */
  it("refuses a checkpoint or flush interval of 0 by name", async () => {
    const dir = await freshDataDir("ohmail-interval-");
    dirs.push(dir);
    await expect(openLocalDb(dir, { checkpointIntervalMs: 0 })).rejects.toThrow(StoreIntervalError);
    await expect(openLocalDb(dir, { checkpointIntervalMs: 0 })).rejects.toThrow(/checkpointIntervalMs/);
    await expect(openLocalDb(dir, { logFlushIntervalMs: 0 })).rejects.toThrow(/logFlushIntervalMs/);
    const h = await openLocalDb(dir, { checkpointIntervalMs: 60_000, logFlushIntervalMs: 500 });
    open.push(h);
  }, 120_000);

  /**
   * ── ONE CHECKPOINT AT A TIME ON THE ONE CONNECTION ────────────────────────────────────────────
   *
   * The periodic tick, the drain's checkpoint and the fold were three callers of one statement
   * with nothing between them. Counted at the client, outside every wrapper the store installs.
   */
  it("never has two checkpoints in flight on its connection", async () => {
    const dir = await freshDataDir("ohmail-one-checkpoint-");
    dirs.push(dir);
    const h = await openLocalDb(dir, { ingestFoldWalBytes: 1 });
    open.push(h);
    const client = (h.db as unknown as { $client: PGlite }).$client as unknown as Record<string, unknown>;
    let inFlight = 0;
    let most = 0;
    let seen = 0;
    for (const m of ["exec", "query"]) {
      const orig = (client[m] as (...a: unknown[]) => Promise<unknown>).bind(client);
      client[m] = async (...a: unknown[]): Promise<unknown> => {
        const ck = typeof a[0] === "string" && /^\s*checkpoint/i.test(a[0]);
        if (ck) { inFlight += 1; seen += 1; most = Math.max(most, inFlight); }
        try { return await orig(...a); } finally { if (ck) inFlight -= 1; }
      };
    }
    await h.db.execute("create table churn (n int)");
    await h.db.execute("insert into churn select generate_series(1, 2000)");
    await Promise.all([h.checkpoint(), h.foldIfLogGrew(), h.checkpoint()]);
    expect(seen, "no checkpoint reached the client, so the count below says nothing").toBeGreaterThanOrEqual(2);
    expect(most, "two checkpoints were in flight on one connection at once").toBe(1);
  }, 120_000);

  /**
   * ── A CHECKPOINT THAT HELD THE STORE IS LOGGED, WHATEVER IT RECLAIMED ─────────────────────────
   *
   * The line used to be written only when a segment went, so a fold that ran for seconds on a large
   * store said nothing. Driven both ways by the floor: 0 logs a checkpoint that reclaimed nothing,
   * a minute logs none, and the fold's own checkpoint is timed and named like the periodic one.
   */
  it("logs a checkpoint over the floor with its time, and none under it", async () => {
    const lines: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const dir = await freshDataDir("ohmail-slow-checkpoint-");
    dirs.push(dir);
    const h = await openLocalDb(dir, {
      log: (event, detail) => lines.push({ event, detail }), slowCheckpointFloorMs: 0, ingestFoldWalBytes: 1,
    });
    open.push(h);
    await h.checkpoint();
    await h.db.execute("create table churn (n int)");
    expect((await h.foldIfLogGrew()).folded, "the fold did not fold, so its arm measures nothing").toBe(true);
    const cps = lines.filter((l) => l.event === "local_db_checkpointed").map((l) => l.detail);
    expect(cps.map((d) => d.kind), "a checkpoint over the floor wrote no line").toEqual(["asked", "fold"]);
    expect(cps.every((d) => typeof d.totalMs === "number" && typeof d.dropped === "number")).toBe(true);
    expect(cps.map((d) => typeof d.fsyncs === "number" && d.fsyncs > 0), "a checkpoint's line counts no fsync")
      .toEqual([true, true]);

    const quiet: string[] = [];
    const dir2 = await freshDataDir("ohmail-slow-checkpoint-quiet-");
    dirs.push(dir2);
    const h2 = await openLocalDb(dir2, { log: (event) => quiet.push(event), slowCheckpointFloorMs: 60_000 });
    open.push(h2);
    await h2.checkpoint();
    expect(quiet.filter((e) => e === "local_db_checkpointed"), "a quick checkpoint that reclaimed "
      + "nothing wrote a line — the log is noise again").toEqual([]);
  }, 120_000);

  it("counts the store's fsyncs and their time on the engine's vitals line, per interval", async () => {
    const dir = await freshDataDir("ohmail-vitals-fsync-");
    dirs.push(dir);
    const h = await openLocalDb(dir);
    open.push(h);
    const lines: Array<Record<string, unknown>> = [];
    const stop = startEngineVitals((event, detail) => { if (event === "engine_vitals") lines.push(detail); }, {
      storeBytes: () => h.storeBytes(), storeSyncs: () => h.storeSyncs(), intervalMs: 1_000,
    });
    try {
      await h.db.execute("create table churn (n int)");
      await h.db.execute("insert into churn select generate_series(1, 2000)");
      await h.checkpoint();
      const seen = lines.length;
      await vi.waitFor(() => expect(lines.length).toBeGreaterThan(Math.max(1, seen)), { timeout: 5_000, interval: 50 });
    } finally { stop(); }
    const later = lines.slice(1);
    expect(later.reduce((n, l) => n + (l.storeFsyncs as number), 0), "the interval's checkpoint synced nothing on the line")
      .toBeGreaterThan(0);
    expect(later.every((l) => typeof l.storeFsyncMs === "number")).toBe(true);
    const count = h.storeSyncs()!;
    expect(count.maxMs, "no fsync was timed").toBeGreaterThan(0);
    expect(count.ms).toBeGreaterThanOrEqual(count.maxMs);
  }, 120_000);
});

/**
 * THE CENSUS. Every source file in the tree, read as text: the setting may be named in exactly
 * one production module, `apps/sidecar/src/db.ts`, and there it must be applied to the local
 * store's own PGlite client. Anything else — a Cloud pool, the test harness's shared cluster, a
 * migration, a script — is another person's database.
 */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Source roots a production database handle can be opened from. Tests state their own reasons. */
const ROOTS = ["apps", "packages", "scripts"];

/**
 * Directories that hold no shipped source, or hold a copy of it. `generated` is the second kind and
 * was missed: `apps/mobile/generated/phone-engine.js` is the sidecar engine BUNDLED for the phone,
 * so the walk read `engine.ts`'s own call a second time and the census reported a caller that does
 * not exist. It is git-ignored, so the reading depended on whether the tree had been built — green
 * in a clean checkout, red after `pnpm -r build`. `target` is the same kind: Cargo's output, where the
 * README's desktop build leaves the bundled engine (a clone that built the app, then ran the suite).
 */
const SKIP = new Set(["node_modules", "dist", "build", ".next", "drizzle", "test", "__tests__", ".git", "generated", "target"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir, { encoding: "utf8" }); } catch { return out; }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) { sourceFiles(full, out); continue; }
    if (/\.(ts|tsx|mts|cts|mjs|cjs|js|sql)$/.test(name) && !/\.test\.[cm]?tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("nothing but the local store loosens its durability", () => {
  it("names synchronous_commit in exactly one production file", () => {
    const hits: string[] = [];
    let walked = 0;
    for (const r of ROOTS) {
      for (const f of sourceFiles(join(ROOT, r))) {
        walked += 1;
        if (readFileSync(f, "utf8").includes("synchronous_commit")) {
          hits.push(f.slice(ROOT.length).replace(/\\/g, "/"));
        }
      }
    }
    /* Anti-vacuity on the WALK and not on the hits: a roots list that resolved to nothing would
       report an empty census as a clean one, and "no hits" is also what a correct walk reports
       the moment somebody deletes the setting — two different failures needing two messages. */
    expect(walked, "the walk reached almost no source — the roots or the filter are wrong")
      .toBeGreaterThan(500);
    expect(hits.sort(), "a database that is not the local store was given the local store's durability")
      .toEqual(["apps/sidecar/src/db.ts"]);
  });


  /**
   * THE `generated` SKIP, WATCHED FAILING. `apps/mobile/generated/phone-engine.js` is the sidecar
   * engine bundled for the phone, git-ignored, so the census reading depended on whether the tree
   * had been built. This plants the bundle and reads both ways: inside `generated/` the walk must
   * not see it, and the same bytes one directory over must be seen. It plants in a TEMP root of the
   * same shape: the real `generated/` is a build output other suites read, and removing it in a
   * `finally` broke them mid-run.
   */
  it("skips the phone's generated bundle, and would not skip the same bytes anywhere else", () => {
    const root = mkdtempSync(join(tmpdir(), "durability-census-"));
    const planted = join(root, "apps/mobile/generated");
    const beside = join(root, "apps/mobile/generated-census-probe");
    const body = 'await inStoreLane("ingest", async () => { /* the bundled copy */ });\nsynchronous_commit\n';
    try {
      mkdirSync(planted, { recursive: true });
      mkdirSync(beside, { recursive: true });
      writeFileSync(join(planted, "phone-engine.js"), body);
      writeFileSync(join(beside, "phone-engine.js"), body);

      /* WALKED FROM WHERE THE CENSUS WALKS FROM. `SKIP` is tested against an ENTRY NAME while the
         PARENT is being read, so calling sourceFiles on the skipped directory itself walks
         straight into it and the arm measures nothing — it read 1 and reported the census as
         broken. The census starts at its ROOTS; so does this. */
      const walkedFiles = sourceFiles(join(root, "apps/mobile")).map((f) => f.replace(/\\/g, "/"));
      const seen = (dir: string): number =>
        walkedFiles.filter((f) => f.startsWith(dir.replace(/\\/g, "/") + "/")).length;

      expect(seen(planted), "the walk read apps/mobile/generated — the census counts the phone's bundled copy of the engine as a second caller")
        .toBe(0);
      expect(seen(beside), "the walk skipped a directory it has no reason to skip — the filter is matching too much and the census reaches less source than it claims")
        .toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * …AND THE LANE THAT LOOSENS IT IS THE DRAIN'S AND THE STORE'S OWN FLUSH, NOTHING ELSE.
   *
   * A setting, a draft, a read-state change and the Cloud door's mirror belong to no lane, so they
   * commit under `on` and a kill takes none of them (`slow/kill-mid-drain.test.ts`). A relaxed
   * commit is flushed within INGEST_LOG_FLUSH_MS by the store's clock, which is a loss window a
   * person's own edit must not have. So the calls are pinned: the drain's cycle and its upkeep in
   * `engine.ts`, and the flush in `db.ts`, which commits `on`. The CALL is parsed, not the name.
   */
  it("runs the ingest's lane from the drain and nowhere else", () => {
    const sites: string[] = [];
    let walked = 0;
    for (const r of ROOTS) {
      for (const f of sourceFiles(join(ROOT, r))) {
        walked += 1;
        const src = withoutComments(readFileSync(f, "utf8"));
        for (const _call of src.matchAll(/\binStoreLane\s*\(\s*["']ingest["']/g)) {
          sites.push(f.slice(ROOT.length).replace(/\\/g, "/"));
        }
      }
    }
    expect(walked, "the walk reached almost no source — the roots or the filter are wrong")
      .toBeGreaterThan(500);
    expect(
      sites.sort(),
      "a caller outside the drain and the store's flush relaxes a write somebody made by hand",
    ).toEqual(["apps/sidecar/src/db.ts", "apps/sidecar/src/engine.ts", "apps/sidecar/src/engine.ts"]);
  });

  it("applies it to the local store's own client and to nothing it did not open", () => {
    const src = readFileSync(join(ROOT, "apps/sidecar/src/db.ts"), "utf8");
    // The receiver is `client`, the PGlite instance this function constructed from `pgDataDir` —
    // not a handle passed in, and not a pool — and the statement is scoped to the transaction.
    expect(src).toMatch(/const setting = STORE_FLUSH in cb \? "on" : INGEST_SYNCHRONOUS_COMMIT;/);
    expect(src).toMatch(/await tx\.exec\(`set local synchronous_commit = \$\{setting\}`\)/);
    expect(src).toMatch(/const INGEST_SYNCHRONOUS_COMMIT = "off";/);
    expect(src).toMatch(/const relaxed = relaxIngestCommits\(client, flush\.noteRelaxed\);/);
    // And it is the ONLY `set` of a durability knob in the file — `local` included, so the
    // session-wide spelling cannot come back beside this one.
    const sets = src.match(/set\s+(local\s+)?(synchronous_commit|fsync|full_page_writes|wal_level)\b/g) ?? [];
    expect(sets).toEqual(["set local synchronous_commit"]);
  });
});
