import fs, { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { PGlite as PGliteClass } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { mailSchema } from "@trafficflow/db/mail";
import { MAIL_JOURNAL, readJournalOf } from "@trafficflow/db/journal";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { NodeFS } from "@electric-sql/pglite/nodefs";
import { LocalStoreOpenError, PGDATA_SUBDIR, openLocalDb, type OpenLocalDb } from "../src/db.js";
import * as store from "../src/db.js";
import * as transport from "../src/pglite-transport.js";
import { freshDataDir } from "./_datadir.js";

/**
 * ═══ THE LOCAL STORE SYNCS THROUGH AN FSYNC OF ITS OWN ═══════════════════════════════════════
 *
 * PGlite's node filesystem defines no fsync, so every `pg_fsync` Postgres made answered 0 having
 * synced nothing. On a guest cut by hard power-off, a cut inside the writeback window after a
 * checkpoint that recycled the log left the store unopenable, and a cut after an open lost every
 * row committed since it. A process kill keeps the page cache, so no kill test sees either; this
 * reads the mechanism instead — the op is installed, the open and a checkpoint reach the host's
 * fsync through it (counted at the `node:fs` seam), and the open refuses a start that did not.
 */

const dirs: string[] = [];
const open: OpenLocalDb[] = [];
afterAll(async () => {
  for (const h of open) await h.close().catch(() => { /* a closed handle is fine */ });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type FsyncOp = (stream: unknown) => number;
interface NodeFsOps { stream_ops: { fsync?: FsyncOp } }

function nodefsOf(client: PGlite): NodeFsOps {
  const mod = (client as unknown as { Module: { FS: { filesystems: { NODEFS: NodeFsOps } } } }).Module;
  return mod.FS.filesystems.NODEFS;
}

const clientOf = (h: OpenLocalDb): PGlite => (h.db as unknown as { $client: PGlite }).$client;

/** Every host fsync made while `work` runs, by what it synced. The original call runs first. */
async function hostSyncs<T>(work: () => Promise<T>): Promise<{ files: number; directories: number; result: T }> {
  const f = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
  const fsync = f.fsyncSync!;
  const fstat = fs.fstatSync;
  let files = 0, directories = 0;
  f.fsyncSync = function (this: unknown, ...a: unknown[]) {
    const out = fsync.apply(this, a);
    if (fstat(a[0] as number).isDirectory()) directories += 1; else files += 1;
    return out;
  };
  try {
    const result = await work();
    return { files, directories, result };
  } finally {
    f.fsyncSync = fsync;
  }
}

/** One word for how an open ended — a `.rejects` on a store handle can take the worker down. */
async function openVerdict(dir: string): Promise<string> {
  try {
    const h = await openLocalDb(dir);
    open.push(h);
    return "OPENED";
  } catch (err) {
    if (!(err instanceof LocalStoreOpenError)) return `THREW ${(err as Error)?.name}`;
    const cause = (err as Error & { cause?: Error }).cause;
    return `REFUSED ${cause?.name}: ${cause instanceof Error ? (cause as Error & { reading?: string }).reading : "?"}`;
  }
}

/** Run `work` with `LocalStoreFs`'s start hook swapped for `hook`, restored by identity after. */
async function withStartHook<T>(hook: (this: NodeFS) => Promise<void>, work: () => Promise<T>): Promise<T> {
  const proto = transport.LocalStoreFs.prototype as unknown as { initialSyncFs: () => Promise<void> };
  const own = Object.getOwnPropertyDescriptor(proto, "initialSyncFs")!;
  proto.initialSyncFs = hook;
  try {
    return await work();
  } finally {
    Object.defineProperty(proto, "initialSyncFs", own);
  }
}

describe("the local store's fsync", () => {
  it("is installed on PGlite's node filesystem, and the open's start syncs through it", async () => {
    const dir = await freshDataDir("ohmail-fsync-open-");
    dirs.push(dir);
    const { files, result: h } = await hostSyncs(() => openLocalDb(dir));
    open.push(h);
    expect(typeof nodefsOf(clientOf(h)).stream_ops.fsync, "PGlite's node filesystem still has no fsync")
      .toBe("function");
    expect(files, "the open synced no file — the control file it marks in use is not on the disk")
      .toBeGreaterThan(0);
  }, 120_000);

  it("makes a CHECKPOINT sync the files it wrote and the directories it renamed in", async () => {
    const dir = await freshDataDir("ohmail-fsync-checkpoint-");
    dirs.push(dir);
    const h = await openLocalDb(dir);
    open.push(h);
    await h.db.execute("create table fsync_probe (n int, pad text)");
    await h.db.execute("insert into fsync_probe select g, repeat('x', 200) from generate_series(1, 4000) g");
    const cp = await hostSyncs(() => h.checkpoint());
    expect(cp.files, "a CHECKPOINT synced no file — the pages and the control file it wrote are in the page cache")
      .toBeGreaterThan(0);
    expect(cp.directories, "a CHECKPOINT synced no directory — its renames are not on the disk").toBeGreaterThan(0);
    // The control: the same seam reads nothing while nothing is asked of the store.
    const idle = await hostSyncs(async () => { await new Promise((r) => setImmediate(r)); });
    expect(idle.files + idle.directories, "the counter reads syncs nobody made").toBe(0);
  }, 120_000);

  it("refuses an open whose start never installed it, and leaves the directory openable", async () => {
    const dir = await freshDataDir("ohmail-fsync-missing-");
    dirs.push(dir);
    const verdict = await withStartHook(
      async function (this: NodeFS) { await NodeFS.prototype.initialSyncFs.call(this); },
      () => openVerdict(dir),
    );
    expect(verdict).toBe("REFUSED StoreFsyncMissingError: the start hook that installs it never ran");
    // The positive control, which also reads that the refusal closed PGlite and released the lock.
    expect(await openVerdict(dir)).toBe("OPENED");
  }, 120_000);

  it("refuses an open whose fsync was replaced after it was installed", async () => {
    const dir = await freshDataDir("ohmail-fsync-replaced-");
    dirs.push(dir);
    const own = Object.getOwnPropertyDescriptor(transport.LocalStoreFs.prototype, "initialSyncFs")!;
    const installThenReplace = async function (this: NodeFS): Promise<void> {
      await (own.value as () => Promise<void>).call(this);
      nodefsOf((this as unknown as { pg: PGlite }).pg).stream_ops.fsync = () => 0;
    };
    const verdict = await withStartHook(installThenReplace, () => openVerdict(dir));
    expect(verdict).toBe("REFUSED StoreFsyncMissingError: another fsync replaced it after it was installed");
  }, 120_000);

  /* The upgrade the guard is for: the same install, made only once Postgres has started — so the
     op is in place and still ours at the guard, and the start's own control-file write missed it. */
  it("refuses an open whose fsync arrived only after Postgres had started", async () => {
    const dir = await freshDataDir("ohmail-fsync-late-");
    dirs.push(dir);
    const own = Object.getOwnPropertyDescriptor(transport.LocalStoreFs.prototype, "initialSyncFs")!;
    let installedLate = false;
    const installAfterStart = async function (this: NodeFS): Promise<void> {
      await NodeFS.prototype.initialSyncFs.call(this);
      const mod = (this as unknown as { pg: { Module: { _pg_initdb: () => number } } }).pg.Module;
      const start = mod._pg_initdb;
      mod._pg_initdb = () => {
        const out = start.call(mod);
        void (own.value as () => Promise<void>).call(this).then(() => { installedLate = true; });
        return out;
      };
    };
    const verdict = await withStartHook(installAfterStart, () => openVerdict(dir));
    expect(installedLate, "the late install never ran, so the refusal below is the missing hook's").toBe(true);
    expect(verdict).toBe("REFUSED StoreFsyncMissingError: the start synced nothing through it");
  }, 120_000);

  /* Each reading on its own, so a guard that dropped one is red here and not only end to end. */
  it("vouches for an fsync only when it is installed, still in place, and the start went through it", () => {
    const fault = transport.storeFsyncFault;
    expect(typeof fault, "the open has no fsync guard").toBe("function");
    const op = (): number => 0;
    expect(fault(op, op, 3)).toBeNull();
    expect(fault(op, op, 1)).toBeNull();
    expect(fault(undefined, undefined, 3)).toBe("the start hook that installs it never ran");
    expect(fault(op, () => 0, 3)).toBe("another fsync replaced it after it was installed");
    expect(fault(op, undefined, 3)).toBe("another fsync replaced it after it was installed");
    expect(fault(op, op, 0)).toBe("the start synced nothing through it");
  });
});

const rowsOf = (r: unknown): Array<Record<string, unknown>> =>
  ((r as { rows?: Array<Record<string, unknown>> }).rows ?? (r as Array<Record<string, unknown>>));

/** Host fsyncs made on the store's log segments while `work` runs, read by the segment's inode. */
async function logSyncs(dir: string, work: () => Promise<unknown>): Promise<number> {
  const wal = join(dir, PGDATA_SUBDIR, "pg_wal");
  const segments = new Set(readdirSync(wal).filter((n) => /^[0-9A-F]{24}$/.test(n)).map((n) => statSync(join(wal, n)).ino));
  const f = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
  const fsync = f.fsyncSync!;
  const fstat = fs.fstatSync;
  let n = 0;
  f.fsyncSync = function (this: unknown, ...a: unknown[]) {
    const out = fsync.apply(this, a);
    if (segments.has(fstat(a[0] as number).ino)) n += 1;
    return out;
  };
  try { await work(); } finally { f.fsyncSync = fsync; }
  return n;
}

/**
 * ═══ THE LOG REACHES THE DISK THROUGH THE SAME FSYNC, ON EVERY PLATFORM ════════════════════════
 *
 * `open_datasync` leaned on a descriptor flag PGlite maps to Node's `O_SYNC`, which Node on Windows
 * lacks, so there the log stayed in the cache. The store runs `wal_sync_method = fsync`, set in its
 * own settings before Postgres reads them, and the open proves one commit's record synced.
 */
describe("the local store's log", () => {
  it("syncs a commit's record through the store's fsync", async () => {
    const dir = await freshDataDir("ohmail-fsync-log-");
    dirs.push(dir);
    const h = await openLocalDb(dir);
    open.push(h);
    await h.db.execute(sql.raw("CREATE TABLE commit_probe (n int)"));
    const n = await logSyncs(dir, () => h.db.execute(sql.raw("INSERT INTO commit_probe VALUES (1)")));
    expect(n, "a synchronous commit synced no log segment — its record is in the page cache").toBeGreaterThan(0);
  }, 120_000);

  it("puts a store's own settings right before Postgres reads them, and keeps their other lines", async () => {
    const dir = await freshDataDir("ohmail-fsync-conf-");
    dirs.push(dir);
    const conf = join(dir, PGDATA_SUBDIR, "postgresql.auto.conf");
    // `cluster_name`, because PGlite's own command line outranks the file for most settings.
    // `wal_recycle = 'off'`, as an earlier build wrote it: recycling is Postgres' default again.
    writeFileSync(conf, "# Do not edit this file manually!\ncluster_name = 'kept'\nwal_sync_method = 'open_datasync'\nwal_recycle = 'off'\n");
    const h = await openLocalDb(dir);
    open.push(h);
    const shown = (name: string) => h.db.execute(sql.raw(`show ${name}`)).then((r) => String(Object.values(rowsOf(r)[0]!)[0]));
    expect(await shown("wal_sync_method"), "the store opened on the method its file said").toBe("fsync");
    expect(await shown("cluster_name"), "a line of the store's own settings was dropped").toBe("kept");
    const lines = readFileSync(conf, "utf8").split("\n").filter((l) => /wal_sync_method/.test(l));
    expect(lines, "the method is in the file once").toEqual(["wal_sync_method = 'fsync'"]);
    expect(await shown("wal_init_zero"), "a store's file without the line kept zero-filling segments").toBe("off");
    expect(await shown("wal_recycle"), "the store kept an old file's line that stops recycling segments").toBe("on");
    const ours = readFileSync(conf, "utf8").split("\n").filter((l) => /^wal_(init_zero|recycle)\b/.test(l));
    expect(ours, "the setting is in the file once, and recycling at its default").toEqual(["wal_init_zero = 'off'"]);
  }, 120_000);

  /* A performance setting read back otherwise is said once and never refuses the open. */
  it("says once when the log's performance settings read back otherwise, and refuses nothing", async () => {
    const note = store.noteLogSettings;
    expect(typeof note, "the open reads the settings back nowhere").toBe("function");
    const reading = (zero: string) => ({
      query: async (q: string) => ({ rows: [{ v: /wal_init_zero/.test(q) ? zero : "fsync" }] }),
    });
    const said: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const log = (event: string, detail: Record<string, unknown>) => { said.push({ event, detail }); };
    await expect(note(reading("off") as never, log)).resolves.toBe(0);
    expect(said, "settings in force wrote a line").toEqual([]);
    await expect(note(reading("on") as never, log)).resolves.toBe(1);
    expect(said.map((s) => [s.event, s.detail.count])).toEqual([["local_db_log_settings_differ", 1]]);
  });

  /* The proof's reading on its own: a commit that did not reach the fsync refuses by name. */
  it("refuses an open whose commit did not sync through the store's fsync", async () => {
    const proof = store.assertCommitSynced;
    expect(typeof proof, "the open proves no commit").toBe("function");
    const count = { files: 4 };
    const synced = { query: async () => { count.files += 1; return { rows: [] }; } };
    const silent = { query: async () => ({ rows: [] }) };
    await expect(proof(synced as never, count)).resolves.toBeUndefined();
    const verdict = await proof(silent as never, count).then(() => "ADMITTED", (err: Error & { reading?: string }) => `${err.name}: ${err.reading}`);
    expect(verdict).toBe("StoreFsyncMissingError: a commit's log record did not go through it");
  });
});

/** One word for a call: what it answered, or the class its refusal names in its cause chain. */
async function refusalOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "ANSWERED";
  } catch (err) {
    const names: string[] = [];
    for (let cur: unknown = err, i = 0; cur && i < 6; cur = (cur as { cause?: unknown }).cause, i += 1) names.push((cur as Error).name);
    return names.includes("StoreAbortedError") ? "REFUSED StoreAbortedError" : `THREW ${names.join(" < ")}`;
  }
}

/**
 * ═══ A FAILED FSYNC ENDS THE STORE'S DATABASE, AND THE STORE SAYS SO ═══════════════════════════
 *
 * Postgres PANICs on a failed fsync, as it must, and PGlite's WASM aborts; every later statement
 * then came back as an EMPTY SUCCESS — reads found nothing, writes kept nothing — and the close
 * recorded a clean run. The store refuses every later statement by name, tells its caller once (the
 * engine ends its process so the shell starts it again), and the next open recovers the log.
 */
describe("a store whose fsync fails", () => {
  it("refuses every later statement, says so once, and records no clean close", async () => {
    const dir = await freshDataDir("ohmail-fsync-fatal-");
    dirs.push(dir);
    const lines: string[] = [];
    const told: Error[] = [];
    const h = await openLocalDb(dir, { log: (event) => { lines.push(event); }, onFatal: (fatal) => { told.push(fatal); } });
    const acct = String(rowsOf(await h.db.execute(sql.raw("INSERT INTO accounts (name) VALUES ('fatal') RETURNING id::text AS id")))[0]!.id);
    await h.db.execute(sql`INSERT INTO rules (account_id, kind, match, destination) VALUES (${acct}::uuid, 'sender', 'before@rig.invalid', 'Archive')`);

    const f = fs as unknown as Record<string, unknown>;
    const real = f.fsyncSync;
    f.fsyncSync = () => {
      const e = new Error("EIO: i/o error, fsync") as NodeJS.ErrnoException;
      e.code = "EIO"; e.errno = -5; e.syscall = "fsync";
      throw e;
    };
    try { await h.checkpoint(); } finally { f.fsyncSync = real; }

    expect(told.map((e) => e.name), "the caller was not told the store's database ended").toEqual(["StoreAbortedError"]);
    expect(lines.filter((e) => e === "local_db_fatal"), "the end was not said once").toHaveLength(1);
    expect(lines, "the checkpoint called a dead store open and serving").not.toContain("local_db_checkpoint_failed");
    expect(await refusalOf(() => h.db.execute(sql.raw("SELECT count(*)::int AS c FROM rules")))).toBe("REFUSED StoreAbortedError");
    expect(await refusalOf(() => h.db.execute(sql`INSERT INTO rules (account_id, kind, match, destination) VALUES (${acct}::uuid, 'sender', 'after@rig.invalid', 'Archive')`))).toBe("REFUSED StoreAbortedError");
    expect(await refusalOf(() => h.db.transaction(async (tx) => tx.execute(sql.raw("SELECT 1"))))).toBe("REFUSED StoreAbortedError");
    await h.close();
    const record = JSON.parse(readFileSync(join(dir, "store-generation.json"), "utf8")) as { open: boolean };
    expect(record.open, "a run whose database ended was recorded as cleanly closed").toBe(true);

    // The next start recovers what was committed before the end, and nothing after it.
    const again = await openLocalDb(dir);
    open.push(again);
    expect(rowsOf(await again.db.execute(sql.raw("SELECT match FROM rules ORDER BY match"))).map((r) => r.match)).toEqual(["before@rig.invalid"]);
  }, 120_000);

  /* The verify's queued shape with no engine to end: an insert and an update admitted INSIDE the
     failing checkpoint's sync are refused at the module's door rather than answered as done. */
  it("refuses what was queued behind the failing checkpoint, and never answers it", async () => {
    const dir = await freshDataDir("ohmail-fsync-queued-");
    dirs.push(dir);
    const told: Error[] = [];
    const h = await openLocalDb(dir, { onFatal: (fatal) => { told.push(fatal); } });
    const client = clientOf(h);
    const acct = String(rowsOf(await client.query("INSERT INTO accounts (name) VALUES ('queued') RETURNING id::text AS id"))[0]!.id);
    await client.query("INSERT INTO rules (account_id, kind, match, destination) VALUES ($1::uuid, 'sender', 'before@rig.invalid', 'Archive')", [acct]);

    const f = fs as unknown as Record<string, unknown>;
    const real = f.fsyncSync;
    const queued: Array<Promise<string>> = [];
    f.fsyncSync = () => {
      if (queued.length === 0) {
        queued.push(refusalOf(() => client.query("INSERT INTO rules (account_id, kind, match, destination) VALUES ($1::uuid, 'sender', 'queued@rig.invalid', 'Archive') RETURNING id", [acct])));
        queued.push(refusalOf(() => client.query("UPDATE rules SET destination = 'Moved' WHERE match = 'before@rig.invalid'")));
      }
      throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO", errno: -5, syscall: "fsync" });
    };
    try { await h.checkpoint(); } finally { f.fsyncSync = real; }

    expect(await Promise.all(queued), "a statement queued behind the dead checkpoint was answered")
      .toEqual(["REFUSED StoreAbortedError", "REFUSED StoreAbortedError"]);
    expect(told.map((e) => e.name), "the end was not told once").toEqual(["StoreAbortedError"]);
    await h.close();
    const again = await openLocalDb(dir);
    open.push(again);
    expect(rowsOf(await again.db.execute(sql.raw("SELECT match, destination FROM rules ORDER BY match"))))
      .toEqual([{ match: "before@rig.invalid", destination: "Archive" }]);
  }, 120_000);

  /* The door on its own: told at the trap, synchronously; every entry after it refused unrun; and
     Emscripten's lazy binding, which assigns over the export, lands behind the guard. */
  it("puts the latch in front of Postgres' entries, refuses every entry after a trap, and keeps its place", () => {
    const guard = store.guardStoreModule;
    expect(typeof guard, "nothing guards the module's entries").toBe("function");
    const ran: string[] = [];
    const trap = (): never => { ran.push("one"); throw new WebAssembly.RuntimeError("Aborted()"); };
    const mod: Record<string, unknown> = {
      _interactive_write: () => { ran.push("write"); },
      _interactive_one: () => { mod._interactive_one = trap; return trap(); },
      _interactive_read: () => { ran.push("read"); return 0; },
    };
    const told: string[] = [];
    guard({ Module: mod } as never, store.storeLatch((fatal) => { told.push(fatal.name); }));
    const door = mod._interactive_one;

    (mod._interactive_write as () => void)();
    expect(() => (mod._interactive_one as () => void)()).toThrow("Aborted()");
    expect(mod._interactive_one, "the lazy binding replaced the guard").toBe(door);
    expect(told, "the trap was not told where it happened").toEqual(["StoreAbortedError"]);
    expect(() => (mod._interactive_read as () => void)()).toThrow(store.StoreAbortedError);
    expect(ran, "an entry after the trap reached the module").toEqual(["write", "one"]);
    expect(() => guard({ Module: { _interactive_one: () => 0 } } as never, store.storeLatch())).toThrow(/_interactive_write/);
  });

  /* The reading on its own: a WASM trap anywhere in the chain, or the refusal after one, and nothing else. */
  it("reads a store abort off a trap in the cause chain, and nothing else", () => {
    const read = store.isStoreAbort;
    expect(typeof read, "the store has no reading for its database ending").toBe("function");
    const trap = new WebAssembly.RuntimeError("Aborted()");
    expect(read(trap)).toBe(true);
    expect(read(new Error("the device store refused a statement", { cause: trap }))).toBe(true);
    expect(read(new store.StoreAbortedError(trap))).toBe(true);
    expect(read(new Error("duplicate key value violates unique constraint"))).toBe(false);
    expect(read(undefined)).toBe(false);
  });
});

/**
 * ═══ A STORE THIS START IS MAKING SYNCS ONCE, AT THE END ══════════════════════════════════════
 *
 * Until the tree sync has put every file of a new store on the disk, the start marker stands and
 * a cut sets the store aside; so the schema pass's own syncs (about 240 on 155 migrations, one
 * device flush each on macOS and Windows) bought nothing and cost the first start its seconds.
 * Counted at the `node:fs` seam on this thread, where the store's fsync runs (the tree sync's
 * threads have their own).
 */
describe("a store this start is making", () => {
  it("holds the schema pass's syncs for the tree sync, and syncs every commit after it", async () => {
    // EMPTY, never the template (`_datadir.ts`): the subject is the store this start makes.
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-fsync-first-start-"));
    dirs.push(dir);
    const marker = join(dir, store.STORE_UNFINISHED_FILE);
    const f = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
    const fsync = f.fsyncSync!;
    let inPass = false;
    const files = { start: 0, pass: 0, after: 0 };
    f.fsyncSync = function (this: unknown, ...a: unknown[]) {
      const out = fsync.apply(this, a);
      if (!fs.fstatSync(a[0] as number).isDirectory()) {
        if (!inPass) files.start += 1;
        else if (existsSync(marker)) files.pass += 1;
        else files.after += 1;
      }
      return out;
    };
    try {
      const h = await openLocalDb(dir, { onPhase: (p) => { if (p === "migrating") inPass = true; } });
      open.push(h);
      expect(files.start, "the start synced no file before the schema pass — the route is unproven").toBeGreaterThan(0);
      expect(files.pass, `the schema pass synced ${files.pass} files itself while the marker stood`).toBe(0);
      const before = files.after;
      await h.db.execute(sql.raw("CREATE TABLE first_start_probe (n int)"));
      await h.db.execute(sql.raw("INSERT INTO first_start_probe VALUES (1)"));
      expect(files.after - before, "a commit after the first start synced nothing — the hold outlived the tree sync")
        .toBeGreaterThan(0);
    } finally {
      f.fsyncSync = fsync;
    }
  }, 120_000);
});

describe("a store an earlier start made", () => {
  /* An older install's store: migrated through a prefix of the journal by drizzle's own migrator,
     so this open is an upgrade over a store that may hold somebody's mail. */
  async function oldInstall(dataDir: string, owed: number): Promise<void> {
    const entries = readJournalOf(MAIL_JOURNAL);
    const folder = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-fsync-journal-"));
    dirs.push(folder);
    cpSync(MAIL_JOURNAL.dir, folder, { recursive: true });
    const path = join(folder, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: unknown[] };
    journal.entries = entries.slice(0, entries.length - owed);
    writeFileSync(path, JSON.stringify(journal));
    const client = new PGliteClass(join(dataDir, PGDATA_SUBDIR));
    await client.waitReady;
    await migrate(drizzle(client, { schema: mailSchema }), { migrationsFolder: folder, migrationsSchema: MAIL_JOURNAL.migrationsSchema });
    await client.close();
  }

  it("syncs every migration its upgrade commits — the hold is a new store's alone", async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-fsync-upgrade-"));
    dirs.push(dir);
    await oldInstall(dir, 6);
    const f = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
    const fsync = f.fsyncSync!;
    let inPass = false;
    let pass = 0;
    f.fsyncSync = function (this: unknown, ...a: unknown[]) {
      const out = fsync.apply(this, a);
      if (inPass && !fs.fstatSync(a[0] as number).isDirectory()) pass += 1;
      return out;
    };
    try {
      const h = await openLocalDb(dir, { onPhase: (p, at) => { if (p === "migrating") inPass = at === undefined || at.applied < at.pending; } });
      open.push(h);
      expect(h.migrations?.applied, "the fixture owed nothing, so this is no upgrade").toBe(6);
      expect(pass, "an upgrade of a store that may hold mail committed its migrations unsynced").toBeGreaterThan(0);
    } finally {
      f.fsyncSync = fsync;
    }
  }, 180_000);
});
