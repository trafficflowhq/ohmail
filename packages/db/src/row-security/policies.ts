import { PASS_DOOR_KEY } from "../bound.js";
import { MAP_2_0, tablesOf } from "../transition/expected-counts.js";
import { STAFF_ROLE, STAFF_SELECT_GRANTS } from "../staff-grants.js";
import { HORIZONS, horizonVerbs, type Horizon } from "../horizons.js";
import {
  ACCOUNT_READER, API_ROLE, KEY_READER, PLANE_ROLE, STAFF_DOOR_KEY, WORKER_ROLE, type PolicyRole,
} from "./names.js";

/**
 * THE POLICY LIST: every table's class, and each locked table's policies by role and verb, as
 * data. The setup's lock step makes exactly these on a server whose runtime logins exist; its
 * census compares the catalog with them both ways; the roster handle's attestation compares the
 * worker's policies with {@link policiesNaming}. No hand-written policy SQL exists anywhere else.
 *
 * Classes are derived, not typed twice. `MAP_2_0` lists every table of a server with its account
 * flag; three lists here name the tables that are not the account's, and every other table must
 * carry the account. So a new table with the column gets its policy with no edit here, and a new
 * table without it and in no list turns this file's test and the census red. This is the one list
 * of a table's class: nothing else in the tree states one.
 */
/**
 * A table's class for row security.
 * - `account`: row security on and forced; one policy for the API's and the worker's logins, the
 *   row's account is the one named for the transaction.
 * - `keyed`: read before sign-in. Row security on and forced; a look-up by the token, code or
 *   address named for the transaction ({@link KEYED_TABLES}), and the account's own policy where
 *   the table carries the account.
 * - `staff`: row security on and forced; the API's login reaches them only through the staff door.
 * - `operations`: nothing of one account; grants only, no row security.
 */
export type TableClass = "account" | "keyed" | "staff" | "operations";

/** Nothing of one account: grants only, no row security (`auth_throttle` by ruling: its keys name no single key). */
export const OPERATIONS_TABLES = [
  "alert_drills", "alert_driver_gaps", "alert_pass_runs", "alert_state", "api_faults", "auth_throttle",
  "oauth_provider_config", "platform_signals", "unsubscribe_drain_state", "worker_heartbeats",
] as const;

/** The operators' own tables: the API's role reaches them only through the staff door. */
export const STAFF_TABLES = ["staff_audit_events", "staff_audit_log", "staff_role_grants", "staff_sessions", "staff_users"] as const;

/**
 * THE TABLES READ BEFORE THE ACCOUNT IS KNOWN, and the arms a look-up names: each is compared with
 * the key the transaction named. A key reads; it never locks or writes (but on the two funnel
 * tables and the rows that name no account yet). Twelve also carry the account, whose own policy
 * holds once the transaction names it.
 */
export const KEYED_TABLES: Readonly<Record<string, readonly string[]>> = {
  cal_push_channels: ["channel_id"],
  erased_bearers: ["token_hash"],
  invites: ["code_hash", "email", "consumed_by_user_id::text", "id::text"],
  login_tokens: ["token_hash"],
  mailbox_oauth_ceremonies: ["state"],
  oauth_auth_codes: ["code_hash"],
  pairing_tokens: ["token_hash"],
  recovery_codes: ["code_hash"],
  refresh_tokens: ["token_hash"],
  sessions: ["access_token_hash"],
  users: ["email"],
  waitlist: ["email", "id::text"],
  webauthn_challenges: ["challenge", "login_token_id::text"],
  webauthn_credentials: ["credential_id"],
};

/** The sign-up funnel: the API inserts a row under the address it names, and rewrites a row it reads by key. */
export const KEYED_WRITES = ["invites", "waitlist"] as const;

/** Rows that may name no account yet (an approval nobody confirmed, a ceremony before the user): made and spent by key. */
export const UNOWNED_TABLES = ["login_tokens", "webauthn_challenges"] as const;

/** What the worker schedules from and writes for the whole service: it reads every row, never writes by it. */
export const WORKER_WIDE_READ = [
  "account_closures", "account_storage", "account_storage_holds", "accounts", "cal_connections", "cal_push_channels",
  "credit_refund_obligations", "mailboxes", "pass_progress", "screener_suggest_owed",
] as const;

/** A roster names the due rows the hosted API may discover before it binds an account. */
export const PASS_ROSTERS = {
  accounts: { using: "erased_at IS NULL", account: "id", id: "id", order: "id" },
  account_storage: { using: "bytes > 0", account: "account_id", id: "account_id", order: "bytes DESC, account_id" },
  away_responders: {
    using: "enabled AND (enabled_at IS NULL OR ends_at < now() OR (starts_at IS NULL OR starts_at <= now()))",
    account: "account_id", id: "id", order: "last_considered_at, enabled_at, account_id",
  },
  drafts: {
    using: "send_at <= now() AND ((status = 'scheduled' AND (send_key IS NOT NULL OR (send_files > 0 AND send_at < now() - interval '25 hours'))) OR (send_key IS NOT NULL AND status IN ('draft', 'sending') AND send_at <= now() - interval '10 minutes'))",
    account: "account_id", id: "id",
    order: "(status <> 'scheduled'), row_number() OVER (PARTITION BY account_id, (status <> 'scheduled') ORDER BY send_at, id), send_at, id",
    recoveryOrder: "(status = 'scheduled'), row_number() OVER (PARTITION BY account_id, (status = 'scheduled') ORDER BY send_at, id), send_at, id",
  },
  mailboxes: {
    using: "smtp_max_size_bytes IS NULL AND status <> 'disabled' AND (smtp_size_probed_at IS NULL OR (smtp_size_probe_code = 'silent' AND smtp_size_probed_at <= now() - interval '30 days') OR (smtp_size_probe_code IS DISTINCT FROM 'silent' AND smtp_size_probed_at <= now() - interval '7 days'))",
    account: "account_id", id: "id", order: "random()",
  },
  outbound_sends: {
    using: "draft_id IS NOT NULL AND ((status = 'pending' AND created_at < now() - interval '10 minutes') OR (status = 'unverified' AND resolved_by IS NULL AND created_at > now() - interval '25 hours'))",
    account: "account_id", id: "id",
    order: "row_number() OVER (PARTITION BY account_id ORDER BY created_at, id), created_at, id",
  },
  outbound_sent_copies: {
    using: "seq = 0 AND (next_attempt_at <= now() OR (files_until IS NOT NULL AND (files_next_attempt_at <= now() OR (files_until <= now() AND (files_next_attempt_at IS NULL OR files_next_attempt_at > now() + interval '5 minutes')))) OR (created_at < now() - interval '7 days' AND next_attempt_at > now() + interval '5 minutes'))",
    account: "account_id", id: "send_id", order: "least(next_attempt_at, files_next_attempt_at), created_at, send_id",
  },
  sessions: {
    using: "device_id IS NULL AND scope = 'full' AND revoked_at IS NULL AND refresh_expires_at < now() AND refresh_expires_at - last_seen_at < interval '100 days'",
    account: "account_id", id: "id", order: "id",
  },
  users: {
    using: "EXISTS (SELECT 1 FROM public.auth_throttle n WHERE n.failures = 1 AND n.key = 'notice:factor:' || users.id::text)",
    account: "account_id", id: "id", order: "id",
  },
} as const;

export type PassRosterTable = keyof typeof PASS_ROSTERS;

/** The billing plane's five objects of `public`: four reads and one append. */
export const PLANE_READS = ["account_storage", "accounts", "mailboxes", "staff_users"] as const;
export const PLANE_APPENDS = ["audit_log"] as const;

/** The owed security notices the worker's drain reads unbound: rows of this key family. */
export const NOTICE_FAMILY = "notice:%";

/** The table whose own id is the account. */
export const ACCOUNT_BY_ID = "accounts";

const OPERATIONS = new Set<string>(OPERATIONS_TABLES);
const STAFF = new Set<string>(STAFF_TABLES);

/**
 * The class of `table`. `carriesAccount` is whether it has an `account_id` column: `MAP_2_0`'s
 * flag by default, the catalog's where the census asks. `null` is a table in no class.
 */
export function tableClass(table: string, carriesAccount: boolean = MAP_2_0[table]?.account ?? false): TableClass | null {
  if (OPERATIONS.has(table)) return "operations";
  if (STAFF.has(table)) return "staff";
  if (table in KEYED_TABLES) return "keyed";
  if (table === ACCOUNT_BY_ID || carriesAccount) return "account";
  return null;
}

/** The column a locked table names its account by: `id` on `accounts`, `account_id` where it carries one, else none. */
export function accountColumnOf(table: string, carriesAccount: boolean = MAP_2_0[table]?.account ?? false): "id" | "account_id" | null {
  if (table === ACCOUNT_BY_ID) return "id";
  const cls = tableClass(table, carriesAccount);
  return cls === "account" || (cls === "keyed" && carriesAccount) ? "account_id" : null;
}

/** Every table a server holds (the Cloud's store), by name. */
export function serverTables(): string[] {
  return tablesOf("cloud");
}

/** The tables under row security: every server table but the operations ones. */
export function lockedTables(): string[] {
  return serverTables().filter((t) => tableClass(t) !== "operations");
}

/**
 * The staff role's read set: the locked tables among the `public` relations it holds column grants
 * on (`staff-grants.ts`), derived and never typed twice.
 */
export function adminReadTables(): string[] {
  return Object.keys(STAFF_SELECT_GRANTS)
    .filter((k) => k.startsWith("public."))
    .map((k) => k.slice("public.".length))
    .filter((t) => { const c = tableClass(t); return c !== null && c !== "operations"; })
    .sort();
}

export type PolicyVerb = "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";

/** One policy as the lock makes it. `using`/`check` are SQL over the row's own columns. */
export interface PolicyRow {
  readonly table: string;
  readonly name: string;
  readonly verb: PolicyVerb;
  readonly roles: readonly PolicyRole[];
  readonly using: string | null;
  readonly check: string | null;
  readonly why: string;
}

const both: readonly PolicyRole[] = [API_ROLE, WORKER_ROLE];
const keyArms = (table: string): string => (KEYED_TABLES[table] ?? []).map((arm) => `${arm} = ${KEY_READER}`).join(" OR ");
const horizonUsing = (x: Horizon): string => (x.onlyUnbound ? `${ACCOUNT_READER} IS NULL AND (${x.using})` : x.using);

/** The policies of one table of class `cls`. `carriesAccount` as {@link tableClass}. */
export function policiesOfTable(table: string, carriesAccount: boolean = MAP_2_0[table]?.account ?? false): PolicyRow[] {
  const cls = tableClass(table, carriesAccount);
  if (cls === null || cls === "operations") return [];
  const out: PolicyRow[] = [];
  const add = (name: string, verb: PolicyVerb, roles: readonly PolicyRole[], using: string | null, check: string | null, why: string): void => {
    out.push({ table, name, verb, roles, using, check, why });
  };
  const column = accountColumnOf(table, carriesAccount);
  if (column !== null) {
    const own = `${column} = ${ACCOUNT_READER}`;
    add("lock_account", "ALL", both, own, own, "a row is the named account's alone");
  }
  if (cls === "keyed") {
    const arms = keyArms(table);
    add("lock_key_read", "SELECT", [API_ROLE], arms, null, "a look-up by the key named before the account is known");
    if ((KEYED_WRITES as readonly string[]).includes(table)) {
      add("lock_key_insert", "INSERT", [API_ROLE], null, `email = ${KEY_READER}`, "a row under the address the transaction named");
      add("lock_key_update", "UPDATE", [API_ROLE], arms, "true", "a row read by key, rewritten (the erasure's pseudonym included)");
    }
    if ((UNOWNED_TABLES as readonly string[]).includes(table)) {
      const unowned = `account_id IS NULL AND (${arms})`;
      add("lock_unowned_insert", "INSERT", [API_ROLE], null, unowned, "a row that names no account yet, made by its key");
      add("lock_unowned_update", "UPDATE", [API_ROLE], unowned, unowned, "a row that names no account yet, spent by its key");
    }
  }
  if (cls === "staff") {
    const door = `${ACCOUNT_READER} IS NULL AND ${KEY_READER} = '${STAFF_DOOR_KEY}'`;
    add("lock_staff_door", "ALL", [API_ROLE], door, door, "the operators' rows, only through the named door and with no account bound");
  }
  if ((WORKER_WIDE_READ as readonly string[]).includes(table)) {
    add("lock_worker_wide", "SELECT", [WORKER_ROLE], "true", null, "the worker schedules from every row");
  }
  const roster = PASS_ROSTERS[table as PassRosterTable];
  if (roster !== undefined) {
    const door = `${ACCOUNT_READER} IS NULL AND ${KEY_READER} = '${PASS_DOOR_KEY}'`;
    add("lock_pass_roster", "SELECT", [API_ROLE], `${door} AND (${roster.using})`, null, "a system pass discovers due work before binding its account");
  }
  const horizon = HORIZONS.find((x) => x.table === table);
  if (horizon !== undefined) {
    const using = horizonUsing(horizon);
    if (horizon.runs === "bound") {
      add("lock_worker_roster", "SELECT", [WORKER_ROLE], using, null, "the roster of accounts holding a row past its horizon");
    } else {
      const verbs = horizonVerbs(horizon);
      add("lock_worker_past_read", "SELECT", [WORKER_ROLE], using, null, "a row past its prune's horizon");
      add("lock_worker_past_delete", "DELETE", [WORKER_ROLE], using, null, "a row past its prune's horizon");
      if (verbs.includes("UPDATE")) add("lock_worker_past_lock", "UPDATE", [WORKER_ROLE], using, "false", "the prune's lock on its batch, and no write");
    }
  }
  if (table === "account_counters") {
    add("lock_worker_notices_read", "SELECT", [WORKER_ROLE], `key LIKE '${NOTICE_FAMILY}'`, null, "the owed security notices the drain sends");
  }
  if (adminReadTables().includes(table)) {
    add("lock_admin_read", "SELECT", [STAFF_ROLE], "true", null, "the staff role reads every row of what its column grants name");
  }
  if ((PLANE_READS as readonly string[]).includes(table)) {
    add("lock_plane_read", "SELECT", [PLANE_ROLE], "true", null, "the billing plane reads every row of what its grants name");
  }
  if ((PLANE_APPENDS as readonly string[]).includes(table)) {
    add("lock_plane_insert", "INSERT", [PLANE_ROLE], null, "true", "the billing plane appends its own audit rows");
  }
  return out;
}

/** Every policy of the lock, on every locked table of a server, in table then name order. */
export function policyList(): PolicyRow[] {
  return lockedTables().flatMap((t) => policiesOfTable(t)).sort(byTableThenName);
}

/** The rows whose every role is in `present`: a policy for a role that does not exist is not made. */
export function policiesFor(rows: readonly PolicyRow[], present: ReadonlySet<string>): PolicyRow[] {
  return rows.filter((r) => r.roles.every((role) => present.has(role)));
}

/** The policies naming `role`, as `public.<table>.<policy>`, sorted: the roster attestation's list. */
export function policiesNaming(role: string, rows: readonly PolicyRow[] = policyList()): string[] {
  return rows.filter((r) => r.roles.includes(role as PolicyRole)).map((r) => `public.${r.table}.${r.name}`).sort();
}

export function byTableThenName(a: { table: string; name: string }, b: { table: string; name: string }): number {
  return a.table === b.table ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : (a.table < b.table ? -1 : 1);
}
