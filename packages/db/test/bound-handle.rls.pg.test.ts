import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { bindDb, BINDING_READERS_SQL } from "../src/bound.js";
import { closePooledDbs, FlightClosedError, makeOwnedDb, makePooledDb, type OwnedDb } from "../src/client.js";
import { readFlightOf } from "../src/read-flight.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { rlsBench, type Bench, type BenchRole } from "./_rls-bench.js";

/**
 * THE BINDING HOLDS ON A SESSION POOL AND THROUGH A TRANSACTION POOLER. Signed in as a role this
 * file makes, which owns nothing and cannot bypass row security, on three tables of its own under
 * forced policies that read the binder's two settings through the readers the setup will run: one
 * by account, one by key, one admitted only while no account is bound. The same cases run on the
 * self-hosted server's session pool and through a transaction pooler of one backend shared by two
 * clients, where a value left on the session would reach the next client.
 *
 * The pooler is a named test service: `TF_POOLER_ADDRESS` (`host:port`) in front of the test
 * database, a pooler in transaction mode with one backend per role. `TF_REQUIRE_POOLER=1` makes its
 * absence a failure; without it the pooler half is skipped and says why.
 */
const PG_UP = await realPgAvailable();
const POOLER = (process.env.TF_POOLER_ADDRESS ?? "").trim();
const REQUIRE_POOLER = process.env.TF_REQUIRE_POOLER === "1";

/** Whether something accepts a connection at `host:port`. */
function listening(at: string): Promise<boolean> {
  const [host, port] = [at.slice(0, at.lastIndexOf(":")), Number(at.slice(at.lastIndexOf(":") + 1))];
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (up: boolean): void => { s.destroy(); resolve(up); };
    s.setTimeout(2_000, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

const POOLER_UP = POOLER !== "" && await listening(POOLER);
if (REQUIRE_POOLER && !POOLER_UP) {
  throw new Error("TF_REQUIRE_POOLER=1 but no transaction pooler answers at TF_POOLER_ADDRESS — start one in front of "
    + "the test database (transaction mode, one backend per role), or unset the variable");
}
if (!POOLER_UP) process.stderr.write("bound-handle.rls: no transaction pooler at TF_POOLER_ADDRESS; its half is skipped\n");

const A = randomUUID();
const B = randomUUID();

type Handle = ReturnType<typeof makePooledDb>;
type Tx = { transaction: <R>(fn: (tx: object) => Promise<R>) => Promise<R>; execute: (q: unknown) => Promise<unknown> };
const rows = (r: unknown): Array<Record<string, unknown>> => r as Array<Record<string, unknown>>;
const notes = (r: unknown): string[] => rows(r).map((x) => String(x.note)).sort();

describe.skipIf(!PG_UP)("the account's binding under forced policies (real Postgres)", () => {
  let admin: postgres.Sql;
  let bench: Bench;
  let role: BenchRole;
  let s = "";

  beforeAll(async () => {
    admin = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    bench = await rlsBench(admin, PG_TEST_URL);
    s = bench.schema;
    // The readers as the setup runs them, made in this file's own schema (the settings' names untouched).
    await admin.unsafe(BINDING_READERS_SQL
      .replace("create schema if not exists ohmail;", `create schema if not exists ${s};`)
      .replaceAll("function ohmail.", `function ${s}.`));
    await admin.unsafe(`create table ${s}.owned_rows (id serial primary key, account_id uuid not null, note text not null)`);
    await admin.unsafe(`create table ${s}.keyed_rows (id serial primary key, key text not null, note text not null)`);
    await admin.unsafe(`create table ${s}.staff_rows (id serial primary key, note text not null)`);
    await admin.unsafe(`insert into ${s}.owned_rows (account_id, note) values ('${A}', 'a1'), ('${A}', 'a2'), ('${B}', 'b1')`);
    await admin.unsafe(`insert into ${s}.keyed_rows (key, note) values ('k-one', 'one'), ('k-two', 'two')`);
    await admin.unsafe(`insert into ${s}.staff_rows (note) values ('staff')`);
    role = await bench.role();
    for (const t of ["owned_rows", "keyed_rows", "staff_rows"]) {
      await admin.unsafe(`alter table ${s}.${t} enable row level security`);
      await admin.unsafe(`alter table ${s}.${t} force row level security`);
      await admin.unsafe(`grant select, insert, update, delete on ${s}.${t} to ${role.name}`);
    }
    await admin.unsafe(`grant usage on all sequences in schema ${s} to ${role.name}`);
    await admin.unsafe(`create policy by_account on ${s}.owned_rows to ${role.name}
      using (account_id = ${s}.current_account()) with check (account_id = ${s}.current_account())`);
    await admin.unsafe(`create policy by_key on ${s}.keyed_rows for select to ${role.name} using (key = ${s}.current_key())`);
    await admin.unsafe(`create policy unbound_only on ${s}.staff_rows to ${role.name}
      using (${s}.current_account() is null) with check (${s}.current_account() is null)`);
  }, 60_000);

  afterAll(async () => {
    await closePooledDbs();
    await bench?.drop();
    await admin?.end({ timeout: 5 });
  });

  const kinds = [
    { kind: "session pool", pooled: false },
    { kind: "transaction pooler", pooled: true },
  ] as const;

  describe.each(kinds)("on a $kind", ({ pooled }) => {
    let owned: OwnedDb | null = null;
    let db: Handle;

    beforeAll(() => {
      if (pooled) db = makePooledDb(role.url(POOLER), { max: 2 });
      else db = (owned = makeOwnedDb(role.url(), { role: "api" })).db;
    });
    afterAll(async () => { await owned?.close(); });

    const skip = pooled && !POOLER_UP;

    it.skipIf(skip)("bound to A, every door reads A's rows only", async () => {
      const a = bindDb(db, { account: A }) as unknown as Tx;
      expect(notes(await a.execute(sql`select note from owned_rows`))).toEqual(["a1", "a2"]);
      const inTx = await a.transaction(async (tx) => {
        const first = notes(await (tx as unknown as Tx).execute(sql`select note from owned_rows`));
        const later = notes(await (tx as unknown as Tx).execute(sql`select note from owned_rows where note like ${"%"}`));
        await (tx as unknown as Tx).transaction(async (sp) => {
          await (sp as unknown as Tx).execute(sql`select 1 / ${0}::int`);
        }).catch(() => undefined);
        const afterSavepoint = notes(await (tx as unknown as Tx).execute(sql`select note from owned_rows`));
        return { first, later, afterSavepoint };
      });
      expect(inTx).toEqual({ first: ["a1", "a2"], later: ["a1", "a2"], afterSavepoint: ["a1", "a2"] });
      const flight = readFlightOf(a as unknown as object) as unknown as Tx;
      expect(notes(await flight.transaction((tx) => (tx as unknown as Tx).execute(sql`select note from owned_rows`))))
        .toEqual(["a1", "a2"]);
    });

    it.skipIf(skip)("a raw statement reads no account row; bound to nothing reads the staff table and no account row", async () => {
      expect(notes(await db.execute(sql`select note from owned_rows`))).toEqual([]);
      const nothing = bindDb(db, { account: null }) as unknown as Tx;
      expect(notes(await nothing.execute(sql`select note from owned_rows`))).toEqual([]);
      expect(notes(await nothing.execute(sql`select note from staff_rows`))).toEqual(["staff"]);
      const a = bindDb(db, { account: A }) as unknown as Tx;
      expect(notes(await a.execute(sql`select note from staff_rows`))).toEqual([]);
    });

    it.skipIf(skip)("a key admits its own keyed row only", async () => {
      const keyed = bindDb(db, { account: null, key: "k-two" }) as unknown as Tx;
      expect(notes(await keyed.execute(sql`select note from keyed_rows`))).toEqual(["two"]);
      const none = bindDb(db, { account: null }) as unknown as Tx;
      expect(notes(await none.execute(sql`select note from keyed_rows`))).toEqual([]);
    });

    it.skipIf(skip)("another account's id is refused on insert; another's row changes on no update or delete", async () => {
      const a = bindDb(db, { account: A }) as unknown as Tx;
      const refused = await a.execute(sql`insert into owned_rows (account_id, note) values (${B}, ${"forged"})`)
        .then(() => null, (e: unknown) => (e as { code?: string }).code);
      expect(refused).toBe("42501");
      const updated = await a.execute(sql`update owned_rows set note = ${"taken"} where account_id = ${B}`);
      const deleted = await a.execute(sql`delete from owned_rows where account_id = ${B}`);
      expect([(updated as { count?: number }).count, (deleted as { count?: number }).count]).toEqual([0, 0]);
      const [row] = rows(await admin.unsafe(`select note from ${s}.owned_rows where account_id = '${B}'`));
      expect(row?.note).toBe("b1");
    });

    it.skipIf(skip)("a write flight's row is its account's, and stands", async () => {
      const a = bindDb(db, { account: A }) as unknown as Tx;
      const note = `w-${randomUUID().slice(0, 8)}`;
      await a.transaction(async (tx) => {
        await (tx as unknown as Tx).execute(sql`insert into owned_rows (account_id, note) values (${A}, ${note})`);
      });
      const b = bindDb(db, { account: B }) as unknown as Tx;
      expect(notes(await b.execute(sql`select note from owned_rows where note = ${note}`))).toEqual([]);
      expect(notes(await a.execute(sql`select note from owned_rows where note = ${note}`))).toEqual([note]);
      await a.execute(sql`delete from owned_rows where note = ${note}`);
    });

    it.skipIf(skip)("A and B alternate a thousand rounds, then interleaved, and never read across", async () => {
      const a = bindDb(db, { account: A }) as unknown as Tx;
      const b = bindDb(db, { account: B }) as unknown as Tx;
      const read = (h: Tx) => h.execute(sql`select note from owned_rows where id > ${0}`).then(notes);
      let crossed = 0;
      for (let i = 0; i < 1_000; i++) {
        const [x, y] = [await read(a), await read(b)];
        if (x.join() !== "a1,a2" || y.join() !== "b1") crossed++;
      }
      for (let i = 0; i < 1_000; i += 50) {
        const batch = await Promise.all(Array.from({ length: 50 }, (_, j) => (j % 2 === 0 ? read(a) : read(b))
          .then((got) => got.join() === (j % 2 === 0 ? "a1,a2" : "b1"))));
        crossed += batch.filter((ok) => !ok).length;
      }
      expect(crossed).toBe(0);
    }, 120_000);

    it.skipIf(skip)("a value planted on the session, then on the role: the bound flight reads its own, the nothing flight none", async () => {
      const a = bindDb(db, { account: A }) as unknown as Tx;
      const nothing = bindDb(db, { account: null }) as unknown as Tx;
      // Session-level, on whatever backend this client has; through the pooler, the backend every client shares.
      await db.execute(sql`select pg_catalog.set_config('ohmail.account', ${B}, false)`);
      expect(notes(await a.execute(sql`select note from owned_rows`))).toEqual(["a1", "a2"]);
      expect(notes(await nothing.execute(sql`select note from owned_rows`))).toEqual([]);
      await db.execute(sql`select pg_catalog.set_config('ohmail.account', ${""}, false)`);
      // Role-level, read by every backend the role starts from now on.
      await admin.unsafe(`alter role ${role.name} set ohmail.account = '${B}'`);
      try {
        await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where usename = '${role.name}'`);
        let fresh: string[] | null = null;
        for (let i = 0; i < 5 && fresh === null; i++) {
          fresh = await nothing.execute(sql`select note from owned_rows`).then(notes, () => null);
        }
        expect(fresh).toEqual([]);
        expect(notes(await a.execute(sql`select note from owned_rows`))).toEqual(["a1", "a2"]);
      } finally {
        await admin.unsafe(`alter role ${role.name} reset ohmail.account`);
        await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where usename = '${role.name}'`);
        for (let i = 0; i < 5; i++) if (await db.execute(sql`select 1`).then(() => true, () => false)) break;
      }
    }, 60_000);

    it.skipIf(skip)("a connection reused after an error carries no account", async () => {
      const a = bindDb(db, { account: A, key: "k-one" }) as unknown as Tx;
      await expect(a.execute(sql`select 1 / ${0}::int`)).rejects.toMatchObject({ code: "22012" });
      const [left] = rows(await db.execute(sql`select current_setting('ohmail.account', true) as a, current_setting('ohmail.key', true) as k`));
      expect([left?.a ?? "", left?.k ?? ""]).toEqual(["", ""]);
      expect(notes(await db.execute(sql`select note from owned_rows`))).toEqual([]);
    });

    it.skipIf(skip)("a handle kept from a closed flight writes nothing into the next one", async () => {
      const a = bindDb(db, { account: A }) as unknown as Tx;
      let kept: Tx | null = null;
      await a.transaction(async (tx) => { kept = tx as unknown as Tx; });
      const b = bindDb(db, { account: B }) as unknown as Tx;
      const late = await b.transaction(async () =>
        kept!.execute(sql`select note from owned_rows`).then(notes, (e: unknown) => e));
      expect(late).toBeInstanceOf(FlightClosedError);
    });
  });
});
