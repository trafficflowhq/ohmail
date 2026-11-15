import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { assertRoster, NotRosterError, rosterDbFor } from "../src/roster-db.js";
import { closePooledDbs, makePooledDb } from "../src/client.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { rlsBench, type Bench, type BenchRole } from "./_rls-bench.js";

/**
 * THE ROSTER HANDLE IS THE WORKER'S ROLE OR NOTHING. On a real Postgres, against a role this file
 * makes (owning nothing, searching a schema of its own with a `mailboxes` and a `message_bodies`
 * table under forced row security): the attestation passes for the worker's shape, and refuses the
 * database's superuser, a role that bypasses row security, a role the lock does not bite (an API-like role reading
 * a body unbound), a policy list that is not the worker's, and a table the lock is off for. A
 * mailbox table with no row is accepted beside an equal census, and said so.
 */
const PG_UP = await realPgAvailable();

describe.skipIf(!PG_UP)("the roster handle's attestation (real Postgres)", () => {
  let admin: postgres.Sql;
  let bench: Bench;
  let worker: BenchRole;
  let policies: string[];

  /** A plain handle signed in as `role`, from the pooled factory (its door is what binds a flight to nothing). */
  const as = (role: BenchRole) => makePooledDb(role.url(), { max: 1 });

  beforeAll(async () => {
    admin = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    bench = await rlsBench(admin, PG_TEST_URL);
    const s = bench.schema;
    await admin.unsafe(`create table ${s}.mailboxes (id int primary key, account_id text not null)`);
    await admin.unsafe(`create table ${s}.message_bodies (id int primary key, account_id text not null)`);
    await admin.unsafe(`insert into ${s}.mailboxes values (1, 'a'), (2, 'b')`);
    await admin.unsafe(`insert into ${s}.message_bodies values (1, 'a'), (2, 'b')`);
    for (const t of ["mailboxes", "message_bodies"]) {
      await admin.unsafe(`alter table ${s}.${t} enable row level security`);
      await admin.unsafe(`alter table ${s}.${t} force row level security`);
    }
    worker = await bench.role();
    await admin.unsafe(`grant select on ${s}.mailboxes, ${s}.message_bodies to ${worker.name}`);
    await admin.unsafe(`create policy roster_wide on ${s}.mailboxes for select to ${worker.name} using (true)`);
    await admin.unsafe(`create policy roster_bound on ${s}.message_bodies for select to ${worker.name}
      using (account_id = pg_catalog.current_setting('ohmail.account', true))`);
    policies = [`${s}.mailboxes.roster_wide`, `${s}.message_bodies.roster_bound`];
  }, 60_000);

  afterAll(async () => {
    await closePooledDbs();
    await bench?.drop();
    await admin?.end({ timeout: 5 });
  });

  it("attests the worker's shape: no rights, owns nothing, the lock live, both bites, the census equal", async () => {
    expect(await assertRoster(as(worker), { role: worker.name, policies })).toBe("attested");
  });

  it("refuses a policy list that is not the worker's", async () => {
    await expect(assertRoster(as(worker), { role: worker.name, policies: policies.slice(0, 1) }))
      .rejects.toBeInstanceOf(NotRosterError);
  });

  it("refuses a role of another name", async () => {
    await expect(assertRoster(as(worker), { role: "ohmail_worker", policies })).rejects.toThrow(/is not ohmail_worker/);
  });

  it("refuses the superuser the tables belong to: the address pointed at the database's own role", async () => {
    const owner = makePooledDb(PG_TEST_URL, { max: 1 });
    const name = String((await admin`select current_user as u`)[0]!.u);
    await expect(assertRoster(owner, { role: name, policies })).rejects.toBeInstanceOf(NotRosterError);
  });

  it("refuses a role that bypasses row security", async () => {
    const bypass = await bench.role("bypassrls");
    await admin.unsafe(`grant select on ${bench.schema}.mailboxes, ${bench.schema}.message_bodies to ${bypass.name}`);
    await expect(assertRoster(as(bypass), { role: bypass.name, policies: [] })).rejects.toThrow(/bypass/);
  });

  it("refuses an API-like role: one the first bite does not stop", async () => {
    const api = await bench.role();
    const s = bench.schema;
    await admin.unsafe(`grant select on ${s}.mailboxes, ${s}.message_bodies to ${api.name}`);
    await admin.unsafe(`create policy api_read on ${s}.message_bodies for select to ${api.name} using (true)`);
    await admin.unsafe(`create policy api_boxes on ${s}.mailboxes for select to ${api.name} using (true)`);
    await expect(assertRoster(as(api), { role: api.name, policies: [`${s}.mailboxes.api_boxes`, `${s}.message_bodies.api_read`] }))
      .rejects.toThrow(/message_bodies answered a row/);
  });

  it("refuses when the lock is off for a table, and says so before any bite", async () => {
    const off = await bench.role();
    const s = bench.schema;
    await admin.unsafe(`grant select on ${s}.mailboxes, ${s}.message_bodies to ${off.name}`);
    // The role searches a schema where `mailboxes` names a table without row security.
    const other = `${s}_off`;
    await admin.unsafe(`create schema ${other}`);
    await admin.unsafe(`create table ${other}.mailboxes (id int)`);
    await admin.unsafe(`grant usage on schema ${other} to ${off.name}`);
    await admin.unsafe(`grant select on ${other}.mailboxes to ${off.name}`);
    await admin.unsafe(`alter role ${off.name} set search_path = ${other}, ${s}`);
    try {
      await expect(assertRoster(as(off), { role: off.name, policies: [] })).rejects.toThrow(/row security is not live/);
    } finally {
      await admin.unsafe(`drop schema ${other} cascade`);
    }
  });

  it("accepts an empty mailbox table only beside an equal census, and says it is not to be remembered", async () => {
    const s = bench.schema;
    await admin.unsafe(`delete from ${s}.mailboxes`);
    try {
      expect(await assertRoster(as(worker), { role: worker.name, policies })).toBe("attested-empty");
      await expect(assertRoster(as(worker), { role: worker.name, policies: [] })).rejects.toBeInstanceOf(NotRosterError);
    } finally {
      await admin.unsafe(`insert into ${s}.mailboxes values (1, 'a'), (2, 'b')`);
    }
  });

  it("the factory names its pool and its list, and refuses any role but the worker's", async () => {
    expect(() => rosterDbFor(worker.url(), {} as never)).toThrow(TypeError);
    expect(() => rosterDbFor(worker.url(), { pool: "pooler" } as never)).toThrow(TypeError);
    const roster = rosterDbFor(worker.url(), { pool: "pooler", policies });
    const outcome = (): Promise<string> => roster().then(() => "a roster handle", (e: unknown) => String((e as Error).message));
    expect(await outcome()).toMatch(/is not ohmail_worker/);
    // A failure is never remembered: the next use asks again.
    expect(await outcome()).toMatch(/is not ohmail_worker/);
  });
});
