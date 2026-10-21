import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brandDialect } from "../src/dialect/index.js";
import { schema } from "../src/schema.js";
import { recordAlertPass } from "../src/alerts.js";
import { STAFF_ROLE, STAFF_SELECT_GRANTS } from "../src/staff-grants.js";
import { MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, makeTestDb, realPgAvailable } from "../src/testing.js";
import type { Tx } from "../src/change-log.js";
import { hardenScriptWithout } from "./_harden-script.js";

/**
 * CLOUD 0049 — THE STAFF ROLE'S GRANT ON THE GAP HISTORY, for a database migrated but not re-hardened.
 *
 * The API stamps its alert pass as `ohmail_admin`, and `recordAlertPass` writes `alert_pass_runs` and
 * 0048's `alert_driver_gaps` in ONE statement. `scripts/harden-staff-role.sql` sets no default
 * privileges, so 0048's table reaches the role only when the script is re-run; until then the whole
 * stamp fails and the worker reports the API arm dark. 0049 is the script's belt: the same grants,
 * applied by the migrator, only where the role exists.
 *
 * THE DATABASE PRODUCTION HAS: the journal through 0048, the SHIPPED script run verbatim, then the
 * one stanza the script gained with 0048 taken back (`#72` added that stanza and nothing else). That
 * is a database hardened before 0048 and not since. On it the role's insert and update of a gap row
 * are refused 42501 and the product's stamp lands neither row; once the migrator has applied 0049
 * both are admitted and the stamp lands both. The grant is then read off the catalog BY EQUALITY with
 * the script's stanza, so a table-level grant or any privilege the script does not give reads red.
 *
 * The role is assumed with SET ROLE on a one-connection client (the lane role is a superuser), so no
 * password is ever set on the cluster-wide role `staff-role.pg.test.ts` logs in as. PGlite and a
 * self-hosted Postgres have no `ohmail_admin`: there the migration must do nothing, and fail nothing.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const SCRIPT = join(REPO, "scripts", "harden-staff-role.sql");
const MAIL_DIR = join(HERE, "..", "..", "db-mail", "drizzle");
const CLOUD_DIR = join(HERE, "..", "drizzle-cloud");
const TAG = "0049_alert_driver_gaps_staff_grant";
const MIGRATION = join(CLOUD_DIR, `${TAG}.sql`);
const TABLE = "alert_driver_gaps";
const COLUMNS = ["day", "driver", "max_gap_at", "max_gap_s", "passes"];
const VERBS = ["INSERT", "SELECT", "UPDATE"];
/** Every (privilege, column) the script's stanza gives, as `VERB column`, sorted. */
const EXPECTED = VERBS.flatMap((v) => COLUMNS.map((c) => `${v} ${c}`)).sort();

/**
 * Every GRANT a text gives on the gap table, as `VERB column` (or `VERB *` for a table-level grant),
 * sorted. Read off the statements themselves, so a widening in either file changes this set.
 */
function grantsOnTable(text: string, table: RegExp): string[] {
  const out: string[] = [];
  const noComments = text.replace(/^\s*--[^\n]*$/gm, "");
  const re = new RegExp(String.raw`GRANT\s+([A-Z ,]+?)\s*(\(([^)]*)\))?\s+ON\s+(?:TABLE\s+)?` + table.source + String.raw`\s+TO\s+(\w+)`, "gi");
  for (const m of noComments.matchAll(re)) {
    expect(m[4]!.toLowerCase(), "a grant on the gap table to another role").toBe(STAFF_ROLE);
    const verbs = m[1]!.split(",").map((v) => v.trim().toUpperCase()).filter(Boolean);
    const cols = m[3] === undefined ? ["*"] : m[3].split(",").map((c) => c.trim().replace(/"/g, ""));
    for (const v of verbs) for (const c of cols) out.push(`${v} ${c}`);
  }
  return out.sort();
}

describe("cloud 0049 says what the harden script says, and only that", () => {
  const migration = readFileSync(MIGRATION, "utf8");
  const script = readFileSync(SCRIPT, "utf8");

  it("its grants are the script's alert_driver_gaps stanza, verb for verb and column for column", () => {
    const fromScript = grantsOnTable(script, /public\.alert_driver_gaps/);
    const fromMigration = grantsOnTable(migration, /"alert_driver_gaps"/);
    expect(fromScript).toEqual(EXPECTED);
    expect(fromMigration).toEqual(fromScript);
    // The script's SELECT columns are the allowlist the boot attestation holds the role to.
    expect([...STAFF_SELECT_GRANTS["public.alert_driver_gaps"]!].sort()).toEqual(COLUMNS);
  });

  it("revokes before it grants, and only inside the role guard", () => {
    const body = migration.replace(/^\s*--[^\n]*$/gm, "");
    const guard = body.indexOf("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohmail_admin') THEN");
    const revoke = body.indexOf(`REVOKE ALL ON TABLE "${TABLE}" FROM ohmail_admin;`);
    const firstGrant = body.search(/GRANT\s/);
    expect(guard, "the role guard").toBeGreaterThan(-1);
    expect(revoke, "the REVOKE ALL").toBeGreaterThan(guard);
    expect(firstGrant).toBeGreaterThan(revoke);
    expect(body.indexOf("END IF;"), "every statement inside the guard").toBeGreaterThan(body.lastIndexOf("GRANT"));
  });
});

describe("cloud 0049 on PGlite: no role, so nothing happens and nothing fails", () => {
  it("the journal replays with 0049 in it, and the gap table carries no grant", async () => {
    const db = await makeTestDb();
    const roles = await db.execute(dsql`select count(*)::int as n from pg_roles where rolname = ${STAFF_ROLE}`);
    expect((roles.rows[0] as { n: number }).n).toBe(0);
    const acl = await db.execute(dsql`select relacl::text as acl from pg_class where relname = ${TABLE}`);
    expect(acl.rows).toHaveLength(1);
    expect((acl.rows[0] as { acl: string | null }).acl).toBeNull();
  }, 120_000);
});

const SUFFIX = randomUUID().replace(/-/g, "").slice(0, 12);
const DB_NAME = `ohmail_gap_grant_${SUFFIX}`;

function urlFor(dbName: string): string {
  const u = new URL(PG_TEST_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * This file builds its own database from the journals and reads nothing in the lane database, so it
 * asks for the SERVER, through its maintenance database, which no migrator touches. Gating on the lane
 * database would make the answer depend on whether that database carries this tree's 0049, which is
 * not what anything here measures.
 */
const SERVER_URL = urlFor("postgres");
const PG_UP = await realPgAvailable(SERVER_URL);

/** The cloud journal through 0048 alone, in a folder of its own: the database before this migration. */
function journalThrough0048(): string {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-cloud-0048-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync(join(CLOUD_DIR, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const cut = journal.entries.findIndex((e) => e.tag === TAG);
  expect(cut, `${TAG} is in the journal`).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, cut);
  expect(journal.entries.at(-1)!.tag).toBe("0048_alert_driver_gaps");
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal, null, 2));
  for (const e of journal.entries) copyFileSync(join(CLOUD_DIR, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

describe.skipIf(!PG_UP)("cloud 0049 on real Postgres: the role's gap writes, refused before and admitted after", () => {
  let root: ReturnType<typeof postgres>;
  let ownerClient: ReturnType<typeof postgres>;
  let roleClient: ReturnType<typeof postgres>;
  let before0049: string;

  const owner = () => brandDialect(drizzle(ownerClient, { schema }), "pg");
  /** The stamp the API's pass runs, on the role's connection. It swallows its own failure by contract. */
  const stampAsRole = (now: Date): Promise<void> =>
    recordAlertPass(brandDialect(drizzle(roleClient, { schema }), "pg") as unknown as Tx, {
      driver: "api", now, firing: 0, delivered: 0, failedSinks: 0, refusedAll: false, sinksConfigured: 1,
    });
  const rows = async () => {
    const [runs] = await ownerClient<Array<{ n: number }>>`select count(*)::int as n from alert_pass_runs where driver = 'api'`;
    const gaps = await ownerClient<Array<{ passes: number }>>`select passes from alert_driver_gaps where driver = 'api'`;
    return { runs: runs!.n, gapPasses: gaps.map((g) => g.passes) };
  };
  /** The role's own write of a gap row: the code it is refused with, or "ok". */
  const asRole = async (statement: string): Promise<string> => {
    try {
      await roleClient.unsafe(statement);
      return "ok";
    } catch (e) {
      return String((e as { code?: string }).code ?? e);
    }
  };
  /** What the catalog says the role holds on the gap table: `VERB column`, and `VERB *` table-wide. */
  const heldByRole = async (): Promise<string[]> => {
    const table = await ownerClient<Array<{ p: string }>>`
      select a.privilege_type as p from pg_class c, aclexplode(c.relacl) a
       where c.oid = ${`public.${TABLE}`}::regclass and a.grantee = ${STAFF_ROLE}::regrole`;
    const cols = await ownerClient<Array<{ p: string; col: string }>>`
      select a.privilege_type as p, att.attname as col from pg_attribute att, aclexplode(att.attacl) a
       where att.attrelid = ${`public.${TABLE}`}::regclass and att.attnum > 0 and not att.attisdropped
         and a.grantee = ${STAFF_ROLE}::regrole`;
    return [...table.map((r) => `${r.p} *`), ...cols.map((r) => `${r.p} ${r.col}`)].sort();
  };

  beforeAll(async () => {
    root = postgres(SERVER_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
    await root.unsafe(`drop database if exists "${DB_NAME}" with (force)`);
    await root.unsafe(`create database "${DB_NAME}"`);
    ownerClient = postgres(urlFor(DB_NAME), { max: 1, onnotice: () => {} });

    before0049 = journalThrough0048();
    await migrate(owner(), { migrationsFolder: MAIL_DIR, migrationsSchema: "drizzle_mail" });
    await migrate(owner(), { migrationsFolder: before0049, migrationsSchema: "drizzle_cloud" });
    // The shipped script — it creates the role when absent — without the stanzas of tables newer
    // than this database (cloud 0051's `alert_drills`), then the stanza 0048 added to it taken back:
    // the role as production holds it, hardened before 0048 and not since.
    await ownerClient.unsafe(hardenScriptWithout("alert_drills")).simple();
    await ownerClient.unsafe(`revoke all on public.${TABLE} from ${STAFF_ROLE}`);

    roleClient = postgres(urlFor(DB_NAME), { max: 1, onnotice: () => {} });
    await roleClient.unsafe(`set role ${STAFF_ROLE}`);
  }, 300_000);

  afterAll(async () => {
    await roleClient?.end({ timeout: 5 }).catch(() => {});
    await ownerClient?.end({ timeout: 5 }).catch(() => {});
    await root?.unsafe(`drop database if exists "${DB_NAME}" with (force)`).catch(() => {});
    await root?.end({ timeout: 5 }).catch(() => {});
    if (before0049) rmSync(before0049, { recursive: true, force: true });
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("the role connection really is the role, and holds alert_pass_runs as production does", async () => {
    const [who] = await roleClient<Array<{ u: string; s: boolean }>>`
      select current_user as u, (select rolsuper from pg_roles where rolname = current_user) as s`;
    expect(who).toEqual({ u: STAFF_ROLE, s: false });
    // The stamp's other table, granted by the script's 0030 stanza: what has held in production since 09-26.
    expect(await asRole(`insert into alert_pass_runs (driver, ran_at, firing, delivered, failed_sinks, sink_failure_streak, sinks_configured)
      values ('worker', now(), 0, 0, 0, 0, 1)`)).toBe("ok");
    await ownerClient`delete from alert_pass_runs`;
  });

  it("before 0049: the role's insert and update of a gap row are refused 42501, and the stamp lands neither row", async () => {
    expect(await heldByRole()).toEqual([]);
    expect(await asRole(`insert into ${TABLE} (driver, day, passes, max_gap_s, max_gap_at) values ('api', current_date, 1, 0, null)`))
      .toBe("42501");
    await ownerClient`insert into alert_driver_gaps (driver, day, passes, max_gap_s) values ('worker', current_date, 1, 0)`;
    expect(await asRole(`update ${TABLE} set passes = passes + 1 where driver = 'worker'`)).toBe("42501");
    await ownerClient`delete from alert_driver_gaps`;
    // The production failure itself: one statement, so the run stamp goes down with the gap row.
    await stampAsRole(new Date("2026-10-17T12:00:00.000Z"));
    expect(await rows()).toEqual({ runs: 0, gapPasses: [] });
  });

  it("the migrator applies 0049 alone, and then the role's insert and update are admitted and the stamp lands both rows", async () => {
    await migrate(owner(), { migrationsFolder: CLOUD_DIR, migrationsSchema: "drizzle_cloud" });
    const [last] = await ownerClient<Array<{ n: number }>>`select count(*)::int as n from drizzle_cloud.__drizzle_migrations`;
    const entries = (JSON.parse(readFileSync(join(CLOUD_DIR, "meta", "_journal.json"), "utf8")) as { entries: unknown[] }).entries;
    expect(last!.n).toBe(entries.length);

    expect(await asRole(`insert into ${TABLE} (driver, day, passes, max_gap_s, max_gap_at) values ('worker', current_date, 1, 0, null)`))
      .toBe("ok");
    expect(await asRole(`update ${TABLE} set passes = passes + 1, max_gap_s = 60, max_gap_at = now() where driver = 'worker'`))
      .toBe("ok");
    // DELETE stays the worker's: the role prunes nothing.
    expect(await asRole(`delete from ${TABLE} where driver = 'worker'`)).toBe("42501");
    await ownerClient`delete from alert_driver_gaps`;

    await stampAsRole(new Date("2026-10-17T12:00:00.000Z"));
    await stampAsRole(new Date("2026-10-17T12:02:00.000Z"));
    expect(await rows()).toEqual({ runs: 1, gapPasses: [2] });
  });

  it("after 0049 the role holds exactly the script's stanza: no table-level grant, no other privilege", async () => {
    expect(await heldByRole()).toEqual(EXPECTED);
    const [wide] = await ownerClient<Array<Record<string, boolean>>>`
      select has_table_privilege(${STAFF_ROLE}, ${`public.${TABLE}`}, 'DELETE') as del,
             has_table_privilege(${STAFF_ROLE}, ${`public.${TABLE}`}, 'TRUNCATE') as trunc,
             has_table_privilege(${STAFF_ROLE}, ${`public.${TABLE}`}, 'REFERENCES') as refs,
             has_table_privilege(${STAFF_ROLE}, ${`public.${TABLE}`}, 'TRIGGER') as trig`;
    expect(wide).toEqual({ del: false, trunc: false, refs: false, trig: false });
  });

  it("re-running the harden script afterwards leaves the same privileges: either order agrees", async () => {
    await ownerClient.unsafe(readFileSync(SCRIPT, "utf8")).simple();
    expect(await heldByRole()).toEqual(EXPECTED);
  });

  it("where the role is absent (a self-hosted Postgres), the same statement does nothing and fails nothing", async () => {
    const absent = `ohmail_admin_absent_${SUFFIX}`;
    const [none] = await ownerClient<Array<{ n: number }>>`select count(*)::int as n from pg_roles where rolname = ${absent}`;
    expect(none!.n).toBe(0);
    const [aclBefore] = await ownerClient<Array<{ acl: string | null }>>`
      select relacl::text as acl from pg_class where oid = ${`public.${TABLE}`}::regclass`;
    // The migration's own text, its one role name swapped for one that does not exist.
    await ownerClient.unsafe(readFileSync(MIGRATION, "utf8").replaceAll("ohmail_admin", absent));
    const [aclAfter] = await ownerClient<Array<{ acl: string | null }>>`
      select relacl::text as acl from pg_class where oid = ${`public.${TABLE}`}::regclass`;
    expect(aclAfter!.acl).toBe(aclBefore!.acl);
    expect(await heldByRole()).toEqual(EXPECTED);
  });
});
