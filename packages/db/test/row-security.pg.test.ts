import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { MIGRATED_DB_SETUP_BUDGET_MS, MIGRATOR_ROLE, PG_MAJORS, ownServersAvailable, startLockGround, type LockGround } from "../src/testing.js";
import { messageSearch, messages } from "../src/schema-mail.js";
import {
  expectedPolicies, lockCensus, pinSpelling, policyComment, policyDifferences, readLockFacts, viewComment, type LockFacts,
} from "../src/row-security/census.js";
import { createPolicyStatement } from "../src/row-security/apply.js";
import { LOCK_READERS } from "../src/row-security/names.js";
import { policyList, lockedTables, policiesOfTable } from "../src/row-security/policies.js";
import { ROLE_DEADLINES } from "../src/row-security/deadlines.js";
import { API_REPLACEMENT_ROLE } from "../src/row-security/logins.js";
import { readLock, type LockReading } from "../src/row-security/check.js";
import { ACCOUNT_VIEWS, INDEX_READS, readerCondition, viewName, viewStatement, type AccountView } from "../src/row-security/views.js";
import { switchLock } from "../src/row-security/switch.js";
import { BINDER_SQL } from "../src/bound.js";

/**
 * The readers as the handle's first part wrote them, before the lock's list carried its own: a
 * store may still hold them. Kept here as the plant it is: a malformed value fails the statement
 * in these, where the list's readers read NULL.
 */
const OLD_READERS_SQL = `create schema if not exists ohmail;
create or replace function ohmail.current_account() returns uuid language sql stable parallel safe
  as $$ select nullif(pg_catalog.current_setting('ohmail.account', true), '')::uuid $$;
create or replace function ohmail.current_key() returns text language sql stable parallel safe
  as $$ select nullif(pg_catalog.current_setting('ohmail.key', true), '') $$;`;

/**
 * THE LOCK ON A REAL POSTGRES, ON A SERVER THIS FILE OWNS WHOLE. Roles belong to the whole server,
 * so the runtime logins are made under their real names by the real script, on a container of this
 * file's own, for each major the product runs on (the self-hosted servers' 16, the Cloud's 17).
 *
 * The cases of one server run in order: a server without the roles, the roles made, the setup that
 * is not asked, the setup that is, a second run; then each drift on a database of its own.
 */
const FILE = "packages/db/test/row-security.pg.test.ts";
const OWN = ownServersAvailable(FILE);
const CASE_MS = 120_000;

describe("a server of the test's own is asked of docker, and its absence is named", () => {
  const unreachable: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST: "tcp://127.0.0.1:9" };

  it("under TF_REQUIRE_PG=1 a docker that does not answer fails the file, naming docker run", () => {
    expect(() => ownServersAvailable(FILE, { ...unreachable, TF_REQUIRE_PG: "1" })).toThrow(/docker run/);
  });

  it("without it the file is skipped, and says so", () => {
    const env = { ...unreachable };
    delete env.TF_REQUIRE_PG;
    expect(ownServersAvailable(FILE, env)).toBe(false);
  });
});

for (const major of PG_MAJORS) {
  describe.skipIf(!OWN)(`the lock's setup on Postgres ${major}`, () => {
    let ground: LockGround;
    beforeAll(async () => { ground = await startLockGround(major, `lock_${major}`, "ground"); }, MIGRATED_DB_SETUP_BUDGET_MS);
    afterAll(() => ground?.stop());

    /** What the catalog of `db` holds of a lock: the schema, the policies, the tables under row security. */
    async function lockOf(db: string): Promise<{ schema: boolean; policies: number; underRls: number }> {
      const sql = ground.connectAs(db);
      try {
        const [r] = await sql<Array<{ schema: boolean; policies: number; under_rls: number }>>`select
          exists (select 1 from pg_namespace where nspname = 'ohmail') as schema,
          (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public') as policies,
          (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relrowsecurity) as under_rls`;
        return { schema: r!.schema, policies: r!.policies, underRls: r!.under_rls };
      } finally {
        await sql.end({ timeout: 5 });
      }
    }

    /** `statements` on `db` as the migrator, then the census of `db`. */
    async function plantAndCensus(db: string, statements: string[]): Promise<string[]> {
      const sql = ground.connectAs(db, MIGRATOR_ROLE);
      try {
        for (const s of statements) await sql.unsafe(s);
        return await lockCensus(sql);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }

    it("a server without the roles: the setup, asked or not, makes no lock and its report is as it was", async () => {
      const said: string[] = [];
      const report = await ground.setup("ground", undefined, { log: (m) => said.push(m) });
      expect("lock" in report).toBe(false);
      expect(said.filter((m) => m.startsWith("lock:"))).toEqual([]);
      const asked = await ground.setup("ground", undefined, { lock: "apply" });
      expect("lock" in asked).toBe(false);
      expect(await lockOf("ground")).toEqual({ schema: false, policies: 0, underRls: 0 });
      const sql = ground.connectAs("ground");
      try { expect((await readLock(sql)).verdict).toBe("absent"); } finally { await sql.end({ timeout: 5 }); }
    }, CASE_MS);

    /** `plant` on the ground as its owner, the setup's answer, then `undo`: a server without the roles. */
    async function withoutRoles(plant: string[], undo: string[]): Promise<{ report?: object; refused?: string; said: string[] }> {
      const su = ground.connectAs("ground");
      const said: string[] = [];
      try {
        for (const s of plant) await su.unsafe(s);
        return await ground.setup("ground", undefined, { log: (m) => said.push(m) })
          .then((report) => ({ report, said }), (e: Error) => ({ refused: e.message, said }));
      } finally {
        for (const s of undo) await su.unsafe(s);
        await su.end({ timeout: 5 });
      }
    }

    it("a server without the roles: row security its owner turned on, on a listed table or one of its own, changes nothing in the setup", async () => {
      const plain = await withoutRoles([], []);
      for (const [plant, undo] of [
        [["alter table public.accounts enable row level security"], ["alter table public.accounts disable row level security"]],
        [["create table public.someone_elses (id int)", "alter table public.someone_elses enable row level security"], ["drop table public.someone_elses"]],
      ] as const) {
        const got = await withoutRoles([...plant], [...undo]);
        expect(got.refused, plant.join("; ")).toBeUndefined();
        expect("lock" in got.report!).toBe(false);
        expect(got.said.filter((m) => m.startsWith("lock:"))).toEqual([]);
        expect(Object.keys(got.report!).sort()).toEqual(Object.keys(plain.report!).sort());
      }
    }, CASE_MS);

    it("a server without the roles that holds a locked store's marks, a forced table, a lock policy or the readers' schema, is refused and nothing changes", async () => {
      for (const [plant, undo] of [
        [["alter table public.messages force row level security"], ["alter table public.messages no force row level security"]],
        [["create policy lock_account on public.accounts using (true)"], ["drop policy lock_account on public.accounts"]],
        [["create schema ohmail"], ["drop schema ohmail"]],
      ] as const) {
        const got = await withoutRoles([...plant], [...undo]);
        expect(got.refused, plant.join("; ")).toMatch(/lock: this database carries a locked store's marks \(.*\) and this server has none of its runtime logins; nothing was changed/);
      }
      expect(await lockOf("ground")).toEqual({ schema: false, policies: 0, underRls: 0 });
    }, CASE_MS);

    it("the copied roles' script makes the logins over the 2.0 store and answers ROLES_OK", async () => {
      const said = await ground.makeRoles("ground");
      expect(said.filter((t) => /ROLES_(DRIFT|REFUSED)/.test(t))).toEqual([]);
      expect(said.some((t) => t.includes("ROLES_OK migrator=ohmail_migrator bypass=migrator-only"))).toBe(true);
    }, CASE_MS);

    it("the logins exist and nothing asks for the lock: not applied, nothing written", async () => {
      const report = await ground.setup("ground", MIGRATOR_ROLE);
      expect(report.lock).toMatchObject({ state: "not-applied", wrote: 0 });
      expect(await lockOf("ground")).toEqual({ schema: false, policies: 0, underRls: 0 });
      await ground.clone("ground", "unlocked");
    }, CASE_MS);

    it("the logins exist, nothing asks, and only the readers' schema stands, bare or with old readers: not applied, nothing written", async () => {
      for (const [name, plant] of [["bare_schema", "create schema ohmail"], ["old_readers", OLD_READERS_SQL]] as const) {
        const db = await ground.clone("unlocked", name);
        const mig = ground.connectAs(db, MIGRATOR_ROLE);
        try { await mig.unsafe(plant).simple(); } finally { await mig.end({ timeout: 5 }); }
        const said: string[] = [];
        const report = await ground.setup(db, MIGRATOR_ROLE, { log: (m) => said.push(m) });
        expect(report.lock, name).toMatchObject({ state: "not-applied", wrote: 0, repaired: [] });
        expect(said.filter((m) => m.startsWith("lock:")), name).toHaveLength(1);
        expect(await lockOf(db), name).toEqual({ schema: true, policies: 0, underRls: 0 });
      }
    }, CASE_MS);

    /** The rights the runtime roles' rule writes on the account's views, which a login lacks between the lock step and the roles' apply. */
    const ungrantedLines = (views: readonly string[] = ACCOUNT_VIEWS.map((v) => v.name), usage = true): string[] => [
      ...(usage ? ["ohmail_api", "ohmail_worker"].map((l) => `LOCK_DRIFT views.ungranted ohmail: ${l} holds no USAGE while a view stands`) : []),
      ...views.flatMap((v) => ["ohmail_api", "ohmail_worker"].map((l) => `LOCK_DRIFT views.ungranted ohmail.${v}: ${l} holds no SELECT`)),
    ].sort();
    /** As `role` on `db`, the binder's own statement naming `account`, then the account's reader called by name: what it answers, or the refusal's code. */
    const readerByName = async (db: string, role: string, account: string): Promise<string> => {
      const c = ground.connectAs(db, role);
      try {
        return await c.begin(async (tx) => {
          await tx.unsafe(BINDER_SQL, [account, ""]);
          return String((await tx.unsafe("select ohmail.current_account()::text as a"))[0]!.a);
        }) as string;
      } catch (e) {
        return String((e as { code?: unknown }).code ?? (e as Error).message);
      } finally {
        await c.end({ timeout: 5 });
      }
    };

    it("asked: every locked table is forced, exactly the listed policies stand, the deadlines by role, and the census names only the views' rights the roles' apply writes next", async () => {
      const report = await ground.setup("ground", MIGRATOR_ROLE, { lock: "apply" });
      // Screener learning has its own account-scoped table and must be forced too.
      expect(report.lock).toMatchObject({ state: "locked", tables: lockedTables().length, forced: 102, policies: policyList().length, repaired: [] });
      expect(report.lock!.wrote).toBeGreaterThan(policyList().length);
      const existingDeadlines = Object.entries(ROLE_DEADLINES).filter(([role]) => role !== API_REPLACEMENT_ROLE);
      expect(report.lock!.deadlines).toEqual(Object.fromEntries(existingDeadlines.map(([role, cell]) =>
        [role, Object.fromEntries(Object.keys(cell).map((guc) => [guc, true]))])));
      const sql = ground.connectAs("ground", MIGRATOR_ROLE);
      try {
        expect((await lockCensus(sql)).sort()).toEqual(ungrantedLines());
        const [t] = await sql<Array<{ n: number }>>`select count(*)::int as n from pg_tables where schemaname = 'public'`;
        // The public table inventory includes the new account-scoped Screener learning table.
        expect(t!.n).toBe(112);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }, CASE_MS);

    it("a second run writes nothing", async () => {
      const report = await ground.setup("ground", MIGRATOR_ROLE);
      expect(report.lock).toMatchObject({ state: "locked", wrote: 0, repaired: [] });
    }, CASE_MS);

    /** Who holds what on the readers' schema and the account's views of `db`, as the catalog's entries say. */
    async function viewRights(db: string): Promise<string[]> {
      const sql = ground.connectAs(db, MIGRATOR_ROLE);
      try {
        return (await sql.unsafe(`select n.nspname || ':' || pg_get_userbyid(x.grantee) || ':' || x.privilege_type as e
            from pg_namespace n cross join lateral aclexplode(n.nspacl) x where n.nspname = 'ohmail' and x.grantee <> n.nspowner
          union all select c.relname || ':' || pg_get_userbyid(x.grantee) || ':' || x.privilege_type from pg_class c
            join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) x
           where n.nspname = 'ohmail' and c.relkind = 'v' and x.grantee <> c.relowner order by 1`)).map((r) => String(r.e));
      } finally {
        await sql.end({ timeout: 5 });
      }
    }

    it("the views stood ungranted through that second run: the step grants nothing, its check before and after cuts the views' grants, and a login naming a reader is refused", async () => {
      expect(await viewRights("ground")).toEqual([]);
      expect((await plantAndCensus("ground", [])).sort()).toEqual(ungrantedLines());
      const a = "00000000-0000-4000-8000-0000000000a1";
      expect({ api: await readerByName("ground", "ohmail_api", a), worker: await readerByName("ground", "ohmail_worker", a) }).toEqual({ api: "42501", worker: "42501" });
    }, CASE_MS);

    it("the roles' apply after the lock step writes exactly the eight rights the views take, and the lock stays as listed", async () => {
      const said = await rolesScript("ground");
      expect(said.filter((s) => /ROLES_(OK|DRIFT|REFUSED)/.test(s)).map((s) => s.split(" ")[1])).toEqual(["ROLES_OK"]);
      const want = ["ohmail_api", "ohmail_worker"].flatMap((l) => ["ohmail", ...ACCOUNT_VIEWS.map((v) => v.name)].map((o) => `${o}:${l}:${o === "ohmail" ? "USAGE" : "SELECT"}`)).sort();
      expect(await viewRights("ground")).toEqual(want);
      expect(said.filter((s) => /write: [^\n]*ohmail/.test(s))).toHaveLength(8);
      expect(await plantAndCensus("ground", [])).toEqual([]);
      for (const role of ["ohmail_api", "ohmail_worker"]) {
        expect(await verdictOf("ground", role, { role }), role).toMatchObject({ verdict: "locked", why: [], census: 0, views: 3 });
      }
      expect((await ground.setup("ground", MIGRATOR_ROLE)).lock).toMatchObject({ state: "locked", wrote: 0, repaired: [], views: 3 });
      // The lock's first proof case, flipped: with USAGE on the readers' schema a login may call a reader by name, and it answers the binding the login wrote.
      const a = "00000000-0000-4000-8000-0000000000a1";
      expect({ api: await readerByName("ground", "ohmail_api", a), worker: await readerByName("ground", "ohmail_worker", a), nothing: await readerByName("ground", "ohmail_api", "") })
        .toEqual({ api: a, worker: a, nothing: "null" });
    }, CASE_MS);

    it("a whole-row read through each view answers: every column the schema declares for its table is one the view holds", async () => {
      const a = "00000000-0000-4000-8000-0000000000a1";
      const tables = { messages, message_search: messageSearch };
      for (const v of ACCOUNT_VIEWS) {
        // What a read of the whole row names: each column of the table's schema, by name (never `*`).
        const declared = Object.values(getTableColumns(tables[v.table])).map((c) => `"${c.name}"`).join(", ");
        const rows = await boundCount("ground", "ohmail_api", a, `select count(*)::int as n from ${viewName(v)}`);
        const whole = await boundCount("ground", "ohmail_api", a, `select count(*)::int as n from (select ${declared} from ${viewName(v)}) as whole`);
        expect({ view: v.name, answers: typeof rows, whole }).toEqual({ view: v.name, answers: "number", whole: rows });
      }
    }, CASE_MS);

    /**
     * THE POSTCONDITION: the views are born unreachable or not at all. On a store with no lock yet the check
     * before the step has no view to read who reaches; after the step made them, inside its transaction, the
     * check runs again on the step's own connection, names who would reach them, and the step rolls back.
     */
    const firstLockRefused = async (name: string, plant: { readonly asSuper?: string[]; readonly asMigrator?: string[]; readonly undo?: string[] }):
      Promise<{ refused: string; lock: object }> => {
      const db = await ground.clone("unlocked", name);
      const su = ground.connectAs("postgres");
      try {
        for (const s of plant.asSuper ?? []) await su.unsafe(s);
        const mig = ground.connectAs(db, MIGRATOR_ROLE);
        try { for (const s of plant.asMigrator ?? []) await mig.unsafe(s); } finally { await mig.end({ timeout: 5 }); }
        const refused = await ground.setup(db, MIGRATOR_ROLE, { lock: "apply" }).then((r) => `not refused: ${JSON.stringify(r.lock)}`, (e: Error) => e.message);
        return { refused, lock: await lockOf(db) };
      } finally {
        for (const s of plant.undo ?? []) await su.unsafe(s);
        await su.end({ timeout: 5 });
      }
    };
    const NOTHING_MADE = { schema: false, policies: 0, underRls: 0 };

    it("the postcondition: a member of pg_read_all_data on a store with no lock yet; the step names it, rolls back, the readers' schema stays absent, and the member reads nothing", async () => {
      const db = "post_reader";
      const got = await firstLockRefused(db, { asSuper: ["create role r_post_reader login in role pg_read_all_data"] });
      await ground.password("r_post_reader");
      const member = ground.connectAs(db, "r_post_reader");
      let read: string;
      try { read = await member.unsafe("select count(*) from ohmail.messages").then(() => "read", (e: { code?: string }) => String(e.code)); }
      finally { await member.end({ timeout: 5 }); }
      const su = ground.connectAs("postgres");
      try { await su.unsafe("drop role r_post_reader"); } finally { await su.end({ timeout: 5 }); }
      expect({
        names: /lock: the runtime roles' check, after the step made the views, refused: ROLES_DRIFT [^\n]*r_post_reader[^\n]*; nothing was written/.test(got.refused),
        lock: got.lock, read,
      }).toEqual({ names: true, lock: NOTHING_MADE, read: "42P01" });
    }, CASE_MS);

    // The views born granted by the migrator's default privilege: a grant on them is the lock's own census's line, inside the
    // step's transaction, so it refuses there first; USAGE for a role the census does not read is the postcondition's alone.
    it("the migrator's default privilege on tables in every schema, for the staff role: the views born granted are named, rolled back, nothing made", async () => {
      const got = await firstLockRefused("post_default_tables", { asMigrator: ["alter default privileges for role ohmail_migrator grant select on tables to ohmail_admin"] });
      expect({ names: ACCOUNT_VIEWS.every((v) => got.refused.includes(`lock: LOCK_DRIFT views.grants ${viewName(v)}: ohmail_admin holds SELECT; nothing was written`)),
        lock: got.lock }).toEqual({ names: true, lock: NOTHING_MADE });
    }, CASE_MS);

    it("the postcondition: the migrator's default privilege on schemas, for a role of its own: the schema born usable to it is named after the step made the views, rolled back, nothing made", async () => {
      const got = await firstLockRefused("post_default_schemas", {
        asSuper: ["create role r_post_schema login"],
        // The role stays: its default privilege lives in that database alone, and it reaches nothing anywhere else.
        asMigrator: ["alter default privileges for role ohmail_migrator grant usage on schemas to r_post_schema"],
      });
      expect({ names: /lock: the runtime roles' check, after the step made the views, refused: ROLES_DRIFT [^\n]*r_post_schema[^\n]*; nothing was written/.test(got.refused),
        lock: got.lock }).toEqual({ names: true, lock: NOTHING_MADE });
    }, CASE_MS);

    it("both default privileges for the billing plane, which would read the views from the commit: named, rolled back, nothing made", async () => {
      const got = await firstLockRefused("post_default_both", { asMigrator: ["alter default privileges for role ohmail_migrator grant select on tables to plane_runtime",
        "alter default privileges for role ohmail_migrator grant usage on schemas to plane_runtime"] });
      expect({ names: got.refused.split("\n").filter((l) => /^ {2}- lock: [^\n]*plane_runtime[^\n]*; nothing was written$/.test(l)).length >= 2, lock: got.lock })
        .toEqual({ names: true, lock: NOTHING_MADE });
    }, CASE_MS);

    it("all three views dropped by hand, the logins' USAGE left: the census names it, and the next setup makes them again and the roles' apply grants them", async () => {
      const db = await ground.clone("ground", "views_dropped");
      expect((await plantAndCensus(db, [...ACCOUNT_VIEWS].reverse().map((v) => `drop view ${viewName(v)}`))).sort()).toEqual([
        ...ACCOUNT_VIEWS.map((v) => `LOCK_DRIFT views.missing ${viewName(v)}`),
        drift("schema.usage", "ohmail", "ohmail_api holds USAGE"), drift("schema.usage", "ohmail", "ohmail_worker holds USAGE"),
      ].sort());
      const report = await ground.setup(db, MIGRATOR_ROLE);
      expect({ repaired: [...report.lock!.repaired].sort(), views: report.lock!.views })
        .toEqual({ repaired: ACCOUNT_VIEWS.map((v) => `view ${viewName(v)} was missing: made`).sort(), views: 3 });
      expect((await plantAndCensus(db, [])).sort()).toEqual(ungrantedLines(ACCOUNT_VIEWS.map((v) => v.name), false));
      expect((await rolesScript(db)).filter((s) => /write: [^\n]*ohmail\./.test(s))).toHaveLength(6);
      expect(await plantAndCensus(db, [])).toEqual([]);
    }, CASE_MS);

    /**
     * Every policy of `db` against its row of the list, as the check compares them: the policies
     * that differ, with how. The second digest of a policy's record is the catalog's own spelling
     * read back after the step made it, so a policy nobody touched compares equal by construction.
     */
    async function policiesNotAsListed(db: string): Promise<{ policies: number; differ: string[] }> {
      const sql = ground.connectAs(db, MIGRATOR_ROLE);
      try {
        const facts = await sql.begin("read only", (tx) => readLockFacts(tx)) as LockFacts;
        const rows = new Map(expectedPolicies(facts).map((r) => [`${r.table}.${r.name}`, r]));
        return {
          policies: facts.policies.length,
          differ: facts.policies.flatMap((p) => {
            const r = rows.get(`${p.table}.${p.name}`);
            const d = r === undefined ? ["not listed"] : policyDifferences(p, r).map((x) => x.detail);
            return d.length === 0 ? [] : [`${p.table}.${p.name}: ${d.join("; ")}`];
          }),
        };
      } finally {
        await sql.end({ timeout: 5 });
      }
    }

    it("a fresh lock: every policy's record holds what the catalog prints for it, and both logins read locked", async () => {
      expect(await policiesNotAsListed("ground")).toEqual({ policies: policyList().length, differ: [] });
      for (const role of ["ohmail_api", "ohmail_worker"]) {
        expect(await verdictOf("ground", role, { role }), role).toMatchObject({ verdict: "locked", why: [], census: 0, role: { policies: "equal" } });
      }
    }, CASE_MS);

    it("a dump of the locked store restored onto a server with the roles: every policy's record still holds what the catalog prints, both logins read locked, and the next setup writes nothing", async () => {
      const dump = ground.server.dump("ground");
      expect(dump).toContain("CREATE POLICY lock_account ON public.messages");
      const db = await ground.clone("template0", "restored");
      ground.server.restore(db, dump);
      expect(await policiesNotAsListed(db)).toEqual({ policies: policyList().length, differ: [] });
      expect(await plantAndCensus(db, [])).toEqual([]);
      for (const role of ["ohmail_api", "ohmail_worker"]) {
        expect(await verdictOf(db, role, { role }), role).toMatchObject({ verdict: "locked", why: [], census: 0, role: { policies: "equal" } });
      }
      expect((await ground.setup(db, MIGRATOR_ROLE)).lock).toMatchObject({ state: "locked", forced: 102, wrote: 0, repaired: [] });
    }, CASE_MS);

    it("a dropped policy is red in the census, and the next setup makes it again", async () => {
      const db = await ground.clone("ground", "drift_dropped");
      expect(await plantAndCensus(db, ["drop policy lock_account on public.messages"]))
        .toEqual(["LOCK_DRIFT policies.missing messages.lock_account"]);
      const report = await ground.setup(db, MIGRATOR_ROLE);
      expect(report.lock!.repaired).toEqual(["policy messages.lock_account was missing: made"]);
      expect(await plantAndCensus(db, [])).toEqual([]);
    }, CASE_MS);

    it("a policy the list does not name is red, and the next setup drops it", async () => {
      const db = await ground.clone("ground", "drift_foreign");
      expect(await plantAndCensus(db, ["create policy wide_open on public.message_bodies for select to ohmail_api using (true)"]))
        .toEqual(["LOCK_DRIFT policies.foreign message_bodies.wide_open: a policy the list does not name"]);
      const report = await ground.setup(db, MIGRATOR_ROLE);
      expect(report.lock!.repaired).toEqual(["policy message_bodies.wide_open is not the list's: dropped"]);
      expect(await plantAndCensus(db, [])).toEqual([]);
    }, CASE_MS);

    it("an expression altered under a listed name is red, and the next setup makes it again", async () => {
      const db = await ground.clone("ground", "drift_altered");
      expect(await plantAndCensus(db, ["alter policy lock_account on public.messages using (true)"]))
        .toEqual(["LOCK_DRIFT policies.altered messages.lock_account: its expression is not what was made"]);
      const report = await ground.setup(db, MIGRATOR_ROLE);
      expect(report.lock!.repaired).toEqual(["policy messages.lock_account is not as it was made: made again"]);
      expect(await plantAndCensus(db, [])).toEqual([]);
    }, CASE_MS);

    it("forcing dropped on one table, or row security disabled on another, is red in the census, and the next setup locks each again and names it", async () => {
      for (const [table, plant, found] of [
        ["message_bodies", "no force", "on=true forced=false"],
        ["messages", "disable", "on=false forced=true"],
      ] as const) {
        const db = await ground.clone("ground", `drift_flags_${table}`);
        expect(await plantAndCensus(db, [`alter table public.${table} ${plant} row level security`]))
          .toEqual([`LOCK_DRIFT tables.flags ${table}: ${found} while the lock is on`]);
        const said: string[] = [];
        const report = await ground.setup(db, MIGRATOR_ROLE, { log: (m) => said.push(m) });
        expect(report.lock).toMatchObject({ forced: 102, wrote: 1, repaired: [`table ${table} was ${found}: locked again`] });
        expect(said).toContain(`lock: repair: table ${table} was ${found}: locked again`);
        expect(await plantAndCensus(db, [])).toEqual([]);
      }
    }, CASE_MS);

    it("a table in no class is red, and the setup refuses with nothing written", async () => {
      const db = await ground.clone("ground", "drift_unclassed");
      expect(await plantAndCensus(db, ["create table public.planted_free (id int)"]))
        .toEqual(["LOCK_DRIFT tables.unclassed planted_free: a table of public in no class"]);
      await expect(ground.setup(db, MIGRATOR_ROLE)).rejects.toThrow(/lock: LOCK_DRIFT tables\.unclassed planted_free.*nothing was written/);
      expect(await plantAndCensus(db, ["drop table public.planted_free"])).toEqual([]);
    }, CASE_MS);

    it("a new table with the account's column is red until the setup locks it, with no edit of the list", async () => {
      const db = await ground.clone("ground", "drift_new_table");
      expect(await plantAndCensus(db, ["create table public.planted_owned (id int, account_id uuid not null)"])).toEqual([
        "LOCK_DRIFT tables.flags planted_owned: on=false forced=false while the lock is on",
        "LOCK_DRIFT policies.missing planted_owned.lock_account",
      ]);
      const report = await ground.setup(db, MIGRATOR_ROLE);
      expect(report.lock).toMatchObject({ tables: 103, forced: 103, repaired: [] });
      expect(await plantAndCensus(db, [])).toEqual([]);
    }, CASE_MS);

    /**
     * One count as `role` on `db`, in a transaction the binder's own statement binds to `account` ("" names none): the
     * rows, or the refusal's code. Several statements run in order in that transaction, and the last one counts.
     */
    async function boundCount(db: string, role: string, account: string, text: string | readonly string[]): Promise<number | string> {
      const c = ground.connectAs(db, role);
      try {
        return await c.begin(async (tx) => {
          await tx.unsafe(BINDER_SQL, [account, ""]);
          let last: Array<Record<string, unknown>> = [];
          for (const s of typeof text === "string" ? [text] : text) last = await tx.unsafe(s);
          return Number(last[0]!.n);
        }) as number;
      } catch (e) {
        return String((e as { code?: unknown }).code ?? (e as Error).message);
      } finally {
        await c.end({ timeout: 5 });
      }
    }

    /** What `table` holds, as each login reads it bound to `a` and naming nothing. */
    async function readsOf(db: string, table: string, a: string): Promise<Record<string, number | string>> {
      const n = `select count(*)::int as n from public.${table}`;
      return {
        apiBoundA: await boundCount(db, "ohmail_api", a, n), apiNothing: await boundCount(db, "ohmail_api", "", n),
        workerBoundA: await boundCount(db, "ohmail_worker", a, n), workerNothing: await boundCount(db, "ohmail_worker", "", n),
      };
    }

    /**
     * `table` locked by hand as the step locks a table of the account's class: row security on and
     * forced, the list's policies for it made by the step's own statement, and the step's record on
     * each (what the catalog printed for it, read under the step's own spelling settings).
     */
    async function lockByHand(db: string, table: string): Promise<void> {
      const mig = ground.connectAs(db, MIGRATOR_ROLE);
      try {
        await mig.begin(async (tx) => {
          await tx.unsafe(`alter table public.${table} enable row level security, force row level security`);
          await pinSpelling(tx);
          for (const r of policiesOfTable(table, true)) {
            await tx.unsafe(createPolicyStatement(r));
            const [p] = await tx.unsafe(`select p.polcmd::text as verb,
                (select coalesce(pg_catalog.array_agg(pg_catalog.pg_get_userbyid(x.r)::text order by 1), '{}') from pg_catalog.unnest(p.polroles) as x(r)) as roles,
                pg_catalog.pg_get_expr(p.polqual, p.polrelid) as using, pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) as check
              from pg_catalog.pg_policy p where p.polrelid = $1::pg_catalog.regclass and p.polname = $2`, [`public.${table}`, r.name]);
            await tx.unsafe(`comment on policy ${r.name} on public.${table} is '${policyComment(r, p as never)}'`);
          }
        });
      } finally {
        await mig.end({ timeout: 5 });
      }
    }

    /** The copied roles' script, run as the migrator on `db` as a release runs it: its notices. */
    const rolesScript = (db: string): Promise<string[]> => ground.runRolesScript(db);

    /** What a refused step must leave as it found: the policies, the tables under row security and forced, the schema. */
    async function catalogOf(db: string): Promise<string> {
      const mig = ground.connectAs(db, MIGRATOR_ROLE);
      try {
        const [r] = await mig.unsafe(`select (select pg_catalog.string_agg(c.relname || '.' || p.polname || ':' || coalesce(pg_catalog.obj_description(p.oid, 'pg_policy'), '-'), ',' order by 1, 2)
              from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid) as policies,
            (select pg_catalog.string_agg(c.relname || ':' || c.relrowsecurity || c.relforcerowsecurity, ',' order by 1) from pg_catalog.pg_class c
              join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')) as flags,
            (select pg_catalog.string_agg(nspname, ',' order by 1) from pg_catalog.pg_namespace where nspname = 'ohmail') as schema`);
        return JSON.stringify(r);
      } finally {
        await mig.end({ timeout: 5 });
      }
    }

    /** A partitioned table with the account's column and one partition holding a row of each account. */
    const PARTED = (a: string, b: string): string[] => [
      "create table public.part_owned (id int not null, account_id uuid not null) partition by list (id)",
      "create table public.part_owned_1 partition of public.part_owned for values in (1)",
      `insert into public.part_owned values (1, '${a}'), (1, '${b}')`,
    ];

    it("a parent's row security holds only where a statement names the parent: read by its own name, a partition answers its own flags and policies", async () => {
      const db = await ground.clone("ground", "part_proof");
      const [a, b] = await twoAccounts(db);
      await plantAndCensus(db, PARTED(a, b));
      await lockByHand(db, "part_owned");
      const roles = await rolesScript(db);
      expect(roles.filter((t) => /ROLES_(OK|DRIFT|REFUSED)/.test(t)).map((t) => t.split(" ")[1])).toEqual(["ROLES_OK"]);
      expect(roles.some((t) => t.includes("role ohmail_api on public.part_owned_1: [DELETE INSERT SELECT UPDATE]"))).toBe(true);
      // The parent locked: through it each login reads its account's row. The partition, named by
      // itself, has no row security of its own: the parent's policy is not consulted, both rows answer.
      expect({ parent: await readsOf(db, "part_owned", a), partition: await readsOf(db, "part_owned_1", a) }).toEqual({
        parent: { apiBoundA: 1, apiNothing: 0, workerBoundA: 1, workerNothing: 0 },
        partition: { apiBoundA: 2, apiNothing: 2, workerBoundA: 2, workerNothing: 2 },
      });
      // Its own row security with no policy of its own: nothing answers, whatever the parent holds.
      const mig = ground.connectAs(db, MIGRATOR_ROLE);
      try { await mig.unsafe("alter table public.part_owned_1 enable row level security, force row level security"); } finally { await mig.end({ timeout: 5 }); }
      expect(await readsOf(db, "part_owned_1", a)).toEqual({ apiBoundA: 0, apiNothing: 0, workerBoundA: 0, workerNothing: 0 });
      // Its own copy of the account's policy: the account's row alone, by its own name.
      await lockByHand(db, "part_owned_1");
      expect(await readsOf(db, "part_owned_1", a)).toEqual({ apiBoundA: 1, apiNothing: 0, workerBoundA: 1, workerNothing: 0 });
    }, CASE_MS);

    it("the lock takes no partitioned table: the parent, each partition, one attached after the lock and a sub-partition are named by the census, the check reads broken for both logins, and the setup refuses before it writes", async () => {
      const db = await ground.clone("ground", "part_refused");
      const [a, b] = await twoAccounts(db);
      await plantAndCensus(db, [...PARTED(a, b),
        "create table public.part_owned_sub partition of public.part_owned for values in (3) partition by hash (account_id)",
        "create table public.part_owned_sub_0 partition of public.part_owned_sub for values with (modulus 1, remainder 0)",
        `insert into public.part_owned values (3, '${a}'), (3, '${b}')`]);
      // As the step locked a partitioned parent before: forced, with the list's policy and its record.
      await lockByHand(db, "part_owned");
      // A partition attached after the lock, then the roles' script, which grants every table of public.
      await plantAndCensus(db, ["create table public.part_owned_2 (id int not null, account_id uuid not null)",
        `insert into public.part_owned_2 values (2, '${a}'), (2, '${b}')`,
        "alter table public.part_owned attach partition public.part_owned_2 for values in (2)"]);
      expect((await rolesScript(db)).filter((t) => /ROLES_(OK|DRIFT|REFUSED)/.test(t)).map((t) => t.split(" ")[1])).toEqual(["ROLES_OK"]);
      // Each partition, named by itself, answers both accounts to both logins, bound or naming nothing.
      const open = { apiBoundA: 2, apiNothing: 2, workerBoundA: 2, workerNothing: 2 };
      for (const t of ["part_owned_1", "part_owned_2", "part_owned_sub", "part_owned_sub_0"]) expect(await readsOf(db, t, a), t).toEqual(open);
      const tail = "the lock takes no partitioned table";
      const why = [`part_owned is partitioned; ${tail}`, `part_owned_1 is a partition of part_owned; ${tail}`, `part_owned_2 is a partition of part_owned; ${tail}`,
        `part_owned_sub is partitioned, and a partition of part_owned; ${tail}`, `part_owned_sub_0 is a partition of part_owned_sub; ${tail}`];
      const before = await catalogOf(db);
      const said: string[] = [];
      const refused = await ground.setup(db, MIGRATOR_ROLE, { log: (m) => said.push(m) })
        .then((r) => `not refused: ${JSON.stringify(r.lock)}`, (e: Error) => e.message);
      expect({
        census: (await plantAndCensus(db, [])).sort(),
        api: await verdictOf(db, "ohmail_api", { role: "ohmail_api" }).then((v) => ({ verdict: v.verdict, why: v.why })),
        worker: await verdictOf(db, "ohmail_worker", { role: "ohmail_worker" }).then((v) => ({ verdict: v.verdict, why: v.why })),
        refused: why.every((w) => refused.includes(`lock: LOCK_DRIFT tables.partitioned ${w.replace(" is ", ": ")}; nothing was written`)),
        // Refused before it writes: no repair is said that a rollback then takes back.
        repairsSaid: said.filter((m) => m.startsWith("lock: repair:")),
        unchanged: await catalogOf(db) === before,
      }).toEqual({
        census: [...why.map((w) => `LOCK_DRIFT tables.partitioned ${w.replace(" is ", ": ")}`),
          "LOCK_DRIFT policies.foreign part_owned.lock_account: a policy the list does not name"].sort(),
        api: { verdict: "broken", why: [...why, "the policies naming ohmail_api are not the list's"] },
        worker: { verdict: "broken", why: [...why, "the policies naming ohmail_worker are not the list's"] },
        refused: true,
        repairsSaid: [],
        unchanged: true,
      });
      // Asked for the first time, over a store that holds a partitioned table: refused as well, nothing written.
      const first = await ground.clone("unlocked", "part_first");
      const [fa, fb] = await twoAccounts(first);
      await plantAndCensus(first, PARTED(fa, fb));
      await expect(ground.setup(first, MIGRATOR_ROLE, { lock: "apply" })).rejects
        .toThrow(`lock: LOCK_DRIFT tables.partitioned part_owned: partitioned; ${tail}; nothing was written`);
      expect(await lockOf(first)).toEqual({ schema: false, policies: 0, underRls: 0 });
    }, CASE_MS);

    /** The listed policies that call the reader `name`, as `table.policy`. */
    const calling = (name: string): string[] => policyList()
      .filter((r) => `${r.using ?? ""} ${r.check ?? ""}`.includes(`ohmail.${name}()`)).map((r) => `${r.table}.${r.name}`);
    const missingLines = (keys: string[]): string[] => keys.map((k) => `LOCK_DRIFT policies.missing ${k}`);
    const madeLines = (keys: string[]): string[] => keys.map((k) => `policy ${k} was missing: made`);
    /** A listed policy dropped and made again by `create`, with the comment the step wrote on it kept. */
    const remake = (table: string, name: string, create: string): string => `do $plant$ declare c text := pg_catalog.obj_description(
        (select p.oid from pg_catalog.pg_policy p where p.polrelid = 'public.${table}'::regclass and p.polname = '${name}'), 'pg_policy');
      begin drop policy ${name} on public.${table}; ${create}; execute pg_catalog.format('comment on policy ${name} on public.${table} is %L', c); end $plant$`;
    const KEY_BODY = LOCK_READERS.find((r) => r.name === "current_key")!.body;
    const OFF = "ohmail.lock off since=2026-11-15T10:00:00.000Z by=ohmail_migrator why=test";
    const drift = (arm: string, subject: string, detail: string): string => `LOCK_DRIFT ${arm} ${subject}: ${detail}`;
    /** Code on `table` that runs with its owner's rights: the census's line, and the check's reason. */
    const PAST_THE_LOCK = "runs with its owner's rights, past the lock";
    const calls = (what: string, routine: string): string => `${what} calls the SECURITY DEFINER routine ${routine}, which ${PAST_THE_LOCK}`;
    const codeLine = (table: string, what: string): string => drift("tables.code", table, what);
    const codeWhy = (table: string, what: string): string => `on ${table}, ${what}`;

    /**
     * EVERY CLAUSE OF THE CENSUS, each planted on a clone of the locked ground: the exact lines it
     * reads, and what the next setup does, a repair (and a clean census after) or a refusal.
     */
    interface Clause {
      readonly arm: string;
      readonly plant: (db: string) => string[];
      readonly asSuper?: boolean;
      readonly lines: (db: string) => string[];
      readonly setup: { readonly repaired: readonly string[] } | { readonly refused: RegExp };
      /** Statements, as the superuser, that undo a plant the whole server holds. */
      readonly undo?: readonly string[];
      /** The census after the setup mended it, where that is not clean: the views it made again stand ungranted until the roles' apply. */
      readonly after?: readonly string[];
    }
    const CLAUSES: Clause[] = [
      { arm: "tables.column, a column the map does not name", plant: () => ["alter table public.waitlist add column account_id uuid"],
        lines: () => [drift("tables.column", "waitlist", "account_id present where the map says otherwise"), "LOCK_DRIFT policies.missing waitlist.lock_account"],
        setup: { refused: /lock: LOCK_DRIFT tables\.column waitlist: account_id present/ } },
      { arm: "tables.column, a column the map names and the table lost", plant: () => ["alter table public.erased_bearers drop column account_id cascade"],
        lines: () => [drift("tables.column", "erased_bearers", "account_id missing where the map says otherwise")],
        setup: { refused: /lock: LOCK_DRIFT tables\.column erased_bearers: account_id missing/ } },
      { arm: "tables.column, an operations table with the account", plant: () => ["alter table public.auth_throttle add column account_id uuid"],
        lines: () => [drift("tables.column", "auth_throttle", "account_id present where the map says otherwise"),
          drift("tables.column", "auth_throttle", "an operations table carries account_id")],
        setup: { refused: /lock: LOCK_DRIFT tables\.column auth_throttle: an operations table carries account_id/ } },
      { arm: "tables.flags, an operations table under row security", plant: () => ["alter table public.auth_throttle enable row level security"],
        lines: () => [drift("tables.flags", "auth_throttle", "an operations table under row security")],
        setup: { refused: /lock: LOCK_DRIFT tables\.flags auth_throttle: an operations table under row security/ } },
      { arm: "tables.gone", plant: () => ["drop table public.worker_heartbeats"],
        lines: () => [drift("tables.gone", "worker_heartbeats", "a listed table is not in the catalog")],
        setup: { refused: /lock: LOCK_DRIFT tables\.gone worker_heartbeats/ } },
      { arm: "policies.shape, restrictive", plant: () => [remake("accounts", "lock_worker_wide", "create policy lock_worker_wide on public.accounts as restrictive for select to ohmail_worker using (true)")],
        lines: () => [drift("policies.shape", "accounts.lock_worker_wide", "restrictive")],
        setup: { repaired: ["policy accounts.lock_worker_wide is not as it was made: made again"] } },
      { arm: "policies.shape, the verb", plant: () => [remake("accounts", "lock_worker_wide", "create policy lock_worker_wide on public.accounts for all to ohmail_worker using (true)")],
        lines: () => [drift("policies.shape", "accounts.lock_worker_wide", "for ALL, the list says SELECT"),
          drift("policies.altered", "accounts.lock_worker_wide", "its expression is not what was made")],
        setup: { repaired: ["policy accounts.lock_worker_wide is not as it was made: made again"] } },
      { arm: "policies.roles", plant: () => ["alter policy lock_account on public.messages to ohmail_api"],
        lines: () => [drift("policies.roles", "messages.lock_account", "to ohmail_api"), drift("policies.altered", "messages.lock_account", "its expression is not what was made")],
        setup: { repaired: ["policy messages.lock_account is not as it was made: made again"] } },
      { arm: "policies.roles, a listed policy moved to PUBLIC", plant: () => ["alter policy lock_account on public.messages to public"],
        lines: () => [drift("policies.roles", "messages.lock_account", "to public"), drift("policies.altered", "messages.lock_account", "its expression is not what was made")],
        setup: { repaired: ["policy messages.lock_account is not as it was made: made again"] } },
      // One role whose name is the two logins' names joined by a comma is not the two logins: the roles are compared as a list.
      { arm: "policies.roles, a listed policy moved to one role named as the two logins joined", asSuper: true,
        plant: () => ["create role \"ohmail_api,ohmail_worker\"", "alter policy lock_account on public.messages to \"ohmail_api,ohmail_worker\""],
        lines: () => [drift("policies.roles", "messages.lock_account", "to ohmail_api,ohmail_worker"), drift("policies.altered", "messages.lock_account", "its expression is not what was made")],
        setup: { repaired: ["policy messages.lock_account is not as it was made: made again"] },
        undo: ["alter policy lock_account on public.messages to ohmail_api, ohmail_worker", "drop role \"ohmail_api,ohmail_worker\""] },
      { arm: "policies.unrecorded", plant: () => ["comment on policy lock_account on public.messages is null"],
        lines: () => [drift("policies.unrecorded", "messages.lock_account", "no record of how it was made")],
        setup: { repaired: ["policy messages.lock_account is not as it was made: made again"] } },
      { arm: "policies.listed", plant: () => [`do $plant$ declare c text := pg_catalog.obj_description((select p.oid from pg_catalog.pg_policy p
          where p.polrelid = 'public.messages'::regclass and p.polname = 'lock_account'), 'pg_policy');
        begin execute pg_catalog.format('comment on policy lock_account on public.messages is %L',
          pg_catalog.split_part(c, ' ', 1) || ' ' || pg_catalog.repeat('0', 64) || ' ' || pg_catalog.split_part(c, ' ', 3)); end $plant$`],
        lines: () => [drift("policies.listed", "messages.lock_account", "made from another version of the list")],
        // A row of the list that changed is made again as the list's, not as a repair.
        setup: { repaired: [] } },
      { arm: "schema.missing", plant: () => ["drop schema ohmail cascade"],
        lines: () => ["LOCK_DRIFT schema.missing ohmail", ...ACCOUNT_VIEWS.map((v) => `LOCK_DRIFT views.missing ${viewName(v)}`),
          ...missingLines([...new Set([...calling("current_account"), ...calling("current_key")])])],
        setup: { repaired: ["schema ohmail was missing: made", "reader ohmail.current_account was missing: made", "reader ohmail.current_key was missing: made",
          ...ACCOUNT_VIEWS.map((v) => `view ${viewName(v)} was missing: made`), ...madeLines([...new Set([...calling("current_account"), ...calling("current_key")])])] },
        after: ungrantedLines() },
      // USAGE on the readers' schema: the two logins' is the rule's while one of the account's views stands there; no other role's is.
      { arm: "schema.usage", plant: () => ["grant usage on schema ohmail to ohmail_admin"],
        lines: () => [drift("schema.usage", "ohmail", "ohmail_admin holds USAGE")],
        setup: { refused: /the runtime roles' check refused: ROLES_DRIFT [^\n]*ohmail_admin/ } },
      { arm: "schema.objects, a routine, and one of a reader's name that takes an argument",
        plant: () => ["create function ohmail.extra() returns int language sql as 'select 1'",
          "create function ohmail.current_account(x int) returns uuid language sql stable as 'select null::uuid'"],
        lines: () => [drift("schema.objects", "ohmail", "routine current_account(x integer)"), drift("schema.objects", "ohmail", "routine extra()")],
        // A login may run them: the runtime roles' check refuses them before the step writes.
        setup: { refused: /the runtime roles' check refused: ROLES_DRIFT EXECUTE on the routine ohmail\.extra\(\): role ohmail_api may run it in schema ohmail/ } },
      { arm: "schema.objects, a relation and a type", plant: () => ["create table ohmail.extra (id int)", "create type ohmail.mood as enum ('calm')"],
        lines: () => [drift("schema.objects", "ohmail", "relation extra"), drift("schema.objects", "ohmail", "type mood")],
        // A relation the rule does not name there: the runtime roles' check refuses it before the step writes.
        setup: { refused: /the runtime roles' check refused: ROLES_DRIFT [^\n]*ohmail\.extra/ } },
      { arm: "marker.unreadable", plant: () => ["comment on schema ohmail is 'the lock is off, trust me'"],
        lines: () => [drift("marker.unreadable", "ohmail", "its comment is no marker")],
        setup: { refused: /lock: LOCK_DRIFT marker\.unreadable ohmail/ } },
      { arm: "marker.stale", plant: () => [`comment on schema ohmail is '${OFF}'`],
        lines: () => [drift("marker.stale", "ohmail", "the marker says off and every table is locked"),
          ...lockedTables().map((t) => drift("tables.flags", t, "on=true forced=true while the lock is off"))],
        setup: { refused: /lock: LOCK_DRIFT marker\.stale ohmail/ } },
      { arm: "readers.missing", plant: () => ["drop function ohmail.current_key() cascade"],
        lines: () => ["LOCK_DRIFT readers.missing ohmail.current_key", ...missingLines(calling("current_key"))],
        setup: { repaired: ["reader ohmail.current_key was missing: made", ...madeLines(calling("current_key"))] } },
      { arm: "readers.differ, body",
        plant: () => ["create or replace function ohmail.current_account() returns pg_catalog.uuid language sql stable parallel safe as $r$select null::pg_catalog.uuid$r$"],
        lines: () => [drift("readers.differ", "ohmail.current_account", "body")], setup: { repaired: ["reader ohmail.current_account made again: body"] } },
      { arm: "readers.differ, volatility", plant: () => ["alter function ohmail.current_account() volatile"],
        lines: () => [drift("readers.differ", "ohmail.current_account", "volatility")], setup: { repaired: ["reader ohmail.current_account made again: volatility"] } },
      { arm: "readers.differ, parallel", plant: () => ["alter function ohmail.current_account() parallel unsafe"],
        lines: () => [drift("readers.differ", "ohmail.current_account", "parallel")], setup: { repaired: ["reader ohmail.current_account made again: parallel"] } },
      // The logins hold USAGE on the readers' schema while the views stand: a definer there is one they may run by name, and the roles' check refuses it first.
      { arm: "readers.differ, security definer", plant: () => ["alter function ohmail.current_account() security definer"],
        lines: () => [drift("readers.differ", "ohmail.current_account", "security definer")],
        setup: { refused: /the runtime roles' check refused: ROLES_DRIFT EXECUTE on the SECURITY DEFINER routine ohmail\.current_account\(\): role ohmail_api can run it/ } },
      { arm: "readers.differ, settings", plant: () => ["alter function ohmail.current_account() set search_path = pg_catalog"],
        lines: () => [drift("readers.differ", "ohmail.current_account", "settings")], setup: { repaired: ["reader ohmail.current_account made again: settings"] } },
      { arm: "readers.differ, language",
        plant: () => ["create or replace function ohmail.current_key() returns pg_catalog.text language plpgsql stable parallel safe as $r$begin return null; end$r$"],
        lines: () => [drift("readers.differ", "ohmail.current_key", "body, language")], setup: { repaired: ["reader ohmail.current_key made again: body, language"] } },
      { arm: "readers.differ, return type",
        plant: () => ["drop function ohmail.current_key() cascade",
          `create function ohmail.current_key() returns pg_catalog.varchar language sql stable parallel safe as $r$${KEY_BODY}$r$`],
        lines: () => [drift("readers.differ", "ohmail.current_key", "return type"), ...missingLines(calling("current_key"))],
        setup: { refused: /lock: LOCK_DRIFT readers\.differ ohmail\.current_key: return type; nothing was written/ } },
      { arm: "readers.differ, owner", asSuper: true, plant: () => [`alter function ohmail.current_account() owner to ${ground.server.superuser}`],
        lines: () => [drift("readers.differ", "ohmail.current_account", "owner")],
        setup: { refused: /lock: LOCK_DRIFT readers\.differ ohmail\.current_account: owner; nothing was written/ } },
      { arm: "readers.differ, privileges", plant: () => ["revoke execute on function ohmail.current_account() from public"],
        lines: () => [drift("readers.differ", "ohmail.current_account", "privileges")],
        setup: { refused: /lock: LOCK_DRIFT readers\.differ ohmail\.current_account: privileges; nothing was written/ } },
      { arm: "readers.differ, strict", plant: () => ["alter function ohmail.current_account() strict"],
        lines: () => [drift("readers.differ", "ohmail.current_account", "strict")], setup: { repaired: ["reader ohmail.current_account made again: strict"] } },
      { arm: "readers.differ, kind",
        plant: () => ["drop function ohmail.current_key() cascade", "create procedure ohmail.current_key() language sql as $r$select 1$r$"],
        lines: () => [drift("readers.differ", "ohmail.current_key", "body, volatility, parallel, return type, kind"), ...missingLines(calling("current_key"))],
        setup: { refused: /lock: LOCK_DRIFT readers\.differ ohmail\.current_key: body, volatility, parallel, return type, kind; nothing was written/ } },
      { arm: "settings.binding, on a role", asSuper: true, plant: () => ["alter role ohmail_api set ohmail.account = '00000000-0000-4000-8000-000000000001'"],
        lines: () => [drift("settings.binding", "ohmail_api/-/ohmail.account", "the binding's setting stands on a role or a database")],
        // The roles' own check reads a login's settings first.
        setup: { refused: /lock: the runtime roles' check refused: ROLES_DRIFT role ohmail_api: the setting ohmail\.account is set and the rule writes no such setting/ },
        undo: ["alter role ohmail_api reset ohmail.account"] },
      { arm: "settings.binding, on this database", asSuper: true, plant: (db) => [`alter database "${db}" set ohmail.key = 'x'`],
        lines: (db) => [drift("settings.binding", `-/${db}/ohmail.key`, "the binding's setting stands on a role or a database")],
        setup: { refused: /lock: LOCK_DRIFT settings\.binding -\/clause_\d+\/ohmail\.key/ } },
      { arm: "grants.ohmail_admin, a grant no policy reads", plant: () => ["grant select (id) on public.messages to ohmail_admin"],
        lines: () => [drift("grants.ohmail_admin", "messages", "SELECT granted and no policy names the role")],
        setup: { refused: /lock: LOCK_DRIFT grants\.ohmail_admin messages: SELECT granted and no policy names the role; nothing was written/ } },
      { arm: "grants.ohmail_admin, a policy nothing is granted for", plant: () => ["revoke select on public.accounts from ohmail_admin"],
        lines: () => [drift("grants.ohmail_admin", "accounts", "a SELECT policy names the role and nothing is granted")],
        setup: { refused: /lock: LOCK_DRIFT grants\.ohmail_admin accounts: a SELECT policy names the role and nothing is granted; nothing was written/ } },
      { arm: "grants.plane_runtime, a grant no policy reads", plant: () => ["grant select on public.messages to plane_runtime"],
        lines: () => [drift("grants.plane_runtime", "messages", "SELECT granted and no policy names the role")],
        setup: { refused: /lock: LOCK_DRIFT grants\.plane_runtime messages: SELECT granted and no policy names the role; nothing was written/ } },
      { arm: "grants.plane_runtime, a policy nothing is granted for", plant: () => ["revoke insert on public.audit_log from plane_runtime"],
        lines: () => [drift("grants.plane_runtime", "audit_log", "an INSERT policy names the role and nothing is granted")],
        setup: { refused: /lock: LOCK_DRIFT grants\.plane_runtime audit_log: an INSERT policy names the role and nothing is granted; nothing was written/ } },
      // Code on a table that runs with its owner's rights, one arm of the census's statement each.
      { arm: "tables.code, a rule", plant: () => ["create rule note_insert as on insert to public.audit_log do also notify note_insert"],
        lines: () => [codeLine("audit_log", `the rule note_insert ${PAST_THE_LOCK}`)],
        setup: { refused: /lock: LOCK_DRIFT tables\.code audit_log: the rule note_insert runs with its owner's rights, past the lock; nothing was written/ } },
      { arm: "tables.code, a trigger: its routine, or one its condition calls", plant: () => ["create schema side_code",
        "create function side_code.fire() returns trigger language plpgsql security definer as $f$begin return new; end$f$",
        "create trigger fire_on_insert after insert on public.audit_log for each row execute function side_code.fire()",
        "create function side_code.plain() returns trigger language plpgsql as $f$begin return new; end$f$",
        "create function side_code.yes() returns boolean language sql security definer as $f$select true$f$",
        "create trigger when_yes before update on public.cal_settings for each row when (side_code.yes()) execute function side_code.plain()"],
        lines: () => [codeLine("audit_log", calls("the trigger fire_on_insert", "side_code.fire()")), codeLine("cal_settings", calls("the trigger when_yes", "side_code.yes()"))],
        setup: { refused: /lock: LOCK_DRIFT tables\.code audit_log: the trigger fire_on_insert calls the SECURITY DEFINER routine side_code\.fire\(\), which runs with its owner's rights, past the lock; nothing was written/ } },
      { arm: "tables.code, a default and a generated column", plant: () => ["create schema side_code",
        "create function side_code.word() returns text language sql security definer as $f$select 'x'$f$",
        "alter table public.cal_settings alter column second_zone set default side_code.word()",
        "create function side_code.word_of(pg_catalog.uuid) returns text language sql immutable security definer as $f$select $1::text$f$",
        "alter table public.cal_settings add column account_word text generated always as (side_code.word_of(account_id)) stored"],
        lines: () => [codeLine("cal_settings", calls("the default of second_zone", "side_code.word()")),
          codeLine("cal_settings", calls("the generated column account_word", "side_code.word_of(uuid)"))],
        setup: { refused: /lock: LOCK_DRIFT tables\.code cal_settings: the generated column account_word calls the SECURITY DEFINER routine side_code\.word_of\(uuid\)/ } },
      { arm: "tables.code, a constraint", plant: () => ["create schema side_code",
        "create function side_code.fits(pg_catalog.uuid) returns boolean language sql security definer as $f$select true$f$",
        "alter table public.cal_settings add constraint fits_account check (side_code.fits(account_id))"],
        lines: () => [codeLine("cal_settings", calls("the constraint fits_account", "side_code.fits(uuid)"))],
        setup: { refused: /lock: LOCK_DRIFT tables\.code cal_settings: the constraint fits_account calls the SECURITY DEFINER routine side_code\.fits\(uuid\)/ } },
      { arm: "tables.code, an index", plant: () => ["create schema side_code",
        "create function side_code.word_of(pg_catalog.uuid) returns text language sql immutable security definer as $f$select $1::text$f$",
        "create index account_word on public.cal_settings (side_code.word_of(account_id))"],
        lines: () => [codeLine("cal_settings", calls("the index account_word", "side_code.word_of(uuid)"))],
        setup: { refused: /lock: LOCK_DRIFT tables\.code cal_settings: the index account_word calls the SECURITY DEFINER routine side_code\.word_of\(uuid\)/ } },
    ];

    for (const [i, c] of CLAUSES.entries()) {
      it(`the census's clause ${c.arm}: its exact lines, and the next setup ${"refused" in c.setup ? "refuses" : "mends it"}`, async () => {
        const db = await ground.clone("ground", `clause_${i}`);
        const su = ground.connectAs(db);
        try {
          const planter = c.asSuper === true ? su : ground.connectAs(db, MIGRATOR_ROLE);
          try { for (const s of c.plant(db)) await planter.unsafe(s); } finally { if (planter !== su) await planter.end({ timeout: 5 }); }
          expect((await plantAndCensus(db, [])).sort()).toEqual([...c.lines(db)].sort());
          if ("refused" in c.setup) {
            await expect(ground.setup(db, MIGRATOR_ROLE)).rejects.toThrow(c.setup.refused);
          } else {
            const report = await ground.setup(db, MIGRATOR_ROLE);
            expect([...report.lock!.repaired].sort()).toEqual([...c.setup.repaired].sort());
            expect((await plantAndCensus(db, [])).sort()).toEqual([...(c.after ?? [])].sort());
          }
        } finally {
          for (const s of c.undo ?? []) await su.unsafe(s);
          await su.end({ timeout: 5 });
        }
      }, CASE_MS);
    }

    /**
     * THE ACCOUNT'S VIEWS, AS THE STEP MAKES THEM: in the readers' schema, the migrator's, each carrying the
     * account's condition and the reader's (the two runtime logins by `current_user`, as the catalog stores
     * it) and the check option alone, recorded as a policy is, and born with no grant.
     */
    it("the step made the account's three views as listed: the migrator's, the reader's condition and the check option alone in the catalog, and recorded", async () => {
      const sql = ground.connectAs("ground", MIGRATOR_ROLE);
      try {
        const got = await sql.unsafe(`select c.relname::text as name, c.relkind::text as kind, pg_get_userbyid(c.relowner)::text as owner,
            c.reloptions::text[] as options, c.relacl::text as acl, pg_get_viewdef(c.oid) as text, obj_description(c.oid, 'pg_class') as comment
          from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'ohmail' and c.relkind = 'v' order by 1`);
        expect(got.map((r) => ({ name: r.name, kind: r.kind, owner: r.owner, options: r.options, recorded: String(r.comment).startsWith("ohmail-lock ") })))
          .toEqual(ACCOUNT_VIEWS.map((v) => ({ name: v.name, kind: "v", owner: MIGRATOR_ROLE, options: ["check_option=cascaded"], recorded: true }))
            .sort((x, y) => (x.name < y.name ? -1 : 1)));
        for (const r of got) {
          expect(String(r.text), String(r.name)).toContain("(CURRENT_USER = ANY (ARRAY['ohmail_api'::name, 'ohmail_worker'::name]))");
          expect(String(r.text), String(r.name)).not.toMatch(/SESSION_USER/i);
        }
        expect(String(got.find((r) => r.name === "message_search_words")!.text)).toContain("((account_id)::text = (ohmail.current_account())::text)");
      } finally {
        await sql.end({ timeout: 5 });
      }
    }, CASE_MS);

    /** A listed view made again by hand over itself, its record kept: another reader's condition, no check option, or options of its own. */
    const remakeView = (name: string, change: { readonly reader?: string; readonly key?: string; readonly option?: string; readonly with?: string } = {}): string => {
      const v = ACCOUNT_VIEWS.find((x) => x.name === name)!;
      const where = [change.key ?? v.key, change.reader ?? readerCondition()].filter((x) => x !== "").join(" and ");
      return `create or replace view ${viewName(v)}${change.with ?? ""} as select ${v.columns.map((c) => `"${c}"`).join(", ")} from public."${v.table}"`
        + `${where === "" ? "" : ` where ${where}`}${change.option ?? " with check option"}`;
    };
    /**
     * EVERY WAY ONE OF THE ACCOUNT'S VIEWS IS NOT AS LISTED, each planted on a clone of the locked ground: the
     * census's exact lines, the check for each login, and what the next setup does.
     */
    interface ViewPlant {
      readonly name: string;
      readonly asSuper?: boolean;
      readonly plant: string[];
      readonly lines: readonly string[];
      /** The check's reasons, the same for both logins; none is `locked`. */
      readonly why: readonly string[];
      readonly setup: { readonly repaired: readonly string[] } | { readonly refused: RegExp };
      /** The census after the setup mended it, where that is not clean (a view it made again stands ungranted until the roles' apply). */
      readonly after?: readonly string[];
      /** Statements, as the superuser on the plant's database, that undo what the whole server holds (a role the plant made). */
      readonly undo?: readonly string[];
    }
    const viewDiffers = (name: string, words: string): { lines: string[]; why: string[] } =>
      ({ lines: [drift("views.differ", `ohmail.${name}`, words)], why: [`the view ohmail.${name} differs: ${words}`] });
    /** Every verb `grant all` gives on a view on this major (17 adds MAINTAIN), in the order the census reads them: by name. */
    const ALL_VERBS = ["DELETE", "INSERT", ...(major >= 17 ? ["MAINTAIN"] : []), "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"];
    /** The check's reason for a right on a listed view beyond the two logins' SELECT, up to what is held. */
    const BEYOND = (name: string): string => `the view ohmail.${name} is granted beyond the two logins' SELECT: `;
    const VIEW_PLANTS: ViewPlant[] = [
      { name: "the reader's condition taken out", plant: [remakeView("messages", { reader: "" })], ...viewDiffers("messages", "text"),
        setup: { repaired: ["view ohmail.messages is not as it was made: made again (text)"] } },
      { name: "the account's condition taken out", plant: [remakeView("message_search", { key: "" })], ...viewDiffers("message_search", "text"),
        setup: { repaired: ["view ohmail.message_search is not as it was made: made again (text)"] } },
      { name: "another role named beside a login", plant: [remakeView("message_search", { reader: "current_user in ('ohmail_api', 'ohmail_admin')" })],
        ...viewDiffers("message_search", "text"), setup: { repaired: ["view ohmail.message_search is not as it was made: made again (text)"] } },
      { name: "session_user in place of current_user", plant: [remakeView("message_search_words", { reader: "session_user in ('ohmail_api', 'ohmail_worker')" })],
        ...viewDiffers("message_search_words", "text"), setup: { repaired: ["view ohmail.message_search_words is not as it was made: made again (text)"] } },
      { name: "the check option taken out", plant: [remakeView("messages", { option: "" })], ...viewDiffers("messages", "options"),
        setup: { repaired: ["view ohmail.messages is not as it was made: made again (options)"] } },
      { name: "a barrier", plant: [remakeView("message_search_words", { with: " with (security_barrier)" })], ...viewDiffers("message_search_words", "options"),
        setup: { repaired: ["view ohmail.message_search_words is not as it was made: made again (options)"] } },
      { name: "an invoker's rights", plant: ["alter view ohmail.messages set (security_invoker = true)"], ...viewDiffers("messages", "options"),
        setup: { repaired: ["view ohmail.messages is not as it was made: made again (options)"] } },
      { name: "its record taken away", plant: ["comment on view ohmail.messages is null"], ...viewDiffers("messages", "unrecorded"),
        setup: { repaired: ["view ohmail.messages is not as it was made: made again (unrecorded)"] } },
      { name: "made from another version of the list", plant: [`do $plant$ declare c text := obj_description('ohmail.messages'::regclass, 'pg_class');
          begin execute format('comment on view ohmail.messages is %L', split_part(c, ' ', 1) || ' ' || repeat('0', 64) || ' ' || split_part(c, ' ', 3)); end $plant$`],
        ...viewDiffers("messages", "listed"), setup: { repaired: [] } },
      { name: "one dropped", plant: ["drop view ohmail.message_search_words"],
        lines: [drift("views.missing", "ohmail.message_search_words", "").replace(/: $/, "")], why: [],
        setup: { repaired: ["view ohmail.message_search_words was missing: made"] }, after: ungrantedLines(["message_search_words"], false) },
      // The list's first columns alone, in order and type: `create or replace view` adds the rest, as a repair here.
      { name: "its columns the list's first ones alone", plant: ["drop view ohmail.message_search", `create view ohmail.message_search as select message_id, account_id
          from public.message_search where account_id = ohmail.current_account() and ${readerCondition()} with check option`],
        lines: [drift("views.differ", "ohmail.message_search", "fewer columns, unrecorded"), ...ungrantedLines(["message_search"], false)],
        why: ["the view ohmail.message_search differs: fewer columns, unrecorded"],
        setup: { repaired: ["view ohmail.message_search is not as it was made: made again (fewer columns, unrecorded)"] },
        after: ungrantedLines(["message_search"], false) },
      // Columns in another order: Postgres cannot make it again over itself; the refusal says the remedy.
      { name: "its columns another list", plant: ["drop view ohmail.message_search", `create view ohmail.message_search as select account_id, message_id
          from public.message_search where account_id = ohmail.current_account() and ${readerCondition()} with check option`],
        lines: [drift("views.differ", "ohmail.message_search", "columns, unrecorded"), ...ungrantedLines(["message_search"], false)],
        why: ["the view ohmail.message_search differs: columns, unrecorded"],
        setup: { refused: /lock: LOCK_DRIFT views\.differ ohmail\.message_search: columns, unrecorded; Postgres cannot make it again over other columns: drop it first \(DROP VIEW IF EXISTS ohmail\.message_search, in the release's journal or by hand\), in a closed window; the step then makes it again and the roles' apply grants it; nothing was written/ } },
      { name: "its name taken by a table", plant: ["drop view ohmail.messages", "create table ohmail.messages (id int)"], ...viewDiffers("messages", "kind"),
        setup: { refused: /ROLES_DRIFT [^\n]*ohmail\.messages|lock: LOCK_DRIFT views\.differ ohmail\.messages: kind; nothing was written/ } },
      { name: "owned by another role", asSuper: true, plant: ["alter view ohmail.message_search owner to ohmail_admin"], ...viewDiffers("message_search", "owner"),
        setup: { refused: /ROLES_DRIFT [^\n]*ohmail\.message_search|lock: LOCK_DRIFT views\.differ ohmail\.message_search: owner; nothing was written/ } },
      { name: "a view the list does not name", plant: ["create view ohmail.side_view as select 1 as x"],
        lines: [drift("views.foreign", "ohmail.side_view", "a view the list does not name")], why: [],
        setup: { refused: /ROLES_DRIFT [^\n]*ohmail\.side_view|lock: LOCK_DRIFT views\.foreign ohmail\.side_view: a view the list does not name; nothing was written/ } },
      { name: "granted to another role", plant: ["grant select on ohmail.messages to ohmail_admin"],
        lines: [drift("views.grants", "ohmail.messages", "ohmail_admin holds SELECT")], why: [`${BEYOND("messages")}ohmail_admin holds SELECT`],
        setup: { refused: /the runtime roles' check refused: ROLES_DRIFT [^\n]*ohmail_admin/ } },
      { name: "granted to PUBLIC", plant: ["grant select on ohmail.message_search to public"],
        lines: [drift("views.grants", "ohmail.message_search", "public holds SELECT")], why: [`${BEYOND("message_search")}public holds SELECT`],
        setup: { refused: /the runtime roles' check refused: ROLES_DRIFT / } },
      { name: "a column granted to another role", plant: ["grant select (account_id) on ohmail.messages to plane_runtime"],
        lines: [drift("views.grants", "ohmail.messages", "plane_runtime holds SELECT on its column account_id")],
        why: [`${BEYOND("messages")}plane_runtime holds SELECT on its column account_id`],
        setup: { refused: /the runtime roles' check refused: ROLES_DRIFT [^\n]*plane_runtime/ } },
      // Any right on a listed view beyond the rule's is broken whoever reads: through a
      // view an insert ... on conflict do update by a login holding both verbs takes another account's row, and a holder of the
      // grant option hands the view to anybody. The roles' check refuses each grant before the step.
      { name: "a write verb to a login", plant: ["grant update on ohmail.messages to ohmail_api"],
        lines: [drift("views.grants", "ohmail.messages", "ohmail_api holds UPDATE")], why: [`${BEYOND("messages")}ohmail_api holds UPDATE`],
        setup: { refused: /the runtime roles' check refused: ROLES_DRIFT UPDATE on ohmail\.messages: a direct grant to role ohmail_api outside the rule/ } },
      { name: "a login's grant option", plant: ["grant select on ohmail.messages to ohmail_api with grant option"],
        lines: [drift("views.grants", "ohmail.messages", "ohmail_api holds SELECT with the grant option")],
        why: [`${BEYOND("messages")}ohmail_api holds SELECT with the grant option`],
        setup: { refused: /the runtime roles' check refused: ROLES_DRIFT [^\n]*ohmail_api/ } },
      { name: "a column granted to a login", plant: ["grant update (subject) on ohmail.messages to ohmail_api"],
        lines: [drift("views.grants", "ohmail.messages", "ohmail_api holds UPDATE on its column subject")],
        why: [`${BEYOND("messages")}ohmail_api holds UPDATE on its column subject`],
        setup: { refused: /the runtime roles' check refused: ROLES_DRIFT [^\n]*ohmail_api/ } },
      // A role whose name holds a colon, every verb on a view and USAGE on the schema: its rights
      // are another role's, never a login's, however its name reads. The census names each, quoted, and both logins read broken.
      { name: "every verb to a role named like a login's right", asSuper: true,
        plant: ["create role \"ohmail_api:SELECT\" login", "grant usage on schema ohmail to \"ohmail_api:SELECT\"", "grant all on ohmail.messages to \"ohmail_api:SELECT\""],
        lines: ALL_VERBS.map((p) => drift("views.grants", "ohmail.messages", `"ohmail_api:SELECT" holds ${p}`)),
        why: [`${BEYOND("messages")}${ALL_VERBS.map((p) => `"ohmail_api:SELECT" holds ${p}`).join("; ")}`],
        setup: { refused: /ROLES_DRIFT [^\n]*ohmail_api:SELECT/ },
        undo: ["drop owned by \"ohmail_api:SELECT\"", "drop role \"ohmail_api:SELECT\""] },
      // CODE ON A LISTED VIEW (and the class beside it): a rule beside _RETURN, a trigger
      // and a default on a column. A rule or an INSTEAD OF trigger voids the check option for every holder of a verb; a definer
      // routine a trigger or a default calls runs with its owner's rights. `create or replace view` keeps each (seen on 16 and
      // 17), so the step refuses before it writes: by hand, drop it.
      { name: "a rule on insert, no write verb granted to anybody",
        plant: ["create rule riso_ins as on insert to ohmail.messages do instead update public.messages set subject = 'REWRITTEN BY A RULE'"],
        ...viewDiffers("messages", "code (the rule riso_ins on INSERT)"),
        setup: { refused: /lock: LOCK_DRIFT views\.differ ohmail\.messages: code \(the rule riso_ins on INSERT\)[^\n]*; nothing was written/ } },
      { name: "a rule on update, no write verb granted to anybody",
        plant: ["create rule riso_upd as on update to ohmail.message_search do instead update public.message_search set source = new.source"],
        ...viewDiffers("message_search", "code (the rule riso_upd on UPDATE)"),
        setup: { refused: /lock: LOCK_DRIFT views\.differ ohmail\.message_search: code \(the rule riso_upd on UPDATE\)[^\n]*; nothing was written/ } },
      { name: "an INSTEAD OF trigger calling a SECURITY DEFINER routine nobody may run, in a schema no login may use", asSuper: true,
        plant: ["create schema riso_t authorization ohmail_migrator", "set role ohmail_migrator",
          "create function riso_t.f() returns trigger language plpgsql security definer as $$ begin update public.messages set subject = 'TRIGGERED' where account_id <> new.account_id; return new; end $$",
          "revoke execute on function riso_t.f() from public", "create trigger riso_tr instead of insert on ohmail.messages for each row execute function riso_t.f()"],
        ...viewDiffers("messages", "code (the trigger riso_tr)"),
        setup: { refused: /lock: LOCK_DRIFT views\.differ ohmail\.messages: code \(the trigger riso_tr\)[^\n]*; nothing was written/ } },
      { name: "a statement trigger", asSuper: true,
        plant: ["create schema riso_s authorization ohmail_migrator", "set role ohmail_migrator",
          "create function riso_s.f() returns trigger language plpgsql as $$ begin return null; end $$",
          "create trigger riso_st before delete on ohmail.message_search_words for each statement execute function riso_s.f()"],
        ...viewDiffers("message_search_words", "code (the trigger riso_st)"),
        setup: { refused: /lock: LOCK_DRIFT views\.differ ohmail\.message_search_words: code \(the trigger riso_st\)[^\n]*; nothing was written/ } },
      { name: "a default on one of its columns", plant: ["alter view ohmail.messages alter column snippet set default 'by hand'"],
        ...viewDiffers("messages", "code (the default of snippet)"),
        setup: { refused: /lock: LOCK_DRIFT views\.differ ohmail\.messages: code \(the default of snippet\)[^\n]*; nothing was written/ } },
      // A SECURITY LABEL, on a view and on a column of one, as the catalog holds one a provider wrote. No provider is loaded on
      // these images and the statement is refused (below), so the superuser writes the catalog's row, which is what a provider's is.
      { name: "a security label on it", asSuper: true,
        plant: ["insert into pg_catalog.pg_seclabel (objoid, classoid, objsubid, provider, label) "
          + "values ('ohmail.messages'::regclass, 'pg_catalog.pg_class'::regclass, 0, 'riso', 'on the view')"],
        ...viewDiffers("messages", "label"),
        setup: { refused: /lock: LOCK_DRIFT views\.differ ohmail\.messages: label; by hand, take the label away; nothing was written/ } },
      { name: "a security label on one of its columns", asSuper: true,
        plant: ["insert into pg_catalog.pg_seclabel (objoid, classoid, objsubid, provider, label) "
          + "select 'ohmail.message_search_words'::regclass, 'pg_catalog.pg_class'::regclass, a.attnum, 'riso', 'on a column' "
          + "from pg_catalog.pg_attribute a where a.attrelid = 'ohmail.message_search_words'::regclass and a.attname = 'terms'"],
        ...viewDiffers("message_search_words", "label"),
        setup: { refused: /lock: LOCK_DRIFT views\.differ ohmail\.message_search_words: label; by hand, take the label away; nothing was written/ } },
    ];

    for (const [i, c] of VIEW_PLANTS.entries()) {
      it(`one of the account's views, ${c.name}: the census's lines, the check for each login, and the next setup ${"refused" in c.setup ? "refuses" : "mends it"}`, async () => {
        const db = await ground.clone("ground", `view_plant_${i}`);
        try {
          const planter = ground.connectAs(db, c.asSuper === true ? undefined : MIGRATOR_ROLE);
          try { for (const s of c.plant) await planter.unsafe(s).simple(); } finally { await planter.end({ timeout: 5 }); }
          const judged = async (role: string): Promise<object> => verdictOf(db, role, { role }).then((v) => ({ verdict: v.verdict, why: v.why }));
          const want = { verdict: c.why.length === 0 ? "locked" : "broken", why: [...c.why] };
          expect({ census: (await plantAndCensus(db, [])).sort(), api: await judged("ohmail_api"), worker: await judged("ohmail_worker") })
            .toEqual({ census: [...c.lines].sort(), api: want, worker: want });
          if ("refused" in c.setup) {
            await expect(ground.setup(db, MIGRATOR_ROLE)).rejects.toThrow(c.setup.refused);
            return;
          }
          const report = await ground.setup(db, MIGRATOR_ROLE);
          expect({ repaired: [...report.lock!.repaired].sort(), views: report.lock!.views }).toEqual({ repaired: [...c.setup.repaired].sort(), views: ACCOUNT_VIEWS.length });
          expect({ census: (await plantAndCensus(db, [])).sort(), api: await judged("ohmail_api") }).toEqual({ census: [...(c.after ?? [])].sort(), api: { verdict: "locked", why: [] } });
        } finally {
          if (c.undo !== undefined) {
            const su = ground.connectAs(db);
            try { for (const s of c.undo) await su.unsafe(s); } finally { await su.end({ timeout: 5 }); }
          }
        }
      }, CASE_MS);
    }

    /**
     * EVERYTHING ELSE POSTGRES LETS HANG ON A VIEW, OR WOULD CHANGE HOW IT ANSWERS (the class of the code above: something on a
     * listed view the census did not read). Read as drift, each above: a rule beside `_RETURN`, a trigger (INSTEAD OF or for each
     * statement), a default on a column, its owner, options, columns and text, and every right beyond the two logins' SELECT
     * (another verb, the grant option, a column grant, any other role), and a security label, by its row in the catalog (no
     * provider is loaded on these images, so the statement is refused here). Refused by Postgres on a view,
     * as the view's owner: what follows. Taken and harmless: a comment on one of its columns, and USAGE on its row type (PUBLIC's
     * already): neither gives a row or a write, the census is equal and both logins read locked.
     */
    /** A trigger's routine of the migrator's, in a schema of its own, made inside the statement's transaction. */
    const RISO_TRIGGER_FN = ["create schema riso_k", "create function riso_k.t() returns trigger language plpgsql as $$ begin return null; end $$"];
    const NOT_ON_A_VIEW: ReadonlyArray<{ what: string; asSuper?: boolean; before?: readonly string[]; statement: string; refused: RegExp }> = [
      { what: "a policy", statement: "create policy riso_p on ohmail.messages using (true)", refused: /"messages" is not a table/ },
      { what: "row security", statement: "alter table ohmail.messages enable row level security", refused: /cannot be performed on relation "messages"/ },
      { what: "forced row security", statement: "alter table ohmail.messages force row level security", refused: /cannot be performed on relation "messages"/ },
      { what: "a security label (no provider is loaded)", statement: "security label on view ohmail.messages is 'x'", refused: /no security label providers have been loaded/ },
      { what: "a security label on a column", statement: "security label on column ohmail.messages.subject is 'x'", refused: /no security label providers have been loaded/ },
      { what: "an index", statement: "create index riso_i on ohmail.messages (subject)", refused: /cannot create index on relation "messages"/ },
      { what: "extended statistics", statement: "create statistics riso_s on subject, snippet from ohmail.messages", refused: /cannot define statistics for relation "messages"/ },
      { what: "a publication", asSuper: true, statement: "create publication riso_pub for table ohmail.messages", refused: /cannot add relation "messages" to publication/ },
      { what: "a table inheriting it", statement: "create table public.riso_child () inherits (ohmail.messages)", refused: /inherited relation "messages" is not a table or foreign table/ },
      { what: "a column's statistics target", statement: "alter table ohmail.messages alter column subject set statistics 100", refused: /cannot be performed on relation "messages"/ },
      { what: "a column's options", statement: "alter table ohmail.messages alter column subject set (n_distinct = 5)", refused: /cannot be performed on relation "messages"/ },
      { what: "a column's storage", statement: "alter table ohmail.messages alter column subject set storage external", refused: /cannot be performed on relation "messages"/ },
      { what: "a replica identity", statement: "alter table ohmail.messages replica identity full", refused: /cannot be performed on relation "messages"/ },
      { what: "a constraint trigger", before: RISO_TRIGGER_FN, statement: "create constraint trigger riso_ct after insert on ohmail.messages for each row execute function riso_k.t()",
        refused: /"messages" is a view/ },
      { what: "a trigger disabled", before: [...RISO_TRIGGER_FN, "create trigger riso_tr instead of insert on ohmail.messages for each row execute function riso_k.t()"],
        statement: "alter table ohmail.messages disable trigger riso_tr", refused: /cannot be performed on relation "messages"/ },
      { what: "a rule disabled", statement: "alter table ohmail.messages disable rule \"_RETURN\"", refused: /cannot be performed on relation "messages"/ },
      { what: "a rule enabled always", statement: "alter table ohmail.messages enable always rule \"_RETURN\"", refused: /cannot be performed on relation "messages"/ },
      { what: "its _RETURN rule dropped", statement: "drop rule \"_RETURN\" on ohmail.messages", refused: /view ohmail\.messages requires it/ },
      { what: "a second rule on select", statement: `do $$ begin execute 'create rule riso_sel as on select to ohmail.messages do instead '
          || pg_catalog.rtrim(pg_catalog.pg_get_viewdef('ohmail.messages'::pg_catalog.regclass), ';'); end $$`, refused: /"messages" is already a view/ },
    ];

    it("the rest of what Postgres lets hang on a view: each refused on a view, as its owner; a comment on a column and USAGE on its row type taken and harmless", async () => {
      const db = await ground.clone("ground", "not_on_a_view");
      const refused: Record<string, string> = {};
      for (const n of NOT_ON_A_VIEW) {
        const c = ground.connectAs(db, n.asSuper === true ? undefined : MIGRATOR_ROLE);
        try {
          refused[n.what] = await c.begin(async (tx) => { for (const b of n.before ?? []) await tx.unsafe(b); await tx.unsafe(n.statement); return "taken"; })
            .then((t) => String(t), (e: Error) => (n.refused.test(e.message) ? "refused" : `refused otherwise: ${e.message}`));
        } finally {
          await c.end({ timeout: 5 });
        }
      }
      expect(refused).toEqual(Object.fromEntries(NOT_ON_A_VIEW.map((n) => [n.what, "refused"])));
      // Taken: a comment on a column of a view, and USAGE on a view's row type for a role of the host's. Neither reaches a row.
      await plantAndCensus(db, ["comment on column ohmail.messages.subject is 'by hand'", "grant usage on type ohmail.messages to ohmail_admin"]);
      const judged = async (role: string): Promise<object> => verdictOf(db, role, { role }).then((v) => ({ verdict: v.verdict, why: v.why }));
      const admin = ground.connectAs(db, "ohmail_admin");
      let staffReads: string;
      try { staffReads = await admin.unsafe("select count(*) from ohmail.messages").then(() => "read", (e: { code?: string }) => String(e.code)); }
      finally { await admin.end({ timeout: 5 }); }
      expect({ census: await plantAndCensus(db, []), api: await judged("ohmail_api"), worker: await judged("ohmail_worker"), staffReads })
        .toEqual({ census: [], api: { verdict: "locked", why: [] }, worker: { verdict: "locked", why: [] }, staffReads: "42501" });
    }, CASE_MS);

    /**
     * THE RECHECK'S DATABASE PLANTS (2026-11-15), each on a clone of the locked ground that holds a
     * row of each of two accounts in `cal_settings`: what each login reads there bound to A and
     * naming nothing, the census, the check judged for each login, and the next setup's answer;
     * and, where the setup mends it, the lock's reads and verdicts again.
     */
    interface RecheckPlant {
      readonly name: string;
      readonly asSuper?: boolean;
      readonly plant: (a: string, b: string) => string[];
      /** `cal_settings` as the API's login bound to A and naming nothing, then the worker's. */
      readonly reads: readonly [number, number, number, number];
      /** Reads past `cal_settings`: the login, bound to A or naming nothing, the statement, its rows, and its rows once mended. */
      readonly extra?: ReadonlyArray<readonly [string, "A" | "none", string, number, number?]>;
      readonly census: readonly string[];
      /**
       * The check's reasons, judged for each login; none is `locked`. Absent where the check, as
       * ruled, reads `public` alone: a side schema's objects are the roles' check's to refuse.
       */
      readonly api?: readonly string[];
      readonly worker?: readonly string[];
      readonly setup: { readonly repaired: readonly string[] } | { readonly refused: RegExp };
    }
    const ALTERED = "its expression is not what was made";
    const UNRECORDED = "no record of how it was made";
    const notAsListed = (role: string, detail: string, key = "cal_settings.lock_account"): string => `the policy ${key} naming ${role} is not as listed: ${detail}`;
    const namesDiffer = (role: string): string => `the policies naming ${role} are not the list's`;
    const MADE_AGAIN = { repaired: ["policy cal_settings.lock_account is not as it was made: made again"] };
    /** A schema beside `public` both logins may use. */
    const SIDE = ["create schema side", "grant usage on schema side to ohmail_api, ohmail_worker"];
    const RECHECK_PLANTS: RecheckPlant[] = [
      { name: "altered_true", plant: () => ["alter policy lock_account on public.cal_settings using (true) with check (true)"],
        reads: [2, 2, 2, 2], census: [drift("policies.altered", "cal_settings.lock_account", ALTERED)],
        api: [notAsListed("ohmail_api", ALTERED)], worker: [notAsListed("ohmail_worker", ALTERED)], setup: MADE_AGAIN },
      { name: "altered_or_true", plant: () => ["alter policy lock_account on public.cal_settings using (account_id = ohmail.current_account() or true)"],
        reads: [2, 2, 2, 2], census: [drift("policies.altered", "cal_settings.lock_account", ALTERED)],
        api: [notAsListed("ohmail_api", ALTERED)], worker: [notAsListed("ohmail_worker", ALTERED)], setup: MADE_AGAIN },
      { name: "remade_by_hand", plant: () => ["drop policy lock_account on public.cal_settings",
        "create policy lock_account on public.cal_settings for all to ohmail_api, ohmail_worker using (true) with check (true)"],
        reads: [2, 2, 2, 2], census: [drift("policies.unrecorded", "cal_settings.lock_account", UNRECORDED)],
        api: [notAsListed("ohmail_api", UNRECORDED)], worker: [notAsListed("ohmail_worker", UNRECORDED)], setup: MADE_AGAIN },
      { name: "another_row_of_the_list", plant: () => [`do $plant$ declare c text := pg_catalog.obj_description((select p.oid from pg_catalog.pg_policy p
          where p.polrelid = 'public.cal_settings'::regclass and p.polname = 'lock_account'), 'pg_policy');
        begin execute pg_catalog.format('comment on policy lock_account on public.cal_settings is %L',
          pg_catalog.split_part(c, ' ', 1) || ' ' || pg_catalog.repeat('0', 64) || ' ' || pg_catalog.split_part(c, ' ', 3)); end $plant$`],
        reads: [1, 0, 1, 0], census: [drift("policies.listed", "cal_settings.lock_account", "made from another version of the list")],
        api: [notAsListed("ohmail_api", "made from another version of the list")], worker: [notAsListed("ohmail_worker", "made from another version of the list")],
        // A row of the list that changed is made again as the list's, not as a repair.
        setup: { repaired: [] } },
      { name: "a_policy_naming_both_logins", plant: () => ["create policy also on public.cal_settings for select to ohmail_api, ohmail_worker using (true)"],
        reads: [2, 2, 2, 2], census: [drift("policies.foreign", "cal_settings.also", "a policy the list does not name")],
        api: [namesDiffer("ohmail_api")], worker: [namesDiffer("ohmail_worker")], setup: { repaired: ["policy cal_settings.also is not the list's: dropped"] } },
      { name: "a_policy_naming_the_worker", plant: () => ["create policy also on public.cal_settings for select to ohmail_worker using (true)"],
        reads: [1, 0, 2, 2], census: [drift("policies.foreign", "cal_settings.also", "a policy the list does not name")],
        api: [], worker: [namesDiffer("ohmail_worker")], setup: { repaired: ["policy cal_settings.also is not the list's: dropped"] } },
      { name: "the_door_gains_the_worker", plant: () => ["alter policy lock_staff_door on public.staff_sessions to ohmail_api, ohmail_worker"],
        reads: [1, 0, 1, 0],
        census: [drift("policies.roles", "staff_sessions.lock_staff_door", "to ohmail_api,ohmail_worker"), drift("policies.altered", "staff_sessions.lock_staff_door", ALTERED)],
        api: [notAsListed("ohmail_api", `to ohmail_api,ohmail_worker; ${ALTERED}`, "staff_sessions.lock_staff_door")],
        worker: [notAsListed("ohmail_worker", `to ohmail_api,ohmail_worker; ${ALTERED}`, "staff_sessions.lock_staff_door"), namesDiffer("ohmail_worker")],
        setup: { repaired: ["policy staff_sessions.lock_staff_door is not as it was made: made again"] } },
      // The readers and their schema.
      { name: "the_key_reader_immutable", plant: () => ["alter function ohmail.current_key() immutable"],
        reads: [1, 0, 1, 0], census: [drift("readers.differ", "ohmail.current_key", "volatility")],
        api: ["the reader ohmail.current_key differs: volatility"], worker: ["the reader ohmail.current_key differs: volatility"],
        setup: { repaired: ["reader ohmail.current_key made again: volatility"] } },
      { name: "the_account_reader_a_definer", plant: () => ["alter function ohmail.current_account() security definer"],
        reads: [1, 0, 1, 0], census: [drift("readers.differ", "ohmail.current_account", "security definer")],
        api: ["the reader ohmail.current_account differs: security definer"], worker: ["the reader ohmail.current_account differs: security definer"],
        // The logins may run it by name (their USAGE while the views stand): the roles' check refuses it before the step could mend it.
        setup: { refused: /the runtime roles' check refused: ROLES_DRIFT EXECUTE on the SECURITY DEFINER routine ohmail\.current_account\(\): role ohmail_api can run it/ } },
      { name: "the_account_reader_owned_by_another", asSuper: true, plant: () => [`alter function ohmail.current_account() owner to ${ground.server.superuser}`],
        reads: [1, 0, 1, 0], census: [drift("readers.differ", "ohmail.current_account", "owner")],
        api: ["the reader ohmail.current_account differs: owner"], worker: ["the reader ohmail.current_account differs: owner"],
        setup: { refused: /lock: LOCK_DRIFT readers\.differ ohmail\.current_account: owner; nothing was written/ } },
      { name: "the_schema_and_readers_owned_by_the_plane", asSuper: true, plant: () => ["alter schema ohmail owner to plane_runtime",
        "alter function ohmail.current_account() owner to plane_runtime", "alter function ohmail.current_key() owner to plane_runtime"],
        // The account's views stay the migrator's in a schema that is no longer: not as listed, and refused, by hand.
        reads: [1, 0, 1, 0], census: [drift("schema.usage", "ohmail", "plane_runtime holds USAGE"),
          ...ACCOUNT_VIEWS.map((v) => drift("views.differ", viewName(v), "owner"))],
        api: ["plane_runtime holds USAGE on the schema ohmail", ...ACCOUNT_VIEWS.map((v) => `the view ${viewName(v)} differs: owner`)],
        worker: ["plane_runtime holds USAGE on the schema ohmail", ...ACCOUNT_VIEWS.map((v) => `the view ${viewName(v)} differs: owner`)],
        setup: { refused: /ROLES_DRIFT [^\n]*plane_runtime|LOCK_DRIFT views\.differ ohmail\.messages: owner; nothing was written/ } },
      // PUBLIC, and the table's own flags.
      { name: "the_listed_policy_to_public", plant: () => ["alter policy lock_account on public.cal_settings to public"],
        reads: [1, 0, 1, 0],
        census: [drift("policies.roles", "cal_settings.lock_account", "to public"), drift("policies.altered", "cal_settings.lock_account", ALTERED)],
        api: ["a policy names PUBLIC: cal_settings.lock_account", notAsListed("ohmail_api", `to public; ${ALTERED}`)],
        worker: ["a policy names PUBLIC: cal_settings.lock_account", notAsListed("ohmail_worker", `to public; ${ALTERED}`)], setup: MADE_AGAIN },
      { name: "a_policy_to_public_for_all", plant: () => ["create policy pub on public.cal_settings for all to public using (true) with check (true)"],
        reads: [2, 2, 2, 2], census: [drift("policies.foreign", "cal_settings.pub", "a policy the list does not name")],
        api: ["a policy names PUBLIC: cal_settings.pub", namesDiffer("ohmail_api")], worker: ["a policy names PUBLIC: cal_settings.pub", namesDiffer("ohmail_worker")],
        setup: { repaired: ["policy cal_settings.pub is not the list's: dropped"] } },
      { name: "the_table_unforced", plant: () => ["alter table public.cal_settings no force row level security"],
        reads: [1, 0, 1, 0], census: [drift("tables.flags", "cal_settings", "on=true forced=false while the lock is on")],
        api: ["102 of 102 locked tables on and 101 forced, with no marker"], worker: ["102 of 102 locked tables on and 101 forced, with no marker"],
        setup: { repaired: ["table cal_settings was on=true forced=false: locked again"] } },
      { name: "the_table_disabled", plant: () => ["alter table public.cal_settings disable row level security"],
        reads: [2, 2, 2, 2], census: [drift("tables.flags", "cal_settings", "on=false forced=true while the lock is on")],
        api: ["101 of 102 locked tables on and 102 forced, with no marker"], worker: ["101 of 102 locked tables on and 102 forced, with no marker"],
        setup: { repaired: ["table cal_settings was on=false forced=true: locked again"] } },
      { name: "an_inherited_child_granted", plant: (_a, b) => ["create table public.cal_settings_child () inherits (public.cal_settings)",
        `insert into public.cal_settings_child (account_id) values ('${b}')`, "grant select on public.cal_settings_child to ohmail_api, ohmail_worker"],
        // Through its parent the child's row answers the parent's policy; by its own name, nothing holds it until the setup locks it as the new table it is.
        reads: [1, 0, 1, 0], extra: [["ohmail_api", "A", "select count(*)::int as n from public.cal_settings_child", 1, 0],
          ["ohmail_api", "none", "select count(*)::int as n from public.cal_settings_child", 1, 0]],
        census: [drift("tables.flags", "cal_settings_child", "on=false forced=false while the lock is on"), "LOCK_DRIFT policies.missing cal_settings_child.lock_account"],
        api: ["102 of 103 locked tables on and 102 forced, with no marker", namesDiffer("ohmail_api")],
        worker: ["102 of 103 locked tables on and 102 forced, with no marker", namesDiffer("ohmail_worker")], setup: { repaired: [] } },
      // Views and definer routines: of public, the check reads them for the login that reaches them; of another schema, the roles' check refuses them.
      { name: "a_view_of_public_for_the_worker", plant: () => ["create view public.all_settings as select account_id from public.cal_settings",
        "grant select on public.all_settings to ohmail_worker"],
        reads: [1, 0, 1, 0], extra: [["ohmail_worker", "none", "select count(*)::int as n from public.all_settings", 2]], census: [],
        api: [], worker: ["ohmail_worker may reach a view or a foreign table of public"],
        setup: { refused: /ROLES_DRIFT SELECT on the view public\.all_settings: role ohmail_worker reaches it/ } },
      { name: "a_materialized_view_of_public_for_the_api", plant: () => ["create materialized view public.mv_settings as select account_id from public.cal_settings",
        "grant select on public.mv_settings to ohmail_api"],
        reads: [1, 0, 1, 0], extra: [["ohmail_api", "none", "select count(*)::int as n from public.mv_settings", 2]], census: [],
        api: ["ohmail_api may reach a view or a foreign table of public"], worker: [],
        setup: { refused: /ROLES_DRIFT SELECT on the materialized view public\.mv_settings: role ohmail_api reaches it/ } },
      // The third recheck's L1: a view of public reached by a column grant, or by a write verb alone, reads past the lock too.
      { name: "a_view_of_public_by_a_column_grant", plant: () => ["create view public.all_settings as select account_id from public.cal_settings",
        "grant select (account_id) on public.all_settings to ohmail_api, ohmail_worker"],
        reads: [1, 0, 1, 0], extra: [["ohmail_api", "none", "select count(*)::int as n from public.all_settings", 2],
          ["ohmail_worker", "none", "select count(*)::int as n from public.all_settings", 2]], census: [],
        api: ["ohmail_api may reach a view or a foreign table of public"], worker: ["ohmail_worker may reach a view or a foreign table of public"],
        setup: { refused: /ROLES_DRIFT [^\n]*public\.all_settings[^\n]*ohmail_api/ } },
      { name: "a_view_of_public_with_update_alone", plant: () => ["create view public.all_settings as select account_id, second_zone from public.cal_settings",
        "grant update on public.all_settings to ohmail_api"],
        // Bound to A, the API rewrites B's row through it as well as its own.
        reads: [1, 0, 1, 0], extra: [["ohmail_api", "A", "with w as (update public.all_settings set second_zone = 'rewritten' returning 1) select count(*)::int as n from w", 2]],
        census: [], api: ["ohmail_api may reach a view or a foreign table of public"], worker: [],
        setup: { refused: /ROLES_DRIFT [^\n]*public\.all_settings[^\n]*ohmail_api/ } },
      { name: "a_materialized_view_of_public_by_a_column_grant", plant: () => ["create materialized view public.mv_settings as select account_id from public.cal_settings",
        "grant select (account_id) on public.mv_settings to ohmail_worker"],
        reads: [1, 0, 1, 0], extra: [["ohmail_worker", "none", "select count(*)::int as n from public.mv_settings", 2]], census: [],
        api: [], worker: ["ohmail_worker may reach a view or a foreign table of public"],
        setup: { refused: /ROLES_DRIFT [^\n]*public\.mv_settings[^\n]*ohmail_worker/ } },
      { name: "a_view_in_another_schema", plant: () => [...SIDE, "create view side.all_settings as select account_id from public.cal_settings",
        "grant select on side.all_settings to ohmail_api, ohmail_worker"],
        reads: [1, 0, 1, 0], extra: [["ohmail_api", "A", "select count(*)::int as n from side.all_settings", 2],
          ["ohmail_worker", "none", "select count(*)::int as n from side.all_settings", 2]], census: [],
        setup: { refused: /ROLES_DRIFT USAGE on schema side: role ohmail_api holds it and the rule does not write it/ } },
      { name: "a_definer_routine_in_another_schema", plant: () => [...SIDE,
        "create function side.all_settings() returns int language sql security definer as 'select count(*)::int from public.cal_settings'"],
        reads: [1, 0, 1, 0], extra: [["ohmail_api", "A", "select side.all_settings() as n", 2], ["ohmail_worker", "none", "select side.all_settings() as n", 2]],
        census: [], setup: { refused: /ROLES_DRIFT EXECUTE on the SECURITY DEFINER routine side\.all_settings\(\): role ohmail_api can run it/ } },
      { name: "a_copied_table_in_another_schema", plant: () => [...SIDE, "create table side.settings_copy as select * from public.cal_settings",
        "grant select on side.settings_copy to ohmail_api, ohmail_worker"],
        reads: [1, 0, 1, 0], extra: [["ohmail_api", "none", "select count(*)::int as n from side.settings_copy", 2]], census: [],
        setup: { refused: /ROLES_DRIFT SELECT on side\.settings_copy: a direct grant to role ohmail_api outside the rule/ } },
    ];

    for (const p of RECHECK_PLANTS) {
      it(`the recheck's plant ${p.name}: what each login reads, the census, the check for each login, and the next setup`, async () => {
        const db = await ground.clone("ground", `recheck_${p.name}`.slice(0, 60));
        const [a, b] = await twoAccounts(db);
        const mig = ground.connectAs(db, MIGRATOR_ROLE);
        try { await mig.unsafe("insert into public.cal_settings (account_id) values ($1), ($2)", [a, b]); } finally { await mig.end({ timeout: 5 }); }
        const planter = ground.connectAs(db, p.asSuper === true ? undefined : MIGRATOR_ROLE);
        try { for (const s of p.plant(a, b)) await planter.unsafe(s).simple(); } finally { await planter.end({ timeout: 5 }); }
        const verdict = async (role: string): Promise<{ verdict: string; why: readonly string[] }> =>
          verdictOf(db, role, { role }).then((v) => ({ verdict: v.verdict, why: v.why }));
        const reading = async (): Promise<object> => ({
          reads: Object.values(await readsOf(db, "cal_settings", a)),
          extra: await Promise.all((p.extra ?? []).map(([role, bind, text]) => boundCount(db, role, bind === "A" ? a : "", text))),
          census: (await plantAndCensus(db, [])).sort(),
          ...(p.api === undefined ? {} : { api: await verdict("ohmail_api") }),
          ...(p.worker === undefined ? {} : { worker: await verdict("ohmail_worker") }),
        });
        const judged = (why: readonly string[]): object => ({ verdict: why.length === 0 ? "locked" : "broken", why: [...why] });
        expect(await reading()).toEqual({
          reads: [...p.reads], extra: (p.extra ?? []).map((x) => x[3]), census: [...p.census].sort(),
          ...(p.api === undefined ? {} : { api: judged(p.api) }), ...(p.worker === undefined ? {} : { worker: judged(p.worker) }),
        });
        if ("refused" in p.setup) {
          await expect(ground.setup(db, MIGRATOR_ROLE)).rejects.toThrow(p.setup.refused);
          return;
        }
        expect([...(await ground.setup(db, MIGRATOR_ROLE)).lock!.repaired].sort()).toEqual([...p.setup.repaired].sort());
        expect(await reading()).toEqual({
          reads: [1, 0, 1, 0], extra: (p.extra ?? []).map((x) => x[4]), census: [],
          ...(p.api === undefined ? {} : { api: judged([]) }), ...(p.worker === undefined ? {} : { worker: judged([]) }),
        });
      }, CASE_MS);
    }

    /**
     * CODE ON A TABLE THAT RUNS WITH ITS OWNER'S RIGHTS (the second recheck, 2026-11-15), each on a clone of the
     * locked ground holding a settings row of each of two accounts. The API's login bound to A fires the code, then reads
     * its own settings row, into which the code wrote every account's id it could read: run as the login, it reads A's
     * alone; run with its owner's rights (the migrator, which bypasses), both. A rule's actions run as the table's owner;
     * a trigger fires its routine with no EXECUTE asked; an expression calls its routine by its id, with no USAGE on the
     * routine's schema asked. A foreign table of `public` answers with its user mapping's rights.
     */
    interface OwnersCode {
      readonly name: string;
      readonly asSuper?: boolean;
      readonly plant: (db: string) => string[];
      /** Each read: the login, bound to A or naming nothing, the statements in one transaction, and what the last one counts. */
      readonly reads: ReadonlyArray<readonly [string, "A" | "none", readonly string[], number]>;
      readonly census: readonly string[];
      /** The check's reasons, judged for each login; none is `locked`. */
      readonly api: readonly string[];
      readonly worker: readonly string[];
      /** The next setup: it writes nothing, or it refuses and the catalog stays as it was. */
      readonly setup: "writes nothing" | RegExp;
    }
    /** Every account's id the statement can read, written into the settings row of the account `who` names. */
    const FILL = (who: string): string => "update public.cal_settings set second_zone = (select pg_catalog.string_agg(c2.account_id::text, ',' "
      + `order by c2.account_id) from public.cal_settings c2) where account_id = ${who}`;
    /** How many accounts' ids the reader's own settings row holds. */
    const IDS = "select coalesce(max(pg_catalog.array_length(pg_catalog.string_to_array(second_zone, ','), 1)), 0)::int as n from public.cal_settings";
    const AUDIT = "insert into public.audit_log (account_id, action) values (pg_catalog.current_setting('ohmail.account')::pg_catalog.uuid, 'fill')";
    const FAULT = "insert into public.api_faults (route, method, status, error_class, arm) values ('/fill', 'GET', 500, 'Error', 'api')";
    /** A trigger on the audit log that fills the row of the account it names, its routine in `schema`. */
    const fillTrigger = (schema: string, definer: boolean): string[] => [
      `create function ${schema}.fill_ids() returns trigger language plpgsql ${definer ? "security definer " : ""}set search_path = pg_catalog
        as $f$begin ${FILL("new.account_id")}; return new; end$f$`,
      `create trigger fill_ids after insert on public.audit_log for each row execute function ${schema}.fill_ids()`,
    ];
    /** A default of the settings row that holds every account's id its routine reads, the routine in a schema no login may use. */
    const idsDefault = (definer: boolean): string[] => ["create schema side_code",
      `create function side_code.ids() returns text language sql ${definer ? "security definer " : ""}set search_path = pg_catalog
        as $f$select pg_catalog.string_agg(account_id::text, ',' order by account_id) from public.cal_settings$f$`,
      "alter table public.cal_settings alter column second_zone set default side_code.ids()"];
    const both = (why: readonly string[]): { api: readonly string[]; worker: readonly string[] } => ({ api: why, worker: why });
    const OWNERS_CODE: OwnersCode[] = [
      { name: "a rule on a locked table", plant: () => [`create rule fill_ids as on insert to public.audit_log do also ${FILL("new.account_id")}`],
        reads: [["ohmail_api", "A", [AUDIT, IDS], 2]], census: [codeLine("audit_log", `the rule fill_ids ${PAST_THE_LOCK}`)],
        ...both([codeWhy("audit_log", `the rule fill_ids ${PAST_THE_LOCK}`)]),
        setup: /lock: LOCK_DRIFT tables\.code audit_log: the rule fill_ids runs with its owner's rights, past the lock; nothing was written/ },
      { name: "a rule on an operations table",
        plant: () => [`create rule fill_ids as on insert to public.api_faults do also ${FILL("pg_catalog.current_setting('ohmail.account')::pg_catalog.uuid")}`],
        reads: [["ohmail_api", "A", [FAULT, IDS], 2]], census: [codeLine("api_faults", `the rule fill_ids ${PAST_THE_LOCK}`)],
        ...both([codeWhy("api_faults", `the rule fill_ids ${PAST_THE_LOCK}`)]),
        setup: /lock: LOCK_DRIFT tables\.code api_faults: the rule fill_ids runs with its owner's rights, past the lock; nothing was written/ },
      { name: "a trigger whose routine is SECURITY DEFINER, its EXECUTE revoked from PUBLIC",
        plant: () => [...fillTrigger("public", true), "revoke execute on function public.fill_ids() from public"],
        reads: [["ohmail_api", "A", [AUDIT, IDS], 2]], census: [codeLine("audit_log", calls("the trigger fill_ids", "public.fill_ids()"))],
        ...both([codeWhy("audit_log", calls("the trigger fill_ids", "public.fill_ids()"))]),
        setup: /lock: LOCK_DRIFT tables\.code audit_log: the trigger fill_ids calls the SECURITY DEFINER routine public\.fill_ids\(\), which runs with its owner's rights, past the lock; nothing was written/ },
      { name: "the same trigger, its routine in a schema no login may use", plant: () => ["create schema side_code", ...fillTrigger("side_code", true)],
        reads: [["ohmail_api", "A", [AUDIT, IDS], 2]], census: [codeLine("audit_log", calls("the trigger fill_ids", "side_code.fill_ids()"))],
        ...both([codeWhy("audit_log", calls("the trigger fill_ids", "side_code.fill_ids()"))]),
        setup: /lock: LOCK_DRIFT tables\.code audit_log: the trigger fill_ids calls the SECURITY DEFINER routine side_code\.fill_ids\(\), which runs with its owner's rights, past the lock; nothing was written/ },
      { name: "a default that calls a SECURITY DEFINER routine of such a schema", plant: () => idsDefault(true),
        reads: [["ohmail_api", "A", ["update public.cal_settings set second_zone = default", IDS], 2]],
        census: [codeLine("cal_settings", calls("the default of second_zone", "side_code.ids()"))],
        ...both([codeWhy("cal_settings", calls("the default of second_zone", "side_code.ids()"))]),
        setup: /lock: LOCK_DRIFT tables\.code cal_settings: the default of second_zone calls the SECURITY DEFINER routine side_code\.ids\(\), which runs with its owner's rights, past the lock; nothing was written/ },
      // The controls: the same code run as the login is held by the lock, and nothing names it.
      { name: "control: the trigger whose routine runs as the login", plant: () => ["create schema side_code", ...fillTrigger("side_code", false)],
        reads: [["ohmail_api", "A", [AUDIT, IDS], 1]], census: [], ...both([]), setup: "writes nothing" },
      { name: "control: the default whose routine runs as the login", plant: () => idsDefault(false),
        reads: [["ohmail_api", "A", ["update public.cal_settings set second_zone = default", IDS], 1]], census: [], ...both([]), setup: "writes nothing" },
      // The recheck's own control: a definer routine of public that PUBLIC may run is the roles' check's, and the census's.
      { name: "the definer trigger's routine of public, which every login may also run", plant: () => fillTrigger("public", true),
        reads: [["ohmail_api", "A", [AUDIT, IDS], 2]], census: [codeLine("audit_log", calls("the trigger fill_ids", "public.fill_ids()"))],
        api: [codeWhy("audit_log", calls("the trigger fill_ids", "public.fill_ids()")), "ohmail_api may run a SECURITY DEFINER routine of public"],
        worker: [codeWhy("audit_log", calls("the trigger fill_ids", "public.fill_ids()")), "ohmail_worker may run a SECURITY DEFINER routine of public"],
        setup: /ROLES_DRIFT EXECUTE on the SECURITY DEFINER routine fill_ids\(\): role ohmail_api can run it/ },
      // Over the server's own socket, as the migrator, which the user mapping names for everyone.
      { name: "a foreign table of public both logins may read", asSuper: true,
        plant: (db) => ["create extension postgres_fdw",
          `create server loopback foreign data wrapper postgres_fdw options (host '/var/run/postgresql', dbname '${db}')`,
          `create user mapping for public server loopback options (user '${MIGRATOR_ROLE}', password_required 'false')`,
          "create foreign table public.settings_elsewhere (account_id uuid) server loopback options (schema_name 'public', table_name 'cal_settings')",
          `alter foreign table public.settings_elsewhere owner to ${MIGRATOR_ROLE}`, "grant select on public.settings_elsewhere to ohmail_api, ohmail_worker"],
        reads: [["ohmail_api", "A", ["select count(*)::int as n from public.settings_elsewhere"], 2], ["ohmail_worker", "none", ["select count(*)::int as n from public.settings_elsewhere"], 2]],
        census: [], api: ["ohmail_api may reach a view or a foreign table of public"], worker: ["ohmail_worker may reach a view or a foreign table of public"],
        setup: /ROLES_DRIFT SELECT on the foreign table public\.settings_elsewhere: role ohmail_api reaches it/ },
    ];

    for (const [i, p] of OWNERS_CODE.entries()) {
      it(`code that runs with its owner's rights, ${p.name}: what the API bound to A reads through it, the census, the check for each login, and the next setup`, async () => {
        const db = await ground.clone("ground", `owners_code_${i}`);
        const [a, b] = await twoAccounts(db);
        const mig = ground.connectAs(db, MIGRATOR_ROLE);
        try { await mig.unsafe("insert into public.cal_settings (account_id) values ($1), ($2)", [a, b]); } finally { await mig.end({ timeout: 5 }); }
        const planter = ground.connectAs(db, p.asSuper === true ? undefined : MIGRATOR_ROLE);
        try { for (const s of p.plant(db)) await planter.unsafe(s).simple(); } finally { await planter.end({ timeout: 5 }); }
        const verdict = async (role: string): Promise<{ verdict: string; why: readonly string[] }> =>
          verdictOf(db, role, { role }).then((v) => ({ verdict: v.verdict, why: v.why }));
        const judged = (why: readonly string[]): object => ({ verdict: why.length === 0 ? "locked" : "broken", why: [...why] });
        const before = await catalogOf(db);
        const said: string[] = [];
        const setup = await ground.setup(db, MIGRATOR_ROLE, { log: (m) => said.push(m) })
          .then((r) => ({ wrote: r.lock!.wrote, repaired: r.lock!.repaired }), (e: Error) => e.message);
        const reads: Array<number | string> = [];
        for (const [role, bind, text] of p.reads) reads.push(await boundCount(db, role, bind === "A" ? a : "", text));
        expect({
          reads,
          census: (await plantAndCensus(db, [])).sort(),
          api: await verdict("ohmail_api"),
          worker: await verdict("ohmail_worker"),
          setup: typeof setup === "string" && p.setup !== "writes nothing" && p.setup.test(setup) ? "refused" : setup,
          repairsSaid: said.filter((m) => m.startsWith("lock: repair:")),
          unchanged: await catalogOf(db) === before,
        }, p.name).toEqual({
          reads: p.reads.map((r) => r[3]),
          census: [...p.census].sort(),
          api: judged(p.api),
          worker: judged(p.worker),
          setup: p.setup === "writes nothing" ? { wrote: 0, repaired: [] } : "refused",
          repairsSaid: [],
          unchanged: true,
        });
      }, CASE_MS);
    }

    it("a view the step cannot mend beside a drift it would: refused before it writes, and no repair is said", async () => {
      const db = await ground.clone("ground", "view_unmendable_beside");
      const mig = ground.connectAs(db, MIGRATOR_ROLE);
      try {
        await mig.unsafe("drop view ohmail.message_search");
        // Its columns in another order: no list's first columns, so Postgres cannot make it again over itself.
        await mig.unsafe(`create view ohmail.message_search as select account_id, message_id from public.message_search
          where account_id = ohmail.current_account() and ${readerCondition()} with check option`);
        await mig.unsafe("drop policy lock_account on public.messages");
      } finally {
        await mig.end({ timeout: 5 });
      }
      const before = await catalogOf(db);
      const said: string[] = [];
      const refused = await ground.setup(db, MIGRATOR_ROLE, { log: (m) => said.push(m) })
        .then((r) => `not refused: ${JSON.stringify(r.lock)}`, (e: Error) => e.message);
      expect({
        refused: refused.includes("lock: LOCK_DRIFT views.differ ohmail.message_search: columns, unrecorded; Postgres cannot make it again over other columns: "
          + "drop it first (DROP VIEW IF EXISTS ohmail.message_search, in the release's journal or by hand), in a closed window; the step then makes it again and "
          + "the roles' apply grants it; nothing was written"),
        repairsSaid: said.filter((m) => m.startsWith("lock: repair:")),
        unchanged: await catalogOf(db) === before,
      }).toEqual({ refused: true, repairsSaid: [], unchanged: true });
    }, CASE_MS);

    it("a column two views name dropped by a journal, the views with it: the census names the gap, and the next setup refuses before it writes", async () => {
      const db = await ground.clone("ground", "view_column_gone");
      expect((await plantAndCensus(db, ["alter table public.message_search drop column source cascade"])).sort()).toEqual([
        "LOCK_DRIFT views.missing ohmail.message_search", "LOCK_DRIFT views.missing ohmail.message_search_words",
        drift("views.columns", "ohmail.message_search", "public.message_search holds no column source"),
        drift("views.columns", "ohmail.message_search_words", "public.message_search holds no column source"),
      ].sort());
      for (const role of ["ohmail_api", "ohmail_worker"]) expect((await verdictOf(db, role, { role })).verdict, role).toBe("locked");
      const before = await catalogOf(db);
      await expect(ground.setup(db, MIGRATOR_ROLE)).rejects
        .toThrow("lock: LOCK_DRIFT views.columns ohmail.message_search: public.message_search holds no column source; nothing was written");
      expect(await catalogOf(db)).toBe(before);
    }, CASE_MS);

    /**
     * A VIEW AN EARLIER RELEASE MADE FROM ANOTHER LIST OF COLUMNS, on a clone of the locked and granted ground:
     * the view dropped and made again by that release's own statement and record, and granted as the roles' apply grants it.
     */
    async function earlierView(db: string, name: string, columns: (listed: readonly string[]) => readonly string[]): Promise<AccountView> {
      const listed = ACCOUNT_VIEWS.find((x) => x.name === name)!;
      const earlier: AccountView = { ...listed, columns: columns(listed.columns) };
      const mig = ground.connectAs(db, MIGRATOR_ROLE);
      try {
        await mig.begin(async (tx) => {
          await pinSpelling(tx);
          await tx.unsafe(`drop view ${viewName(listed)}`);
          await tx.unsafe(viewStatement(earlier));
          const [printed] = await tx.unsafe(`select pg_catalog.pg_get_viewdef('${viewName(listed)}'::pg_catalog.regclass) as text`);
          await tx.unsafe(`comment on view ${viewName(listed)} is '${viewComment(earlier, String(printed!.text))}'`);
          await tx.unsafe(`grant select on ${viewName(listed)} to ohmail_api, ohmail_worker`);
        });
      } finally {
        await mig.end({ timeout: 5 }).catch(() => undefined);
      }
      return earlier;
    }

    /**
     * Reads through `view` as the API's login, bound, one flight after another while `during` runs: how many ran, and every
     * error one met (a flight that waits behind a lock is no error).
     */
    async function readsBeside(db: string, view: string, during: () => Promise<unknown>): Promise<{ flights: number; errors: string[]; answer: unknown }> {
      const api = ground.connectAs(db, "ohmail_api");
      let running = true;
      let flights = 0;
      const errors: string[] = [];
      const loop = (async () => {
        while (running) {
          try {
            await api.begin(async (tx) => {
              await tx.unsafe(BINDER_SQL, ["00000000-0000-4000-8000-0000000000a1", ""]);
              await tx.unsafe(`select count(*) from ${view}`);
            });
            flights += 1;
          } catch (e) {
            errors.push(String((e as { code?: string }).code ?? (e as Error).message));
          }
        }
      })();
      try {
        await new Promise((r) => setTimeout(r, 150));
        const answer = await during().then((r) => r, (e: Error) => e.message);
        await new Promise((r) => setTimeout(r, 150));
        return { flights, errors, answer };
      } finally {
        running = false;
        await loop;
        await api.end({ timeout: 5 });
      }
    }

    it("a release whose list names one more column at the end of a view: the setup makes the view again over itself (two statements, no repair said), the logins' rights kept, and a read beside it never fails", async () => {
      const db = await ground.clone("ground", "list_grown");
      await earlierView(db, "messages", (c) => c.slice(0, -1));
      const rightsBefore = await viewRights(db);
      const census = (await plantAndCensus(db, [])).sort();
      const why = { api: (await verdictOf(db, "ohmail_api", { role: "ohmail_api" })).why, worker: (await verdictOf(db, "ohmail_worker", { role: "ohmail_worker" })).why };
      const beside = await readsBeside(db, "ohmail.messages", () => ground.setup(db, MIGRATOR_ROLE));
      const report = (beside.answer as { lock?: { wrote: number; repaired: string[]; views: number } }).lock;
      const differs = ["the view ohmail.messages differs: fewer columns, listed"];
      expect({ census, why, errors: beside.errors, ran: beside.flights > 0,
        lock: report === undefined ? beside.answer : { wrote: report.wrote, repaired: report.repaired, views: report.views } })
        .toEqual({ census: [drift("views.differ", "ohmail.messages", "fewer columns, listed")], why: { api: differs, worker: differs },
          errors: [], ran: true, lock: { wrote: 2, repaired: [], views: 3 } });
      expect({ rights: await viewRights(db), census: await plantAndCensus(db, []), api: (await verdictOf(db, "ohmail_api", { role: "ohmail_api" })).verdict,
        worker: (await verdictOf(db, "ohmail_worker", { role: "ohmail_worker" })).verdict, again: (await ground.setup(db, MIGRATOR_ROLE)).lock?.wrote })
        .toEqual({ rights: rightsBefore, census: [], api: "locked", worker: "locked", again: 0 });
    }, CASE_MS);

    it("a view whose columns Postgres cannot make again over itself (one missing in the middle, or one more than the list names): refused before it writes, and the refusal names the remedy", async () => {
      const remedy = "Postgres cannot make it again over other columns: drop it first (DROP VIEW IF EXISTS ohmail.messages, in the release's "
        + "journal or by hand), in a closed window; the step then makes it again and the roles' apply grants it";
      const listed = ACCOUNT_VIEWS.find((x) => x.name === "messages")!;
      const got: Record<string, object> = {};
      // An earlier release that did not list a column the list now names in the middle (the review's listcol case, snippet).
      const middle = await ground.clone("ground", "list_middle");
      await earlierView(middle, "messages", (c) => c.filter((x) => x !== "snippet"));
      // A later release's view, met by this one after a rollback: one column more than this list names, at its end.
      const longer = await ground.clone("ground", "list_longer");
      const later: AccountView = { ...listed, columns: [...listed.columns, "a_later_column"] };
      const mig = ground.connectAs(longer, MIGRATOR_ROLE);
      try {
        await mig.begin(async (tx) => {
          await pinSpelling(tx);
          await tx.unsafe("drop view ohmail.messages");
          await tx.unsafe(`create view ohmail.messages as select ${listed.columns.map((c) => `"${c}"`).join(", ")}, "id" as "a_later_column" from public."messages"
            where ${listed.key} and ${readerCondition()} with check option`);
          const [printed] = await tx.unsafe("select pg_catalog.pg_get_viewdef('ohmail.messages'::pg_catalog.regclass) as text");
          await tx.unsafe(`comment on view ohmail.messages is '${viewComment(later, String(printed!.text))}'`);
          await tx.unsafe("grant select on ohmail.messages to ohmail_api, ohmail_worker");
        });
      } finally {
        await mig.end({ timeout: 5 });
      }
      for (const db of [middle, longer]) {
        const before = await catalogOf(db);
        const refused = await ground.setup(db, MIGRATOR_ROLE).then((r) => `not refused: ${JSON.stringify(r.lock)}`, (e: Error) => e.message);
        got[db] = { census: await plantAndCensus(db, []), refused: refused.includes(`lock: LOCK_DRIFT views.differ ohmail.messages: columns, listed; ${remedy}; nothing was written`),
          unchanged: await catalogOf(db) === before };
      }
      const want = { census: [drift("views.differ", "ohmail.messages", "columns, listed")], refused: true, unchanged: true };
      expect(got).toEqual({ [middle]: want, [longer]: want });
    }, CASE_MS);

    /**
     * A JOURNAL'S STATEMENTS OVER THE STANDING VIEWS: no test database holds the views, so nothing
     * else replays an entry over them. As the migrator on clones of the locked and granted ground: a listed column dropped or
     * retyped is refused by Postgres (the deploy stops at its journal), and passes after DROP VIEW IF EXISTS of the view, the
     * next setup making it again and the roles' apply granting it; a column renamed passes and leaves the view reading it under
     * its old name, both logins broken and every setup refused until the list changes; a column added passes and no view shows it.
     */
    it("a journal's statements over the standing views: refused by Postgres where a view names the column, taken after DROP VIEW IF EXISTS and made again by the next setup; a rename reads broken; an added column changes nothing", async () => {
      const ROLLED_BACK = "rolled back";
      const tried = async (db: string, statements: readonly string[]): Promise<string> => {
        const mig = ground.connectAs(db, MIGRATOR_ROLE);
        try {
          return await mig.begin(async (tx) => { for (const t of statements) await tx.unsafe(t); throw new Error(ROLLED_BACK); })
            .then(() => "committed", (e: Error & { code?: string }) => (e.message === ROLLED_BACK ? "passes" : String(e.code)));
        } finally {
          await mig.end({ timeout: 5 });
        }
      };
      const judged = async (db: string, role: string): Promise<object> => verdictOf(db, role, { role }).then((v) => ({ verdict: v.verdict, why: v.why }));
      const db = await ground.clone("ground", "journal_over_views");
      const statements = {
        dropListed: await tried(db, ["alter table public.message_search drop column source"]),
        retypeListed: await tried(db, ["alter table public.messages alter column snippet type varchar(4000)"]),
        dropAfterTheViews: await tried(db, ["drop view if exists ohmail.message_search", "drop view if exists ohmail.message_search_words",
          "alter table public.message_search drop column source"]),
        retypeAfterTheView: await tried(db, ["drop view if exists ohmail.messages", "alter table public.messages alter column snippet type varchar(4000)"]),
      };
      // The retype after its DROP VIEW IF EXISTS, committed: the next setup makes the view again over the new type, the roles' apply grants it.
      await plantAndCensus(db, ["drop view if exists ohmail.messages", "alter table public.messages alter column snippet type varchar(4000)"]);
      const report = await ground.setup(db, MIGRATOR_ROLE);
      const retyped = { repaired: report.lock!.repaired, views: report.lock!.views, census: (await plantAndCensus(db, [])).sort(),
        writes: (await rolesScript(db)).filter((t) => /write: [^\n]*ohmail\.messages/.test(t)).length, after: await plantAndCensus(db, []) };
      // A column renamed: Postgres takes it, and the view reads the column under its old name.
      const renamed = await ground.clone("ground", "journal_rename");
      const renameCensus = (await plantAndCensus(renamed, ["alter table public.messages rename column snippet to preview"])).sort();
      const before = await catalogOf(renamed);
      const renameSetup = await ground.setup(renamed, MIGRATOR_ROLE).then(() => "not refused", (e: Error) => e.message);
      // A column added: no view shows it, and nothing reads otherwise.
      const added = await ground.clone("ground", "journal_add");
      const addCensus = await plantAndCensus(added, ["alter table public.message_search add column added_later text"]);
      const differs = ["the view ohmail.messages differs: columns, text"];
      expect({ statements, retyped, renamed: { census: renameCensus, api: await judged(renamed, "ohmail_api"), worker: await judged(renamed, "ohmail_worker"),
        refused: renameSetup.includes("lock: LOCK_DRIFT views.columns ohmail.messages: public.messages holds no column snippet; nothing was written"),
        // The table cannot answer the view: dropping the view first would mend nothing (the step could not make it again), so the refusal does not say it.
        saysDropItFirst: renameSetup.includes("drop it first"),
        unchanged: await catalogOf(renamed) === before }, added: { census: addCensus, api: await judged(added, "ohmail_api") } }).toEqual({
        statements: { dropListed: "2BP01", retypeListed: "0A000", dropAfterTheViews: "passes", retypeAfterTheView: "passes" },
        retyped: { repaired: ["view ohmail.messages was missing: made"], views: 3, census: ungrantedLines(["messages"], false), writes: 2, after: [] },
        renamed: { census: [drift("views.columns", "ohmail.messages", "public.messages holds no column snippet"), drift("views.differ", "ohmail.messages", "columns, text")].sort(),
          api: { verdict: "broken", why: differs }, worker: { verdict: "broken", why: differs }, refused: true, saysDropItFirst: false, unchanged: true },
        added: { census: [], api: { verdict: "locked", why: [] } },
      });
    }, CASE_MS);

    /**
     * EVERY INDEX THE LOCK COULD TAKE FROM A READ, FROM THE CATALOG (the search ruling's first part): each index on a
     * locked table that is no btree or hash, or whose key or predicate is an expression, against the lock's typed table of how it
     * is read. An index with no row is red, and so is a row with no index: a new expression index is a decision.
     */
    async function expressionIndexes(db: string): Promise<string[]> {
      const sql = ground.connectAs(db, MIGRATOR_ROLE);
      try {
        return (await sql.unsafe(`select c.relname || '.' || i.relname as n from pg_catalog.pg_index ix
            join pg_catalog.pg_class i on i.oid = ix.indexrelid join pg_catalog.pg_class c on c.oid = ix.indrelid
            join pg_catalog.pg_am am on am.oid = i.relam join pg_catalog.pg_namespace ns on ns.oid = c.relnamespace
           where ns.nspname = 'public' and c.relname = any($1::text[])
             and (am.amname not in ('btree', 'hash') or ix.indexprs is not null or ix.indpred is not null) order by 1`, [lockedTables()]))
          .map((r) => String(r.n));
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    const typedIndexes = (): string[] => Object.entries(INDEX_READS).map(([n, r]) => `${r.table}.${n}`).sort();

    it("every expression, predicate or GIN index on a locked table has its row in the lock's typed table of index reads, and every row its index; a new one is red", async () => {
      const unread = (catalog: readonly string[]): { rowless: string[]; indexless: string[] } => ({
        rowless: catalog.filter((n) => !typedIndexes().includes(n)), indexless: typedIndexes().filter((n) => !catalog.includes(n)),
      });
      expect(unread(await expressionIndexes("ground"))).toEqual({ rowless: [], indexless: [] });
      const db = await ground.clone("ground", "index_reads_new");
      await plantAndCensus(db, ["create index riso_tags_lower_idx on public.tags (account_id, lower(name))",
        "create index riso_drafts_open_idx on public.drafts (account_id) where status = 'draft'"]);
      expect(unread(await expressionIndexes(db))).toEqual({ rowless: ["drafts.riso_drafts_open_idx", "tags.riso_tags_lower_idx"], indexless: [] });
    }, CASE_MS);

    it("a relation of the readers' schema a login may reach beside the views: the census names it, and the check reads broken for that login alone", async () => {
      const db = await ground.clone("ground", "ohmail_reach");
      const mig = ground.connectAs(db, MIGRATOR_ROLE);
      try {
        await mig.unsafe("create table ohmail.beside (id int)");
        await mig.unsafe("grant select on ohmail.beside to ohmail_worker");
      } finally {
        await mig.end({ timeout: 5 });
      }
      const judged = async (role: string): Promise<object> => verdictOf(db, role, { role }).then((v) => ({ verdict: v.verdict, why: v.why }));
      expect({ census: await plantAndCensus(db, []), api: await judged("ohmail_api"), worker: await judged("ohmail_worker") }).toEqual({
        census: [drift("schema.objects", "ohmail", "relation beside")],
        api: { verdict: "locked", why: [] },
        worker: { verdict: "broken", why: ["ohmail_worker may reach a relation of the schema ohmail beside the account's views, or run a SECURITY DEFINER routine there"] },
      });
    }, CASE_MS);

    it("code that runs with its owner's rights beside a drift the step would mend: refused before it writes, and no repair is said", async () => {
      const db = await ground.clone("ground", "owners_code_beside");
      const mig = ground.connectAs(db, MIGRATOR_ROLE);
      try {
        await mig.unsafe(`create rule fill_ids as on insert to public.audit_log do also ${FILL("new.account_id")}`);
        await mig.unsafe("drop policy lock_account on public.messages");
      } finally {
        await mig.end({ timeout: 5 });
      }
      const before = await catalogOf(db);
      const said: string[] = [];
      const refused = await ground.setup(db, MIGRATOR_ROLE, { log: (m) => said.push(m) })
        .then((r) => `not refused: ${JSON.stringify(r.lock)}`, (e: Error) => e.message);
      expect({
        refused: refused.includes(`lock: ${codeLine("audit_log", `the rule fill_ids ${PAST_THE_LOCK}`)}; nothing was written`),
        repairsSaid: said.filter((m) => m.startsWith("lock: repair:")),
        unchanged: await catalogOf(db) === before,
      }).toEqual({ refused: true, repairsSaid: [], unchanged: true });
    }, CASE_MS);

    /** The verdict of `role` on `db`, judged for it, read on a session of its own after `pre`. */
    async function verdictUnder(db: string, role: string, pre: readonly string[]): Promise<{ verdict: string; why: readonly string[] }> {
      const sql = ground.connectAs(db, role);
      try {
        for (const s of pre) await sql.unsafe(s);
        const r = await readLock(sql, { role });
        return { verdict: r.verdict, why: r.why };
      } finally {
        await sql.end({ timeout: 5 });
      }
    }

    it("the reading pins, for its transaction alone, the settings a catalog's spelling follows", async () => {
      const sql = ground.connectAs("ground", MIGRATOR_ROLE);
      const read = "select pg_catalog.current_setting('IntervalStyle') as interval, pg_catalog.current_setting('quote_all_identifiers') as quote, "
        + "pg_catalog.current_setting('DateStyle') as date, pg_catalog.current_setting('TimeZone') as zone, pg_catalog.current_setting('search_path') as path";
      try {
        for (const s of ["set search_path = public", "set intervalstyle = 'iso_8601'", "set quote_all_identifiers = on", "set datestyle = 'German, DMY'",
          "set timezone = 'Pacific/Kiritimati'"]) {
          await sql.unsafe(s);
        }
        const inside = await sql.begin("read only", async (tx) => { await readLockFacts(tx); return (await tx.unsafe(read))[0]; });
        const after = (await sql.unsafe(read))[0];
        expect({ inside, after }).toEqual({
          inside: { interval: "postgres", quote: "off", date: "ISO, MDY", zone: "UTC", path: "" },
          after: { interval: "iso_8601", quote: "on", date: "German, DMY", zone: "Pacific/Kiritimati", path: "public" },
        });
      } finally {
        await sql.end({ timeout: 5 });
      }
    }, CASE_MS);

    /**
     * AN UNTOUCHED LOCK UNDER A SETTING THE CATALOG'S SPELLING FOLLOWS (the second recheck): an interval constant
     * prints as IntervalStyle says (the 35 horizon policies, all the worker's), and every identifier and type name as
     * quote_all_identifiers says (every policy, and both readers' return type). The reading pins both for its transaction,
     * and the step records each policy's spelling under the same pins: so the lock reads locked for both logins whether
     * the setting stands on the reading session, the database, the migrator's role or a login's role, or stood when the
     * lock was first made, and the setup writes nothing.
     */
    const SPELLING_MOVERS = [["IntervalStyle", "iso_8601"], ["quote_all_identifiers", "on"]] as const;
    for (const [guc, value] of SPELLING_MOVERS) {
      it(`an untouched lock under ${guc} = ${value}, on the reading session, the database, the migrator's role, a login's role, and when the lock is first made: both logins read locked, and the setup writes nothing`, async () => {
        const set = `set ${guc} = '${value}'`;
        const db = await ground.clone("ground", `spelling_${guc.toLowerCase()}`);
        const first = await ground.clone("unlocked", `spelling_first_${guc.toLowerCase()}`);
        const word = (v: { verdict: string; why: readonly string[] }): string => (v.why.length === 0 ? v.verdict : `${v.verdict} (${v.why.length}: ${v.why[0]})`);
        const logins = async (target: string, pre: readonly string[] = []): Promise<string[]> =>
          [word(await verdictUnder(target, "ohmail_api", pre)), word(await verdictUnder(target, "ohmail_worker", pre))];
        const setupOf = (target: string, opts: { lock?: "apply" } = {}): Promise<object | string> => ground.setup(target, MIGRATOR_ROLE, opts)
          .then((r) => ({ state: r.lock!.state, wrote: r.lock!.wrote, repaired: r.lock!.repaired.length }), (e: Error) => e.message);
        const census = async (target: string): Promise<number> => (await plantAndCensus(target, [])).length;
        const su = ground.connectAs("postgres");
        const undo = [`alter database "${db}" reset ${guc}`, `alter role ${MIGRATOR_ROLE} in database "${db}" reset ${guc}`,
          `alter role ohmail_worker in database "${db}" reset ${guc}`, `alter role ${MIGRATOR_ROLE} in database "${first}" reset ${guc}`];
        try {
          const session = { logins: await logins(db, [set]), census: (await plantAndCensus(db, [set])).length };
          await su.unsafe(`alter database "${db}" set ${guc} = '${value}'`);
          const database = { logins: await logins(db), census: await census(db), setup: await setupOf(db) };
          await su.unsafe(undo[0]!);
          const databaseReset = { logins: await logins(db), setup: await setupOf(db) };
          await su.unsafe(`alter role ${MIGRATOR_ROLE} in database "${db}" set ${guc} = '${value}'`);
          const migratorsRole = { setup: await setupOf(db), logins: await logins(db), census: await census(db) };
          await su.unsafe(undo[1]!);
          await su.unsafe(`alter role ohmail_worker in database "${db}" set ${guc} = '${value}'`);
          const refused = await setupOf(db);
          const loginsRole = { logins: await logins(db),
            setup: typeof refused === "string" && /ROLES_DRIFT role ohmail_worker: the setting \S+ is set in database/.test(refused) ? "refused by the roles' check" : refused };
          await su.unsafe(undo[2]!);
          await su.unsafe(`alter role ${MIGRATOR_ROLE} in database "${first}" set ${guc} = '${value}'`);
          const made = await setupOf(first, { lock: "apply" });
          const firstLock = { made: typeof made === "string" ? made : { state: (made as { state: string }).state, repaired: (made as { repaired: number }).repaired },
            logins: await logins(first), census: await census(first), again: await setupOf(first) };
          await su.unsafe(undo[3]!);
          const firstReset = { logins: await logins(first), setup: await setupOf(first) };
          const LOCKED = ["locked", "locked"];
          const NOTHING = { state: "locked", wrote: 0, repaired: 0 };
          expect({ session, database, databaseReset, migratorsRole, loginsRole, firstLock, firstReset }, `${guc} = ${value}`).toEqual({
            session: { logins: LOCKED, census: 0 },
            database: { logins: LOCKED, census: 0, setup: NOTHING },
            databaseReset: { logins: LOCKED, setup: NOTHING },
            migratorsRole: { setup: NOTHING, logins: LOCKED, census: 0 },
            loginsRole: { logins: LOCKED, setup: "refused by the roles' check" },
            firstLock: { made: { state: "locked", repaired: 0 }, logins: LOCKED, census: ungrantedLines().length, again: NOTHING },
            firstReset: { logins: LOCKED, setup: NOTHING },
          });
        } finally {
          // A login's setting in any database is the roles' check's refusal everywhere: none outlives the case.
          for (const s of undo) await su.unsafe(s);
          await su.end({ timeout: 5 });
        }
      }, CASE_MS);
    }

    it("a policy altered, or made again by hand, stays broken under each of those settings, on the reading session and on the database", async () => {
      const db = await ground.clone("ground", "spelling_fail_closed");
      const mig = ground.connectAs(db, MIGRATOR_ROLE);
      try {
        await mig.unsafe("alter policy lock_account on public.cal_settings using (true) with check (true)");
        await mig.unsafe("alter policy lock_account on public.messages using (account_id = ohmail.current_account() or true)");
        await mig.unsafe("drop policy lock_account on public.mailboxes");
        await mig.unsafe("create policy lock_account on public.mailboxes for all to ohmail_api, ohmail_worker using (true) with check (true)");
      } finally {
        await mig.end({ timeout: 5 });
      }
      const broken = (role: string): object => ({ verdict: "broken", why: [notAsListed(role, ALTERED),
        notAsListed(role, UNRECORDED, "mailboxes.lock_account"), notAsListed(role, ALTERED, "messages.lock_account")] });
      const both = async (pre: readonly string[] = []): Promise<object[]> => [await verdictUnder(db, "ohmail_api", pre), await verdictUnder(db, "ohmail_worker", pre)];
      const want = [broken("ohmail_api"), broken("ohmail_worker")];
      const su = ground.connectAs("postgres");
      try {
        const got: Record<string, object[]> = { plain: await both() };
        for (const [guc, value] of SPELLING_MOVERS) {
          got[`session ${guc}`] = await both([`set ${guc} = '${value}'`]);
          await su.unsafe(`alter database "${db}" set ${guc} = '${value}'`);
          try { got[`database ${guc}`] = await both(); } finally { await su.unsafe(`alter database "${db}" reset ${guc}`); }
        }
        expect(got).toEqual(Object.fromEntries(Object.keys(got).map((k) => [k, want])));
      } finally {
        await su.end({ timeout: 5 });
      }
    }, CASE_MS);

    it("a binding setting on another database is that database's: this one's census and check do not read it", async () => {
      const here = await ground.clone("ground", "binding_here");
      const there = await ground.clone("ground", "binding_there");
      const su = ground.connectAs("postgres");
      try {
        await su.unsafe(`alter database "${there}" set ohmail.account = '00000000-0000-4000-8000-000000000001'`);
        expect(await plantAndCensus(here, [])).toEqual([]);
        expect((await verdictOf(here, "ohmail_api", { role: "ohmail_api" })).verdict).toBe("locked");
        expect(await plantAndCensus(there, [])).toEqual([drift("settings.binding", `-/${there}/ohmail.account`, "the binding's setting stands on a role or a database")]);
        expect(await verdictOf(there, "ohmail_api", { role: "ohmail_api" }))
          .toMatchObject({ verdict: "broken", why: [`the binding's setting stands on a role or a database: -/${there}/ohmail.account`] });
      } finally {
        await su.end({ timeout: 5 });
      }
    }, CASE_MS);

    it("a deadline that drifted on a login refuses the step by the roles' check, and reads back once the roles' script ran", async () => {
      const su = ground.connectAs("postgres");
      await su.unsafe("alter role ohmail_api set lock_timeout = '1s'");
      try {
        await expect(ground.setup("ground", MIGRATOR_ROLE)).rejects
          .toThrow(/lock: the runtime roles' check refused: ROLES_DRIFT role ohmail_api: lock_timeout is 1s, not 30000ms/);
      } finally {
        await su.unsafe("alter role ohmail_api set lock_timeout = '30000ms'");
        await su.end({ timeout: 5 });
      }
      const report = await ground.setup("ground", MIGRATOR_ROLE);
      expect(report.lock!.deadlines.ohmail_api).toEqual({ lock_timeout: true, statement_timeout: true, idle_in_transaction_session_timeout: true });
    }, CASE_MS);

    /** How many rows of `table` `role` reads on `db`, with nothing named. */
    async function unboundCount(db: string, role: string, table: string): Promise<number> {
      const sql = ground.connectAs(db, role);
      try {
        const [r] = await sql.unsafe(`select count(*)::int as n from public.${table}`) as unknown as Array<{ n: number }>;
        return r!.n;
      } finally {
        await sql.end({ timeout: 5 });
      }
    }

    /** The lock's verdict on `db`, read as `role`, judged for `expect` when given. */
    async function verdictOf(db: string, role: string, expect?: { role: string }): Promise<LockReading> {
      const sql = ground.connectAs(db, role);
      try { return await readLock(sql, expect); } finally { await sql.end({ timeout: 5 }); }
    }

    it("the marker cannot be a database setting: the migrator may not set an unknown parameter on its database", async () => {
      const sql = ground.connectAs("ground", MIGRATOR_ROLE);
      try {
        const code = await sql.unsafe("alter database ground set ohmail.lock = 'off'").then(() => "taken", (e: { code?: string }) => e.code);
        expect(code).toBe("42501");
      } finally {
        await sql.end({ timeout: 5 });
      }
    }, CASE_MS);

    it("the switch off releases the lock and says so; on again, the API's role reads nothing unbound", async () => {
      const db = await ground.clone("ground", "switch_off_on");
      const mig = ground.connectAs(db, MIGRATOR_ROLE);
      try { await mig.unsafe("insert into public.accounts (name) values ('switched')"); } finally { await mig.end({ timeout: 5 }); }
      expect(await unboundCount(db, "ohmail_api", "accounts")).toBe(0);
      const off = await switchLock(ground.urlAs(db, MIGRATOR_ROLE), "off", { why: "test", now: () => new Date("2026-11-15T10:00:00.000Z") });
      expect(off).toMatchObject({ to: "off", tables: 102, tries: 1, marker: "ohmail.lock off since=2026-11-15T10:00:00.000Z by=ohmail_migrator why=test" });
      expect(await unboundCount(db, "ohmail_api", "accounts")).toBe(1);
      expect(await verdictOf(db, MIGRATOR_ROLE)).toMatchObject({ verdict: "off", on: 0, forced: 0, marker: { since: "2026-11-15T10:00:00.000Z", by: "ohmail_migrator", why: "test" } });
      // The setup over a lock that is off keeps it off, and its policies as listed.
      expect((await ground.setup(db, MIGRATOR_ROLE)).lock).toMatchObject({ state: "off", forced: 0, wrote: 0 });
      expect(await switchLock(ground.urlAs(db, MIGRATOR_ROLE), "on")).toMatchObject({ to: "on", tables: 102, marker: null });
      expect(await unboundCount(db, "ohmail_api", "accounts")).toBe(0);
      expect((await verdictOf(db, MIGRATOR_ROLE)).verdict).toBe("locked");
    }, CASE_MS);

    it("the switch off and on again over a view the setup made again and the roles' apply has not granted yet: the logins' rights are not the switch's", async () => {
      const db = await ground.clone("ground", "switch_view_ungranted");
      await plantAndCensus(db, ["drop view ohmail.message_search_words"]);
      expect((await ground.setup(db, MIGRATOR_ROLE)).lock!.repaired).toEqual(["view ohmail.message_search_words was missing: made"]);
      const ungranted = ["ohmail_api", "ohmail_worker"].map((l) => `LOCK_DRIFT views.ungranted ohmail.message_search_words: ${l} holds no SELECT`);
      expect(await plantAndCensus(db, [])).toEqual(ungranted);
      await switchLock(ground.urlAs(db, MIGRATOR_ROLE), "off", { why: "test" });
      expect(await switchLock(ground.urlAs(db, MIGRATOR_ROLE), "on")).toMatchObject({ to: "on", marker: null });
      expect({ verdict: (await verdictOf(db, MIGRATOR_ROLE)).verdict, census: await plantAndCensus(db, []) }).toEqual({ verdict: "locked", census: ungranted });
    }, CASE_MS);

    it("forcing alone taken off, as the switch was first written, releases nobody: the logins own nothing", async () => {
      const db = await ground.clone("ground", "switch_no_force");
      const mig = ground.connectAs(db, MIGRATOR_ROLE);
      try {
        await mig.unsafe("insert into public.accounts (name) values ('forced')");
        await mig.unsafe("alter table public.accounts no force row level security");
      } finally {
        await mig.end({ timeout: 5 });
      }
      expect(await unboundCount(db, "ohmail_api", "accounts")).toBe(0);
      expect((await verdictOf(db, MIGRATOR_ROLE)).verdict).toBe("broken");
    }, CASE_MS);

    it("the four states read as the table says: locked, a stale marker, off, and a mixed state broken", async () => {
      const db = await ground.clone("ground", "switch_states");
      expect((await verdictOf(db, MIGRATOR_ROLE)).verdict).toBe("locked");
      const mig = ground.connectAs(db, MIGRATOR_ROLE);
      try {
        await mig.unsafe("comment on schema ohmail is 'ohmail.lock off since=2026-11-15T10:00:00.000Z by=ohmail_migrator why=incident'");
        expect((await verdictOf(db, MIGRATOR_ROLE)).verdict).toBe("stale_marker");
        await mig.unsafe("comment on schema ohmail is null");
        await mig.unsafe("alter table public.messages disable row level security");
        expect(await verdictOf(db, MIGRATOR_ROLE)).toMatchObject({ verdict: "broken", on: 101 });
        await mig.unsafe("alter table public.messages enable row level security");
      } finally {
        await mig.end({ timeout: 5 });
      }
      await switchLock(ground.urlAs(db, MIGRATOR_ROLE), "off", { why: "rehearsal" });
      expect((await verdictOf(db, MIGRATOR_ROLE)).verdict).toBe("off");
    }, CASE_MS);

    it("a switch behind a held lock changes nothing", async () => {
      const db = await ground.clone("ground", "switch_held");
      const holder = ground.connectAs(db);
      try {
        await holder.unsafe("begin");
        await holder.unsafe("lock table public.accounts in access share mode");
        const refused = await switchLock(ground.urlAs(db, MIGRATOR_ROLE), "off", { why: "test", lockTimeoutMs: 200, tries: 2 })
          .then(() => "switched", (e: { code?: string }) => e.code);
        expect(refused).toBe("55P03");
        expect(await verdictOf(db, MIGRATOR_ROLE)).toMatchObject({ verdict: "locked", marker: null });
      } finally {
        await holder.unsafe("rollback").catch(() => undefined);
        await holder.end({ timeout: 5 });
      }
    }, CASE_MS);

    it("asked to serve as the API: its own login reads locked; the migrator's address, or a login that may bypass, is broken", async () => {
      expect(await verdictOf("ground", "ohmail_api", { role: "ohmail_api" })).toMatchObject({ verdict: "locked", role: { policies: "equal", bypass: false } });
      expect((await verdictOf("ground", MIGRATOR_ROLE, { role: "ohmail_api" })).verdict).toBe("broken");
      const su = ground.connectAs("postgres");
      await su.unsafe("alter role ohmail_api bypassrls");
      try {
        expect(await verdictOf("ground", "ohmail_api", { role: "ohmail_api" }))
          .toMatchObject({ verdict: "broken", why: ["ohmail_api may bypass row security"] });
      } finally {
        await su.unsafe("alter role ohmail_api nobypassrls");
        await su.end({ timeout: 5 });
      }
    }, CASE_MS);

    /** Two accounts on `db`, made by the migrator: their ids. */
    async function twoAccounts(db: string): Promise<[string, string]> {
      const mig = ground.connectAs(db, MIGRATOR_ROLE);
      try {
        const made = await mig.unsafe("insert into public.accounts (name) values ('A'), ('B') returning id::text as id");
        return [String(made[0]!.id), String(made[1]!.id)];
      } finally {
        await mig.end({ timeout: 5 });
      }
    }

    /**
     * On one connection as the API's login, the same read of `accounts` in a transaction bound to
     * each of `accounts` in turn ("" names none): the driver prepares it once and runs it again, as
     * a pooled session does. With `param`, the read carries a parameter.
     */
    async function preparedReads(db: string, accounts: string[], param = false): Promise<string[][]> {
      const c = ground.connectAs(db, "ohmail_api");
      try {
        const out: string[][] = [];
        for (const account of accounts) {
          out.push(await c.begin(async (tx) => {
            await tx.unsafe(BINDER_SQL, [account, ""]);
            const read = param
              ? await tx<Array<{ id: string }>>`select id::text as id from public.accounts where name <> ${"-"}`
              : await tx<Array<{ id: string }>>`select id::text as id from public.accounts`;
            return read.map((r) => r.id).sort();
          }) as string[]);
        }
        return out;
      } finally {
        await c.end({ timeout: 5 });
      }
    }

    it("a policy to PUBLIC: both logins read both accounts; the census names it, the check reads broken, and the next setup drops it", async () => {
      const db = await ground.clone("ground", "policy_public");
      const [a, b] = await twoAccounts(db);
      expect(await preparedReads(db, [a, ""])).toEqual([[a], []]);
      expect(await plantAndCensus(db, ["create policy pub on public.accounts for select to public using (true)"]))
        .toEqual(["LOCK_DRIFT policies.foreign accounts.pub: a policy the list does not name"]);
      expect(await preparedReads(db, [a, ""])).toEqual([[a, b].sort(), [a, b].sort()]);
      for (const role of ["ohmail_api", "ohmail_worker"]) {
        expect(await verdictOf(db, role, { role }), role).toMatchObject({ verdict: "broken", role: { policies: "differ" } });
      }
      expect(await verdictOf(db, MIGRATOR_ROLE)).toMatchObject({ verdict: "broken", why: ["a policy names PUBLIC: accounts.pub"] });
      expect((await ground.setup(db, MIGRATOR_ROLE)).lock!.repaired).toEqual(["policy accounts.pub is not the list's: dropped"]);
      expect(await preparedReads(db, [a, ""])).toEqual([[a], []]);
      expect((await verdictOf(db, "ohmail_api", { role: "ohmail_api" })).verdict).toBe("locked");
    }, CASE_MS);

    it("a reader made IMMUTABLE answers the rows of the account a read was prepared under to the next; the census and the check read it, and the next setup makes it again", async () => {
      const db = await ground.clone("ground", "reader_immutable");
      const [a, b] = await twoAccounts(db);
      // The reader as listed: each transaction reads its own account, with or without a parameter.
      expect(await preparedReads(db, [a, b, ""])).toEqual([[a], [b], []]);
      expect(await preparedReads(db, [a, a, a, a, a, a, b, ""], true)).toEqual([[a], [a], [a], [a], [a], [a], [b], []]);
      expect(await plantAndCensus(db, ["alter function ohmail.current_account() immutable"]))
        .toEqual(["LOCK_DRIFT readers.differ ohmail.current_account: volatility"]);
      // Planned once, the read keeps the first account it was planned under.
      expect(await preparedReads(db, [a, b, ""])).toEqual([[a], [a], [a]]);
      expect(await preparedReads(db, [a, a, a, a, a, a, b, ""], true)).toEqual([[a], [a], [a], [a], [a], [a], [a], [a]]);
      for (const role of ["ohmail_api", "ohmail_worker"]) {
        expect(await verdictOf(db, role, { role }), role)
          .toMatchObject({ verdict: "broken", why: ["the reader ohmail.current_account differs: volatility"], role: { policies: "equal" } });
      }
      expect((await ground.setup(db, MIGRATOR_ROLE)).lock!.repaired).toEqual(["reader ohmail.current_account made again: volatility"]);
      expect(await preparedReads(db, [a, b, ""])).toEqual([[a], [b], []]);
      expect((await verdictOf(db, "ohmail_api", { role: "ohmail_api" })).verdict).toBe("locked");
    }, CASE_MS);

    it("a view of public, or a SECURITY DEFINER routine there, reads past the lock with its owner's rights: the check reads broken, and the setup refuses", async () => {
      for (const [name, plant, read, why, refused] of [
        ["past_view", ["create view public.all_accounts as select id from public.accounts", "grant select on public.all_accounts to ohmail_api"],
          "select count(*)::int as n from public.all_accounts", "ohmail_api may reach a view or a foreign table of public", /ROLES_DRIFT SELECT on the view public\.all_accounts: role ohmail_api reaches it/],
        ["past_definer", ["create function public.all_accounts() returns int language sql security definer as 'select count(*)::int from public.accounts'"],
          "select public.all_accounts() as n", "ohmail_api may run a SECURITY DEFINER routine of public", /ROLES_DRIFT EXECUTE on the SECURITY DEFINER routine all_accounts\(\): role ohmail_api can run it/],
      ] as const) {
        const db = await ground.clone("ground", name);
        const [a] = await twoAccounts(db);
        const mig = ground.connectAs(db, MIGRATOR_ROLE);
        try { for (const s of plant) await mig.unsafe(s); } finally { await mig.end({ timeout: 5 }); }
        const api = ground.connectAs(db, "ohmail_api");
        try {
          const seen = await api.begin(async (tx) => {
            await tx.unsafe(BINDER_SQL, [a, ""]);
            return Number((await tx.unsafe(read))[0]!.n);
          });
          expect(seen, name).toBe(2);
        } finally {
          await api.end({ timeout: 5 });
        }
        expect(await verdictOf(db, "ohmail_api", { role: "ohmail_api" }), name).toMatchObject({ verdict: "broken", why: [why] });
        await expect(ground.setup(db, MIGRATOR_ROLE), name).rejects.toThrow(refused);
      }
    }, CASE_MS);

    it("one login alone: the lock is refused where it stands, and nothing asks it where it does not", async () => {
      const su = ground.connectAs("postgres");
      await su.unsafe("alter role ohmail_worker rename to ohmail_worker_aside");
      try {
        await expect(ground.setup("ground", MIGRATOR_ROLE)).rejects.toThrow(/lock: refused: of the two runtime logins only ohmail_api exists/);
        const quiet = await ground.setup("unlocked", MIGRATOR_ROLE);
        expect(quiet.lock).toMatchObject({ state: "not-applied", wrote: 0 });
      } finally {
        await su.unsafe("alter role ohmail_worker_aside rename to ohmail_worker");
        await su.end({ timeout: 5 });
      }
    }, CASE_MS);
  });
}
