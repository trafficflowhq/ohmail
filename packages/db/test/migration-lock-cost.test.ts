import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import * as mailSchema from "../src/schema-mail.js";
import * as cloudSchema from "../src/schema-cloud.js";
import { PREMIGRATION_PREBUILD_SPECS } from "../src/search-setup.js";

/**
 * THE LOCK-COST RULE, ENFORCED — the section "Lock cost on populated tables" in
 * `packages/db-mail/drizzle/README.md`. The migrator replays a journal's pending set in ONE
 * transaction, so a validating FK/CHECK or an index build on a table that grows with mail or
 * traffic holds a write-blocking lock for its whole scan, mid-deploy (0118: 36 validating FKs +
 * 14 unique indexes in one transaction — fine at the rows it met, minutes at 10×). Entries at or
 * below each journal's WATERMARK are shipped and unmodifiable — the rule binds what comes NEXT.
 * pg journals only: SQLite has no NOT VALID and the sqlite twin is not read here.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MAIL_DIR = join(HERE, "..", "..", "db-mail", "drizzle");
const CLOUD_DIR = join(HERE, "..", "drizzle-cloud");

/**
 * The shipped frontier at the moment the rule was adopted (2026-09-19): the max `when` of each
 * journal. It does NOT move when a migration lands — a new entry complies instead. Moving it is
 * a ruled exception, recorded in the README's retrospective section.
 */
const WATERMARKS = {
  mail: { when: 1791602600023, tag: "0119_messages_arrived_at" },
  cloud: { when: 1791328224222, tag: "0039_screener_suggest_owed" },
} as const;

/**
 * The growth tables: a row per message, per message event, or per request/session — what one
 * live mailbox or one live client grows without bound, so a validating scan there is minutes,
 * not milliseconds, at scale. Bounded-per-account tables (accounts, mailboxes, rules, notes…)
 * are deliberately absent: the ceremony would buy nothing there. Each name is asserted against
 * the live schema below, so a rename cannot silently unguard a table.
 */
const MAIL_GROWTH_TABLES: readonly string[] = [
  "attachments", "audit_log", "away_replies", "away_responder_sent", "away_sender_state",
  "change_log", "contacts", "flag_state", "folder_ops", "folder_state", "idempotency_keys",
  "junk_rescues", "learning_signals", "message_bodies", "message_failures", "message_instances",
  "message_search", "message_states", "message_tags", "messages", "outbound_send_fingerprints", "outbound_sends",
  "refresh_tokens", "routing_decisions", "sessions", "threads", "tracker_events",
  "unsubscribe_examined", "unsubscribe_records", "workflow_runs",
];
const CLOUD_GROWTH_TABLES: readonly string[] = [
  "api_faults", "attachment_staging", "auth_events", "connect_attempts", "login_tokens", "platform_signals",
  "staff_audit_log",
];
// Either journal may ALTER a shared table (the cloud one references mail tables), so both
// journals are checked against the union.
const GROWTH = new Set<string>([...MAIL_GROWTH_TABLES, ...CLOUD_GROWTH_TABLES]);

interface Violation {
  file: string;
  table: string;
  clazz: "validating-fk" | "validating-check" | "constraint-index-build"
    | "index-build" | "concurrently-in-journal" | "column-type-rewrite" | "long-statement";
}

/**
 * ONE left-to-right pass over '…' strings ('' escapes), $tag$…$tag$ bodies, `--` line comments
 * and nestable block comments, blanking each so no quoted "FOREIGN KEY" or commented statement
 * can be read as DDL (the two-pass strip is the measured trap — `source-scan.mjs`).
 */
function stripSqlNoise(text: string): string {
  const out = text.split("");
  const n = text.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      blank(i + 1, j);
      i = Math.min(j + 1, n);
      continue;
    }
    if (c === "-" && d === "-") {
      let j = i;
      while (j < n && text[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") { depth++; j += 2; }
        else if (text[j] === "*" && text[j + 1] === "/") { depth--; j += 2; }
        else j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "$") {
      const m = /^\$[a-zA-Z_]*\$/.exec(text.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const end = text.indexOf(tag, i + tag.length);
        blank(i + tag.length, end === -1 ? n : end);
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

const ident = String.raw`"?([A-Za-z0-9_]+)"?`;
const CREATE_INDEX_RE = new RegExp(
  String.raw`^CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?` +
    String.raw`"?[A-Za-z0-9_]+"?\s+ON\s+(?:ONLY\s+)?(?:"?public"?\.)?${ident}`, "i");
const ALTER_TABLE_RE = new RegExp(
  String.raw`^ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:"?public"?\.)?${ident}`, "i");

const CREATE_TABLE_RE = new RegExp(
  String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?${ident}`, "i");

/** A statement as the checker compares it: one space, no case, no trailing semicolon. */
const normalized = (stmt: string): string => stmt.replace(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();

/**
 * THE TWO ADMITTED INDEX BUILDS on a growth table, each a fact the file or the setup command
 * proves: an index on a table the SAME migration creates (it is empty — the build costs
 * nothing), and a statement the setup command builds CONCURRENTLY ahead of the migrator
 * (`PREMIGRATION_PREBUILD_SPECS`), spelled as that spec minus `concurrently`, so it no-ops
 * wherever the table holds rows. Any other spelling of a prebuilt name is refused.
 */
// Through the SAME noise strip the statement passes: mail 0139's spec carries string literals
// (`'epoch'`, `'48 hours'`), which the strip blanks in the journal statement. The literals
// themselves are held byte-equal to the journal by `arrival-order-index.test.ts`.
const PREBUILT = new Set(PREMIGRATION_PREBUILD_SPECS.map((spec) =>
  normalized(stripSqlNoise(new PgDialect().sqlToQuery(spec.ddl).sql.replace(/\bconcurrently\s+/i, "")))));

/**
 * A column TYPE change on a growth table rewrites the whole table and every index on it under
 * ACCESS EXCLUSIVE — the index-build cost, paid for all of them at once. Refused unless the file
 * is named here with its reason; the README's lock-cost section states the rule and the one
 * admitted migration, whose rewrite was measured before it shipped.
 */
const MEASURED_TYPE_REWRITES: ReadonlyMap<string, string> = new Map([
  ["0131_uid_bigint.sql", "a UID above 2^31 is refused 22003 by an integer column; measured on a lane db"],
]);
const ALTER_TYPE_RE = /ALTER\s+COLUMN\s+"?[A-Za-z0-9_]+"?\s+(?:SET\s+DATA\s+)?TYPE\b/i;

/**
 * A LONG STATEMENT HOLDS EVERY EARLIER MIGRATION'S LOCKS: the pending set replays in one transaction, so
 * One migration's long gin_clean_pending_list kept two earlier migrations' table locks and two production backends waited
 * long seconds. A pending-list flush, or an UPDATE over a growth table (a backfill), must say
 * so in its header — a `-- LOCK-WAIT: <its own pass, or why the wait is accepted>` line in the leading
 * comment block. 0152 shipped before the rule and its bytes are pinned, so it is admitted by name.
 */
const LONG_CALL_RE = /\bgin_clean_pending_list\s*\(/i;
const UPDATE_RE = new RegExp(String.raw`^UPDATE\s+(?:ONLY\s+)?(?:"?public"?\.)?${ident}`, "i");
const LONG_STATEMENT_ADMITTED: ReadonlyMap<string, string> = new Map([
  ["0152_search_gin_pending_bounded.sql", "released in 0.25.21 before the rule; pinned bytes, so named here"],
]);
const lockWaitMarked = (sqlText: string): boolean => {
  for (const line of sqlText.split("\n")) {
    if (line.trim() === "") continue;
    if (!line.startsWith("--")) return false;
    if (/^--\s*LOCK-WAIT:\s*\S/.test(line)) return true;
  }
  return false;
};

/** The deciding function: the lock-cost violations one statement-stripped migration carries. */
function lockCostViolations(file: string, sqlText: string, growth: ReadonlySet<string>): Violation[] {
  const out: Violation[] = [];
  const createdHere = new Set<string>();
  const longAdmitted = LONG_STATEMENT_ADMITTED.has(file) || lockWaitMarked(sqlText);
  for (const raw of stripSqlNoise(sqlText).split(";")) {
    const stmt = raw.replace(/\s+/g, " ").trim();
    if (stmt === "") continue;
    const up = UPDATE_RE.exec(stmt);
    if (!longAdmitted && LONG_CALL_RE.test(stmt)) out.push({ file, table: "(gin_clean_pending_list)", clazz: "long-statement" });
    if (!longAdmitted && up && growth.has(up[1]!)) out.push({ file, table: up[1]!, clazz: "long-statement" });
    const ct = CREATE_TABLE_RE.exec(stmt);
    if (ct) { createdHere.add(ct[1]!); continue; }
    const ci = CREATE_INDEX_RE.exec(stmt);
    if (ci) {
      const [, , concurrently, table] = ci;
      if (!concurrently && (createdHere.has(table!) || PREBUILT.has(normalized(stmt)))) continue;
      // CONCURRENTLY cannot run inside the migrator's one transaction (25001) on ANY table;
      // a plain build write-blocks a growth table for the whole build. Both belong in a
      // ConcurrentIndexSpec (packages/db/src/hot-path-indexes.ts), not in a journal.
      if (concurrently) out.push({ file, table: table!, clazz: "concurrently-in-journal" });
      else if (growth.has(table!)) out.push({ file, table: table!, clazz: "index-build" });
      continue;
    }
    const at = ALTER_TABLE_RE.exec(stmt);
    if (!at) continue;
    const table = at[1]!;
    if (!growth.has(table)) continue;
    if (ALTER_TYPE_RE.test(stmt) && !MEASURED_TYPE_REWRITES.has(file)) {
      out.push({ file, table, clazz: "column-type-rewrite" });
    }
    const clauseStarts: number[] = [];
    const addRe = /ADD\s+CONSTRAINT\s+"?[A-Za-z0-9_]+"?/gi;
    for (let m = addRe.exec(stmt); m !== null; m = addRe.exec(stmt)) clauseStarts.push(m.index);
    for (let k = 0; k < clauseStarts.length; k++) {
      const clause = stmt.slice(clauseStarts[k], clauseStarts[k + 1] ?? stmt.length);
      const notValid = /NOT\s+VALID/i.test(clause);
      if (/FOREIGN\s+KEY/i.test(clause)) {
        if (!notValid) out.push({ file, table, clazz: "validating-fk" });
      } else if (/\bCHECK\s*\(/i.test(clause)) {
        if (!notValid) out.push({ file, table, clazz: "validating-check" });
      } else if (/\bUNIQUE\b/i.test(clause) || /PRIMARY\s+KEY/i.test(clause)) {
        out.push({ file, table, clazz: "constraint-index-build" });
      }
    }
  }
  return out;
}

interface JournalReading {
  entries: { when: number; tag: string }[];
  scanned: number;
  checked: number;
  violations: Violation[];
}

/** Reads a journal dir end to end; every entry's file is read, entries past `watermark` are checked. */
function readJournalViolations(dir: string, watermark: number, growth: ReadonlySet<string>): JournalReading {
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as {
    entries: { when: number; tag: string }[];
  };
  let scanned = 0;
  let checked = 0;
  const violations: Violation[] = [];
  for (const e of journal.entries) {
    const text = readFileSync(join(dir, `${e.tag}.sql`), "utf8");
    if (text.trim().length === 0) throw new Error(`${e.tag}.sql is empty — the scan read nothing`);
    scanned++;
    if (e.when <= watermark) continue;
    checked++;
    violations.push(...lockCostViolations(`${e.tag}.sql`, text, growth));
  }
  return { entries: journal.entries, scanned, checked, violations };
}

const describeViolations = (v: Violation[]) =>
  v.map((x) => `${x.file}: ${x.clazz} on ${x.table}`).join("\n");

describe("migration lock cost — pg journals only", () => {
  it("every declared growth table exists in the pg schema, so a rename cannot silently unguard it", () => {
    const names = new Set<string>();
    for (const mod of [mailSchema, cloudSchema]) {
      for (const value of Object.values(mod)) {
        if (is(value, PgTable)) names.add(getTableName(value));
      }
    }
    for (const t of GROWTH) expect(names.has(t), `growth table "${t}" is not a schema table`).toBe(true);
  });

  it("each watermark is a shipped entry of its journal, not an invented number", () => {
    for (const [dir, mark] of [[MAIL_DIR, WATERMARKS.mail], [CLOUD_DIR, WATERMARKS.cloud]] as const) {
      const { entries } = readJournalViolations(dir, Number.MAX_SAFE_INTEGER, GROWTH);
      const hit = entries.find((e) => e.when === mark.when);
      expect(hit?.tag, `no entry at when=${mark.when} in ${dir}`).toBe(mark.tag);
    }
  });

  it("mail journal: every entry past the watermark is lock-cheap on growth tables", () => {
    const r = readJournalViolations(MAIL_DIR, WATERMARKS.mail.when, GROWTH);
    expect(r.scanned).toBe(r.entries.length);
    expect(r.entries.length).toBeGreaterThanOrEqual(120);
    expect(r.violations, describeViolations(r.violations)).toEqual([]);
  });

  it("cloud journal: every entry past the watermark is lock-cheap on growth tables", () => {
    const r = readJournalViolations(CLOUD_DIR, WATERMARKS.cloud.when, GROWTH);
    expect(r.scanned).toBe(r.entries.length);
    expect(r.entries.length).toBeGreaterThanOrEqual(25);
    expect(r.violations, describeViolations(r.violations)).toEqual([]);
  });

  /**
   * POSITIVE CONTROL for the journal zero, through the SAME pipeline (journal json → file read →
   * checker): a synthetic journal whose one entry sits past the watermark and carries the exact
   * 0118 shape. A zero over the real journals is a reading only beside this arm being red.
   */
  describe("the refused shapes, driven through the same pipeline", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lock-cost-"));
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    it("a validating FK on messages past the watermark refuses", () => {
      mkdirSync(join(tmp, "meta"), { recursive: true });
      writeFileSync(join(tmp, "meta", "_journal.json"), JSON.stringify({
        entries: [{ when: WATERMARKS.mail.when + 1, tag: "9999_synthetic" }],
      }));
      writeFileSync(join(tmp, "9999_synthetic.sql"),
        `ALTER TABLE "messages" ADD CONSTRAINT "m_fk" FOREIGN KEY ("thread_id","account_id")` +
        ` REFERENCES "threads"("id","account_id");\n`);
      const r = readJournalViolations(tmp, WATERMARKS.mail.when, GROWTH);
      expect(r.checked).toBe(1);
      expect(r.violations.map((v) => v.clazz)).toEqual(["validating-fk"]);
      expect(r.violations[0]!.table).toBe("messages");
    });
  });

  describe("the checker's classes, statement by statement", () => {
    const check = (sql: string) => lockCostViolations("t.sql", sql, GROWTH).map((v) => v.clazz);

    it("refuses a validating CHECK on a growth table", () => {
      expect(check(`ALTER TABLE "sessions" ADD CONSTRAINT "s_ck" CHECK (char_length("id") < 100);`))
        .toEqual(["validating-check"]);
    });
    it("refuses a unique index, a plain index, and a UNIQUE constraint on a growth table", () => {
      expect(check(`CREATE UNIQUE INDEX "m_uq" ON "messages" ("account_id","uid");`))
        .toEqual(["index-build"]);
      expect(check(`CREATE INDEX IF NOT EXISTS "f_idx" ON "folder_state" ("desired_folder");`))
        .toEqual(["index-build"]);
      expect(check(`ALTER TABLE "messages" ADD CONSTRAINT "m_uq" UNIQUE ("id","account_id");`))
        .toEqual(["constraint-index-build"]);
    });
    it("refuses CONCURRENTLY inside the journal on ANY table — 25001 in the migrator's transaction", () => {
      expect(check(`CREATE UNIQUE INDEX CONCURRENTLY "a_uq" ON "away_responders" ("id");`))
        .toEqual(["concurrently-in-journal"]);
    });
    it("admits the NOT VALID twin, the VALIDATE half, and bounded-table constraints (the ordinary case)", () => {
      expect(check(
        `ALTER TABLE "messages" ADD CONSTRAINT "m_fk" FOREIGN KEY ("thread_id","account_id")` +
        ` REFERENCES "threads"("id","account_id") NOT VALID;`)).toEqual([]);
      expect(check(`ALTER TABLE "messages" VALIDATE CONSTRAINT "m_fk";`)).toEqual([]);
      expect(check(`ALTER TABLE "accounts" ADD CONSTRAINT "a_ck" CHECK ("dormancy_days" >= 1);`))
        .toEqual([]);
      expect(check(`CREATE UNIQUE INDEX "acc_uq" ON "accounts" ("email");`)).toEqual([]);
    });
    it("admits an index on a table the same migration creates, and refuses it on one it does not", () => {
      expect(check(`CREATE TABLE IF NOT EXISTS "message_search" ("message_id" uuid);\n` +
        `CREATE INDEX IF NOT EXISTS "s_idx" ON "message_search" USING gin ("tsv");`)).toEqual([]);
      expect(check(`CREATE INDEX IF NOT EXISTS "s_idx" ON "message_search" USING gin ("tsv");`))
        .toEqual(["index-build"]);
      // Created AFTER the index is not created before it: the order in the file is the order run.
      expect(check(`CREATE INDEX "s_idx" ON "message_search" ("x");\nCREATE TABLE "message_search" ("x" int);`))
        .toEqual(["index-build"]);
    });
    it("admits a prebuilt statement only in its spec's spelling minus CONCURRENTLY", () => {
      const history = `create index if not exists "messages_account_msg_order_idx"
      on public.messages using btree ("account_id","date" desc nulls last,"id" desc)
      where "deleted_at" is null;`;
      expect(check(history)).toEqual([]);
      // The same name, another definition: a different index, refused.
      expect(check(`create index if not exists "messages_account_msg_order_idx" on public.messages ("account_id");`))
        .toEqual(["index-build"]);
      // 0125's History index, the withheld-provenance index, 0139's and 0171's arrival indexes, 0154's recipient
      // keys, 0157's sender-date index, 0159's outstanding filings and 0160's mailboxes by account.
      expect(PREBUILT.size).toBe(8);
    });
    it("a FOREIGN KEY spelled in a comment or a string is noise, not DDL", () => {
      expect(check(
        `-- ADD CONSTRAINT x FOREIGN KEY would scan "messages"\n` +
        `/* CREATE UNIQUE INDEX "y" ON "messages" ("id") */\n` +
        `INSERT INTO "messages" ("subject") VALUES ('FOREIGN KEY; CHECK (1)');`)).toEqual([]);
    });
    it("refuses a column TYPE change on a growth table, and admits the measured one by file", () => {
      expect(check(`ALTER TABLE "messages" ALTER COLUMN "size" TYPE bigint;`)).toEqual(["column-type-rewrite"]);
      expect(check(`ALTER TABLE "sessions" ALTER COLUMN "scope" SET DATA TYPE text;`))
        .toEqual(["column-type-rewrite"]);
      // A bounded table rewrites in milliseconds: no class.
      expect(check(`ALTER TABLE "accounts" ALTER COLUMN "dormancy_days" TYPE bigint;`)).toEqual([]);
      // The admission is the FILE, never the statement: the same text elsewhere is refused.
      const stmt = `ALTER TABLE "message_instances" ALTER COLUMN "uid" TYPE bigint;`;
      expect(lockCostViolations("0131_uid_bigint.sql", stmt, GROWTH)).toEqual([]);
      expect(lockCostViolations("0130_other.sql", stmt, GROWTH).map((v) => v.clazz))
        .toEqual(["column-type-rewrite"]);
      expect([...MEASURED_TYPE_REWRITES.keys()].every((f) =>
        readFileSync(join(MAIL_DIR, f), "utf8").length > 0), "an admitted file that does not exist").toBe(true);
    });
    it("refuses an unmarked pending-list flush and a growth-table UPDATE; a LOCK-WAIT header admits both", () => {
      const flush = `SELECT gin_clean_pending_list(c.oid) FROM pg_class c WHERE c.relname = 'x';`;
      const backfill = `UPDATE "messages" SET "list_address" = false WHERE "list_address" IS NULL;`;
      expect(check(flush)).toEqual(["long-statement"]);
      expect(check(backfill)).toEqual(["long-statement"]);
      expect(check(`-- 0999_x — a backfill.\n-- LOCK-WAIT: its own pass, run by the setup command\n${backfill}`)).toEqual([]);
      // The mark is the HEADER's: the same words after the first statement are no mark.
      expect(check(`${backfill}\n-- LOCK-WAIT: too late`)).toEqual(["long-statement"]);
      // A bounded table updates in milliseconds, and a quoted call is noise.
      expect(check(`UPDATE "rules" SET "decided_by" = 'person';`)).toEqual([]);
      expect(check(`INSERT INTO "audit_log" ("note") VALUES ('gin_clean_pending_list(1)');`)).toEqual([]);
    });
    it("0152 as shipped is admitted by name only: its own bytes in another file refuse", () => {
      const text = readFileSync(join(MAIL_DIR, "0152_search_gin_pending_bounded.sql"), "utf8");
      expect(lockCostViolations("0152_search_gin_pending_bounded.sql", text, GROWTH)).toEqual([]);
      expect(lockCostViolations("0153_copy.sql", text, GROWTH).map((v) => v.clazz)).toEqual(["long-statement"]);
    });
    it("two ADD CONSTRAINT clauses in one ALTER are judged apart", () => {
      expect(check(
        `ALTER TABLE "messages"` +
        ` ADD CONSTRAINT "a" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") NOT VALID,` +
        ` ADD CONSTRAINT "b" CHECK ("size" >= 0);`)).toEqual(["validating-check"]);
    });
  });
});
