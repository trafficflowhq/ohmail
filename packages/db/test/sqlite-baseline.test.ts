import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
// The journal's own directory, from the package that owns it — never a path composed here.
import { SQLITE_MIGRATIONS_DIR } from "@ohmail/db-mail";

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

const declared = (Object.values(sqliteSchema) as unknown[])
  .filter((v): v is SQLiteTable => is(v, SQLiteTable))
  .map((t) => getTableConfig(t));

describe("the SQLite journal, applied", () => {
  it("replays into an empty store and records what it applied", async () => {
    const { db, target } = open();
    const applied = await migrateSqlite(target);
    expect(applied).toEqual([
      "0001_baseline.sql", "0093_outbound_send_fingerprints.sql",
      "0094_request_kinds_moves_profile.sql", "0095_outbound_send_resolution.sql",
      "0096_away_piles.sql", "0097_folder_state_last_error_class.sql",
      "0098_signature_html.sql", "0099_folder_state_trashed_from.sql",
      // mail 0104 — the press that releases mail held at the screening gate. 0100–0103 are
      // `.noop` on this store (each widens a server CHECK, which is a table rebuild here and has
      // never shipped), so this list skips straight to it. Carried rather than noop'd because the
      // column is on the shared twin: a device whose `rules` lacks it reads through a schema that
      // no longer matches.
      "0107_release_held_at.sql",
      // mail 0108 — the sign-out's durable stamp. Carried for 0107's reason: the column is on the
      // shared twin, so a device whose `mailboxes` lacks it reads through a schema that no longer
      // matches.
      "0108_mailbox_signed_out_at.sql",
      // mail 0109 — the one-time gate release's per-account marker. Carried for 0107's reason:
      // the column is on the shared twin, so a device whose `account_settings` lacks it reads
      // through a schema that no longer matches.
      "0109_gate_release_done_at.sql",
      // mail 0110 — the resurface time. Carried for 0107's reason: the column is on the shared
      // twin, so a device whose `account_settings` lacks it reads through a schema that no
      // longer matches.
      "0110_resurface_time.sql",
      // mail 0111 — the MAILBOX erasure fence's stamp. Carried for 0107's reason: the column is
      // on the shared twin, so a device whose `mailboxes` lacks it reads through a schema that no
      // longer matches.
      "0111_mailbox_erased_at.sql",
      // mail 0112 — when an erasure replaced an idempotency row's stored response. Carried for
      // 0107's reason: the column is on the shared twin, so a device whose `idempotency_keys`
      // lacks it reads through a schema that no longer matches.
      "0112_idempotency_erased_at.sql",
      // mail 0113 — which attempt consumed a refresh token. Carried for 0107's reason: the column
      // is on the shared twin, so a device whose `refresh_tokens` lacks it reads through a schema
      // that no longer matches and fails at its first rotation.
      "0113_refresh_consumed_by_attempt.sql",
      // mail 0114 — the away responder's rotation stamp. Carried for 0107's reason: the column is
      // on the shared twin and the pass orders by it on this store too, so a device whose
      // `away_responders` lacks it fails at the probe.
      "0114_away_rotation_stamp.sql",
      // mail 0115 — where a budgeted first sync stopped. Carried for 0107's reason and one of its
      // own: this store runs the same sync pass through the same cursor, so a device whose
      // `mailbox_folders` lacks the pair cannot resume either and begins again at INBOX.
      "0115_first_sync_budget_stop.sql",
      // mail 0116 — the unsubscribe drain's per-message mark, where its window walk stopped, and
      // the index over that window. Carried rather than noop'd: the standalone phone runs the
      // same pass over this store, so a device without them re-reads a list it has already left
      // and restarts its walk at the head at every tick.
      "0116_unsub_drain_cursor.sql",
      // mail 0117 — the junk rescue's desired state. A REAL twin: the standalone phone serves the
      // screener routes through its own local door, so the press records a row here.
      "0117_junk_rescues.sql",
      // mail 0118 — the unique indexes the server's composite account keys reference. The keys
      // themselves are not carried: adding one here is a table rebuild, and this store holds
      // exactly one account. The indexes are, so the two schemas stay one schema.
      "0118_account_isolation.sql",
      // mail 0119 — the honest arrival (`messages.arrived_at`), the sort clamp's truth.
      "0119_messages_arrived_at.sql",
      // mail 0120 — the dismissed held-release offer, the pg column's twin on account_settings.
      "0120_held_release_dismissed.sql",
      // mail 0121 — the sibling-lapse refusal, the pg column's twin on mailboxes.
      "0121_release_refusal.sql",
      // mail 0122 — the retention floor; the pg prune index is not mirrored on a device.
      "0122_change_log_retention.sql",
      // mail 0125 — the search document's twin (no vectors: FTS5 is this store's word index).
      "0125_message_search.sql",
      // mail 0126 — when a per-mailbox erasure finished, the pg column's twin on mailboxes.
      "0126_mailbox_erasure_done.sql",
      // mail 0127 — where a signed-out mailbox lives, the pg column's twin on mailboxes.
      "0127_mailbox_signed_out_meta.sql",
      // mail 0128 — who made a rule's decision, the pg column's twin on rules.
      "0128_rule_person_decided.sql",
      // mail 0129 — a press of Import settings the organizer finishes, the pg columns' twins.
      "0129_profile_import_ask.sql",
      // mail 0130 — when a cycle last read a never-completed mailbox, the pg column's twin.
      "0130_mailbox_sync_soft_states.sql",
      // mail 0132 — the mailbox's own Sent folder, the pg column's twin on mailboxes.
      "0132_mailbox_sent_folder.sql",
      // mail 0133 — the act on suggestions' consent and its refusal, the pg columns' twins.
      "0133_screener_auto_act.sql",
      // mail 0135 — when the wall released a mailbox, the pg column's twin on mailboxes.
      "0135_organizer_parked_at.sql",
      // mail 0136 — the Screener probe indexes, carried as the pg entry builds them.
      "0136_screener_probe_indexes.sql",
      // The message a draft forwards, the pg column's twin on drafts.
      "0137_draft_forward_of.sql",
      // The Screener's automatic filing, put back: the pg column's twin on folder_state.
      "0138_auto_filing_undone_at.sql",
      // The mail word index stemmed as the server's is (device-only: the server already stems).
      "0138_device_search_stems.sql",
      // The arrival order index, the pg entry's twin on this store's milliseconds.
      "0139_messages_arrival_order.sql",
      // The Screener floor's version mark, the pg column's twin on folder_state (0140 is a noop here).
      "0141_screener_floor_version.sql",
      // The person's decisions before their stamp, and the rules key index, the pg entry's twin
      // (0142 and 0143 are noops here).
      "0144_rule_person_decided_backfill.sql",
      // The stale-press stamp on folder_state, flag_state and message_states, the pg entry's twin.
      "0145_press_decided_at.sql",
      // The stamps 0144 could not give, the pg entry's two arms.
      "0146_rule_person_decided_followup.sql",
      // The open read, the pg column's twin on `messages`.
      "0147_messages_open_read_at.sql",
      // The identity fact and who made a contact, the pg columns' twins, with the backfill's index.
      "0148_messages_sender_check.sql",
      // Which writer gave the fact, the pg column's twin on `messages`.
      "0149_messages_sender_check_by.sql",
      // The list addresses and the backfill's stamp, the pg twins.
      "0150_list_addresses.sql",
      // The gap window and its offer, the pg columns' twins.
      "0151_mailboxes_gap_since.sql",
      // The recipients side table and its triggers, the pg expression index's twin.
      "0154_messages_recipient_keys.sql",
      // The send re-arm's two columns, the pg columns' twins.
      "0155_outbound_sends_rearm.sql",
      // The fact that capped a stored suggestion, the pg column's twin.
      "0156_routing_decisions_sender_reason.sql",
      // The Screener cutline probe's index, the pg index's twin.
      "0157_messages_sender_date.sql",
      // The gap offer's stranger count, the pg column's twin.
      "0158_mailboxes_gap_strangers.sql",
      // The reader's press ordering on rules, the pg column's twin.
      "0159_rules_settled_press_at.sql",
      // The poll's outstanding filings: the column, its two triggers, the index and the backfill.
      "0160_folder_state_outstanding.sql",
      // The list read's index, the pg index's twin.
      "0161_mailboxes_account_idx.sql",
      // The send's offer state, the pg column's twin.
      "0162_outbound_sends_offer_state.sql",
      // A new filing's schedule reset, the pg trigger's twin.
      "0163_folder_state_fresh_intent.sql",
      // A letter the server lost, kept: the pg column's twin.
      "0164_messages_server_missing.sql",
      // The storage counter's facts, the pg columns' twins.
      "0166_account_storage_facts.sql",
      // A Rules-page Change's re-filing, the pg columns' twins.
      "0167_rules_refile.sql",
    ]);
    const rows = db.prepare(`SELECT name FROM ${SQLITE_MIGRATIONS_TABLE}`).all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual([
      "0001_baseline.sql", "0093_outbound_send_fingerprints.sql",
      "0094_request_kinds_moves_profile.sql", "0095_outbound_send_resolution.sql",
      "0096_away_piles.sql", "0097_folder_state_last_error_class.sql",
      "0098_signature_html.sql", "0099_folder_state_trashed_from.sql",
      // mail 0104 — the press that releases mail held at the screening gate. 0100–0103 are
      // `.noop` on this store (each widens a server CHECK, which is a table rebuild here and has
      // never shipped), so this list skips straight to it. Carried rather than noop'd because the
      // column is on the shared twin: a device whose `rules` lacks it reads through a schema that
      // no longer matches.
      "0107_release_held_at.sql",
      // mail 0108 — the sign-out's durable stamp. Carried for 0107's reason: the column is on the
      // shared twin, so a device whose `mailboxes` lacks it reads through a schema that no longer
      // matches.
      "0108_mailbox_signed_out_at.sql",
      // mail 0109 — the one-time gate release's per-account marker. Carried for 0107's reason:
      // the column is on the shared twin, so a device whose `account_settings` lacks it reads
      // through a schema that no longer matches.
      "0109_gate_release_done_at.sql",
      // mail 0110 — the resurface time. Carried for 0107's reason: the column is on the shared
      // twin, so a device whose `account_settings` lacks it reads through a schema that no
      // longer matches.
      "0110_resurface_time.sql",
      // mail 0111 — the MAILBOX erasure fence's stamp. Carried for 0107's reason: the column is
      // on the shared twin, so a device whose `mailboxes` lacks it reads through a schema that no
      // longer matches.
      "0111_mailbox_erased_at.sql",
      // mail 0112 — when an erasure replaced an idempotency row's stored response. Carried for
      // 0107's reason: the column is on the shared twin, so a device whose `idempotency_keys`
      // lacks it reads through a schema that no longer matches.
      "0112_idempotency_erased_at.sql",
      // mail 0113 — which attempt consumed a refresh token. Carried for 0107's reason: the column
      // is on the shared twin, so a device whose `refresh_tokens` lacks it reads through a schema
      // that no longer matches and fails at its first rotation.
      "0113_refresh_consumed_by_attempt.sql",
      // mail 0114 — the away responder's rotation stamp. Carried for 0107's reason: the column is
      // on the shared twin and the pass orders by it on this store too, so a device whose
      // `away_responders` lacks it fails at the probe.
      "0114_away_rotation_stamp.sql",
      // mail 0115 — where a budgeted first sync stopped. Carried for 0107's reason and one of its
      // own: this store runs the same sync pass through the same cursor, so a device whose
      // `mailbox_folders` lacks the pair cannot resume either and begins again at INBOX.
      "0115_first_sync_budget_stop.sql",
      // mail 0116 — the unsubscribe drain's per-message mark, where its window walk stopped, and
      // the index over that window. Carried rather than noop'd: the standalone phone runs the
      // same pass over this store, so a device without them re-reads a list it has already left
      // and restarts its walk at the head at every tick.
      "0116_unsub_drain_cursor.sql",
      // mail 0117 — the junk rescue's desired state. A REAL twin: the standalone phone serves the
      // screener routes through its own local door, so the press records a row here.
      "0117_junk_rescues.sql",
      // mail 0118 — the unique indexes the server's composite account keys reference. The keys
      // themselves are not carried: adding one here is a table rebuild, and this store holds
      // exactly one account. The indexes are, so the two schemas stay one schema.
      "0118_account_isolation.sql",
      // mail 0119 — the honest arrival (`messages.arrived_at`), the sort clamp's truth.
      "0119_messages_arrived_at.sql",
      // mail 0120 — the dismissed held-release offer, the pg column's twin on account_settings.
      "0120_held_release_dismissed.sql",
      // mail 0121 — the sibling-lapse refusal, the pg column's twin on mailboxes.
      "0121_release_refusal.sql",
      // mail 0122 — the retention floor; the pg prune index is not mirrored on a device.
      "0122_change_log_retention.sql",
      // mail 0125 — the search document's twin.
      "0125_message_search.sql",
      // mail 0126 — when a per-mailbox erasure finished, the pg column's twin on mailboxes.
      "0126_mailbox_erasure_done.sql",
      // mail 0127 — where a signed-out mailbox lives, the pg column's twin on mailboxes.
      "0127_mailbox_signed_out_meta.sql",
      // mail 0128 — who made a rule's decision, the pg column's twin on rules.
      "0128_rule_person_decided.sql",
      // mail 0129 — a press of Import settings the organizer finishes, the pg columns' twins.
      "0129_profile_import_ask.sql",
      // mail 0130 — when a cycle last read a never-completed mailbox, the pg column's twin.
      "0130_mailbox_sync_soft_states.sql",
      // mail 0132 — the mailbox's own Sent folder, the pg column's twin on mailboxes.
      "0132_mailbox_sent_folder.sql",
      // mail 0133 — the act on suggestions' consent and its refusal, the pg columns' twins.
      "0133_screener_auto_act.sql",
      // mail 0135 — when the wall released a mailbox, the pg column's twin on mailboxes.
      "0135_organizer_parked_at.sql",
      // mail 0136 — the Screener probe indexes, carried as the pg entry builds them.
      "0136_screener_probe_indexes.sql",
      // The message a draft forwards, the pg column's twin on drafts.
      "0137_draft_forward_of.sql",
      // The Screener's automatic filing, put back: the pg column's twin on folder_state.
      "0138_auto_filing_undone_at.sql",
      // The mail word index stemmed as the server's is (device-only: the server already stems).
      "0138_device_search_stems.sql",
      // The arrival order index, the pg entry's twin on this store's milliseconds.
      "0139_messages_arrival_order.sql",
      // The Screener floor's version mark, the pg column's twin on folder_state (0140 is a noop here).
      "0141_screener_floor_version.sql",
      // The person's decisions before their stamp, and the rules key index, the pg entry's twin
      // (0142 and 0143 are noops here).
      "0144_rule_person_decided_backfill.sql",
      // The stale-press stamp on folder_state, flag_state and message_states, the pg entry's twin.
      "0145_press_decided_at.sql",
      // The stamps 0144 could not give, the pg entry's two arms.
      "0146_rule_person_decided_followup.sql",
      // The open read, the pg column's twin on `messages`.
      "0147_messages_open_read_at.sql",
      // The identity fact and who made a contact, the pg columns' twins, with the backfill's index.
      "0148_messages_sender_check.sql",
      // Which writer gave the fact, the pg column's twin on `messages`.
      "0149_messages_sender_check_by.sql",
      // The list addresses and the backfill's stamp, the pg twins.
      "0150_list_addresses.sql",
      // The gap window and its offer, the pg columns' twins.
      "0151_mailboxes_gap_since.sql",
      // The recipients side table and its triggers, the pg expression index's twin.
      "0154_messages_recipient_keys.sql",
      // The send re-arm's two columns, the pg columns' twins.
      "0155_outbound_sends_rearm.sql",
      // The fact that capped a stored suggestion, the pg column's twin.
      "0156_routing_decisions_sender_reason.sql",
      // The Screener cutline probe's index, the pg index's twin.
      "0157_messages_sender_date.sql",
      // The gap offer's stranger count, the pg column's twin.
      "0158_mailboxes_gap_strangers.sql",
      // The reader's press ordering on rules, the pg column's twin.
      "0159_rules_settled_press_at.sql",
      // The poll's outstanding filings: the column, its two triggers, the index and the backfill.
      "0160_folder_state_outstanding.sql",
      // The list read's index, the pg index's twin.
      "0161_mailboxes_account_idx.sql",
      // The send's offer state, the pg column's twin.
      "0162_outbound_sends_offer_state.sql",
      // A new filing's schedule reset, the pg trigger's twin.
      "0163_folder_state_fresh_intent.sql",
      // A letter the server lost, kept: the pg column's twin.
      "0164_messages_server_missing.sql",
      // The storage counter's facts, the pg columns' twins.
      "0166_account_storage_facts.sql",
      // A Rules-page Change's re-filing, the pg columns' twins.
      "0167_rules_refile.sql",
    ]);
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
