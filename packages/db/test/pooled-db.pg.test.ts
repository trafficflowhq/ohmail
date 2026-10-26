import { describe, it, expect, afterAll } from "vitest";
import net from "node:net";
import { sql as raw } from "drizzle-orm";
import postgres from "postgres";
import {
  makePooledDb, closePooledDbs, POOLED_TIMEOUTS, API_MAX_DURATION_MS, isDbAcquireTimeout,
} from "../src/client.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

const AVAILABLE = await realPgAvailable();

/**
 * The serverless request-scoped Db. Verifies the `prepare: false` pooled
 * connection is functional against a real Postgres and that repeated calls for the same
 * connection string reuse ONE underlying pool (module-cached) rather than opening a new
 * connection per request. Runs against the docker compose Postgres on :5433.
 */
const URL = PG_TEST_URL;

describe.skipIf(!AVAILABLE)("makePooledDb — serverless pooled Db", () => {
  afterAll(async () => { await closePooledDbs(); });

  it("returns a working Db with prepare:false and executes queries", async () => {
    const db = makePooledDb(URL);
    const rows = await db.execute(raw`select 1 as one`);
    const one = Number((rows as unknown as Array<{ one: number }>)[0]!.one);
    expect(one).toBe(1);
  });

  it("caches one pool per connection string (a warm instance reuses it)", async () => {
    const a = makePooledDb(URL);
    const b = makePooledDb(URL);
    // Both wrappers run against the same cached underlying pool; both must work
    // concurrently without opening a second connection storm.
    const [ra, rb] = await Promise.all([
      a.execute(raw`select 2 as two`),
      b.execute(raw`select 3 as three`),
    ]);
    expect(Number((ra as unknown as Array<{ two: number }>)[0]!.two)).toBe(2);
    expect(Number((rb as unknown as Array<{ three: number }>)[0]!.three)).toBe(3);
  });

  it("hands every request ONE handle per URL and ceiling, so what a caller keeps per handle holds", async () => {
    // The host asks on every request; a new handle each time re-ran every per-handle probe.
    const a = makePooledDb(URL);
    expect(makePooledDb(URL)).toBe(a);
    const short = makePooledDb(URL, { acquireTimeoutMs: 5_000 });
    expect(short).not.toBe(a);
    expect(makePooledDb(URL, { acquireTimeoutMs: 5_000 })).toBe(short);
    await closePooledDbs();
    const fresh = makePooledDb(URL);
    expect(fresh).not.toBe(a);
    const rows = await fresh.execute(raw`select 4 as four`);
    expect(Number((rows as unknown as Array<{ four: number }>)[0]!.four)).toBe(4);
  });
});

/**
 * ── THE GATEWAY-TIMEOUT FAMILY, AND WHY A COMMENT WAS NOT A CEILING ───────────────────────────
 *
 * Seven days of production request logs held hundreds of gateway timeouts on this API. Every one was
 * `FUNCTION_INVOCATION_TIMEOUT` between 60 009 ms and 60 517 ms — a distribution with no
 * variance, which is what a wait that never ends looks like after one external knife truncates
 * it. They covered 15 route families on hot instances in one region, so the cause was the one
 * resource all of them share: the connection this factory hands out, which had no server-side
 * deadline of any kind.
 *
 * These are the guards for the ceilings that replaced that. Two of them reproduce the production
 * shape against a real backend, because "we set some timeouts" is a claim and the claim is that
 * the database gives up BEFORE the platform does.
 */
describe("POOLED_TIMEOUTS — the values", () => {
  it("every ceiling is strictly under the platform kill it is derived from", () => {
    // The whole point: the DATABASE must fail first. A statement that fails is an error a route
    // can answer and log; a function that is killed is a 504 nobody can attribute afterwards.
    // Named individually so removing one is a visible edit rather than a smaller object.
    expect(POOLED_TIMEOUTS.lock_timeout).toBeGreaterThan(0);
    expect(POOLED_TIMEOUTS.statement_timeout).toBeGreaterThan(0);
    expect(POOLED_TIMEOUTS.idle_in_transaction_session_timeout).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(POOLED_TIMEOUTS)) {
      expect(v, `${k} must fire before the platform kills the function`)
        .toBeLessThan(API_MAX_DURATION_MS);
    }
  });

  it("a lock wait gives up before a statement does, so the error names the right cause", () => {
    expect(POOLED_TIMEOUTS.lock_timeout).toBeLessThanOrEqual(POOLED_TIMEOUTS.statement_timeout);
  });

  it("leaves the route enough of its budget to still answer after the database refuses", () => {
    // 25 s of statement inside a 60 s invocation leaves 35 s for the rest of the request. A
    // ceiling that consumed the whole budget would swap one silent 504 for another.
    expect(API_MAX_DURATION_MS - POOLED_TIMEOUTS.statement_timeout).toBeGreaterThanOrEqual(30_000);
  });
});

describe.skipIf(!AVAILABLE)("POOLED_TIMEOUTS — against a real backend", () => {
  afterAll(async () => { await closePooledDbs(); });

  it("the settings actually reach the session (a comment is not a connection option)", async () => {
    const db = makePooledDb(URL);
    const rows = await db.execute(raw`select current_setting('lock_timeout') as lock,
      current_setting('statement_timeout') as stmt,
      current_setting('idle_in_transaction_session_timeout') as idle`);
    const r = ((rows as { rows?: unknown[] }).rows ?? (rows as unknown[]))[0] as Record<string, string>;
    // Postgres reports these as strings with units; the point is they are NOT "0" (no limit),
    // which is exactly what this handle reported before the fix.
    expect(r.lock).not.toBe("0");
    expect(r.stmt).not.toBe("0");
    expect(r.idle).not.toBe("0");
  }, 60_000);

  it("THE REGRESSION: a runaway statement is CANCELLED, not left to outlive the function", async () => {
    // `pg_sleep` past the ceiling stands in for the real population — a lock wait, a pooler that
    // stopped answering, a seq scan on a mailbox that outgrew its index. Before the ceiling this
    // ran until the platform killed the invocation at 60 s and the backend kept going.
    const db = makePooledDb(URL);
    const started = Date.now();
    const err = await db
      .execute(raw`select pg_sleep(${(POOLED_TIMEOUTS.statement_timeout / 1000) + 20})`)
      .then(() => null)
      .catch((e: unknown) => e as { code?: string });

    // 57014 = query_canceled. The wait ENDED, and it ended for the right reason.
    expect(err, "the runaway statement must fail, not run on").not.toBeNull();
    expect(err?.code).toBe("57014");
    const took = Date.now() - started;
    // …at its own ceiling, and — the acceptance for the whole 504 family — before the platform's.
    expect(took).toBeGreaterThanOrEqual(POOLED_TIMEOUTS.statement_timeout - 2_000);
    expect(took).toBeLessThan(API_MAX_DURATION_MS);
  }, 120_000);

  it("THE REGRESSION: a blocked row lock gives up instead of pinning a connection", async () => {
    // A one-connection pool was the amplifier: postgres.js pipelines rather than errors, so a
    // connection stuck on a lock stalls everything queued behind it on the warm instance. That is
    // why 15 unrelated route families timed out in the same minute.
    const holder = postgres(URL, { max: 1, onnotice: () => {} });
    const db = makePooledDb(URL);
    try {
      await holder`create table if not exists tf_pooled_lock_probe (id int primary key, n int)`;
      await holder`insert into tf_pooled_lock_probe (id, n) values (1, 0)
        on conflict (id) do update set n = 0`;
      // Hold the row and DO NOT commit — the state a platform-killed function leaves behind.
      const held = holder.begin(async (tx) => {
        await tx`update tf_pooled_lock_probe set n = n + 1 where id = 1`;
        await new Promise((r) => setTimeout(r, POOLED_TIMEOUTS.lock_timeout + 15_000));
      });

      await new Promise((r) => setTimeout(r, 400));   // let the lock land
      const started = Date.now();
      const err = await db
        .execute(raw`update tf_pooled_lock_probe set n = n + 1 where id = 1`)
        .then(() => null)
        .catch((e: unknown) => e as { code?: string });

      // 55P03 = lock_not_available.
      expect(err, "the blocked statement must fail, not hang").not.toBeNull();
      expect(err?.code).toBe("55P03");
      const took = Date.now() - started;
      // The ORDERING invariant, proven behaviourally and not only as a comparison of two
      // literals: the lock ceiling fired, so it fired BEFORE the statement ceiling could mask it
      // and name 57014 (a runaway query) for what is actually contention.
      expect(took).toBeGreaterThanOrEqual(POOLED_TIMEOUTS.lock_timeout - 2_000);
      expect(took).toBeLessThan(POOLED_TIMEOUTS.statement_timeout);

      await held.catch(() => { /* torn down below */ });
    } finally {
      await holder`drop table if exists tf_pooled_lock_probe`.catch(() => {});
      await holder.end({ timeout: 5 });
    }
  }, 120_000);
});

/*
 * A TRANSACTION'S WAIT TO BEGIN is bounded like a statement's, and a refused one writes NOTHING.
 * `sql.begin` opens through the driver's own handle, so the statement ceiling never saw it: on a
 * busy pool every transaction waited for a connection without limit. The arm refuses the caller at
 * the ceiling and, when the connection does come, rolls the abandoned transaction back before its
 * callback can write — a 503 whose write committed anyway would be worse than the wait it ends.
 */
describe.skipIf(!AVAILABLE)("a transaction's wait to begin", () => {
  afterAll(async () => { await closePooledDbs(); });

  it("is refused at the ceiling on a busy pool, and the refused transaction never writes", async () => {
    await closePooledDbs();   // so this URL's pool is built here, with ONE connection
    const db = makePooledDb(URL, { acquireTimeoutMs: 200, max: 1 });
    const patient = makePooledDb(URL, { acquireTimeoutMs: 10_000 });   // the same pool, a long wait
    const direct = postgres(URL, { max: 1, onnotice: () => {} });
    try {
      await direct`create table if not exists tf_pooled_begin_probe (id int primary key)`;
      await direct`delete from tf_pooled_begin_probe`;
      await patient.execute(raw`select 1`);   // dialled: a cold dial is not the wait under test

      // The positive control: an idle pool begins inside the ceiling and commits.
      await db.transaction(async (tx) => { await tx.execute(raw`insert into tf_pooled_begin_probe (id) values (1)`); });

      // The pool's only connection, held by an open transaction for three seconds.
      const holding = patient.transaction(async (tx) => { await tx.execute(raw`select pg_sleep(3)`); });
      holding.catch(() => { /* awaited below */ });
      await new Promise((r) => setTimeout(r, 150));

      const started = Date.now();
      const err = await db.transaction(async (tx) => {
        await tx.execute(raw`insert into tf_pooled_begin_probe (id) values (2)`);
      }).then(() => null, (e: unknown) => e);
      expect(isDbAcquireTimeout(err), "refused by name, not left waiting").toBe(true);
      expect(Date.now() - started, "at the ceiling, not at the holder's end").toBeLessThan(1_500);

      await holding;
      // FIFO behind the abandoned BEGIN: this answers only once that transaction has rolled back.
      const back = await patient.execute(raw`select 5 as five`);
      expect(Number((back as unknown as Array<{ five: number }>)[0]!.five), "the connection came back").toBe(5);
      const ids = (await direct`select id from tf_pooled_begin_probe order by id`).map((r) => Number(r.id));
      expect(ids, "the refused transaction wrote nothing; the control's row stands").toEqual([1]);
    } finally {
      await direct`drop table if exists tf_pooled_begin_probe`.catch(() => {});
      await direct.end({ timeout: 5 });
    }
  }, 60_000);
});

/** A transaction-mode pooler stand-in: it holds a statement (a checkout that waits), forwards it, or refuses it unforwarded. */
async function fakePooler(target: string) {
  const to = new globalThis.URL(target);
  const pairs: Array<{ client: net.Socket; server: net.Socket; held: Buffer[] }> = [];
  let mode: "pass" | "hold" | "hold-queries" = "pass";
  const server = net.createServer((client) => {
    const pair = { client, server: net.connect(Number(to.port), to.hostname), held: [] as Buffer[] };
    pairs.push(pair);
    pair.server.on("data", (d) => client.write(d));
    client.on("data", (d: Buffer) => {
      const query = d[0] === 0x50 || d[0] === 0x51;   // Parse or Query: anything past startup
      if (mode === "hold" || pair.held.length > 0 || (mode === "hold-queries" && query)) pair.held.push(d);
      else pair.server.write(d);
    });
    for (const s of [client, pair.server]) { s.on("error", () => {}); s.on("close", () => { client.destroy(); pair.server.destroy(); }); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = new globalThis.URL(target);
  url.hostname = "127.0.0.1";
  url.port = String((server.address() as net.AddressInfo).port);
  return {
    url: url.toString(),
    hold: (queriesOnly = false) => { mode = queriesOnly ? "hold-queries" : "hold"; },
    release: () => { mode = "pass"; for (const p of pairs) { for (const b of p.held.splice(0)) p.server.write(b); } },
    /** Refuse every held statement the way the pooler does: one FATAL, then the close, nothing forwarded. */
    refuse: (code: string, message: string) => {
      mode = "pass";
      const body = Buffer.from(`SFATAL\0VFATAL\0C${code}\0M${message}\0\0`);
      const frame = Buffer.concat([Buffer.from("E"), Buffer.alloc(4), body]);
      frame.writeInt32BE(body.length + 4, 1);
      for (const p of pairs.filter((x) => x.held.length > 0)) { p.held = []; p.client.end(frame); p.server.destroy(); }
    },
    close: () => { server.close(); for (const p of pairs) { p.client.destroy(); p.server.destroy(); } },
  };
}

// The pooler's wire text: its error code in front of the message.
const CHECKOUT_REFUSED = ["XX000", "(ECHECKOUTTIMEOUT) unable to check out connection from the pool after 300ms in Transaction mode"] as const;

/*
 * A HEAD WAITING AT A TRANSACTION-MODE POOLER is the pooler's to refuse, never the client's: a
 * one-flush statement's first reply byte comes with its completion, so a silent head may already
 * be running a write. The pooler's own refusal says it never handed the statement on: busy.
 */
describe.skipIf(!AVAILABLE)("a head the pooler holds", () => {
  const direct = postgres(URL, { max: 1, onnotice: () => {} });
  const ran = async (id: number): Promise<boolean> =>
    (await direct`select 1 from tf_pooled_head_probe where id = ${id}`).length === 1;
  afterAll(async () => {
    await closePooledDbs();
    await direct`drop table if exists tf_pooled_head_probe`.catch(() => {});
    await direct.end({ timeout: 5 });
  });

  async function scene(ceiling: number) {
    await closePooledDbs();
    await direct`create table if not exists tf_pooled_head_probe (id int primary key)`;
    const pooler = await fakePooler(URL);
    return { pooler, db: makePooledDb(pooler.url, { acquireTimeoutMs: ceiling, max: 1 }) };
  }

  it("is refused as busy when the pooler gives up on it, and the write never ran", async () => {
    const { pooler, db } = await scene(5_000);
    try {
      await db.execute(raw`select 1`);
      pooler.hold();
      const started = Date.now();
      const out = db.execute(raw`insert into tf_pooled_head_probe (id) values (${1})`).then(() => null, (e: unknown) => e);
      setTimeout(() => pooler.refuse(...CHECKOUT_REFUSED), 300);
      expect(isDbAcquireTimeout(await out), "the pooler's refusal is db_busy, not a closed connection").toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await ran(1)).toBe(false);
      await expect(db.execute(raw`select 2`), "the pool dials again").resolves.toBeDefined();
    } finally { pooler.close(); }
  }, 30_000);

  it("a query_wait_timeout refusal of a cold dial's first statement is busy too", async () => {
    const { pooler, db } = await scene(5_000);
    try {
      pooler.hold(true);
      const cold = db.execute(raw`insert into tf_pooled_head_probe (id) values (${2})`).then(() => null, (e: unknown) => e);
      setTimeout(() => pooler.refuse("08P01", "query_wait_timeout"), 300);
      expect(isDbAcquireTimeout(await cold)).toBe(true);
      expect(await ran(2)).toBe(false);
    } finally { pooler.close(); }
  }, 30_000);

  it("a transaction whose BEGIN the pooler refuses is busy, and its callback never runs", async () => {
    const { pooler, db } = await scene(5_000);
    try {
      await db.execute(raw`select 1`);
      pooler.hold();
      let called = false;
      const out = db.transaction(async (tx) => { called = true; await tx.execute(raw`insert into tf_pooled_head_probe (id) values (${3})`); })
        .then(() => null, (e: unknown) => e);
      setTimeout(() => pooler.refuse(...CHECKOUT_REFUSED), 300);
      expect(isDbAcquireTimeout(await out)).toBe(true);
      expect(called).toBe(false);
      expect(await ran(3)).toBe(false);
    } finally { pooler.close(); }
  }, 30_000);

  it("is never refused by the client while the pooler holds it: forwarded, the write runs and answers", async () => {
    const { pooler, db } = await scene(300);
    try {
      await db.execute(raw`select 1`);
      pooler.hold();
      let settled = "pending";
      const out = db.execute(raw`insert into tf_pooled_head_probe (id) values (${4})`)
        .then(() => { settled = "ran"; }, (e: unknown) => { settled = (e as Error).name; });
      await new Promise((r) => setTimeout(r, 900));
      expect(settled, "three ceilings later the head still waits").toBe("pending");
      pooler.release();
      await out;
      expect(settled).toBe("ran");
      expect(await ran(4)).toBe(true);
    } finally { pooler.close(); }
  }, 30_000);

  it("a session-mode checkout refusal is busy too", async () => {
    const { pooler, db } = await scene(5_000);
    try {
      await db.execute(raw`select 1`);
      pooler.hold();
      const out = db.execute(raw`insert into tf_pooled_head_probe (id) values (${5})`).then(() => null, (e: unknown) => e);
      setTimeout(() => pooler.refuse("XX000", "(ECHECKOUTTIMEOUT) unable to check out connection from the pool after 15000ms in Session mode"), 300);
      expect(isDbAcquireTimeout(await out)).toBe(true);
      expect(await ran(5)).toBe(false);
    } finally { pooler.close(); }
  }, 30_000);

  // A DbHandler exit comes after the statement was forwarded (it may have committed); the other
  // two texts are not what a pooler that keeps pipelined replies in order sends.
  it.each([
    ["57P01", "terminating connection due to administrator command"],
    ["XX000", "(EDBHANDLEREXITED) DbHandler exited. Check logs for more information"],
    ["XX000", "unable to check out connection from the pool after 300ms in Transaction mode"],
    ["XX000", "Unable to check out connection from the pool due to timeout"],
  ])("any other FATAL that closes the connection stays a closed connection: %s %s", async (code, message) => {
    const { pooler, db } = await scene(5_000);
    try {
      await db.execute(raw`select 1`);
      pooler.hold();
      const out = db.execute(raw`select 3`).then(() => null, (e: unknown) => e);
      setTimeout(() => pooler.refuse(code, message), 300);
      expect(await out).toMatchObject({ code: "CONNECTION_CLOSED" });
    } finally { pooler.close(); }
  }, 30_000);
});
