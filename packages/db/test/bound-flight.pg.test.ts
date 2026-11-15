import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { brandDialect } from "../src/dialect/index.js";
import {
  bindDb, bindingOf, rebindTx, BindingRefusedError, type AccountBound, type NothingBound,
} from "../src/bound.js";
import {
  acquireCeilingHandle, closePooledDbs, DbParameterTypeError, FlightClosedError, isDbAcquireTimeout, makeOwnedDb,
  makePooledDb, type OwnedDb,
} from "../src/client.js";
import { readFlightOf } from "../src/read-flight.js";
import { PG_TEST_URL, realPgAvailable, recordPgWire } from "../src/testing.js";

/**
 * THE DOOR ON THE WIRE: a bound handle's statements and transactions run in flights that write the
 * binder's statement right after BEGIN, before anything is read. Counted off the protocol bytes on
 * a pool of one (the pooled handle) and on the self-hosted pool. Nothing here reads a policy (none
 * exists until the lock is switched on): what is proven is what reaches the wire, in what order, and
 * what a connection carries afterwards.
 */
const wire = recordPgWire();
const PG_UP = await realPgAvailable();

const A = randomUUID();
const B = randomUUID();
const CANARY = `canary-${randomUUID()}`;

/** How often `needle` occurs in `hay`. */
const occurrences = (hay: Buffer, needle: string): number => {
  let n = 0;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) n++;
  return n;
};

/** Every string reachable from `value` through own properties, enumerable or not, symbols included. */
function strings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value];
  if (value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return [];
  seen.add(value);
  const keys = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)];
  return keys.flatMap((k) => {
    let v: unknown;
    try { v = (value as Record<PropertyKey, unknown>)[k]; } catch { return []; }
    return strings(v, seen);
  });
}

type Tx = { transaction: <R>(fn: (tx: object) => Promise<R>, config?: object) => Promise<R>; execute: (q: unknown) => Promise<unknown> };
const rowsOf = (r: unknown): Array<Record<string, unknown>> => r as Array<Record<string, unknown>>;

describe.skipIf(!PG_UP)("the binding on the wire (real Postgres)", () => {
  let pool: ReturnType<typeof makePooledDb>;
  let owned: OwnedDb;

  /** The connection's own settings, read on the plain handle: what the next flight would inherit. */
  const leftover = async (): Promise<[string, string]> => {
    const [row] = rowsOf(await pool.execute(sql`select current_setting('ohmail.account', true) as a, current_setting('ohmail.key', true) as k`));
    return [String(row?.a ?? ""), String(row?.k ?? "")];
  };

  beforeAll(async () => {
    pool = makePooledDb(PG_TEST_URL, { max: 1 });
    owned = makeOwnedDb(PG_TEST_URL, { role: "api" });
    await pool.execute(sql`create table if not exists tf_bound_deferred (id int primary key,
      ref int references tf_bound_deferred(id) deferrable initially deferred)`);
    await pool.execute(sql`select 1`);
  });

  afterAll(async () => {
    await pool.execute(sql`drop table if exists tf_bound_deferred`).catch(() => undefined);
    await owned.close();
    await closePooledDbs();
  });

  it("a lone statement: begin, the binder, the statement and commit in one burst; the values ride in a Bind, never in text", async () => {
    const view = bindDb(pool, { account: A, key: CANARY });
    wire.start();
    const got = await view.execute(sql`select ${7}::int as seven`);
    const r = wire.read();
    expect(rowsOf(got)[0]?.seven).toBe(7);
    expect(r.burstShapes).toEqual(["QPDBESPDBESQ"]);
    const binds = Buffer.concat(r.binds);
    expect(occurrences(binds, A)).toBe(1);
    expect(occurrences(binds, CANARY)).toBe(1);
    // Every statement's text, the binder's among them: neither value is ever written into one.
    const texts = Buffer.concat(r.texts);
    expect(occurrences(texts, "set_config('ohmail.account', $1, true)")).toBe(1);
    expect(occurrences(texts, A)).toBe(0);
    expect(occurrences(texts, CANARY)).toBe(0);
  });

  it("a read-only flight: begin read only, the binder and the first read written before any answer", async () => {
    const view = bindDb(pool, { account: A }) as unknown as object;
    const { readFlightOf } = await import("../src/read-flight.js");
    const flight = readFlightOf(view) as unknown as Tx;
    expect(bindingOf(flight)).toBe(bindingOf(view));
    wire.start();
    const got = await flight.transaction(async (tx) =>
      rowsOf(await (tx as unknown as Tx).execute(sql`select current_setting('ohmail.account', true) as a, ${1}::int as one`)));
    expect(got[0]?.a).toBe(A);
    expect(wire.read().burstShapes[0]).toBe("QPDBESPDBES");
    expect(await leftover()).toEqual(["", ""]);
  });

  it("a read-write flight writes no body frame before its start has answered", async () => {
    const view = bindDb(pool, { account: A }) as unknown as Tx;
    wire.start();
    const got = await view.transaction(async (tx) =>
      rowsOf(await (tx as unknown as Tx).execute(sql`select current_setting('ohmail.account', true) as a, ${2}::int as two`)));
    expect(got[0]?.a).toBe(A);
    expect(wire.read().burstShapes).toEqual(["QPDBES", "PDBES", "Q"]);
    expect(await leftover()).toEqual(["", ""]);
  });

  it("modes ride in BEGIN from a closed list; a mode outside it is refused before a connection is taken", async () => {
    const view = bindDb(pool, { account: A }) as unknown as Tx;
    const level = await view.transaction(async (tx) =>
      rowsOf(await (tx as unknown as Tx).execute(sql`select current_setting('transaction_isolation') as l`))[0]?.l,
    { isolationLevel: "serializable" });
    expect(level).toBe("serializable");
    await expect(view.transaction(async () => 1, { isolationLevel: "serializable; drop table x" })).rejects.toBeInstanceOf(TypeError);
  });

  it("a handle used after its flight closed throws and writes nothing", async () => {
    const view = bindDb(pool, { account: A }) as unknown as Tx;
    let leaked: Tx | null = null;
    await view.transaction(async (tx) => { leaked = tx as unknown as Tx; });
    wire.start();
    await expect(leaked!.execute(sql`select ${1}::int`)).rejects.toBeInstanceOf(FlightClosedError);
    expect(wire.read().flushes).toEqual([]);
  });

  it("a statement error the callback swallowed fails the transaction, and nothing of it stands", async () => {
    const view = bindDb(pool, { account: A }) as unknown as Tx;
    const id = Math.floor(Math.random() * 1e6) + 10;
    const err = await view.transaction(async (tx) => {
      await (tx as unknown as Tx).execute(sql`insert into tf_bound_deferred (id) values (${id})`);
      await (tx as unknown as Tx).execute(sql`select 1 / ${0}::int`).catch(() => undefined);
    }).then(() => null, (e: unknown) => e);
    expect((err as { code?: string }).code).toBe("22012");
    expect(rowsOf(await pool.execute(sql`select count(*)::int as n from tf_bound_deferred where id = ${id}`))[0]?.n).toBe(0);
  });

  it("a savepoint is written without a wait and rolled back alone on failure", async () => {
    const view = bindDb(pool, { account: A }) as unknown as Tx;
    const id = Math.floor(Math.random() * 1e6) + 10;
    wire.start();
    await view.transaction(async (tx) => {
      const t = tx as unknown as Tx;
      await t.execute(sql`insert into tf_bound_deferred (id) values (${id})`);
      await t.transaction(async (sp) => {
        await (sp as unknown as Tx).execute(sql`select 1 / ${0}::int`);
      }).catch(() => undefined);
      const [row] = rowsOf(await t.execute(sql`select current_setting('ohmail.account', true) as a`));
      expect(row?.a).toBe(A);
    });
    // begin and the binder; the insert; `savepoint s0` with its statement, unwaited; `rollback to s0`;
    // the read after it (no parameter: a simple query); commit.
    expect(wire.read().burstShapes.join(" | ")).toBe("QPDBES | PDBES | QPDBES | Q | Q | Q");
    expect(rowsOf(await pool.execute(sql`select count(*)::int as n from tf_bound_deferred where id = ${id}`))[0]?.n).toBe(1);
    await pool.execute(sql`delete from tf_bound_deferred where id = ${id}`);
  });

  it("after a failing statement, a failing commit and a killed backend, the connection carries no account", async () => {
    const view = bindDb(pool, { account: A, key: CANARY }) as unknown as Tx;
    const failing = await view.execute(sql`select 1 / ${0}::int`).then(() => null, (e: unknown) => e);
    expect((failing as { code?: string }).code).toBe("22012");
    expect(await leftover()).toEqual(["", ""]);

    const id = Math.floor(Math.random() * 1e6) + 10;
    const commit = await view.transaction(async (tx) => {
      await (tx as unknown as Tx).execute(sql`insert into tf_bound_deferred (id, ref) values (${id}, ${id + 1})`);
    }).then(() => null, (e: unknown) => e);
    expect((commit as { code?: string }).code).toBe("23503");
    expect(await leftover()).toEqual(["", ""]);

    const killer = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    try {
      const dead = await view.transaction(async (tx) => {
        const [row] = rowsOf(await (tx as unknown as Tx).execute(sql`select pg_backend_pid() as pid`));
        await killer`select pg_terminate_backend(${Number(row!.pid)})`;
        await (tx as unknown as Tx).execute(sql`select pg_sleep(${0.2})`);
      }).then(() => null, (e: unknown) => e);
      expect(dead).not.toBeNull();
    } finally {
      await killer.end({ timeout: 5 });
    }
    expect(await leftover()).toEqual(["", ""]);
  });

  it("a lone write refused for its parameter's type says it was committed", async () => {
    const view = bindDb(pool, { account: A });
    const lone = await view.execute(sql`select ${"t"}::boolean as v`).then(() => null, (e: unknown) => e);
    expect(lone).toBeInstanceOf(DbParameterTypeError);
    expect(lone).toMatchObject({ committed: true });
  });

  it("rebindTx names the account on the wire, once, and refuses a second", async () => {
    const nothing = bindDb(pool, { account: null }) as unknown as Tx;
    const seen = await nothing.transaction(async (tx) => {
      const named = await rebindTx(tx as object & NothingBound, { account: B });
      const keyed = await rebindTx(named as object & AccountBound, { key: CANARY });
      await expect(rebindTx(keyed as unknown as object & NothingBound, { account: A })).rejects.toBeInstanceOf(BindingRefusedError);
      await (tx as unknown as Tx).transaction(async (sp) => {
        await expect(rebindTx(sp as object & AccountBound, { key: null })).rejects.toBeInstanceOf(BindingRefusedError);
      });
      return rowsOf(await (tx as unknown as Tx).execute(sql`select current_setting('ohmail.account', true) as a, current_setting('ohmail.key', true) as k`))[0];
    });
    expect(seen).toEqual({ a: B, k: CANARY });
    expect(await leftover()).toEqual(["", ""]);
  });

  it("a bound view answers nothing through drizzle's relational builders or the raw client", () => {
    const view = bindDb(pool, { account: A }) as unknown as Record<string, unknown>;
    expect(() => view.query).toThrow(BindingRefusedError);
    expect(() => view.$client).toThrow(BindingRefusedError);
    expect(() => view._).toThrow(BindingRefusedError);
    expect(() => acquireCeilingHandle(view as never, 1_000)).toThrow(TypeError);
  });

  it("refuses a postgres.js handle its factory did not register", async () => {
    const raw = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    try {
      const plain = brandDialect(drizzle(raw), "pg");
      expect(() => bindDb(plain, { account: A })).toThrow(BindingRefusedError);
    } finally {
      await raw.end({ timeout: 5 });
    }
  });

  it("refuses to bind the staff handle", () => {
    const staff = makePooledDb(PG_TEST_URL, { role: "staff" });
    expect(() => bindDb(staff, { account: null })).toThrow(BindingRefusedError);
  });

  it("a canary key reaches no log line and no thrown error", async () => {
    const lines: string[] = [];
    const out = process.stdout.write;
    const err = process.stderr.write;
    process.stdout.write = ((c: unknown, ...r: unknown[]) => { lines.push(String(c)); return (out as (...a: unknown[]) => boolean).apply(process.stdout, [c, ...r]); }) as typeof out;
    process.stderr.write = ((c: unknown, ...r: unknown[]) => { lines.push(String(c)); return (err as (...a: unknown[]) => boolean).apply(process.stderr, [c, ...r]); }) as typeof err;
    try {
      const view = bindDb(pool, { account: A, key: CANARY }) as unknown as Tx;
      const errors = [
        await view.execute(sql`select 1 / ${0}::int`).then(() => null, (e: unknown) => e),
        await view.transaction(async (tx) => { await (tx as unknown as Tx).execute(sql`select nope`); }).then(() => null, (e: unknown) => e),
      ];
      for (const e of errors) {
        expect(e).not.toBeNull();
        expect(strings(e).some((s) => s.includes(CANARY))).toBe(false);
      }
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    expect(lines.some((l) => l.includes(CANARY))).toBe(false);
  });

  it("the self-hosted pool takes the same flights", async () => {
    const view = bindDb(owned.db, { account: A, key: CANARY }) as unknown as Tx;
    const [row] = rowsOf(await view.execute(sql`select current_setting('ohmail.account', true) as a, current_setting('ohmail.key', true) as k`));
    expect(row).toEqual({ a: A, k: CANARY });
    const inTx = await view.transaction(async (tx) =>
      rowsOf(await (tx as unknown as Tx).execute(sql`select current_setting('ohmail.account', true) as a`))[0]?.a);
    expect(inTx).toBe(A);
    const [after] = rowsOf(await owned.db.execute(sql`select current_setting('ohmail.account', true) as a`));
    expect(after?.a ?? "").toBe("");
  });

  it("fifty plain reads in flight and one bound statement all answer on the self-hosted pool", async () => {
    const view = bindDb(owned.db, { account: A });
    const plain = Array.from({ length: 50 }, () => owned.db.execute(sql`select pg_sleep(${0.01})`));
    const bound = view.execute(sql`select current_setting('ohmail.account', true) as a`);
    const [, got] = await Promise.all([Promise.all(plain), bound]);
    expect(rowsOf(got)[0]?.a).toBe(A);
  }, 30_000);
});

/** `p`'s value within `ms`, or "NEVER": a flight that hangs is red here, not at the test's timeout. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | "NEVER"> => Promise.race([p, new Promise<"NEVER">((resolve) => {
  const t = setTimeout(() => resolve("NEVER"), ms);
  (t as { unref?: () => void }).unref?.();
})]);

/** How a statement answered: `ok`, or its error's name and code. */
const outcome = (p: Promise<unknown>): Promise<string> =>
  p.then(() => "ok", (e: unknown) => `${(e as Error).name}:${String((e as { code?: unknown }).code ?? "")}`);

/** A pool of one under its own name (beside the shared one above), with a short wait to begin; at `at` (`host:port`) when named. */
function poolOfOne(name: string, at?: string, acquireTimeoutMs = 3_000): ReturnType<typeof makePooledDb> {
  const url = new URL(PG_TEST_URL);
  if (at !== undefined) url.host = at;
  url.searchParams.set("application_name", name);
  return makePooledDb(url.toString(), { max: 1, acquireTimeoutMs });
}

/**
 * A FLIGHT WAITING FOR A CONNECTION. postgres.js 3.4.9 hands the first statement waiting for one to
 * the connection it dials again after a close, and drops it there when it is a reservation.
 */
describe.skipIf(!PG_UP)("a flight waiting for a connection", () => {
  let one: ReturnType<typeof makePooledDb>;
  beforeAll(() => { one = poolOfOne("tf-bound-waiting"); });
  afterAll(async () => { await closePooledDbs(); });

  it("gets one when the connection it waited for dies", async () => {
    const killer = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    try {
      const view = bindDb(one, { account: A }) as unknown as Tx;
      const holder = Number(rowsOf(await one.execute(sql`select pg_backend_pid() as pid`))[0]?.pid);
      const held = one.execute(sql`select pg_sleep(${2})`).then(() => "ran", () => "ended");
      await new Promise((r) => setTimeout(r, 100));
      const waiting = view.execute(sql`select ${5}::int as five`).then(rowsOf);
      await new Promise((r) => setTimeout(r, 100));
      await killer`select pg_terminate_backend(${holder})`;
      const got = await within(waiting, 2_500);
      expect(got === "NEVER" ? got : got[0]?.five).toBe(5);
      expect(await held).toBe("ended");
    } finally {
      await killer.end({ timeout: 5 });
    }
  }, 30_000);

  it("refused at its wait to begin, a lone statement is busy as a statement, a transaction as a transaction", async () => {
    const short = poolOfOne("tf-bound-waiting-words", undefined, 300);
    const view = bindDb(short, { account: A }) as unknown as Tx;
    await short.execute(sql`select 1`);
    const held = short.transaction(async (tx) => { await tx.execute(sql`select pg_sleep(${1})`); });
    await new Promise((r) => setTimeout(r, 100));
    const [lone, inTx] = await Promise.all([view.execute(sql`select ${1}::int`), view.transaction(async () => 1)]
      .map((p) => p.then(() => null, (e: unknown) => e)));
    await held;
    expect([lone, inTx].map(isDbAcquireTimeout)).toEqual([true, true]);
    expect((lone as Error).message).toMatch(/\bthis statement\b/);
    expect((inTx as Error).message).toMatch(/\bthis transaction\b/);
  }, 30_000);
});

/**
 * A STATEMENT THE DRIVER REFUSES WHILE BUILDING IT. postgres.js 3.4.9 throws such a refusal inside
 * its write and hands it to the connection's head, which in a flight is BEGIN: the statement then
 * waits for a reply that belongs to the next one, and the close for one that never comes. A flight
 * must answer the statement's own error and leave its pool serving.
 */
describe.skipIf(!PG_UP)("a statement the driver cannot build, in a flight", () => {
  let one: ReturnType<typeof makePooledDb>;
  let owned: OwnedDb;
  const driver = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });   // only for its typed values; never dials

  /** The driver's own refusal of an undefined value. */
  const undefinedValue = () => sql`select ${sql.param(undefined)}::text as v`;
  /** A value the driver refuses while writing the statement's Parse (a type outside the protocol's range). */
  const unwritable = () => sql`select ${driver.typed("x", -1)}::text as v`;
  const pid = async (): Promise<number> => Number(rowsOf(await one.execute(sql`select pg_backend_pid() as pid`))[0]?.pid);

  beforeAll(async () => {
    one = poolOfOne("tf-bound-unbuildable");
    owned = makeOwnedDb(PG_TEST_URL, { role: "api" });
    await one.execute(sql`create table if not exists tf_bound_unbuildable (id int primary key)`);
  });

  afterAll(async () => {
    await one.execute(sql`drop table if exists tf_bound_unbuildable`).catch(() => undefined);
    await owned.close();
    await driver.end({ timeout: 5 });
    await closePooledDbs();
  });

  const lone = (v: Tx, q: () => unknown) => v.execute(q());
  const readFirst = (v: Tx, q: () => unknown) => (readFlightOf(v as object) as unknown as Tx).transaction((tx) => (tx as unknown as Tx).execute(q()));
  const inWrite = (v: Tx, q: () => unknown) => v.transaction((tx) => (tx as unknown as Tx).execute(q()));

  it.each([
    ["a lone statement", lone],
    ["a read flight's first read", readFirst],
    ["a write flight's statement", inWrite],
  ])("an undefined value in %s answers the driver's own refusal, and the connection serves the next statement", async (_, run) => {
    const view = bindDb(one, { account: A }) as unknown as Tx;
    const before = await pid();
    const plain = await outcome(one.execute(undefinedValue()));
    expect(plain).toBe("Error:UNDEFINED_VALUE");
    expect(await within(outcome(run(view, undefinedValue)), 2_000)).toBe(plain);
    const next = await within(view.execute(sql`select ${2}::int as two`).then(rowsOf), 5_000);
    expect(next === "NEVER" ? next : next[0]?.two).toBe(2);
    expect(await within(pid(), 5_000), "nothing was lost: the same connection").toBe(before);
  }, 30_000);

  it("a write flight whose callback swallowed an undefined value's refusal fails, and nothing of it stands", async () => {
    const view = bindDb(one, { account: A }) as unknown as Tx;
    const id = Math.floor(Math.random() * 1e6) + 10;
    const out = await within(outcome(view.transaction(async (tx) => {
      const t = tx as unknown as Tx;
      await t.execute(undefinedValue()).catch(() => undefined);
      await t.execute(sql`insert into tf_bound_unbuildable (id) values (${id})`);
    })), 2_000);
    expect(out).toBe("Error:UNDEFINED_VALUE");
    expect(rowsOf(await one.execute(sql`select count(*)::int as n from tf_bound_unbuildable where id = ${id}`))[0]?.n).toBe(0);
  }, 30_000);

  it("six undefined values, lone and first reads in turn, leave the self-hosted pool (five connections, no wait ceiling) serving", async () => {
    const view = bindDb(owned.db, { account: A }) as unknown as Tx;
    const six: string[] = [];
    for (let i = 0; i < 6; i++) six.push(await within(outcome((i % 2 === 0 ? lone : readFirst)(view, undefinedValue)), 1_500));
    expect(six).toEqual(Array(6).fill("Error:UNDEFINED_VALUE"));
    expect(await within(outcome(view.execute(sql`select ${2}::int`)), 4_000)).toBe("ok");
    expect(await within(outcome(owned.db.execute(sql`select ${3}::int`)), 4_000)).toBe("ok");
  }, 60_000);

  it.each([
    ["a lone statement", lone],
    ["a read flight's first read", readFirst],
  ])("a refusal no door foresees in %s answers that refusal, and the connection is closed, never handed back", async (_, run) => {
    const view = bindDb(one, { account: A }) as unknown as Tx;
    const plain = await outcome(one.execute(unwritable()));
    expect(plain).toBe("RangeError:ERR_OUT_OF_RANGE");
    const before = await pid();
    expect(await within(outcome(run(view, unwritable)), 2_000)).toBe(plain);
    const next = await within(view.execute(sql`select ${2}::int as two`).then(rowsOf), 5_000);
    expect(next === "NEVER" ? next : next[0]?.two, "the next statement has its own answer").toBe(2);
    expect(await within(pid(), 5_000), "the pool dialed a new connection").not.toBe(before);
  }, 30_000);

  it("in a write flight, a statement written behind one the driver refuses leaves nothing standing and the pool serving", async () => {
    const view = bindDb(one, { account: A }) as unknown as Tx;
    const id = Math.floor(Math.random() * 1e6) + 10;
    const out = await within(outcome(view.transaction(async (tx) => {
      const t = tx as unknown as Tx;
      await Promise.all([t.execute(sql`insert into tf_bound_unbuildable (id) values (${id})`), t.execute(unwritable())]);
    })), 2_000);
    expect(out).toBe("RangeError:ERR_OUT_OF_RANGE");
    const left = await within(one.execute(sql`select count(*)::int as n from tf_bound_unbuildable where id = ${id}`).then(rowsOf), 5_000);
    expect(left === "NEVER" ? left : left[0]?.n).toBe(0);
    expect(await within(outcome(view.execute(sql`select ${2}::int`)), 5_000)).toBe("ok");
  }, 30_000);

  it("once a flight's line is lost, its handle throws and writes no statement", async () => {
    const view = bindDb(one, { account: A }) as unknown as Tx;
    let after = "";
    let texts = -1;
    const out = await within(outcome(view.transaction(async (tx) => {
      const t = tx as unknown as Tx;
      await t.execute(unwritable()).catch(() => undefined);
      wire.start();
      after = await outcome(t.execute(sql`select ${1}::int`));
      texts = wire.read().texts.length;
    })), 2_000);
    expect(after).toBe("FlightClosedError:");
    expect(texts).toBe(0);
    expect(out).toBe("RangeError:ERR_OUT_OF_RANGE");
  }, 30_000);

  it("a line lost while the binder heads it: no refusal the callback or the caller reads carries the account or a key", async () => {
    const view = bindDb(one, { account: A, key: CANARY }) as unknown as Tx;
    const renamed = `canary-${randomUUID()}`;
    let inside: string[] = [];
    let carried: string[] = [];
    const out = await within(view.transaction(async (tx) => {
      const t = tx as unknown as Tx;
      const all = await Promise.allSettled([
        rebindTx(tx as object & AccountBound, { key: renamed }), t.execute(unwritable()), t.execute(sql`select ${1}::int`),
      ]);
      inside = all.map((s) => s.status);
      carried = all.flatMap((s) => (s.status === "rejected" ? strings(s.reason) : []));
    }).then(() => null, (e: unknown) => e), 2_000);
    expect(out === "NEVER" ? out : (out as Error | null)?.name).toBe("RangeError");
    expect(inside).toEqual(["rejected", "rejected", "rejected"]);
    for (const value of [A, CANARY, renamed]) {
      expect(carried.some((s) => s.includes(value)), "inside the callback").toBe(false);
      expect(strings(out).some((s) => s.includes(value)), "the flight's answer").toBe(false);
    }
  }, 30_000);
});

/**
 * The transaction pooler of bound-handle.rls.pg.test.ts, a named test service: `TF_POOLER_ADDRESS`
 * (`host:port`) in front of the test database. `TF_REQUIRE_POOLER=1` makes its absence a failure.
 */
const POOLER = (process.env.TF_POOLER_ADDRESS ?? "").trim();
const POOLER_UP = POOLER !== "" && await new Promise<boolean>((resolve) => {
  const s = net.connect({ host: POOLER.slice(0, POOLER.lastIndexOf(":")), port: Number(POOLER.slice(POOLER.lastIndexOf(":") + 1)) });
  const done = (up: boolean): void => { s.destroy(); resolve(up); };
  s.setTimeout(2_000, () => done(false));
  s.once("connect", () => done(true));
  s.once("error", () => done(false));
});
if (process.env.TF_REQUIRE_POOLER === "1" && !POOLER_UP) {
  throw new Error("TF_REQUIRE_POOLER=1 but no transaction pooler answers at TF_POOLER_ADDRESS");
}
if (!POOLER_UP) process.stderr.write("bound-flight: no transaction pooler at TF_POOLER_ADDRESS; its cases are skipped\n");

/**
 * A REFUSAL THE DRIVER MAKES IN STEP, WITH A STATEMENT OF THE FLIGHT WRITTEN AFTER IT. A raw Date is
 * refused at its Bind, once the describe has answered; the driver writes a Sync and the stream stays
 * in step. A describe keeps the connection full, so what the flight writes after it waits in the
 * reservation's own queue, which ending the connection never reaches. Every flight answers the
 * plain handle's refusal, within 2 s, and its pool serves the next statement.
 */
describe.skipIf(!PG_UP)("a refusal the driver makes in step, with a statement of the flight behind it", () => {
  const direct = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
  const rawDate = () => sql`select ${new Date()}::timestamptz as v`;
  const stands = async (id: number): Promise<boolean> =>
    (await direct`select 1 from tf_bound_parked where id = ${id}`).length === 1;

  beforeAll(async () => { await direct`create table if not exists tf_bound_parked (id int primary key)`; });
  afterAll(async () => {
    await direct`drop table if exists tf_bound_parked`.catch(() => undefined);
    await direct.end({ timeout: 5 });
    await closePooledDbs();
  });

  describe.each([
    { kind: "the pooled cell (a pool of one)", at: null, self: false },
    { kind: "the self-hosted pool", at: null, self: true },
    { kind: "the pooled cell through a transaction pooler", at: POOLER, self: false },
  ])("on $kind", ({ at, self }) => {
    const skip = at !== null && !POOLER_UP;
    let owned: OwnedDb | null = null;
    let db: Tx;
    beforeAll(() => {
      if (skip) return;
      if (self) db = (owned = makeOwnedDb(PG_TEST_URL, { role: "api" })).db as unknown as Tx;
      else db = poolOfOne(at === null ? "tf-bound-parked" : "tf-bound-parked-pooler", at ?? undefined) as unknown as Tx;
    });
    afterAll(async () => { await owned?.close(); });

    it.skipIf(skip)("a lone bound statement answers the plain handle's refusal", async () => {
      const plain = await within(outcome(db.execute(rawDate())), 2_000);
      expect(plain).toBe("TypeError:ERR_INVALID_ARG_TYPE");
      const view = bindDb(db as object, { account: A }) as unknown as Tx;
      expect(await within(outcome(view.execute(rawDate())), 2_000)).toBe(plain);
      expect(await within(outcome(view.execute(sql`select ${2}::int`)), 5_000)).toBe("ok");
    }, 30_000);

    it.skipIf(skip)("a write flight awaiting a raw Date statement and a sibling together answers", async () => {
      const view = bindDb(db as object, { account: A }) as unknown as Tx;
      let settled: string[] = [];
      const out = await within(outcome(view.transaction(async (tx) => {
        const t = tx as unknown as Tx;
        settled = (await Promise.allSettled([t.execute(rawDate()), t.execute(sql`select ${1}::int as one`)])).map((s) => s.status);
      })), 2_000);
      expect(out).toBe("TypeError:ERR_INVALID_ARG_TYPE");
      expect(settled, "the line is lost: the sibling is refused, never left waiting").toEqual(["rejected", "rejected"]);
      expect(await within(outcome(view.execute(sql`select ${2}::int`)), 5_000)).toBe("ok");
    }, 30_000);

    it.skipIf(skip)("a write flight whose callback left a raw Date statement floating answers at its commit, and nothing of it stands", async () => {
      const view = bindDb(db as object, { account: A }) as unknown as Tx;
      const id = Math.floor(Math.random() * 1e6) + 10;
      const out = await within(outcome(view.transaction(async (tx) => {
        const t = tx as unknown as Tx;
        await t.execute(sql`insert into tf_bound_parked (id) values (${id})`);
        void t.execute(rawDate()).catch(() => undefined);
      })), 2_000);
      expect(out).toBe("TypeError:ERR_INVALID_ARG_TYPE");
      expect(await stands(id)).toBe(false);
      expect(await within(outcome(view.execute(sql`select ${2}::int`)), 5_000)).toBe("ok");
    }, 30_000);

    it.skipIf(skip)("a read flight awaiting a raw Date read and a sibling together answers", async () => {
      const view = bindDb(db as object, { account: A }) as unknown as Tx;
      const flight = readFlightOf(view as object) as unknown as Tx;
      const out = await within(outcome(flight.transaction(async (tx) => {
        const t = tx as unknown as Tx;
        await Promise.allSettled([t.execute(rawDate()), t.execute(sql`select ${1}::int as one`)]);
      })), 2_000);
      expect(out).toBe("TypeError:ERR_INVALID_ARG_TYPE");
      expect(await within(outcome(view.execute(sql`select ${2}::int`)), 5_000)).toBe("ok");
    }, 30_000);
  });
});

const tagOf = (e: unknown): string => `${(e as Error).name}:${String((e as { code?: unknown }).code ?? "")}`;
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const gate = <T = void>(): { promise: Promise<T>; open: (v: T) => void } => {
  let open!: (v: T) => void;
  const promise = new Promise<T>((r) => { open = r; });
  return { promise, open };
};

/**
 * A FLIGHT WHOSE CONNECTION ENDED UNDER IT. postgres.js 3.4.9 dials a closed connection again for the
 * next caller waiting, as the same connection object a flight writes through. Account A's flight loses
 * its connection while its callback waits (its backend ended, or its own lost line ended it); account
 * B's flight begins on the connection dialed again; then A goes on. A writes nothing more and answers a
 * refusal; B's rows, binding and commit stay its own (it gives up at the end: nothing of it stands).
 * On the self-hosted pool its other four connections are held, so that B gets A's.
 */
describe.skipIf(!PG_UP)("a flight whose connection ended and was dialed again for another flight", () => {
  const admin = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
  const driver = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });   // only for its typed values; never dials
  const C = randomUUID();
  const rawDate = () => sql`select ${new Date()}::timestamptz as v`;
  const unwritable = () => sql`select ${driver.typed("x", -1)}::text as v`;
  let nextId = Math.floor(Math.random() * 1e6) * 100;
  const fresh = (): number => (nextId += 10);
  const ins = (t: Tx, id: number, note = "x") =>
    t.execute(sql`insert into tf_bound_redial (id, acct, note) values (${id}, current_setting('ohmail.account', true), ${note})`);
  const mine = (t: Tx): Promise<{ a: unknown; pid: number }> =>
    t.execute(sql`select current_setting('ohmail.account', true) as a, pg_backend_pid() as pid`)
      .then((x) => ({ a: rowsOf(x)[0]?.a, pid: Number(rowsOf(x)[0]?.pid) }));
  const who = (a: unknown): string => (a === A ? "A" : a === B ? "B" : a === C ? "C" : a === "" || a == null ? "none" : "?");
  /** Whose binding the row stands under, or "no row". */
  const standing = async (id: number): Promise<string> => {
    const [row] = await admin`select acct from tf_bound_redial where id = ${id}`;
    return row === undefined ? "no row" : who(row.acct);
  };
  /** What B's side reads when A's dead flight wrote nothing of its own into B's transaction. */
  const B_UNTOUCHED = { bBegan: "B", midB: "no row", afterB: "B", lateB: "ok", b: "Error:", standsB: "no row", standsBLate: "no row", next: "ok" };

  beforeAll(async () => { await admin`create table if not exists tf_bound_redial (id int primary key, acct text, note text)`; });
  afterAll(async () => {
    await admin`drop table if exists tf_bound_redial`.catch(() => undefined);
    await admin.end({ timeout: 5 });
    await driver.end({ timeout: 5 });
    await closePooledDbs();
  });

  describe.each([
    { kind: "the pooled cell (a pool of one)", at: null, self: false },
    { kind: "the self-hosted pool", at: null, self: true },
    { kind: "the pooled cell through a transaction pooler", at: POOLER, self: false },
  ])("on $kind", ({ at, self }) => {
    const skip = at !== null && !POOLER_UP;
    let owned: OwnedDb | null = null;
    let db: object;
    beforeAll(() => {
      if (skip) return;
      if (self) db = (owned = makeOwnedDb(PG_TEST_URL, { role: "api" })).db;
      else db = poolOfOne(at === null ? "tf-bound-redial" : "tf-bound-redial-pooler", at ?? undefined, 6_000);
    });
    afterAll(async () => { await owned?.close(); });

    /** The self-hosted pool's other four connections, each reserved by a flight of account C until let go. */
    const hold = (n: number) => {
      const go = gate();
      const c = bindDb(db, { account: C }) as unknown as Tx;
      const began: Array<Promise<void>> = [];
      const done = Array.from({ length: n }, () => {
        const g = gate();
        began.push(g.promise);
        return c.transaction(async () => { g.open(); await go.promise; }).catch(() => undefined);
      });
      return { began: Promise.all(began), letGo: async () => { go.open(); await Promise.all(done); } };
    };

    /**
     * A's flight (`flight`) calls `idle(pid)` where its callback waits: the backend `pid` is ended (null:
     * its own lost line ended the connection). B's write flight begins on the connection dialed again and
     * waits; A goes on; B reads its binding and writes once more, then gives up.
     */
    const scene = async (flight: (idle: (pid: number | null) => Promise<void>) => Promise<unknown>) => {
      const b = bindDb(db, { account: B }) as unknown as Tx;
      const idB = fresh();
      const idled = gate<number | null>();
      const goA = gate();
      const began = gate<string>();
      const goB = gate();
      let afterB = "not read";
      let lateB = "not sent";
      const outA = outcome(flight(async (pid) => { idled.open(pid); await goA.promise; }));
      const pid = await within(idled.promise, 3_000);
      const held = self ? hold(4) : null;
      await held?.began;
      if (typeof pid === "number") await admin`select pg_terminate_backend(${pid})`;
      await pause(250);
      const outB = outcome(b.transaction(async (tx) => {
        const t = tx as unknown as Tx;
        await ins(t, idB);
        began.open(who((await mine(t)).a));
        await goB.promise;
        afterB = await mine(t).then((x) => who(x.a), tagOf);
        lateB = await outcome(ins(t, idB + 1));
        throw new Error("B gives up");
      }));
      const bBegan = await within(began.promise, 5_000);
      goA.open();
      const a = await within(outA, 3_000);
      await pause(200);
      const midB = await standing(idB);   // B is still inside its transaction: nothing of it may be seen yet
      goB.open();
      const bOut = await within(outB, 5_000);
      await held?.letGo();
      return {
        a, bBegan, midB, afterB, lateB, b: bOut, standsB: await standing(idB), standsBLate: await standing(idB + 1),
        next: await within(outcome(b.execute(sql`select ${2}::int`)), 5_000),
      };
    };

    it.skipIf(skip)("its connection dies while its callback waits; dialed again for B's flight; A goes on", async () => {
      const a = bindDb(db, { account: A }) as unknown as Tx;
      const idA = fresh();
      let second = "not read";
      let wrote = "not sent";
      const seen = await scene((idle) => a.transaction(async (tx) => {
        const t = tx as unknown as Tx;
        await idle((await mine(t)).pid);
        second = await mine(t).then((x) => who(x.a), tagOf);
        wrote = await outcome(ins(t, idA));
      }));
      expect({ ...seen, second, wrote, standsA: await standing(idA) }).toEqual({
        ...B_UNTOUCHED, a: "Error:CONNECTION_CLOSED", second: "Error:CONNECTION_CLOSED", wrote: "FlightClosedError:", standsA: "no row",
      });
    }, 30_000);

    it.skipIf(skip)("its line is lost inside a savepoint whose error the callback swallowed; it goes on; its commit after the pool dialed again", async () => {
      const a = bindDb(db, { account: A }) as unknown as Tx;
      const idA = fresh();
      let inner = "";
      const seen = await scene((idle) => a.transaction(async (tx) => {
        const t = tx as unknown as Tx;
        await ins(t, idA);
        inner = await outcome(t.transaction(async (sp) => { await (sp as unknown as Tx).execute(rawDate()); }));
        await idle(null);
      }));
      expect({ ...seen, inner, standsA: await standing(idA) }).toEqual({
        ...B_UNTOUCHED, a: "TypeError:ERR_INVALID_ARG_TYPE", inner: "TypeError:ERR_INVALID_ARG_TYPE", standsA: "no row",
      });
    }, 30_000);

    it.skipIf(skip)("between BEGIN and the binder: a transaction begun bound to nothing names its account after its connection died", async () => {
      const nothing = bindDb(db, { account: null }) as unknown as Tx;
      const idA = fresh();
      let named = "not sent";
      const seen = await scene((idle) => nothing.transaction(async (tx) => {
        const t = tx as unknown as Tx;
        await idle((await mine(t)).pid);
        named = await outcome(rebindTx(tx as object & NothingBound, { account: A }));
        await ins(t, idA);
      }));
      expect({ ...seen, named, standsA: await standing(idA) }).toEqual({
        ...B_UNTOUCHED, a: "Error:CONNECTION_CLOSED", named: "BindingFailedError:binding_failed", standsA: "no row",
      });
    }, 30_000);

    it.skipIf(skip)("between the last statement and the commit", async () => {
      const a = bindDb(db, { account: A }) as unknown as Tx;
      const idA = fresh();
      const seen = await scene((idle) => a.transaction(async (tx) => {
        const t = tx as unknown as Tx;
        await ins(t, idA);
        await idle((await mine(t)).pid);
      }));
      expect({ ...seen, standsA: await standing(idA) }).toEqual({ ...B_UNTOUCHED, a: "Error:CONNECTION_CLOSED", standsA: "no row" });
    }, 30_000);

    it.skipIf(skip)("inside a savepoint", async () => {
      const a = bindDb(db, { account: A }) as unknown as Tx;
      const idA = fresh();
      let inner = "not sent";
      const seen = await scene((idle) => a.transaction(async (tx) => {
        const t = tx as unknown as Tx;
        await ins(t, idA);
        await t.transaction(async (sp) => {
          const s = sp as unknown as Tx;
          await ins(s, idA + 1);
          await idle((await mine(s)).pid);
          inner = await outcome(ins(s, idA + 2));
        });
      }));
      const stands = [await standing(idA), await standing(idA + 1), await standing(idA + 2)];
      expect({ ...seen, inner, stands }).toEqual({
        ...B_UNTOUCHED, a: "Error:CONNECTION_CLOSED", inner: "Error:CONNECTION_CLOSED", stands: ["no row", "no row", "no row"],
      });
    }, 30_000);

    it.skipIf(skip)("a read flight", async () => {
      const a = bindDb(db, { account: A }) as unknown as Tx;
      let second = "not read";
      const seen = await scene((idle) => (readFlightOf(a as object) as unknown as Tx).transaction(async (tx) => {
        const t = tx as unknown as Tx;
        await idle((await mine(t)).pid);
        second = await mine(t).then((x) => who(x.a), tagOf);
      }));
      expect({ ...seen, second }).toEqual({ ...B_UNTOUCHED, a: "Error:CONNECTION_CLOSED", second: "Error:CONNECTION_CLOSED" });
    }, 30_000);

    it.skipIf(skip)("a lone bound statement whose connection dies under it answers a refusal, nothing of it stands, and B's next one is B's", async () => {
      const a = bindDb(db, { account: A }) as unknown as Tx;
      const b = bindDb(db, { account: B }) as unknown as Tx;
      const idA = fresh();
      const mark = `tf-redial-${randomUUID()}`;
      const lone = outcome(a.execute(sql`insert into tf_bound_redial (id, acct) select ${idA}, current_setting('ohmail.account', true)
        from pg_sleep(${0.6}) ${sql.raw(`/* ${mark} */`)}`));
      let ended = 0;
      for (let i = 0; i < 40 && ended === 0; i++) {
        await pause(25);
        ended = (await admin`select pg_terminate_backend(pid) as x from pg_stat_activity
          where query like ${`%${mark}%`} and pid <> pg_backend_pid() and query not like '%pg_stat_activity%'`).length;
      }
      const out = await within(lone, 5_000);
      const nextB = await within(b.execute(sql`select current_setting('ohmail.account', true) as a`).then((x) => who(rowsOf(x)[0]?.a), tagOf), 5_000);
      expect({ ended, out, standsA: await standing(idA), nextB }).toEqual({ ended: 1, out: "Error:CONNECTION_CLOSED", standsA: "no row", nextB: "B" });
    }, 30_000);

    it.skipIf(skip)("a connection that dies under a statement hands the statements written behind it none of its values", async () => {
      const view = bindDb(db, { account: A }) as unknown as Tx;
      const secret = `canary-${randomUUID()}`;
      let sibling: unknown = "not answered";
      const out = await within(view.transaction(async (tx) => {
        const t = tx as unknown as Tx;
        const pid = (await mine(t)).pid;
        const pair = Promise.allSettled([t.execute(sql`select pg_sleep(${0.6}), ${secret}::text as v`), t.execute(sql`select ${1}::int as one`)]);
        await pause(150);
        await admin`select pg_terminate_backend(${pid})`;
        const [, behind] = await pair;
        sibling = behind.status === "rejected" ? behind.reason : "ok";
      }).then(() => null, (e: unknown) => e), 5_000);
      expect({ sibling: tagOf(sibling), out: out === "NEVER" ? out : tagOf(out) }).toEqual({ sibling: "Error:CONNECTION_CLOSED", out: "Error:CONNECTION_CLOSED" });
      expect(strings(sibling).some((s) => s.includes(secret)), "the statement behind it").toBe(false);
      expect(strings(out).some((s) => s.includes(secret)), "the flight's answer").toBe(false);
    }, 30_000);

    it.skipIf(skip)("a floating statement, one the driver cannot write and the commit in one tick, at every size around the 1,024-byte flush: a refusal, and nothing stands", async () => {
      const view = bindDb(db, { account: A }) as unknown as Tx;
      const seen: Record<string, number> = {};
      for (let n = 760; n <= 960; n += 2) {
        const id = fresh();
        const out = await within(outcome(view.transaction(async (tx) => {
          const t = tx as unknown as Tx;
          await ins(t, id);
          void ins(t, id + 1, "y".repeat(n)).catch(() => undefined);
          void t.execute(unwritable()).catch(() => undefined);
        })), 2_500);
        await pause(30);   // a commit written before the refusal answered would land by now
        const key = `${out} | ${await standing(id)} ${await standing(id + 1)}`;
        seen[key] = (seen[key] ?? 0) + 1;
        if (out === "NEVER") break;   // a hung flight holds the pool of one
      }
      expect(seen).toEqual({ "RangeError:ERR_OUT_OF_RANGE | no row no row": 101 });
    }, 120_000);

    it.skipIf(skip)("a statement its callback set off to start after the commit was written is refused, and never runs outside the transaction", async () => {
      const view = bindDb(db, { account: A }) as unknown as Tx;
      const id = fresh();
      let late: Promise<string> = Promise.resolve("not sent");
      const out = await within(outcome(view.transaction(async (tx) => {
        const t = tx as unknown as Tx;
        await ins(t, id);
        void Promise.resolve().then(() => { late = outcome(ins(t, id + 1)); });
      })), 3_000);
      await pause(100);
      expect({ out, late: await late, stands: [await standing(id), await standing(id + 1)] })
        .toEqual({ out: "ok", late: "FlightClosedError:", stands: ["A", "no row"] });
    }, 30_000);
  });
});

/**
 * ONE HUNDRED ROUNDS ON A POOL OF TWO. Each round account A's flight (a write flight, a read flight, a
 * savepoint, or a transaction begun bound to nothing that names A) has its backend ended at a step
 * drawn at random, while B's and C's flights run beside it and take the connection the pool dials
 * again. Every row stores the binding the server held as it was written beside the account that meant
 * to write it.
 */
describe.skipIf(!PG_UP)("one hundred rounds on a pool of two, one account's connection ended each round", () => {
  const admin = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
  const C = randomUUID();
  const named = (name: string, at?: string): string => {
    const url = new URL(PG_TEST_URL);
    if (at !== undefined) url.host = at;
    url.searchParams.set("application_name", name);
    return url.toString();
  };

  beforeAll(async () => {
    await admin`drop table if exists tf_bound_rounds`;
    await admin`create table tf_bound_rounds (who text not null, acct text, kind text not null, round int not null, part int not null)`;
  });
  afterAll(async () => {
    await admin`drop table if exists tf_bound_rounds`.catch(() => undefined);
    await admin.end({ timeout: 5 });
    await closePooledDbs();
  });

  for (const { kind, at, self } of [
    { kind: "the pooled cell", at: null as string | null, self: false },
    { kind: "a session pool (the roster's cell)", at: null as string | null, self: true },
    { kind: "the pooled cell through a transaction pooler", at: POOLER as string | null, self: false },
  ]) it.skipIf(at !== null && !POOLER_UP)(`on ${kind}: no row under another account's binding, no other account's flight failed or ended early, nothing of A stands`, async () => {
    const owned = self ? makeOwnedDb(named("tf-bound-rounds-own"), { role: "roster" }) : null;
    const two = owned?.db ?? makePooledDb(named(at === null ? "tf-bound-rounds" : "tf-bound-rounds-pooler", at ?? undefined), { max: 2, acquireTimeoutMs: 10_000 });
    const a = bindDb(two, { account: A }) as unknown as Tx;
    const nothing = bindDb(two, { account: null }) as unknown as Tx;
    const b = bindDb(two, { account: B }) as unknown as Tx;
    const c = bindDb(two, { account: C }) as unknown as Tx;
    const ins = (t: Tx, w: string, r: number, part: number) =>
      t.execute(sql`insert into tf_bound_rounds (who, acct, kind, round, part) values (${w}, current_setting('ohmail.account', true), ${kind}, ${r}, ${part})`);
    const mine = (t: Tx) => t.execute(sql`select current_setting('ohmail.account', true) as a, pg_backend_pid() as pid, now()::text as at`)
      .then((x) => rowsOf(x)[0] as { a: unknown; pid: unknown; at: unknown });
    let seed = 0x5eed + (self ? 1 : 0) + (at === null ? 0 : 2);
    const rand = (n: number): number => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % n; };
    const outA: string[] = [];
    const failed: string[] = [];
    const wrong: string[] = [];
    try {
      for (let r = 0; r < 100; r++) {
        const step = rand(3);
        const shape = r % 4;
        const idled = gate<number>();
        const goA = gate();
        /** A's flight waits at step `i` when it is the round's: its backend is ended there. */
        const stop = async (i: number, pid: unknown): Promise<void> => { if (i === step) { idled.open(Number(pid)); await goA.promise; } };
        const flightA = shape === 0 ? a.transaction(async (tx) => {
          const t = tx as unknown as Tx;
          const { pid } = await mine(t);
          await stop(0, pid); await ins(t, A, r, 1);
          await stop(1, pid); await mine(t); await ins(t, A, r, 2);
          await stop(2, pid);
        }) : shape === 1 ? (readFlightOf(a as object) as unknown as Tx).transaction(async (tx) => {
          const t = tx as unknown as Tx;
          const { pid } = await mine(t);
          await stop(0, pid); await mine(t);
          await stop(1, pid); await mine(t);
          await stop(2, pid);
        }) : shape === 2 ? a.transaction(async (tx) => {
          const t = tx as unknown as Tx;
          const { pid } = await mine(t);
          await stop(0, pid); await ins(t, A, r, 1);
          await t.transaction(async (sp) => {
            await stop(1, pid); await ins(sp as unknown as Tx, A, r, 2);
            await stop(2, pid);
          });
        }) : nothing.transaction(async (tx) => {
          const t = tx as unknown as Tx;
          const { pid } = await mine(t);
          await stop(0, pid); await rebindTx(tx as object & NothingBound, { account: A });
          await stop(1, pid); await ins(t, A, r, 1);
          await stop(2, pid);
        });
        // A read flight whose reads were all answered before its backend ended has its rows; every other flight of A is refused.
        const answers = shape === 1 && step === 2 ? "ok" : "refused";
        const jobs: Array<Promise<unknown>> = [
          outcome(flightA).then((o) => { if ((o === "ok" ? "ok" : "refused") !== answers) outA.push(`round ${r} (shape ${shape}, step ${step}): ${o}`); }),
          b.transaction(async (tx) => {
            const t = tx as unknown as Tx;
            const first = await mine(t);
            await ins(t, B, r, 1);
            await pause(rand(40));
            const second = await mine(t);
            await ins(t, B, r, 2);
            if (first.a !== B || second.a !== B || first.pid !== second.pid || first.at !== second.at) wrong.push(`B round ${r}`);
          }).catch((e: unknown) => { failed.push(`B round ${r}: ${tagOf(e)}`); }),
          ins(c, C, r, 1).then(() => undefined, (e: unknown) => { failed.push(`C lone round ${r}: ${tagOf(e)}`); }),
          c.transaction(async (tx) => {
            const t = tx as unknown as Tx;
            const first = await mine(t);
            await pause(rand(40));
            await ins(t, C, r, 2);
            const second = await mine(t);
            if (first.a !== C || second.a !== C || first.pid !== second.pid || first.at !== second.at) wrong.push(`C round ${r}`);
          }).catch((e: unknown) => { failed.push(`C round ${r}: ${tagOf(e)}`); }),
        ];
        const pid = await within(idled.promise, 8_000);
        if (pid === "NEVER") { failed.push(`round ${r}: A never reached its step`); break; }
        await admin`select pg_terminate_backend(${pid})`;
        await pause(20 + rand(60));
        goA.open();
        if (await within(Promise.all(jobs), 15_000) === "NEVER") { failed.push(`round ${r} never finished`); break; }
      }
      await pause(200);
      const rows = await admin`select who, acct, count(*)::int as n from tf_bound_rounds where kind = ${kind} group by who, acct order by who, acct`;
      const per = Object.fromEntries(rows.map((x) => [`${x.who === A ? "A" : x.who === B ? "B" : x.who === C ? "C" : "?"} as ${
        x.acct === A ? "A" : x.acct === B ? "B" : x.acct === C ? "C" : x.acct === "" ? "none" : "?"}`, x.n]));
      expect({ failed, wrong, per, outA }).toEqual({ failed: [], wrong: [], per: { "B as B": 200, "C as C": 200 }, outA: [] });
    } finally {
      await owned?.close();
    }
  }, 240_000);
});
