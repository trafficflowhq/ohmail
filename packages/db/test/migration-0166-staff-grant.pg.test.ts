import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brandDialect } from "../src/dialect/index.js";
import { schema } from "../src/schema.js";
import { STAFF_ROLE, STAFF_SELECT_GRANTS } from "../src/staff-grants.js";
import { MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { HARDEN_SCRIPT } from "./_harden-script.js";

/**
 * MAIL 0166 ON A DATABASE HARDENED BEFORE IT: the staff role holds the counter's three 0062 columns;
 * once the migrator has applied 0166 it reads the seven facts too, and nothing more (no table-level
 * privilege, no content). Re-running the harden script afterwards leaves the same set. The role is
 * assumed with SET ROLE on one connection (the lane role is a superuser), so no password is set on
 * the cluster-wide role `staff-role.pg.test.ts` logs in as.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const MAIL_DIR = join(HERE, "..", "..", "db-mail", "drizzle");
const CLOUD_DIR = join(HERE, "..", "drizzle-cloud");
const TAG = "0166_account_storage_facts";
const DB_NAME = `ohmail_m0166_grant_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const urlFor = (db: string): string => { const u = new URL(PG_TEST_URL); u.pathname = `/${db}`; return u.toString(); };
const PG_UP = await realPgAvailable(urlFor("postgres"));
const FACTS = [
  "first_husked_at", "husked_for_space", "kept_from", "last_husked_at", "recount_drift", "recounted_at", "withheld_on_arrival",
];

/** The mail journal up to the entry before 0166, in a folder of its own. */
function journalBefore0166(): string {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-mail-0165-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync(join(MAIL_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === TAG));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal, null, 2));
  for (const e of journal.entries) copyFileSync(join(MAIL_DIR, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

describe.skipIf(!PG_UP)("mail 0166 on a database hardened before it", () => {
  let root: ReturnType<typeof postgres>;
  let owner: ReturnType<typeof postgres>;
  let role: ReturnType<typeof postgres>;
  let before: string;
  const migrateMail = (folder: string) =>
    migrate(brandDialect(drizzle(owner, { schema }), "pg"), { migrationsFolder: folder, migrationsSchema: "drizzle_mail" });
  /** The role's own read: "ok", or the SQLSTATE it is refused with. */
  const asRole = async (statement: string): Promise<string> => {
    try { await role.unsafe(statement); return "ok"; } catch (e) { return String((e as { code?: string }).code ?? e); }
  };
  /** What the catalog says the role holds on account_storage: `VERB column`, and `VERB *` table-wide. */
  const held = async (): Promise<string[]> => {
    const table = await owner<Array<{ p: string }>>`select a.privilege_type as p from pg_class c, aclexplode(c.relacl) a
      where c.oid = 'public.account_storage'::regclass and a.grantee = ${STAFF_ROLE}::regrole`;
    const cols = await owner<Array<{ p: string; col: string }>>`select a.privilege_type as p, att.attname as col
      from pg_attribute att, aclexplode(att.attacl) a where att.attrelid = 'public.account_storage'::regclass
       and att.attnum > 0 and not att.attisdropped and a.grantee = ${STAFF_ROLE}::regrole`;
    return [...table.map((r) => `${r.p} *`), ...cols.map((r) => `${r.p} ${r.col}`)].sort();
  };

  beforeAll(async () => {
    root = postgres(urlFor("postgres"), { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
    await root.unsafe(`create database "${DB_NAME}"`);
    owner = postgres(urlFor(DB_NAME), { max: 1, onnotice: () => {} });
    before = journalBefore0166();
    await migrateMail(before);
    // The role as the 0062 stanza left it: the counter's three columns.
    await owner.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${STAFF_ROLE}')
      THEN CREATE ROLE ${STAFF_ROLE} NOLOGIN; END IF; END $$`);
    await owner.unsafe(`grant usage on schema public to ${STAFF_ROLE}`);
    await owner.unsafe(`grant select (account_id, bytes, updated_at) on public.account_storage to ${STAFF_ROLE}`);
    role = postgres(urlFor(DB_NAME), { max: 1, onnotice: () => {} });
    await role.unsafe(`set role ${STAFF_ROLE}`);
  }, 300_000);

  afterAll(async () => {
    await role?.end({ timeout: 5 }).catch(() => {});
    await owner?.end({ timeout: 5 }).catch(() => {});
    await root?.unsafe(`drop database if exists "${DB_NAME}" with (force)`).catch(() => {});
    await root?.end({ timeout: 5 }).catch(() => {});
    if (before) rmSync(before, { recursive: true, force: true });
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("the migrator's 0166 grants the role the seven facts, and nothing it did not hold", async () => {
    expect(await held()).toEqual(["SELECT account_id", "SELECT bytes", "SELECT updated_at"]);
    await migrateMail(MAIL_DIR);
    expect(await asRole(`select ${FACTS.join(", ")} from account_storage`)).toBe("ok");
    expect(await asRole("select text from message_bodies")).toBe("42501");
    const ten = [...STAFF_SELECT_GRANTS["public.account_storage"]!].map((c) => `SELECT ${c}`).sort();
    expect(ten).toHaveLength(10);
    expect(await held()).toEqual(ten);
  });

  it("re-running the harden script afterwards leaves the same set: either order agrees", async () => {
    await migrate(brandDialect(drizzle(owner, { schema }), "pg"), { migrationsFolder: CLOUD_DIR, migrationsSchema: "drizzle_cloud" });
    await owner.unsafe(readFileSync(HARDEN_SCRIPT, "utf8")).simple();
    expect(await held()).toEqual([...STAFF_SELECT_GRANTS["public.account_storage"]!].map((c) => `SELECT ${c}`).sort());
  });
});
