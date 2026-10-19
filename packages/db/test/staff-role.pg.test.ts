/* THIS FILE IS THE ROLE HALF of the staff-blindness evidence documented in
 * `packages/services/src/admin-service.ts`: against real Postgres it proves the staff role
 * refuses the mail relations outright, that a chosen delivery to one of two otherwise identical
 * accounts changes nothing the role can select, and that a ledger digest seeded from a known
 * Message-ID appears in NOTHING the role can read. Those comments used to cite this file by
 * full path; they were reworded to "a role-level test" when the services sources were prepared
 * for publication (test directories are not yet published), and the pointer moved here so the
 * coupling is still written down at the end a grep can find. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { managedDomain } from "../../../test/support/fixture-credentials.js";
import {
  adminAccountDetail, adminAccounts, adminAccountsByIds, adminActions, adminAlerts, adminEngagement,
  adminFunnel, adminLatestResolvedAlerts, adminStaffFeed, adminStorage, adminSyncRoster, adminWorker,
  type AdminDb,
} from "@trafficflow/services";
import {
  assertContentBlind,
  listOpenAlerts,
  runAlertPass,
  asCapabilities,
  staffCapabilityExcess,
  staffCapabilityShortfall,
  CONTENT_BITE_TESTS,
  CONTENT_BLIND_PROBE,
  DENIED_SQLSTATE,
  NotContentBlindError,
  STAFF_ADMIN_VIEWS,
  STAFF_CAPABILITY_SQL,
  STAFF_ROLE,
  STAFF_SELECT_GRANTS,
  STAFF_TABLE_GRANTS,
} from "../src/cloud.js";
import { schema } from "../src/schema.js";
import { MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * THE GUARD FOR STRUCTURAL STAFF ISOLATION (the "Account isolation is absolute, and it binds staff too" invariant).
 *
 * The "Account isolation is absolute, and it binds staff too" invariant says an account's mail is reachable by that account's own users "and by nobody
 * else, including operators and the admin console", and that the enforcement "must be
 * structural […] never a projection someone remembers to keep narrow". The first staff change closed the render
 * path; this file is the proof that the DATABASE now refuses, which is the part a projection
 * can never be.
 *
 * ── WHY IT IS A `*.pg.test.ts` AND CANNOT BE ANYTHING ELSE ────────────────────────────────
 *
 * PGlite has no roles. `CREATE ROLE`, `GRANT SELECT (col)`, SQLSTATE 42501 — none of it exists
 * there, so the entire subject of this file is STRUCTURALLY INVISIBLE to the whole PGlite
 * suite. A green run of that suite says exactly nothing about staff isolation, which is why
 * `packages/api/test/helpers.ts` brands its PGlite handle by an explicit cast and says so.
 *
 * ── IT EXECUTES THE SHIPPED SCRIPT, VERBATIM ──────────────────────────────────────────────
 *
 * `scripts/harden-staff-role.sql` is read off disk and run as one simple query. It is NOT
 * reimplemented here and no grant is provisioned inline, because a test that built its own
 * grants would be the repo's built-tested-unreachable pattern in its purest form: CI proving,
 * in perpetuity, a configuration production never received. The only thing this file adds is a
 * PASSWORD, which the script deliberately does not carry.
 *
 * ── THE THREE HALVES ──────────────────────────────────────────────────────────────────────
 *
 *  1. **Denials.** Every column and table the "Account isolation is absolute, and it binds staff too" invariant names, plus every write, answers 42501.
 *  2. **Positives, in the same run.** The six admin reads and the alert pass are executed
 *     against the role and asserted to return the seeded data. Without this an over-revoke —
 *     a script that granted nothing at all — would pass the denial half perfectly.
 *  3. **A CENSUS.** `has_column_privilege` over every column of every table in `public`, and
 *     `has_table_privilege` over every write, compared to an explicit allowlist by EQUALITY.
 *     A table-level `GRANT SELECT ON accounts` somebody adds "for support" fails by exhaustion
 *     rather than by whether anyone thought to write an assertion for that table.
 *
 * ── ONE ALLOWLIST, AND THE ATTACKS THE VERSION OF THIS FILE COULD NOT SEE ────────
 *
 * The allowlist is no longer declared here. It is `packages/db/src/staff-grants.ts`, imported
 * by this file AND by the boot attestation in `admin-db.ts`, so what CI asserts and what
 * production refuses to boot without are the same object. A review finding asked for exactly that,
 * and this repo has been bitten twice by a constant living in two places.
 *
 * Two structural blind spots are closed here, both of them review findings:
 *
 *  · **The first finding** — the boot probe was `select subject from messages where false` and ONE 42501
 *    minted the brand. A role denied that column and granted `message_bodies` passed. §6a
 *    builds exactly that role and requires a refusal; §6b builds one whose only excess is
 *    invisible to BOTH bite tests, so only the census can catch it.
 *  · **The second finding** — the rerun mutation added a DIRECT grant, which is the one kind
 *    `REVOKE … FROM ohmail_admin` repairs. §6c–§6g grant through an inherited role, through
 *    predefined `pg_read_all_data`, through `PUBLIC`, through OWNERSHIP, and through the
 *    `SUPERUSER` attribute, and require the shipped script to repair each one or roll back
 *    loudly. Every one of them left the script committing under a false "START FROM ZERO".
 *
 * ── THE MUTATIONS THIS FILE IS DESIGNED TO CATCH ──────────────────────────────────────────
 *
 *  (a) add `subject` to the `messages` stanza of the script → the denial and the census fail.
 *  (b) point {@link staffUrl} at the OWNER role → every denial fails, which is what proves the
 *      denials come from the role and not from a stub that would answer 42501 to anything.
 *  (c) delete the body of `assertContentBlind` → "the boot probe refuses the runtime
 *      connection" fails.
 *  (d) delete the census from `assertContentBlind`, keeping the bite tests → §6b fails.
 *  (e) delete §1c (memberships) / §1d (ownership) / §12 (PUBLIC) / §13 (the postcondition)
 *      from the script → §6c / §6f / §6e / the vacuity check fail, one each.
 *
 * ── + THE ORACLE THAT SURVIVED EVERY COLUMN CHECK IN THIS FILE ────────────────
 *
 * A review pass asked one question of the state this file had shipped — *can the staff role
 * still learn whether a given account received a given message?* — and answered yes twice, from
 * relations that carry no content at all:
 *
 *  · **A high finding.** `messages(id, mailbox_id)` IS the oracle. Resolve the target's `mailbox_id`
 *    from `mailboxes`, read `count(*)`, deliver a probe, poll, observe the delta. `count(*)`
 *    NAMES NO COLUMN, so a two-column grant is minimal as a projection and sufficient as a
 *    channel. **This file asserted that grant's presence as a POSITIVE result in three places.**
 *  · **A medium finding.** `change_log.entity_id → messages.id → mailboxes.id` reconstructs which
 *    account, which message, which operation and when.
 *
 * `messages`, `change_log`, `folder_state` and `flag_state` now have NO grant, the redaction
 * keeps only a namespace token, and **§7 is the guard that would have caught both**: it sweeps
 * every value the role can select, delivers a chosen message to one of two identical accounts,
 * sweeps again, and requires the two sweeps to be byte-identical. Four more mutations, all
 * watched red:
 *
 *  (i) restore `GRANT SELECT (id, mailbox_id) ON public.messages` → §0's converted assertions,
 *      three `DENIED_READS` rows, the census equality, the boot attestation's excess check, and
 *      §7 (on the `messages` line of the sweep) all fail.
 *  (j) restore the `change_log` grant → §7 fails on the `change_log` line, and `lastActivityAt`
 *      stops being null.
 *  (k) restore `folder_state`/`flag_state` → §7 fails on those lines.
 *
 * §7 also proves its own instrument: after asserting equality it inserts one `alert_state` row
 * — the one table this role reads and writes — and requires the sweep to CHANGE. An equality
 * between two measurements that cannot vary is not evidence.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const SCRIPT = join(REPO, "scripts", "harden-staff-role.sql");
const MAIL_DIR = join(HERE, "..", "..", "db-mail", "drizzle");
const CLOUD_DIR = join(HERE, "..", "drizzle-cloud");

const ADMIN_URL = PG_TEST_URL;

/** A throwaway database with a RANDOM suffix — the `*.pg.test.ts` files share one Postgres. */
const SUFFIX = randomUUID().replace(/-/g, "").slice(0, 12);
const DB_NAME = `ohmail_staff_role_${SUFFIX}`;

/** Test-local, and the reason the shipped script carries no password: it is set out of band. */
const STAFF_PASSWORD = `staff_password_${SUFFIX}`;

const PG_UP = await realPgAvailable(ADMIN_URL);

function urlFor(dbName: string, role?: { user: string; password: string }): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  if (role) {
    u.username = role.user;
    u.password = role.password;
  }
  return u.toString();
}

/** The URL the STAFF connection uses. Mutation (b) points this at the database owner. */
const staffUrl = (): string => urlFor(DB_NAME, { user: STAFF_ROLE, password: STAFF_PASSWORD });

/* ════════════════════════════════════════════════════════════════════════════════════════
   THE ALLOWLIST — imported, not restated. See `packages/db/src/staff-grants.ts`.
   ════════════════════════════════════════════════════════════════════════════════════════

   It is still two independent statements of the same fact: the GRANT stanzas in the shipped
   script, and `STAFF_SELECT_GRANTS`. Adding a column to one without the other fails, and the
   failure names the column. What changed in that change is which two — the second statement moved out
   of this test file and into `src/`, because the BOOT ATTESTATION has to compare against it
   too, and an allowlist that lived in a test could only ever be checked in CI.

   These three helpers narrow the schema-qualified allowlist to the shape the database-owner side
   `information_schema` censuses below already speak. */
function bySchema(
  grants: Readonly<Record<string, readonly string[]>>, schema: string,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(grants)) {
    const [ns, relation] = key.split(".");
    if (ns === schema) out[relation!] = [...values].sort();
  }
  return out;
}

/** Column grants on `public`, table name → sorted columns. */
const GRANTED_COLUMNS = bySchema(STAFF_SELECT_GRANTS, "public");

/** The ONE table this role writes, at TABLE level. `alert_state` and its one un-scopable verb. */
const GRANTED_WRITES = bySchema(STAFF_TABLE_GRANTS, "public");

/** Each `admin` view's own named scalars. No `payload`, no `inverse`, no raw `source`. */
const ADMIN_VIEW_COLUMNS = bySchema(STAFF_SELECT_GRANTS, "admin");

/** The digest §7's sweep hashes a chosen Message-ID with, to prove it is nowhere. */
const shortHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);

/**
 * Denials, as (label, statement). `WHERE false` on every one: Postgres checks column
 * privileges when it PLANS, so the refusal arrives without reading a row.
 */
const DENIED_READS: ReadonlyArray<readonly [string, string]> = [
  /* ── THE ROW, NOT THE COLUMN ──────────────────────────────────────────────────────────────
     `messages.id` and `messages.mailbox_id` were GRANTED for three slices, and the pg guard
     asserted their presence as a positive result. The oracle needs neither of them by name:
     `count(*)` names no column, so the third entry here is the one that would still bite if
     somebody re-added a single "harmless" id column to make a join work.

     `change_log`, `folder_state` and `flag_state` join to `messages.id` and carry per-message
     event times; the medium finding is the reconstruction that follows. None of the four has a grant now. */
  ["messages.id", "select id from messages where false"],
  ["messages.mailbox_id", "select mailbox_id from messages where false"],
  ["messages count(*) — the ROW is the oracle, and count names no column",
    "select count(*) from messages"],
  ["change_log.*", "select * from change_log where false"],
  ["change_log.entity_id — the join key to messages.id",
    "select entity_id from change_log where false"],
  ["change_log.created_at — a per-account event time to the second",
    "select created_at from change_log where false"],
  ["folder_state.*", "select * from folder_state where false"],
  ["folder_state.message_id", "select message_id from folder_state where false"],
  ["folder_state count(*)", "select count(*) from folder_state"],
  ["flag_state.*", "select * from flag_state where false"],
  ["flag_state count(*)", "select count(*) from flag_state"],
  ["messages.subject", "select subject from messages where false"],
  ["messages.snippet", "select snippet from messages where false"],
  ["messages.from_address", "select from_address from messages where false"],
  ["messages.to_addresses", "select to_addresses from messages where false"],
  ["messages.cc_addresses", "select cc_addresses from messages where false"],
  ["messages.message_id_header", "select message_id_header from messages where false"],
  // The subtle one: generated from subject + from_address, and its lexemes reconstruct both.
  ["messages.subject_tsv", "select subject_tsv from messages where false"],
  ["messages.*", "select * from messages where false"],
  ["message_bodies", "select * from message_bodies where false"],
  // `root_message_id_header` carries sender domains.
  ["threads", "select * from threads where false"],
  ["drafts", "select * from drafts where false"],
  ["contacts", "select * from contacts where false"],
  ["kb_entries", "select * from kb_entries where false"],
  ["attachments", "select * from attachments where false"],
  ["snippets", "select * from snippets where false"],
  ["contact_notes", "select * from contact_notes where false"],
  ["thread_notes", "select * from thread_notes where false"],
  ["routing_decisions", "select * from routing_decisions where false"],
  ["rules", "select * from rules where false"],
  ["tracker_events", "select * from tracker_events where false"],
  ["mailbox_folders", "select * from mailbox_folders where false"],
  // ── FUNNEL TOP: the DATE columns are granted (§9d); the PII columns MUST STILL 42501. ─────
  //   This is the non-vacuity guard the grant's approval required: adding an email column to
  //   the funnel's select fails HERE, by name, which is what stops a later hand widening a
  //   counts-only grant into a leak of a not-yet-customer's address or a live invite secret.
  ["invites.email — the binding address of a non-customer, NEVER granted",
    "select email from invites where false"],
  ["invites.code_hash — a live invite secret", "select code_hash from invites where false"],
  ["invites.* — the whole row includes the address and the secret",
    "select * from invites where false"],
  ["waitlist.email — a prospect's address", "select email from waitlist where false"],
  ["waitlist.tier — not projected by the funnel", "select tier from waitlist where false"],
  ["waitlist.* — includes the address", "select * from waitlist where false"],
  ["workflows", "select * from workflows where false"],
  ["mailbox_credentials.secret_enc", "select secret_enc from mailbox_credentials where false"],
  ["mailbox_credentials.meta", "select meta from mailbox_credentials where false"],
  ["change_log.meta", "select meta from change_log where false"],
  ["outbound_sends.idempotency_key", "select idempotency_key from outbound_sends where false"],
  ["outbound_sends.minted_message_id", "select minted_message_id from outbound_sends where false"],
  ["folder_state.desired_folder", "select desired_folder from folder_state where false"],
  // The audit TABLE. Only `admin.audit_log`, the security_barrier view, is reachable.
  ["public.audit_log", "select * from public.audit_log where false"],
  ["public.audit_log.payload", "select payload from public.audit_log where false"],
  // Every table that stores or gates a live credential.
  ["sessions", "select * from sessions where false"],
  ["credentials", "select * from credentials where false"],
  ["webauthn_credentials", "select * from webauthn_credentials where false"],
  ["totp_secrets", "select * from totp_secrets where false"],
  ["recovery_codes", "select * from recovery_codes where false"],
  ["refresh_tokens", "select * from refresh_tokens where false"],
  ["login_tokens", "select * from login_tokens where false"],
  ["oauth_auth_codes", "select * from oauth_auth_codes where false"],
  // ── Cloud 0047's grants: the organizer facts are granted, the holder's NAME never is. ──────
  ["mailboxes.organized_by_name — a customer's machine name, NEVER granted",
    "select organized_by_name from mailboxes where false"],
  ["mailboxes.organized_by_capabilities — a header value", "select organized_by_capabilities from mailboxes where false"],
  ["mailboxes.organized_by_install_id — a lease header value", "select organized_by_install_id from mailboxes where false"],
  ["credit_refund_obligations.meta — the spend's provenance", "select meta from credit_refund_obligations where false"],
  ["credit_refund_obligations.attempt", "select attempt from credit_refund_obligations where false"],
  ["staff_users — the credentials that protect the console", "select * from staff_users where false"],
  ["staff_sessions", "select * from staff_sessions where false"],
  ["staff_role_grants — who may do what is read by the API, never the console's role",
    "select * from staff_role_grants where false"],
];

const DENIED_WRITES: ReadonlyArray<readonly [string, string]> = [
  ["update accounts", "update accounts set name = name where false"],
  ["update mailboxes", "update mailboxes set status = status where false"],
  ["update messages", "update messages set mailbox_id = mailbox_id where false"],
  ["delete accounts", "delete from accounts where false"],
  ["insert audit_log", "insert into public.audit_log (account_id, action) values (null, 'x')"],
  ["truncate alert_state", "truncate alert_state"],
  // The staff audit is read here and written only by the API's runtime connection.
  ["insert staff_audit_events", "insert into staff_audit_events (request_id, staff_user_id, actor_label, roles, action, outcome) values (gen_random_uuid(), gen_random_uuid(), 'x', '{}', 'read.overview', 'ok')"],
  ["delete staff_audit_events", "delete from staff_audit_events where false"],
];

interface Seeded {
  accountId: string;
  mailboxId: string;
  messageId: string;
}

function sqlstateOf(err: unknown): string | null {
  const direct = (err as { code?: unknown } | null)?.code;
  if (typeof direct === "string") return direct;
  const nested = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof nested === "string" ? nested : null;
}

describe.skipIf(!PG_UP)("ohmail_admin is content-blind, and the console still works", () => {
  let root: ReturnType<typeof postgres>;
  let ownerClient: ReturnType<typeof postgres>;
  let owner: PostgresJsDatabase<typeof schema>;
  let staffClient: ReturnType<typeof postgres>;
  let staff: AdminDb;
  let seeded: Seeded;
  let scriptText: string;

  beforeAll(async () => {
    root = postgres(ADMIN_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
    await root.unsafe(`drop database if exists "${DB_NAME}" with (force)`);
    await root.unsafe(`create database "${DB_NAME}"`);

    ownerClient = postgres(urlFor(DB_NAME), { max: 1, onnotice: () => {} });
    owner = brandDialect(drizzle(ownerClient, { schema }), "pg");
    await migrate(owner, { migrationsFolder: MAIL_DIR, migrationsSchema: "drizzle_mail" });
    await migrate(owner, { migrationsFolder: CLOUD_DIR, migrationsSchema: "drizzle_cloud" });

    seeded = await seedWorld(owner);

    // ── THE SHIPPED ARTIFACT, VERBATIM ────────────────────────────────────────────────────
    scriptText = readFileSync(SCRIPT, "utf8");
    await ownerClient.unsafe(scriptText).simple();
    // The one thing the script deliberately omits, because a committed password is a leaked
    // password. On Neon this is `ALTER ROLE ohmail_admin PASSWORD '…'` typed by a human.
    await ownerClient.unsafe(
      `alter role ${STAFF_ROLE} password '${STAFF_PASSWORD}'`,
    );

    staffClient = postgres(staffUrl(), { max: 1, onnotice: () => {} });
    staff = brandDialect(drizzle(staffClient, { schema }), "pg") as unknown as AdminDb;
  }, 300_000);

  afterAll(async () => {
    await staffClient?.end({ timeout: 5 }).catch(() => {});
    await ownerClient?.end({ timeout: 5 }).catch(() => {});
    await root?.unsafe(`drop database if exists "${DB_NAME}" with (force)`).catch(() => {});
    await root?.end({ timeout: 5 }).catch(() => {});
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  /* ══ 0. The run is not vacuous ═══════════════════════════════════════════════════════ */

  it("ran the SHIPPED script — not a reimplementation, and not an empty file", () => {
    // A truncated or renamed script would make every denial below pass for the wrong reason:
    // a role with no grants refuses everything. The positive half is the real defence against
    // that, and this is the cheap one that names the cause.
    expect(scriptText.length).toBeGreaterThan(4_000);
    expect(scriptText).toContain(`CREATE ROLE ${STAFF_ROLE} LOGIN`);
    expect(scriptText).toContain("CREATE VIEW admin.audit_log WITH (security_barrier)");
    // No `ALTER DEFAULT PRIVILEGES` STATEMENT: a new TABLE must stay invisible until it is
    // granted explicitly. Comments are stripped first — the script explains at length why it
    // does not use one, and a scanner that punished it for saying so would be answered by
    // deleting the explanation rather than by fixing anything.
    const statements = scriptText.replace(/^\s*--.*$/gm, " ");
    expect(statements).not.toContain("ALTER DEFAULT PRIVILEGES");
    // …and the strip is not eating the whole file.
    expect(statements).toContain("GRANT SELECT (id, name, ai_enabled, created_at, erased_at) ON public.accounts");
    // §13. Deleting the postcondition would leave every §6 test below passing on the
    // repairs alone, with nothing proving the script cannot COMMIT while it is false.
    expect(statements).toContain("POSTCONDITION FAILED");

    /* ── THE FOUR RELATIONS THAT MUST HAVE NO GRANT AT ALL ──────────
       CONVERTED, not added. Two assertions here used to read

           expect(scriptText).toContain("GRANT SELECT (id, mailbox_id) ON public.messages")

       and they were the proof that the column sweep had worked. They encoded the wrong reading
       of that change: a two-column grant is minimal as a projection and still a receipt oracle, because
       `count(*)` names no column. They now pin the opposite, and they are checked against the
       COMMENT-STRIPPED text so that the script's own prose about the grant it no longer makes
       cannot satisfy them. */
    // Runs of whitespace collapsed, so the assertions cannot be broken by aligning a column of
    // `FROM`s — the script does exactly that for the `folder_state`/`flag_state` pair.
    const flat = statements.replace(/\s+/g, " ");
    for (const relation of ["messages", "change_log", "folder_state", "flag_state"]) {
      expect(flat, `§2's blanket revoke is not enough — ${relation} needs its own REVOKE`)
        .toContain(`REVOKE ALL ON public.${relation} FROM ${STAFF_ROLE}`);
      expect(flat, `public.${relation} is GRANTED — the grant rule says not one column`)
        .not.toContain(`ON public.${relation} TO ${STAFF_ROLE}`);
    }
  });

  it("connected AS the staff role — so every denial below is the role's answer", async () => {
    const [row] = await staffClient.unsafe<Array<{ who: string }>>("select current_user as who");
    expect(row?.who).toBe(STAFF_ROLE);
  });

  /* ══ 1. Denials ══════════════════════════════════════════════════════════════════════ */

  it.each(DENIED_READS)("REFUSES to read %s", async (_label, statement) => {
    const err = await staffClient.unsafe(statement).then(() => null, (e: unknown) => e);
    expect(err, `${statement} SUCCEEDED — the staff role can read this`).not.toBeNull();
    expect(sqlstateOf(err)).toBe(DENIED_SQLSTATE);
  });

  it.each(DENIED_WRITES)("REFUSES to %s", async (_label, statement) => {
    const err = await staffClient.unsafe(statement).then(() => null, (e: unknown) => e);
    expect(err, `${statement} SUCCEEDED — the staff role can write this`).not.toBeNull();
    // A TRUNCATE refusal is 42501 too; ownership checks report the same class.
    expect(sqlstateOf(err)).toBe(DENIED_SQLSTATE);
  });

  /* ══ 2. Positives — in the SAME run, so an over-revoke cannot pass as green ═══════════ */

  it("ANSWERS the reads the console lives on", async () => {
    const [counted] = await staffClient.unsafe<Array<{ n: string }>>(
      "select count(*) as n from accounts",
    );
    expect(Number(counted?.n)).toBeGreaterThan(0);

    /* CONVERTED — a review finding. This assertion used to be

         const rows = await staffClient.unsafe("select id, mailbox_id from messages");
         expect(rows).toHaveLength(1);
         expect(rows[0]!.mailbox_id).toBe(seeded.mailboxId);

       and it lived in the POSITIVE section, as evidence that the narrowest grant in the script
       worked. That is exactly the finding: the row it asserted the presence of is the receipt
       fact. It now asserts the mailbox roster instead — a legitimately staff-visible read on the
       same seeded world, so the positive half still proves the run is not an over-revoke — and
       the `messages` half moved to {@link DENIED_READS}. */
    const boxes = await staffClient.unsafe<Array<{ id: string; address: string }>>(
      "select id, address from mailboxes",
    );
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.id).toBe(seeded.mailboxId);
  });

  /**
   * THE FUNNEL COLUMNS ARE READABLE — the positive half of §9d, in the same run as the denials
   * of `invites.email` / `waitlist.email` above. An over-revoke that took the date columns too
   * would pass every denial and fail HERE; the census-equality test then pins that the grant is
   * EXACTLY these columns and no more.
   */
  it("reads the funnel DATE columns on invites and waitlist, and nothing else on them", async () => {
    const invites = await staffClient.unsafe<Array<{ created_at: unknown }>>(
      "select created_at, consumed_at, revoked_at from invites where false",
    );
    expect(Array.isArray(invites)).toBe(true);
    const waiting = await staffClient.unsafe<Array<{ created_at: unknown }>>(
      "select created_at, invited_at from waitlist where false",
    );
    expect(Array.isArray(waiting)).toBe(true);
  });

  it("reads `audit_log` through the VIEW — qualified, and unqualified via search_path", async () => {
    // Qualified: what the script created.
    const viaSchema = await staffClient.unsafe<Array<{ action: string }>>(
      "select action from admin.audit_log",
    );
    expect(viaSchema.map((r) => r.action)).toEqual(["admin.account.suspend"]);

    // UNQUALIFIED — which is what drizzle emits for `pgTable("audit_log", …)`. This is the
    // mechanism that lets ONE query in `admin-service.ts` serve the staff role and the PGlite
    // harness. `search_path = admin, public` is set on the role by the script.
    const viaPath = await staffClient.unsafe<Array<{ action: string }>>(
      "select action from audit_log",
    );
    expect(viaPath.map((r) => r.action)).toEqual(["admin.account.suspend"]);

    // …and the view FILTERS: the product's own domain audit row is in the table and not here.
    const [total] = await ownerClient.unsafe<Array<{ n: string }>>(
      "select count(*) as n from public.audit_log",
    );
    expect(Number(total?.n)).toBe(2);
  });

  /**
   * THE ACCEPTANCE CRITERION, RUN LOCALLY: every admin read returns the seeded data while
   * every denial above holds. This is what makes "the console works content-blind" a fact
   * rather than a hope pinned on a production smoke test.
   */
  it("serves all FIVE admin reads, and the alert pass, as the blind role", async () => {
    const now = new Date();

    const page = await adminAccounts(staff, now, {}, { roles: ["owner"] });
    expect(page.total).toBe(1);
    expect(page.accounts[0]!.id).toBe(seeded.accountId);
    expect(page.accounts[0]!.ownerEmail).toBe("owner@example.test");
    expect(page.accounts[0]!.mailboxCount).toBe(1);
    /* CONVERTED — This read `expect(page.accounts[0]!.lastActivityAt).toBeTruthy()` on
       the strength of the `change_log` grant. `pipeline.ts` writes a `change_log` row for every
       ingested message, so one account's newest-change stamp advancing is a receipt confirmation
       at second resolution; no bucket fixes a value whose population is one account. The grant
       is gone and the field is null — see `admin-service.ts:loadRoster`. The seeded world DOES
       have a `change_log` row (see `seedWorld`), so a null here is the redaction and not an
       empty table. */
    expect(page.accounts[0]!.lastActivityAt).toBeNull();
    const [changes] = await ownerClient.unsafe<Array<{ n: string }>>(
      "select count(*) as n from change_log");
    expect(Number(changes?.n), "no change_log row was seeded — the null above proves nothing")
      .toBeGreaterThan(0);

    const detail = await adminAccountDetail(staff, now, seeded.accountId, { roles: ["owner"] });
    expect(detail).not.toBeNull();
    expect(detail!.mailboxes).toHaveLength(1);
    expect(detail!.mailboxes[0]!.hasImapCredential).toBe(true);
    /* CONVERTED — This read `.pendingMoves).toBe(1)`, which is the row-existence fact
       itself: the 1 came from joining `folder_state → messages` for `mailbox_id`. Both grants are
       gone. The seeded `folder_state` row is still `pending` (asserted below), so the 0 is the
       redaction rather than an empty table. */
    expect(detail!.mailboxes[0]!.pendingMoves).toBe(0);
    expect(detail!.mailboxes[0]!.oldestPendingMoveSeconds).toBeNull();
    const [pending] = await ownerClient.unsafe<Array<{ n: string }>>(
      "select count(*) as n from folder_state where reconcile_status = 'pending'");
    expect(Number(pending?.n), "no pending folder_state row was seeded — the 0 proves nothing")
      .toBeGreaterThan(0);
    expect(detail!.audit).toHaveLength(1);
    expect(detail!.audit[0]!.action).toBe("admin.account.suspend");
    expect(detail!.audit[0]!.payload).toEqual({});
    // Nothing seeded as mail content reached the response, on a database that has it.
    expect(JSON.stringify(detail)).not.toContain("ZZSUBJECTZZ");
    expect(JSON.stringify(detail)).not.toContain("ZZSENDERZZ");

    const worker = await adminWorker(staff, now, { roles: ["owner"] });
    expect(worker.instances).toHaveLength(1);
    expect(worker.roster).toHaveLength(1);
    // CONVERTED — Was `.toBe(1)`, from the same `folder_state ⋈ messages` join. The
    // cluster-wide number is the one shape that COULD be aggregated safely; it is not built here
    // because it has no `public` counterpart to shadow. `admin-service.ts:adminWorker` carries
    // the D=15min / k=5 design and the reason it belongs in `worker_heartbeats`.
    expect(worker.pendingMoves).toEqual({ total: 0, mailboxes: 0, oldestSeconds: null });
    expect(worker.staleSends).toHaveLength(1);
    expect(JSON.stringify(worker)).not.toContain("ZZIDEMPOTENCYZZ");

    const actions = await adminActions(staff, now, { roles: ["owner"] });
    expect(actions.actions).toHaveLength(2);
    // The catalog the blind role reads, with no widened grant. `resync_mailbox` is the property
    // this line pins: clearing `mailboxes.retry_after` is a write the RUNTIME connection
    // performs, and the action's target list is the same two-column mailbox read this role
    // already had — a new available action must not have widened its grants.
    const available = new Set(actions.actions.filter((a) => a.available).map((a) => a.id));
    expect(available).toEqual(new Set(["resync_mailbox"]));

    const alerts = await adminAlerts(staff, now);
    expect(alerts.map((a) => a.kind)).toContain("sends_stuck");

    // THE FUNNEL runs on the blind role — its three stage queries read `accounts`,
    // `users.email_verified_at` and `mailboxes`, and its top reads the invite/waitlist DATE
    // grant. A missing grant would raise 42501 out of this call, not just miss a field.
    const funnel = await adminFunnel(staff, now);
    expect(funnel.stages.map((s) => s.key)).toEqual(["signup", "verified", "connected"]);
    expect(funnel.stages[0]!.count).toBeGreaterThanOrEqual(1);
    expect(typeof funnel.invites.outstanding).toBe("number");
    expect(typeof funnel.waitlist.waiting).toBe("number");
    expect(JSON.stringify(funnel)).not.toContain("@");
  });

  /**
   * THE CONSOLE'S CROSS-ACCOUNT READS, AS THE BLIND ROLE, WITH NO GRANT ADDED FOR THEM. Each one
   * names only columns the shipped script already grants; a column outside the allowlist raises
   * 42501 out of the call, and the census below stays an equality. The rows the reads need beyond
   * the seeded world are written through the database-owner connection, under keys no alert rule reads.
   */
  it("serves the batch, the sync roster, the funnel window, engagement, storage, the staff trail and resolved alerts", async () => {
    const now = new Date();
    const batch = await adminAccountsByIds(staff, now, [seeded.accountId], { roles: ["owner"] });
    expect(batch.rows.map((r) => r.id)).toEqual([seeded.accountId]);

    const roster = await adminSyncRoster(staff, now, null, 500);
    const mine = roster.rows.find((r) => r.accountId === seeded.accountId)!;
    expect(mine.createdAt).toBeTruthy();
    expect(mine.firstMailboxAt).toBeTruthy();
    expect(mine.emailVerifiedAt).toBeNull();

    const funnel = await adminFunnel(staff, now, { from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + 60_000) });
    expect(funnel.window).toMatchObject({ signedUp: 1, verified: 0, connected: 1 });

    expect((await adminEngagement(staff, now)).activeAccounts.d1).toBe(1);

    await ownerClient.unsafe(`insert into account_storage (account_id, bytes) values ('${seeded.accountId}', 2048)`);
    expect(await adminStorage(staff, now, null, 500)).toMatchObject({ totalBytes: 2048, measuredAccounts: 1 });

    const staffId = randomUUID();
    await ownerClient.unsafe(`insert into staff_users (id, email, password_hash) values ('${staffId}', 'role-test@example.test', 'x')`);
    await ownerClient.unsafe(`insert into staff_audit_events (request_id, staff_user_id, actor_label, roles, action, outcome, target_account_id)
      values (gen_random_uuid(), '${staffId}', 'role-test@example.test', '{owner}', 'write.mailbox.resync', 'ok', '${seeded.accountId}')`);
    const feed = await adminStaffFeed(staff, now, { staffId, roles: ["owner"] }, {
      cursor: null, actor: null, action: null, account: seeded.accountId, outcome: null, from: null, to: null, reads: false,
    });
    expect(feed.rows.map((r) => r.action)).toEqual(["write.mailbox.resync"]);

    await ownerClient.unsafe(`insert into alert_state (alert_key, kind, severity, opened_at, last_seen_at, resolved_at, notify_count)
      values ('api_fault_rate:api:/staff-role-test', 'api_fault_rate', 'warning', now() - interval '3 hours',
              now() - interval '2 hours', now() - interval '1 hour', 0)`);
    const resolved = await adminLatestResolvedAlerts(staff, now, { from: new Date(now.getTime() - 86_400_000), to: now });
    expect(resolved.latestResolved.map((r) => r.key)).toContain("api_fault_rate:api:/staff-role-test");
  });

  it("runs the ALERT PASS as the blind role — the one table it writes", async () => {
    const now = new Date();
    const seen: string[][] = [];
    const pass = await runAlertPass(staff, {
      now,
      sinks: [{ name: "spy", notify: async (a) => { seen.push(a.map((x) => x.key)); return true; } }],
      source: "api",
      environment: "test",
    });
    // INSERT happened — two rules fire on the seeded world: `sends_stuck` (the pending
    // outbound send) is an INCIDENT, and `device_sync_stale` (the paired device whose mirror
    // never converged while its account kept syncing) is a SIGNAL. The signal is seeded on
    // purpose: it is the one class whose delivery rule this file can only prove on the blind
    // role, and its rule reads `devices`/`sessions` columns that are on this role's allowlist
    // and nowhere else.
    expect(pass.firing.map((a) => a.kind).sort())
      .toEqual(["device_sync_stale", "sends_stuck"]);
    const open = await listOpenAlerts(staff);
    expect(open.map((o) => o.kind).sort()).toEqual(["device_sync_stale", "sends_stuck"]);

    // ── THE INCIDENT/SIGNAL SPLIT, THROUGH THE BLIND ROLE, ON REAL POSTGRES ──────────────
    //
    // The split is unit-tested against PGlite elsewhere. What only this file can establish is
    // that it holds when the pass runs as `ohmail_admin`: `cls` is a column the blind role must
    // both READ and WRITE, and a missing grant is 42501 on the whole pass rather than on one
    // rule. A green here is the grant and the gate agreeing.
    const bySplit = (c: string) => open.filter((o) => o.cls === c).map((o) => o.kind).sort();
    expect(bySplit("incident")).toEqual(["sends_stuck"]);
    expect(bySplit("signal")).toEqual(["device_sync_stale"]);

    // UPDATE happened — the claim and the settle both wrote `notified_at`, FOR THE INCIDENTS.
    // The signal's stays null, and that is the invariant rather than an omission: `notified_at`
    // means "a human was told", so a signal that stamped it would make a later promotion of the
    // same key look like an already-confirmed page.
    for (const o of open) {
      if (o.cls === "signal") expect(o.notifiedAt).toBeNull();
      else expect(o.notifiedAt).not.toBeNull();
    }
    // ONE delivery, carrying the incident ONLY — the sink never sees the signal.
    expect(seen).toHaveLength(1);
    expect([...seen[0]!].sort()).toEqual(["sends_stuck"]);

    // DELETE happens when a condition clears, and it is the verb most easily left out of a
    // grant: without it every resolving alert raises 42501 and the whole pass 503s, which is a
    // pager that dies exactly when the incident ends. Clear both conditions and watch the rows
    // go. (The clearing writes go through the OWNER — the staff role cannot touch those tables,
    // which is itself asserted above.)
    await ownerClient.unsafe("update outbound_sends set status = 'sent'");
    const cleared = await runAlertPass(staff, { now, sinks: [], source: "api", environment: "test" });
    expect(cleared.resolved.sort()).toEqual(["sends_stuck"]);
    // The DELETE is SELECTIVE, which is a stronger statement than the empty table this used to
    // assert: the resolved incident is gone and the still-firing signal is untouched. A pass
    // that cleared every row would satisfy "the rows go" and would silently drop a live
    // observation on its way past.
    expect((await listOpenAlerts(staff)).map((o) => o.kind)).toEqual(["device_sync_stale"]);

    // Put the world back, so the order these `it`s run in cannot matter to a later reader.
    await ownerClient.unsafe("update outbound_sends set status = 'pending'");
  });

  it("the API arm's pass records its gap history as the blind role (cloud 0048)", async () => {
    // The pass swallows a failed stamp by contract, so a missing grant reads as "no gap" here
    // unless the rows are read back on the database-owning connection. Both come from one statement.
    const first = new Date(Date.UTC(2026, 9, 17, 12, 0, 0));
    const second = new Date(first.getTime() + 90_000);
    for (const now of [first, second]) {
      await runAlertPass(staff, { now, sinks: [], source: "api", environment: "test", driver: "api" });
    }
    const runs = await ownerClient.unsafe<Array<{ ran_at: Date }>>(
      "select ran_at from alert_pass_runs where driver = 'api'");
    expect(runs.map((r) => new Date(r.ran_at).toISOString())).toEqual([second.toISOString()]);
    const gaps = await ownerClient.unsafe<Array<{ passes: number; max_gap_s: number }>>(
      "select passes, max_gap_s from alert_driver_gaps where driver = 'api' and day = '2026-10-17'");
    expect(gaps).toEqual([{ passes: 2, max_gap_s: 90 }]);
    await ownerClient.unsafe("delete from alert_driver_gaps; delete from alert_pass_runs");
  });

  /* ══ 3. The census — equality, so a grant nobody asserted still fails ════════════════ */

  it("the SELECT-able set EQUALS the allowlist, column for column", async () => {
    // The schema filter is in a MATERIALIZED cte, not a sibling qual. `has_column_privilege`
    // raises 42703 for a column that is not on the relation it is handed, and a planner is free
    // to evaluate the function before the filter — which made the first version of this query
    // die on `public.audit_log.payload` while asking about a view in another schema.
    const rows = await ownerClient.unsafe<Array<{ table_name: string; column_name: string }>>(`
      with cols as materialized (
        select c.table_name, c.column_name
          from information_schema.columns c
          join information_schema.tables t
            on t.table_schema = c.table_schema and t.table_name = c.table_name
         where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      )
      select table_name, column_name from cols
       where has_column_privilege(
               '${STAFF_ROLE}', format('public.%I', table_name)::regclass, column_name, 'SELECT')
       order by 1, 2`);

    const actual: Record<string, string[]> = {};
    for (const r of rows) (actual[r.table_name] ??= []).push(r.column_name);

    const expected: Record<string, string[]> = {};
    for (const [t, cols] of Object.entries(GRANTED_COLUMNS)) expected[t] = [...cols].sort();

    // Table set first: the failure message then names the TABLE somebody opened up, which is
    // the actionable half. `has_column_privilege` sees table-level grants too, so a
    // `GRANT SELECT ON contacts` added during an incident lands here as a whole new key.
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const table of Object.keys(expected)) {
      expect(actual[table], `column grants on ${table} drifted`).toEqual(expected[table]);
    }
  });

  /**
   * THE WRITE VERBS ARE COLUMN-SCOPED, AND A COLUMN NOBODY REVIEWED IS NOT WRITABLE.
   *
   * `GRANT INSERT, UPDATE, DELETE ON public.alert_state` had no column list, sitting directly
   * under an 8-column-scoped SELECT — the only asymmetry of its kind in the script. It granted
   * nothing extra on the day it was written, because the SELECT list happens to name every
   * column the table has; what it granted was the next migration. A column added to
   * `alert_state` became writable by this deliberately BLIND role automatically while staying
   * unreadable, and the table-level census above cannot tell the difference.
   *
   * So this asserts what the census cannot: the column-level INSERT and UPDATE sets are EXACTLY
   * the granted SELECT columns. Widen either grant back to the whole table and this goes red on
   * the table-level census; add a ninth column to `alert_state` without deciding about it and
   * this one goes red instead — which is the point.
   *
   * `has_column_privilege` sees table-level grants too, so this is also a second, independent
   * statement of the table-level assertion below.
   */
  it("INSERT and UPDATE on `alert_state` name exactly the granted SELECT columns", async () => {
    const granted = [...(STAFF_SELECT_GRANTS["public.alert_state"] ?? [])].sort();
    expect(granted.length, "the fixture itself must not be empty").toBeGreaterThan(0);

    for (const verb of ["INSERT", "UPDATE"] as const) {
      const rows = await ownerClient.unsafe<Array<{ column_name: string }>>(`
        with cols as materialized (
          select column_name from information_schema.columns
           where table_schema = 'public' and table_name = 'alert_state'
        )
        select column_name from cols
         where has_column_privilege('${STAFF_ROLE}', 'public.alert_state'::regclass, column_name, '${verb}')
         order by 1`);
      expect(rows.map((r) => r.column_name), `${verb} columns on alert_state drifted`)
        .toEqual(granted);
    }
  });

  /**
   * …AND THE PASS STILL WORKS, which is the half a grant audit cannot answer.
   *
   * Narrowing a grant is only correct if the code that needed it still runs, so this performs
   * the writes `runAlertPass` performs, as the staff role itself: open (INSERT), claim and
   * settle (UPDATE), and resolve — which is now an UPDATE too. A column the pass writes but the
   * grant omits shows up here as a permission error rather than in production as a pager that dies with the
   * incident.
   *
   * THE THIRD WRITE USED TO BE A DELETE, and this case asserted it succeeded. Resolution marks
   * `resolved_at` now, the tombstone prune that briefly needed the verb is gone, and the grant
   * went with it — so the case is inverted: the delete must be REFUSED. That inversion is the
   * point rather than an accident of bookkeeping. Cloud 0030 permits a pre-0030 driver to keep
   * running through a rolling deploy, and that driver's resolution path is a DELETE over this
   * same role; it would remove the row a delayed new-build observation fences against, which
   * then takes the unfenced INSERT branch and pages a resolved incident. The revocation is what
   * makes that impossible, and this is where it is proven.
   */
  it("the alert pass's writes succeed as the staff role — and its DELETE is refused", async () => {
    const key = "b1e_grant_scope_probe";
    await staffClient.unsafe(
      `insert into alert_state (alert_key, kind, severity, opened_at, last_seen_at, notify_count, detail)
         values ('${key}', 'probe', 'critical', now(), now(), 0, 'grant-scope probe')`);
    await staffClient.unsafe(
      `update alert_state set last_seen_at = now(), notified_at = now(), notify_count = notify_count + 1,
              severity = 'critical', kind = 'probe', detail = 'grant-scope probe'
        where alert_key = '${key}'`);
    // Resolution, as the pass performs it now: a fenced UPDATE that marks and blanks.
    const marked = await staffClient.unsafe<Array<{ alert_key: string }>>(
      `update alert_state set resolved_at = now(), detail = null
        where alert_key = '${key}' returning alert_key`);
    expect(marked.map((r) => r.alert_key), "resolution is an update and it is granted")
      .toEqual([key]);

    // AND THE OLD PATH IS CLOSED. An old bundle running this statement is the one thing that can
    // still remove a live fence, so the role must not be able to.
    const refused = await staffClient
      .unsafe(`delete from alert_state where alert_key = '${key}'`)
      .then(() => null, (e: unknown) => String((e as Error)?.message ?? e));
    expect(refused, "DELETE on alert_state is revoked").toMatch(/permission denied/i);

    // Cleaned up as the OWNER, since the staff role deliberately cannot.
    await ownerClient.unsafe(`delete from alert_state where alert_key = '${key}'`);
  });

  it("the WRITE-able set is EMPTY of table-wide verbs — every write is column-scoped now", async () => {
    const rows = await ownerClient.unsafe<Array<{ table_name: string; priv: string }>>(`
      select t.table_name, p.priv
        from information_schema.tables t
        cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p(priv)
       where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
         and has_table_privilege('${STAFF_ROLE}', format('public.%I', t.table_name)::regclass, p.priv)
       order by 1, 2`);

    const actual: Record<string, string[]> = {};
    for (const r of rows) (actual[r.table_name] ??= []).push(r.priv);
    const expected: Record<string, string[]> = {};
    for (const [t, privs] of Object.entries(GRANTED_WRITES)) expected[t] = [...privs].sort();
    expect(actual).toEqual(expected);
  });

  /**
   * §12b's census, widened by that change from one view to two — and it is an EQUALITY in both
   * directions, which is the half that matters. `admin` is FIRST on this role's `search_path`,
   * so an unreviewed relation there does not merely exist: it SHADOWS the `public` relation of
   * the same name for every unqualified query the staff surface makes. `STAFF_ADMIN_VIEWS` is
   * the list, the script's §12b states it a second time, and the provisioning pre-flight reads
   * the same constant.
   */
  it("schema `admin` holds exactly this file's two views, each with exactly its own columns",
    async () => {
      const relations = await ownerClient.unsafe<Array<{ table_name: string; table_type: string }>>(`
        select table_name, table_type from information_schema.tables
         where table_schema = 'admin' order by 1`);
      expect(relations).toEqual(
        [...STAFF_ADMIN_VIEWS].sort().map((name) => ({ table_name: name, table_type: "VIEW" })),
      );

      for (const view of STAFF_ADMIN_VIEWS) {
        const cols = await ownerClient.unsafe<Array<{ column_name: string }>>(`
          with cols as materialized (
            select column_name from information_schema.columns
             where table_schema = 'admin' and table_name = '${view}'
          )
          select column_name from cols
           where has_column_privilege(
                   '${STAFF_ROLE}', 'admin.${view}'::regclass, column_name, 'SELECT')
           order by 1`);
        expect(cols.map((c) => c.column_name), `admin.${view} columns drifted`)
          .toEqual(ADMIN_VIEW_COLUMNS[view]);

        // `security_barrier`, which is what stops a cheap leaky operator being pushed under a
        // view's own predicate. Free on a read-only surface, and the ruling asked for it by
        // name — on the ledger view too, where the redaction is an EXPRESSION and a function
        // evaluated below it would be handed the raw value.
        const [opts] = await ownerClient.unsafe<Array<{ reloptions: string[] | null }>>(`
          select reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'admin' and c.relname = '${view}'`);
        expect(opts?.reloptions ?? [], `admin.${view} is not a security_barrier view`)
          .toContain("security_barrier=true");
      }
    });

  /**
   * THE CENSUS THE API ITSELF BOOTS ON, run here as the role, against the same
   * allowlist.
   *
   * The two censuses above ask `information_schema` from the OWNER's connection about
   * `ohmail_admin`. This one is the query `assertContentBlind` runs on the staff connection at
   * cold start, evaluated with `current_user`, and it is asserted by EQUALITY in both
   * directions — excess AND shortfall. Production refuses only on excess (a shortfall is a
   * broken console that reports itself; an outage is not an acceptable failure mode for a
   * safety mechanism). CI has no such excuse, so drift in either direction fails here.
   */
  it("the CAPABILITY CENSUS the API boots on equals the allowlist, in both directions", async () => {
    const rows = asCapabilities(await staffClient.unsafe(STAFF_CAPABILITY_SQL));

    // Not vacuous. An empty result satisfies every subset check below.
    expect(rows.length).toBeGreaterThan(50);

    expect(staffCapabilityExcess(rows)).toEqual([]);
    expect(staffCapabilityShortfall(rows)).toEqual([]);

    // The five kinds whose allowlist is EMPTY BY CONSTRUCTION rather than by a lookup — each
    // one a route around every column grant in the script, and each one asserted by name so
    // that a widened `allowed()` in `staff-grants.ts` cannot pass silently.
    for (const kind of ["role", "owns", "attribute", "sequence", "secdef"]) {
      expect(rows.filter((r) => r.kind === kind), `${kind} must be empty`).toEqual([]);
    }
  });

  /* ══ 4. The boot probe — the half a privilege census cannot express ══════════════════ */

  it("the boot probe ACCEPTS the staff role", async () => {
    await expect(assertContentBlind(staff)).resolves.toBeUndefined();
  });

  /**
   * THE CASE AN ABSENT-VARIABLE CHECK CANNOT SEE: a wrong VALUE. Runtime credentials pasted
   * into `DATABASE_URL_ADMIN` produce a perfectly working console with no isolation at all,
   * and nothing in the configuration is empty. So the factory asks the database, and a probe
   * that SUCCEEDS is the refusal.
   */
  it("the boot probe REFUSES the database-owner connection — a probe that succeeds is the failure", async () => {
    const err = await assertContentBlind(owner).then(() => null, (e: unknown) => e);
    expect(err, `'${CONTENT_BLIND_PROBE}' must not be answerable by a staff handle`).not.toBeNull();
    expect(err).toBeInstanceOf(NotContentBlindError);
    expect((err as Error).message).toContain("SUCCEEDED");
    // The refusal names no connection string and no driver text.
    expect((err as Error).message).not.toContain(STAFF_PASSWORD);
  });

  it("the boot probe REFUSES a connection that fails for any OTHER reason", async () => {
    const unreachable = {
      execute: async (): Promise<never> => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
    };
    const err = await assertContentBlind(unreachable as never).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(NotContentBlindError);
    expect((err as Error).message).toContain(DENIED_SQLSTATE);
  });

  /**
   * VACUITY. An empty census satisfies "nothing is outside the allowlist" perfectly, so
   * a driver whose result shape this module does not understand would be indistinguishable
   * from a perfectly narrow role. Every connected role holds USAGE on some schema; zero rows
   * is the absence of an answer, not an answer.
   *
   * A stub rather than a role, because no role can produce this — only a driver change can,
   * which is exactly why nothing else in this file would ever notice the guard's removal.
   */
  it("the boot attestation REFUSES a census that comes back with no rows", async () => {
    let call = 0;
    const shapeShifter = {
      execute: async (): Promise<never> => {
        call += 1;
        // The bite tests answer 42501, as a genuinely blind role would…
        if (call <= CONTENT_BITE_TESTS.length) {
          throw Object.assign(new Error("permission denied"), { code: DENIED_SQLSTATE });
        }
        // …and then the census comes back in a shape this module cannot read.
        return [] as never;
      },
    };
    const err = await assertContentBlind(shapeShifter as never).then(() => null, (e: unknown) => e);
    expect(err, "an unreadable census was treated as a passing one").toBeInstanceOf(NotContentBlindError);
    expect((err as Error).message).toContain("no rows");
    expect(call).toBe(CONTENT_BITE_TESTS.length + 1);
  });

  /* ══ 5. Re-runnability — the reason this is a script and not a migration ═════════════ */

  it("RE-RUNNING the script repairs a hand-widened grant", async () => {
    // Exactly the shape of the incident it exists for: somebody grants a column "for support".
    await ownerClient.unsafe(`grant select (subject) on public.messages to ${STAFF_ROLE}`);
    const widened = await staffClient.unsafe("select subject from messages where false")
      .then(() => "answered", () => "refused");
    expect(widened, "the sabotage did not take — the rest of this test proves nothing").toBe("answered");

    await ownerClient.unsafe(scriptText).simple();

    const err = await staffClient.unsafe("select subject from messages where false")
      .then(() => null, (e: unknown) => e);
    expect(err, "re-running the script did not remove the hand-added grant").not.toBeNull();
    expect(sqlstateOf(err)).toBe(DENIED_SQLSTATE);
  });

  /* ══ 6. the two CRITICAL findings, each attack executed ════════════════════════
     A review finding: "its rerun mutation adds only a direct grant to `ohmail_admin`, which
     is the one kind this revoke repairs". §5 above IS that mutation. Everything below is a
     privilege source `REVOKE … FROM ohmail_admin` cannot reach.

     Every test here follows the same three beats, and the FIRST of them is the one that
     matters: prove the sabotage TOOK. A repair test whose sabotage silently failed is a green
     test that proves nothing, which is the failure mode `CLAUDE.md` calls "a guard nobody has
     watched fail". */

  /**
   * The shipped script, again, exactly as §5 and `beforeAll` run it.
   *
   * The `rollback` is not decoration. The script opens an EXPLICIT transaction block, and in
   * the simple protocol an error stops the remaining statements in the string — including its
   * own `COMMIT;` — leaving the connection inside a failed transaction that every later
   * statement answers with "current transaction is aborted". `psql -v ON_ERROR_STOP=1` exits
   * and rolls back for the operator; a long-lived client has to say it.
   */
  const rerun = async (): Promise<void> => {
    try {
      await ownerClient.unsafe(scriptText).simple();
    } catch (err) {
      await ownerClient.unsafe("rollback").catch(() => {});
      throw err;
    }
  };

  /** A COLD staff connection — what a serverless cold start actually opens. */
  async function onFreshStaff<T>(
    fn: (client: ReturnType<typeof postgres>, db: PostgresJsDatabase<typeof schema>) => Promise<T>,
  ): Promise<T> {
    const client = postgres(staffUrl(), { max: 1, onnotice: () => {} });
    try {
      return await fn(client, brandDialect(drizzle(client, { schema }), "pg"));
    } finally {
      await client.end({ timeout: 5 }).catch(() => {});
    }
  }

  /** Can the staff role read message BODIES? The one question every §6 sabotage turns on. */
  const bodiesReadable = (): Promise<boolean> =>
    onFreshStaff((c) => c.unsafe("select text from message_bodies where false")
      .then(() => true, () => false));

  /** The boot attestation, on a cold connection. Resolves to the error, or null. */
  const attest = (): Promise<unknown> =>
    onFreshStaff((_c, db) => assertContentBlind(db).then(() => null, (e: unknown) => e));

  /* ── the boot probe was a one-column oracle ──────────────────────────────────────── */

  /**
   * CODEX VERBATIM: "a role […] lacks `SELECT(messages.subject)` but retains
   * `SELECT(message_bodies.*)`". the probe asked one question, got 42501, and minted the
   * brand. This test asserts both halves — that the OLD oracle still says "blind", and that
   * the attestation now refuses anyway.
   */
  it("denied `messages.subject`, granted `message_bodies`: the grant oracle passes, boot REFUSES",
    async () => {
      await ownerClient.unsafe(`grant select on public.message_bodies to ${STAFF_ROLE}`);
      try {
        // The sabotage took: every body in the database is readable by the staff role.
        const bodies = await staffClient.unsafe<Array<{ text: string }>>(
          "select text from message_bodies");
        expect(bodies.map((r) => r.text)).toContain("ZZBODYZZ");

        // …and the ENTIRE proof of blindness still answers "blind".
        const oracle = await staffClient.unsafe(CONTENT_BLIND_PROBE)
          .then(() => "answered", () => "refused");
        expect(oracle, "the premise is gone — `messages.subject` is readable").toBe("refused");

        const err = await attest();
        expect(err, "the staff handle was minted for a role that can read every body")
          .toBeInstanceOf(NotContentBlindError);
        expect((err as Error).message).toContain("message_bodies");
      } finally {
        await rerun();
      }
      expect(await bodiesReadable()).toBe(false);
    });

  /**
   * The same finding, one step further out: an excess that NO bite test can see. Only the census
   * answers this one, so it is the test that goes red if somebody deletes the census and keeps
   * the cheap statements.
   *
   * ── CONVERTED BY THAT CHANGE, AND THE CONVERSION IS ITSELF THE EVIDENCE ─────────────────────────
   *
   * This used to be one test, titled "an excess invisible to both bite tests
   * (`messages.snippet`, `threads`)", granting BOTH and asserting that only the census caught
   * them. `messages.snippet` is no longer invisible to the bite tests: a later fix added
   * `select count(*) from messages`, which answers the moment the role holds ANY column of that
   * relation. So the two halves have separated, and asserting the separation is what proves the
   * new bite is load-bearing rather than decorative:
   *
   *  · `messages.snippet` — caught by the row bite, BEFORE the census runs.
   *  · `threads`          — caught by the census alone, exactly as before.
   */
  it("a `messages` column excess is caught by the ROW BITE, before the census",
    async () => {
      await ownerClient.unsafe(`grant select (snippet) on public.messages to ${STAFF_ROLE}`);
      try {
        const snippets = await staffClient.unsafe<Array<{ snippet: string }>>(
          "select snippet from messages");
        expect(snippets.map((r) => r.snippet), "the sabotage did not take").toContain("ZZSNIPPETZZ");

        // The two COLUMN bites are untouched and still refuse: `messages.subject` and
        // `message_bodies` are as denied as they were a moment ago.
        for (const stmt of [CONTENT_BLIND_PROBE, "select text from message_bodies where false"]) {
          expect(await staffClient.unsafe(stmt).then(() => "answered", () => "refused"))
            .toBe("refused");
        }
        // …and the ROW bite ANSWERS, which is the whole point of it. `count(*)` names no column,
        // so it does not care WHICH column was granted.
        expect(await staffClient.unsafe("select count(*) from messages")
          .then(() => "answered", () => "refused")).toBe("answered");

        const err = await attest();
        expect(err).toBeInstanceOf(NotContentBlindError);
        // The row bite's message, not the census's. Deleting the third entry of
        // CONTENT_BITE_TESTS makes this assertion name a census row instead, and go red.
        expect((err as Error).message, "the row bite did not fire first")
          .toContain("select count(*) from messages' SUCCEEDED");
      } finally {
        await rerun();
      }
      expect(await attest()).toBeNull();
    });

  it("an excess invisible to EVERY bite test (`threads`) is refused by the census alone",
    async () => {
      await ownerClient.unsafe(`grant select on public.threads to ${STAFF_ROLE}`);
      try {
        // The relation ANSWERS rather than 42501s. Not "returns rows": `seedWorld` plants no
        // thread, and a sabotage check that depended on the seed would break the day it does.
        expect(await staffClient.unsafe("select root_message_id_header from threads")
          .then(() => "answered", () => "refused"), "the sabotage did not take").toBe("answered");

        // ALL THREE bites still refuse — nothing about `messages` or `message_bodies` changed.
        for (const [, stmt] of CONTENT_BITE_TESTS) {
          expect(await staffClient.unsafe(stmt).then(() => "answered", () => "refused"),
            `${stmt} answered — this excess is not census-only any more`).toBe("refused");
        }

        const err = await attest();
        expect(err, "only the census can see this one, and it did not")
          .toBeInstanceOf(NotContentBlindError);
        expect((err as Error).message).toContain("public.threads");
      } finally {
        await rerun();
      }
      expect(await attest()).toBeNull();
    });

  /**
   * The census is not a column census. Three capabilities that confer NO readable column
   * today, each of which is one step from conferring all of them, and each of which is
   * carried by a UNION branch of {@link STAFF_CAPABILITY_SQL} that nothing else in this file
   * would notice the deletion of.
   */
  it("a MEMBERSHIP that grants nothing is still refused at boot", async () => {
    await ownerClient.unsafe(`
      drop role if exists b1c_empty;
      create role b1c_empty;
      grant b1c_empty to ${STAFF_ROLE};
    `).simple();
    try {
      // It reads no more than it did a moment ago — and that is the point. What it holds is a
      // handle on whatever `b1c_empty` is granted NEXT, by somebody who never read this file.
      expect(await bodiesReadable()).toBe(false);
      const err = await attest();
      expect(err, "a membership is invisible to a column census").toBeInstanceOf(NotContentBlindError);
      expect((err as Error).message).toContain("b1c_empty");
    } finally {
      await ownerClient.unsafe(`
        revoke b1c_empty from ${STAFF_ROLE};
        drop role if exists b1c_empty;
      `).simple().catch(() => {});
    }
  });

  it("OWNERSHIP with every privilege revoked is still refused at boot", async () => {
    // A relation's owner can re-grant itself anything at any time, so an ACL that says
    // "no privileges" is a statement about this second, not about the boundary.
    await ownerClient.unsafe(`
      alter table public.threads owner to ${STAFF_ROLE};
      revoke all on public.threads from ${STAFF_ROLE};
    `).simple();
    try {
      const readable = await onFreshStaff((c) => c.unsafe("select * from threads where false")
        .then(() => true, () => false));
      expect(readable, "the premise is gone — the ACL did not deny the database owner").toBe(false);

      const err = await attest();
      expect(err, "ownership is invisible to a column census").toBeInstanceOf(NotContentBlindError);
      expect((err as Error).message).toContain("OWNS relation public.threads");
    } finally {
      await rerun();
    }
    expect(await attest()).toBeNull();
  });

  it("a role ATTRIBUTE that grants no column is still refused at boot", async () => {
    await ownerClient.unsafe(`alter role ${STAFF_ROLE} createrole`);
    try {
      // CREATEROLE reads nothing by itself. It grants the ability to hand yourself a
      // membership, which is the previous test's finding one statement away.
      expect(await bodiesReadable()).toBe(false);
      const err = await attest();
      expect(err).toBeInstanceOf(NotContentBlindError);
      expect((err as Error).message).toContain("role attribute CREATEROLE");
    } finally {
      await rerun();
    }
    expect(await attest()).toBeNull();
  });

  /* ── REVOKE does not return an existing role to zero ─────────────────────────────── */

  /**
   * MEMBERSHIP. `GRANT <role> TO ohmail_admin` where that role can read bodies. No `REVOKE …
   * ON message_bodies FROM ohmail_admin` in the script touches it, because there is no ACL
   * entry for `ohmail_admin` to remove.
   */
  it("a grant inherited through another ROLE is repaired by the rerun", async () => {
    await ownerClient.unsafe(`
      drop role if exists b1c_support;
      create role b1c_support;
      grant select on public.message_bodies to b1c_support;
      grant b1c_support to ${STAFF_ROLE};
    `).simple();
    try {
      expect(await bodiesReadable(), "the sabotage did not take").toBe(true);

      await rerun();

      expect(await bodiesReadable(), "the rerun left the inherited grant in place").toBe(false);
      expect(await attest()).toBeNull();
      const [row] = await ownerClient.unsafe<Array<{ n: string }>>(`
        select count(*) as n from pg_auth_members where member = '${STAFF_ROLE}'::regrole`);
      expect(Number(row?.n)).toBe(0);
    } finally {
      await ownerClient.unsafe(`
        revoke all on public.message_bodies from b1c_support;
        drop role if exists b1c_support;
      `).simple().catch(() => {});
    }
  });

  /**
   * The PREDEFINED role a review named. `pg_read_all_data` is one line, is exactly what an
   * operator reaches for at 3am, and hands the staff role every body, subject and sender in
   * the database.
   */
  it("`pg_read_all_data` membership is repaired by the rerun", async () => {
    await ownerClient.unsafe(`grant pg_read_all_data to ${STAFF_ROLE}`);
    let repaired = false;
    try {
      expect(await bodiesReadable(), "the sabotage did not take").toBe(true);
      // And it is not just bodies: the own probe answers, because SELECT is universal now.
      expect(await onFreshStaff((c) => c.unsafe(CONTENT_BLIND_PROBE)
        .then(() => "answered", () => "refused"))).toBe("answered");

      await rerun();
      repaired = true;

      expect(await bodiesReadable(), "the rerun left pg_read_all_data in place").toBe(false);
      expect(await attest()).toBeNull();
    } finally {
      if (!repaired) {
        await ownerClient.unsafe(`revoke pg_read_all_data from ${STAFF_ROLE}`).catch(() => {});
      }
    }
  });

  /**
   * `PUBLIC`. The one case the script does NOT repair, deliberately: revoking a PUBLIC grant
   * changes what every other role can do, and the standing promise is that this script
   * cannot alter the running deployment's privileges. So it must ABORT — loudly, naming the
   * relation and naming PUBLIC — and provision nothing.
   */
  it("a grant to PUBLIC ABORTS the script, names PUBLIC, and provisions nothing", async () => {
    await ownerClient.unsafe("grant select on public.message_bodies to public");
    try {
      expect(await bodiesReadable(), "the sabotage did not take").toBe(true);

      const err = await rerun().then(() => null, (e: unknown) => e);
      expect(err, "the script COMMITTED while ohmail_admin could read every body").not.toBeNull();
      expect((err as Error).message).toContain("PUBLIC");
      expect((err as Error).message).toContain("message_bodies");
      // …and §12 is the guard that fired, not §13's catch-all. That distinction is the whole
      // reason §12 exists: the census would abort too, but it would report "ohmail_admin can
      // read message_bodies.text" and send the operator looking for a grant that is not there.
      expect((err as Error).message,
        "the PUBLIC grant fell through to the census instead of being diagnosed by name")
        .not.toContain("POSTCONDITION FAILED");

      // The rollback is the point: a script that half-applied would leave the console armed.
      expect(await bodiesReadable()).toBe(true);
    } finally {
      await ownerClient.unsafe("revoke select on public.message_bodies from public");
      await rerun();
    }
    expect(await bodiesReadable()).toBe(false);
    expect(await attest()).toBeNull();
  });

  /**
   * OWNERSHIP. An owner holds every privilege on its object by default and can re-grant them,
   * so `REVOKE ALL ON message_bodies FROM ohmail_admin` against a table it OWNS removes an ACL
   * entry that was never the source of the privilege.
   */
  it("OWNERSHIP of a protected relation is taken back by the rerun", async () => {
    await ownerClient.unsafe(`alter table public.message_bodies owner to ${STAFF_ROLE}`);
    let repaired = false;
    try {
      expect(await bodiesReadable(), "the sabotage did not take").toBe(true);

      await rerun();
      repaired = true;

      expect(await bodiesReadable(), "the rerun left the staff role owning the body table")
        .toBe(false);
      const [row] = await ownerClient.unsafe<Array<{ owner: string }>>(`
        select relowner::regrole::text as owner from pg_class
         where oid = 'public.message_bodies'::regclass`);
      expect(row?.owner).not.toBe(STAFF_ROLE);
      expect(await attest()).toBeNull();
    } finally {
      if (!repaired) {
        await ownerClient.unsafe("alter table public.message_bodies owner to current_user")
          .catch(() => {});
      }
    }
  });

  /**
   * ANOTHER SCHEMA. The blind connection revoked in `public` only, so a grant anywhere else was a privilege the
   * repair tool could not see — and `USAGE` on the schema plus `SELECT` on a view inside it is
   * the whole of the shape, one namespace over.
   *
   * Both halves are load-bearing and neither is covered by anything above: the boot census's
   * SCHEMA branch is the only thing that reports `ops` (the relation branches range over
   * `public` and `admin`), and §2's all-schema reset loop is the only thing that repairs it —
   * §13 would accept a DIRECT `GRANT USAGE ON SCHEMA ops` as direct.
   */
  it("a grant in ANOTHER SCHEMA is refused at boot and repaired by the rerun", async () => {
    await ownerClient.unsafe(`
      drop schema if exists ops cascade;
      create schema ops;
      create view ops.mail as select id, subject from public.messages;
      grant usage on schema ops to ${STAFF_ROLE};
      grant select on ops.mail to ${STAFF_ROLE};
    `).simple();
    try {
      const leaked = await onFreshStaff((c) =>
        c.unsafe<Array<{ subject: string }>>("select subject from ops.mail"));
      expect(leaked.map((r) => r.subject), "the sabotage did not take").toContain("ZZSUBJECTZZ");

      const err = await attest();
      expect(err, "a schema outside public+admin is invisible to the relation census")
        .toBeInstanceOf(NotContentBlindError);
      expect((err as Error).message).toContain("USAGE on schema ops");

      await rerun();

      expect(await onFreshStaff((c) => c.unsafe("select 1 from ops.mail where false")
        .then(() => "answered", () => "refused")),
        "the rerun left a grant standing in a schema it never named").toBe("refused");
      expect(await attest()).toBeNull();
    } finally {
      await ownerClient.unsafe("drop schema if exists ops cascade");
      await rerun();
    }
  });

  /**
   * A REVIEW FINDING. `SECURITY DEFINER` runs as the routine's OWNER, and Postgres grants `EXECUTE`
   * to `PUBLIC` on every routine it creates — so this needs no grant to `ohmail_admin` at all,
   * and `REVOKE ALL ON ALL FUNCTIONS … FROM ohmail_admin` cannot negate it.
   *
   * "One default PostgreSQL privilege can create a content path that all three advertised
   * mechanisms miss": the column census stays green because no relation privilege changed,
   * and both bite tests still get their 42501.
   */
  it("a SECURITY DEFINER routine returning `messages.subject` ABORTS the script and the boot",
    async () => {
      await ownerClient.unsafe(`
        create function public.b1c_helper() returns setof text
          language sql security definer
          as 'select subject from public.messages';
      `).simple();
      try {
        // No grant was made to the staff role. It calls it through PUBLIC, and the routine
        // reads subjects with its owner's privileges.
        const leaked = await onFreshStaff((c) =>
          c.unsafe<Array<{ b1c_helper: string }>>("select * from public.b1c_helper()"));
        expect(leaked.map((r) => r.b1c_helper)).toContain("ZZSUBJECTZZ");

        // All three of the mechanisms still say "blind".
        for (const stmt of [CONTENT_BLIND_PROBE, "select text from message_bodies where false"]) {
          expect(await onFreshStaff((c) => c.unsafe(stmt).then(() => "answered", () => "refused")))
            .toBe("refused");
        }
        const columnCensus = asCapabilities(await staffClient.unsafe(STAFF_CAPABILITY_SQL))
          .filter((r) => r.kind === "column");
        expect(staffCapabilityExcess(columnCensus)).toEqual([]);

        // PROVISIONING refuses…
        const err = await rerun().then(() => null, (e: unknown) => e);
        expect(err, "the script COMMITTED over a definer routine that returns subjects")
          .not.toBeNull();
        expect((err as Error).message).toContain("SECURITY DEFINER");
        expect((err as Error).message).toContain("b1c_helper");

        // …and so does BOOT, which is the half that protects an already-provisioned database.
        const bootErr = await attest();
        expect(bootErr).toBeInstanceOf(NotContentBlindError);
        expect((bootErr as Error).message).toContain("b1c_helper");
      } finally {
        await ownerClient.unsafe("drop function if exists public.b1c_helper()");
        await rerun();
      }
      expect(await attest()).toBeNull();
    });

  /**
   * CODEX. An ordinary view reads its base tables with the VIEW OWNER's privileges, and
   * The blind connection reset `admin` by re-creating one view and nothing else — so this survived a full
   * rerun, grant included, in the one schema the role's `search_path` searches first.
   */
  it("a content VIEW in schema `admin` ABORTS the script until somebody removes it",
    async () => {
      await ownerClient.unsafe(`
        create view admin.mail_preview as
          select id, subject, from_address from public.messages;
        grant select on admin.mail_preview to ${STAFF_ROLE};
      `).simple();
      try {
        // The sabotage took: mail, with no base-column grant anywhere near it.
        const leaked = await onFreshStaff((c) =>
          c.unsafe<Array<{ subject: string; from_address: string }>>(
            "select subject, from_address from admin.mail_preview"));
        expect(leaked.map((r) => r.subject)).toContain("ZZSUBJECTZZ");

        // …while `public.messages` itself is as denied as it ever was.
        expect(await onFreshStaff((c) => c.unsafe(CONTENT_BLIND_PROBE)
          .then(() => "answered", () => "refused"))).toBe("refused");

        const err = await rerun().then(() => null, (e: unknown) => e);
        expect(err, "the script COMMITTED with a mail view sitting in its own schema")
          .not.toBeNull();
        expect((err as Error).message).toContain("mail_preview");
        expect((err as Error).message).toContain("admin");

        // Rolled back: the view is still readable, so nothing half-applied.
        expect(await onFreshStaff((c) => c.unsafe("select 1 from admin.mail_preview where false")
          .then(() => "answered", () => "refused"))).toBe("answered");

        // Boot refuses too — the view's columns are a capability the allowlist does not name.
        const bootErr = await attest();
        expect(bootErr).toBeInstanceOf(NotContentBlindError);
        expect((bootErr as Error).message).toContain("admin.mail_preview");
      } finally {
        await ownerClient.unsafe("drop view if exists admin.mail_preview");
        await rerun();
      }
      expect(await attest()).toBeNull();
    });

  /**
   * CLOUD-025 — the script's OWN retired view. An earlier version created `admin.credit_ledger`
   * (§9b); the billing move dropped the stanza and not the view, so every rerun on a database
   * that ran the old script aborted at §12b on an object this file made. It is dropped by name,
   * and the schema then holds exactly `STAFF_ADMIN_VIEWS`.
   */
  it("CLOUD-025 — the retired `admin.credit_ledger` is dropped by the rerun, not refused", async () => {
    await ownerClient.unsafe("create view admin.credit_ledger as select 1 as id").simple();
    try {
      const err = await rerun().then(() => null, (e: unknown) => e);
      expect(err, `the rerun refused its own retired view: ${String(err)}`).toBeNull();
      const rels = await ownerClient.unsafe<Array<{ relname: string }>>(`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'admin' order by 1`);
      expect(rels.map((r) => r.relname)).toEqual([...STAFF_ADMIN_VIEWS].sort());
    } finally {
      await ownerClient.unsafe("drop view if exists admin.credit_ledger");
    }
    expect(await attest()).toBeNull();
  });

  /**
   * The ROLE ATTRIBUTE. A `SUPERUSER` staff role reads every table in the cluster and no grant
   * in the script means anything at all.
   */
  it("the SUPERUSER attribute is removed by the rerun", async () => {
    await ownerClient.unsafe(`alter role ${STAFF_ROLE} superuser`);
    let repaired = false;
    try {
      expect(await bodiesReadable(), "the sabotage did not take").toBe(true);

      await rerun();
      repaired = true;

      const [row] = await ownerClient.unsafe<Array<{ rolsuper: boolean }>>(
        `select rolsuper from pg_roles where rolname = '${STAFF_ROLE}'`);
      expect(row?.rolsuper).toBe(false);
      expect(await bodiesReadable()).toBe(false);
      expect(await attest()).toBeNull();
    } finally {
      if (!repaired) {
        await ownerClient.unsafe(`alter role ${STAFF_ROLE} nosuperuser`).catch(() => {});
      }
    }
  });

  /* ── the census attested `current_user`, and `SET ROLE NONE` recovers `session_user` ── */

  /**
   * CODEX. Every §6 sabotage above widens what `ohmail_admin` ITSELF can reach, and the
   * census — keyed on `current_user` — caught each one. This finding is the sabotage that does not touch
   * `ohmail_admin` at all: a LOGIN role that DEFAULTS into it.
   *
   *   create role wrapper login password '…';
   *   grant ohmail_admin to wrapper;               -- wrapper is now a MEMBER
   *   alter role wrapper set role = 'ohmail_admin'; -- every session STARTS wearing it
   *   grant select on message_bodies to wrapper;    -- the wrapper's OWN content grant
   *
   * A connection through `wrapper` answers `current_user = ohmail_admin`, so it LOOKS blind: the
   * bite tests refuse, and a census keyed on `current_user` alone matches the allowlist exactly.
   * But `session_user` is still `wrapper`, and a single `SET ROLE NONE` — needing no privilege —
   * drops the costume and recovers the wrapper's own grant. A `DATABASE_URL_ADMIN` built this way
   * would be handed out as "blind" and read every body in the database.
   *
   * The fix enumerates BOTH identities. This test asserts, on ONE cold wrapper connection: the
   * costume is real (`current_user` = the blind role), the exploit is real (`SET ROLE NONE` reads
   * bodies), and the attestation now REFUSES — naming the session mismatch and the recovered
   * grant. Reverting `staff-grants.ts` to `where r.rolname = current_user` makes this go green,
   * i.e. mints a "blind" handle for a connection that can read all mail.
   */
  it("a wrapper login that defaults `role = ohmail_admin` is REFUSED, not blessed", async () => {
    const WRAPPER = `b1f9_wrapper_${SUFFIX}`;
    const WRAPPER_PW = `wpw_${SUFFIX}`;
    await ownerClient.unsafe(`
      drop role if exists ${WRAPPER};
      create role ${WRAPPER} login password '${WRAPPER_PW}';
      grant ${STAFF_ROLE} to ${WRAPPER};
      alter role ${WRAPPER} set role = '${STAFF_ROLE}';
      grant select on public.message_bodies to ${WRAPPER};
    `).simple();

    const wrapperClient = postgres(
      urlFor(DB_NAME, { user: WRAPPER, password: WRAPPER_PW }), { max: 1, onnotice: () => {} },
    );
    try {
      // THE COSTUME IS REAL: the session starts wearing the blind role, so `current_user` is
      // `ohmail_admin` and every surface that asks only that question sees the blind role.
      const [who] = await wrapperClient.unsafe<Array<{ cu: string; su: string }>>(
        "select current_user as cu, session_user as su");
      expect(who?.cu, "the wrapper is not wearing the blind role").toBe(STAFF_ROLE);
      expect(who?.su, "the session identity is not the wrapper").toBe(WRAPPER);

      // …and it LOOKS blind while wearing it: the bite tests refuse, exactly as for the real role.
      for (const [, stmt] of CONTENT_BITE_TESTS) {
        expect(
          await wrapperClient.unsafe(stmt).then(() => "answered", () => "refused"),
          `${stmt} answered while wearing the blind role — the costume is leaky, test is moot`,
        ).toBe("refused");
      }

      // THE EXPLOIT, in one statement that needs no privilege: drop the costume and the
      // wrapper's OWN grant reads every body. This is what `current_user`-only attestation cannot
      // see, and it is why the mismatch is refused OUTRIGHT rather than measured.
      await wrapperClient.unsafe("set role none");
      const recovered = await wrapperClient.unsafe<Array<{ text: string }>>(
        "select text from message_bodies");
      expect(recovered.map((r) => r.text), "SET ROLE NONE did not recover the wrapper's grant")
        .toContain("ZZBODYZZ");
      await wrapperClient.unsafe("reset role");

      // THE ATTESTATION REFUSES — on a fresh drizzle handle over the same wrapper connection,
      // wearing the blind role exactly as a serverless staff request would. It names the session
      // mismatch and, because the census now enumerates `session_user` too, the recovered grant.
      const db = brandDialect(drizzle(wrapperClient, { schema }), "pg");
      const err = await assertContentBlind(db).then(() => null, (e: unknown) => e);
      expect(err, "a wrapper login was blessed as content-blind")
        .toBeInstanceOf(NotContentBlindError);
      // The recovered content grant is in the census as an excess for `session_user`, by name.
      // (`message_bodies` columns sort ahead of the `session` row, so they are what the first
      // named faults show; the bare-wrapper test below is the one that pins the `session`
      // message itself, on an excess set small enough to name it.)
      expect((err as Error).message).toContain("message_bodies");
    } finally {
      await wrapperClient.end({ timeout: 5 }).catch(() => {});
      await ownerClient.unsafe(`
        revoke all on public.message_bodies from ${WRAPPER};
        drop role if exists ${WRAPPER};
      `).simple().catch(() => {});
    }
  });

  /**
   * The pure form of the same finding: a wrapper that holds NOTHING beyond the allowlist is
   * STILL refused. `session_user <> current_user` is not an allowlisted state — "what SET ROLE
   * can reach" is a property of the login arrangement, and the only arrangement this seam
   * supports is connecting AS the blind role. Without the `session` row (and the membership the
   * wrapper necessarily holds) this connection's census would match the allowlist exactly.
   */
  it("even a wrapper that holds nothing extra is refused on the session mismatch alone", async () => {
    const WRAPPER = `b1f9_bare_${SUFFIX}`;
    const WRAPPER_PW = `bpw_${SUFFIX}`;
    await ownerClient.unsafe(`
      drop role if exists ${WRAPPER};
      create role ${WRAPPER} login password '${WRAPPER_PW}';
      grant ${STAFF_ROLE} to ${WRAPPER};
      alter role ${WRAPPER} set role = '${STAFF_ROLE}';
    `).simple();

    const wrapperClient = postgres(
      urlFor(DB_NAME, { user: WRAPPER, password: WRAPPER_PW }), { max: 1, onnotice: () => {} },
    );
    try {
      const db = brandDialect(drizzle(wrapperClient, { schema }), "pg");
      const err = await assertContentBlind(db).then(() => null, (e: unknown) => e);
      expect(err, "a bare wrapper login was blessed (session mismatch not refused)")
        .toBeInstanceOf(NotContentBlindError);
      expect((err as Error).message).toContain("SET ROLE NONE");
    } finally {
      await wrapperClient.end({ timeout: 5 }).catch(() => {});
      await ownerClient.unsafe(`drop role if exists ${WRAPPER}`).catch(() => {});
    }
  });

  /* ══ 7. THE RECEIPT ORACLE ════════════════════════════════════════

     Every other assertion in this file asks "can the staff role read column X". The review's
     finding is the one that question cannot see: the role held nothing but ids, statuses and
     timestamps — and could still learn whether a named account had received a message the
     tester chose, from the EXISTENCE of rows.

     So §7 asks the product question directly, and it is the only test in the file that would
     have gone red on the state that shipped before it:

       **can the staff role tell an account that received a chosen message from one that did
       not?**

     It answers it by MEASUREMENT rather than by enumeration: sweep every value the role can
     select, deliver, sweep again, and require the two sweeps to be byte-identical. That shape is
     what makes it survive the next slice — a grant somebody adds for a good reason lands in the
     sweep automatically, because the relation/column list comes from the LIVE census and not
     from `STAFF_SELECT_GRANTS`. A test written as "assert `messages` is denied" would go green
     the moment the console needed one more id. */

  /** Every value the staff role can select, canonicalised. The census supplies the columns. */
  async function sweepEverything(): Promise<{ text: string; relations: number; rows: number }> {
    const columns = asCapabilities(await staffClient.unsafe(STAFF_CAPABILITY_SQL))
      .filter((c) => c.kind === "column");
    const byRelation = new Map<string, string[]>();
    for (const c of columns) {
      const [schema, relation] = c.subject.split(".");
      const key = `"${schema}"."${relation}"`;
      const cols = byRelation.get(key) ?? [];
      cols.push(`"${c.detail}"`);
      byRelation.set(key, cols);
    }
    const lines: string[] = [];
    let rows = 0;
    for (const [relation, cols] of [...byRelation].sort()) {
      const got = await staffClient.unsafe<Array<{ row: unknown }>>(
        `select to_jsonb(t) as row from (select ${[...cols].sort().join(", ")} from ${relation}) t`);
      rows += got.length;
      // Sorted, because row ORDER is not part of what the role can learn and an unstable order
      // would make this test flake instead of bite.
      for (const r of got.map((x) => `${relation} ${JSON.stringify(x.row)}`).sort()) lines.push(r);
    }
    return { text: lines.join("\n"), relations: byRelation.size, rows };
  }

  it("a chosen delivery changes NOTHING the staff role can select", async () => {
    const chosenMid = "<ZZCHOSENPROBEZZ.9001@attacker.example.test>";
    const targetAccount = randomUUID();
    const targetMailbox = randomUUID();
    const controlAccount = randomUUID();
    const controlMailbox = randomUUID();
    const deliveredMessage = randomUUID();

    // TWO accounts, identical in everything the staff role can see except the delivery. The
    // control is what makes "identical sweeps" mean "indistinguishable" rather than "nothing
    // happened anywhere".
    for (const [account, mailbox, name] of [
      [targetAccount, targetMailbox, "Target"],
      [controlAccount, controlMailbox, "Control"],
    ] as const) {
      await ownerClient.unsafe(
        `insert into accounts (id, name) values ('${account}', '${name}')`);
      await ownerClient.unsafe(
        `insert into mailboxes (id, account_id, provider, address, status)
         values ('${mailbox}', '${account}', 'imap', '${mailbox}@example.test', 'connected')`);
    }

    try {
      // THE LITERAL SEQUENCE, as the review wrote it: resolve the mailbox uuid (which staff may
      // legitimately do — `mailboxes` is granted), then count rows in `messages` for it.
      const probe = await staffClient
        .unsafe(`select count(*) from messages where mailbox_id = '${targetMailbox}'`)
        .then(() => "answered", () => "refused");
      expect(probe, "the count probe still answers — the staff role can count a mailbox's messages")
        .toBe("refused");

      const before = await sweepEverything();
      // NOT VACUOUS. An empty sweep is byte-identical to another empty sweep.
      expect(before.relations).toBeGreaterThan(10);
      expect(before.rows).toBeGreaterThan(10);

      // ── THE DELIVERY, written exactly as `packages/core/src/pipeline.ts` writes one ────────
      // A `messages` row (§4's oracle), a body, a PENDING `folder_state` row (the organizer
      // files an arrival whose desired folder differs from its arrival folder — §7's oracle),
      // and the `change_log` row `pipeline.ts:512` records for every ingested message (§8's
      // oracle, and the one that moved `lastActivityAt`).
      await ownerClient.unsafe(`
        insert into messages
          (id, account_id, mailbox_id, message_id_header, body_hash, dedup_key,
           subject, from_address, snippet)
        values ('${deliveredMessage}', '${targetAccount}', '${targetMailbox}',
                '${chosenMid}', 'h2', 'mid:${chosenMid}',
                'ZZCHOSENSUBJECTZZ', 'attacker@example.test', 'ZZCHOSENSNIPPETZZ')`);
      await ownerClient.unsafe(
        `insert into message_bodies (id, message_id, text)
         values ('${randomUUID()}', '${deliveredMessage}', 'ZZCHOSENBODYZZ')`);
      await ownerClient.unsafe(`
        insert into folder_state
          (id, message_id, desired_folder, observed_folder, last_set_by, reconcile_status)
        values ('${randomUUID()}', '${deliveredMessage}', 'ohmail/Answer Later', 'INBOX',
                'us', 'pending')`);
      await ownerClient.unsafe(`
        insert into change_log (account_id, seq, entity_type, entity_id, op, meta)
        values ('${targetAccount}', 1, 'message', '${deliveredMessage}', 'create', null)`);

      // THE SABOTAGE TOOK. Without this the equality below is satisfied by a delivery that
      // never landed, which is the exact "guard nobody has watched fail" shape.
      const landed = await ownerClient.unsafe<Array<{ n: string }>>(
        `select count(*) as n from messages where mailbox_id = '${targetMailbox}'`);
      expect(Number(landed[0]?.n), "the delivery did not land — this test proves nothing").toBe(1);

      const after = await sweepEverything();

      // ── THE ASSERTION ────────────────────────────────────────────────────────────────────
      // Byte-identical. The account that received a message the tester chose is
      // indistinguishable, to this role, from the one that did not.
      expect(
        after.text,
        "a chosen delivery is VISIBLE to the staff role — the mail-content rule. Diff the two sweeps: the " +
        "relation named on the changed line is the oracle.",
      ).toBe(before.text);
      expect(after.rows).toBe(before.rows);

      // …and the chosen Message-ID and its digest are nowhere in either sweep.
      for (const needle of [chosenMid, "ZZCHOSENPROBEZZ", "ZZCHOSENSUBJECTZZ", "ZZCHOSENBODYZZ",
        deliveredMessage, shortHash(`mid:${chosenMid}`)]) {
        expect(after.text, `${needle} is reachable by the staff role`).not.toContain(needle);
      }

      // ── AND THE SWEEP IS NOT A CONSTANT ──────────────────────────────────────────────────
      // The equality above is only evidence if `sweepEverything` can go UNEQUAL. `alert_state`
      // is the one table this role reads AND writes, so a row in it must show up — proving the
      // measurement is live rather than that the two calls both returned nothing useful.
      await ownerClient.unsafe(
        `insert into alert_state (alert_key, kind, severity, detail)
         values ('b1e_sweep_bite', 'worker_down', 'critical', 'proving the sweep is not a constant')`);
      try {
        const bitten = await sweepEverything();
        expect(
          bitten.text,
          "the sweep did not change when a row was added to a relation the role CAN read — it " +
          "is not measuring anything, and the equality above is vacuous",
        ).not.toBe(before.text);
        expect(bitten.rows).toBe(before.rows + 1);
      } finally {
        await ownerClient.unsafe("delete from alert_state where alert_key = 'b1e_sweep_bite'");
      }
    } finally {
      // Leave the world as §2 asserts it: later readers must not find two extra accounts.
      await ownerClient.unsafe(`delete from change_log where account_id = '${targetAccount}'`);
      await ownerClient.unsafe(`delete from folder_state where message_id = '${deliveredMessage}'`);
      await ownerClient.unsafe(`delete from message_bodies where message_id = '${deliveredMessage}'`);
      await ownerClient.unsafe(`delete from messages where id = '${deliveredMessage}'`);
      await ownerClient.unsafe(
        `delete from mailboxes where id in ('${targetMailbox}', '${controlMailbox}')`);
      await ownerClient.unsafe(
        `delete from accounts where id in ('${targetAccount}', '${controlAccount}')`);
    }
  });
});

/**
 * A compact world: one account with one of everything the six reads touch, with mail content
 * carrying distinctive markers so the positive half can also assert their ABSENCE.
 */
async function seedWorld(db: PostgresJsDatabase<typeof schema>): Promise<Seeded> {
  const accountId = randomUUID();
  const mailboxId = randomUUID();
  const messageId = randomUUID();
  const draftId = randomUUID();

  await db.execute(sql`
    insert into accounts (id, name) values (${accountId}, 'Staff Role Test');
  `);
  const userId = randomUUID();
  await db.execute(sql`
    insert into users (id, account_id, email) values (${userId}, ${accountId}, 'owner@example.test');
  `);
  // `last_sync_at` is the "moved on" gate of the `device_sync_stale` rule below: the worker
  // demonstrably synced this account AFTER the device's horizon, so there was server-side
  // motion the device never pulled.
  await db.execute(sql`
    insert into mailboxes (id, account_id, provider, address, status, last_sync_at)
    values (${mailboxId}, ${accountId}, 'imap', 'owner@example.test', 'connected', now());
  `);
  // A paired NATIVE device whose mirror last reached the horizon three days ago, with a live
  // session — the `device_sync_stale` SIGNAL. Seeded here rather than in the alert-pass case
  // because it is the only signal class whose rule reads columns (`devices`, `sessions`) that
  // exist on this role's allowlist, and the pass running as this role is what is under test.
  const deviceId = randomUUID();
  await db.execute(sql`
    insert into devices (id, account_id, user_id, kind, last_synced_at)
    values (${deviceId}, ${accountId}, ${userId}, 'macos', now() - interval '3 days');
  `);
  await db.execute(sql`
    insert into sessions
      (id, account_id, user_id, device_id, family_id, access_expires_at, refresh_expires_at)
    values (${randomUUID()}, ${accountId}, ${userId}, ${deviceId}, ${randomUUID()},
            now() + interval '1 hour', now() + interval '30 days');
  `);
  await db.execute(sql`
    insert into mailbox_credentials (mailbox_id, transport, secret_enc, key_version, meta)
    values (${mailboxId}, 'imap', 'ZZSECRETZZ', 1, '{"host":"imap.example.test"}'::jsonb);
  `);
  await db.execute(sql`
    insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address, snippet)
    values (${messageId}, ${accountId}, ${mailboxId}, 'h', 'd',
            'ZZSUBJECTZZ', 'ZZSENDERZZ@example.test', 'ZZSNIPPETZZ');
  `);
  await db.execute(sql`
    insert into message_bodies (id, message_id, text) values (${randomUUID()}, ${messageId}, 'ZZBODYZZ');
  `);
  await db.execute(sql`
    insert into folder_state (id, message_id, desired_folder, observed_folder, last_set_by, reconcile_status)
    values (${randomUUID()}, ${messageId}, 'Answer Later', 'Ohbox', 'us', 'pending');
  `);
  await db.execute(sql`
    insert into drafts (id, account_id, mailbox_id, subject, body)
    values (${draftId}, ${accountId}, ${mailboxId}, 'ZZDRAFTSUBJECTZZ', 'ZZDRAFTBODYZZ');
  `);
  await db.execute(sql`
    insert into outbound_sends (id, account_id, idempotency_key, draft_id, minted_message_id, status, created_at)
    values (${randomUUID()}, ${accountId}, 'ZZIDEMPOTENCYZZ', ${draftId},
            ${`<ZZMINTEDZZ@${managedDomain()}>`}, 'pending', now() - interval '2 hours');
  `);
  await db.execute(sql`
    insert into worker_heartbeats (shard_index, instance_id) values (0, 'staff-role-test');
  `);
  // The `admin.%` row the view admits, and a PRODUCT audit row it must filter out.
  await db.execute(sql`
    insert into audit_log (id, account_id, action, payload, inverse)
    values (${randomUUID()}, ${accountId}, 'admin.account.suspend',
            '{"actor":"staff_test","note":"ZZNOTEZZ"}'::jsonb, '{"action":"admin.account.resume"}'::jsonb);
  `);
  await db.execute(sql`
    insert into audit_log (id, account_id, action, payload, inverse)
    values (${randomUUID()}, ${accountId}, 'workflow_step',
            '{"effect":"ZZWORKFLOWEFFECTZZ"}'::jsonb, null);
  `);
  await db.execute(sql`
    insert into change_log (account_id, seq, entity_type, entity_id, op, meta)
    values (${accountId}, 1, 'message', ${messageId}, 'create', '{"note":"ZZCHANGEMETAZZ"}'::jsonb);
  `);
  return { accountId, mailboxId, messageId };
}
