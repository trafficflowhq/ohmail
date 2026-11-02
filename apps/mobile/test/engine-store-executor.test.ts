/**
 * THE ENGINE STORE'S PLATFORM BINDING — positional rows, one transaction, one handle.
 *
 * `expoEngineExecutor` is what the mail engine's store talks to on a phone. Four properties decide
 * whether mail survives, and each one has a failure that is silent rather than loud:
 *
 *  · **rows are positional, with the statement's own column names.** The layer above maps rows to
 *    columns BY POSITION. A binding that answered row objects would collapse two columns of one
 *    name into a single key and fill both positions from one value — a full-length row carrying the
 *    wrong data, which nothing errors on.
 *  · **`batch` is one transaction on one handle.** Not `withExclusiveTransactionAsync`, which opens
 *    a SECOND connection: that has already cost this app twice, once as "database is locked" when
 *    two writers overlapped and once as a connection that never received `PRAGMA foreign_keys = ON`
 *    and wrote unenforced references for as long as it lived.
 *  · **every call is serialized.** The driver is asynchronous, so two overlapping read-modify-writes
 *    lose one.
 *  · **statements are finalized.** An unfinalized statement holds a cursor on the file.
 *
 * ── THE DOUBLE HAS THE PLATFORM'S API SHAPE AND REAL SQL BEHIND IT ────────────────────────
 *
 * It exposes exactly the four methods the real database does, with the same asynchrony, and runs
 * the statements against `node:sqlite` — so the SQL is real, a rollback really rolls back, and
 * `select 1 as a, 2 as a` really does produce two columns of one name. A double that returned
 * canned values could not fail the way the platform fails, which is the only thing that makes any
 * of these cases evidence.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENGINE_DB_FILE,
  ENGINE_DB_OPEN_OPTIONS,
  expoEngineExecutor,
  openLocalEnginePlatform,
  removeStandaloneEngine,
  type EngineDbOpenOptions,
  type EngineStoreDatabase,
  type LocalEnginePlatformVerdict,
} from "../src/engine/local-engine";
import { KEK_KEY } from "../src/engine/kek";
import type { SecureKV } from "../src/state/servers";
import { DE } from "../src/copy.de";
import { EN } from "../src/copy.en";

const sqlite = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    close(): void;
    prepare(sql: string): {
      all(...p: unknown[]): unknown[];
      run(...p: unknown[]): unknown;
      columns(): { name?: string; column?: string | null }[];
    };
  };
};

interface Recorded {
  readonly calls: string[];
  finalized: number;
  prepared: number;
  closed: number;
}

/**
 * The platform's API shape over real SQL. Every method awaits a macrotask first, which is what lets
 * two callers interleave — the hazard the serialization exists to prevent and one a synchronous
 * double cannot express.
 */
function fakeExpoDatabase(rec: Recorded): EngineStoreDatabase {
  const raw = new sqlite.DatabaseSync(":memory:");
  const yielded = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return {
    async prepareAsync(source: string) {
      await yielded();
      rec.prepared += 1;
      rec.calls.push(source);
      const statement = raw.prepare(source);
      return {
        async executeForRawResultAsync(params: readonly unknown[]) {
          await yielded();
          const objects = statement.all(...(params as unknown[])) as Record<string, unknown>[];
          const columns = statement.columns().map((c) => c.name ?? c.column ?? "");
          /* THE PLATFORM'S OWN BEHAVIOUR: it answers each row as an array of VALUES. Reproduced
             here from the statement's column metadata rather than from the row object's keys,
             because that is the difference the whole contract is about. */
          const rows = objects.map((o) => columns.map((c) => o[c]));
          return { async getAllAsync() { return rows; } };
        },
        async executeAsync(params: readonly unknown[]) {
          await yielded();
          return statement.run(...(params as unknown[]));
        },
        async getColumnNamesAsync() {
          await yielded();
          return statement.columns().map((c) => c.name ?? c.column ?? "");
        },
        async finalizeAsync() {
          await yielded();
          rec.finalized += 1;
        },
      };
    },
    async closeAsync() {
      rec.closed += 1;
      raw.close();
    },
  };
}

const recorder = (): Recorded => ({ calls: [], finalized: 0, prepared: 0, closed: 0 });

describe("the engine store's platform binding", () => {
  it("answers rows POSITIONALLY, with the statement's own column names", async () => {
    const rec = recorder();
    const exec = expoEngineExecutor(fakeExpoDatabase(rec));

    const answer = await exec.all("select 1 as one, 'x' as two", []);

    expect(answer.columns).toEqual(["one", "two"]);
    expect(answer.rows).toEqual([[1, "x"]]);
    await exec.close();
  });

  /**
   * ── THE DUPLICATE-COLUMN PROPERTY IS A DEVICE CRITERION, AND THIS HARNESS CANNOT PROVE IT ──
   *
   * The contract exists because the layer above maps rows by POSITION: a binding that answered row
   * objects would collapse `select 1 as a, 2 as a` to a single key and fill both positions from it,
   * a full-length row carrying the wrong data with nothing to error on.
   *
   * The real platform answers positional values from the driver, so it cannot make that mistake.
   * `node:sqlite` has NO positional API, so this double has to rebuild positions from the row
   * object — which is the lossy path itself. Asserting `[[1, 2]]` here therefore measured the
   * fixture and failed: the double answered `[[2, 2]]`, correctly, because that is all it can know.
   *
   * So this case asserts the SHAPE the contract guarantees, which the double can honestly show, and
   * the value-preservation half is named as belonging to a device run rather than quietly dropped. A
   * case that cannot distinguish the behaviour under test is worse than no case, because it reads
   * like coverage.
   */
  it("pairs columns and values by POSITION, one value per column", async () => {
    const rec = recorder();
    const exec = expoEngineExecutor(fakeExpoDatabase(rec));

    const answer = await exec.all("select 1 as one, 'x' as two, 3 as three", []);

    expect(answer.columns).toEqual(["one", "two", "three"]);
    expect(answer.rows[0]).toHaveLength(answer.columns.length);
    expect(answer.rows).toEqual([[1, "x", 3]]);
    await exec.close();
  });

  it("runs a batch as ONE transaction on the SAME handle", async () => {
    const rec = recorder();
    const exec = expoEngineExecutor(fakeExpoDatabase(rec));
    await exec.run("create table t (v integer)", []);
    const before = rec.calls.length;

    await exec.batch([
      { sql: "insert into t (v) values (?)", params: [1] },
      { sql: "insert into t (v) values (?)", params: [2] },
    ]);

    // BEGIN, the two writes, COMMIT — in that order, through this handle. No second connection is
    // opened anywhere: the double has no API for one, which is itself part of the assertion.
    expect(rec.calls.slice(before)).toEqual([
      "BEGIN IMMEDIATE",
      "insert into t (v) values (?)",
      "insert into t (v) values (?)",
      "COMMIT",
    ]);
    expect((await exec.all("select v from t order by v", [])).rows).toEqual([[1], [2]]);
    await exec.close();
  });

  it("rolls a failed batch back whole, and reports the ORIGINAL failure", async () => {
    const rec = recorder();
    const exec = expoEngineExecutor(fakeExpoDatabase(rec));
    await exec.run("create table t (v integer)", []);

    const err = await exec
      .batch([
        { sql: "insert into t (v) values (?)", params: [1] },
        { sql: "insert into nonexistent (v) values (?)", params: [2] },
      ])
      .then(() => null, (e: unknown) => e as Error);

    // The caller sees what actually went wrong, not the rollback's own noise — the rollback's error
    // is swallowed precisely so it cannot mask this.
    expect(err?.message ?? "").toMatch(/nonexistent/);
    // And the first write is GONE. A half-applied batch is the outcome the transaction exists to
    // make unrepresentable.
    expect((await exec.all("select v from t", [])).rows).toEqual([]);
    expect(rec.calls).toContain("ROLLBACK");
    await exec.close();
  });

  it("serializes overlapping callers — asserted by the ORDER of what reached the store", async () => {
    const rec = recorder();
    const exec = expoEngineExecutor(fakeExpoDatabase(rec));
    await exec.run("create table t (v integer)", []);
    const before = rec.calls.length;

    // Two batches started in the same tick. With the queue removed, the driver's own yields
    // interleave them and a `BEGIN` lands inside the other's transaction — which on the real store
    // is refused outright, losing that writer's work.
    await Promise.all([
      exec.batch([{ sql: "insert into t (v) values (1)" }]),
      exec.batch([{ sql: "insert into t (v) values (2)" }]),
    ]);

    const seen = rec.calls.slice(before);
    expect(seen).toEqual([
      "BEGIN IMMEDIATE", "insert into t (v) values (1)", "COMMIT",
      "BEGIN IMMEDIATE", "insert into t (v) values (2)", "COMMIT",
    ]);
    await exec.close();
  });

  /* THE CLOSE FINDS NOTHING OF OURS. With `finalizeUnusedStatementsBeforeClosing` off, a statement
     this statement runner left open is not finalized by the platform: `sqlite3_close` refuses the file instead.
     So the count is taken AT the close, over the paths that fail as well as the ones that succeed. */
  it("leaves no statement of its own for the close, the failed ones included", async () => {
    const rec = recorder();
    let openAtClose: number | null = null;
    const db = fakeExpoDatabase(rec);
    const close = db.closeAsync.bind(db);
    db.closeAsync = async () => { openAtClose = rec.prepared - rec.finalized; await close(); };
    const exec = expoEngineExecutor(db);
    await exec.run("create table t (v integer not null)", []);
    await exec.all("select v from t", []);
    await exec.batch([{ sql: "insert into t (v) values (1)" }]);
    await exec.run("insert into t (v) values (null)", []).catch(() => undefined);
    await exec.batch([{ sql: "insert into t (v) values (2)" }, { sql: "insert into t (v) values (null)" }]).catch(() => undefined);
    await exec.close();
    expect(rec.prepared).toBeGreaterThan(8);
    expect(openAtClose, "statements this SqlExecutor prepared and never finalized").toBe(0);
  });

  it("finalizes every statement it prepares", async () => {
    const rec = recorder();
    const exec = expoEngineExecutor(fakeExpoDatabase(rec));
    await exec.run("create table t (v integer)", []);
    await exec.all("select v from t", []);
    await exec.batch([{ sql: "insert into t (v) values (3)" }]);

    // An unfinalized statement holds a cursor on the file. Counted rather than sampled, because
    // one leaked cursor per drain page is the shape that only shows up on a long sync.
    expect(rec.finalized).toBe(rec.prepared);
    expect(rec.prepared).toBeGreaterThan(3);
    await exec.close();
  });

  /* A REFUSED CONNECT STOPS THE ENGINE WHILE A STATEMENT IS OUT: the close waits its turn, so the
     native handle is never closed under a statement, and nothing reaches it afterwards. */
  it("closes only after the statement in flight is finalized", async () => {
    const rec = recorder();
    const db = fakeExpoDatabase(rec);
    const atClose: string[] = [];
    const close = db.closeAsync.bind(db);
    db.closeAsync = async () => { atClose.push(`${rec.prepared - rec.finalized} open of ${rec.prepared}`); await close(); };
    const exec = expoEngineExecutor(db);
    const read = exec.all("select 1 as one", []);
    await exec.close();
    expect((await read).rows).toEqual([[1]]);
    expect(atClose).toEqual(["0 open of 1"]);
  });

  it("refuses a statement after the close without touching the closed handle", async () => {
    const rec = recorder();
    const exec = expoEngineExecutor(fakeExpoDatabase(rec));
    await exec.run("create table t (v integer)", []);
    const closing = exec.close();
    const late = exec.all("select v from t", []);
    await closing;
    const prepared = rec.prepared;
    await expect(late).rejects.toMatchObject({ code: "engine_store_closed" });
    await expect(exec.run("insert into t (v) values (1)", [])).rejects.toMatchObject({ code: "engine_store_closed" });
    await expect(exec.batch([{ sql: "insert into t (v) values (2)" }])).rejects.toMatchObject({ code: "engine_store_closed" });
    expect(rec.prepared, "a statement reached the closed handle").toBe(prepared);
    expect(EN.storeFault("engine_store_closed")).not.toBe("engine_store_closed");
    expect(DE.storeFault("engine_store_closed")).not.toBe("engine_store_closed");
  });

  it("closes the handle once, however often it is asked", async () => {
    const rec = recorder();
    const exec = expoEngineExecutor(fakeExpoDatabase(rec));
    await Promise.all([exec.close(), exec.close()]);
    await exec.close();
    expect(rec.closed).toBe(1);
  });
});

describe("opening the platform", () => {
  /* NO REMOVAL IN FLIGHT — the ordinary install, and the arm these two cases are about. The
     removal belt has its own cases in `forget.test.ts`, against a real store. */
  const noRemoval = () => ({ recorded: async () => null, clear: async () => undefined });

  const memoryKV = (seed?: Record<string, string>): SecureKV => {
    const store = new Map<string, string>(Object.entries(seed ?? {}));
    return {
      async get(k) { return store.get(k) ?? null; },
      async set(k, v) { store.set(k, v); },
      async remove(k) { store.delete(k); },
    };
  };

  it("opens the engine's OWN database file, not the mirror's", async () => {
    const rec = recorder();
    const opened: string[] = [];
    const platform = await openLocalEnginePlatform({
      openDatabase: async (name) => { opened.push(name); return fakeExpoDatabase(rec); },
      deleteDatabase: async () => undefined,
      kv: memoryKV(),
      randomKekHex: () => "a".repeat(64),
      removal: noRemoval(),
    });

    expect(platform.kind, "the platform refused where it must open").toBe("ready");
    const ready = platform as Extract<LocalEnginePlatformVerdict, { kind: "ready" }>;
    expect(opened).toEqual([ENGINE_DB_FILE]);
    // The key ring in the desktop's shape, one version.
    expect(ready.keks).toEqual({ 1: "a".repeat(64) });
    await ready.exec.close();
  });

  it("CLOSES the store when the key cannot be resolved", async () => {
    // The order matters: store first, key second, and a key failure must not leave a file handle
    // open for an engine that will not start. Watched by counting the close.
    const rec = recorder();
    const outcome = await openLocalEnginePlatform({
      openDatabase: async () => fakeExpoDatabase(rec),
      deleteDatabase: async () => undefined,
      kv: memoryKV({ [KEK_KEY]: "not-a-key" }),
      randomKekHex: () => "a".repeat(64),
      removal: noRemoval(),
    });

    /* A REFUSAL, not a throw: the reason carries a deck key, so the door renders it in the
       reader's language and `gate.ts` routes it to the surface that shows a reason. */
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" ? outcome.reason.say : null).toBe("kekUnreadable");
    expect(rec.closed).toBe(1);
  });
});

/**
 * ── THE ENGINE STORE'S CLOSE AFTER FTS5 HAS RUN ON IT ──────────────────────────────────────
 *
 * expo-sqlite's close, as measured on Android (host ASAN over the real engine store, and the
 * device's frames): with `finalizeUnusedStatementsBeforeClosing` on it finalizes every statement
 * SQLite lists, which after FTS5 ran includes FTS5's own, and `sqlite3_close` frees those again —
 * the process aborts. This double answers that close with a rejection instead of an abort, keeps a
 * handle open when its close fails, and refuses to delete a file a handle still holds, as expo does.
 */
function expoShapedStore(dir: string) {
  const open = new Map<string, number>();
  const opened: (EngineDbOpenOptions | undefined)[] = [];
  const refusedDeletes: string[] = [];
  const openDatabase = async (name: string, options?: EngineDbOpenOptions): Promise<EngineStoreDatabase> => {
    opened.push(options);
    const raw = new sqlite.DatabaseSync(join(dir, name));
    open.set(name, (open.get(name) ?? 0) + 1);
    let ftsRan = false;
    const fts = (sql: string): boolean => /fts5|_fts\b/iu.test(sql);
    return {
      async prepareAsync(source: string) {
        const statement = raw.prepare(source);
        return {
          async executeForRawResultAsync(params: readonly unknown[]) {
            if (fts(source)) ftsRan = true;
            const objects = statement.all(...(params as unknown[])) as Record<string, unknown>[];
            const columns = statement.columns().map((c) => c.name ?? c.column ?? "");
            return { async getAllAsync() { return objects.map((o) => columns.map((c) => o[c])); } };
          },
          async executeAsync(params: readonly unknown[]) {
            if (fts(source)) ftsRan = true;
            return statement.run(...(params as unknown[]));
          },
          async getColumnNamesAsync() { return statement.columns().map((c) => c.name ?? c.column ?? ""); },
          async finalizeAsync() {},
        };
      },
      async closeAsync() {
        if (ftsRan && options?.finalizeUnusedStatementsBeforeClosing !== false) {
          throw new Error("FTS5's statements finalized twice at close (the device aborts here)");
        }
        raw.close();
        open.set(name, (open.get(name) ?? 1) - 1);
      },
    };
  };
  const deleteDatabase = async (name: string): Promise<void> => {
    if ((open.get(name) ?? 0) > 0) { refusedDeletes.push(name); throw new Error(`${name} is still open`); }
    rmSync(join(dir, name), { force: true });
  };
  return { openDatabase, deleteDatabase, opened, refusedDeletes, open };
}

describe("the engine store closes after FTS5 has run on it", () => {
  const memoryKV = (): SecureKV => {
    const store = new Map<string, string>();
    return {
      async get(k) { return store.get(k) ?? null; },
      async set(k, v) { store.set(k, v); },
      async remove(k) { store.delete(k); },
    };
  };
  const world = () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmail-engine-close-"));
    return { dir, store: expoShapedStore(dir), kv: memoryKV(), done: () => rmSync(dir, { recursive: true, force: true }) };
  };
  const indexOne = async (exec: { run(sql: string, p: readonly unknown[]): Promise<void> }) => {
    await exec.run("create virtual table if not exists m_fts using fts5(subject)", []);
    await exec.run("insert into m_fts (subject) values ('delivery')", []);
  };

  it("closes, through the platform door, with the options every opener passes", async () => {
    const w = world();
    try {
      const platform = await openLocalEnginePlatform({
        openDatabase: w.store.openDatabase, deleteDatabase: w.store.deleteDatabase, kv: w.kv,
        randomKekHex: () => "a".repeat(64), removal: { recorded: async () => null, clear: async () => undefined },
      });
      expect(platform.kind).toBe("ready");
      const ready = platform as Extract<LocalEnginePlatformVerdict, { kind: "ready" }>;
      await indexOne(ready.exec);
      await expect(ready.exec.close()).resolves.toBeUndefined();
      expect(w.store.opened).toEqual([ENGINE_DB_OPEN_OPTIONS]);
    } finally { w.done(); }
  });

  it("the double refuses that close where the store is opened without them", async () => {
    const w = world();
    try {
      const exec = expoEngineExecutor(await w.store.openDatabase(ENGINE_DB_FILE));
      await indexOne(exec);
      await expect(exec.close()).rejects.toThrow(/finalized twice/u);
    } finally { w.done(); }
  });

  it("releases the file: Stop and remove reopens it, deletes it and reads nothing back", async () => {
    const w = world();
    try {
      const platform = await openLocalEnginePlatform({
        openDatabase: w.store.openDatabase, deleteDatabase: w.store.deleteDatabase, kv: w.kv,
        randomKekHex: () => "a".repeat(64), removal: { recorded: async () => null, clear: async () => undefined },
      });
      const ready = platform as Extract<LocalEnginePlatformVerdict, { kind: "ready" }>;
      await indexOne(ready.exec);
      await ready.exec.close();
      await removeStandaloneEngine({ openDatabase: w.store.openDatabase, deleteDatabase: w.store.deleteDatabase, kv: w.kv });
      expect(w.store.refusedDeletes, "a delete refused over a handle the close did not release").toEqual([]);
      expect(w.store.opened).toEqual([ENGINE_DB_OPEN_OPTIONS, ENGINE_DB_OPEN_OPTIONS]);
      expect(w.store.open.get(ENGINE_DB_FILE)).toBe(0);
    } finally { w.done(); }
  });
});
