import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
// The journal's own directory, from the package that owns it — never a path composed here.
import { SQLITE_JOURNAL, SQLITE_MIGRATIONS_DIR } from "@ohmail/db-mail";

// Reached through `createRequire` rather than a static import: the bundler this suite runs under
// does not yet know this module is a builtin, and resolves the bare name to a package that does
// not exist. The runtime has it either way.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string, options?: { enableForeignKeyConstraints?: boolean }) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      run(...params: unknown[]): unknown;
      /** Absent on hosts that predate it — every caller here guards with `?.()`. */
      columns?: () => { name?: string; column?: string }[];
      setReadBigInts(on: boolean): void;
    };
  };
};
type DatabaseSync = InstanceType<typeof DatabaseSync>;
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import * as sqliteSchema from "../src/schema-mail-sqlite.js";
import { migrateSqlite, SQLITE_MIGRATIONS_TABLE } from "../src/sqlite-migrate.js";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import { mailboxFolders } from "../src/schema-mail-sqlite.js";
import { ORGANIZER_KINDS } from "../src/organizer-role.js";
import { MAILBOX_DISABLED_REASONS, MAILBOX_SYNC_BLOCK_REASONS } from "../src/mailbox-errors.js";
import { ORGANIZER_INTENTS } from "../src/organizer-role.js";
import { closedSetValue, organizerKindColumn, ClosedSetViolation } from "../src/closed-sets.js";

/**
 * THE JOURNAL PRODUCES THE SCHEMA THE CODE BELIEVES IN — applied, not read.
 *
 * A migration file and a schema declaration are two statements of the same thing, and nothing
 * about writing them makes them agree. Reading one against the other catches a typo; running one
 * and interrogating the result catches the rest, including every statement that parses on the
 * server and not here.
 *
 * So this opens an empty store, replays the journal into it, and asks the STORE what it now
 * holds — then compares that with what the query builder believes. A column the journal forgot,
 * a constraint spelled in a dialect this store does not accept, an index over a column that is
 * not there: each fails here, on this machine, rather than at a first launch on a device.
 *
 * WHAT IT COMPARES, so nobody reads it as more: table and column names and order, index names
 * with their predicates present or absent, and uniqueness. It does NOT compare every default,
 * every CHECK expression or every predicate against the schema module — the parity test does that
 * side. The behavioural cases below are examples, not a sweep: one closed set refusing, one search
 * index following an edit, one 64-bit value surviving a host that cannot bind it.
 */
function open(): { db: DatabaseSync; target: Parameters<typeof migrateSqlite>[0] } {
  // OPENED WITH REFERENCES OFF, deliberately. This host turns them on by itself, so a store opened
  // its way cannot show whether the migrator turns them on — removing the migrator's PRAGMA left
  // every test here green twice over: once because this helper used to set it, and again because
  // the host would have anyway. The device's host does not. Starting from off is the only way this
  // file can answer the question it claims to.
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  return {
    db,
    target: {
      run: async (statement: string) => { db.exec(statement); },
      all: async <T,>(statement: string) => db.prepare(statement).all() as T[],
    },
  };
}

/**
 * The device migrations release 0.30.17 shipped, frozen. A device's ledger records these names, so
 * a rename re-runs the entry on every upgraded store and a deletion strands the stores that ran it.
 * Newer entries follow them and are read from the journal.
 */
const RELEASED_SQLITE: readonly string[] = [
  "0001_baseline", "0093_outbound_send_fingerprints", "0094_request_kinds_moves_profile",
  "0095_outbound_send_resolution", "0096_away_piles", "0097_folder_state_last_error_class", "0098_signature_html",
  "0099_folder_state_trashed_from", "0107_release_held_at", "0108_mailbox_signed_out_at", "0109_gate_release_done_at",
  "0110_resurface_time", "0111_mailbox_erased_at", "0112_idempotency_erased_at", "0113_refresh_consumed_by_attempt",
  "0114_away_rotation_stamp", "0115_first_sync_budget_stop", "0116_unsub_drain_cursor", "0117_junk_rescues",
  "0118_account_isolation", "0119_messages_arrived_at", "0120_held_release_dismissed", "0121_release_refusal",
  "0122_change_log_retention", "0125_message_search", "0126_mailbox_erasure_done", "0127_mailbox_signed_out_meta",
  "0128_rule_person_decided", "0129_profile_import_ask", "0130_mailbox_sync_soft_states", "0132_mailbox_sent_folder",
  "0133_screener_auto_act", "0135_organizer_parked_at", "0136_screener_probe_indexes", "0137_draft_forward_of",
  "0138_auto_filing_undone_at", "0138_device_search_stems", "0139_messages_arrival_order",
  "0141_screener_floor_version", "0144_rule_person_decided_backfill", "0145_press_decided_at",
  "0146_rule_person_decided_followup", "0147_messages_open_read_at", "0148_messages_sender_check",
  "0149_messages_sender_check_by", "0150_list_addresses", "0151_mailboxes_gap_since", "0154_messages_recipient_keys",
  "0155_outbound_sends_rearm", "0156_routing_decisions_sender_reason", "0157_messages_sender_date",
  "0158_mailboxes_gap_strangers", "0159_rules_settled_press_at", "0160_folder_state_outstanding",
  "0161_mailboxes_account_idx", "0162_outbound_sends_offer_state", "0163_folder_state_fresh_intent",
  "0164_messages_server_missing", "0166_account_storage_facts", "0167_rules_refile", "0168_drafts_forward_parts",
  "0169_mailboxes_organized_through", "0170_outbound_sent_copies", "0171_messages_arrival_key",
  "0172_html_words_backfill",
].map((tag) => `${tag}.sql`);

const declared = (Object.values(sqliteSchema) as unknown[])
  .filter((v): v is SQLiteTable => is(v, SQLiteTable))
  .map((t) => getTableConfig(t));

describe("the SQLite journal, applied", () => {
  it("replays into an empty store and records what it applied", async () => {
    const { db, target } = open();
    const applied = await migrateSqlite(target);
    // Every file of the journal's directory, in order: a list written here reddened on each new entry.
    expect(applied).toEqual(readdirSync(SQLITE_MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort());
    expect(applied[0]).toBe("0001_baseline.sql");
    const rows = db.prepare(`SELECT name FROM ${SQLITE_MIGRATIONS_TABLE}`).all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(applied);
  });

  it("upgrades a store from the last release by applying only what came after it", async () => {
    const { target } = open();
    const shipped = SQLITE_JOURNAL.filter((e) => RELEASED_SQLITE.includes(e.name));
    expect(shipped.map((e) => e.name), "a shipped device migration was renamed, removed or moved")
      .toEqual(RELEASED_SQLITE);
    await migrateSqlite(target, shipped);
    expect(await migrateSqlite(target)).toEqual(SQLITE_JOURNAL.slice(RELEASED_SQLITE.length).map((e) => e.name));
  });

  it("applies nothing the second time, which is what makes a relaunch safe", async () => {
    const { target } = open();
    /* Counted from the journal itself. A literal here was pinned at 2 for the consolidated
       step and went stale the day it was split per shared entry — and the property under test
       is "the second run applies NOTHING", which is the assertion below, not this number. */
    const steps = readdirSync(SQLITE_MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    expect(await migrateSqlite(target)).toHaveLength(steps.length);
    expect(await migrateSqlite(target)).toEqual([]);
  });

  it("leaves the store holding every table the code declares, with every column", async () => {
    const { db, target } = open();
    await migrateSqlite(target);
    const present = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
        .map((r) => r.name),
    );
    for (const table of declared) {
      expect(present.has(table.name), `${table.name} is declared and was not created`).toBe(true);
      const columns = (db.prepare(`PRAGMA table_info("${table.name}")`).all() as { name: string }[])
        .map((r) => r.name);
      expect(columns, `${table.name} columns`).toEqual(table.columns.map((c) => c.name));
    }
  });

  it("creates every index the code declares, and keeps the partial ones partial", async () => {
    const { db, target } = open();
    await migrateSqlite(target);
    const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
      .all() as { name: string; sql: string }[];
    const bySql = new Map(rows.map((r) => [r.name, r.sql]));
    for (const table of declared) {
      for (const index of table.indexes) {
        const created = bySql.get(index.config.name);
        expect(created, `${index.config.name} is declared and was not created`).toBeDefined();
        if (index.config.where !== undefined) {
          expect(created, `${index.config.name} lost its predicate`).toMatch(/ WHERE /);
        }
        if (index.config.unique === true) {
          expect(created, `${index.config.name} lost its uniqueness`).toMatch(/CREATE UNIQUE INDEX/);
        }
      }
    }
  });

  it("enforces the IMMUTABLE closed sets, and leaves the widenable ones to the write door", async () => {
    const { db, target } = open();
    await migrateSqlite(target);
    const insert = (role: string) => db.exec(
      "INSERT INTO mailboxes (id, account_id, provider, address, organizer_role) " +
        `VALUES ('m1-${role}', 'a1', 'imap', '${role}@example.test', '${role}')`,
    );
    expect(() => insert("reader")).not.toThrow();
    expect(() => insert("organizer")).not.toThrow();
    expect(() => insert("captain")).toThrow(/CHECK constraint failed/);

    /* AND WHERE THE ENFORCEMENT MOVED. `organized_by_kind` and `disabled_reason` are WIDENABLE —
       the server has widened both (mail 0103) by DROP CONSTRAINT then ADD, which SQLite has no
       statement for. A CHECK here would make the next one-word widening a fifty-column rebuild on
       every device, so this store admits a foreign value and `closed-sets.ts` refuses it before
       the write. Asserted in BOTH directions: the store takes it, the door does not. */
    const holder = (kind: string) => db.exec(
      "INSERT INTO mailboxes (id, account_id, provider, address, organized_by_kind) " +
        `VALUES ('h1-${kind}', 'a1', 'imap', '${kind}@holder.test', '${kind}')`,
    );
    for (const kind of ORGANIZER_KINDS) {
      expect(() => holder(kind), `${kind} must be storable`).not.toThrow();
    }
    expect(() => holder("phone"), "the device store is expected to carry no CHECK here").not.toThrow();
    expect(organizerKindColumn("phone"), "the write door is the refusal").toBe("unknown");

    const reason = (r: string, id: string) => db.exec(
      "INSERT INTO mailboxes (id, account_id, provider, address, status, disabled_reason) " +
        `VALUES ('${id}', 'a1', 'imap', '${id}@reason.test', 'disabled', '${r}')`,
    );
    MAILBOX_DISABLED_REASONS.forEach((r, i) => {
      expect(() => reason(r, `r${i}`), `${r} must be storable`).not.toThrow();
    });
    // WIDENABLE, so the STORE admits it and the WRITE DOOR refuses it — that swap is the change.
    expect(() => reason("organized_elsewhere:phone", "rbad")).not.toThrow();
    expect(() => closedSetValue("mailboxes_disabled_reason_closed", "organized_elsewhere:phone"))
      .toThrow(ClosedSetViolation);

    /* WHY THIS INSTALL IS NOT SERVING A MAILBOX IT KNOWS ABOUT (mail 0029, widened by 0102 and
       0105) — widenable too, so the device store carries no CHECK for it either. Every member is
       storable, a foreign one is storable HERE, and the door is what refuses it. */
    const blocked = (b: string, id: string) => db.exec(
      "INSERT INTO mailboxes (id, account_id, provider, address, status, sync_blocked_reason) " +
        `VALUES ('${id}', 'a1', 'imap', '${id}@blocked.test', 'connected', '${b}')`,
    );
    MAILBOX_SYNC_BLOCK_REASONS.forEach((b, i) => {
      expect(() => blocked(b, `b${i}`), `${b} must be storable`).not.toThrow();
    });
    expect(() => blocked("a_sixth_reason", "bbad")).not.toThrow();
    expect(() => closedSetValue("mailboxes_sync_blocked_reason_closed", "a_sixth_reason"))
      .toThrow(ClosedSetViolation);

    /* THE VERB BEHIND THE TAKEOVER STAMP (mail 0104) KEEPS ITS CHECK, because it is IMMUTABLE by
       the same measurement: one migration adds it and none has widened it. It is a CHECK the lease
       DECIDES on — an out-of-vocabulary value read by a `!== 'join'` test would be the displacing
       verb — so the store refuses it rather than the readers coercing it, and the DEFAULT is the
       yielding one. Derived from `ORGANIZER_INTENTS`. */
    const verb = (v: string, id: string) => db.exec(
      "INSERT INTO mailboxes (id, account_id, provider, address, takeover_intent) " +
        `VALUES ('${id}', 'a1', 'imap', '${id}@verb.test', '${v}')`,
    );
    ORGANIZER_INTENTS.forEach((v, i) => {
      expect(() => verb(v, `v${i}`), `${v} must be storable`).not.toThrow();
    });
    expect(() => verb("seize", "vbad")).toThrow(/CHECK constraint failed/);
    db.exec(
      "INSERT INTO mailboxes (id, account_id, provider, address) " +
        "VALUES ('vdef', 'a1', 'imap', 'vdef@verb.test')",
    );
    const [dflt] = db.prepare("SELECT takeover_intent AS v FROM mailboxes WHERE id = 'vdef'")
      .all() as { v: string }[];
    expect(dflt!.v, "a row nobody pressed on defaults to the verb that DISPLACES").toBe("join");
  });

  it("refuses a store that cannot run this schema, through the migrator rather than beside it", async () => {
    // The capability check used to live in a factory, so removing it left every caller that had
    // its own copy green. It is the migrator's now, and this asks the migrator.
    const { target } = open();
    const pretendOld = {
      ...target,
      all: async <T,>(statement: string) =>
        (statement.includes("sqlite_version")
          ? [{ version: "3.30.0" }]
          : await target.all(statement)) as T[],
    };
    await expect(migrateSqlite(pretendOld)).rejects.toThrow(/3\.43\.0 or newer/);

    const pretendNoSearch = {
      ...target,
      all: async <T,>(statement: string) =>
        (statement.includes("compile_options")
          ? [{ compile_options: "THREADSAFE=1" }]
          : await target.all(statement)) as T[],
    };
    await expect(migrateSqlite(pretendNoSearch)).rejects.toThrow(/no FTS5/);
  });

  it("enforces the schema's references, and the migrator is what turns them on", async () => {
    // With the helper's own PRAGMA removed, this is the migrator's doing or nobody's.
    const { db, target } = open();
    await migrateSqlite(target);
    expect(() => db.exec(
      "INSERT INTO messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address) " +
      "VALUES ('orphan', 'a1', 'no-such-mailbox', 'h', 'd', 's', 'f@example.test')",
    )).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("stores a 64-bit counter exactly, through a host that cannot bind a bigint", async () => {
    // THE BIND IS THE POINT, so this goes through the query builder rather than raw SQL — raw SQL
    // inlines the literal and never reaches the column's conversion at all, which is how the first
    // version of this case passed against a column that still handed the host a bigint.
    //
    // The adapter refuses a bigint parameter the way the device's binding does. This machine's
    // accepts one, so without the refusal there is nothing here to see.
    const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    const target = {
      run: async (statement: string) => { db.exec(statement); },
      all: async <T,>(statement: string) => db.prepare(statement).all() as T[],
    };
    await migrateSqlite(target);

    let sawBigintBind = false;
    const proxy = drizzleSqliteProxy(async (query, params, method) => {
      for (const p of params) {
        if (typeof p === "bigint") { sawBigintBind = true; throw new Error("this host cannot bind a bigint"); }
      }
      if (method === "run") { db.prepare(query).run(...(params as never[])); return { rows: [] }; }
      const st = db.prepare(query);
      const order = st.columns?.().map((c) => c.name ?? c.column ?? "") ?? null;
      const raws = st.all(...(params as never[])) as Record<string, unknown>[];
      return { rows: order === null ? raws.map((r) => Object.values(r)) : raws.map((r) => order.map((n) => r[n])) };
    });

    const beyondDouble = 9007199254740993n;   // 2^53 + 1: the first value a double cannot hold
    db.exec("INSERT INTO mailboxes (id, account_id, provider, address) VALUES ('m','a','imap','x@e.test')");
    await proxy.insert(mailboxFolders).values({
      id: "f", mailboxId: "m", folder: "INBOX", uidvalidity: beyondDouble,
    });
    expect(sawBigintBind, "the column handed the host a bigint").toBe(false);

    // Stored exactly, read straight off the store — this half only proves the write.
    const [row] = db.prepare("SELECT CAST(uidvalidity AS TEXT) AS v FROM mailbox_folders").all() as { v: string }[];
    expect(BigInt(row.v)).toBe(beyondDouble);

    // AND READ BACK THROUGH THE COLUMN, which the line above does not do: a raw select never
    // reaches the conversion, so every claim about the return side was resting on a statement that
    // could not have exercised it.
    //
    // Asking this host for big integers is the shape the conversion's first branch is written for.
    // It is not a convenience: the column has INTEGER affinity, so the decimal string the write
    // side binds is stored as a 64-bit integer, and a host that reports integers as JavaScript
    // numbers cannot hand this value back AT ALL — node's own driver raises "value is too large"
    // rather than rounding. The case below grades the host that rounds instead.
    const exact = drizzleSqliteProxy(async (query, params, method) => {
      const st = db.prepare(query);
      if (method === "run") { st.run(...(params as never[])); return { rows: [] }; }
      st.setReadBigInts(true);
      const order = st.columns?.().map((c) => c.name ?? c.column ?? "") ?? null;
      const raws = st.all(...(params as never[])) as Record<string, unknown>[];
      const rows = order === null
        ? raws.map((r) => Object.values(r))
        : raws.map((r) => order.map((n) => r[n]));
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    });
    const [back] = await exact.select({ v: mailboxFolders.uidvalidity }).from(mailboxFolders);
    expect(typeof back.v).toBe("bigint");
    expect(back.v).toBe(beyondDouble);
  });

  it("refuses a 64-bit column a host hands back as a double, rather than returning a near miss", async () => {
    // THE OTHER HALF OF THE SAME CONVERSION, and the one with teeth. The return side cannot be
    // made exact from inside the column: by the time a double arrives the low bits are already
    // gone. Refusing names the value and the column instead of answering with a number one or two
    // away from the one stored — which for a UIDVALIDITY is a message pointing at the wrong mail.
    //
    // The host is simulated, deliberately and visibly. Node's driver raises rather than rounds, so
    // there is no way to reach this branch on this machine by choosing a value; the thing under
    // test is what the COLUMN does when handed a double, not what any particular driver hands it.
    // The fixture supplies the host's behaviour, never the refusal — remove the refusal and this
    // returns a wrong number instead of throwing.
    const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    const target = {
      run: async (statement: string) => { db.exec(statement); },
      all: async <T,>(statement: string) => db.prepare(statement).all() as T[],
    };
    await migrateSqlite(target);

    const beyondDouble = 9007199254740993n;
    db.exec("INSERT INTO mailboxes (id, account_id, provider, address) VALUES ('m','a','imap','x@e.test')");
    db.exec(`INSERT INTO mailbox_folders (id, mailbox_id, folder, uidvalidity) VALUES ('f','m','INBOX',${beyondDouble})`);

    let handedBack: unknown;
    const rounding = drizzleSqliteProxy(async (query, params, method) => {
      const st = db.prepare(query);
      if (method === "run") { st.run(...(params as never[])); return { rows: [] }; }
      st.setReadBigInts(true);
      const order = st.columns?.().map((c) => c.name ?? c.column ?? "") ?? null;
      const raws = st.all(...(params as never[])) as Record<string, unknown>[];
      const rows = (order === null
        ? raws.map((r) => Object.values(r))
        : raws.map((r) => order.map((n) => r[n])))
        // The rounding host, in one line: every integer becomes a double on the way up.
        .map((cells) => cells.map((c) => (typeof c === "bigint" ? Number(c) : c)));
      handedBack = rows[0]?.[0];
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    });

    await expect(rounding.select({ v: mailboxFolders.uidvalidity }).from(mailboxFolders))
      .rejects.toThrow(/cannot survive a double/);
    // And the value it refused really was the near miss, not something else that happened to throw.
    expect(typeof handedBack).toBe("number");
    expect(Number.isSafeInteger(handedBack as number)).toBe(false);
    expect(BigInt(handedBack as number)).not.toBe(beyondDouble);
  });

  it("indexes mail for search, and keeps the index current as rows change", async () => {
    const { db, target } = open();
    await migrateSqlite(target);
    db.exec("INSERT INTO mailboxes (id, account_id, provider, address) " +
      "VALUES ('m1', 'a1', 'imap', 'x@example.test')");
    db.exec("INSERT INTO messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address) " +
      "VALUES ('msg1', 'a1', 'm1', 'h1', 'd1', 'Quarterly invoice attached', 'billing@example.test')");
    const hit = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'invoice'").all();
    expect(hit).toHaveLength(1);

    db.exec("UPDATE messages SET subject = 'Quarterly summary attached' WHERE id = 'msg1'");
    expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'invoice'").all())
      .toHaveLength(0);
    expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'summary'").all())
      .toHaveLength(1);

    db.exec("DELETE FROM messages WHERE id = 'msg1'");
    expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'summary'").all())
      .toHaveLength(0);
  });
});
