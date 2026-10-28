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
import {
  ackDrill, deliverDrill, drillAckState, drillKinds, listDrillRuns, recordDrillOutcomes, startDrillRun,
  type AlertSink,
} from "../src/cloud.js";
import { STAFF_ROLE, STAFF_SELECT_GRANTS } from "../src/staff-grants.js";
import { MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import type { Tx } from "../src/change-log.js";
import { HARDEN_SCRIPT, hardenScriptWithout } from "./_harden-script.js";

/**
 * CLOUD 0051'S GRANT, in the migration itself — 0049's lesson applied up front. The API starts,
 * delivers and acknowledges drills as `ohmail_admin`, and `scripts/harden-staff-role.sql` sets no
 * default privileges, so a database migrated but not re-hardened must still let the role do all
 * three. The database production has: the journals through 0050, the harden script as it stood
 * before 0051 (the shipped one with its `alert_drills` stanza taken out), then the migrator. On it
 * the role starts, delivers, records and acknowledges a drill; the same database with 0051's DO
 * block removed refuses the role 42501. The grant is read off the catalog by equality with the
 * script's stanza and with the migration's own text.
 *
 * The role is assumed with SET ROLE on a one-connection client, so no password is ever set on the
 * cluster-wide role `staff-role.pg.test.ts` logs in as.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = HARDEN_SCRIPT;
const MAIL_DIR = join(HERE, "..", "..", "db-mail", "drizzle");
const CLOUD_DIR = join(HERE, "..", "drizzle-cloud");
const TAG = "0051_alert_drills";
const MIGRATION = join(CLOUD_DIR, `${TAG}.sql`);
const TABLE = "alert_drills";
const COLUMNS = [
  "ack_base", "ack_token_hash", "acked_at", "driver", "fired_at", "kind", "outcome", "requested_at", "run_id", "sink",
];
const EXPECTED = [
  ...COLUMNS.map((c) => `SELECT ${c}`),
  ...COLUMNS.filter((c) => c !== "acked_at").map((c) => `INSERT ${c}`),
  "UPDATE acked_at", "UPDATE outcome",
].sort();
const NOW = new Date("2026-12-01T12:00:00.000Z");
const ACK_BASE = "https://ohmail.example/api";

/** Every GRANT a text gives on the drill table, as `VERB column` (`VERB *` table-wide), sorted. */
function grantsOnTable(text: string, table: RegExp): string[] {
  const out: string[] = [];
  const noComments = text.replace(/^\s*--[^\n]*$/gm, "");
  const re = new RegExp(String.raw`GRANT\s+([A-Z ,]+?)\s*(\(([^)]*)\))?\s+ON\s+(?:TABLE\s+)?` + table.source + String.raw`\s+TO\s+(\w+)`, "gi");
  for (const m of noComments.matchAll(re)) {
    expect(m[4]!.toLowerCase(), "a grant on the drill table to another role").toBe(STAFF_ROLE);
    const verbs = m[1]!.split(",").map((v) => v.trim().toUpperCase()).filter(Boolean);
    const cols = m[3] === undefined ? ["*"] : m[3].split(",").map((c) => c.trim().replace(/"/g, ""));
    for (const v of verbs) for (const c of cols) out.push(`${v} ${c}`);
  }
  return out.sort();
}

/** The harden script as it stood before 0051: the shipped one, its `alert_drills` stanza and cloud 0054's taken out. */
const scriptBefore0051 = (): string => hardenScriptWithout(TABLE, "connect_attempts");

describe("cloud 0051's grant says what the harden script says, and only that", () => {
  it("its grants are the script's alert_drills stanza, verb for verb and column for column", () => {
    const fromScript = grantsOnTable(readFileSync(SCRIPT, "utf8"), /public\.alert_drills/);
    const fromMigration = grantsOnTable(readFileSync(MIGRATION, "utf8"), /"alert_drills"/);
    expect(fromScript).toEqual(EXPECTED);
    expect(fromMigration).toEqual(fromScript);
    expect([...STAFF_SELECT_GRANTS["public.alert_drills"]!].sort()).toEqual(COLUMNS);
  });

  it("revokes before it grants, only inside the role guard, and grants no DELETE", () => {
    const body = readFileSync(MIGRATION, "utf8").replace(/^\s*--[^\n]*$/gm, "");
    const guard = body.indexOf("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohmail_admin') THEN");
    const revoke = body.indexOf(`REVOKE ALL ON TABLE "${TABLE}" FROM ohmail_admin;`);
    expect(guard).toBeGreaterThan(-1);
    expect(revoke).toBeGreaterThan(guard);
    expect(body.search(/GRANT\s/)).toBeGreaterThan(revoke);
    expect(body.indexOf("END IF;")).toBeGreaterThan(body.lastIndexOf("GRANT"));
    expect(body).not.toMatch(/GRANT[^;]*DELETE/i);
  });
});

const SUFFIX = randomUUID().replace(/-/g, "").slice(0, 12);
const DB_GRANTED = `ohmail_drill_grant_${SUFFIX}`;
const DB_UNGRANTED = `ohmail_drill_nogrant_${SUFFIX}`;

function urlFor(dbName: string): string {
  const u = new URL(PG_TEST_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** This file builds its own databases, so it asks for the SERVER, through its maintenance database. */
const SERVER_URL = urlFor("postgres");
const PG_UP = await realPgAvailable(SERVER_URL);

/** The cloud journal through 0050, and optionally 0051 rewritten by `rewrite`, in a folder of its own. */
function journalDir(with0051: ((sql: string) => string) | null): string {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-cloud-0051-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync(join(CLOUD_DIR, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const cut = journal.entries.findIndex((e) => e.tag === TAG);
  expect(cut, `${TAG} is in the journal`).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, with0051 ? cut + 1 : cut);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal, null, 2));
  for (const e of journal.entries) {
    if (e.tag === TAG && with0051) writeFileSync(join(dir, `${e.tag}.sql`), with0051(readFileSync(MIGRATION, "utf8")));
    else copyFileSync(join(CLOUD_DIR, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  }
  return dir;
}

describe.skipIf(!PG_UP)("cloud 0051 on real Postgres: a database hardened before it still lets the role drill", () => {
  let root: ReturnType<typeof postgres>;
  const owners: Record<string, ReturnType<typeof postgres>> = {};
  const roles: Record<string, ReturnType<typeof postgres>> = {};
  const dirs: string[] = [];

  const asRoleDb = (name: string): Tx => brandDialect(drizzle(roles[name]!, { schema }), "pg") as unknown as Tx;

  /** The database production has: journals through 0050, the old script, then `final` as 0051. */
  async function build(name: string, final: (sql: string) => string): Promise<void> {
    await root.unsafe(`drop database if exists "${name}" with (force)`);
    await root.unsafe(`create database "${name}"`);
    const owner = postgres(urlFor(name), { max: 1, onnotice: () => {} });
    owners[name] = owner;
    const ownerDb = brandDialect(drizzle(owner, { schema }), "pg");
    const before = journalDir(null);
    const after = journalDir(final);
    dirs.push(before, after);
    await migrate(ownerDb, { migrationsFolder: MAIL_DIR, migrationsSchema: "drizzle_mail" });
    await migrate(ownerDb, { migrationsFolder: before, migrationsSchema: "drizzle_cloud" });
    // The script as production last ran it: it creates the role when absent and knows no drill table.
    await owner.unsafe(scriptBefore0051()).simple();
    await migrate(ownerDb, { migrationsFolder: after, migrationsSchema: "drizzle_cloud" });
    const role = postgres(urlFor(name), { max: 1, onnotice: () => {} });
    await role.unsafe(`set role ${STAFF_ROLE}`);
    roles[name] = role;
  }

  beforeAll(async () => {
    root = postgres(SERVER_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
    await build(DB_GRANTED, (s) => s);
    // The negative control: 0051 without its DO block, as it would have shipped had 0049's lesson not been taken.
    await build(DB_UNGRANTED, (s) => s.slice(0, s.indexOf("DO $$")));
  }, 300_000);

  afterAll(async () => {
    for (const c of [...Object.values(roles), ...Object.values(owners)]) await c.end({ timeout: 5 }).catch(() => {});
    for (const name of [DB_GRANTED, DB_UNGRANTED]) {
      await root?.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {});
    }
    await root?.end({ timeout: 5 }).catch(() => {});
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  /** What the catalog says the role holds on the drill table: `VERB column`, and `VERB *` table-wide. */
  const heldByRole = async (name: string): Promise<string[]> => {
    const owner = owners[name]!;
    const table = await owner<Array<{ p: string }>>`
      select a.privilege_type as p from pg_class c, aclexplode(c.relacl) a
       where c.oid = ${`public.${TABLE}`}::regclass and a.grantee = ${STAFF_ROLE}::regrole`;
    const cols = await owner<Array<{ p: string; col: string }>>`
      select a.privilege_type as p, att.attname as col from pg_attribute att, aclexplode(att.attacl) a
       where att.attrelid = ${`public.${TABLE}`}::regclass and att.attnum > 0 and not att.attisdropped
         and a.grantee = ${STAFF_ROLE}::regrole`;
    return [...table.map((r) => `${r.p} *`), ...cols.map((r) => `${r.p} ${r.col}`)].sort();
  };

  it("the role connection really is the role", async () => {
    const [who] = await roles[DB_GRANTED]!<Array<{ u: string; s: boolean }>>`
      select current_user as u, (select rolsuper from pg_roles where rolname = current_user) as s`;
    expect(who).toEqual({ u: STAFF_ROLE, s: false });
  });

  it("the role starts a run, delivers it, records what each sink said and acknowledges it", async () => {
    const db = asRoleDb(DB_GRANTED);
    const kinds = drillKinds();
    const run = await startDrillRun(db, { kinds, drivers: ["api", "worker"], apiSinkNames: ["mail"], ackBase: ACK_BASE, now: NOW });
    expect(run.state).toBe("started");
    if (run.state !== "started") return;
    const messages: number[] = [];
    const mail: AlertSink = { name: "mail", async notify(alerts) { messages.push(alerts.length); return true; } };
    const report = await deliverDrill([mail], {
      runId: run.runId, kinds, tokens: run.tokens, ackBase: ACK_BASE, source: "api", environment: "test", now: NOW,
    });
    expect(messages).toEqual([kinds.length]);
    await recordDrillOutcomes(db, run.runId, "api", report.outcomes);
    const token = run.tokens.get("mail")!;
    expect((await drillAckState(db, token, NOW)).state).toBe("open");
    expect(await ackDrill(db, token, new Date(NOW.getTime() + 60_000))).toBe(kinds.length);
    const runs = await listDrillRuns(db, 5);
    expect(runs[0]!.messages.find((m) => m.sink === "mail")).toMatchObject({ outcome: "ok", ackedAt: expect.any(String) });
    // The rows are the record: the role removes nothing.
    const refused = await roles[DB_GRANTED]!.unsafe(`delete from ${TABLE}`).then(() => "ok", (e: { code?: string }) => e.code);
    expect(refused).toBe("42501");
  });

  it("without 0051's DO block the same role is refused 42501, so the block is what grants it", async () => {
    expect(await heldByRole(DB_UNGRANTED)).toEqual([]);
    const refused = await startDrillRun(asRoleDb(DB_UNGRANTED), {
      kinds: ["worker_down"], drivers: ["api"], apiSinkNames: ["mail"], ackBase: ACK_BASE, now: NOW,
    }).then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code);
    expect(refused).toBe("42501");
  });

  it("after 0051 the role holds exactly the script's stanza: no table-level grant, no other privilege", async () => {
    expect(await heldByRole(DB_GRANTED)).toEqual(EXPECTED);
    const [wide] = await owners[DB_GRANTED]!<Array<Record<string, boolean>>>`
      select has_table_privilege(${STAFF_ROLE}, ${`public.${TABLE}`}, 'DELETE') as del,
             has_table_privilege(${STAFF_ROLE}, ${`public.${TABLE}`}, 'TRUNCATE') as trunc,
             has_table_privilege(${STAFF_ROLE}, ${`public.${TABLE}`}, 'REFERENCES') as refs,
             has_table_privilege(${STAFF_ROLE}, ${`public.${TABLE}`}, 'TRIGGER') as trig`;
    expect(wide).toEqual({ del: false, trunc: false, refs: false, trig: false });
  });

  it("re-running the shipped harden script afterwards leaves the same privileges: either order agrees", async () => {
    // Without the stanzas of tables newer than this database (cloud 0054's), which it would refuse.
    await owners[DB_GRANTED]!.unsafe(hardenScriptWithout("connect_attempts")).simple();
    expect(await heldByRole(DB_GRANTED)).toEqual(EXPECTED);
  });
});
