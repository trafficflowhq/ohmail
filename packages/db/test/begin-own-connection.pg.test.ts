import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { bindDb } from "../src/bound.js";
import { closePooledDbs, makeOwnedDb, makePooledDb, type OwnedDb } from "../src/client.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * A PLAIN TRANSACTION WRITES ONLY ON ITS OWN CONNECTION.
 *
 * postgres.js 3.4.9's `begin` writes every statement of a transaction on the connection its BEGIN ran on,
 * whoever holds that connection by then. When it closes while the callback waits, the caller is told
 * CONNECTION_CLOSED and the callback goes on, and the pool dials the same connection again for the next
 * caller: the callback's next statement ran inside that caller's transaction (under a bound flight's
 * account), its commit committed that transaction early and its rollback removed that transaction's rows;
 * with nobody holding the connection, a later write stood alone. A statement sent on the handle after its
 * transaction ended ran the same way. patches/postgres@3.4.9.patch refuses it in `begin`, unwritten, once
 * the connection's reservation is no longer the one its BEGIN made.
 */

const PG_UP = await realPgAvailable();
const MARKER = "statement sent on a transaction whose connection closed";

/** The transaction pooler of bound-flight.pg.test.ts: `TF_POOLER_ADDRESS` (`host:port`); `TF_REQUIRE_POOLER=1` makes its absence a failure. */
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
if (!POOLER_UP) process.stderr.write("begin-own-connection: no transaction pooler at TF_POOLER_ADDRESS; its cases are skipped\n");

const B = randomUUID();
const C = randomUUID();

type Tx = { transaction: <R>(fn: (tx: object) => Promise<R>, config?: object) => Promise<R>; execute: (q: unknown) => Promise<unknown> };
interface Reading { a: string; pid: number; at: string; tx: string }
const rowsOf = (r: unknown): Array<Record<string, unknown>> => r as Array<Record<string, unknown>>;
const tagOf = (e: unknown): string => `${(e as Error).name}:${String((e as { code?: unknown }).code ?? "")}`;
const outcome = (p: Promise<unknown>): Promise<string> => p.then(() => "ok", tagOf);
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const within = <T>(p: Promise<T>, ms: number): Promise<T | "NEVER"> => Promise.race([p, new Promise<"NEVER">((resolve) => {
  const t = setTimeout(() => resolve("NEVER"), ms);
  (t as { unref?: () => void }).unref?.();
})]);
const gate = <T = void>(): { promise: Promise<T>; open: (v: T) => void } => {
  let open!: (v: T) => void;
  const promise = new Promise<T>((r) => { open = r; });
  return { promise, open };
};
/** The test database's URL under its own application name, through `at` (`host:port`) when named. */
const named = (name: string, at?: string | null): string => {
  const url = new URL(PG_TEST_URL);
  if (at) url.host = at;
  url.searchParams.set("application_name", name);
  return url.toString();
};
const who = (a: unknown): string => (a === B ? "B" : a === C ? "C" : a === "" || a == null ? "none" : "?");
/** "refused" when the patch refused the statement unwritten (`CONNECTION_CLOSED` with its reason), else as `outcome` reads it. */
const told = (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e: unknown) => {
  const x = e as { code?: unknown; reason?: unknown };
  return x?.code === "CONNECTION_CLOSED" && x.reason === MARKER ? "refused" : tagOf(e);
});
/**
 * A seeded generator: the 31-bit LCG the rounds draw from, its product taken whole (`Math.imul`; in a double the
 * product outgrew 53 bits and lost its low bits, so a pause of up to 40 ms took five values), each draw read from its
 * high bits. The same seed gives the same draws in the same order, and every round draws its values at its start, so
 * a seed reproduces a run's steps and pauses.
 */
const seeded = (seed: number) => (n: number): number => {
  seed = (Math.imul(seed, 1_103_515_245) + 12_345) & 0x7fffffff;
  return (seed >>> 16) % n;
};

const HANDLES = [
  { kind: "the pooled cell (a pool of one)", slug: "pooled", at: null as string | null, self: false },
  { kind: "the self-hosted pool", slug: "self", at: null as string | null, self: true },
  { kind: "the pooled cell through a transaction pooler", slug: "pooler", at: POOLER as string | null, self: false },
];

/** The driver as each build the package ships loads: the ESM build by import, the CommonJS build by require. */
const BUILDS = [
  { build: "the ESM build (src/)", open: postgres },
  { build: "the CommonJS build (cjs/src/)", open: createRequire(import.meta.url)("postgres") as typeof postgres },
];

describe.skipIf(!PG_UP)("the driver's own begin, in both builds the package ships (`node scripts/apply-patches.mjs apply` after an npm install)", () => {
  const admin = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
  let nextId = Math.floor(Math.random() * 1e6) * 100 + 5;
  beforeAll(async () => { await admin`create table if not exists tf_begin_gap (id int primary key, tx text)`; });
  afterAll(async () => {
    await admin`drop table if exists tf_begin_gap`.catch(() => undefined);
    await admin.end({ timeout: 5 });
  });
  type Raw = (s: TemplateStringsArray, ...v: unknown[]) => Promise<Array<Record<string, unknown>>>;
  const refusal = (e: unknown) => {
    const x = e as { code?: unknown; reason?: unknown; message?: unknown };
    return { code: x.code, reason: x.reason, message: x.message };
  };
  /** Coded as the driver codes a closed connection, with the patch's reason, and no host in its words. */
  const REFUSAL = { code: "CONNECTION_CLOSED", reason: MARKER, message: "write CONNECTION_CLOSED" };

  for (const { build, open } of BUILDS) {
    it(`${build}: a statement sent on a transaction's handle after the transaction ended is refused`, async () => {
      const one = open(named("tf-begin-own-build"), { max: 1, onnotice: () => {} });
      try {
        const kept: { t: Raw | null } = { t: null };
        await one.begin(async (t) => { await t`select 1`; kept.t = t as unknown as Raw; });
        expect(await kept.t!`select 1`.then(() => "ok", refusal)).toEqual(REFUSAL);
      } finally {
        await one.end({ timeout: 5 });
      }
    }, 30_000);

    it(`${build}: a statement sent after the transaction's connection closed is refused, and the connection dialed again serves the next caller`, async () => {
      const one = open(named("tf-begin-own-build"), { max: 1, onnotice: () => {} });
      try {
        const idled = gate<number>();
        const goA = gate();
        const done = gate<unknown>();
        const outA = one.begin(async (t) => {
          const [row] = await t`select pg_backend_pid() as pid`;
          idled.open(Number(row!.pid));
          await goA.promise;
          done.open(await t`select 1`.then(() => "ok", refusal));
        }).then(() => "ok", (e: unknown) => String((e as { code?: unknown }).code));
        await admin`select pg_terminate_backend(${await idled.promise})`;
        const next = await one`select ${2}::int as n`;
        goA.open();
        expect({ a: await outA, after: await within(done.promise, 3_000), next: next[0]?.n })
          .toEqual({ a: "CONNECTION_CLOSED", after: REFUSAL, next: 2 });
      } finally {
        await one.end({ timeout: 5 });
      }
    }, 30_000);

    it(`${build}: a sibling handed in any microtask after the callback returns or gives up: the driver's own commit or rollback is written, and the sibling stands inside the transaction or is refused, never alone`, async () => {
      const bad: string[] = [];
      const refusedAt: string[] = [];
      for (const givesUp of [false, true]) {
        for (let depth = 0; depth <= 8; depth++) {
          // A pool of its own each time: a transaction whose close was refused would hold its connection.
          const one = open(named("tf-begin-own-gap"), { max: 1, onnotice: () => {} });
          const idA = (nextId += 10);
          let sibling: Promise<string> = Promise.resolve("not sent");
          const a = await within(one.begin(async (t) => {
            await t`insert into tf_begin_gap (id, tx) values (${idA}, txid_current()::text)`;
            let n = depth;
            const hand = (): void => {
              if (n-- > 0) { queueMicrotask(hand); return; }
              sibling = told(t`insert into tf_begin_gap (id, tx) values (${idA + 1}, txid_current()::text)`);
            };
            queueMicrotask(hand);
            if (givesUp) throw new Error("A gives up");
          }).then(() => "ok", tagOf), 5_000);
          const s = await within(sibling, 2_000);
          const next = await within(one`select 1`.then(() => "ok", tagOf), 3_000);
          const rows = await admin`select id, tx from tf_begin_gap where id in (${idA}, ${idA + 1})`;
          const txA = rows.find((x) => x.id === idA)?.tx;
          const txS = rows.find((x) => x.id === idA + 1)?.tx;
          const row = txS === undefined ? "no row" : txS === txA ? "inside A" : "alone";
          const close = givesUp ? "rollback" : "commit";
          const reading = `${close}, sibling ${depth} microtasks on: A ${a}, sibling ${String(s)} (${row}), next ${String(next)}`;
          const own = givesUp ? a === "Error:" : a === "ok";
          const sib = (s === "refused" && row === "no row") || (s === "ok" && row === (givesUp ? "no row" : "inside A"));
          if (!own || !sib || next !== "ok") bad.push(reading);
          if (s === "refused") refusedAt.push(`${close} ${depth}`);
          await within(one.end({ timeout: 1 }), 5_000);
        }
      }
      expect({ bad, windowReached: ["commit", "rollback"].map((c) => refusedAt.some((x) => x.startsWith(c))) })
        .toEqual({ bad: [], windowReached: [true, true] });
    }, 60_000);

    it(`${build}: the driver's own prepare transaction is written as the transaction's close`, async () => {
      const one = open(named("tf-begin-own-prepare"), { max: 1, onnotice: () => {} });
      const gid = `tf_begin_own_${randomUUID().slice(0, 8)}`;
      try {
        const out = await within(one.begin(async (t) => {
          await t`select 1`;
          (t as unknown as { prepare: (name: string) => void }).prepare(gid);
        }).then(() => "prepared", (e: unknown) => {
          const x = e as { name?: unknown; code?: unknown };
          // max_prepared_transactions = 0 (the default, and the test servers'): the server's own refusal, so it was written.
          return x.name === "PostgresError" && x.code === "55000" ? "refused by the server" : tagOf(e);
        }), 5_000);
        const [held] = await admin`select count(*)::int as n from pg_prepared_xacts where gid = ${gid}`;
        if (held?.n === 1) await admin.unsafe(`rollback prepared '${gid}'`);
        const next = await within(one`select 1`.then(() => "ok", tagOf), 3_000);
        expect({ written: out === "prepared" ? held?.n === 1 : out === "refused by the server", next }).toEqual({ written: true, next: "ok" });
      } finally {
        await within(one.end({ timeout: 1 }), 5_000);
      }
    }, 30_000);
  }
});

describe.skipIf(!PG_UP)("a plain transaction whose connection closed, dialed again for another caller", () => {
  const admin = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
  let nextId = Math.floor(Math.random() * 1e6) * 100;
  const fresh = (): number => (nextId += 10);
  const ins = (t: Tx, id: number, note: string) =>
    t.execute(sql`insert into tf_begin_own (id, acct, note, tx) values (${id}, current_setting('ohmail.account', true), ${note}, txid_current()::text)`);
  const mine = (t: Tx): Promise<Reading> =>
    t.execute(sql`select current_setting('ohmail.account', true) as a, pg_backend_pid() as pid, now()::text as at, txid_current()::text as tx`)
      .then((x) => { const r = rowsOf(x)[0]; return { a: who(r?.a), pid: Number(r?.pid), at: String(r?.at), tx: String(r?.tx) }; });
  /** Whose binding the row stands under, or "no row". */
  const standing = async (id: number): Promise<string> => {
    const [row] = await admin`select acct from tf_begin_own where id = ${id}`;
    return row === undefined ? "no row" : who(row.acct);
  };
  const txOf = async (id: number): Promise<string> => String((await admin`select tx from tf_begin_own where id = ${id}`)[0]?.tx);
  /** What the caller that took the connection reads when the dead transaction wrote nothing into it. */
  const UNTOUCHED = (acct: string) => ({ b: "ok", bOwn: true, midB: ["no row", "no row"], lateB: "ok", bRows: [acct, acct], bOneTx: true, next: "ok" });

  beforeAll(async () => { await admin`create table if not exists tf_begin_own (id int primary key, acct text, note text, tx text)`; });
  afterAll(async () => {
    await admin`drop table if exists tf_begin_own`.catch(() => undefined);
    await admin.end({ timeout: 5 });
    await closePooledDbs();
  });

  describe.each(HANDLES)("on $kind", ({ slug, at, self }) => {
    const skip = at !== null && !POOLER_UP;
    let owned: OwnedDb | null = null;
    let db: object;
    beforeAll(() => {
      if (skip) return;
      if (self) db = (owned = makeOwnedDb(named(`tf-begin-own-${slug}`), { role: "api" })).db;
      else db = makePooledDb(named(`tf-begin-own-${slug}`, at), { max: 1, acquireTimeoutMs: 8_000 });
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
     * A, a plain transaction on the plain handle, runs `body`, which calls `idle(pid)` where its callback waits:
     * its backend `pid` is ended there. `next` takes the connection the pool dials again: B's bound flight, a
     * plain transaction, or nobody (a lone plain statement dials it and leaves it idle). Then A goes on. B writes
     * a row, reads its binding, waits until A is done, reads again, writes a second row and commits.
     */
    const scene = async (
      next: "bound" | "plain" | "nobody",
      body: (t: Tx, idle: (pid: number) => Promise<void>) => Promise<void>,
      killAfterMs = 15,
    ): Promise<Record<string, unknown>> => {
      const plain = db as Tx;
      const other = next === "bound" ? bindDb(db, { account: B }) as unknown as Tx : plain;
      const expectB = next === "bound" ? "B" : "none";
      const idB = fresh();
      const idled = gate<number>();
      const goA = gate();
      const began = gate<Reading>();
      const goB = gate();
      const bodyDone = gate();
      let second: Reading | string = "not read";
      let lateB = "not sent";
      const outA = outcome(plain.transaction(async (tx) => {
        try {
          await body(tx as unknown as Tx, async (pid) => { idled.open(pid); await goA.promise; });
        } finally {
          bodyDone.open();
        }
      }));
      const pid = await within(idled.promise, 5_000);
      if (pid === "NEVER") return { a: await within(outA, 100), never: "A never reached the point where its connection is ended" };
      const held = self ? hold(4) : null;
      await held?.began;
      const outB = next === "nobody" ? null : outcome(other.transaction(async (tx) => {
        const t = tx as unknown as Tx;
        await ins(t, idB, "B first");
        began.open(await mine(t));
        await goB.promise;
        second = await mine(t).catch(tagOf);
        lateB = await outcome(ins(t, idB + 1, "B second"));
      }));
      await pause(killAfterMs);
      await admin`select pg_terminate_backend(${pid})`;
      const first = outB === null ? null : await within(began.promise, 6_000);
      if (outB === null) {
        await pause(150);
        await within(outcome(plain.execute(sql`select ${1}::int`)), 6_000);
      }
      goA.open();
      await within(bodyDone.promise, 6_000);
      const a = await within(outA, 6_000);
      await pause(200);   // a commit or a rollback A wrote would have landed by now
      const midB = [await standing(idB), await standing(idB + 1)];
      goB.open();
      const b = outB === null ? null : await within(outB, 6_000);
      await held?.letGo();
      const s = second as Reading | string;
      return {
        a,
        ...(outB === null ? {} : {
          b,
          bOwn: first !== null && first !== "NEVER" && typeof s === "object"
            && first.a === expectB && s.a === expectB && first.pid === s.pid && first.at === s.at && first.tx === s.tx,
          midB, lateB,
          bRows: [await standing(idB), await standing(idB + 1)],
          bOneTx: (await txOf(idB)) === (await txOf(idB + 1)),
        }),
        next: await within(outcome(plain.execute(sql`select ${2}::int`)), 6_000),
      };
    };

    /** A goes on after its connection closed: it reads its binding and writes once more. */
    const goesOn = (idA: number, inside: Record<string, string>, givesUp = false) => async (t: Tx, idle: (pid: number) => Promise<void>) => {
      await ins(t, idA, "A before");
      await idle((await mine(t)).pid);
      inside.read = await mine(t).then((x) => `read ${x.a}`, tagOf);
      inside.wrote = await outcome(ins(t, idA + 1, "A after"));
      if (givesUp) throw new Error("A gives up");
    };
    const REFUSED_INSIDE = { read: "Error:CONNECTION_CLOSED", wrote: "Error:CONNECTION_CLOSED" };

    it.skipIf(skip)("A goes on and returns; B's bound flight took the connection: A writes nothing, and B's rows, binding and commit stay its own", async () => {
      const idA = fresh();
      const inside: Record<string, string> = {};
      const seen = await scene("bound", goesOn(idA, inside));
      expect({ ...seen, inside, aRows: [await standing(idA), await standing(idA + 1)] }).toEqual({
        ...UNTOUCHED("B"), a: "Error:CONNECTION_CLOSED", inside: REFUSED_INSIDE, aRows: ["no row", "no row"],
      });
    }, 30_000);

    it.skipIf(skip)("A gives up; B's bound flight took the connection: A's rollback is not written there, and B keeps its rows", async () => {
      const idA = fresh();
      const inside: Record<string, string> = {};
      const seen = await scene("bound", goesOn(idA, inside, true));
      expect({ ...seen, inside, aRows: [await standing(idA), await standing(idA + 1)] }).toEqual({
        ...UNTOUCHED("B"), a: "Error:CONNECTION_CLOSED", inside: REFUSED_INSIDE, aRows: ["no row", "no row"],
      });
    }, 30_000);

    it.skipIf(skip)("A goes on and returns; a plain transaction took the connection: A writes nothing, and that transaction commits its own", async () => {
      const idA = fresh();
      const inside: Record<string, string> = {};
      const seen = await scene("plain", goesOn(idA, inside));
      expect({ ...seen, inside, aRows: [await standing(idA), await standing(idA + 1)] }).toEqual({
        ...UNTOUCHED("none"), a: "Error:CONNECTION_CLOSED", inside: REFUSED_INSIDE, aRows: ["no row", "no row"],
      });
    }, 30_000);

    it.skipIf(skip)("A gives up; a plain transaction took the connection: A's rollback is not written there", async () => {
      const idA = fresh();
      const inside: Record<string, string> = {};
      const seen = await scene("plain", goesOn(idA, inside, true));
      expect({ ...seen, inside, aRows: [await standing(idA), await standing(idA + 1)] }).toEqual({
        ...UNTOUCHED("none"), a: "Error:CONNECTION_CLOSED", inside: REFUSED_INSIDE, aRows: ["no row", "no row"],
      });
    }, 30_000);

    it.skipIf(skip)("A goes on and returns; nobody holds the connection dialed again: A's later write does not stand alone", async () => {
      const idA = fresh();
      const inside: Record<string, string> = {};
      const seen = await scene("nobody", goesOn(idA, inside));
      expect({ ...seen, inside, aRows: [await standing(idA), await standing(idA + 1)] }).toEqual({
        a: "Error:CONNECTION_CLOSED", next: "ok", inside: REFUSED_INSIDE, aRows: ["no row", "no row"],
      });
    }, 30_000);

    it.skipIf(skip)("inside a savepoint, A goes on: its savepoint and its commit are refused, and B's flight is untouched", async () => {
      const idA = fresh();
      let wrote = "not sent";
      let inner = "not answered";
      const seen = await scene("bound", async (t, idle) => {
        await ins(t, idA, "A before");
        inner = await outcome(t.transaction(async (sp) => {
          const s = sp as unknown as Tx;
          await ins(s, idA + 1, "A in its savepoint");
          await idle((await mine(s)).pid);
          wrote = await outcome(ins(s, idA + 2, "A after, in its savepoint"));
        }));
      });
      const aRows = [await standing(idA), await standing(idA + 1), await standing(idA + 2)];
      expect({ ...seen, wrote, inner, aRows }).toEqual({
        ...UNTOUCHED("B"), a: "Error:CONNECTION_CLOSED", wrote: "Error:CONNECTION_CLOSED", inner: "Error:CONNECTION_CLOSED",
        aRows: ["no row", "no row", "no row"],
      });
    }, 30_000);

    it.skipIf(skip)("inside a savepoint, A gives up and swallows it: its rollback to the savepoint is not written on B's connection", async () => {
      const idA = fresh();
      let inner = "not answered";
      const seen = await scene("bound", async (t, idle) => {
        await ins(t, idA, "A before");
        inner = await outcome(t.transaction(async (sp) => {
          const s = sp as unknown as Tx;
          await ins(s, idA + 1, "A in its savepoint");
          await idle((await mine(s)).pid);
          throw new Error("A's savepoint gives up");
        }));
      });
      const aRows = [await standing(idA), await standing(idA + 1)];
      expect({ ...seen, inner, aRows }).toEqual({
        ...UNTOUCHED("B"), a: "Error:CONNECTION_CLOSED", inner: "Error:CONNECTION_CLOSED", aRows: ["no row", "no row"],
      });
    }, 30_000);

    it.skipIf(skip)("A opens a savepoint after its connection closed: the savepoint is refused and its callback never runs", async () => {
      const idA = fresh();
      let ran = false;
      let inner = "not answered";
      const seen = await scene("bound", async (t, idle) => {
        await ins(t, idA, "A before");
        await idle((await mine(t)).pid);
        inner = await outcome(t.transaction(async (sp) => {
          ran = true;
          await ins(sp as unknown as Tx, idA + 1, "A in a savepoint opened late");
        }));
      });
      expect({ ...seen, ran, inner, aRows: [await standing(idA), await standing(idA + 1)] }).toEqual({
        ...UNTOUCHED("B"), a: "Error:CONNECTION_CLOSED", ran: false, inner: "Error:CONNECTION_CLOSED", aRows: ["no row", "no row"],
      });
    }, 30_000);

    it.skipIf(skip)("a statement parked behind one in flight when the connection closed is never written; what A sends next is refused", async () => {
      const idA = fresh();
      const inside: Record<string, string> = {};
      const fresher = randomUUID();
      const seen = await scene("bound", async (t, idle) => {
        const { pid } = await mine(t);
        // A statement with a parameter and a text the connection has not seen keeps the connection full (a describe on
        // a session pool, the one-flush hold on a pooled one), so the next one waits in the transaction's own queue.
        const slow = outcome(t.execute(sql`insert into tf_begin_own (id, acct, note, tx)
          select ${idA}, current_setting('ohmail.account', true), ${"A slow"}, txid_current()::text from pg_sleep(${0.6}) ${sql.raw(`/* ${fresher} */`)}`));
        const parked = outcome(ins(t, idA + 1, "A parked"));
        await idle(pid);
        inside.slow = String(await within(slow, 3_000));
        inside.parked = String(await within(parked, 500));
        inside.after = await outcome(ins(t, idA + 2, "A after"));
      }, 200);
      const aRows = [await standing(idA), await standing(idA + 1), await standing(idA + 2)];
      expect(["NEVER", "Error:CONNECTION_CLOSED"], `the parked statement read ${inside.parked}`).toContain(inside.parked);
      expect({ ...seen, slow: inside.slow, after: inside.after, aRows }).toEqual({
        ...UNTOUCHED("B"), a: "Error:CONNECTION_CLOSED", slow: "Error:CONNECTION_CLOSED", after: "Error:CONNECTION_CLOSED",
        aRows: ["no row", "no row", "no row"],
      });
    }, 30_000);
  });
});

describe.skipIf(!PG_UP)("a statement sent on a plain transaction's handle after the transaction ended", () => {
  const admin = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
  let nextId = Math.floor(Math.random() * 1e6) * 100 + 7;
  const fresh = (): number => (nextId += 10);
  const ins = (t: Tx, id: number, note: string) =>
    t.execute(sql`insert into tf_begin_late (id, acct, note, tx) values (${id}, current_setting('ohmail.account', true), ${note}, txid_current()::text)`);
  const mine = (t: Tx): Promise<Reading> =>
    t.execute(sql`select current_setting('ohmail.account', true) as a, pg_backend_pid() as pid, now()::text as at, txid_current()::text as tx`)
      .then((x) => { const r = rowsOf(x)[0]; return { a: who(r?.a), pid: Number(r?.pid), at: String(r?.at), tx: String(r?.tx) }; });
  const standing = async (id: number): Promise<string> => {
    const [row] = await admin`select acct from tf_begin_late where id = ${id}`;
    return row === undefined ? "no row" : who(row.acct);
  };
  const txOf = async (id: number): Promise<string> => String((await admin`select tx from tf_begin_late where id = ${id}`)[0]?.tx);

  beforeAll(async () => { await admin`create table if not exists tf_begin_late (id int primary key, acct text, note text, tx text)`; });
  afterAll(async () => {
    await admin`drop table if exists tf_begin_late`.catch(() => undefined);
    await admin.end({ timeout: 5 });
    await closePooledDbs();
  });

  describe.each(HANDLES)("on $kind", ({ slug, at, self }) => {
    const skip = at !== null && !POOLER_UP;
    let owned: OwnedDb | null = null;
    let db: object;
    beforeAll(() => {
      if (skip) return;
      if (self) db = (owned = makeOwnedDb(named(`tf-begin-late-${slug}`), { role: "api" })).db;
      else db = makePooledDb(named(`tf-begin-late-${slug}`, at), { max: 1, acquireTimeoutMs: 8_000 });
    });
    afterAll(async () => { await owned?.close(); });

    /** The self-hosted pool's other four connections, held by plain transactions until let go. */
    const hold = async (n: number) => {
      const go = gate();
      const began: Array<Promise<void>> = [];
      const done = Array.from({ length: n }, () => {
        const g = gate();
        began.push(g.promise);
        return (db as Tx).transaction(async () => { g.open(); await go.promise; }).catch(() => undefined);
      });
      await Promise.all(began);
      return async () => { go.open(); await Promise.all(done); };
    };

    /**
     * A plain transaction writes a row and commits; its handle is kept. `next` then holds the same connection
     * (B's bound flight, a plain transaction, or nobody) while the kept handle reads and writes once more.
     */
    const lateScene = async (next: "bound" | "plain" | "nobody") => {
      const letGo = self ? await hold(4) : null;
      const plain = db as Tx;
      const idA = fresh();
      const idB = fresh();
      const kept: { t: Tx | null } = { t: null };
      const out = await within(outcome(plain.transaction(async (tx) => {
        const t = tx as unknown as Tx;
        await ins(t, idA, "A");
        kept.t = t;
      })), 6_000);
      const began = gate<Reading>();
      const goB = gate();
      let second: Reading | string = "not read";
      let lateB = "not sent";
      const other = next === "bound" ? bindDb(db, { account: B }) as unknown as Tx : plain;
      const outB = next === "nobody" ? null : outcome(other.transaction(async (tx) => {
        const t = tx as unknown as Tx;
        await ins(t, idB, "B first");
        began.open(await mine(t));
        await goB.promise;
        second = await mine(t).catch(tagOf);
        lateB = await outcome(ins(t, idB + 1, "B second"));
      }));
      const first = outB === null ? null : await within(began.promise, 6_000);
      if (outB === null) await pause(30);
      const lateRead = await within(mine(kept.t!).then((x) => `read ${x.a}`, tagOf), 3_000);
      const lateWrote = await within(outcome(ins(kept.t!, idA + 1, "A late")), 3_000);
      goB.open();
      const b = outB === null ? null : await within(outB, 6_000);
      await letGo?.();
      const expectB = next === "bound" ? "B" : "none";
      const s = second as Reading | string;
      return {
        out, lateRead, lateWrote, aRows: [await standing(idA), await standing(idA + 1)],
        ...(outB === null ? {} : {
          b, lateB,
          bOwn: first !== null && first !== "NEVER" && typeof s === "object"
            && first.a === expectB && s.a === expectB && first.pid === s.pid && first.at === s.at && first.tx === s.tx,
          bRows: [await standing(idB), await standing(idB + 1)],
          bOneTx: (await txOf(idB)) === (await txOf(idB + 1)),
        }),
      };
    };
    const REFUSED = { out: "ok", lateRead: "Error:CONNECTION_CLOSED", lateWrote: "Error:CONNECTION_CLOSED", aRows: ["none", "no row"] };

    it.skipIf(skip)("with nobody on the connection: refused, and nothing is written", async () => {
      expect(await lateScene("nobody")).toEqual(REFUSED);
    }, 30_000);

    it.skipIf(skip)("while B's bound flight holds the connection: refused, and B's rows, binding and commit stay its own", async () => {
      expect(await lateScene("bound")).toEqual({ ...REFUSED, b: "ok", lateB: "ok", bOwn: true, bRows: ["B", "B"], bOneTx: true });
    }, 30_000);

    it.skipIf(skip)("while another plain transaction holds the connection: refused, and that transaction is untouched", async () => {
      expect(await lateScene("plain")).toEqual({ ...REFUSED, b: "ok", lateB: "ok", bOwn: true, bRows: ["none", "none"], bOneTx: true });
    }, 30_000);
  });
});

/**
 * THE WINDOW BETWEEN THE CALLBACK'S END AND THE ANSWER TO THE DRIVER'S OWN COMMIT OR ROLLBACK. The connection is still
 * the transaction's reservation until that answer comes, so a statement handed on the handle in between was written
 * behind the commit or the rollback and ran after it, alone, outside the transaction: after a rollback too. Each scene
 * here holds the answer on the server, so the window is certain: the commit waits on a lock this test holds, taken by a
 * deferred trigger at commit; the rollback stands behind a statement of A's waiting on that lock. The test sees A's
 * backend waiting in pg_stat_activity before anything is handed.
 */
describe.skipIf(!PG_UP)("a statement handed after the callback ended and before the answer to the driver's own commit or rollback", () => {
  const admin = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
  /** The advisory lock's first key; its second is the id of A's row held at its commit (`key` in a scene). */
  const HOLD = 7_311;
  /** The note of a row whose insert makes its transaction's commit wait on that lock. */
  const HELD = "held at its commit";
  let nextId = Math.floor(Math.random() * 1e6) * 100 + 3;
  const fresh = (): number => (nextId += 10);
  const ins = (t: Tx, id: number, note: string) =>
    t.execute(sql`insert into tf_begin_window (id, acct, note, tx) values (${id}, current_setting('ohmail.account', true), ${note}, txid_current()::text)`);
  const pidOf = (t: Tx): Promise<number> => t.execute(sql`select pg_backend_pid() as pid`).then((x) => Number(rowsOf(x)[0]?.pid));
  const standing = async (id: number): Promise<string> => {
    const [row] = await admin`select acct from tf_begin_window where id = ${id}`;
    return row === undefined ? "no row" : who(row.acct);
  };
  const txOf = async (id: number): Promise<string> => String((await admin`select tx from tf_begin_window where id = ${id}`)[0]?.tx);
  /** A's backend seen waiting on the lock, running `what`: its commit, or the statement ahead of its rollback. */
  const waitingOn = async (pid: number, what: RegExp): Promise<string> => {
    for (let i = 0; i < 300; i++) {
      const [row] = await admin`select wait_event_type as t, wait_event as e, query as q from pg_stat_activity where pid = ${pid}`;
      if (row?.t === "Lock" && row.e === "advisory" && what.test(String(row.q))) return "waiting";
      await pause(10);
    }
    return "never seen waiting";
  };

  beforeAll(async () => {
    await admin`create table if not exists tf_begin_window (id int primary key, acct text, note text, tx text)`;
    await admin.unsafe(`create or replace function tf_begin_window_hold() returns trigger language plpgsql
      as $$ begin perform pg_advisory_xact_lock(${HOLD}, new.id); return null; end $$`);
    await admin.unsafe("drop trigger if exists tf_begin_window_hold on tf_begin_window");
    await admin.unsafe(`create constraint trigger tf_begin_window_hold after insert on tf_begin_window
      deferrable initially deferred for each row when (new.note = '${HELD}') execute function tf_begin_window_hold()`);
  });
  afterAll(async () => {
    await admin`drop table if exists tf_begin_window`.catch(() => undefined);
    await admin`drop function if exists tf_begin_window_hold()`.catch(() => undefined);
    await admin.end({ timeout: 5 });
    await closePooledDbs();
  });

  describe.each(HANDLES)("on $kind", ({ slug, at, self }) => {
    const skip = at !== null && !POOLER_UP;
    let owned: OwnedDb | null = null;
    let db: object;
    beforeAll(() => {
      if (skip) return;
      if (self) db = (owned = makeOwnedDb(named(`tf-begin-window-${slug}`), { role: "api" })).db;
      else db = makePooledDb(named(`tf-begin-window-${slug}`, at), { max: 1, acquireTimeoutMs: 8_000 });
    });
    afterAll(async () => { await owned?.close(); });

    /**
     * A writes its row and, returning, a row its commit waits on; giving up, it leaves a statement waiting on the lock
     * ahead of its rollback. Once its backend is seen waiting, a statement is handed: on the handle kept from the
     * callback, or by a sibling the callback did not await, let go then. Then the lock is let go and A is answered.
     */
    const scene = async (givesUp: boolean, by: "the kept handle" | "a sibling") => {
      const plain = db as Tx;
      const idA = fresh();
      const key = idA + 1;
      const kept: { t: Tx | null } = { t: null };
      const started = gate<number>();
      const goSibling = gate();
      let sibling: Promise<string> = Promise.resolve("not sent");
      await admin`select pg_advisory_lock(${HOLD}, ${key})`;
      try {
        const outA = outcome(plain.transaction(async (tx) => {
          const t = tx as unknown as Tx;
          const pid = await pidOf(t);
          await ins(t, idA, "A");
          kept.t = t;
          if (by === "a sibling") sibling = (async () => { await goSibling.promise; return told(ins(t, idA + 2, "A's sibling, in the window")); })();
          if (!givesUp) {
            await ins(t, key, HELD);
            started.open(pid);
            return;
          }
          void t.execute(sql.raw(`select pg_advisory_xact_lock(${HOLD}, ${key})`)).catch(() => undefined);
          await pause(20);   // handed and written inside the live transaction before A gives up
          started.open(pid);
          throw new Error("A gives up");
        }));
        const pid = await within(started.promise, 6_000);
        if (pid === "NEVER") return { a: await within(outA, 100), never: "A never wrote its rows" };
        const waiting = await waitingOn(pid, givesUp ? /pg_advisory_xact_lock/ : /^\s*commit\s*$/i);
        await pause(30);   // A's commit or rollback was handed in the microtasks after its callback ended
        let late: Promise<string>;
        if (by === "a sibling") { goSibling.open(); await pause(0); late = sibling; } else late = told(ins(kept.t!, idA + 2, "A in the window"));
        // Refused, it is answered at once; written, it waits behind the answer the lock holds.
        const before = await within(late, 1_000);
        await admin`select pg_advisory_unlock(${HOLD}, ${key})`;
        const a = await within(outA, 6_000);
        const after = await within(late, 3_000);
        await pause(150);
        const rows = givesUp ? [await standing(idA), await standing(idA + 2)] : [await standing(idA), await standing(key), await standing(idA + 2)];
        return {
          waiting, a, late: { before, after }, rows,
          ...(givesUp ? {} : { aOneTx: (await txOf(idA)) === (await txOf(key)) }),
          next: await within(outcome(plain.execute(sql`select ${1}::int`)), 6_000),
        };
      } finally {
        await admin`select pg_advisory_unlock_all()`;
      }
    };

    it.skipIf(skip)("after the callback returned, before its commit's answer: a statement on the kept handle is refused unwritten, and A's commit stands whole", async () => {
      expect(await scene(false, "the kept handle")).toEqual({
        waiting: "waiting", a: "ok", late: { before: "refused", after: "refused" }, rows: ["none", "none", "no row"], aOneTx: true, next: "ok",
      });
    }, 30_000);

    it.skipIf(skip)("after the callback gave up, before its rollback's answer: a statement on the kept handle is refused unwritten, and nothing of A stands", async () => {
      expect(await scene(true, "the kept handle")).toEqual({
        waiting: "waiting", a: "Error:", late: { before: "refused", after: "refused" }, rows: ["no row", "no row"], next: "ok",
      });
    }, 30_000);

    it.skipIf(skip)("a sibling the callback did not await sends in its commit's window: refused unwritten, and A's rows stand as committed", async () => {
      expect(await scene(false, "a sibling")).toEqual({
        waiting: "waiting", a: "ok", late: { before: "refused", after: "refused" }, rows: ["none", "none", "no row"], aOneTx: true, next: "ok",
      });
    }, 30_000);

    it.skipIf(skip)("a sibling the callback did not await sends in its rollback's window: refused unwritten, and nothing of A stands", async () => {
      expect(await scene(true, "a sibling")).toEqual({
        waiting: "waiting", a: "Error:", late: { before: "refused", after: "refused" }, rows: ["no row", "no row"], next: "ok",
      });
    }, 30_000);
  });
});

/**
 * THE DRIVER'S OWN STATEMENTS STILL PASS. The window's refusal lets through the one statement the driver hands to close
 * the transaction; every statement of a live transaction passes as before. Each close here is shown written by its
 * effect: the rows it keeps or removes, the backend idle again, the connection serving the next caller. A pool of two
 * where a transaction opens another of its own on it.
 */
describe.skipIf(!PG_UP)("the driver's own statements of a transaction are still written", () => {
  const admin = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
  let nextId = Math.floor(Math.random() * 1e6) * 100 + 9;
  const fresh = (): number => (nextId += 10);
  const ins = (t: Tx, id: number, note: string) =>
    t.execute(sql`insert into tf_begin_close (id, acct, note, tx) values (${id}, current_setting('ohmail.account', true), ${note}, txid_current()::text)`);
  const pidOf = (t: Tx): Promise<number> => t.execute(sql`select pg_backend_pid() as pid`).then((x) => Number(rowsOf(x)[0]?.pid));
  const standing = async (id: number): Promise<string> => {
    const [row] = await admin`select acct from tf_begin_close where id = ${id}`;
    return row === undefined ? "no row" : who(row.acct);
  };
  const txOf = async (id: number): Promise<string> => String((await admin`select tx from tf_begin_close where id = ${id}`)[0]?.tx);
  /** The backend's state once its transaction was answered: `idle`, never `idle in transaction`. */
  const stateOf = async (pid: number): Promise<string> => String((await admin`select state from pg_stat_activity where pid = ${pid}`)[0]?.state ?? "gone");

  beforeAll(async () => { await admin`create table if not exists tf_begin_close (id int primary key, acct text, note text, tx text)`; });
  afterAll(async () => {
    await admin`drop table if exists tf_begin_close`.catch(() => undefined);
    await admin.end({ timeout: 5 });
    await closePooledDbs();
  });

  describe.each(HANDLES)("on $kind", ({ slug, at, self }) => {
    const skip = at !== null && !POOLER_UP;
    let owned: OwnedDb | null = null;
    let db: object;
    beforeAll(() => {
      if (skip) return;
      if (self) db = (owned = makeOwnedDb(named(`tf-begin-close-${slug}`), { role: "api" })).db;
      else db = makePooledDb(named(`tf-begin-close-${slug}`, at), { max: 2, acquireTimeoutMs: 8_000 });
    });
    afterAll(async () => { await owned?.close(); });
    const next = (): Promise<string | "NEVER"> => within(outcome((db as Tx).execute(sql`select ${1}::int`)), 6_000);

    /** A runs `body` and is answered; what its rows, its backend and the next caller read then. */
    const run = async (ids: number[], body: (t: Tx) => Promise<void>) => {
      let pid = 0;
      const a = await within(outcome((db as Tx).transaction(async (tx) => {
        const t = tx as unknown as Tx;
        pid = await pidOf(t);
        await body(t);
      })), 8_000);
      return { a, rows: await Promise.all(ids.map(standing)), backend: await stateOf(pid), next: await next() };
    };

    it.skipIf(skip)("its commit: written; A's rows stand in one transaction and its backend is idle again", async () => {
      const idA = fresh();
      const seen = await run([idA, idA + 1], async (t) => { await ins(t, idA, "A"); await ins(t, idA + 1, "A"); });
      expect({ ...seen, oneTx: (await txOf(idA)) === (await txOf(idA + 1)) })
        .toEqual({ a: "ok", rows: ["none", "none"], backend: "idle", next: "ok", oneTx: true });
    }, 30_000);

    it.skipIf(skip)("its rollback: written; nothing of A stands, its caller reads its own error, and its backend is idle again", async () => {
      const idA = fresh();
      const seen = await run([idA], async (t) => { await ins(t, idA, "A"); throw new Error("A gives up"); });
      expect(seen).toEqual({ a: "Error:", rows: ["no row"], backend: "idle", next: "ok" });
    }, 30_000);

    it.skipIf(skip)("a nested transaction that ends well (its savepoint, which the driver closes with nothing): its rows commit with A's", async () => {
      const idA = fresh();
      let inner = "not answered";
      const seen = await run([idA, idA + 1, idA + 2], async (t) => {
        await ins(t, idA, "A");
        inner = await outcome(t.transaction(async (sp) => { await ins(sp as unknown as Tx, idA + 1, "A's savepoint"); }));
        await ins(t, idA + 2, "A after its savepoint");
      });
      expect({ ...seen, inner, oneTx: (await txOf(idA)) === (await txOf(idA + 1)) && (await txOf(idA)) === (await txOf(idA + 2)) })
        .toEqual({ a: "ok", rows: ["none", "none", "none"], backend: "idle", next: "ok", inner: "ok", oneTx: true });
    }, 30_000);

    it.skipIf(skip)("a nested transaction that fails, swallowed: its rollback to the savepoint is written, its rows are gone and A commits after it", async () => {
      const idA = fresh();
      let inner = "not answered";
      const seen = await run([idA, idA + 1, idA + 2], async (t) => {
        await ins(t, idA, "A");
        // A failed statement leaves the transaction aborted until the driver's `rollback to` is written.
        inner = await outcome(t.transaction(async (sp) => { await ins(sp as unknown as Tx, idA + 1, "A's savepoint"); await ins(sp as unknown as Tx, idA, "a duplicate"); }));
        await ins(t, idA + 2, "A after its savepoint");
      });
      expect({ ...seen, inner }).toEqual({ a: "ok", rows: ["none", "no row", "none"], backend: "idle", next: "ok", inner: "PostgresError:23505" });
    }, 30_000);

    it.skipIf(skip)("savepoint statements written by hand inside the live transaction: a release and a rollback to are written", async () => {
      const idA = fresh();
      const seen = await run([idA, idA + 1, idA + 2, idA + 3], async (t) => {
        await ins(t, idA, "A");
        await t.execute(sql.raw("savepoint tf_by_hand"));
        await ins(t, idA + 1, "A, released");
        await t.execute(sql.raw("release savepoint tf_by_hand"));
        await t.execute(sql.raw("savepoint tf_by_hand_2"));
        await ins(t, idA + 2, "A, rolled back to its savepoint");
        await t.execute(sql.raw("rollback to savepoint tf_by_hand_2"));
        await ins(t, idA + 3, "A after");
      });
      expect(seen).toEqual({ a: "ok", rows: ["none", "none", "no row", "none"], backend: "idle", next: "ok" });
    }, 30_000);

    // Through the bench pooler (one server connection) a transaction opened inside another waits for ever for a connection.
    it.skipIf(skip || at !== null)("a transaction of its own on the pool, inside A's callback: its commit and its rollback are written, and A's commit after them", async () => {
      const idA = fresh();
      const inner: string[] = [];
      const seen = await run([idA, idA + 1, idA + 2, idA + 3], async (t) => {
        await ins(t, idA, "A");
        inner.push(await outcome((db as Tx).transaction(async (tx2) => { await ins(tx2 as unknown as Tx, idA + 1, "its own, commits"); })));
        inner.push(await outcome((db as Tx).transaction(async (tx2) => { await ins(tx2 as unknown as Tx, idA + 2, "its own, gives up"); throw new Error("it gives up"); })));
        await ins(t, idA + 3, "A after");
      });
      expect({ ...seen, inner, aOneTx: (await txOf(idA)) === (await txOf(idA + 3)), innerOwn: (await txOf(idA)) !== (await txOf(idA + 1)) })
        .toEqual({ a: "ok", rows: ["none", "none", "no row", "none"], backend: "idle", next: "ok", inner: ["ok", "Error:"], aOneTx: true, innerOwn: true });
    }, 30_000);

    it.skipIf(skip)("a sibling handed in any microtask after the callback returns or gives up: A's own commit or rollback is written, and the sibling stands inside A or is refused, never alone", async () => {
      const bad: string[] = [];
      const refusedAt: string[] = [];
      for (const givesUp of [false, true]) {
        for (let depth = 0; depth <= 16; depth++) {
          const idA = fresh();
          let sibling: Promise<string> = Promise.resolve("not sent");
          const a = await within(outcome((db as Tx).transaction(async (tx) => {
            const t = tx as unknown as Tx;
            await ins(t, idA, "A");
            let n = depth;
            const hand = (): void => {
              if (n-- > 0) { queueMicrotask(hand); return; }
              sibling = told(ins(t, idA + 1, "A's sibling"));
            };
            queueMicrotask(hand);
            if (givesUp) throw new Error("A gives up");
          })), 6_000);
          const s = await within(sibling, 2_000);
          const n2 = await next();
          await pause(20);
          const row = (await standing(idA + 1)) === "no row" ? "no row" : (await txOf(idA + 1)) === (await txOf(idA)) ? "inside A" : "alone";
          const close = givesUp ? "rollback" : "commit";
          const own = givesUp ? a === "Error:" : a === "ok";
          const sib = (s === "refused" && row === "no row") || (s === "ok" && row === (givesUp ? "no row" : "inside A"));
          if (!own || !sib || n2 !== "ok") bad.push(`${close}, sibling ${depth} microtasks on: A ${String(a)}, sibling ${String(s)} (${row}), next ${String(n2)}`);
          if (s === "refused") refusedAt.push(`${close} ${depth}`);
          if (n2 !== "ok") break;   // the connection is held: what follows would only wait
        }
      }
      expect({ bad, windowReached: ["commit", "rollback"].map((c) => refusedAt.some((x) => x.startsWith(c))) })
        .toEqual({ bad: [], windowReached: [true, true] });
    }, 120_000);
  });
});

/**
 * ONE HUNDRED ROUNDS ON A POOL OF TWO. Each round a plain transaction A (it goes on, gives up, goes on or gives up
 * inside a savepoint, leaves statements floating at its commit, or leaves one to be sent after it) has its backend
 * ended at a step drawn at random, while B's bound flight, a plain transaction C and a lone plain statement E run
 * beside it and take the connection the pool dials again. Every row stores the binding the server held as it was
 * written and the transaction it was written in.
 */
describe.skipIf(!PG_UP)("one hundred rounds on a pool of two, plain and bound work mixed, one connection ended each round", () => {
  const admin = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
  const ROUNDS = 100;

  beforeAll(async () => {
    await admin`drop table if exists tf_begin_rounds`;
    await admin`create table tf_begin_rounds (who text not null, acct text, kind text not null, round int not null, part int not null, tx text)`;
  });
  afterAll(async () => {
    await admin`drop table if exists tf_begin_rounds`.catch(() => undefined);
    await admin.end({ timeout: 5 });
    await closePooledDbs();
  });

  for (const { kind, slug, at, self } of [
    { kind: "the pooled cell", slug: "pooled", at: null as string | null, self: false },
    { kind: "a session pool (the roster's cell)", slug: "session", at: null as string | null, self: true },
    { kind: "the pooled cell through a transaction pooler", slug: "pooler", at: POOLER as string | null, self: false },
  ]) it.skipIf(at !== null && !POOLER_UP)(`on ${kind}: no row under another binding, no other transaction committed early or rolled back, nothing of A stands`, async () => {
    const owned = self ? makeOwnedDb(named("tf-begin-rounds-own"), { role: "roster" }) : null;
    const handle = owned?.db ?? makePooledDb(named(`tf-begin-rounds-${slug}`, at), { max: 2, acquireTimeoutMs: 10_000 });
    const two = handle as unknown as Tx;
    const b = bindDb(handle, { account: B }) as unknown as Tx;
    const ins = (t: Tx, w: string, r: number, part: number) =>
      t.execute(sql`insert into tf_begin_rounds (who, acct, kind, round, part, tx) values (${w}, current_setting('ohmail.account', true), ${slug}, ${r}, ${part}, txid_current()::text)`);
    const mine = (t: Tx) => t.execute(sql`select current_setting('ohmail.account', true) as a, pg_backend_pid() as pid, now()::text as at, txid_current()::text as tx`)
      .then((x) => rowsOf(x)[0] as { a: unknown; pid: unknown; at: unknown; tx: unknown });
    const rand = seeded(0xb3e1 + (self ? 1 : 0) + (at === null ? 0 : 2));
    const outA: string[] = [];
    const lates: string[] = [];
    const failed: string[] = [];
    const wrong: string[] = [];
    /** A transaction that must be whole: one binding, one backend, one transaction, two rows, a commit of its own. */
    const whole = (view: Tx, w: string, acct: string, r: number, pauseMs: number) => view.transaction(async (tx) => {
      const t = tx as unknown as Tx;
      const first = await mine(t);
      await ins(t, w, r, 1);
      await pause(pauseMs);
      const second = await mine(t);
      await ins(t, w, r, 2);
      if (who(first.a) !== acct || who(second.a) !== acct || first.pid !== second.pid || first.at !== second.at || first.tx !== second.tx) wrong.push(`${w} round ${r}`);
    }).catch((e: unknown) => { failed.push(`${w} round ${r}: ${tagOf(e)}`); });
    try {
      for (let r = 0; r < ROUNDS; r++) {
        const [step, pauseB, pauseC, pauseKill] = [rand(3), rand(40), rand(40), rand(70)];
        const shape = r % 6;
        const idled = gate<number>();
        const goA = gate();
        /** A waits at step `i` when it is the round's: its backend is ended there. */
        const stop = async (i: number, pid: unknown): Promise<void> => { if (i === step) { idled.open(Number(pid)); await goA.promise; } };
        let late: Promise<string> = Promise.resolve("not sent");
        const flightA = two.transaction(async (tx) => {
          const t = tx as unknown as Tx;
          const { pid } = await mine(t);
          if (shape === 0) {          // goes on
            await stop(0, pid); await ins(t, "A", r, 1);
            await stop(1, pid); await mine(t); await ins(t, "A", r, 2);
            await stop(2, pid);
          } else if (shape === 1) {   // gives up: its rollback
            await stop(0, pid); await ins(t, "A", r, 1).catch(() => undefined);
            await stop(1, pid); await ins(t, "A", r, 2).catch(() => undefined);
            await stop(2, pid);
            throw new Error("A gives up");
          } else if (shape === 2) {   // goes on inside a savepoint
            await stop(0, pid); await ins(t, "A", r, 1);
            await t.transaction(async (sp) => {
              await stop(1, pid); await ins(sp as unknown as Tx, "A", r, 2);
              await stop(2, pid);
            });
          } else if (shape === 3) {   // its savepoint gives up, swallowed: rollback to, then the commit
            await stop(0, pid); await ins(t, "A", r, 1).catch(() => undefined);
            await t.transaction(async (sp) => {
              await stop(1, pid); await ins(sp as unknown as Tx, "A", r, 2).catch(() => undefined);
              await stop(2, pid);
              throw new Error("A's savepoint gives up");
            }).catch(() => undefined);
          } else if (shape === 4) {   // floating statements and the commit in one tick
            await stop(0, pid); await ins(t, "A", r, 1).catch(() => undefined);
            await stop(1, pid);
            await stop(2, pid);
            void ins(t, "A", r, 2).catch(() => undefined);
            void ins(t, "A", r, 3).catch(() => undefined);
            void mine(t).catch(() => undefined);
          } else {                    // leaves a statement to be sent after it returned
            await stop(0, pid); await ins(t, "A", r, 1).catch(() => undefined);
            await stop(1, pid);
            await stop(2, pid);
            setTimeout(() => { late = outcome(ins(t, "A", r, 4)); }, 20);
          }
        });
        const jobs: Array<Promise<unknown>> = [
          outcome(flightA).then((o) => { if (o === "ok") outA.push(`round ${r} (shape ${shape}, step ${step}): ok`); }),
          whole(b, "B", "B", r, pauseB),
          whole(two, "C", "none", r, pauseC),
          ins(two, "E", r, 1).then(() => undefined, (e: unknown) => { failed.push(`E lone round ${r}: ${tagOf(e)}`); }),
        ];
        const pid = await within(idled.promise, 12_000);
        if (pid === "NEVER") { failed.push(`round ${r}: A never reached its step`); break; }
        await admin`select pg_terminate_backend(${pid})`;
        await pause(pauseKill);
        goA.open();
        if (await within(Promise.all(jobs), 20_000) === "NEVER") { failed.push(`round ${r} never finished`); break; }
        if (shape === 5) {
          await pause(40);
          const o = await within(late, 3_000);
          if (o === "ok" || o === "not sent") lates.push(`round ${r} (step ${step}): ${o}`);
        }
      }
      await pause(300);
      const rows = await admin`select who, coalesce(acct, '') as acct, count(*)::int as n, count(distinct (round, tx))::int as txs
        from tf_begin_rounds where kind = ${slug} group by 1, 2 order by 1, 2`;
      const per = Object.fromEntries(rows.map((x) => [`${String(x.who)} as ${who(x.acct)}`, `${String(x.n)} rows in ${String(x.txs)} transactions`]));
      expect({ failed, wrong, outA, lates, per }).toEqual({
        failed: [], wrong: [], outA: [], lates: [],
        per: {
          "B as B": `${2 * ROUNDS} rows in ${ROUNDS} transactions`,
          "C as none": `${2 * ROUNDS} rows in ${ROUNDS} transactions`,
          "E as none": `${ROUNDS} rows in ${ROUNDS} transactions`,
        },
      });
    } finally {
      await owned?.close();
    }
  }, 280_000);
});

/**
 * TWO HUNDRED ROUNDS ON A POOL OF TWO, BACKENDS ENDED AT RANDOM (the review's). Each round a plain transaction A in one
 * of eleven shapes runs beside bound flights B and D, a plain transaction C and lone statements E (plain) and F (bound),
 * and none, one or two of the pool's backends are ended at random moments. Two of A's shapes hand a statement in the
 * window of its commit or of its rollback. Every row stores the binding the server held as it was written and its
 * transaction. Read at the end, per transaction: its rows under its own binding only, all of them or none, all of them
 * when its caller was told ok, none when it gave up; nothing A handed in its window or after its answer stands.
 */
describe.skipIf(!PG_UP)("two hundred rounds on a pool of two, plain and bound work mixed, backends ended at random", () => {
  const admin = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
  const ROUNDS = 200;

  beforeAll(async () => {
    await admin`drop table if exists tf_begin_random`;
    await admin`create table tf_begin_random (inst text not null, acct text, kind text not null, part int not null, tx text)`;
  });
  afterAll(async () => {
    await admin`drop table if exists tf_begin_random`.catch(() => undefined);
    await admin.end({ timeout: 5 });
    await closePooledDbs();
  });

  for (const { kind, slug, at, self } of [
    { kind: "the pooled cell", slug: "pooled", at: null as string | null, self: false },
    { kind: "a session pool (the roster's cell)", slug: "session", at: null as string | null, self: true },
    { kind: "the pooled cell through a transaction pooler", slug: "pooler", at: POOLER as string | null, self: false },
  ]) it.skipIf(at !== null && !POOLER_UP)(`on ${kind}: no write stands after its transaction rolled back, none outside it, none under another binding`, async () => {
    const app = `tf-begin-random-${slug}`;
    const owned = self ? makeOwnedDb(named(app), { role: "roster" }) : null;
    const handle = owned?.db ?? makePooledDb(named(app, at), { max: 2, acquireTimeoutMs: 10_000 });
    const plain = handle as unknown as Tx;
    const asB = bindDb(handle, { account: B }) as unknown as Tx;
    const asC = bindDb(handle, { account: C }) as unknown as Tx;
    const ins = (t: Tx, inst: string, part: number) =>
      t.execute(sql`insert into tf_begin_random (inst, acct, kind, part, tx) values (${inst}, current_setting('ohmail.account', true), ${slug}, ${part}, txid_current()::text)`);
    /** The backends this pool's work was last seen on: what a kill draws from. */
    const seenPids: number[] = [];
    const mine = (t: Tx) => t.execute(sql`select current_setting('ohmail.account', true) as a, pg_backend_pid() as pid, now()::text as at, txid_current()::text as tx`)
      .then((x) => { const row = rowsOf(x)[0] as { a: unknown; pid: unknown; at: unknown; tx: unknown }; seenPids.push(Number(row.pid)); return row; });
    const seed = 0x5eed + (self ? 7 : 0) + (at === null ? 0 : 13);
    const rand = seeded(seed);
    /** What each transaction must be: its binding, the parts that stand when it commits, whether it may commit at all. */
    const expected = new Map<string, { acct: string; parts: number[]; mayCommit: boolean }>();
    const outs = new Map<string, string>();
    /** Parts A handed after its caller was answered, and between its callback's end and that answer (its window). */
    const sentLate = new Set<string>();
    const sentInWindow = new Set<string>();
    const wrong: string[] = [];
    const never: string[] = [];
    let kills = 0;

    const whole = (view: Tx, inst: string, acct: string, pauseMs: number): Promise<void> => {
      expected.set(inst, { acct, parts: [1, 2], mayCommit: true });
      return outcome(view.transaction(async (tx) => {
        const t = tx as unknown as Tx;
        const first = await mine(t);
        await ins(t, inst, 1);
        await pause(pauseMs);
        const second = await mine(t);
        await ins(t, inst, 2);
        if (who(first.a) !== acct || who(second.a) !== acct || first.pid !== second.pid || first.at !== second.at || first.tx !== second.tx) wrong.push(inst);
      })).then((o) => { outs.set(inst, o); });
    };
    const lone = (view: Tx, inst: string, acct: string): Promise<void> => {
      expected.set(inst, { acct, parts: [1], mayCommit: true });
      return outcome(ins(view, inst, 1)).then((o) => { outs.set(inst, o); });
    };

    /** A in its round's shape; `p` its pauses, drawn at the round's start. */
    const flightA = (r: number, shape: number, p: number[]): Promise<void> => {
      const inst = `A#${r}`;
      let answered = false;
      let returned = false;
      const send = (t: Tx, part: number): Promise<unknown> => {
        if (answered) sentLate.add(`${inst}/${part}`);
        else if (returned) sentInWindow.add(`${inst}/${part}`);
        return ins(t, inst, part);
      };
      const spec = { acct: "none", parts: [1, 2], mayCommit: true };
      const run = plain.transaction(async (tx) => {
        const t = tx as unknown as Tx;
        try {
          await mine(t);
          if (shape === 0) {            // goes on
            await send(t, 1); await pause(p[0]!); await mine(t); await send(t, 2); await pause(p[1]!);
          } else if (shape === 1) {     // gives up: the driver's rollback
            spec.parts = []; spec.mayCommit = false;
            await send(t, 1).catch(() => undefined); await pause(p[0]!); await send(t, 2).catch(() => undefined); await pause(p[1]!);
            throw new Error("A gives up");
          } else if (shape === 2) {     // goes on inside a savepoint
            await send(t, 1);
            await t.transaction(async (sp) => { await pause(p[0]!); await send(sp as unknown as Tx, 2); await pause(p[1]!); });
          } else if (shape === 3) {     // its savepoint gives up, swallowed: rollback to, one more row, the commit
            spec.parts = [1, 3];
            await send(t, 1);
            await t.transaction(async (sp) => { await pause(p[0]!); await send(sp as unknown as Tx, 2); await pause(p[1]!); throw new Error("A's savepoint gives up"); })
              .catch(() => undefined);
            await send(t, 3);
          } else if (shape === 4) {     // floating statements and the commit in one tick
            spec.parts = [1, 2, 3];
            await send(t, 1); await pause(p[0]!);
            void send(t, 2).catch(() => undefined); void send(t, 3).catch(() => undefined); void mine(t).catch(() => undefined);
          } else if (shape === 5) {     // a statement left to be sent after the callback returned
            spec.parts = [1];
            await send(t, 1); await pause(p[0]!);
            setTimeout(() => { void send(t, 4).catch(() => undefined); }, 25 + p[6]!);
          } else if (shape === 6) {     // a transaction of its own on the pool, inside the callback
            await send(t, 1); await pause(p[1]!);
            expected.set(`AI#${r}`, { acct: "none", parts: [1, 2], mayCommit: true });
            outs.set(`AI#${r}`, await outcome(plain.transaction(async (tx2) => {
              const u = tx2 as unknown as Tx;
              await ins(u, `AI#${r}`, 1); await pause(p[2]!); await ins(u, `AI#${r}`, 2);
            })));
            await send(t, 2);
          } else if (shape === 7) {     // siblings, all well
            spec.parts = [1, 2, 3, 4, 5];
            await send(t, 1);
            const sib = async (part: number): Promise<void> => { await send(t, part); await pause(p[2]!); await send(t, part + 1); };
            await Promise.all([sib(2), sib(4)]);
          } else if (shape === 8) {     // siblings, one gives up while the other is at work
            spec.parts = []; spec.mayCommit = false;
            await send(t, 1);
            await Promise.all([
              (async () => { await pause(2 + p[3]!); throw new Error("a sibling gives up"); })(),
              (async () => { await send(t, 2); await pause(10 + p[4]!); await send(t, 3); await pause(10 + p[5]!); await send(t, 4); })().catch(() => undefined),
            ]);
          } else if (shape === 9) {     // a sibling sends in its commit's window
            await send(t, 1); await pause(p[0]!); await send(t, 2);
            setImmediate(() => { void send(t, 3).catch(() => undefined); });
          } else {                      // a sibling sends in its rollback's window
            spec.parts = []; spec.mayCommit = false;
            await send(t, 1); await pause(p[0]!);
            setImmediate(() => { void send(t, 2).catch(() => undefined); });
            throw new Error("A gives up");
          }
        } finally {
          returned = true;
        }
      });
      expected.set(inst, spec);
      return outcome(run).then((o) => { answered = true; outs.set(inst, o); });
    };

    const killOne = async (pick: number): Promise<void> => {
      const recent = [...new Set(seenPids.slice(-6))];
      if (recent.length === 0) return;
      // Only a backend of this database: a pid seen a moment ago is never another checkout's.
      const [row] = await admin`select pg_terminate_backend(pid) as done from pg_stat_activity
        where pid = ${recent[pick % recent.length]!} and datname = current_database()`;
      if (row?.done === true) kills++;
    };

    try {
      for (let r = 0; r < ROUNDS; r++) {
        // Every value of the round, drawn at its start in one order: the seed reproduces the run's draws.
        const [n, k1, k2, t1, t2, pB, pC, pD] = [rand(4), rand(28), rand(60), rand(1_000), rand(1_000), rand(30), rand(30), rand(30)];
        const pA = [rand(40), rand(20), rand(30), rand(10), rand(25), rand(25), rand(40)];
        const shape = at !== null && r % 11 === 6 ? 0 : r % 11;   // through the bench pooler's one connection a transaction inside another waits for ever
        const jobs: Array<Promise<unknown>> = [
          flightA(r, shape, pA),
          whole(asB, `B#${r}`, "B", pB),
          whole(plain, `C#${r}`, "none", pC),
          whole(asC, `D#${r}`, "C", pD),
          lone(plain, `E#${r}`, "none"),
          lone(asB, `F#${r}`, "B"),
        ];
        const killing: Array<Promise<void>> = [];
        if (n >= 1) killing.push(pause(k1).then(() => killOne(t1)));
        if (n === 3) killing.push(pause(k2).then(() => killOne(t2)));
        if (await within(Promise.all([...jobs, ...killing]), 25_000) === "NEVER") { never.push(`round ${r} never finished`); break; }
      }
      await pause(500);
      const rows = await admin`select inst, array_agg(distinct coalesce(acct, '')) as accts, array_agg(part order by part) as parts, count(distinct tx)::int as txs
        from tf_begin_random where kind = ${slug} group by 1`;
      const stood = new Map(rows.map((x) => [String(x.inst), { accts: (x.accts as unknown[]).map(who), parts: (x.parts as number[]).map(Number), txs: Number(x.txs) }]));
      const bad: string[] = [];
      for (const [inst, spec] of expected) {
        const o = outs.get(inst) ?? "NOT ANSWERED";
        const s = stood.get(inst) ?? { accts: [], parts: [], txs: 0 };
        const late = s.parts.filter((x) => sentLate.has(`${inst}/${x}`));
        const inWindow = s.parts.filter((x) => sentInWindow.has(`${inst}/${x}`));
        const parts = s.parts.filter((x) => !late.includes(x) && !inWindow.includes(x));
        if (late.length > 0) bad.push(`${inst}: parts ${late.join(",")} handed after its caller was answered stand (${o})`);
        if (inWindow.length > 0) bad.push(`${inst}: parts ${inWindow.join(",")} handed in its commit's or rollback's window stand (${o})`);
        if (o === "NOT ANSWERED") bad.push(`${inst}: never answered`);
        if (s.accts.some((a) => a !== spec.acct)) bad.push(`${inst}: a row under ${s.accts.join("+")}, its binding is ${spec.acct}`);
        if (parts.length > 0 && !spec.mayCommit) bad.push(`${inst}: parts ${parts.join(",")} stand, and it gave up (${o})`);
        if (parts.length > 0 && spec.mayCommit && parts.join(",") !== spec.parts.join(",")) bad.push(`${inst}: parts ${parts.join(",")} stand of ${spec.parts.join(",")} (${o})`);
        if (late.length + inWindow.length === 0 && s.txs > 1) bad.push(`${inst}: its rows stand in ${s.txs} transactions`);
        if (o === "ok" && spec.mayCommit && parts.join(",") !== spec.parts.join(",")) bad.push(`${inst}: answered ok, parts ${parts.join(",") || "none"} stand`);
        if (o === "ok" && !spec.mayCommit) bad.push(`${inst}: it gave up and was answered ok`);
      }
      for (const inst of stood.keys()) if (!expected.has(inst)) bad.push(`${inst}: rows of nobody`);
      const usable = [await within(outcome(plain.execute(sql`select ${1}::int`)), 8_000), await within(outcome(asB.execute(sql`select ${1}::int`)), 8_000)];
      expect({ bad, wrong, never, usable, windowHanded: sentInWindow.size > 0 }, `seed ${seed}, ${kills} backends ended`)
        .toEqual({ bad: [], wrong: [], never: [], usable: ["ok", "ok"], windowHanded: true });
    } finally {
      await owned?.close();
    }
  }, 280_000);
});
