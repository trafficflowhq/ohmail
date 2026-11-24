import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { bindDb, BindingRefusedError, onServerPool } from "../src/bound.js";
import { closePooledDbs, FlightClosedError, makeOwnedDb, makePooledDb, type OwnedDb } from "../src/client.js";
import { dropInvalidLeftovers, ensureConcurrentIndexes, type ConcurrentIndexSpec } from "../src/concurrent-index.js";
import { brandDialect } from "../src/dialect/index.js";
import { ensureHotPathIndexes } from "../src/hot-path-indexes.js";
import { readFlightOf } from "../src/read-flight.js";
import { reclaimSpace } from "../src/reclaim-space.js";
import { LOCK_READERS, READER_SCHEMA, readerStatement } from "../src/row-security/names.js";
import { ensureSearchExtensions, ensureWithheldProvenanceIndex, ensureWordIndex, retireOldSearch } from "../src/search-setup.js";
import { PG_TEST_URL, realPgAvailable, recordPgWire } from "../src/testing.js";
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
// Before the first connection: the recorder reads what a session-level function writes, or does not.
const wire = recordPgWire();
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
    // The lock's own readers, as its setup makes them, in this file's own schema (the settings' names untouched).
    for (const r of LOCK_READERS) {
      const made = readerStatement(r);
      expect(made).toContain(`function ${READER_SCHEMA}.${r.name}()`);
      await admin.unsafe(made.replace(`function ${READER_SCHEMA}.${r.name}()`, `function ${s}.${r.name}()`));
    }
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

    it.skipIf(skip)("a bound handle handed to a session-level build is refused before a byte is written", async () => {
      const spec: ConcurrentIndexSpec = {
        name: "owned_rows_note_idx", table: "owned_rows",
        ddl: sql`create index concurrently if not exists "owned_rows_note_idx" on owned_rows (note)`,
      };
      // Warm: the pool's connection is open, so a write below would be a statement's and not a sign-in's.
      await db.execute(sql`select 1`);
      for (const view of [bindDb(db, { account: A }), bindDb(db, { account: null }), bindDb(db, { account: null, key: "k-one" })]) {
        // Each call below is also the type's refusal: a bound handle does not fit the parameter.
        const builds: Array<() => Promise<unknown>> = [
          // @ts-expect-error a bound handle is not the pool's own
          () => ensureConcurrentIndexes(view, [spec], { label: "a test's index build" }),
          // @ts-expect-error a bound handle is not the pool's own
          () => dropInvalidLeftovers(view, [spec.name], { label: "a test's drop of leftovers" }),
          // @ts-expect-error a bound handle is not the pool's own
          () => ensureSearchExtensions(view),
          // @ts-expect-error a bound handle is not the pool's own
          () => ensureWordIndex(view),
          // @ts-expect-error a bound handle is not the pool's own
          () => retireOldSearch(view),
          // @ts-expect-error a bound handle is not the pool's own
          () => ensureWithheldProvenanceIndex(view),
          // @ts-expect-error a bound handle is not the pool's own
          () => ensureHotPathIndexes(view),
        ];
        for (const build of builds) {
          wire.start();
          await expect(build()).rejects.toBeInstanceOf(BindingRefusedError);
          expect(wire.read().flushes).toEqual([]);
        }
      }
      const [built] = rows(await admin.unsafe(`select count(*)::int as n from pg_indexes where schemaname = '${s}' and indexname = 'owned_rows_note_idx'`));
      expect(built?.n).toBe(0);
    });

    it.skipIf(skip)("a server pool is sent nothing to reclaim a table's space: not on its own handle, not on a view", async () => {
      expect(onServerPool(db)).toBe(true);
      await db.execute(sql`select 1`);
      for (const handle of [db, bindDb(db, { account: A }), bindDb(db, { account: null })]) {
        expect(onServerPool(handle)).toBe(true);
        wire.start();
        await reclaimSpace(handle, "scheduled_send_files");
        await reclaimSpace(handle, "outbound_sent_copies");
        expect(wire.read().flushes).toEqual([]);
      }
    });
  });
});

describe("a device's store is sent the statement that hands a table's space back", () => {
  it("on PGlite, once per call, outside any transaction, on the store's own handle and through a view of it", async () => {
    const client = new PGlite();
    await client.exec("create table scheduled_send_files (id int primary key, data text)");
    await client.exec("create table outbound_sent_copies (id int primary key, data text)");
    await client.exec("insert into scheduled_send_files select g, repeat('x', 2000) from generate_series(1, 200) g");
    await client.exec("delete from scheduled_send_files");
    const store = brandDialect(drizzlePglite(client), "pg");
    expect(onServerPool(store)).toBe(false);
    const sent: string[] = [];
    const failed: unknown[] = [];
    const query = client.query.bind(client);
    client.query = ((text: string, ...rest: unknown[]) => {
      sent.push(text);
      const answer = (query as (...a: unknown[]) => Promise<unknown>)(text, ...rest);
      answer.catch((err: unknown) => { failed.push(err); });
      return answer;
    }) as typeof client.query;
    await reclaimSpace(store, "scheduled_send_files");
    await reclaimSpace(bindDb(store, { account: A }), "outbound_sent_copies");
    expect(sent).toEqual(["VACUUM scheduled_send_files", "VACUUM outbound_sent_copies"]);
    expect(failed).toEqual([]);
    await client.close();
  });

  it("a store that is not Postgres is sent nothing, and a table outside the two is refused", async () => {
    const sent: unknown[] = [];
    const sqlite = brandDialect({ run: (q: unknown) => { sent.push(q); } }, "sqlite");
    await reclaimSpace(sqlite, "scheduled_send_files");
    expect(sent).toEqual([]);
    const store = brandDialect(drizzlePglite(new PGlite()), "pg");
    await expect(reclaimSpace(store, "accounts" as never)).rejects.toBeInstanceOf(TypeError);
  });
});
