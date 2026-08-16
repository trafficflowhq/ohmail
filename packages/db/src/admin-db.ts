import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { makePooledDb } from "./client.js";
import type { schema } from "./schema.js";
import {
  asCapabilities, describeCapability, staffCapabilityExcess,
  STAFF_CAPABILITY_SQL, STAFF_ROLE,
} from "./staff-grants.js";

/**
 * THE CONTENT-BLIND STAFF CONNECTION — the structural half of the rule that staff can operate
 * the service without ever being able to read anyone's mail.
 *
 * `scripts/harden-staff-role.sql` creates `ohmail_admin`, a Postgres role with column-level
 * grants that make `SELECT subject FROM messages` raise 42501. This module is the other half:
 * the handle the staff surfaces run on, and the two independent mechanisms that stop it from
 * ever being the runtime handle by accident.
 *
 * ## Why a second connection and not a role swap on the first
 *
 * The boundary is **staff-surface vs. user-serving runtime**, not "the API must not read
 * content". The API *must* read `subject`/`snippet`/`from_address` — those columns exist so it
 * can serve them to the account's own user, which is the isolation rule's first clause. Denying the
 * runtime role those columns kills the product. But the admin reads run in the SAME API
 * process on the SAME connection (`routes/admin.ts` passed `deps.db` to all six), so the seam
 * has to be a second connection inside that process.
 *
 * Per-request `SET ROLE` was considered and rejected: the production pooler runs in TRANSACTION
 * mode, where a session-level `SET ROLE` leaks across pooled requests in both directions.
 *
 * ## Mechanism 1 — the compile-time half
 *
 * {@link ContentBlind} is a nominal brand. `adminAccounts(db: AdminDb, …)` therefore refuses
 * `deps.db` at the type level: passing the runtime handle to a staff read is a TYPE ERROR, not
 * a review comment. Only {@link adminDbFor} mints the brand, and only after mechanism 2.
 *
 * ## Mechanism 2 — the boot attestation, because an absent-var check cannot see a WRONG value
 *
 * The realistic accident is not a missing `DATABASE_URL_ADMIN`; it is runtime credentials
 * pasted into it. A configuration check sees a non-empty string and is satisfied, the console
 * comes up, every screen works, and the isolation is gone with nothing anywhere reporting it.
 *
 * So the factory ASKS THE DATABASE — and it now asks the whole question.
 *
 * ### What the first cut got wrong, in its own words
 *
 * It asked ONE question: `select subject from messages where false`, and let a single 42501
 * mint the brand. The security review's finding, rated Critical:
 *
 * > Provision or drift a `DATABASE_URL_ADMIN` role so it lacks `SELECT(messages.subject)` but
 * > retains `SELECT(message_bodies.*)`, `SELECT(messages.snippet)`, `SELECT(messages.
 * > from_address)`, or access through another relation […] `assertContentBlind` treats that
 * > one denial as sufficient and brands the connection `AdminDb`.
 *
 * The oracle was sound in one direction only. A role that CAN read `messages.subject` is
 * certainly the wrong role; a role that CANNOT is not thereby the right one. Every other
 * mail-bearing column in the schema fell through the hole.
 *
 * ### What it does now: an effective-capability attestation, then a bite test
 *
 * {@link assertContentBlind} runs {@link STAFF_CAPABILITY_SQL} — one statement that enumerates
 * every relation, column, sequence, schema, role membership, role attribute, relation
 * ownership and SECURITY DEFINER routine the connected role can reach, using
 * `has_column_privilege` and friends so that a privilege inherited from a role, granted to
 * `PUBLIC`, or implied by OWNERSHIP counts exactly as much as a direct grant. It now also
 * asks every question of BOTH `current_user` and `session_user` and refuses outright when the
 * two differ, because a wrapper login defaulting `role = ohmail_admin` used to pass the whole
 * census while an unprivileged `SET ROLE NONE` stood ready to recover the wrapper — the
 * costume attested, the wearer did not. The answer is
 * compared to {@link STAFF_SELECT_GRANTS} — **the same allowlist `staff-role.pg.test.ts`
 * compares against, imported from `./staff-grants.js`, not a second copy of it.** Anything the
 * allowlist does not name refuses the brand and names itself in the error.
 *
 * The bite tests survive, and run FIRST, because they are the fast unambiguous answer to
 * the accident that actually happens: runtime credentials in the admin variable produce a
 * probe that SUCCEEDS, and "this connection can read message content" is a better first line
 * of a log than four hundred census rows. They are corroboration — the planner agreeing with
 * the catalog — and no longer the proof. The review asked for exactly that split.
 *
 * Both bites are `WHERE false`: Postgres checks column privileges when it PLANS the statement,
 * so the refusal arrives without a row being read and without a sequential scan on a table
 * with millions of rows in it.
 *
 * ### Cost
 *
 * Four round trips — three bites and the census — once per connection string per cold
 * instance, on the first staff request of that instance's life, or the first `/health` — see
 * {@link attestStaffDbFault}, which surfaces the outcome on `/health` non-fatally and
 * awaits this same memoised factory, so whichever comes first pays the round trips and the other
 * is instant. Never on a user-serving request, because the factory is lazy. (The third
 * bite, `count(*) from messages`, arrived with the row-existence fix; it is a refusal at plan
 * time and costs the round trip, not a scan.)
 *
 * MEASURED against PostgreSQL 16 on a fully migrated database (185 relations, 659 columns in
 * `public` + `admin`), averaged over 20 runs on a warm connection: the census is **1.4 ms**
 * and the whole of `assertContentBlind` is **2.0 ms**, against a 0.17 ms empty-round-trip
 * baseline on the same connection. It is catalog scans and syscache lookups; nothing in it
 * touches an application row, and the cost grows with the SCHEMA, not with the data. On a
 * remote database the network round trips will dominate that server time, and four round trips
 * once per cold instance is not a number worth optimising.
 *
 * It is deliberately not cached separately from the handle: the per-URL memo in
 * {@link adminDbFor} already means SUCCESS is paid once per instance and FAILURE is never
 * cached, which is the correct pair — a transient fault must not darken the console until the
 * instance recycles, and a passing attestation must not be re-run per request.
 */

/**
 * The nominal brand. A `declare const` symbol, so it exists only in the type system and
 * nothing can forge one by writing an object literal.
 *
 * It is not exported as a value on purpose: the ONLY way to obtain the brand is
 * {@link adminDbFor}, which cannot return one until the probe has passed. A test that needs a
 * branded handle casts explicitly, and that cast is visible in the diff.
 */
declare const contentBlind: unique symbol;

/** @see contentBlind */
export interface ContentBlind {
  readonly [contentBlind]: "ohmail_admin";
}

/**
 * A database handle that has PROVEN it is connected as a content-blind role.
 *
 * The union in `@trafficflow/services`' `Db` also admits PGlite, and the staff services widen
 * to `Db & ContentBlind` for that reason — PGlite has no roles at all, so the api-level tests
 * brand a PGlite handle by cast and prove the PROJECTION half, while
 * `test/staff-role.pg.test.ts` proves the ROLE half against real Postgres. Neither
 * substitutes for the other, and the pg guard says so by failing when it is pointed at the
 * runtime role.
 */
export type AdminDb = PostgresJsDatabase<typeof schema> & ContentBlind;

/**
 * `insufficient_privilege`. The ONLY answer to {@link CONTENT_BLIND_PROBE} that mints a brand.
 *
 * Not a message match: SQLSTATE is stable across Postgres versions and locales, and the error
 * TEXT is neither.
 */
export const DENIED_SQLSTATE = "42501";

/**
 * The first bite. `subject` because it is the plainest thing the isolation rule names, and
 * `messages` because it is the table the runtime role must keep, so a handle that can read
 * this column is by definition the runtime handle.
 *
 * It is NOT the proof of blindness — see {@link STAFF_CAPABILITY_SQL} for that. The first cut
 * treated it as the proof and the review's Critical finding is the bill for it.
 */
export const CONTENT_BLIND_PROBE = "select subject from messages where false";

/**
 * The bite tests, in order. Three statements, and every one of them must raise
 * {@link DENIED_SQLSTATE}.
 *
 * `message_bodies` is here BY NAME because it is the relation the Critical finding escaped
 * through: a role denied `messages.subject` and granted `message_bodies` passed the original
 * probe and served the console. The census would catch it now regardless; this makes the
 * headline case a one-statement answer that does not depend on the census being right.
 *
 * ── `select count(*) from messages` — the row-existence oracle ─────────────────────────────
 *
 * The third bite NAMES NO COLUMN, on purpose, and that is the whole reason it exists. Every
 * other check on this path — both other bites, and the census, which is built out of
 * `has_column_privilege` — asks "which COLUMNS can this role read". The row-existence oracle
 * is not a column
 * finding: staff resolved the target's `mailbox_id`, counted rows in `messages` for it, sent a
 * probe carrying a chosen Message-ID and watched the count move. `count(*)` requires only that
 * the relation be readable AT ALL.
 *
 * A role granted `SELECT (id) ON messages` "to make a join work" would pass both other bites
 * and would be caught by the census — but the census's answer is one row among four hundred,
 * and this one is a single statement whose failure says the sentence out loud. It is also the
 * check that a future re-widening trips FIRST.
 *
 * No `WHERE false` here, and that is deliberate: `WHERE false` lets the planner answer without
 * touching the relation, which is exactly what makes the other two cheap, but a privilege
 * refusal on `count(*)` also arrives at plan time — the permission check is on the relation,
 * not on the rows — so the statement is as cheap and strictly stronger.
 */
export const CONTENT_BITE_TESTS: ReadonlyArray<readonly [string, string]> = [
  ["messages.subject", CONTENT_BLIND_PROBE],
  ["message_bodies", "select text from message_bodies where false"],
  ["messages (row existence)", "select count(*) from messages"],
];

/** Refusal to mint a staff handle. Carries no connection string and no driver message. */
export class NotContentBlindError extends Error {
  constructor(readonly reason: string) {
    super(
      `refusing to build the staff database handle: ${reason}. DATABASE_URL_ADMIN must name a ` +
      `role that cannot read message content — run scripts/harden-staff-role.sql and point it ` +
      `at ohmail_admin`,
    );
    this.name = "NotContentBlindError";
  }
}

/** The driver's SQLSTATE, or null. postgres-js puts it on `.code`; PGlite nests it. */
function sqlstateOf(err: unknown): string | null {
  const direct = (err as { code?: unknown } | null)?.code;
  if (typeof direct === "string") return direct;
  const nested = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof nested === "string" ? nested : null;
}

/** How many excess capabilities an error lists before it says "and N more". */
const FAULTS_NAMED = 8;

/**
 * Run ONE bite test and throw {@link NotContentBlindError} unless Postgres refuses it.
 *
 * `label` names the relation, so a bite that failed for the WRONG reason says which bite it
 * was. The one branch that quotes the statement is the dangerous one — a bite that SUCCEEDED —
 * because there the exact SQL is the finding.
 */
async function bite(
  db: Pick<PostgresJsDatabase<typeof schema>, "execute">,
  label: string,
  statement: string,
): Promise<void> {
  try {
    await db.execute(sql.raw(statement));
  } catch (err) {
    const code = sqlstateOf(err);
    if (code === DENIED_SQLSTATE) return;
    // A connection failure, a missing table, a syntax error — none of them is evidence of
    // blindness, so none of them may mint the brand.
    throw new NotContentBlindError(
      code === null
        ? `the ${label} bite test failed with no SQLSTATE (the database is unreachable, or the schema is not this application's)`
        : `the ${label} bite test failed with SQLSTATE ${code}, not ${DENIED_SQLSTATE}`,
    );
  }
  // THE DANGEROUS CASE. A bite test that SUCCEEDS means this connection can read mail, which
  // means it is the runtime connection wearing the admin variable's name.
  throw new NotContentBlindError(
    `'${statement}' SUCCEEDED — this connection can read message content`,
  );
}

/**
 * ATTEST that `db` is connected as a role whose EFFECTIVE capabilities are a subset of the
 * staff allowlist, and throw {@link NotContentBlindError} if they are not.
 *
 * Two mechanisms, in this order and both required:
 *
 *  1. {@link CONTENT_BITE_TESTS} — `messages.subject`, `message_bodies` and
 *     `count(*) from messages` must all raise 42501. Fast, and the pasted-runtime-credentials
 *     accident produces a one-line answer. The third names no column, which is what makes it
 *     able to see the row-existence oracle at all.
 *  2. {@link STAFF_CAPABILITY_SQL} — the census. Every column, table privilege, sequence,
 *     schema, role membership, role attribute, relation ownership and SECURITY DEFINER
 *     routine the role can reach, compared to {@link STAFF_SELECT_GRANTS} and its siblings.
 *     Excess refuses the brand and names itself. (Shortfall does not — see
 *     {@link staffCapabilityExcess} for why that asymmetry is the fail-closed direction.)
 *
 * Exported so the pg guard can call it directly against a role it chose, which is what makes
 * "delete the attestation" observable as a red test rather than as a silent widening.
 */
export async function assertContentBlind(
  db: Pick<PostgresJsDatabase<typeof schema>, "execute">,
): Promise<void> {
  for (const [label, statement] of CONTENT_BITE_TESTS) await bite(db, label, statement);

  let rows: unknown;
  try {
    rows = await db.execute(sql.raw(STAFF_CAPABILITY_SQL));
  } catch (err) {
    // The census is the PROOF. A census that cannot be read is not a passing census, and a
    // handle whose capabilities are unknown is not a handle that may serve staff.
    const code = sqlstateOf(err);
    throw new NotContentBlindError(
      `the capability census could not be read${code === null ? "" : ` (SQLSTATE ${code})`}` +
      ` — nothing has attested that this connection is ${STAFF_ROLE}`,
    );
  }

  const held = asCapabilities(rows);
  // VACUITY. An empty census passes every comparison below, so a driver that handed back a
  // shape this module does not understand would look exactly like a perfectly narrow role.
  // Every connected role holds at least `USAGE` on some schema, so zero rows is never an
  // answer — it is the absence of one.
  if (held.length === 0) {
    throw new NotContentBlindError(
      "the capability census returned no rows — the driver did not hand back a result set, " +
      "so nothing was attested",
    );
  }

  const excess = staffCapabilityExcess(held);
  if (excess.length === 0) return;

  // The costume/wearer case — a `session` capability in the excess means `session_user <> current_user`: the
  // connection is WEARING `ohmail_admin` while a privilege-free `SET ROLE NONE` stands ready to
  // recover the login role's own capabilities. It is refused like any other excess (there is no
  // allowlisted `session` kind), and `describeCapability` names it in the message — for a bare
  // wrapper the excess is small enough that the `SET ROLE NONE` line is among those named.
  const named = excess.slice(0, FAULTS_NAMED).map(describeCapability).join("; ");
  const rest = excess.length > FAULTS_NAMED ? `; and ${excess.length - FAULTS_NAMED} more` : "";
  throw new NotContentBlindError(
    `the connected role holds ${excess.length} capabilit${excess.length === 1 ? "y" : "ies"} ` +
    `the staff allowlist does not name — ${named}${rest}`,
  );
}

/**
 * One probed handle per connection string, per cold instance.
 *
 * SUCCESS is cached (the probe is one round trip on the first admin request of an instance's
 * life, not one per request). FAILURE is NOT: a transient connection fault at the wrong moment
 * would otherwise darken the console until the instance is recycled, and the next request is
 * free to ask again.
 */
const handles = new Map<string, Promise<AdminDb>>();

/**
 * The staff handle factory for `url`. Lazy: nothing connects until a staff route is served, so
 * a cold start for `GET /health` pays nothing.
 *
 * There is deliberately **no fallback** anywhere on this path. A caller that has no
 * `DATABASE_URL_ADMIN` gets no factory at all and its routes answer 404; a caller whose URL is
 * wrong gets a rejected promise and a 503. "Absent config selects the dangerous branch" is this
 * repository's recurring failure shape, and the dangerous branch here is the runtime handle.
 */
export function adminDbFor(url: string): () => Promise<AdminDb> {
  return () => {
    const held = handles.get(url);
    if (held) return held;
    const pending = (async (): Promise<AdminDb> => {
      const db = makePooledDb(url);
      await assertContentBlind(db);
      return db as AdminDb;
    })();
    handles.set(url, pending);
    pending.catch(() => {
      if (handles.get(url) === pending) handles.delete(url);
    });
    return pending;
  };
}

/** Test seam: forget every probed handle so a test can point the same URL at another role. */
export function resetAdminDbs(): void {
  handles.clear();
}

/**
 * The boot attestation's outcome as a SHORT, non-throwing, disclosure-safe string,
 * for `/health` to publish beside `adminFault`.
 *
 * The census + bite tests that {@link adminDbFor} runs used to surface ONLY as a per-request
 * 503 the first time a staff route was hit: a wrong-but-plausible role — an equivalently-spelled
 * over-privileged `DATABASE_URL_ADMIN` — left `/health` green and the console dark until someone
 * loaded it. There is no disclosure either way (the handle refuses to mint, so nothing leaks),
 * but the diagnostic cost was real. This lets `/health` name it minutes earlier, at 200.
 *
 * It AWAITS the memoised factory, so it pays the four probe round trips only on the FIRST call
 * per cold instance (success is cached; failure is not, and is retried) and is instant
 * thereafter — the same lazy handle a staff request would build, not a second connection. It
 * NEVER throws and NEVER makes `/health` fatal: the return is the reason string or null.
 *
 * Disclosure-safe by construction:
 *  · a {@link NotContentBlindError} carries only `pg_catalog` identifiers (a schema, a relation,
 *    a column, a privilege verb) — `describeCapability`'s output, quotable verbatim; and
 *  · any OTHER failure (an unreachable blind host, say) is collapsed to a fixed string, because
 *    a driver message can name the host and the role and this value is published.
 */
export async function attestStaffDbFault(
  handle: () => Promise<AdminDb>,
): Promise<string | null> {
  try {
    await handle();
    return null;
  } catch (err) {
    if (err instanceof NotContentBlindError) {
      return `staff DB attestation FAILED: ${err.reason}`;
    }
    // No driver text: it can name the blind host and role, and `/health` publishes this.
    return "staff DB attestation could not run (the content-blind connection is unreachable)";
  }
}
