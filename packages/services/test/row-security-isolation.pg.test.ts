import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { bindDb, rebindTx, type BindTo } from "@trafficflow/db";
import { brandDialect } from "@trafficflow/db/dialect";
import {
  makeOwnedDb, schema, accountColumnOf, lockedTables, policyList, readLock, WORKER_WIDE_READ, STAFF_DOOR_KEY, STAFF_TABLES, type OwnedDb,
  pruneSignInRecords, pruneAuthEvents, pruneConnectAttempts, pruneAuditLog, pruneErasedBearers, pruneErasedNotices,
  sweepExpiredStagingFor, horizonOf, SIGN_IN_RECORD_RETENTION_MS, AUTH_EVENTS_RETENTION_MS, CONNECT_ATTEMPTS_RETENTION_MS,
  AUDIT_LOG_RETENTION_MS, WEBAUTHN_CHALLENGE_RETENTION_MS, OAUTH_CEREMONY_RETENTION_MS, DEVICE_CEREMONY_RETENTION_MS,
  ERASED_NOTICE_KEEP_YEARS, ERASED_REFRESH_KEEP_DAYS, AUTH_THROTTLE_RETENTION_MS, resyncMailbox,
} from "@trafficflow/db/cloud";
import { pruneIdempotencyKeys, pruneSendFingerprints, SEND_FINGERPRINT_RETENTION_MS } from "@trafficflow/db";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATOR_ROLE, PG_MAJORS, ownServersAvailable, ruleVerbs, startLockGround, type LockGround,
} from "@trafficflow/db/testing";
import { UNWRITTEN_TABLES } from "../../db/test/_unwritten-tables.js";
import { reapStaleWebSessions } from "../src/auth/session-reaper.js";
import { seedFullAccount, type Db, type SeededAccount } from "./helpers/erasure-fixture.js";

/**
 * THE LOCK HOLDS ACROSS ACCOUNTS AT THE DATABASE: the proof on a real Postgres, as the runtime
 * logins, through the real binder. The roles are made by their real script on a server this file
 * owns whole, the lock by the setup, and two accounts are seeded with a row in every table that
 * names an account (the erasure's one seed, and the tables nothing writes yet planted here).
 *
 * As the API's role bound to A, every such table answers exactly A's rows; B's rows can be neither
 * changed nor deleted; nothing is written under B's id, and A's row cannot be moved to B; with no
 * account named, every locked table answers nothing. The migrator, which bypasses, reads both: the
 * control. The worker reads its wide tables whole and no letter. A key reads its own row and locks
 * nothing; the staff tables open only through their door. The plans of a list read and a body read
 * keep the account's index.
 */
const FILE = "packages/services/test/row-security-isolation.pg.test.ts";
const OWN = ownServersAvailable(FILE);
const CASE_MS = 120_000;

type Rows = Array<Record<string, unknown>>;
type Exec = { execute(q: unknown): Promise<unknown> };
type Txable = Exec & { transaction<T>(fn: (tx: Exec & object) => Promise<T>): Promise<T> };
const rows = (r: unknown): Rows => r as Rows;
const codeOf = (e: unknown): string => String((e as { code?: unknown }).code ?? (e as Error).message);
const q = (name: string): string => `public."${name}"`;

/**
 * WHAT REFUSED A STATEMENT. A missing grant and a policy both answer SQLSTATE 42501, and they are
 * different errors: a login without the grant is refused before the statement runs ("permission
 * denied for table"); a policy refuses a row the statement would write ("new row violates
 * row-level security policy"); a policy that admits no row raises nothing (the statement changes
 * 0 rows). Anything else is named whole. Telling them apart needs no change to the roles' script;
 * a role of the test's own holding the grant would be held by no policy unless it were a member
 * of a login, and the roles' script refuses (and its apply revokes) any member of a login.
 */
const NOT_GRANTED = "not granted: held by the roles' census";
const BY_POLICY = "refused by the policy";
function refusalOf(e: unknown): string {
  const code = String((e as { code?: unknown }).code ?? "");
  const words = String((e as { message?: unknown }).message ?? e);
  if (code === "42501" && words.startsWith("permission denied for table ")) return NOT_GRANTED;
  if (code === "42501" && words.includes("violates row-level security policy")) return BY_POLICY;
  return `${code}: ${words}`;
}

/** One insert into each staff table, in the shape its writer in the product writes it. */
const STAFF_INSERTS = (staffId: string): Record<string, string> => ({
  staff_users: "insert into staff_users (email, password_hash) values ('intruder@example.test', 'x')",
  staff_sessions: `insert into staff_sessions (staff_user_id, token_hash, expires_at, last_twofa_at) values ('${staffId}', 'intruder', now() + interval '1 day', now())`,
  staff_role_grants: `insert into staff_role_grants (staff_user_id, role, granted_at) values ('${staffId}', 'support', now())`,
  staff_audit_log: `insert into staff_audit_log (staff_user_id, action, actor, note) values ('${staffId}', 'staff.totp.reset', 'intruder', 'x')`,
  staff_audit_events: `insert into staff_audit_events (request_id, staff_user_id, actor_label, roles, action, outcome)
    values (gen_random_uuid(), '${staffId}', 'intruder', '{owner}', 'write.mailbox.resync', 'ok')`,
});

/**
 * The rows nothing writes yet, planted for one account so that no locked table is empty for it. The
 * calendar's connection and calendar they hang off are the erasure's seed's: a table that gained a
 * writer is the seed's to plant, and leaves this plant.
 */
async function plantUnwritten(m: postgres.Sql, a: SeededAccount): Promise<void> {
  const u = a.accountId.slice(0, 8);
  const [conn] = await m.unsafe(`select id from cal_connections where account_id = $1`, [a.accountId]);
  const [cal] = await m.unsafe(`select id from cal_calendars where account_id = $1`, [a.accountId]);
  await m.unsafe(`insert into cal_credentials (account_id, connection_id, kind, secret_enc, key_version) values ($1, $2, 'oauth', 'enc:x', 1)`, [a.accountId, conn!.id]);
  await m.unsafe(`insert into cal_writes (account_id, calendar_id, op, payload, idempotency_key) values ($1, $2, 'create', '{}', $3)`, [a.accountId, cal!.id, `k-${u}`]);
  await m.unsafe(`insert into cal_links (account_id, message_id, mailbox_id, uid, kind) values ($1, $2, $3, $4, 'invite')`, [a.accountId, a.messageId, a.mailboxId, `uid-${u}`]);
  await m.unsafe(`insert into cal_push_channels (account_id, connection_id, provider, channel_id, token_hash, expires_at)
    values ($1, $2, 'google', $3, $4, now() + interval '1 day')`, [a.accountId, conn!.id, `ch-${u}`, `th-${u}`]);
  await m.unsafe(`insert into account_closures (account_id, request_id) values ($1, $2)`, [a.accountId, `req-${u}`]);
  // Written only by an erasure, which the erasure's seed does not run: one live hash per account.
  await m.unsafe(`insert into erased_bearers (token_hash, account_id, expires_at) values ($1, $2, now() + interval '1 day')`, [`eb-${u}`, a.accountId]);
}

/** The instant `ms` before the database's clock, as SQL. */
const before = (ms: number): string => `now() - interval '${ms} milliseconds'`;
const HOUR = "interval '1 hour'";
type Side = "past" | "inside";
/** An hour past the horizon `ms` back, or an hour inside it. */
const edge = (ms: number, side: Side): string => `${before(ms)} ${side === "past" ? "-" : "+"} ${HOUR}`;
/** An hour before the database's clock, or an hour after it: either side of a horizon of `now()`. */
const nowEdge = (side: Side): string => `now() ${side === "past" ? "-" : "+"} ${HOUR}`;

/**
 * EACH PRUNED TABLE'S HORIZON AS THE PRODUCT DEFINES IT: a row past it, in SQL over the row's own
 * columns, written from the product's exported constants and never from the policy list, so a
 * horizon the list widens or narrows reads differently here. The session reaper keeps its window
 * to itself; its arm is what the reaper's own run takes (`reaperTakes`).
 */
const PAST: Record<string, string> = {
  login_tokens: `expires_at < ${before(SIGN_IN_RECORD_RETENTION_MS)}`,
  oauth_auth_codes: `expires_at < ${before(SIGN_IN_RECORD_RETENTION_MS)}`,
  pairing_tokens: `expires_at < ${before(SIGN_IN_RECORD_RETENTION_MS)}`,
  invites: `consumed_at is null and expires_at < ${before(SIGN_IN_RECORD_RETENTION_MS)}`,
  staff_sessions: `expires_at < ${before(SIGN_IN_RECORD_RETENTION_MS)}`,
  webauthn_challenges: `expires_at < ${before(WEBAUTHN_CHALLENGE_RETENTION_MS)}`,
  mailbox_oauth_ceremonies: `created_at < ${before(OAUTH_CEREMONY_RETENTION_MS)}`,
  mailbox_oauth_device_ceremonies: `created_at < ${before(DEVICE_CEREMONY_RETENTION_MS)}`,
  auth_events: `at < ${before(AUTH_EVENTS_RETENTION_MS)}`,
  connect_attempts: `at < ${before(CONNECT_ATTEMPTS_RETENTION_MS)}`,
  audit_log: `created_at < ${before(AUDIT_LOG_RETENTION_MS)}`,
  idempotency_keys: "expires_at <= now()",
  erased_bearers: "expires_at <= now()",
  attachment_staging: "expires_at <= now()",
  outbound_send_fingerprints: `created_at < ${before(SEND_FINGERPRINT_RETENTION_MS)}`,
  devices: `ip <> '' and last_seen_at < ${before(SIGN_IN_RECORD_RETENTION_MS)}`,
  account_counters: `window_started_at < ${before(AUTH_THROTTLE_RETENTION_MS)} and (locked_until is null or locked_until <= now())`,
  account_lifecycle_notices: `account_id in (select id from public.accounts where erased_at <= now() - make_interval(years => ${ERASED_NOTICE_KEEP_YEARS}))`,
  sessions: `revoked_at < ${before(SIGN_IN_RECORD_RETENTION_MS)} `
    + `or (revoked_at is null and refresh_expires_at + make_interval(days => ${ERASED_REFRESH_KEEP_DAYS}) <= now())`,
};
/** The three tables the worker reads only as a roster: it binds each account it names and prunes there. */
const ROSTER = new Set(["sessions", "devices", "outbound_send_fingerprints"]);

/**
 * Each table's planted rows by their `ctid`: `past`, an hour past its horizon; `inside`, rows the
 * product does not call past (an hour inside it, and on `devices` one whose address is blank).
 */
type Edges = Record<string, { past: string[]; inside: string[] }>;

/**
 * AT THE EDGE OF EVERY HORIZON, for one account: a row an hour inside it and one an hour past it,
 * placed by the product's constants, planted as the migrator. The sessions' three arms each get
 * their pair: revoked, never revoked past the erasure's keep (a paired device, which the reaper
 * never takes), and the reaper's window, placed by the list's restatement of it
 * (`sessions:cookie`, which the reaper's own run then holds).
 */
async function plantEdges(m: postgres.Sql, a: SeededAccount, staffUserId: string, edges: Edges): Promise<void> {
  const u = a.accountId.slice(0, 8);
  const cookie = horizonOf("sessions")!.constants.find((c) => c.name === "COOKIE_WINDOW_UNDER_MS")!.value;
  const plant = async (table: string, side: Side, text: string, params: unknown[] = []): Promise<void> => {
    const got = await m.unsafe(`${text} returning ctid::text as c`, params as never[]);
    (edges[table] ??= { past: [], inside: [] })[side].push(...got.map((r) => String(r.c)));
  };
  const S = SIGN_IN_RECORD_RETENTION_MS;
  for (const side of ["past", "inside"] as const) {
    const k = `edge-${side}-${u}`;
    const sign = side === "past" ? "-" : "+";
    await plant("login_tokens", side, `insert into login_tokens (user_id, account_id, token_hash, expires_at) values ($1, $2, $3, ${edge(S, side)})`, [a.userId, a.accountId, k]);
    await plant("oauth_auth_codes", side, `insert into oauth_auth_codes (user_id, account_id, client_id, code_hash, code_challenge, redirect_uri, expires_at)
      values ($1, $2, 'desktop', $3, 'cc', 'ohmail://cb', ${edge(S, side)})`, [a.userId, a.accountId, k]);
    await plant("pairing_tokens", side, `insert into pairing_tokens (created_by_user_id, account_id, "grant", token_hash, label, expires_at)
      values ($1, $2, 'device-pair', $3, $3, ${edge(S, side)})`, [a.userId, a.accountId, k]);
    await plant("invites", side, `insert into invites (code_hash, email, issued_by, expires_at) values ($1, $2, 'operator', ${edge(S, side)})`, [k, `${k}@example.test`]);
    await plant("staff_sessions", side, `insert into staff_sessions (staff_user_id, token_hash, expires_at, last_twofa_at) values ($1, $2, ${edge(S, side)}, now())`, [staffUserId, k]);
    await plant("webauthn_challenges", side, `insert into webauthn_challenges (user_id, account_id, challenge, type, rp_id, origin, expires_at)
      values ($1, $2, $3, 'registration', 'app.ohmail.app', 'https://app.ohmail.app', ${edge(WEBAUTHN_CHALLENGE_RETENTION_MS, side)})`, [a.userId, a.accountId, k]);
    await plant("mailbox_oauth_ceremonies", side, `insert into mailbox_oauth_ceremonies (account_id, state, provider, code_verifier_enc, code_verifier_key_version, return_to, created_at)
      values ($1, $2, 'microsoft', 'enc:v', 1, '/mailbox', ${edge(OAUTH_CEREMONY_RETENTION_MS, side)})`, [a.accountId, k]);
    await plant("mailbox_oauth_device_ceremonies", side, `insert into mailbox_oauth_device_ceremonies (account_id, state, provider, device_code_enc, device_code_key_version,
      user_code, verification_uri, poll_interval_ms, grant_expires_at, created_at)
      values ($1, $2, 'microsoft', 'enc:d', 1, 'EDGE-CODE', 'https://microsoft.com/devicelogin', 5000, now(), ${edge(DEVICE_CEREMONY_RETENTION_MS, side)})`, [a.accountId, k]);
    await plant("auth_events", side, `insert into auth_events (account_id, user_id, event, device, at) values ($1, $2, 'login', $3, ${edge(AUTH_EVENTS_RETENTION_MS, side)})`, [a.accountId, a.userId, k]);
    await plant("connect_attempts", side, `insert into connect_attempts (account_id, at, door, preset, outcome, reason, transport)
      values ($1, ${edge(CONNECT_ATTEMPTS_RETENTION_MS, side)}, 'connect', 'gmail', 'refused', 'auth', 'imap')`, [a.accountId]);
    await plant("audit_log", side, `insert into audit_log (account_id, action, created_at) values ($1, $2, ${edge(AUDIT_LOG_RETENTION_MS, side)})`, [a.accountId, k]);
    await plant("idempotency_keys", side, `insert into idempotency_keys (account_id, key, request_hash, response_status, response_json, expires_at)
      values ($1, $2, 'h', 200, '{}', ${nowEdge(side)})`, [a.accountId, k]);
    await plant("erased_bearers", side, `insert into erased_bearers (token_hash, account_id, expires_at) values ($1, $2, ${nowEdge(side)})`, [k, a.accountId]);
    await plant("attachment_staging", side, `insert into attachment_staging (id, account_id, object_path, filename, content_type, size_bytes, expires_at)
      values (gen_random_uuid(), $1, $2, $3, 'text/plain', 1, ${nowEdge(side)})`, [a.accountId, `staging/${k}`, k]);
    await plant("devices", side, `insert into devices (account_id, user_id, kind, label, ip, last_seen_at) values ($1, $2, 'macos', $3, '192.0.2.9', ${edge(S, side)})`, [a.accountId, a.userId, k]);
    // The claim of a send that went: nothing guards it.
    await plant("outbound_send_fingerprints", side, `with sent as (insert into outbound_sends (account_id, draft_id, idempotency_key, minted_message_id, status)
        values ($1, (select id from drafts where account_id = $1 limit 1), $3, $4, 'sent') returning id)
      insert into outbound_send_fingerprints (account_id, mailbox_id, fingerprint, send_id, created_at)
      select $1::uuid, $2::uuid, $5, id, ${edge(SEND_FINGERPRINT_RETENTION_MS, side)} from sent`,
    [a.accountId, a.mailboxId, k, `<${k}@x>`, (side === "past" ? "e" : "f").repeat(64)]);
    await plant("account_counters", side, `insert into account_counters (account_id, key, failures, window_started_at) values ($1, $2, 1, ${edge(AUTH_THROTTLE_RETENTION_MS, side)})`,
      [a.accountId, `factor-day:${k}`]);
    // Past its window, held by a lock that ended an hour ago, or that ends an hour from now.
    await plant("account_counters", side, `insert into account_counters (account_id, key, failures, window_started_at, locked_until)
      values ($1, $2, 1, ${edge(AUTH_THROTTLE_RETENTION_MS, "past")}, ${nowEdge(side)})`, [a.accountId, `user:${k}`]);
    await plant("account_lifecycle_notices", side, `with gone as (insert into accounts (name, erased_at)
        values ('', now() - make_interval(years => ${ERASED_NOTICE_KEEP_YEARS}) ${sign} ${HOUR}) returning id)
      insert into account_lifecycle_notices (account_id, kind, anchor) select id, 'closed', now() from gone`);
    await plant("sessions", side, `insert into sessions (account_id, user_id, family_id, access_expires_at, refresh_expires_at, revoked_at, scope)
      values ($1, $2, gen_random_uuid(), now(), now() + interval '90 days', ${edge(S, side)}, 'full')`, [a.accountId, a.userId]);
    await plant("sessions", side, `insert into sessions (account_id, user_id, device_id, family_id, access_expires_at, refresh_expires_at, scope)
      values ($1, $2, $3, gen_random_uuid(), now(), now() - make_interval(days => ${ERASED_REFRESH_KEEP_DAYS}) ${sign} ${HOUR}, 'full')`, [a.accountId, a.userId, a.deviceId]);
    // Expired a day ago, its refresh window an hour under the reaper's, or an hour over it.
    await plant("sessions:cookie", side, `insert into sessions (account_id, user_id, family_id, access_expires_at, refresh_expires_at, last_seen_at, scope)
      values ($1, $2, gen_random_uuid(), now(), now() - interval '1 day',
              now() - interval '1 day' - interval '${cookie} milliseconds' ${side === "past" ? "+" : "-"} ${HOUR}, 'full')`, [a.accountId, a.userId]);
  }
  // Each word of the sessions' horizon held by a row it alone keeps out: none is past for the
  // product, and the reaper takes none of them.
  // A live browser session: its refresh not yet expired (arm 3's `refresh_expires_at < now()`).
  await plant("sessions", "inside", `insert into sessions (account_id, user_id, family_id, access_expires_at, refresh_expires_at, scope)
    values ($1, $2, gen_random_uuid(), now() + ${HOUR}, now() + interval '30 days', 'full')`, [a.accountId, a.userId]);
  // An enrollment session, expired a day ago, its window under the reaper's (arm 3's `scope = 'full'`).
  await plant("sessions", "inside", `insert into sessions (account_id, user_id, family_id, access_expires_at, refresh_expires_at, last_seen_at, scope)
    values ($1, $2, gen_random_uuid(), now(), now() - interval '1 day', now() - interval '2 days', 'enrollment')`, [a.accountId, a.userId]);
  // A browser session revoked an hour ago, expired a day ago, its window under the reaper's (arm 3's `revoked_at IS NULL`).
  await plant("sessions", "inside", `insert into sessions (account_id, user_id, family_id, access_expires_at, refresh_expires_at, last_seen_at, revoked_at, scope)
    values ($1, $2, gen_random_uuid(), now(), now() - interval '1 day', now() - interval '2 days', now() - ${HOUR}, 'full')`, [a.accountId, a.userId]);
  // A paired device's session revoked an hour ago, its refresh an hour past the erasure's keep (arm 2's `revoked_at IS NULL`).
  await plant("sessions", "inside", `insert into sessions (account_id, user_id, device_id, family_id, access_expires_at, refresh_expires_at, revoked_at, scope)
    values ($1, $2, $3, gen_random_uuid(), now(), now() - make_interval(days => ${ERASED_REFRESH_KEEP_DAYS}) - ${HOUR}, now() - ${HOUR}, 'full')`,
  [a.accountId, a.userId, a.deviceId]);
  // A silent device whose address the prune already blanked: an hour past its date, and still
  // nothing the product calls past (its prune blanks an address, and this one has none).
  await plant("devices", "inside", `insert into devices (account_id, user_id, kind, label, ip, last_seen_at) values ($1, $2, 'macos', $3, '', ${edge(S, "past")})`,
    [a.accountId, a.userId, `blank-${u}`]);
  // An owed notice, inside every horizon: the drain reads it by its family alone.
  await m.unsafe(`insert into account_counters (account_id, key, failures) values ($1, $2, 1)`, [a.accountId, `notice:factor:${a.userId}`]);
}

for (const major of PG_MAJORS) {
  describe.skipIf(!OWN)(`the lock across two full accounts on Postgres ${major}`, () => {
    let g: LockGround;
    let A: SeededAccount;
    let B: SeededAccount;
    let mig: postgres.Sql;
    let api: OwnedDb;
    let worker: OwnedDb;
    /** Every locked table that names an account, and the column it names it by. */
    let owned: Array<{ table: string; col: "id" | "account_id" }>;
    /** The rows planted at the edge of each horizon, both accounts'. */
    const edges: Edges = {};
    /** The operator the ground's staff rows belong to. */
    let staffId: string;

    beforeAll(async () => {
      g = await startLockGround(major, `proof_${major}`, "ground");
      await g.setup("ground");
      await g.makeRoles("ground");
      await g.setup("ground", MIGRATOR_ROLE, { lock: "apply" });
      mig = g.connectAs("ground", MIGRATOR_ROLE);
      const db = brandDialect(drizzle(mig, { schema }), "pg") as unknown as Db;
      A = await seedFullAccount(db, "Account A");
      B = await seedFullAccount(db, "Account B");
      for (const a of [A, B]) await plantUnwritten(mig, a);
      const [staff] = await mig.unsafe(`insert into staff_users (email, password_hash) values ('operator@example.test', 'x') returning id`);
      staffId = String(staff!.id);
      for (const a of [A, B]) await plantEdges(mig, a, staffId, edges);
      // The three staff tables nothing above fills, a row each, as the product writes them. The
      // operator's mailbox release writes its staff event through the product's own writer; a role
      // grant and the second-factor reset's trail are written inline by the API's staff routes
      // (`admin-staff.ts`), with no writer of their own, so in the shape those routes write.
      await resyncMailbox(db as never, {
        mailboxId: A.mailboxId, staffId, note: "the ground's operator", now: new Date(),
        staffEvent: (o) => ({ requestId: randomUUID(), staffUserId: staffId, actorLabel: "operator@example.test", roles: ["owner"],
          action: "write.mailbox.resync", outcome: o.outcome, targetAccountId: o.accountId, targetMailboxId: A.mailboxId, detail: { changed: o.changed } }),
      });
      await mig.unsafe(`insert into staff_role_grants (staff_user_id, role, granted_by, granted_at) values ($1, 'owner', null, now())`, [staffId]);
      await mig.unsafe(`insert into staff_audit_log (staff_user_id, action, actor, note, created_at)
        values ($1, 'staff.totp.reset', 'operator', 'a lost authenticator', now())`, [staffId]);
      owned = policyList().filter((r) => r.name === "lock_account").map((r) => ({ table: r.table, col: accountColumnOf(r.table)! }));
      api = makeOwnedDb(g.urlAs("ground", "ohmail_api"), { role: "api" });
      worker = makeOwnedDb(g.urlAs("ground", "ohmail_worker"), { role: "worker" });
    }, MIGRATED_DB_SETUP_BUDGET_MS);

    afterAll(async () => {
      await api?.close();
      await worker?.close();
      await mig?.end({ timeout: 5 });
      g?.stop();
    });

    /** The migrator's count of `table`'s rows naming `account`: the control, past the lock. */
    const ownCount = async (table: string, col: string, account: string): Promise<number> =>
      Number((await mig.unsafe(`select count(*)::int as n from ${q(table)} where "${col}" = $1`, [account]))[0]!.n);
    const total = async (table: string): Promise<number> => Number((await mig.unsafe(`select count(*)::int as n from ${q(table)}`))[0]!.n);
    const countOn = async (db: Exec, table: string): Promise<number> =>
      Number(rows(await db.execute(sql.raw(`select count(*)::int as n from ${q(table)}`)))[0]!.n);
    /** A digest of every row of `table` naming `account`, read by the migrator. */
    const digest = async (table: string, col: string, account: string): Promise<string> =>
      String((await mig.unsafe(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as d from ${q(table)} t where "${col}" = $1`, [account]))[0]!.d);

    it("every table that names an account holds rows of both accounts, before anything is read", async () => {
      expect(owned).toHaveLength(94);
      const empty: string[] = [];
      for (const { table, col } of owned) {
        for (const [who, a] of [["A", A], ["B", B]] as const) if (await ownCount(table, col, a.accountId) === 0) empty.push(`${table} (${who})`);
      }
      // And every staff table: a sweep over an empty table says nothing of its policy.
      for (const table of STAFF_TABLES) if (await total(table) === 0) empty.push(`${table} (the operators')`);
      expect(empty, "a table with no planted row proves nothing: seed it").toEqual([]);
    }, CASE_MS);

    it("bound to A through the real binder, every table answers exactly A's rows", async () => {
      const a = bindDb(api.db, { account: A.accountId }) as unknown as Exec;
      const wrong: string[] = [];
      for (const { table, col } of owned) {
        const seen = await countOn(a, table);
        const mine = await ownCount(table, col, A.accountId);
        if (seen !== mine) wrong.push(`${table}: ${seen} rows, A holds ${mine}`);
      }
      expect(wrong).toEqual([]);
    }, CASE_MS);

    it("bound to A, an update or a delete of B's rows changes nothing", async () => {
      const a = bindDb(api.db, { account: A.accountId }) as unknown as Exec;
      const changed: string[] = [];
      for (const { table, col } of owned) {
        const before = await digest(table, col, B.accountId);
        const del = await a.execute(sql.raw(`delete from ${q(table)} where "${col}" = '${B.accountId}'`)) as { count?: number };
        const upd = await a.execute(sql.raw(`update ${q(table)} set "${col}" = "${col}" where "${col}" = '${B.accountId}'`)) as { count?: number };
        if ((del.count ?? 0) !== 0 || (upd.count ?? 0) !== 0 || before !== await digest(table, col, B.accountId)) changed.push(table);
      }
      expect(changed).toEqual([]);
    }, CASE_MS);

    it("bound to A, a row under B's id is refused, and so is moving A's own row to B", async () => {
      const a = bindDb(api.db, { account: A.accountId }) as unknown as Exec;
      const columns = async (table: string): Promise<string[]> => (await mig.unsafe(`select a.attname from pg_attribute a
        where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' order by a.attnum`, [q(table)])).map((r) => String(r.attname));
      const admitted: string[] = [];
      for (const { table, col } of owned) {
        const cols = await columns(table);
        const list = cols.map((c) => `"${c}"`).join(", ");
        const copy = cols.map((c) => (c === col ? `'${B.accountId}'::uuid` : `t."${c}"`)).join(", ");
        const insert = await a.execute(sql.raw(`insert into ${q(table)} (${list}) overriding system value
          select ${copy} from ${q(table)} t where t."${col}" = '${A.accountId}' limit 1`)).then(() => "written", codeOf);
        const move = await a.execute(sql.raw(`update ${q(table)} set "${col}" = '${B.accountId}' where "${col}" = '${A.accountId}'`)).then(() => "moved", codeOf);
        if (insert !== "42501" || move !== "42501") admitted.push(`${table}: insert ${insert}, move ${move}`);
      }
      expect(admitted).toEqual([]);
    }, CASE_MS);

    /** The verbs `role` holds on each table of `public`, as the catalog says, read by the migrator. */
    async function grantsOf(role: string): Promise<Map<string, Set<string>>> {
      const got = await mig.unsafe(`select c.relname::text as t, array_remove(array[
          case when has_table_privilege($1, c.oid, 'SELECT') then 'SELECT' end, case when has_table_privilege($1, c.oid, 'INSERT') then 'INSERT' end,
          case when has_table_privilege($1, c.oid, 'UPDATE') then 'UPDATE' end, case when has_table_privilege($1, c.oid, 'DELETE') then 'DELETE' end], null) as verbs
        from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')`, [role]);
      return new Map(got.map((r) => [String(r.t), new Set(r.verbs as string[])]));
    }

    /**
     * WHERE A SWEEP IS BLIND, and says so: each locked table on which the roles' rule grants `role`
     * no `verb`. There the statement is refused by the missing grant before any policy is asked,
     * so the sweep claims nothing of the policy: the roles' census holds that grant.
     */
    const blind = (role: string, verbs: readonly string[]): string[] =>
      verbs.flatMap((verb) => lockedTables().filter((t) => !ruleVerbs(role, t).has(verb)).map((t) => `${t} ${verb}: ${NOT_GRANTED}`)).sort();

    /**
     * What a sweep says of `got`, the answer to `verb` on `table` by a login holding `held`: the
     * missing grant's refusal where the catalog says the grant is missing (a line of `notGranted`),
     * else the answer itself, which must be one of `allowed` (a refusal of either kind not allowed
     * is a wrong answer, and so is a grant's refusal where the catalog says granted).
     */
    function judge(table: string, verb: string, got: number | string, held: Map<string, Set<string>>, allowed: ReadonlyArray<number | string>,
      wrong: string[], notGranted: string[]): void {
      if (!held.get(table)!.has(verb)) {
        if (got === NOT_GRANTED) notGranted.push(`${table} ${verb}: ${NOT_GRANTED}`);
        else wrong.push(`${table} ${verb}: ${got}, and the catalog says it is not granted`);
      } else if (!allowed.includes(got)) {
        wrong.push(`${table} ${verb}: ${got}, ${allowed.join(" or ")} wanted`);
      }
    }

    it("with no account named, every locked table answers nothing: a plain statement, and a binding to nothing", async () => {
      const nothing = bindDb(api.db, { account: null }) as unknown as Exec;
      const held = await grantsOf("ohmail_api");
      const wrong: string[] = [];
      const notGranted = new Set<string>();
      for (const table of lockedTables()) {
        for (const [how, db] of [["plain", api.db as unknown as Exec], ["bound to nothing", nothing]] as const) {
          const [w, said]: [string[], string[]] = [[], []];
          judge(table, "SELECT", await countOn(db, table).catch(refusalOf), held, [0], w, said);
          wrong.push(...w.map((x) => `${x} (${how})`));
          for (const s of said) notGranted.add(s);
        }
      }
      // The API's login reads no row of the two staff audit tables at all: it may only append to them.
      expect({ wrong, notGranted: [...notGranted].sort() }).toEqual({ wrong: [], notGranted: blind("ohmail_api", ["SELECT"]) });
    }, CASE_MS);

    it("the worker unbound reads its ten wide tables whole, and no letter", async () => {
      for (const table of WORKER_WIDE_READ) expect(await countOn(worker.db as unknown as Exec, table), table).toBe(await total(table));
      for (const table of ["messages", "message_bodies", "message_search", "drafts"]) expect(await countOn(worker.db as unknown as Exec, table), table).toBe(0);
      const w = bindDb(worker.db, { account: B.accountId }) as unknown as Exec;
      expect(await countOn(w, "messages")).toBe(await ownCount("messages", "account_id", B.accountId));
    }, CASE_MS);

    /** The migrator's count of `table`'s rows where `where` holds: the product's side of a horizon. */
    const countWhere = async (table: string, where: string): Promise<number> =>
      Number((await mig.unsafe(`select count(*)::int as n from ${q(table)} where ${where}`))[0]!.n);

    /**
     * The sessions the session reaper's own run revokes now, by their `ctid`: run as the migrator in a
     * transaction that is rolled back. Its window is its own, so its run is the product's word on it.
     */
    async function reaperTakes(): Promise<string[]> {
      const open = new Map((await mig.unsafe(`select id::text as id, ctid::text as c from sessions where revoked_at is null`)).map((r) => [String(r.id), String(r.c)]));
      let taken: string[] = [];
      const db = brandDialect(drizzle(mig, { schema }), "pg") as unknown as Db;
      const rolledBack = await db.transaction(async (tx) => {
        await reapStaleWebSessions(tx as never, new Date());
        taken = rows(await (tx as unknown as Exec).execute(sql`select id::text as id from sessions where revoked_at is not null`))
          .map((r) => String(r.id)).filter((id) => open.has(id)).map((id) => open.get(id)!);
        (tx as unknown as { rollback(): never }).rollback();
      }).then(() => "committed", (e: unknown) => (e instanceof TransactionRollbackError ? "rolled back" : String(e)));
      expect(rolledBack).toBe("rolled back");
      return taken.sort();
    }

    /**
     * One connection as `role`, naming nothing; `run` answers a statement in a transaction of its
     * own that is rolled back: the rows it changed, or what refused it (`refusalOf`).
     */
    async function asRole<T>(role: string, fn: (run: (statement: string) => Promise<number | string>) => Promise<T>): Promise<T> {
      const c = g.connectAs("ground", role);
      const run = async (statement: string): Promise<number | string> => {
        await c.unsafe("begin");
        try { return (await c.unsafe(statement)).count; } catch (e) { return refusalOf(e); } finally { await c.unsafe("rollback"); }
      };
      try { return await fn(run); } finally { await c.end({ timeout: 5 }); }
    }

    /**
     * A column of `table` an update can name: its first. The sweeps set it to its default, reading
     * no column, so the update's own policies alone decide which rows it reaches (a statement that
     * reads a column is filtered by the read policies too).
     */
    const firstColumn = async (table: string): Promise<string> => String((await mig.unsafe(`select a.attname from pg_attribute a
      where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' order by a.attnum limit 1`, [q(table)]))[0]!.attname);

    it("the session reaper's own run takes the session an hour past its window and keeps the one an hour inside it", async () => {
      const cookie = edges["sessions:cookie"]!;
      expect(cookie.past).toHaveLength(2);
      expect(await reaperTakes()).toEqual([...cookie.past].sort());
    }, CASE_MS);

    it("naming nothing, the worker reads its wide tables whole, the owed notices, past each horizon exactly what the product calls past, and nothing else", async () => {
      const nothing = bindDb(worker.db, { account: null }) as unknown as Exec;
      const reaped = await reaperTakes();
      const held = await grantsOf("ohmail_worker");
      const wrong: string[] = [];
      const notGranted: string[] = [];
      for (const table of lockedTables()) {
        const seen = await nothing.execute(sql.raw(`select ctid::text as c from ${q(table)}`)).then((r) => rows(r).map((x) => String(x.c)), refusalOf);
        const want = (WORKER_WIDE_READ as readonly string[]).includes(table) ? await total(table)
          : table === "account_counters" ? await countWhere(table, `key like 'notice:%' or (${PAST[table]})`)
            : table === "sessions" ? await countWhere(table, PAST[table]!) + reaped.length
              : table in PAST ? await countWhere(table, PAST[table]!) : 0;
        judge(table, "SELECT", typeof seen === "string" ? seen : seen.length, held, [want], wrong, notGranted);
        if (typeof seen === "string") continue;
        const planted = [edges[table], table === "sessions" ? edges["sessions:cookie"] : undefined].filter((e) => e !== undefined);
        for (const e of planted) {
          if (e.past.some((c) => !seen.includes(c))) wrong.push(`${table}: a row an hour past its horizon is not read`);
          if (e.inside.some((c) => seen.includes(c))) wrong.push(`${table}: a row the product does not call past is read`);
        }
      }
      expect(Object.keys(edges).filter((t) => t !== "sessions:cookie").sort()).toEqual(Object.keys(PAST).sort());
      // The worker's login reads no row of the staff tables but the sessions it prunes, nor of the waitlist.
      expect({ wrong, notGranted: notGranted.sort() }).toEqual({ wrong: [], notGranted: blind("ohmail_worker", ["SELECT"]) });
    }, CASE_MS);

    it("naming nothing, the worker's update or delete with no WHERE changes nothing anywhere, but deletes the rows past an unbound prune's horizon", async () => {
      const held = await grantsOf("ohmail_worker");
      const got = await asRole("ohmail_worker", async (run) => {
        const [wrong, notGranted]: [string[], string[]] = [[], []];
        for (const table of lockedTables()) {
          const col = await firstColumn(table);
          const past = table in PAST && !ROSTER.has(table) ? await countWhere(table, PAST[table]!) : 0;
          // No row, or a row past a horizon its prune may lock: the policy refuses what the update would write there.
          judge(table, "UPDATE", await run(`update ${q(table)} set "${col}" = default`), held, [0, BY_POLICY], wrong, notGranted);
          judge(table, "DELETE", await run(`delete from ${q(table)}`), held, [past], wrong, notGranted);
        }
        return { wrong, notGranted: notGranted.sort() };
      });
      expect(got).toEqual({ wrong: [], notGranted: blind("ohmail_worker", ["UPDATE", "DELETE"]) });
    }, CASE_MS);

    it("naming nothing, the API's update or delete with no WHERE changes nothing anywhere, and the funnel takes no row", async () => {
      const held = await grantsOf("ohmail_api");
      const got = await asRole("ohmail_api", async (run) => {
        const [wrong, notGranted]: [string[], string[]] = [[], []];
        for (const table of lockedTables()) {
          const col = await firstColumn(table);
          judge(table, "UPDATE", await run(`update ${q(table)} set "${col}" = default`), held, [0], wrong, notGranted);
          judge(table, "DELETE", await run(`delete from ${q(table)}`), held, [0], wrong, notGranted);
        }
        return {
          wrong, notGranted: notGranted.sort(),
          invite: await run(`insert into invites (code_hash, email, issued_by, expires_at) values ('unnamed', 'unnamed@example.test', 'operator', now() + interval '1 day')`),
          waitlist: await run(`insert into waitlist (email, tier, source) values ('unnamed@example.test', 'solo', 'landing')`),
        };
      });
      expect(got).toEqual({ wrong: [], notGranted: blind("ohmail_api", ["UPDATE", "DELETE"]), invite: BY_POLICY, waitlist: BY_POLICY });
    }, CASE_MS);

    it("the staff role reads every account's rows of what it is granted, and nothing of the mail", async () => {
      const staff = g.connectAs("ground", "ohmail_admin");
      try {
        expect(Number((await staff.unsafe("select count(*)::int as n from public.accounts"))[0]!.n)).toBe(await total("accounts"));
        expect(await staff.unsafe("select id from public.messages").then(() => "read", codeOf)).toBe("42501");
      } finally {
        await staff.end({ timeout: 5 });
      }
    }, CASE_MS);

    it("a key reads its own row and nothing else, and locks it only once the account is named", async () => {
      const [{ token_hash: keyA }] = await mig.unsafe(`select token_hash from refresh_tokens where account_id = $1`, [A.accountId]) as unknown as Array<{ token_hash: string }>;
      expect(await countOn(bindDb(api.db, { account: null }) as unknown as Exec, "refresh_tokens")).toBe(0);
      const keyed = bindDb(api.db, { account: null, key: keyA }) as unknown as Txable;
      expect(await countOn(keyed, "refresh_tokens")).toBe(1);
      const locked = await keyed.transaction(async (tx) => {
        const before = rows(await tx.execute(sql`select id from refresh_tokens where token_hash = ${keyA} for update`)).length;
        const named = await rebindTx(tx as never, { account: A.accountId }) as unknown as Exec;
        const after = rows(await named.execute(sql`select id from refresh_tokens where token_hash = ${keyA} for update`)).length;
        return { before, after };
      });
      expect(locked).toEqual({ before: 0, after: 1 });
    }, CASE_MS);

    it("a row with no account yet is made and spent by its key alone, and refused without it", async () => {
      const key = `unowned-${A.accountId.slice(0, 8)}`;
      const keyed = bindDb(api.db, { account: null, key }) as unknown as Exec;
      await keyed.execute(sql`insert into login_tokens (token_hash, purpose, expires_at) values (${key}, 'desktop_approval', now() + interval '5 minutes')`);
      const spent = await keyed.execute(sql`update login_tokens set consumed_at = now() where token_hash = ${key}`) as { count?: number };
      expect(spent.count).toBe(1);
      const unkeyed = bindDb(api.db, { account: null }) as unknown as Exec;
      expect(await unkeyed.execute(sql`insert into login_tokens (token_hash, purpose, expires_at) values ('no-key', 'desktop_approval', now() + interval '5 minutes')`)
        .then(() => "written", codeOf)).toBe("42501");
    }, CASE_MS);

    it("the staff tables open only through their door, with no account bound", async () => {
      const door = bindDb(api.db, { account: null, key: STAFF_DOOR_KEY }) as unknown as Exec;
      expect(await countOn(door, "staff_users")).toBe(1);
      expect(await countOn(bindDb(api.db, { account: A.accountId, key: STAFF_DOOR_KEY }) as unknown as Exec, "staff_users")).toBe(0);
      expect(await countOn(bindDb(api.db, { account: null }) as unknown as Exec, "staff_users")).toBe(0);
      expect(await countOn(api.db as unknown as Exec, "staff_users")).toBe(0);
    }, CASE_MS);

    /**
     * `statement` as the API's login in a transaction that is rolled back: the rows it wrote, or
     * what refused it. Through the real binder under `bind`; with none, a plain transaction that
     * names nothing at all.
     */
    async function attempt(bind: BindTo | null, statement: string): Promise<number | string> {
      const db = (bind === null ? api.db
        : bind.account === null ? bindDb(api.db, { account: null, key: bind.key }) : bindDb(api.db, { account: bind.account, key: bind.key })) as unknown as Txable;
      let got: number | string = "not run";
      await db.transaction(async (tx) => {
        got = await tx.execute(sql.raw(statement)).then((r) => Number((r as { count?: number }).count ?? 0), refusalOf);
        (tx as unknown as { rollback(): never }).rollback();
      }).catch((e: unknown) => { if (!(e instanceof TransactionRollbackError)) throw e; });
      return got;
    }

    it("an insert into each staff table without the door is refused by its policy, bound to an account or naming nothing; through the door it is admitted", async () => {
      const inserts = STAFF_INSERTS(staffId);
      expect(Object.keys(inserts).sort()).toEqual([...STAFF_TABLES].sort());
      const got: Record<string, object> = {};
      for (const [table, statement] of Object.entries(inserts)) {
        got[table] = {
          boundToA: await attempt({ account: A.accountId }, statement),
          boundToAWithTheDoorsWord: await attempt({ account: A.accountId, key: STAFF_DOOR_KEY }, statement),
          boundToNothing: await attempt({ account: null }, statement),
          plain: await attempt(null, statement),
          throughTheDoor: await attempt({ account: null, key: STAFF_DOOR_KEY }, statement),
        };
      }
      // The same statement, the same login and grant: the door admits it, so each refusal is the policy's.
      const refused = { boundToA: BY_POLICY, boundToAWithTheDoorsWord: BY_POLICY, boundToNothing: BY_POLICY, plain: BY_POLICY, throughTheDoor: 1 };
      expect(got).toEqual(Object.fromEntries(Object.keys(inserts).map((t) => [t, refused])));
    }, CASE_MS);

    it("a reset inside a bound transaction answers nothing, and the login cannot turn row security off", async () => {
      const a = bindDb(api.db, { account: A.accountId, key: STAFF_DOOR_KEY }) as unknown as Txable;
      const afterReset = await a.transaction(async (tx) => {
        await tx.execute(sql`reset all`);
        return { messages: await countOn(tx, "messages"), staff: await countOn(tx, "staff_users") };
      });
      expect(afterReset).toEqual({ messages: 0, staff: 0 });
      const off = await a.transaction(async (tx) => {
        await tx.execute(sql`set local row_security = off`);
        return countOn(tx, "messages");
      }).then((n) => `read ${n}`, codeOf);
      expect(off).toBe("42501");
    }, CASE_MS);

    it("the right to bypass, granted to the API's login, reads B's rows bound to A, and the check names it", async () => {
      const su = g.connectAs("postgres");
      await su.unsafe("alter role ohmail_api bypassrls");
      try {
        // A connection of its own: the attribute is read when a session begins.
        const bypassing = makeOwnedDb(g.urlAs("ground", "ohmail_api"), { role: "api" });
        try {
          const a = bindDb(bypassing.db, { account: A.accountId }) as unknown as Exec;
          expect(await countOn(a, "messages")).toBe(await total("messages"));
          expect(await countOn(a, "messages")).toBeGreaterThan(await ownCount("messages", "account_id", A.accountId));
        } finally {
          await bypassing.close();
        }
        const login = g.connectAs("ground", "ohmail_api");
        try {
          expect(await readLock(login, { role: "ohmail_api" })).toMatchObject({ verdict: "broken", why: ["ohmail_api may bypass row security"] });
        } finally {
          await login.end({ timeout: 5 });
        }
      } finally {
        await su.unsafe("alter role ohmail_api nobypassrls");
        await su.end({ timeout: 5 });
      }
    }, CASE_MS);

    it("the plans of a list read and a body read keep the account's index, custom and generic", async () => {
      const a = bindDb(api.db, { account: A.accountId }) as unknown as Txable;
      type Plan = { "Node Type": string; "Relation Name"?: string; "Index Cond"?: string; "Recheck Cond"?: string; Plans?: Plan[] };
      const nodes = (p: Plan): Plan[] => [p, ...(p.Plans ?? []).flatMap(nodes)];
      const reads = {
        list: `select id from public.messages where deleted_at is null order by date desc nulls last, id desc limit 50`,
        listOwn: `select id from public.messages where account_id = '${A.accountId}' and deleted_at is null order by date desc nulls last, id desc limit 50`,
        body: `select text from public.message_bodies where message_id = '${A.messageId}'`,
        bodyOwn: `select text from public.message_bodies where account_id = '${A.accountId}' and message_id = '${A.messageId}'`,
      };
      const plans: Record<string, Plan[]> = {};
      await a.transaction(async (tx) => {
        await tx.execute(sql`select set_config('enable_seqscan', 'off', true)`);
        for (const [name, text] of Object.entries(reads)) {
          plans[name] = nodes((rows(await tx.execute(sql.raw(`explain (format json) ${text}`)))[0]!["QUERY PLAN"] as Array<{ Plan: Plan }>)[0]!.Plan);
          await tx.execute(sql`select set_config('plan_cache_mode', 'force_generic_plan', true)`);
          await tx.execute(sql.raw(`prepare lock_plan_${name} as ${text.replace(`'${A.messageId}'`, "$1::uuid")}`));
          const generic = rows(await tx.execute(sql.raw(`explain (format json) execute lock_plan_${name}${text.includes(A.messageId) ? `('${A.messageId}')` : ""}`)));
          plans[`${name} generic`] = nodes((generic[0]!["QUERY PLAN"] as Array<{ Plan: Plan }>)[0]!.Plan);
          await tx.execute(sql.raw(`deallocate lock_plan_${name}`));
          await tx.execute(sql`select set_config('plan_cache_mode', 'auto', true)`);
        }
      });
      for (const [name, plan] of Object.entries(plans)) {
        const scans = plan.filter((n) => n["Relation Name"] === "messages" || n["Relation Name"] === "message_bodies");
        expect(scans.length, name).toBeGreaterThan(0);
        expect(scans.map((n) => n["Node Type"]), name).not.toContain("Seq Scan");
        if (name.startsWith("list")) {
          expect(scans.some((n) => /account_id/.test(`${n["Index Cond"] ?? ""}${n["Recheck Cond"] ?? ""}`)), `${name}: the account names the index`).toBe(true);
        }
      }
    }, CASE_MS);
  });
}

/**
 * ROWS PAST THEIR HORIZON, AND ROWS NOT YET, for one account: each pruned table's row an hour past
 * its horizon named `dead`, the one an hour inside it `live`, placed by the product's constants.
 * Beside them the three rows a guard keeps: a revoked session whose family still has a live one, a
 * silent device a live session names, and the old claim of a send still held. And their unguarded
 * twins, which a prune bound to the account takes.
 */
async function plantHorizons(m: postgres.Sql, a: SeededAccount, staffUserId: string): Promise<void> {
  const [ids] = await m.unsafe(`select (select id from drafts where account_id = $1 limit 1) as draft`, [a.accountId]);
  const at = (ago: string): string => `now() - interval '${ago}'`;
  const each = async (statements: Array<[string, unknown[]]>): Promise<void> => { for (const [s, p] of statements) await m.unsafe(s, p as never[]); };
  const A = a.accountId;
  const U = a.userId;
  const S = SIGN_IN_RECORD_RETENTION_MS;
  const both = (ms: number): [string, string] => [edge(ms, "past"), edge(ms, "inside")];
  const [sDead, sLive] = both(S);
  const [nowDead, nowLive] = [nowEdge("past"), nowEdge("inside")];
  await each([
    [`insert into login_tokens (user_id, account_id, token_hash, expires_at) values ($1, $2, 'dead', ${sDead}), ($1, $2, 'live', ${sLive})`, [U, A]],
    [`insert into oauth_auth_codes (user_id, account_id, client_id, code_hash, code_challenge, redirect_uri, expires_at)
      values ($1, $2, 'desktop', 'dead', 'cc', 'ohmail://cb', ${sDead}), ($1, $2, 'desktop', 'live', 'cc', 'ohmail://cb', ${sLive})`, [U, A]],
    [`insert into pairing_tokens (created_by_user_id, account_id, "grant", token_hash, label, expires_at)
      values ($1, $2, 'device-pair', 'dead', 'dead', ${sDead}), ($1, $2, 'device-pair', 'live', 'live', ${sLive})`, [U, A]],
    [`insert into invites (code_hash, email, issued_by, expires_at) values ('dead', 'dead@example.test', 'operator', ${sDead}), ('live', 'live@example.test', 'operator', ${sLive})`, []],
    [`insert into webauthn_challenges (user_id, account_id, challenge, type, rp_id, origin, expires_at)
      values ($1, $2, 'dead', 'registration', 'app.ohmail.app', 'https://app.ohmail.app', ${edge(WEBAUTHN_CHALLENGE_RETENTION_MS, "past")}),
             ($1, $2, 'live', 'registration', 'app.ohmail.app', 'https://app.ohmail.app', ${edge(WEBAUTHN_CHALLENGE_RETENTION_MS, "inside")})`, [U, A]],
    [`insert into mailbox_oauth_ceremonies (account_id, state, provider, code_verifier_enc, code_verifier_key_version, return_to, created_at)
      values ($1, 'dead', 'microsoft', 'enc:v', 1, '/mailbox', ${edge(OAUTH_CEREMONY_RETENTION_MS, "past")}),
             ($1, 'live', 'microsoft', 'enc:v', 1, '/mailbox', ${edge(OAUTH_CEREMONY_RETENTION_MS, "inside")})`, [A]],
    [`insert into mailbox_oauth_device_ceremonies (account_id, state, provider, device_code_enc, device_code_key_version, user_code, verification_uri, poll_interval_ms, grant_expires_at, created_at)
      values ($1, 'dead', 'microsoft', 'enc:d', 1, 'AAAA-BBBB', 'https://microsoft.com/devicelogin', 5000, now(), ${edge(DEVICE_CEREMONY_RETENTION_MS, "past")}),
             ($1, 'live', 'microsoft', 'enc:d', 1, 'CCCC-DDDD', 'https://microsoft.com/devicelogin', 5000, now() + interval '1 hour', ${edge(DEVICE_CEREMONY_RETENTION_MS, "inside")})`, [A]],
    [`insert into auth_events (account_id, user_id, event, device, at)
      values ($1, $2, 'login', 'dead', ${edge(AUTH_EVENTS_RETENTION_MS, "past")}), ($1, $2, 'login', 'live', ${edge(AUTH_EVENTS_RETENTION_MS, "inside")})`, [A, U]],
    [`insert into connect_attempts (account_id, at, door, preset, outcome, reason, transport)
      values ($1, ${edge(CONNECT_ATTEMPTS_RETENTION_MS, "past")}, 'connect', 'gmail', 'refused', 'dead', 'imap'),
             ($1, ${edge(CONNECT_ATTEMPTS_RETENTION_MS, "inside")}, 'connect', 'gmail', 'refused', 'live', 'imap')`, [A]],
    [`insert into audit_log (account_id, action, created_at)
      values ($1, 'dead', ${edge(AUDIT_LOG_RETENTION_MS, "past")}), ($1, 'live', ${edge(AUDIT_LOG_RETENTION_MS, "inside")})`, [A]],
    [`insert into idempotency_keys (account_id, key, request_hash, response_status, response_json, expires_at)
      values ($1, 'dead', 'h', 200, '{}', ${nowDead}), ($1, 'live', 'h', 200, '{}', ${nowLive})`, [A]],
    [`insert into erased_bearers (token_hash, account_id, expires_at) values ('dead', $1, ${nowDead}), ('live', $1, ${nowLive})`, [A]],
    [`insert into attachment_staging (id, account_id, object_path, filename, content_type, size_bytes, expires_at)
      values (gen_random_uuid(), $1, 'staging/dead', 'dead', 'text/plain', 1, ${nowDead}), (gen_random_uuid(), $1, 'staging/live', 'live', 'text/plain', 1, ${nowLive})`, [A]],
    [`insert into account_counters (account_id, key, failures, window_started_at)
      values ($1, 'factor-day:dead', 1, ${edge(AUTH_THROTTLE_RETENTION_MS, "past")}), ($1, 'factor-day:live', 1, ${edge(AUTH_THROTTLE_RETENTION_MS, "inside")})`, [A]],
    [`insert into staff_sessions (staff_user_id, token_hash, expires_at, last_twofa_at) values ($1, 'dead', ${sDead}, now()), ($1, 'live', ${sLive}, now())`, [staffUserId]],
    // The notices of an account erased an hour more than the keep ago go; one erased an hour less ago stays.
    [`with gone as (insert into accounts (name, erased_at)
        values ('dead', now() - make_interval(years => ${ERASED_NOTICE_KEEP_YEARS}) - ${HOUR}), ('live', now() - make_interval(years => ${ERASED_NOTICE_KEEP_YEARS}) + ${HOUR}) returning id)
      insert into account_lifecycle_notices (account_id, kind, anchor) select id, 'closed', now() from gone`, []],
    // The guarded and the unguarded: sessions revoked 60 days ago, one in a family with a live session.
    [`insert into sessions (account_id, user_id, family_id, access_expires_at, refresh_expires_at, revoked_at, scope)
      values ($1, $2, '00000000-0000-4000-8000-0000000000aa', now(), now() + interval '1 day', ${at("60 days")}, 'full'),
             ($1, $2, '00000000-0000-4000-8000-0000000000aa', now() + interval '1 day', now() + interval '90 days', null, 'full'),
             ($1, $2, '00000000-0000-4000-8000-0000000000bb', now(), now() + interval '1 day', ${at("60 days")}, 'full')`, [A, U]],
    // Devices silent for 60 days: one a live session names, one nothing names.
    [`with named as (insert into devices (account_id, user_id, kind, label, ip, last_seen_at) values ($1, $2, 'macos', 'named', '192.0.2.1', ${at("60 days")}) returning id)
      insert into sessions (account_id, user_id, device_id, family_id, access_expires_at, refresh_expires_at, scope)
      select $1::uuid, $2::uuid, id, gen_random_uuid(), now() + interval '1 day', now() + interval '90 days', 'full' from named`, [A, U]],
    [`insert into devices (account_id, user_id, kind, label, ip, last_seen_at) values ($1, $2, 'macos', 'alone', '192.0.2.2', ${at("60 days")})`, [A, U]],
    // Content claims two days old: one of a send still held, one of a send that went.
    [`with held as (insert into outbound_sends (account_id, draft_id, idempotency_key, minted_message_id, status) values ($1, $3, 'held', '<held@x>', 'unverified') returning id),
          sent as (insert into outbound_sends (account_id, draft_id, idempotency_key, minted_message_id, status) values ($1, $3, 'sent', '<sent@x>', 'sent') returning id)
      insert into outbound_send_fingerprints (account_id, mailbox_id, fingerprint, send_id, created_at)
      select $1::uuid, $2::uuid, repeat('c', 64), id, ${at("2 days")} from held union all select $1::uuid, $2::uuid, repeat('d', 64), id, ${at("2 days")} from sent`, [A, a.mailboxId, ids!.draft]],
  ]);
}

for (const major of PG_MAJORS) {
  describe.skipIf(!OWN)(`the worker's prunes and the API's erasure under the lock, on Postgres ${major}`, () => {
    let g: LockGround;
    let A: SeededAccount;
    let mig: postgres.Sql;
    let worker: OwnedDb;
    let api: OwnedDb;

    beforeAll(async () => {
      g = await startLockGround(major, `prune_${major}`, "ground");
      await g.setup("ground");
      await g.makeRoles("ground");
      await g.setup("ground", MIGRATOR_ROLE, { lock: "apply" });
      mig = g.connectAs("ground", MIGRATOR_ROLE);
      A = await seedFullAccount(brandDialect(drizzle(mig, { schema }), "pg") as unknown as Db, "Account A");
      const [staff] = await mig.unsafe(`insert into staff_users (email, password_hash) values ('operator@example.test', 'x') returning id`);
      await plantHorizons(mig, A, String(staff!.id));
      worker = makeOwnedDb(g.urlAs("ground", "ohmail_worker"), { role: "worker" });
      api = makeOwnedDb(g.urlAs("ground", "ohmail_api"), { role: "api" });
    }, MIGRATED_DB_SETUP_BUDGET_MS);

    afterAll(async () => {
      await worker?.close();
      await api?.close();
      await mig?.end({ timeout: 5 });
      g?.stop();
    });

    /** What each table holds now, read by the migrator: the planted rows by their marker. */
    const left = async (): Promise<Record<string, string[]>> => {
      const q1 = async (s: string): Promise<string[]> => (await mig.unsafe(s)).map((r) => String(r.v)).sort();
      return {
        login_tokens: await q1(`select token_hash as v from login_tokens where token_hash in ('dead', 'live')`),
        oauth_auth_codes: await q1(`select code_hash as v from oauth_auth_codes where code_hash in ('dead', 'live')`),
        pairing_tokens: await q1(`select token_hash as v from pairing_tokens where token_hash in ('dead', 'live')`),
        invites: await q1(`select code_hash as v from invites where code_hash in ('dead', 'live')`),
        webauthn_challenges: await q1(`select challenge as v from webauthn_challenges where challenge in ('dead', 'live')`),
        mailbox_oauth_ceremonies: await q1(`select state as v from mailbox_oauth_ceremonies where state in ('dead', 'live')`),
        mailbox_oauth_device_ceremonies: await q1(`select state as v from mailbox_oauth_device_ceremonies where state in ('dead', 'live')`),
        auth_events: await q1(`select device as v from auth_events where device in ('dead', 'live')`),
        audit_log: await q1(`select action as v from audit_log where action in ('dead', 'live')`),
        idempotency_keys: await q1(`select key as v from idempotency_keys where key in ('dead', 'live')`),
        erased_bearers: await q1(`select token_hash as v from erased_bearers where token_hash in ('dead', 'live')`),
        attachment_staging: await q1(`select filename as v from attachment_staging where filename in ('dead', 'live')`),
        staff_sessions: await q1(`select token_hash as v from staff_sessions where token_hash in ('dead', 'live')`),
        account_counters: await q1(`select substr(key, 12) as v from account_counters where key in ('factor-day:dead', 'factor-day:live')`),
        connect_attempts: await q1(`select reason as v from connect_attempts where reason in ('dead', 'live')`),
        notices_of_erased: await q1(`select a.name as v from account_lifecycle_notices n join accounts a on a.id = n.account_id where a.erased_at is not null`),
      };
    };
    const ALL = { dead: ["dead", "live"] } as const;
    const unbound = (): Exec => bindDb(worker.db, { account: null }) as unknown as Exec;
    const now = (): Date => new Date();

    /** Every unbound prune the worker runs, each its real function; the counters' by its shape and the throttle's constant (it has no prune yet). */
    async function pruneUnbound(db: Exec): Promise<void> {
      const tx = db as never;
      await pruneSignInRecords(tx, now(), { retentionMs: SIGN_IN_RECORD_RETENTION_MS });
      await pruneAuthEvents(tx, now());
      await pruneConnectAttempts(tx, now());
      await pruneAuditLog(tx, now());
      await pruneIdempotencyKeys(tx, now());
      await pruneErasedBearers(tx, now());
      await pruneErasedNotices(tx, now());
      await sweepExpiredStagingFor(tx, { remove: async () => {} } as never, now());
      await db.execute(sql.raw(`delete from account_counters where (account_id, key) in (select account_id, key from account_counters
        where window_started_at < ${before(AUTH_THROTTLE_RETENTION_MS)} and (locked_until is null or locked_until <= now()) limit 100 for update skip locked)`));
    }

    it("without the worker's horizon policies, each prune as the worker's role takes nothing", async () => {
      const dropped = await mig.unsafe(`select c.relname as t, p.polname as p from pg_policy p join pg_class c on c.oid = p.polrelid
        where p.polname like 'lock\\_worker\\_past\\_%'`);
      for (const r of dropped) await mig.unsafe(`drop policy ${String(r.p)} on public."${String(r.t)}"`);
      const before = await left();
      await pruneUnbound(unbound());
      expect(await left()).toEqual(before);
      expect(before.login_tokens).toEqual(ALL.dead);
      // The setup makes them again: the lock stood.
      expect((await g.setup("ground", MIGRATOR_ROLE)).lock).toMatchObject({ state: "locked" });
    }, CASE_MS);

    it("with them, each prune takes the row an hour past its horizon and keeps the one an hour inside it", async () => {
      for (const [table, planted] of Object.entries(await left())) expect(planted, table).toEqual(["dead", "live"]);
      await pruneUnbound(unbound());
      for (const [table, kept] of Object.entries(await left())) expect(kept, table).toEqual(["live"]);
    }, CASE_MS);

    it("the three prunes that read beside their row take nothing unbound, and bound to the account keep the guarded rows", async () => {
      const sessions = async (): Promise<string[]> => (await mig.unsafe(`select family_id::text || ':' || coalesce(revoked_at is not null, false)::text as v
        from sessions where account_id = $1 and family_id in ('00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000bb')`, [A.accountId])).map((r) => String(r.v)).sort();
      const ips = async (): Promise<string[]> => (await mig.unsafe(`select label || '=' || ip as v from devices where label in ('named', 'alone')`)).map((r) => String(r.v)).sort();
      const claims = async (): Promise<string[]> => (await mig.unsafe(`select s.idempotency_key as v from outbound_send_fingerprints f
        join outbound_sends s on s.id = f.send_id where s.idempotency_key in ('held', 'sent')`)).map((r) => String(r.v)).sort();
      const before = { sessions: await sessions(), ips: await ips(), claims: await claims() };
      const free = await pruneSignInRecords(unbound() as never, now(), { retentionMs: SIGN_IN_RECORD_RETENTION_MS });
      expect({ sessions: free.sessions, devices: free.deviceAddresses, claims: await pruneSendFingerprints(unbound() as never, now()) })
        .toEqual({ sessions: 0, devices: 0, claims: 0 });
      expect({ sessions: await sessions(), ips: await ips(), claims: await claims() }).toEqual(before);
      const bound = bindDb(worker.db, { account: A.accountId }) as never;
      const done = await pruneSignInRecords(bound, now(), { retentionMs: SIGN_IN_RECORD_RETENTION_MS });
      expect({ sessions: done.sessions, devices: done.deviceAddresses, claims: await pruneSendFingerprints(bound, now()) }).toEqual({ sessions: 1, devices: 1, claims: 1 });
      expect(await sessions()).toEqual(["00000000-0000-4000-8000-0000000000aa:false", "00000000-0000-4000-8000-0000000000aa:true"]);
      expect(await ips()).toEqual(["alone=", "named=192.0.2.1"]);
      expect(await claims()).toEqual(["held"]);
    }, CASE_MS);

    it("the worker's role may lock a dead invite and never write it", async () => {
      await mig.unsafe(`insert into invites (code_hash, email, issued_by, expires_at) values ('dead-again', 'dead-again@example.test', 'operator', now() - interval '60 days')`);
      const w = unbound();
      expect(rows(await w.execute(sql`select id from invites where code_hash = 'dead-again'`))).toHaveLength(1);
      expect(await w.execute(sql`update invites set email = 'rewritten@example.test' where code_hash = 'dead-again'`).then(() => "written", codeOf)).toBe("42501");
    }, CASE_MS);

    it("the erasure as the API's role, by the ruled loop, leaves no address of the account; the one statement of 1.0 changes nothing", async () => {
      const [u] = await mig.unsafe(`select id, email from users where account_id = $1`, [A.accountId]) as unknown as Array<{ id: string; email: string }>;
      await mig.unsafe(`insert into invites (code_hash, email, issued_by, expires_at) values ('unused-by-address', $1, 'operator', now() + interval '1 day'),
        ('consumed-before-a-change', 'before-a-change@example.test', 'operator', now() + interval '1 day')`, [u!.email]);
      await mig.unsafe(`update invites set consumed_at = now(), consumed_by_user_id = $1 where code_hash = 'consumed-before-a-change'`, [u!.id]);
      const addresses = async (): Promise<number> => Number((await mig.unsafe(`select
          (select count(*) from invites where email in ($1, 'before-a-change@example.test')) + (select count(*) from waitlist where email = $1) as n`, [u!.email]))[0]!.n);
      expect(await addresses()).toBe(4);
      const a = bindDb(api.db, { account: A.accountId }) as unknown as Txable;
      // 1.0's statements: one update by address and consumer each, with no key named.
      const tag = await a.transaction(async (tx) => {
        const i = await tx.execute(sql`update invites set email = 'erased-' || id::text || '@invalid' where email in (select email from users where account_id = ${A.accountId})
          or (consumed_by_user_id is not null and consumed_by_user_id in (select id from users where account_id = ${A.accountId}))`) as { count?: number };
        const w = await tx.execute(sql`update waitlist set email = 'erased-' || id::text || '@invalid' where email in (select email from users where account_id = ${A.accountId})`) as { count?: number };
        return (i.count ?? 0) + (w.count ?? 0);
      });
      expect(tag).toBe(0);
      expect(await addresses()).toBe(4);
      // The ruled loop: name each user and rewrite what it consumed; name each address, read the ids, name each id and rewrite it.
      await a.transaction(async (tx) => {
        const people = rows(await tx.execute(sql`select id, email from users where account_id = ${A.accountId}`));
        for (const p of people) {
          const byUser = await rebindTx(tx as never, { key: String(p.id) }) as unknown as Exec;
          await byUser.execute(sql`update invites set email = 'erased-' || id::text || '@invalid' where consumed_by_user_id = ${String(p.id)}::uuid`);
          const byAddress = await rebindTx(tx as never, { key: String(p.email) }) as unknown as Exec;
          const ids = [
            ...rows(await byAddress.execute(sql`select 'invites' as t, id::text as id from invites where email = ${String(p.email)}`)),
            ...rows(await byAddress.execute(sql`select 'waitlist' as t, id::text as id from waitlist where email = ${String(p.email)}`)),
          ];
          for (const r of ids) {
            const byId = await rebindTx(tx as never, { key: String(r.id) }) as unknown as Exec;
            await byId.execute(sql.raw(`update public.${String(r.t)} set email = 'erased-' || id::text || '@invalid' where id = '${String(r.id)}'`));
          }
        }
      });
      expect(await addresses()).toBe(0);
    }, CASE_MS);
  });
}

/** What `plantUnwritten` plants for the tables nothing writes yet (and `erased_bearers`, which only an erasure writes). */
const PLANTED = ["account_closures", "cal_credentials", "cal_links", "cal_push_channels", "cal_writes"];

describe("the rows planted beside the erasure's seed", () => {
  it("are exactly the tables nothing writes yet: a table that gains a writer is the seed's to plant", () => {
    expect(Object.keys(UNWRITTEN_TABLES).sort()).toEqual(PLANTED);
  });
});
