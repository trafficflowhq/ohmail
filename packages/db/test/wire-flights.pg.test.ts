import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { bindDb, rebindTx, BINDER_SQL, type NothingBound } from "../src/bound.js";
import { closePooledDbs, makePooledDb } from "../src/client.js";
import { readFlightOf } from "../src/read-flight.js";
import {
  PG_TEST_URL, carries, flightsOf, keyEquals, realPgAvailable, recordPgWire, type PgWireFlight, type PgWireStatement,
} from "../src/testing.js";

/**
 * THE RECORDER'S FLIGHTS: what `flightsOf` answers for each way a statement reaches the database.
 * Read off the bytes a pool of one wrote: which door a statement went through, which account its
 * binder named, whether a key rode, and the statements' text. The wire tests of the API and the
 * organizer read their journeys through it, so each answer here is held against a statement this
 * file sent itself.
 */
const wire = recordPgWire();
const PG_UP = await realPgAvailable();

const A = randomUUID();
const B = randomUUID();
const KEY = `digest-${randomUUID()}`;

type Tx = { transaction: <R>(fn: (tx: object) => Promise<R>, config?: object) => Promise<R>; execute: (q: unknown) => Promise<unknown> };

/** A statement as a connection was sent it, for a reading made by hand. */
const sent = (text: string, burst: number, params: readonly (string | null)[] = []): PgWireStatement =>
  ({ text, burst, params: params.map((p) => (p === null ? null : Buffer.from(p))) });

describe("flightsOf walks each connection's statements in the order written", () => {
  it("reads a lone statement on a bound handle: one flight, its account, one burst", () => {
    const flights = flightsOf({ lines: [[
      sent("begin", 0), sent(BINDER_SQL, 0, [A, ""]), sent("select 1", 0), sent("commit", 0),
    ]] });
    expect(flights).toEqual([{
      door: "lone", account: A, keyed: false, statements: ["select 1"], bursts: 1, ahead: 1, closed: "commit", continues: false,
    }]);
  });

  it("tells door one from door two by the begin, and counts what was written before the begin was answered", () => {
    const flights = flightsOf({ lines: [[
      sent("begin read only", 0), sent(BINDER_SQL, 0, [A, ""]), sent("select 1", 0), sent("select 2", 1), sent("commit", 2),
      sent("begin isolation level serializable", 3), sent(BINDER_SQL, 3, [B, ""]), sent("update t set x = 1", 4), sent("rollback", 5),
    ]] });
    expect(flights.map((f) => [f.door, f.account, f.statements.length, f.bursts, f.ahead, f.closed])).toEqual([
      ["read", A, 2, 3, 1, "commit"],
      ["write", B, 1, 3, 0, "rollback"],
    ]);
  });

  it("names a flight bound to nothing by a null account, and keeps its key off every field", () => {
    const [flight] = flightsOf({ lines: [[
      sent("begin", 0), sent(BINDER_SQL, 0, ["", KEY]), sent("select 1", 0), sent("commit", 0),
    ]] });
    expect(flight).toMatchObject({ door: "lone", account: null, keyed: true });
    expect(keyEquals(flight!, KEY)).toBe(true);
    expect(keyEquals(flight!, `${KEY}x`)).toBe(false);
    expect(keyEquals(flight!, "")).toBe(false);
    expect(JSON.stringify(flight)).not.toContain(KEY);
    expect(Object.values(flight!).flat()).not.toContain(KEY);
  });

  it("answers false to any key for a flight no key rode in", () => {
    const [flight] = flightsOf({ lines: [[sent("begin", 0), sent(BINDER_SQL, 0, [A, ""]), sent("select 1", 0), sent("commit", 0)]] });
    expect(flight!.keyed).toBe(false);
    expect(keyEquals(flight!, "")).toBe(false);
    expect(keyEquals(flight!, KEY)).toBe(false);
  });

  it("reads a statement outside any transaction, and a transaction without the binder, as plain", () => {
    const flights = flightsOf({ lines: [[
      sent("select now()", 0),
      sent("begin", 1), sent("insert into t values ($1)", 2, ["v"]), sent("commit", 3),
    ]] });
    expect(flights).toEqual([
      { door: "plain", account: null, keyed: false, statements: ["select now()"], bursts: 1, ahead: 0, closed: null, continues: false },
      { door: "plain", account: null, keyed: false, statements: ["insert into t values ($1)"], bursts: 3, ahead: 0, closed: "commit", continues: false },
    ]);
  });

  it("shows a binder written outside a transaction as the statement it is, never as a binding", () => {
    const flights = flightsOf({ lines: [[sent(BINDER_SQL, 0, [A, ""]), sent("select 1", 1)]] });
    expect(flights.map((f) => [f.door, f.account, f.statements])).toEqual([
      ["plain", null, [BINDER_SQL]],
      ["plain", null, ["select 1"]],
    ]);
  });

  it("keeps a savepoint's own statements inside the flight, and what ran in it among the body's", () => {
    const [flight, ...rest] = flightsOf({ lines: [[
      sent("begin", 0), sent(BINDER_SQL, 0, [A, ""]),
      sent("insert into t values (1)", 1), sent("savepoint s0", 2), sent("select 1 / 0", 2), sent("rollback to s0", 3),
      sent("select 2", 4), sent("commit", 5),
    ]] });
    expect(rest).toEqual([]);
    expect(flight!.statements).toEqual(["insert into t values (1)", "select 1 / 0", "select 2"]);
    expect(flight!.closed).toBe("commit");
  });

  it("splits a transaction named again into one flight per binding, in order", () => {
    const flights = flightsOf({ lines: [[
      sent("begin", 0), sent(BINDER_SQL, 0, ["", KEY]), sent("select id from invites", 1),
      sent(BINDER_SQL, 2, [A, ""]), sent("insert into accounts default values", 3), sent("commit", 4),
    ]] });
    expect(flights.map((f) => [f.door, f.account, f.keyed, f.statements, f.closed, f.continues])).toEqual([
      ["write", null, true, ["select id from invites"], null, false],
      ["write", A, false, ["insert into accounts default values"], "commit", true],
    ]);
    expect(keyEquals(flights[0]!, KEY)).toBe(true);
    expect(keyEquals(flights[1]!, KEY)).toBe(false);
  });

  it("answers what a flight's statements carried as parameters, beside the flight and on none of its fields", () => {
    const row = randomUUID();
    const other = randomUUID();
    const flights = flightsOf({ lines: [[
      sent("begin", 0), sent(BINDER_SQL, 0, [A, KEY]), sent("select 1 from t where id = $1", 0, [row]),
      sent("select 1 from t where id = any($1)", 1, [`{${other},${row}}`]), sent("commit", 2),
      sent("select 1 from t where id = $1 and at is $2", 3, [other, null]),
    ]] });
    expect(flights.map((f) => f.door)).toEqual(["write", "plain"]);
    // A value alone, and one among several in one parameter.
    expect(carries(flights[0]!, row)).toBe(true);
    expect(carries(flights[0]!, other)).toBe(true);
    // The binder's own two values are the binding, not a statement's parameters.
    expect(carries(flights[0]!, A)).toBe(false);
    expect(carries(flights[0]!, KEY)).toBe(false);
    // Each flight answers for its own statements.
    expect(carries(flights[1]!, other)).toBe(true);
    expect(carries(flights[1]!, row)).toBe(false);
    expect(carries(flights[1]!, "")).toBe(false);
    expect(JSON.stringify(flights)).not.toContain(row);
  });

  it("keeps each connection's flights apart, and leaves a transaction still open as not closed", () => {
    const flights = flightsOf({ lines: [
      [sent("begin", 0), sent(BINDER_SQL, 0, [A, ""]), sent("select 1", 1)],
      [sent("begin", 2), sent(BINDER_SQL, 2, [B, ""]), sent("select 2", 2), sent("commit", 2)],
    ] });
    expect(flights.map((f) => [f.account, f.door, f.closed])).toEqual([[A, "write", null], [B, "lone", "commit"]]);
  });
});

describe.skipIf(!PG_UP)("flightsOf on what the handles write (real Postgres)", () => {
  let pool: ReturnType<typeof makePooledDb>;
  let raw: postgres.Sql;

  /** The flights of what `run` wrote; a read flight's close is written after its answer, so the reading waits for `flights` closes. */
  const flown = async (run: () => Promise<unknown>, closes = 0): Promise<PgWireFlight[]> => {
    wire.start();
    await run();
    const until = Date.now() + 2_000;
    for (;;) {
      const flights = flightsOf(wire.read());
      if (flights.filter((f) => f.closed !== null).length >= closes || Date.now() > until) return flights;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeAll(async () => {
    pool = makePooledDb(PG_TEST_URL, { max: 1 });
    raw = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    await pool.execute(sql`select 1`);
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
    await closePooledDbs();
  });

  it("a statement on a bound handle is one lone flight: its account, its key by keyEquals alone, one burst", async () => {
    const view = bindDb(pool, { account: A, key: KEY });
    const flights = await flown(() => view.execute(sql`select ${7}::int as seven`));
    expect(flights).toHaveLength(1);
    const [flight] = flights;
    expect(flight).toMatchObject({ door: "lone", account: A, keyed: true, bursts: 1, ahead: 1, closed: "commit", continues: false });
    expect(flight!.statements).toHaveLength(1);
    expect(flight!.statements[0]).toContain("as seven");
    expect(keyEquals(flight!, KEY)).toBe(true);
    expect(keyEquals(flight!, A)).toBe(false);
    expect(JSON.stringify(flight)).not.toContain(KEY);
  });

  it("a statement on a handle bound to nothing is a lone flight that names no account", async () => {
    const flights = await flown(() => bindDb(pool, { account: null }).execute(sql`select ${1}::int as one`));
    expect(flights.map((f) => [f.door, f.account, f.keyed, f.bursts])).toEqual([["lone", null, false, 1]]);
  });

  it("a transaction on a bound handle is door two: the body after the start was answered, then commit", async () => {
    const view = bindDb(pool, { account: B }) as unknown as Tx;
    const flights = await flown(() => view.transaction(async (tx) => {
      await (tx as unknown as Tx).execute(sql`select ${1}::int as first`);
      await (tx as unknown as Tx).execute(sql`select ${2}::int as second`);
    }));
    expect(flights).toHaveLength(1);
    expect(flights[0]).toMatchObject({ door: "write", account: B, keyed: false, ahead: 0, closed: "commit" });
    expect(flights[0]!.statements.map((t) => t.slice(t.lastIndexOf(" as ") + 4))).toEqual(["first", "second"]);
    expect(flights[0]!.bursts).toBe(4);
  });

  it("a transaction whose body throws is closed by rollback", async () => {
    const view = bindDb(pool, { account: A }) as unknown as Tx;
    const flights = await flown(() => view.transaction(async (tx) => {
      await (tx as unknown as Tx).execute(sql`select ${1}::int as one`);
      throw new Error("the body's own");
    }).catch(() => undefined));
    expect(flights.map((f) => [f.door, f.account, f.closed])).toEqual([["write", A, "rollback"]]);
  });

  it("the read flight is door one: begin read only, the binder and the first read before any answer", async () => {
    const flight = readFlightOf(bindDb(pool, { account: A }) as unknown as object) as unknown as Tx;
    const flights = await flown(() => flight.transaction((tx) => (tx as unknown as Tx).execute(sql`select ${1}::int as one`)), 1);
    expect(flights.map((f) => [f.door, f.account, f.ahead, f.closed, f.bursts])).toEqual([["read", A, 1, "commit", 2]]);
  });

  it("a statement and a transaction on the pool's own handle are plain: no binder rode", async () => {
    const flights = await flown(async () => {
      await pool.execute(sql`select ${1}::int as alone`);
      await (pool as unknown as Tx).transaction(async (tx) => { await (tx as unknown as Tx).execute(sql`select ${2}::int as inside`); });
    });
    expect(flights.map((f) => [f.door, f.account, f.keyed, f.closed])).toEqual([
      ["plain", null, false, null],
      ["plain", null, false, "commit"],
    ]);
    expect(flights[0]!.statements[0]).toContain("as alone");
    expect(flights[1]!.statements).toHaveLength(1);
    expect(flights[1]!.statements[0]).toContain("as inside");
  });

  it("a transaction named again inside itself reads as two flights, the second under the account", async () => {
    const nothing = bindDb(pool, { account: null, key: KEY }) as unknown as Tx;
    const flights = await flown(() => nothing.transaction(async (tx) => {
      await (tx as unknown as Tx).execute(sql`select ${1}::int as before`);
      const named = await rebindTx(tx as object & NothingBound, { account: A });
      await (named as unknown as Tx).execute(sql`select ${2}::int as after`);
    }));
    expect(flights.map((f) => [f.door, f.account, f.keyed, f.closed, f.continues])).toEqual([
      ["write", null, true, null, false],
      ["write", A, false, "commit", true],
    ]);
    expect(flights[0]!.statements[0]).toContain("as before");
    expect(flights[1]!.statements[0]).toContain("as after");
    expect(keyEquals(flights[0]!, KEY)).toBe(true);
  });

  it("two accounts in turn on one connection: each flight names its own, none the other's", async () => {
    const a = bindDb(pool, { account: A });
    const b = bindDb(pool, { account: B });
    const flights = await flown(async () => {
      for (let i = 0; i < 3; i++) {
        await a.execute(sql`select ${i}::int as of_a`);
        await b.execute(sql`select ${i}::int as of_b`);
      }
    });
    expect(flights).toHaveLength(6);
    for (const f of flights) {
      expect(f.door).toBe("lone");
      expect(f.account).toBe(f.statements[0]!.includes("of_a") ? A : B);
    }
  });

  it("a parameter the driver wrote is answered by carries, on a bound and on a plain statement alike", async () => {
    const row = randomUUID();
    const flights = await flown(async () => {
      await bindDb(pool, { account: A }).execute(sql`select ${row}::uuid as of_a`);
      await pool.execute(sql`select ${row}::uuid as plain_one`);
      await bindDb(pool, { account: B }).execute(sql`select ${1}::int as of_b`);
    });
    expect(flights.map((f) => [f.door, f.account, carries(f, row)])).toEqual([
      ["lone", A, true], ["plain", null, true], ["lone", B, false],
    ]);
  });

  it("a statement prepared by name before the reading began is read by its text when it is sent again", async () => {
    const named = (): Promise<unknown> => raw`select ${1}::int as prepared_once`;
    await named();
    wire.start();
    await named();
    const r = wire.read();
    // Sent again as a Bind alone: this reading holds no Parse, and the text is the connection's own.
    expect(r.texts).toEqual([]);
    const flights = flightsOf(r);
    expect(flights.map((f) => [f.door, f.statements.length])).toEqual([["plain", 1]]);
    expect(flights[0]!.statements[0]).toContain("as prepared_once");
  });
});
