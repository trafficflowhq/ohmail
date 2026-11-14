import { describe, expect, it } from "vitest";
import {
  OhmailEngine,
  SqlMirrorStore,
  flattenResponse,
  messagesByDateDesc,
  type SqlExecutor,
  type SqlStatement,
  type SyncResponse,
} from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { newDb, nodeSqlExecutor, sqlWorld } from "./helpers/node-sql-executor.js";

/**
 * THE IDB ORACLE, RE-RUN OVER THE SQL STORE.
 *
 * `SqlMirrorStore` is the React Native arm of the mirror, and the ruling for it is that it
 * passes the SAME convergence + atomicity oracle as the browser arm — so the suites below are
 * `idb-store.test.ts`'s cases with the store swapped, plus the shuffled-stream convergence
 * case from `convergence.test.ts` run THROUGH persistence, plus a failure-point sweep that
 * holds the page+cursor atomicity against a dying SQL runner (something fake-indexeddb cannot
 * stage). The SQL runner is `node:sqlite`; the app injects expo-sqlite behind the same seam.
 */

function serialize(store: SqlMirrorStore): string {
  const entries = [...store.snapshot().entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify(entries);
}

const seeded = () => new FixturesAdapter().sync({ since: "0", limit: 2000 });

describe("SqlMirrorStore — the idb persistence oracle", () => {
  it("persists entities + cursor + meta across instances (page and cursor land together)", async () => {
    const world = sqlWorld();
    const resp = await seeded();

    const a = new SqlMirrorStore({ dbName: "mirror-a", open: world.open });
    await a.load();
    expect(a.getCursor()).toBe("0");
    await a.applyResponse(resp);
    await a.setMeta("theme", "dark");
    const stateA = serialize(a);
    a.close();

    const b = new SqlMirrorStore({ dbName: "mirror-a", open: world.open });
    await b.load();
    expect(serialize(b)).toBe(stateA);
    expect(b.getCursor()).toBe(resp.cursor);
    expect(b.maxSeq()).toBe(a.maxSeq());
    expect(b.getMeta("theme")).toBe("dark");
    b.close();
  });

  it("re-applying a persisted page (crash-before-cursor replay) converges", async () => {
    const world = sqlWorld();
    const resp = await seeded();

    const a = new SqlMirrorStore({ dbName: "mirror-b", open: world.open });
    await a.load();
    await a.applyResponse(resp);
    const once = serialize(a);
    // Crash-replay: the same page arrives again (cursor had not advanced).
    await a.applyChanges(flattenResponse(resp));
    await a.applyResponse(resp);
    expect(serialize(a)).toBe(once);
    a.close();
  });

  it("a shuffled + duplicated single stream converges through persistence", async () => {
    const world = sqlWorld();
    const changes = flattenResponse(await seeded());

    const ordered = new SqlMirrorStore({ dbName: "mirror-ordered", open: world.open });
    await ordered.load();
    await ordered.applyChanges(changes);

    // Deterministic shuffle + every change applied twice — convergence.test.ts's stream, but
    // every apply lands in sqlite and the comparison reads a RELOADED store, so the JSON
    // round trip and the upsert path are inside the oracle rather than beside it.
    const shuffled = [...changes, ...changes];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = (i * 7919) % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const chaotic = new SqlMirrorStore({ dbName: "mirror-chaotic", open: world.open });
    await chaotic.load();
    await chaotic.applyChanges(shuffled);
    chaotic.close();

    const reloaded = new SqlMirrorStore({ dbName: "mirror-chaotic", open: world.open });
    await reloaded.load();
    expect(serialize(reloaded)).toBe(serialize(ordered));
    expect(reloaded.maxSeq()).toBe(ordered.maxSeq());
  });

  it("resetForBootstrap wipes persisted state and resets the cursor to 0", async () => {
    const world = sqlWorld();
    const resp = await seeded();

    const a = new SqlMirrorStore({ dbName: "mirror-c", open: world.open });
    await a.load();
    await a.applyResponse(resp);
    await a.resetForBootstrap();
    expect(a.snapshot().size).toBe(0);
    expect(a.getCursor()).toBe("0");
    a.close();

    const b = new SqlMirrorStore({ dbName: "mirror-c", open: world.open });
    await b.load();
    expect(b.snapshot().size).toBe(0);
    expect(b.getCursor()).toBe("0");
    b.close();
  });

  it("drives a full engine bootstrap and rehydrates without the adapter", async () => {
    const world = sqlWorld();
    const store = new SqlMirrorStore({ dbName: "mirror-d", open: world.open });
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), store, syncLimit: 7 });
    await engine.start(); // multi-page drain (hasMore) into sqlite
    const persisted = serialize(store);
    expect(store.snapshot().size).toBeGreaterThan(20);
    store.close();

    // Cold start: hydrate the mirror alone — the offline-first read path.
    const rehydrated = new SqlMirrorStore({ dbName: "mirror-d", open: world.open });
    await rehydrated.load();
    expect(serialize(rehydrated)).toBe(persisted);
    expect(rehydrated.getCursor()).toBe(store.getCursor());
    rehydrated.close();
  });
});

/**
 * INVARIANT #4's SHARP EDGE: A PAGE AND ITS CURSOR ADVANCE TOGETHER OR NOT AT ALL.
 *
 * The sweep below kills the SQL runner at EVERY write boundary a bootstrap crosses — including
 * inside the open ceremony — and after each death reopens the same database with a healthy
 * SQL runner and asks one question: does the persisted state hold the page exactly when it holds
 * the page's cursor? A store that flushed records and cursor in two separate batches has a
 * failure point where one landed without the other; this sweep visits that point by
 * construction, whatever its index turns out to be.
 *
 * Watched red: splitting `persist` into an entities batch followed by a cursor batch fails the
 * sweep at the boundary between them ("page applied without its cursor").
 */
describe("SqlMirrorStore — cursor atomicity under a dying statement runner", () => {
  /** Wrap a SQL runner so every write past the first `okWrites` throws BEFORE executing. */
  function dyingAfter(real: SqlExecutor, okWrites: number): { exec: SqlExecutor; writes: () => number } {
    let writes = 0;
    return {
      exec: {
        all: (sql, params) => real.all(sql, params),
        batch: (statements) => {
          if (writes++ >= okWrites) return Promise.reject(new Error("SqlExecutor killed"));
          return real.batch(statements);
        },
      },
      writes: () => writes,
    };
  }

  it("every failure point leaves the page applied IFF its cursor advanced", async () => {
    const resp = await seeded();

    // The reference: the fully-applied state, serialized once.
    const refWorld = sqlWorld();
    const ref = new SqlMirrorStore({ owner: "acct-A", open: refWorld.open });
    await ref.load();
    await ref.applyResponse(resp);
    const fullyApplied = serialize(ref);
    ref.close();

    // Measure how many write boundaries the whole ceremony crosses when nothing dies.
    const countDb = newDb();
    const counter = dyingAfter(nodeSqlExecutor(countDb), Number.MAX_SAFE_INTEGER);
    const counting = new SqlMirrorStore({ owner: "acct-A", open: () => counter.exec });
    await counting.load();
    await counting.applyResponse(resp);
    const total = counter.writes();
    expect(total).toBeGreaterThanOrEqual(3); // schema, stamp, page — at minimum

    for (let okWrites = 0; okWrites <= total; okWrites++) {
      const db = newDb();
      const dying = dyingAfter(nodeSqlExecutor(db), okWrites);
      const store = new SqlMirrorStore({ owner: "acct-A", open: () => dying.exec });
      // Every step may die — the sweep is interested in what PERSISTED, not in the rejection.
      try {
        await store.load();
        await store.applyResponse(resp);
      } catch {
        /* the SQL runner died at this boundary — inspect the corpse below */
      }

      const inspect = new SqlMirrorStore({ owner: "acct-A", open: () => nodeSqlExecutor(db) });
      await inspect.load();
      const cursorAdvanced = inspect.getCursor() === resp.cursor;
      const pageApplied = serialize(inspect) === fullyApplied;
      expect(
        pageApplied,
        `failure point ${okWrites}/${total}: page ${pageApplied ? "applied" : "absent"} but cursor ${
          cursorAdvanced ? "advanced" : "did not advance"
        } — the flush tore`,
      ).toBe(cursorAdvanced);
      inspect.close();
    }
  });

  /** One /sync page: a single created message at `seq`, cursor advanced to match. */
  const pageOf = (id: string, seq: number): SyncResponse => ({
    changes: {
      creates: [{
        type: "message", op: "create", id, seq,
        updatedAt: "2026-08-19T08:00:00Z",
        entity: { id, subject: id, folder: "INBOX", unread: true },
      }],
      updates: [], moves: [], deletes: [],
    },
    cursor: String(seq),
    hasMore: false,
    serverTime: "2026-08-19T08:00:00Z",
  });

  it("a failed flush POISONS the store until rehydration — a later cursor can never seal over the hole", async () => {
    // The sharp edge past the sweep above: `BaseMirrorStore` advances MEMORY before the flush,
    // so after one failed persist the in-memory cursor is a page ahead of disk. A retry that
    // simply drains on would fetch the NEXT page and flush ITS rows with ITS cursor — past
    // rows sqlite never received, a hole the seq guard cannot see. The store must refuse
    // every write from the failure until `load()` has re-read persisted truth.
    const db = newDb();
    const real = nodeSqlExecutor(db);
    let killNext = false;
    const flaky: SqlExecutor = {
      all: (sql, params) => real.all(sql, params),
      batch: (statements) => {
        if (killNext) {
          killNext = false;
          return Promise.reject(new Error("flush died"));
        }
        return real.batch(statements);
      },
    };

    const store = new SqlMirrorStore({ owner: "acct-A", open: () => flaky });
    await store.load();
    await store.applyResponse(pageOf("m1", 1));
    killNext = true;
    await expect(store.applyResponse(pageOf("m2", 2))).rejects.toThrow(/flush died/);

    // The SQL runner healed — but memory is ahead of disk. The next write REFUSES.
    await expect(store.applyResponse(pageOf("m3", 3))).rejects.toThrow(/reload/i);

    // On disk, the invariant held: cursor 1, no m2, no m3.
    const inspect = new SqlMirrorStore({ owner: "acct-A", open: () => real });
    await inspect.load();
    expect(inspect.getCursor()).toBe("1");
    expect(inspect.get("message", "m2")).toBeUndefined();
    expect(inspect.get("message", "m3")).toBeUndefined();
    inspect.close();

    // The recovery IS rehydration: memory returns to persisted truth, the hole is re-fetched.
    await store.load();
    expect(store.getCursor()).toBe("1");
    await store.applyResponse(pageOf("m2", 2));
    await store.applyResponse(pageOf("m3", 3));
    const after = new SqlMirrorStore({ owner: "acct-A", open: () => real });
    await after.load();
    expect(after.getCursor()).toBe("3");
    expect(after.get("message", "m2")).toBeDefined();
    expect(after.get("message", "m3")).toBeDefined();
    after.close();
  });

  it("load() hydrates from ONE read statement — entities and cursor from one snapshot", async () => {
    // Two separate SELECTs are two sqlite read transactions, and a page committed by another
    // handle between them hydrates OLD rows under the NEW cursor — the session then resumes
    // past mail it never read. One statement is one snapshot; this pins the count.
    const db = newDb();
    const real = nodeSqlExecutor(db);
    let reads = 0;
    const counting: SqlExecutor = {
      all: (sql, params) => {
        reads++;
        return real.all(sql, params);
      },
      batch: (statements) => real.batch(statements),
    };
    const store = new SqlMirrorStore({ owner: "acct-A", open: () => counting });
    await store.load();
    await store.applyResponse(pageOf("m1", 1));
    reads = 0;
    await store.load(); // the store is open — this load is pure hydration
    expect(reads).toBe(1);
    expect(store.get("message", "m1")).toBeDefined();
    expect(store.getCursor()).toBe("1");
    store.close();
  });

  it("a failed open ceremony CLOSES the statement runner it opened", async () => {
    // The opener succeeded, the schema batch died: the handle was never published to the
    // store, so nothing else can release it — retries would accumulate native connections.
    let closed = 0;
    const dead: SqlExecutor = {
      all: async () => [],
      batch: async () => {
        throw new Error("disk full");
      },
      close: () => {
        closed++;
      },
    };
    const store = new SqlMirrorStore({ owner: "acct-A", open: () => dead });
    await expect(store.load()).rejects.toThrow(/disk full/);
    expect(closed).toBe(1);
  });

  it("a store that failed to open retries instead of latching the rejection", async () => {
    const db = newDb();
    const real = nodeSqlExecutor(db);
    let healthy = false;
    const flaky: SqlExecutor = {
      all: (sql, params) => real.all(sql, params),
      batch: (statements) =>
        healthy ? real.batch(statements) : Promise.reject(new Error("storage refused")),
    };
    const store = new SqlMirrorStore({ owner: "acct-A", open: () => flaky });
    await expect(store.load()).rejects.toThrow(/storage refused/);
    healthy = true; // the host's storage recovers…
    await expect(store.load()).resolves.toBeUndefined(); // …and the same store opens
    const resp = await seeded();
    await store.applyResponse(resp);
    expect(store.snapshot().size).toBeGreaterThan(0);
    store.close();
  });
});

/**
 * The one liberty a SQL runner must not take, held against the REAL one used above: a batch
 * that dies mid-list rolls everything back. If `nodeSqlExecutor` ever stopped wrapping the
 * list in a transaction, the atomicity sweep would be green over a SQL runner that lies —
 * this is the control that keeps the oracle honest.
 */
describe("the node:sqlite statement runner itself", () => {
  it("rolls back the whole batch when one statement dies", async () => {
    const db = newDb();
    const exec = nodeSqlExecutor(db);
    await exec.batch([{ sql: "CREATE TABLE t (k TEXT PRIMARY KEY)" }]);
    const bad: SqlStatement[] = [
      { sql: "INSERT INTO t (k) VALUES (?)", params: ["a"] },
      { sql: "INSERT INTO nonexistent (k) VALUES (?)", params: ["b"] },
    ];
    await expect(exec.batch(bad)).rejects.toThrow();
    expect(await exec.all("SELECT k FROM t")).toEqual([]);
  });
});

describe("SqlMirrorStore — hydration stamps the types (INCIDENT-021's phone twin)", () => {
  it("a warm mirror is visible to stamp-keyed derivations after load()", async () => {
    const world = sqlWorld();
    const resp = await seeded();

    const a = new SqlMirrorStore({ dbName: "mirror-stamp", open: world.open });
    await a.load();
    await a.applyResponse(resp);

    const b = new SqlMirrorStore({ dbName: "mirror-stamp", open: world.open });
    // The pre-hydration read that seeds the date-order cache at stamp 0.
    expect(messagesByDateDesc(b)).toHaveLength(0);
    await b.load();
    const held = b.list<unknown>("message").length;
    expect(held).toBeGreaterThan(0);
    expect(b.stampOf("message")).toBeGreaterThan(0);
    expect(messagesByDateDesc(b)).toHaveLength(held);
  });
});

/**
 * A commit is on the disk when its batch resolves. SQLite's default journal commits by unlinking
 * the journal, and only EXTRA flushes the directory after that unlink, so the setting is read back
 * on the connection the store writes through; a connection nobody configured reads the default.
 */
describe("SqlMirrorStore — a commit is on the disk when its batch resolves", () => {
  it("the mirror's own connection runs at synchronous EXTRA", async () => {
    const exec = nodeSqlExecutor(newDb());
    const store = new SqlMirrorStore({ owner: "acct-A", open: () => exec });
    await store.load();
    expect(await exec.all("PRAGMA synchronous"), "3 is EXTRA").toEqual([{ synchronous: 3 }]);
    expect(await nodeSqlExecutor(newDb()).all("PRAGMA synchronous"), "control: SQLite's default, FULL").toEqual([{ synchronous: 2 }]);
    store.close();
  });
});
