import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
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
  accountColumnOf, adminReadTables, lockedTables, policiesFor, policiesNaming, policyList, serverTables, tableClass,
} from "../src/row-security/policies.js";
import { ROLE_DEADLINES } from "../src/row-security/deadlines.js";
import { lockVerdict } from "../src/row-security/check.js";
import { lockDrift, policyComment, type LockFacts, type ReaderFacts } from "../src/row-security/census.js";
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
  it("a server holds 111 tables: 82 of the account, 14 read before sign-in, 5 of the staff, 10 of operations", () => {
    const counts: Record<string, number> = {};
    for (const t of serverTables()) {
      const c = tableClass(t);
      expect(c, `${t} is in no class`).not.toBeNull();
      counts[c!] = (counts[c!] ?? 0) + 1;
    }
    expect(serverTables()).toHaveLength(111);
    expect(counts).toEqual({ account: 82, keyed: 14, staff: 5, operations: 10 });
    expect(lockedTables()).toHaveLength(101);
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

  it("the account's policy on the 94 tables that name an account, for both logins and every verb", () => {
    const own = rows.filter((r) => r.name === "lock_account");
    expect(own).toHaveLength(94);
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
    expect(worker).toHaveLength(146);
    expect(worker[0]).toBe("public.account_closures.lock_account");
    expect([...worker].sort()).toEqual(worker);
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
      schema: { owner: "ohmail_migrator", comment: o.marker ?? null, usage: [] }, readers: READERS, others: [], bindingSettings: [], code: [],
      grants: {}, connected: { name: API_ROLE, bypass: false, super: false, owns: 0, member: 0, views: 0, definers: 0 }, ...o.extra,
    };
  };
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
        .toMatchObject({ verdict: "broken", why: lines, listed: 101, role: { policies: "equal" } });
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
        .toMatchObject({ verdict: "broken", why, listed: 101, role: { policies: "equal" } });
    }
    expect(lockVerdict(withCode)).toMatchObject({ verdict: "broken", why, role: { policies: "not-judged" } });
    expect(lockDrift(withCode)).toEqual(what.map(([table, w]) => `LOCK_DRIFT tables.code ${table}: ${w}`));
  });

  it("asked to serve as a role: the connected role must be it, may not bypass, owns nothing, and its policies are the list's", () => {
    expect(lockVerdict(factsOf(), { role: API_ROLE })).toMatchObject({ verdict: "locked", role: { policies: "equal" } });
    const owner = { name: "ohmail_migrator", bypass: true, super: false, owns: 300, member: 0, views: 0, definers: 0 };
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
    expect(lockVerdict({ ...f, schema: { ...f.schema!, usage: [API_ROLE] } }).why).toEqual(["ohmail_api holds USAGE on the schema ohmail"]);
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
