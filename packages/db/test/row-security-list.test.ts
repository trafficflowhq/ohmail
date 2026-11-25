import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { MAIL_MIGRATIONS_DIR } from "@ohmail/db-mail";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import * as mailTables from "../src/schema-mail.js";
import * as cloudTables from "../src/schema-cloud.js";
import { MAP_2_0 } from "../src/transition/expected-counts.js";
import { BINDER_SQL } from "../src/bound.js";
import { ROLE_DEFAULT_TIMEOUTS } from "../src/handle-table.js";
import { STAFF_ROLE } from "../src/staff-grants.js";
import {
  ACCOUNT_SETTING, API_ROLE, KEY_SETTING, LOCK_READERS, PLANE_ROLE, READER_SCHEMA, WORKER_ROLE, readerStatement,
} from "../src/row-security/names.js";
import {
  KEYED_TABLES, OPERATIONS_TABLES, PLANE_APPENDS, PLANE_READS, STAFF_TABLES, UNOWNED_TABLES, WORKER_WIDE_READ,
  accountColumnOf, adminReadTables, lockedTables, policiesFor, policiesNaming, policiesOfTable, policyList, serverTables, tableClass,
} from "../src/row-security/policies.js";
import { ROLE_DEADLINES } from "../src/row-security/deadlines.js";
import { lockVerdict } from "../src/row-security/check.js";
import { lockDrift, policyComment, viewComment, type LockFacts, type ReaderFacts, type Right, type ViewFacts } from "../src/row-security/census.js";
import { ACCOUNT_VIEWS, INDEX_READS, VIEW_CHECK_OPTION, readerCondition, viewName, viewStatement } from "../src/row-security/views.js";
import { CLOUD_MIGRATIONS_DIR } from "../src/journal-specs.js";
import { RUNTIME_LOGINS } from "../src/row-security/logins.js";
import { WORD_INDEX_SPEC } from "../src/search-setup.js";
import { pgDialect } from "../src/dialect/pg.js";
import { HORIZONS, intervalOf } from "../src/horizons.js";
import { AUTH_EVENTS_RETENTION_MS, CONNECT_ATTEMPTS_RETENTION_MS, SIGN_IN_RECORD_RETENTION_MS } from "../src/retention.js";
import { AUDIT_LOG_RETENTION_MS } from "../src/change-log-retention.js";
import { WEBAUTHN_CHALLENGE_RETENTION_MS } from "../src/webauthn-challenges.js";
import { DEVICE_CEREMONY_RETENTION_MS, OAUTH_CEREMONY_RETENTION_MS } from "../src/oauth-ceremony.js";
import { SEND_FINGERPRINT_RETENTION_MS } from "../src/send-fingerprints.js";
import { ERASED_NOTICE_KEEP_YEARS } from "../src/erased-notices.js";
import { ERASED_REFRESH_KEEP_DAYS } from "../src/erased-bearers.js";
import { AUTH_THROTTLE_RETENTION_MS } from "../src/auth-throttle-prune.js";

/**
 * THE LOCK'S LIST, without a server: every server table has one class, the classes agree with the
 * map of the 2.0 store, each locked table's policies are what the rulings name, and the names the
 * binder writes are the names the readers read. The policies themselves are made and proven on a
 * real Postgres (`row-security.pg.test.ts`); this holds the list they are made from.
 */

/** The columns of each table the two schema files declare, by SQL name. */
const COLUMNS = new Map<string, Set<string>>(
  ([...Object.values(mailTables), ...Object.values(cloudTables)] as unknown[]).filter((t) => t instanceof PgTable)
    .map((t) => { const cfg = getTableConfig(t as PgTable); return [cfg.name, new Set(cfg.columns.map((c) => c.name))] as const; }),
);
const bare = (arm: string): string => arm.replace(/::text$/, "");

describe("every table of a server is in exactly one class, and the classes agree with the map", () => {
  it("a server holds 112 tables: 83 of the account, 14 read before sign-in, 5 of the staff, 10 of operations", () => {
    const counts: Record<string, number> = {};
    for (const t of serverTables()) {
      const c = tableClass(t);
      expect(c, `${t} is in no class`).not.toBeNull();
      counts[c!] = (counts[c!] ?? 0) + 1;
    }
    expect(serverTables()).toHaveLength(112);
    expect(counts).toEqual({ account: 83, keyed: 14, staff: 5, operations: 10 });
    expect(lockedTables()).toHaveLength(102);
  });

  it("keeps the mailbox learning note and log inside the account", () => {
    const table = "screener_learning";
    expect(tableClass(table)).toBe("account");
    expect(adminReadTables()).not.toContain(table);
    expect(WORKER_WIDE_READ).not.toContain(table);
  });

  it("a table with the account's column is the account's or read before sign-in; one without is not", () => {
    for (const t of serverTables()) {
      const cls = tableClass(t);
      const carries = MAP_2_0[t]!.account;
      expect(carries, `${t}: the map's flag against the catalog's columns`).toBe(COLUMNS.get(t)?.has("account_id") ?? false);
      if (cls === "operations" || cls === "staff") expect(carries, t).toBe(false);
      if (cls === "account") expect(carries || t === "accounts", t).toBe(true);
      expect(accountColumnOf(t)).toBe(t === "accounts" ? "id" : carries && cls !== "operations" && cls !== "staff" ? "account_id" : null);
    }
  });

  it("every list names a server table, and none is named in two classes", () => {
    const server = new Set(serverTables());
    const named = [...OPERATIONS_TABLES, ...STAFF_TABLES, ...Object.keys(KEYED_TABLES)];
    expect(new Set(named).size).toBe(named.length);
    for (const t of [...named, ...WORKER_WIDE_READ, ...PLANE_READS, ...PLANE_APPENDS, ...UNOWNED_TABLES, ...HORIZONS.map((x) => x.table)]) {
      expect(server.has(t), `${t} is no table of a server`).toBe(true);
    }
  });

  it("a table outside the map is the account's when it carries the column, and in no class when it does not", () => {
    expect(tableClass("a_table_nobody_listed", true)).toBe("account");
    expect(tableClass("a_table_nobody_listed", false)).toBeNull();
    expect(accountColumnOf("a_table_nobody_listed", true)).toBe("account_id");
  });

  it("every key arm and every horizon names columns its table has", () => {
    for (const [t, arms] of Object.entries(KEYED_TABLES)) {
      for (const arm of arms) expect(COLUMNS.get(t)?.has(bare(arm)), `${t}.${arm}`).toBe(true);
    }
    for (const x of HORIZONS) expect(COLUMNS.has(x.table), x.table).toBe(true);
  });
});

describe("each locked table's policies", () => {
  const rows = policyList();

  it("one name per table, each naming roles of the lock and never PUBLIC", () => {
    const keys = rows.map((r) => `${r.table}.${r.name}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of rows) {
      expect(r.roles.length).toBeGreaterThan(0);
      for (const role of r.roles) expect([API_ROLE, WORKER_ROLE, STAFF_ROLE, PLANE_ROLE]).toContain(role);
      expect(r.using !== null || r.check !== null, `${r.table}.${r.name} says nothing`).toBe(true);
    }
  });

  it("the account's policy on the 95 tables that name an account, for both logins and every verb", () => {
    const own = rows.filter((r) => r.name === "lock_account");
    expect(own).toHaveLength(95);
    for (const r of own) {
      expect(r.verb).toBe("ALL");
      expect([...r.roles]).toEqual([API_ROLE, WORKER_ROLE]);
      expect(r.using).toBe(r.check);
    }
    expect(own.find((r) => r.table === "accounts")!.using).toBe("id = ohmail.current_account()");
  });

  it("no operations table has a policy, and every other server table has at least one for the API's role", () => {
    const tables = new Set(rows.map((r) => r.table));
    for (const t of OPERATIONS_TABLES) expect(tables.has(t), t).toBe(false);
    for (const t of lockedTables()) expect(rows.some((r) => r.table === t && r.roles.includes(API_ROLE)), t).toBe(true);
  });

  it("a key reads on the 14; it inserts and rewrites only on the funnel, and on rows with no account yet", () => {
    expect(rows.filter((r) => r.name === "lock_key_read").map((r) => r.table)).toEqual(Object.keys(KEYED_TABLES).sort());
    expect(rows.filter((r) => r.name === "lock_key_insert" || r.name === "lock_key_update").map((r) => `${r.table}.${r.verb}`))
      .toEqual(["invites.INSERT", "invites.UPDATE", "waitlist.INSERT", "waitlist.UPDATE"]);
    expect(rows.find((r) => r.table === "invites" && r.name === "lock_key_read")!.using)
      .toBe("code_hash = ohmail.current_key() OR email = ohmail.current_key() OR consumed_by_user_id::text = ohmail.current_key() OR id::text = ohmail.current_key()");
    expect(rows.filter((r) => r.name.startsWith("lock_unowned_")).map((r) => `${r.table}.${r.verb}`))
      .toEqual(["login_tokens.INSERT", "login_tokens.UPDATE", "webauthn_challenges.INSERT", "webauthn_challenges.UPDATE"]);
    for (const r of rows.filter((x) => x.name.startsWith("lock_unowned_"))) expect(r.check).toMatch(/^account_id IS NULL AND \(/);
  });

  it("the fourteen keyed tables' arms, word for word: a second arm on any of them is a door to another account's row", () => {
    expect(Object.fromEntries(rows.filter((r) => r.name === "lock_key_read").map((r) => [r.table, r.using]))).toEqual({
      cal_push_channels: "channel_id = ohmail.current_key()",
      erased_bearers: "token_hash = ohmail.current_key()",
      invites: "code_hash = ohmail.current_key() OR email = ohmail.current_key() OR consumed_by_user_id::text = ohmail.current_key() OR id::text = ohmail.current_key()",
      login_tokens: "token_hash = ohmail.current_key()",
      mailbox_oauth_ceremonies: "state = ohmail.current_key()",
      oauth_auth_codes: "code_hash = ohmail.current_key()",
      pairing_tokens: "token_hash = ohmail.current_key()",
      recovery_codes: "code_hash = ohmail.current_key()",
      refresh_tokens: "token_hash = ohmail.current_key()",
      sessions: "access_token_hash = ohmail.current_key()",
      users: "email = ohmail.current_key()",
      waitlist: "email = ohmail.current_key() OR id::text = ohmail.current_key()",
      webauthn_challenges: "challenge = ohmail.current_key() OR login_token_id::text = ohmail.current_key()",
      webauthn_credentials: "credential_id = ohmail.current_key()",
    });
    for (const r of rows.filter((x) => x.name === "lock_key_read")) expect(r, r.table).toMatchObject({ verb: "SELECT", roles: [API_ROLE], check: null });
  });

  it("the rows that name no account yet, word for word: made and spent by their key, and only while they name no account", () => {
    const unowned = {
      login_tokens: "account_id IS NULL AND (token_hash = ohmail.current_key())",
      webauthn_challenges: "account_id IS NULL AND (challenge = ohmail.current_key() OR login_token_id::text = ohmail.current_key())",
    };
    expect(rows.filter((r) => r.name.startsWith("lock_unowned_")).map(({ table, name, verb, roles, using, check }) => ({ table, name, verb, roles, using, check })))
      .toEqual([
        { table: "login_tokens", name: "lock_unowned_insert", verb: "INSERT", roles: [API_ROLE], using: null, check: unowned.login_tokens },
        { table: "login_tokens", name: "lock_unowned_update", verb: "UPDATE", roles: [API_ROLE], using: unowned.login_tokens, check: unowned.login_tokens },
        { table: "webauthn_challenges", name: "lock_unowned_insert", verb: "INSERT", roles: [API_ROLE], using: null, check: unowned.webauthn_challenges },
        { table: "webauthn_challenges", name: "lock_unowned_update", verb: "UPDATE", roles: [API_ROLE], using: unowned.webauthn_challenges, check: unowned.webauthn_challenges },
      ]);
  });

  it("the staff tables open to the API's role only through the named door, with no account bound, to read and to write", () => {
    const door = rows.filter((r) => r.name === "lock_staff_door");
    expect(door.map((r) => r.table)).toEqual([...STAFF_TABLES]);
    for (const r of door) {
      expect(r.roles).toEqual([API_ROLE]);
      expect(r.verb).toBe("ALL");
      expect(r.using).toBe("ohmail.current_account() IS NULL AND ohmail.current_key() = 'ohmail:staff'");
      expect(r.check).toBe("ohmail.current_account() IS NULL AND ohmail.current_key() = 'ohmail:staff'");
    }
  });

  it("the worker reads the ten wide tables, and touches a pruned table only past its horizon", () => {
    expect(rows.filter((r) => r.name === "lock_worker_wide").map((r) => r.table)).toEqual([
      "account_closures", "account_storage", "account_storage_holds", "accounts", "cal_connections", "cal_push_channels",
      "credit_refund_obligations", "mailboxes", "pass_progress", "screener_suggest_owed",
    ]);
    expect(rows.filter((r) => r.name === "lock_worker_past_lock").map((r) => r.table))
      .toEqual(["account_counters", "invites", "login_tokens", "oauth_auth_codes", "pairing_tokens", "staff_sessions"]);
    for (const r of rows.filter((x) => x.name === "lock_worker_past_lock")) expect(r.check).toBe("false");
    expect(rows.filter((r) => r.name === "lock_worker_roster").map((r) => r.table))
      .toEqual(["devices", "outbound_send_fingerprints", "sessions"]);
    expect(rows.filter((r) => r.name === "lock_worker_past_delete")).toHaveLength(16);
    const staff = rows.find((r) => r.table === "staff_sessions" && r.name === "lock_worker_past_read")!;
    expect(staff.using).toBe(`ohmail.current_account() IS NULL AND (expires_at < pg_catalog.now() - interval '30 days')`);
    // The owed notices: read alone, the claim runs bound.
    expect(rows.filter((r) => r.table === "account_counters" && r.roles.includes(WORKER_ROLE)).map((r) => `${r.name}.${r.verb}`))
      .toEqual(["lock_account.ALL", "lock_worker_notices_read.SELECT", "lock_worker_past_delete.DELETE", "lock_worker_past_lock.UPDATE", "lock_worker_past_read.SELECT"]);
  });

  it("the doors beside the account's: the wide read only reads, the notices only their family, and each horizon policy the horizon's own expression", () => {
    for (const r of rows.filter((x) => x.name === "lock_worker_wide")) {
      expect(r, r.table).toMatchObject({ verb: "SELECT", roles: [WORKER_ROLE], using: "true", check: null });
    }
    expect(rows.filter((r) => r.name === "lock_worker_notices_read")).toEqual([expect.objectContaining({
      table: "account_counters", verb: "SELECT", roles: [WORKER_ROLE], using: "key LIKE 'notice:%'", check: null,
    })]);
    for (const x of HORIZONS) {
      const own = rows.filter((r) => r.table === x.table && r.name.startsWith("lock_worker_") && r.name !== "lock_worker_wide" && r.name !== "lock_worker_notices_read");
      expect(own.length, x.table).toBeGreaterThan(0);
      const using = x.onlyUnbound ? `ohmail.current_account() IS NULL AND (${x.using})` : x.using;
      for (const r of own) expect(r.using, `${x.table}.${r.name}`).toBe(using);
    }
  });

  it("the funnel's key writes: an insert only under the address the key names, a rewrite only of a row its key reads", () => {
    const arms = {
      invites: "code_hash = ohmail.current_key() OR email = ohmail.current_key() OR consumed_by_user_id::text = ohmail.current_key() OR id::text = ohmail.current_key()",
      waitlist: "email = ohmail.current_key() OR id::text = ohmail.current_key()",
    };
    expect(rows.filter((r) => r.name === "lock_key_insert" || r.name === "lock_key_update").map(({ table, name, verb, roles, using, check }) => ({ table, name, verb, roles, using, check })))
      .toEqual([
        { table: "invites", name: "lock_key_insert", verb: "INSERT", roles: [API_ROLE], using: null, check: "email = ohmail.current_key()" },
        { table: "invites", name: "lock_key_update", verb: "UPDATE", roles: [API_ROLE], using: arms.invites, check: "true" },
        { table: "waitlist", name: "lock_key_insert", verb: "INSERT", roles: [API_ROLE], using: null, check: "email = ohmail.current_key()" },
        { table: "waitlist", name: "lock_key_update", verb: "UPDATE", roles: [API_ROLE], using: arms.waitlist, check: "true" },
      ]);
  });

  it("the staff role reads the twenty locked tables its grants name; the plane its four and its one append", () => {
    expect(adminReadTables()).toHaveLength(20);
    expect(adminReadTables()).toContain("staff_audit_events");
    expect(adminReadTables()).not.toContain("worker_heartbeats");
    expect(rows.filter((r) => r.name === "lock_admin_read").map((r) => r.table)).toEqual(adminReadTables());
    expect(rows.filter((r) => r.roles.includes(PLANE_ROLE)).map((r) => `${r.table}.${r.verb}`))
      .toEqual(["account_storage.SELECT", "accounts.SELECT", "audit_log.INSERT", "mailboxes.SELECT", "staff_users.SELECT"]);
  });

  it("a role the server lacks gets no policy; the worker's list is the roster handle's", () => {
    const present = new Set([API_ROLE, WORKER_ROLE]);
    expect(policiesFor(rows, present).some((r) => r.roles.includes(STAFF_ROLE) || r.roles.includes(PLANE_ROLE))).toBe(false);
    const worker = policiesNaming(WORKER_ROLE);
    expect(worker).toHaveLength(147);
    expect(worker[0]).toBe("public.account_closures.lock_account");
    expect([...worker].sort()).toEqual(worker);
  });
});

describe("the account's views of the lock", () => {
  const render = (q: Parameters<PgDialect["sqlToQuery"]>[0]): string => new PgDialect().sqlToQuery(q).sql;

  /**
   * THE COLUMNS A STORE MAY ALREADY HOLD, in each view's order. A view an earlier release made answers these:
   * the step makes it again over itself only where the list keeps them, in order and type, and adds columns at its end
   * (`create or replace view` takes no other change of a view's columns). So a list grows at its end only: a column put in the
   * middle, a removal or a reorder is red here before it reaches a store. A release whose grown list has run on a store adds
   * its new columns to the end of this pin.
   */
  const HELD: Readonly<Record<string, readonly string[]>> = {
    messages: [
      "id", "account_id", "mailbox_id", "message_id_header", "body_hash", "dedup_key", "subject", "from_address", "from_name",
      "date", "native_locator", "no_ai", "no_forward", "no_kb", "priority", "created_at", "thread_id", "unread", "last_read_at",
      "deleted_at", "snippet", "to_addresses", "cc_addresses", "has_attachments", "attachment_count", "sensitivity_category",
      "auth_verdict", "updated_at", "arrived_at", "open_read_at", "sender_check", "sender_check_brand", "sender_check_by",
      "server_missing_at", "unconfirmed_hold", "recipient_keys",
    ],
    message_search: ["message_id", "account_id", "head_tsv", "text_tsv", "terms", "source", "built_at"],
  };

  it("each view's list begins with the columns a store may already hold, in their order: a list grows at its end only", () => {
    expect({ messages: HELD.messages!.length, message_search: HELD.message_search!.length }).toEqual({ messages: 36, message_search: 7 });
    for (const v of ACCOUNT_VIEWS) expect(v.columns.slice(0, HELD[v.table]!.length), v.name).toEqual(HELD[v.table]);
  });

  it("three views, of messages and the search documents, each answering columns its table declares, one by one", () => {
    expect(ACCOUNT_VIEWS.map((v) => `${viewName(v)} of ${v.table}`)).toEqual([
      "ohmail.messages of messages", "ohmail.message_search of message_search", "ohmail.message_search_words of message_search",
    ]);
    for (const v of ACCOUNT_VIEWS) {
      expect(v.columns.length, v.name).toBeGreaterThan(0);
      expect(new Set(v.columns).size, `${v.name}: a column named twice`).toBe(v.columns.length);
      for (const c of v.columns) expect(COLUMNS.get(v.table)?.has(c), `${v.name}.${c} is a column of ${v.table}`).toBe(true);
      expect(v.columns.includes("account_id"), v.name).toBe(true);
    }
  });

  it("each view's text names exactly the two runtime logins, by current_user, as literals, once each", () => {
    expect(readerCondition()).toBe(`current_user in (${RUNTIME_LOGINS.map((l) => `'${l}'`).join(", ")})`);
    for (const v of ACCOUNT_VIEWS) {
      const text = viewStatement(v);
      // The only quoted literals of a view's text are the logins' names, each once.
      expect([...text.matchAll(/'([^']*)'/g)].map((m) => m[1]), v.name).toEqual([...RUNTIME_LOGINS]);
      expect(text.split(readerCondition()).length - 1, v.name).toBe(1);
      expect(text, v.name).not.toMatch(/session_user/);
    }
  });

  it("each view's text: its columns, its table, the account's condition, the reader's, and the check option alone", () => {
    for (const v of ACCOUNT_VIEWS) {
      expect(viewStatement(v), v.name).toBe(`create view ${viewName(v)} as select ${v.columns.map((c) => `"${c}"`).join(", ")} from public."${v.table}"`
        + ` where ${v.key} and ${readerCondition()} with check option`);
      expect(viewStatement(v, true), v.name).toBe(viewStatement(v).replace(/^create view /, "create or replace view "));
      expect(viewStatement(v), v.name).not.toMatch(/security_barrier|security_invoker|\*/);
    }
    expect(VIEW_CHECK_OPTION).toBe("check_option=cascaded");
  });

  it("the two views of a table's own key compare the account as the lock's policy does; the words view keys it as the word index and the word key do", () => {
    const own = (table: string): string => policiesOfTable(table).find((r) => r.name === "lock_account")!.using!;
    const byName = new Map(ACCOUNT_VIEWS.map((v) => [v.name, v]));
    expect(byName.get("messages")!.key).toBe(own("messages"));
    expect(byName.get("message_search")!.key).toBe(own("message_search"));
    // The word index's first key, and the left side of the dialect's word key with its alias taken off.
    const indexKey = /using gin \(\((\(account_id\)::text)\),/.exec(render(WORD_INDEX_SPEC.ddl))?.[1];
    const wordKey = /^\((.+?) = /.exec(render(pgDialect().search.wordKey("00000000-0000-4000-8000-000000000001")!))?.[1]?.replace(/\bs\./g, "");
    const viewKey = byName.get("message_search_words")!.key.split(" = ")[0];
    expect({ indexKey, wordKey }).toEqual({ indexKey: viewKey, wordKey: viewKey });
    expect(byName.get("message_search_words")!.key).toBe(`${viewKey} = (ohmail.current_account())::text`);
  });
});

describe("how each index the lock could take from a read is read", () => {
  it("43 rows, each on a locked table: a view over that table, a bound named, or a reason; the catalog's own list is the lock's ground's case", () => {
    const locked = new Set(lockedTables());
    const rows = Object.entries(INDEX_READS);
    expect(rows).toHaveLength(43);
    expect(rows.filter(([, r]) => r.read === "view").map(([n]) => n).sort()).toEqual([
      "message_search_head_terms_trgm_idx", "message_search_head_tsv_idx", "message_search_names_trgm_idx", "message_search_terms_trgm_idx",
      "message_search_text_tsv_idx", "message_search_words_idx", "messages_account_arrival_key_idx", "messages_account_from_addr_idx",
      "messages_account_from_domain_idx", "messages_account_sender_date_idx", "messages_recipient_keys_column_idx",
    ]);
    for (const [name, r] of rows) {
      expect(locked.has(r.table), `${name} is on ${r.table}, a locked table`).toBe(true);
      if (r.read === "view") expect(ACCOUNT_VIEWS.find((v) => v.name === r.through)?.table, `${name} reads through a view over ${r.table}`).toBe(r.table);
      if (r.read === "small") expect(r.bound.length, `${name} names its bound`).toBeGreaterThan(20);
      if (r.read === "kept") expect(r.why.length, `${name} says why`).toBeGreaterThan(20);
    }
  });
});

/**
 * A JOURNAL ENTRY OVER A STANDING VIEW (the search ruling's "a view and a later journal"). Postgres
 * refuses to drop or retype a column a view names, and takes a rename, which leaves the view reading the renamed column under
 * its old name; a table dropped or renamed takes its views with it, or leaves them over the other name. So an entry of a
 * journal that runs on a server (the mail journal and the Cloud's) that drops, renames or retypes a column a listed view
 * names, or drops or renames that view's table, starts with `DROP VIEW IF EXISTS` of each listed view over that table (IF
 * EXISTS: a store without the lock has none), and the setup's lock step makes them again in the same run. No test database
 * holds the views (the step acts only where the runtime logins exist), so only this reading holds it before a store does.
 */
const SERVER_JOURNALS = [["mail", MAIL_MIGRATIONS_DIR], ["cloud", CLOUD_MIGRATIONS_DIR]] as const;
const entriesOf = (dir: string): Array<{ name: string; sql: string }> => readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => ({ name: f, sql: readFileSync(join(dir, f), "utf8") }));

/**
 * An entry's SQL as statements: comments and string literals blanked, dollar quotes taken away so a DO block's statements read
 * as statements, double-quoted names kept bare, lower case, one space; split on `;`. One left-to-right pass.
 */
function statementsOf(sql: string): string[] {
  let out = "";
  for (let i = 0; i < sql.length;) {
    if (sql.startsWith("--", i)) { while (i < sql.length && sql[i] !== "\n") i += 1; continue; }
    if (sql.startsWith("/*", i)) { const end = sql.indexOf("*/", i + 2); i = end < 0 ? sql.length : end + 2; out += " "; continue; }
    if (sql[i] === "'") {
      i += 1;
      while (i < sql.length) { if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; } if (sql[i] === "'") { i += 1; break; } i += 1; }
      out += " ''";
      continue;
    }
    if (sql[i] === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 40));
      if (tag !== null) { i += tag[0].length; out += " "; continue; }
    }
    out += sql[i] === '"' ? "" : sql[i];
    i += 1;
  }
  return out.split(";").map((t) => t.replace(/\s+/g, " ").trim().toLowerCase()).filter((t) => t !== "");
}

/** The parts of a list at its top-level commas (a type's `(10,2)` stays whole). */
function partsOf(text: string): string[] {
  const parts: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") depth -= 1;
    else if (text[i] === "," && depth === 0) { parts.push(text.slice(from, i).trim()); from = i + 1; }
  }
  parts.push(text.slice(from).trim());
  return parts;
}

/** A relation's name, its schema taken off: `public.messages` and `messages` are one table. */
const bareName = (qualified: string): string => qualified.split(".").pop()!;

/**
 * Each statement of an entry that a listed view cannot stand, and the listed views it needs dropped before it that the entry
 * has not dropped by then. A DO block or a function that composes its SQL at run time is refused by its own case below.
 */
export function viewBreaks(entry: { name: string; sql: string }): string[] {
  const dropped = new Set<string>();
  const found: string[] = [];
  const over = (table: string): typeof ACCOUNT_VIEWS[number][] => ACCOUNT_VIEWS.filter((v) => v.table === table);
  const need = (statement: string, views: readonly typeof ACCOUNT_VIEWS[number][]): void => {
    const missing = views.map(viewName).filter((v) => !dropped.has(v));
    if (missing.length > 0) found.push(`${entry.name}: ${statement} (first: DROP VIEW IF EXISTS ${missing.join(", ")})`);
  };
  for (const piece of statementsOf(entry.sql)) {
    // A DO block's or a branch's statement reads from its keyword on (`do begin alter table …`, `if … then drop table …`).
    const at = piece.search(/\b(alter table|drop table|drop view) /);
    if (at < 0) continue;
    const s = piece.slice(at);
    const dropView = /^drop view if exists (.+?)(?: cascade| restrict)?$/.exec(s);
    if (dropView !== null) { for (const n of partsOf(dropView[1]!)) dropped.add(n.includes(".") ? n : `public.${n}`); continue; }
    const dropTable = /^drop table (?:if exists )?(.+?)(?: cascade| restrict)?$/.exec(s);
    if (dropTable !== null) { for (const n of partsOf(dropTable[1]!)) need(s, over(bareName(n))); continue; }
    const alter = /^alter table (?:if exists )?(?:only )?(\S+) (.+)$/.exec(s);
    if (alter === null || over(bareName(alter[1]!)).length === 0) continue;
    const views = over(bareName(alter[1]!));
    const naming = (column: string): typeof views => views.filter((v) => (v.columns as readonly string[]).includes(column));
    for (const action of partsOf(alter[2]!)) {
      const words = action.split(" ");
      if (/^(rename to|set schema) /.test(action)) need(s, views);
      else if (words[0] === "rename" && words[1] !== "constraint") need(s, naming(words[1] === "column" ? words[2]! : words[1]!));
      else if (words[0] === "drop" && words[1] !== "constraint") {
        const rest = words[1] === "column" ? words.slice(2) : words.slice(1);
        need(s, naming(rest[0] === "if" && rest[1] === "exists" ? rest[2]! : rest[0]!));
      } else if (words[0] === "alter") {
        const rest = words[1] === "column" ? words.slice(2) : words.slice(1);
        if (rest[1] === "type" || (rest[1] === "set" && rest[2] === "data" && rest[3] === "type")) need(s, naming(rest[0]!));
      }
    }
  }
  return found;
}

/** Each dollar-quoted body of an entry that runs SQL it composes (EXECUTE) and names a listed view's table: unreadable here. */
export function composedOverViews(entry: { name: string; sql: string }): string[] {
  const tables = new Set<string>(ACCOUNT_VIEWS.map((v) => v.table));
  const bodies: string[] = [];
  const re = /\$[A-Za-z_]*\$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(entry.sql)) !== null) {
    const end = entry.sql.indexOf(m[0], m.index + m[0].length);
    if (end < 0) break;
    bodies.push(entry.sql.slice(m.index + m[0].length, end));
    re.lastIndex = end + m[0].length;
  }
  return bodies.some((b) => /\bexecute\b/i.test(b) && [...tables].some((t) => new RegExp(`\\b${t}\\b`).test(b))) ? [entry.name] : [];
}

describe("the server journals keep the account's views standing", () => {
  it("no entry of the mail or the Cloud's journal drops, renames or retypes a column a listed view names, or drops or renames its table, without DROP VIEW IF EXISTS of each view over it first", () => {
    for (const [name, dir] of SERVER_JOURNALS) {
      const entries = entriesOf(dir);
      expect(entries.length, name).toBeGreaterThan(10);
      expect(entries.flatMap(viewBreaks), name).toEqual([]);
    }
  });

  it("no entry composes at run time SQL it names a listed view's table in: this reading would not see it", () => {
    for (const [name, dir] of SERVER_JOURNALS) expect(entriesOf(dir).flatMap(composedOverViews), name).toEqual([]);
  });

  it("the reading itself: each planted entry that would break a view is named with the views it owes, and one that drops them first is not", () => {
    const planted = (sql: string): string[] => viewBreaks({ name: "0999_planted.sql", sql });
    expect({
      dropColumn: planted(`ALTER TABLE "message_search" DROP COLUMN "source";`),
      dropColumnBare: planted(`alter table public.messages drop snippet;`),
      retype: planted(`ALTER TABLE "messages" ALTER COLUMN "snippet" SET DATA TYPE varchar(4000);`),
      retypeShort: planted(`alter table messages alter snippet type varchar(4000);`),
      renameColumn: planted(`ALTER TABLE "messages" RENAME COLUMN "snippet" TO "preview";`),
      renameTable: planted(`ALTER TABLE "message_search" RENAME TO "message_documents";`),
      dropTable: planted(`DROP TABLE IF EXISTS "drafts", "message_search" CASCADE;`),
      inADoBlock: planted(`DO $$ BEGIN ALTER TABLE "messages" DROP COLUMN IF EXISTS "subject"; END $$;`),
      oneOfTwo: planted(`DROP VIEW IF EXISTS ohmail.message_search;\nALTER TABLE "message_search" DROP COLUMN "source";`),
    }).toEqual({
      dropColumn: [`0999_planted.sql: alter table message_search drop column source (first: DROP VIEW IF EXISTS ohmail.message_search, ohmail.message_search_words)`],
      dropColumnBare: [`0999_planted.sql: alter table public.messages drop snippet (first: DROP VIEW IF EXISTS ohmail.messages)`],
      retype: [`0999_planted.sql: alter table messages alter column snippet set data type varchar(4000) (first: DROP VIEW IF EXISTS ohmail.messages)`],
      retypeShort: [`0999_planted.sql: alter table messages alter snippet type varchar(4000) (first: DROP VIEW IF EXISTS ohmail.messages)`],
      renameColumn: [`0999_planted.sql: alter table messages rename column snippet to preview (first: DROP VIEW IF EXISTS ohmail.messages)`],
      renameTable: [`0999_planted.sql: alter table message_search rename to message_documents (first: DROP VIEW IF EXISTS ohmail.message_search, ohmail.message_search_words)`],
      dropTable: [`0999_planted.sql: drop table if exists drafts, message_search cascade (first: DROP VIEW IF EXISTS ohmail.message_search, ohmail.message_search_words)`],
      inADoBlock: [`0999_planted.sql: alter table messages drop column if exists subject (first: DROP VIEW IF EXISTS ohmail.messages)`],
      oneOfTwo: [`0999_planted.sql: alter table message_search drop column source (first: DROP VIEW IF EXISTS ohmail.message_search_words)`],
    });
    // What a listed view stands: the views dropped first; a column no view names; a constraint; a column added; a comment.
    expect([
      `DROP VIEW IF EXISTS ohmail.message_search, ohmail.message_search_words;\nALTER TABLE "message_search" DROP COLUMN "source";`,
      `DROP VIEW IF EXISTS "ohmail"."messages";\nALTER TABLE "messages" ALTER COLUMN "snippet" TYPE varchar(4000);`,
      `ALTER TABLE "messages" DROP COLUMN IF EXISTS "subject_tsv";`,
      `ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_thread_id_threads_id_fk";`,
      `ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "recipient_note" text;`,
      `-- ALTER TABLE messages DROP COLUMN snippet;\nSELECT 'ALTER TABLE messages DROP COLUMN snippet';`,
    ].flatMap((sql) => planted(sql))).toEqual([]);
    // A plain DROP VIEW is not enough: on a store without the lock there is no view to drop, and the entry would fail there.
    expect(planted(`DROP VIEW ohmail.messages;\nALTER TABLE "messages" DROP COLUMN "snippet";`)).toHaveLength(1);
    expect(composedOverViews({ name: "0999_planted.sql", sql: `DO $$ BEGIN EXECUTE format('ALTER TABLE messages DROP COLUMN %I', 'snippet'); END $$;` }))
      .toEqual(["0999_planted.sql"]);
  });
});

describe("the horizons", () => {
  /**
   * Each pruned table's constants as the product's own modules export them, by name. The session
   * reaper's window is private to its service, so it is the ruling's restatement here; the proof
   * on a real Postgres holds it against the reaper's own run.
   */
  const PRODUCT: Record<string, Record<string, number>> = {
    login_tokens: { SIGN_IN_RECORD_RETENTION_MS },
    oauth_auth_codes: { SIGN_IN_RECORD_RETENTION_MS },
    pairing_tokens: { SIGN_IN_RECORD_RETENTION_MS },
    invites: { SIGN_IN_RECORD_RETENTION_MS },
    sessions: { SIGN_IN_RECORD_RETENTION_MS, ERASED_REFRESH_KEEP_DAYS, COOKIE_WINDOW_UNDER_MS: 100 * 86_400_000 },
    devices: { SIGN_IN_RECORD_RETENTION_MS },
    webauthn_challenges: { WEBAUTHN_CHALLENGE_RETENTION_MS },
    mailbox_oauth_ceremonies: { OAUTH_CEREMONY_RETENTION_MS },
    mailbox_oauth_device_ceremonies: { DEVICE_CEREMONY_RETENTION_MS },
    auth_events: { AUTH_EVENTS_RETENTION_MS },
    connect_attempts: { CONNECT_ATTEMPTS_RETENTION_MS },
    audit_log: { AUDIT_LOG_RETENTION_MS },
    idempotency_keys: {},
    erased_bearers: {},
    attachment_staging: {},
    outbound_send_fingerprints: { SEND_FINGERPRINT_RETENTION_MS },
    account_lifecycle_notices: { ERASED_NOTICE_KEEP_YEARS },
    account_counters: { AUTH_THROTTLE_RETENTION_MS },
    staff_sessions: { SIGN_IN_RECORD_RETENTION_MS },
  };

  it("each is built from the product's own constants, and its expression names each of them", () => {
    expect(HORIZONS.map((x) => x.table).sort()).toEqual(Object.keys(PRODUCT).sort());
    for (const x of HORIZONS) {
      const want = PRODUCT[x.table]!;
      expect(Object.fromEntries(x.constants.map((c) => [c.name, c.value])), x.table).toEqual(want);
      for (const c of x.constants) {
        const words = c.unit === "ms" ? intervalOf(want[c.name]!) : `interval '${want[c.name]} ${c.unit}'`;
        expect(x.using, `${x.table}: ${c.name}`).toContain(words);
      }
    }
    expect(intervalOf(3_600_000)).toBe("interval '1 hours'");
    expect(() => intervalOf(0)).toThrow(RangeError);
  });

  it("a prune that runs unbound is guarded only by a table the worker reads wide", () => {
    for (const x of HORIZONS.filter((h) => h.runs === "unbound")) {
      for (const g of x.guards) expect(WORKER_WIDE_READ as readonly string[], `${x.table} reads ${g.table}`).toContain(g.table);
    }
  });
});

describe("the deadlines by role name", () => {
  it("the API's, the worker's and the staff role's, each the handle table's role defaults", () => {
    expect(Object.keys(ROLE_DEADLINES).sort()).toEqual([STAFF_ROLE, API_ROLE, WORKER_ROLE].sort());
    for (const cell of Object.values(ROLE_DEADLINES)) expect(cell).toEqual(ROLE_DEFAULT_TIMEOUTS);
  });
});

describe("the check's verdict over the catalog's facts", () => {
  type Over = { on?: boolean; forced?: boolean; marker?: string | null; logins?: string[]; unforced?: string; extra?: Partial<LockFacts> };
  /** A catalog of a server, every table as `over` says, the marker as given, the roles all there. */
  const factsOf = (o: Over = {}): LockFacts => {
    const logins = o.logins ?? [API_ROLE, WORKER_ROLE];
    const roles = Object.fromEntries([...logins, STAFF_ROLE, PLANE_ROLE].map((r) => [r, { bypass: false, super: false }]));
    const tables = serverTables().map((name) => {
      const ops = tableClass(name) === "operations";
      const on = !ops && (o.on ?? true) && name !== o.unforced;
      return { name, rls: on, forced: on && (o.forced ?? true), account: MAP_2_0[name]!.account, owner: "ohmail_migrator", partitioned: false, partitionOf: null };
    });
    // Each policy as the step leaves it: its verb as the catalog spells it, and the step's record on it.
    const policies = policyList().map((r) => {
      const p = { table: r.table, name: r.name, permissive: true, verb: VERB_LETTER[r.verb], roles: [...r.roles], using: r.using, check: r.check };
      return { ...p, comment: policyComment(r, p) };
    });
    return {
      version: 170006, user: API_ROLE, session: API_ROLE, roles, tables, policies,
      schema: { owner: "ohmail_migrator", comment: o.marker ?? null, usage: [API_ROLE, WORKER_ROLE] }, readers: READERS, others: [],
      views: VIEWS, viewTables: VIEW_TABLES, bindingSettings: [], code: [],
      grants: {}, connected: { name: API_ROLE, bypass: false, super: false, owns: 0, member: 0, views: 0, definers: 0, ohmail: 0 }, ...o.extra,
    };
  };
  /** The two tables' columns, as the catalog types them: every column `text`, which is all the fixture needs. */
  const VIEW_TABLES = Object.fromEntries([...new Set(ACCOUNT_VIEWS.map((v) => v.table))]
    .map((table) => [table, Object.fromEntries([...COLUMNS.get(table)!].map((c) => [c, "text"]))]));
  /** One right as the catalog's facts carry it: who (`null`: PUBLIC), the privilege, and the grant option. */
  const right = (grantee: string | null, privilege: string, grantable = false): Right => ({ grantee, privilege, grantable });
  /** The three views as the step leaves them and the roles' rule grants them: its record on each, SELECT to the two logins. */
  const VIEWS: ViewFacts[] = ACCOUNT_VIEWS.map((v) => ({
    name: v.name, kind: "v", owner: "ohmail_migrator", options: [VIEW_CHECK_OPTION], text: `printed ${v.name}`,
    columns: v.columns.map((c) => `${c} text`), comment: viewComment(v, `printed ${v.name}`),
    acl: RUNTIME_LOGINS.map((l) => right(l, "SELECT")), columnAcl: [], code: [], labels: 0,
  }));
  /** How the catalog spells a policy's verb (`pg_policy.polcmd`). */
  const VERB_LETTER = { ALL: "*", SELECT: "r", INSERT: "a", UPDATE: "w", DELETE: "d" } as const;
  /** The two readers as the setup makes them. */
  const READERS: ReaderFacts[] = LOCK_READERS.map((r) => ({
    name: r.name, identity: "", src: r.body, volatile: "s", parallel: "s", secdef: false, config: null, lang: "sql",
    returns: r.returns, owner: "ohmail_migrator", args: 0, acl: null, strict: false, kind: "f",
  }));
  const MARK = "ohmail.lock off since=2026-11-15T10:00:00.000Z by=ohmail_migrator why=rehearsal";

  it("all forced, no marker: locked; none on with the marker: off; all forced with it: a stale marker", () => {
    expect(lockDrift(factsOf())).toEqual([]);
    expect(lockVerdict(factsOf()).verdict).toBe("locked");
    expect(lockVerdict(factsOf({ on: false, marker: MARK }))).toMatchObject({ verdict: "off", on: 0, forced: 0, marker: { by: "ohmail_migrator", why: "rehearsal" } });
    expect(lockVerdict(factsOf({ marker: MARK })).verdict).toBe("stale_marker");
  });

  it("a mixed state, an unforced table, a lock off with no marker, an unreadable marker: broken", () => {
    expect(lockVerdict(factsOf({ unforced: "message_bodies" })).verdict).toBe("broken");
    expect(lockVerdict(factsOf({ forced: false })).verdict).toBe("broken");
    expect(lockVerdict(factsOf({ on: false })).verdict).toBe("broken");
    expect(lockVerdict(factsOf({ marker: "lock is off, trust me" })).verdict).toBe("broken");
  });

  it("no runtime login and nothing locked: absent; something locked there: broken", () => {
    expect(lockVerdict(factsOf({ logins: [], on: false })).verdict).toBe("absent");
    expect(lockVerdict(factsOf({ logins: [] })).verdict).toBe("broken");
  });

  it("a table in no class, or the binding's setting on a role, is broken whatever the flags say", () => {
    const planted = factsOf();
    expect(lockVerdict({ ...planted, tables: [...planted.tables, { name: "planted", rls: false, forced: false, account: false, owner: "ohmail_migrator", partitioned: false, partitionOf: null }] }).verdict).toBe("broken");
    expect(lockVerdict(factsOf({ extra: { bindingSettings: ["ohmail_api/-/ohmail.account"] } })).verdict).toBe("broken");
  });

  it("a partitioned table, and each of its partitions, is broken whatever its flags, and the census names each: the lock takes none", () => {
    const f = factsOf();
    const part = (name: string, partitioned: boolean, partitionOf: string | null, on: boolean) =>
      ({ name, rls: on, forced: on, account: true, owner: "ohmail_migrator", partitioned, partitionOf });
    // The parent locked as the step locks a table; one partition open, one forced; a partitioned partition.
    const parted = { ...f, tables: [...f.tables, part("part_owned", true, null, true), part("part_owned_1", false, "part_owned", false),
      part("part_owned_2", false, "part_owned", true), part("part_owned_sub", true, "part_owned", false)] };
    const lines = [
      "part_owned is partitioned; the lock takes no partitioned table",
      "part_owned_1 is a partition of part_owned; the lock takes no partitioned table",
      "part_owned_2 is a partition of part_owned; the lock takes no partitioned table",
      "part_owned_sub is partitioned, and a partition of part_owned; the lock takes no partitioned table",
    ];
    for (const role of [API_ROLE, WORKER_ROLE]) {
      expect(lockVerdict({ ...parted, connected: { ...parted.connected, name: role } }, { role }))
        .toMatchObject({ verdict: "broken", why: lines, listed: 102, role: { policies: "equal" } });
    }
    expect(lockVerdict(parted)).toMatchObject({ verdict: "broken", why: lines });
    expect(lockDrift(parted)).toEqual([
      "LOCK_DRIFT tables.partitioned part_owned: partitioned; the lock takes no partitioned table",
      "LOCK_DRIFT tables.partitioned part_owned_1: a partition of part_owned; the lock takes no partitioned table",
      "LOCK_DRIFT tables.partitioned part_owned_2: a partition of part_owned; the lock takes no partitioned table",
      "LOCK_DRIFT tables.partitioned part_owned_sub: partitioned, and a partition of part_owned; the lock takes no partitioned table",
    ]);
  });

  it("code on a table that runs with its owner's rights, a rule or what calls a SECURITY DEFINER routine, is broken whoever reads, and the census names each", () => {
    const f = factsOf();
    // As the catalog answers them: by table, kind, name and routine.
    const code = [
      { table: "api_faults", kind: "rule", name: "fill_ops", routine: null },
      { table: "audit_log", kind: "rule", name: "fill_ids", routine: null },
      { table: "audit_log", kind: "trigger", name: "fill_ids", routine: "side_code.fill_ids()" },
      { table: "cal_settings", kind: "constraint", name: "fits_account", routine: "side_code.fits(uuid)" },
      { table: "cal_settings", kind: "default", name: "second_zone", routine: "side_code.ids()" },
      { table: "cal_settings", kind: "generated column", name: "account_word", routine: "side_code.word_of(uuid)" },
      { table: "cal_settings", kind: "index", name: "account_word", routine: "side_code.word_of(uuid)" },
    ];
    const withCode = { ...f, code } as LockFacts;
    const past = "runs with its owner's rights, past the lock";
    const what = [
      ["api_faults", `the rule fill_ops ${past}`],
      ["audit_log", `the rule fill_ids ${past}`],
      ["audit_log", `the trigger fill_ids calls the SECURITY DEFINER routine side_code.fill_ids(), which ${past}`],
      ["cal_settings", `the constraint fits_account calls the SECURITY DEFINER routine side_code.fits(uuid), which ${past}`],
      ["cal_settings", `the default of second_zone calls the SECURITY DEFINER routine side_code.ids(), which ${past}`],
      ["cal_settings", `the generated column account_word calls the SECURITY DEFINER routine side_code.word_of(uuid), which ${past}`],
      ["cal_settings", `the index account_word calls the SECURITY DEFINER routine side_code.word_of(uuid), which ${past}`],
    ];
    const why = what.map(([table, w]) => `on ${table}, ${w}`);
    for (const role of [API_ROLE, WORKER_ROLE]) {
      expect(lockVerdict({ ...withCode, connected: { ...withCode.connected, name: role } }, { role }))
        .toMatchObject({ verdict: "broken", why, listed: 102, role: { policies: "equal" } });
    }
    expect(lockVerdict(withCode)).toMatchObject({ verdict: "broken", why, role: { policies: "not-judged" } });
    expect(lockDrift(withCode)).toEqual(what.map(([table, w]) => `LOCK_DRIFT tables.code ${table}: ${w}`));
  });

  it("the account's views: one not as listed (code on it among them), or any right on one beyond the two logins' SELECT, is broken whoever reads; one missing is the census's line", () => {
    const f = factsOf();
    const withView = (name: string, over: Partial<ViewFacts>): LockFacts => ({ ...f, views: f.views.map((v) => (v.name === name ? { ...v, ...over } : v)) });
    expect(lockVerdict(withView("messages", { text: "printed by hand" }))).toMatchObject({ verdict: "broken", why: ["the view ohmail.messages differs: text"], views: 2 });
    expect(lockVerdict(withView("messages", { options: [] })).why).toEqual(["the view ohmail.messages differs: options"]);
    // Code on a listed view: a rule beside _RETURN, a trigger, a default on a column each voids the check
    // option or runs past it, and `create or replace view` keeps each: the view differs, whoever reads.
    const coded = withView("messages", { code: [{ kind: "rule", name: "riso_ins", on: "INSERT" }, { kind: "trigger", name: "riso_tr", on: null },
      { kind: "default", name: "snippet", on: null }] });
    expect(lockVerdict(coded)).toMatchObject({ verdict: "broken", views: 2,
      why: ["the view ohmail.messages differs: code (the rule riso_ins on INSERT, the trigger riso_tr, the default of snippet)"] });
    expect(lockDrift(coded)).toEqual(["LOCK_DRIFT views.differ ohmail.messages: code (the rule riso_ins on INSERT, the trigger riso_tr, the default of snippet)"]);
    // A security label is its provider's word: read, so a provider that acts on one is never past the census.
    expect(lockVerdict(withView("message_search_words", { labels: 1 })).why).toEqual(["the view ohmail.message_search_words differs: label"]);
    expect(lockVerdict(withView("message_search", { acl: [...RUNTIME_LOGINS.map((l) => right(l, "SELECT")), right("ohmail_admin", "SELECT")] })).why)
      .toEqual(["the view ohmail.message_search is granted beyond the two logins' SELECT: ohmail_admin holds SELECT"]);
    // A login's other verb, its grant option and a column grant to it are rights beyond the rule's too: an insert
    // ... on conflict do update through a view takes another account's row, and a holder of the grant option hands the view on.
    const extraVerb = withView("message_search", { acl: [...RUNTIME_LOGINS.map((l) => right(l, "SELECT")), right("ohmail_api", "UPDATE")] });
    expect(lockVerdict(extraVerb)).toMatchObject({ verdict: "broken", census: 1,
      why: ["the view ohmail.message_search is granted beyond the two logins' SELECT: ohmail_api holds UPDATE"] });
    expect(lockDrift(extraVerb)).toEqual(["LOCK_DRIFT views.grants ohmail.message_search: ohmail_api holds UPDATE"]);
    const option = withView("messages", { acl: [right("ohmail_api", "SELECT", true), right("ohmail_worker", "SELECT")] });
    expect(lockVerdict(option)).toMatchObject({ verdict: "broken", census: 1,
      why: ["the view ohmail.messages is granted beyond the two logins' SELECT: ohmail_api holds SELECT with the grant option"] });
    expect(lockDrift(option)).toEqual(["LOCK_DRIFT views.grants ohmail.messages: ohmail_api holds SELECT with the grant option"]);
    const column = withView("messages", { columnAcl: [{ ...right("ohmail_worker", "UPDATE"), column: "subject" }] });
    // Each right by its fields: a role named like a login's right is another role, named quoted; PUBLIC is no name.
    const colon = withView("messages", { acl: [...RUNTIME_LOGINS.map((l) => right(l, "SELECT")), right("ohmail_api:SELECT", "SELECT"), right(null, "SELECT")] });
    expect(lockDrift(colon)).toEqual(["LOCK_DRIFT views.grants ohmail.messages: \"ohmail_api:SELECT\" holds SELECT", "LOCK_DRIFT views.grants ohmail.messages: public holds SELECT"]);
    expect(lockVerdict(colon).verdict).toBe("broken");
    expect(lockVerdict(column).why).toEqual(["the view ohmail.messages is granted beyond the two logins' SELECT: ohmail_worker holds UPDATE on its column subject"]);
    const missing = { ...f, views: f.views.filter((v) => v.name !== "message_search_words") };
    expect(lockVerdict(missing)).toMatchObject({ verdict: "locked", views: 2 });
    expect(lockDrift(missing)).toEqual(["LOCK_DRIFT views.missing ohmail.message_search_words"]);
    // Asked for a role, a relation of the readers' schema it may reach beside the views is broken for it.
    expect(lockVerdict({ ...f, connected: { ...f.connected, ohmail: 1 } }, { role: API_ROLE }).why)
      .toEqual(["ohmail_api may reach a relation of the schema ohmail beside the account's views, or run a SECURITY DEFINER routine there"]);
  });

  it("asked to serve as a role: the connected role must be it, may not bypass, owns nothing, and its policies are the list's", () => {
    expect(lockVerdict(factsOf(), { role: API_ROLE })).toMatchObject({ verdict: "locked", role: { policies: "equal" } });
    const owner = { name: "ohmail_migrator", bypass: true, super: false, owns: 300, member: 0, views: 0, definers: 0, ohmail: 0 };
    expect(lockVerdict(factsOf({ extra: { connected: owner } }), { role: API_ROLE }).why)
      .toEqual(["connected as ohmail_migrator, not ohmail_api", "ohmail_migrator may bypass row security", "ohmail_migrator owns objects"]);
    const bypass = { ...factsOf().connected, bypass: true };
    expect(lockVerdict(factsOf({ extra: { connected: bypass } }), { role: API_ROLE }).verdict).toBe("broken");
    const lessOne = factsOf();
    expect(lockVerdict({ ...lessOne, policies: lessOne.policies.filter((p) => !(p.table === "messages" && p.name === "lock_account")) }, { role: API_ROLE }))
      .toMatchObject({ verdict: "broken", role: { policies: "differ" } });
    // Not asked: the connected role is reported and not judged.
    expect(lockVerdict(factsOf({ extra: { connected: owner } }))).toMatchObject({ verdict: "locked", role: { policies: "not-judged", bypass: true } });
  });

  it("a policy to PUBLIC on a locked table names every role: broken, asked for a role or not", () => {
    const f = factsOf();
    const pub = { ...f, policies: [...f.policies, { table: "messages", name: "pub", permissive: true, verb: "r", roles: ["public"], using: "true", check: null, comment: null }] };
    expect(lockVerdict(pub)).toMatchObject({ verdict: "broken", why: ["a policy names PUBLIC: messages.pub"] });
    for (const role of [API_ROLE, WORKER_ROLE]) {
      expect(lockVerdict(pub, { role })).toMatchObject({ verdict: "broken", role: { policies: "differ" } });
    }
  });

  it("a reader that is missing or not the list's, and USAGE on the readers' schema, are broken", () => {
    const f = factsOf();
    const reader = (over: Partial<ReaderFacts>): LockFacts => ({ ...f, readers: [{ ...READERS[0]!, ...over }, READERS[1]!] });
    expect(lockVerdict(reader({ volatile: "i" }), { role: API_ROLE }))
      .toMatchObject({ verdict: "broken", why: ["the reader ohmail.current_account differs: volatility"], role: { policies: "equal" } });
    expect(lockVerdict(reader({ secdef: true, src: "select null::pg_catalog.uuid" })).why)
      .toEqual(["the reader ohmail.current_account differs: body, security definer"]);
    expect(lockVerdict(reader({ owner: "someone_else", config: ["search_path=public"] })).why)
      .toEqual(["the reader ohmail.current_account differs: settings, owner"]);
    expect(lockVerdict({ ...f, readers: [READERS[0]!] }).why).toEqual(["the reader ohmail.current_key is missing"]);
    // A routine of the same name that takes an argument is not the reader.
    expect(lockVerdict({ ...f, readers: [{ ...READERS[0]!, args: 1, identity: "x integer" }, READERS[1]!] }).why)
      .toEqual(["the reader ohmail.current_account is missing"]);
    // A login's USAGE is the rule's while one of the account's views stands there; another role's never is.
    expect(lockVerdict({ ...f, schema: { ...f.schema!, usage: [API_ROLE, WORKER_ROLE] } }).why).toEqual([]);
    expect(lockVerdict({ ...f, schema: { ...f.schema!, usage: [API_ROLE, STAFF_ROLE] } }).why).toEqual(["ohmail_admin holds USAGE on the schema ohmail"]);
    expect(lockVerdict({ ...f, views: [], schema: { ...f.schema!, usage: [API_ROLE] } }).why).toEqual(["ohmail_api holds USAGE on the schema ohmail"]);
    expect(lockVerdict({ ...f, schema: null }).why).toEqual(["the readers' schema ohmail is missing"]);
    // No runtime login: no lock to read, so the readers are not judged.
    expect(lockVerdict({ ...factsOf({ logins: [], on: false }), readers: [] }).verdict).toBe("absent");
  });

  it("a listed policy naming the judged role that is altered, unrecorded, of another row of the list, or not of its shape is broken for that role; unjudged it is the census's line", () => {
    const f = factsOf();
    /** The catalog with one policy changed, read as `role`. */
    const changed = (table: string, name: string, over: object, role: string = API_ROLE): LockFacts =>
      ({ ...f, connected: { ...f.connected, name: role }, policies: f.policies.map((p) => (p.table === table && p.name === name ? { ...p, ...over } : p)) });
    const own = f.policies.find((p) => p.table === "messages" && p.name === "lock_account")!;
    const made = own.comment!.split(" ");
    const states: Array<[string, object, string]> = [
      ["altered", { using: "true" }, "its expression is not what was made"],
      ["or true", { using: "(account_id = ohmail.current_account()) OR true" }, "its expression is not what was made"],
      ["unrecorded", { comment: null }, "no record of how it was made"],
      ["another comment", { comment: "made by hand" }, "no record of how it was made"],
      ["another row of the list", { comment: `${made[0]} ${"0".repeat(64)} ${made[2]}` }, "made from another version of the list"],
      ["restrictive", { permissive: false }, "restrictive"],
    ];
    for (const [state, over, detail] of states) {
      for (const role of [API_ROLE, WORKER_ROLE]) {
        expect(lockVerdict(changed("messages", "lock_account", over, role), { role }), `${state}, ${role}`).toMatchObject({
          verdict: "broken", why: [`the policy messages.lock_account naming ${role} is not as listed: ${detail}`], role: { policies: "differ" },
        });
      }
      // Unjudged, the policies are not judged: the census names it.
      expect(lockVerdict(changed("messages", "lock_account", over)), state).toMatchObject({ verdict: "locked", census: 1, role: { policies: "not-judged" } });
    }
    // A policy that names only the worker: the API's reading is the list's, the worker's is broken.
    const wide = (role: string): LockFacts => changed("accounts", "lock_worker_wide", { using: "false" }, role);
    expect(lockVerdict(wide(API_ROLE), { role: API_ROLE })).toMatchObject({ verdict: "locked", role: { policies: "equal" } });
    expect(lockVerdict(wide(WORKER_ROLE), { role: WORKER_ROLE })).toMatchObject({
      verdict: "broken", why: ["the policy accounts.lock_worker_wide naming ohmail_worker is not as listed: its expression is not what was made"],
    });
    // Its roles widened to the API: the policy now names the API and is not as listed for either.
    const both = (role: string): LockFacts => changed("accounts", "lock_worker_wide", { roles: [API_ROLE, WORKER_ROLE] }, role);
    expect(lockVerdict(both(API_ROLE), { role: API_ROLE }).why).toEqual([
      "the policy accounts.lock_worker_wide naming ohmail_api is not as listed: to ohmail_api,ohmail_worker; its expression is not what was made",
      "the policies naming ohmail_api are not the list's",
    ]);
    // One role whose name is the two logins' names joined by a comma is not the two logins: the roles are compared as a list.
    expect(lockDrift(changed("messages", "lock_account", { roles: [`${API_ROLE},${WORKER_ROLE}`] }))).toEqual([
      "LOCK_DRIFT policies.roles messages.lock_account: to ohmail_api,ohmail_worker",
      "LOCK_DRIFT policies.altered messages.lock_account: its expression is not what was made",
    ]);
    // Untouched, every policy is as listed for both logins.
    for (const role of [API_ROLE, WORKER_ROLE]) {
      expect(lockVerdict({ ...f, connected: { ...f.connected, name: role } }, { role })).toMatchObject({ verdict: "locked", why: [], census: 0, role: { policies: "equal" } });
    }
  });
});

describe("the binder's settings are the readers' (in-process Postgres)", () => {
  let pg: PGlite;
  const A = "0f6c8a2e-3b1d-4c5e-9a7f-1b2c3d4e5f60";
  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`create schema ${READER_SCHEMA}`);
    for (const r of LOCK_READERS) await pg.exec(readerStatement(r));
  });

  /** One transaction: the binder's statement with `account` and `key`, then both readers. */
  async function readBack(account: string, key: string): Promise<{ account: string | null; key: string | null }> {
    return pg.transaction(async (tx) => {
      await tx.query(BINDER_SQL, [account, key]);
      const res = await tx.query<{ account: string | null; key: string | null }>(
        `select ${READER_SCHEMA}.current_account()::text as account, ${READER_SCHEMA}.current_key() as key`);
      return res.rows[0]!;
    });
  }

  it("what the binder writes is what the readers answer", async () => {
    expect(await readBack(A, "a-key")).toEqual({ account: A, key: "a-key" });
  });

  it("nothing named, an empty value or a malformed one all read as none", async () => {
    expect(await readBack("", "")).toEqual({ account: null, key: null });
    expect(await readBack("not-an-id", "")).toEqual({ account: null, key: null });
    const unset = await pg.query<{ account: string | null; key: string | null }>(
      `select ${READER_SCHEMA}.current_account()::text as account, ${READER_SCHEMA}.current_key() as key`);
    expect(unset.rows[0]).toEqual({ account: null, key: null });
  });

  it("the binding is local to its transaction", async () => {
    await readBack(A, "a-key");
    const after = await pg.query<{ a: string | null; k: string | null }>(
      `select pg_catalog.current_setting('${ACCOUNT_SETTING}', true) as a, pg_catalog.current_setting('${KEY_SETTING}', true) as k`);
    expect([after.rows[0]!.a ?? "", after.rows[0]!.k ?? ""]).toEqual(["", ""]);
  });
});
