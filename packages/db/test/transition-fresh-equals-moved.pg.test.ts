/* @postpush: alone — it makes two databases of its own, one from empty and one along the 1.0 road,
 * and compares their catalogs; nothing it does reaches the lane database. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "../src/migrate.js";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, realPgAvailable, throwawayDb,
} from "../src/testing.js";
import { MAP_2_0, sealedOpener, tablesOf, type TransitionEvent } from "../src/transition/index.js";
import { makeStoreAtOldHeads } from "./_store-at-old-heads.js";
import { fingerprintOf, plant1011, refusalsOf, testRing, type Planted } from "./_plant-1-0-11.js";

/**
 * A STORE MADE FROM EMPTY AT 2.0 AND A 1.0.11 STORE MOVED BY THE TRANSITION ARE THE SAME STORE.
 * There is one road: a new store walks the old journals and then 2.0's entries by the ordinary
 * migrator, and never runs the transition. So an entry edited for one of the two (a guard that
 * holds only on an empty store, a statement the transition's own path skips) would give two
 * shapes of 2.0, and nothing else would notice. Compared here line for line: every column with
 * its position, every constraint with its definition and whether it is validated, every index,
 * trigger, function and statistics object. The server the suite runs on decides the version; the
 * nightly runs this file on the test stack's major and on the hosted database's.
 */
const PG_UP = await realPgAvailable();
const fresh = throwawayDb("transition_fresh");
const moved = throwawayDb("transition_moved");
const ring = testRing();
const quiet = { max: 2, onnotice: () => { /* quiet */ } };

/**
 * THE CONSTRAINTS OF 1.0.11 THAT 2.0 REPLACES, each by the one that stands in its place. A key
 * onto a parent's id becomes the key onto its (id, account_id), with the actions it had. A unique
 * on the user becomes one on (account, user), which that key holds to one row a user. A list of
 * members that grows becomes a shape, and its members are the write door's (`closed-sets.ts`).
 * Every constraint of 1.0.11 that is not named here must stand as it stood. Named one by one and
 * not derived from the entries: a derived list forgives whatever an entry drops and adds again.
 */
const REPLACED: Record<string, string> = {
  // mail 0201
  message_bodies_message_id_messages_id_fk: "message_bodies_message_id_account_fk",
  folder_state_message_id_messages_id_fk: "folder_state_message_id_account_fk",
  flag_state_message_id_messages_id_fk: "flag_state_message_id_account_fk",
  mailbox_credentials_mailbox_id_mailboxes_id_fk: "mailbox_credentials_mailbox_id_account_fk",
  mailbox_folders_mailbox_id_mailboxes_id_fk: "mailbox_folders_mailbox_id_account_fk",
  pairing_tokens_created_by_user_id_users_id_fk: "pairing_tokens_created_by_user_id_account_fk",
  junk_rescues_mailbox_id_fkey: "junk_rescues_mailbox_id_account_fk",
  unsubscribe_examined_message_id_messages_id_fk: "unsubscribe_examined_message_id_account_fk",
  unsubscribe_examined_record_id_unsubscribe_records_id_fk: "unsubscribe_examined_record_id_account_fk",
  // mail 0202
  mailboxes_disabled_reason_closed: "mailboxes_disabled_reason_shape",
  mailboxes_sync_blocked_reason_closed: "mailboxes_sync_blocked_reason_shape",
  mailboxes_organized_by_kind_closed: "mailboxes_organized_by_kind_shape",
  // cloud 0100
  credentials_user_id_users_id_fk: "credentials_user_id_account_fk",
  webauthn_credentials_user_id_users_id_fk: "webauthn_credentials_user_id_account_fk",
  totp_secrets_user_id_users_id_fk: "totp_secrets_user_id_account_fk",
  recovery_codes_user_id_users_id_fk: "recovery_codes_user_id_account_fk",
  oauth_auth_codes_user_id_users_id_fk: "oauth_auth_codes_user_id_account_fk",
  login_tokens_user_id_users_id_fk: "login_tokens_user_id_account_fk",
  webauthn_challenges_user_id_users_id_fk: "webauthn_challenges_user_id_account_fk",
  refresh_tokens_session_id_sessions_id_fk: "refresh_tokens_session_id_account_fk",
  refresh_tokens_user_id_users_id_fk: "refresh_tokens_user_id_account_fk",
  credentials_user_id_unique: "credentials_account_user_unique",
  totp_secrets_user_id_unique: "totp_secrets_account_user_unique",
  // cloud 0103
  platform_signals_provider_check: "platform_signals_provider_shape",
};

describe.skipIf(!PG_UP)("a store from empty and a store moved", () => {
  let a: ReturnType<typeof postgres>;
  let b: ReturnType<typeof postgres>;
  let planted: Planted;
  let before: Awaited<ReturnType<typeof fingerprintOf>>;
  let refused: Awaited<ReturnType<typeof refusalsOf>>;
  const events: TransitionEvent[] = [];

  beforeAll(async () => {
    await fresh.create((url) => runMigrations(url));
    await moved.create(async (url) => {
      await makeStoreAtOldHeads(url);
      const plant = postgres(url, { max: 1, onnotice: () => { /* quiet */ } });
      try {
        planted = await plant1011(plant, { cloud: true, ring });
        before = await fingerprintOf(plant);
        refused = await refusalsOf(plant);
      } finally { await plant.end({ timeout: 5 }); }
      await runMigrations(url, { transition: { kind: "cloud", openSealed: sealedOpener(ring), log: (e) => { events.push(e); } } });
    });
    a = postgres(fresh.url, quiet);
    b = postgres(moved.url, quiet);
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    await a?.end({ timeout: 5 });
    await b?.end({ timeout: 5 });
    await fresh.drop();
    await moved.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("hold the same catalog, line for line", async () => {
    const [made, wasMoved] = [await fingerprintOf(a), await fingerprintOf(b)];
    expect(wasMoved.catalog.split("\n").length).toBeGreaterThan(1500);
    // By line, so a difference is named: what one has and the other lacks.
    const lines = (text: string): Set<string> => new Set(text.split("\n"));
    const [left, right] = [lines(made.catalog), lines(wasMoved.catalog)];
    expect({ onlyFromEmpty: [...left].filter((l) => !right.has(l)), onlyMoved: [...right].filter((l) => !left.has(l)) })
      .toEqual({ onlyFromEmpty: [], onlyMoved: [] });
    expect(Object.keys(wasMoved.counts).sort()).toEqual(Object.keys(made.counts).sort());
    expect(Object.keys(made.counts).sort()).toEqual(tablesOf("cloud"));
  });

  it("record the same journal entries, hash for hash", async () => {
    const [made, wasMoved] = [await fingerprintOf(a), await fingerprintOf(b)];
    expect(wasMoved.ledgers).toBe(made.ledgers);
  });

  it("the moved store holds, table by table, the count the map's formula gave of the store before", async () => {
    const after = await fingerprintOf(b);
    for (const table of tablesOf("cloud")) {
      const rows = MAP_2_0[table]!.rows;
      if (rows === "same") expect(after.counts[table], table).toBe(before.counts[table]);
      if (rows === "empty") expect(after.counts[table], table).toBe(0);
    }
    expect(after.counts.pass_progress).toBe(planted.passRows.length);
    expect(after.counts.account_counters).toBe(planted.countersMoved.length);
    expect(after.counts.auth_throttle).toBe(planted.countersStayed.length);
    expect(events.filter((e) => e.type === "check")).toEqual([]);
    expect(events.at(-1)?.type).toBe("committed");
  });

  /**
   * The comparison above holds two 2.0 stores against each other: what an entry takes away is gone
   * from both, and it sees nothing. This one holds the moved store against the store it was.
   */
  it("the moved store refuses what the store at 1.0.11 refused: every constraint by its definition, every NOT NULL", async () => {
    const after = await refusalsOf(b);
    const stands = new Set(after.tables);
    const now = new Map(after.constraints.map((c) => [`${c.table}.${c.name}`, c]));
    const lost: string[] = [];
    for (const was of refused.constraints.filter((c) => stands.has(c.table))) {
      const same = now.get(`${was.table}.${was.name}`);
      if (same) {
        // A constraint 1.0.11 never validated reads `NOT VALID` there; here it is validated.
        if (same.def !== was.def.replace(/ NOT VALID$/, "") || !same.valid) lost.push(`${was.table}.${was.name} reads ${same.def}`);
        continue;
      }
      const heir = now.get(`${was.table}.${REPLACED[was.name]}`);
      if (!heir || heir.type !== was.type || !heir.valid || !was.columns.every((c) => heir.columns.includes(c))) {
        lost.push(`${was.table}.${was.name} is gone`);
      } else if (was.type === "f" && (heir.parent !== was.parent || heir.onDelete !== was.onDelete || heir.onUpdate !== was.onUpdate)) {
        lost.push(`${was.table}.${was.name}: ${heir.name} is another key (parent ${heir.parent}, on delete ${heir.onDelete}, on update ${heir.onUpdate})`);
      }
    }
    expect(lost).toEqual([]);
    // The list names nothing 1.0.11 did not carry, and the one table that left took its own constraints.
    expect(Object.keys(REPLACED).filter((name) => !refused.constraints.some((c) => c.name === name))).toEqual([]);
    expect(refused.tables.filter((t) => !stands.has(t))).toEqual(["away_responder_sent"]);
    const takesNoNull = new Set(after.notNull);
    expect(refused.notNull.filter((c) => stands.has(c.split(".")[0]!) && !takesNoNull.has(c))).toEqual([]);
  });

  /**
   * A unique index with no constraint behind it refuses as a constraint does, and a trigger can refuse
   * too: `staff_audit_events` refuses every change to the staff's trail by two. Each stands as it stood
   * unless named here with the entry that takes it away (mail 0200 only where no letter is found by
   * the old search alone, so it may stay).
   */
  const TRIGGERS_GONE: Record<string, string> = {
    message_bodies_body_tsv_tg: "mail 0200",
    folder_state_outstanding_account_tg: "mail 0201",
    folder_state_pending_account_tg: "mail 0201",
    flag_state_pending_account_tg: "mail 0201",
  };

  it("the moved store keeps every unique index and every trigger of the store at 1.0.11, by its definition", async () => {
    const after = await refusalsOf(b);
    const stands = new Set(after.tables);
    const lost: string[] = [];
    const indexNow = new Map(after.uniqueIndexes.map((i) => [`${i.table}.${i.name}`, i]));
    for (const was of refused.uniqueIndexes.filter((i) => stands.has(i.table))) {
      const now = indexNow.get(`${was.table}.${was.name}`);
      if (!now) lost.push(`${was.table}.${was.name} is gone`);
      else if (now.def !== was.def || !now.valid) lost.push(`${was.table}.${was.name} reads ${now.def}${now.valid ? "" : ", not valid"}`);
    }
    const triggerNow = new Map(after.triggers.map((t) => [`${t.table}.${t.name}`, t]));
    for (const was of refused.triggers.filter((t) => stands.has(t.table) && !(t.name in TRIGGERS_GONE))) {
      const now = triggerNow.get(`${was.table}.${was.name}`);
      if (!now) lost.push(`${was.table}.${was.name} is gone`);
      else if (now.def !== was.def || now.enabled !== was.enabled || now.fn !== was.fn || now.body !== was.body) {
        lost.push(`${was.table}.${was.name} reads ${now.def}, enabled ${now.enabled}, ${now.fn} ${now.body}`);
      }
    }
    expect(lost).toEqual([]);
    // What the reading must reach on the store it was: unique indexes no constraint holds, the trail's two refusals.
    const names = new Set(refused.uniqueIndexes.map((i) => i.name));
    expect(["users_email_unique_idx", "mailboxes_active_address_uq", "message_instances_primary_uq", "tags_account_name_uq"]
      .filter((n) => !names.has(n))).toEqual([]);
    expect(refused.triggers.filter((t) => t.table === "staff_audit_events").map((t) => t.name))
      .toEqual(["staff_audit_events_no_change", "staff_audit_events_no_truncate"]);
    expect(Object.keys(TRIGGERS_GONE).filter((name) => !refused.triggers.some((t) => t.name === name))).toEqual([]);
  });
});
