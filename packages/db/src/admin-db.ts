import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { makePooledDb } from "./client.js";
import type { schema } from "./schema.js";
import {
  asCapabilities, describeCapability, staffCapabilityExcess,
  STAFF_CAPABILITY_SQL, STAFF_ROLE,
} from "./staff-grants.js";

/**
 * The content-blind staff connection — the structural half of "staff can operate the service
 * without ever reading anyone's mail". `harden-staff-role.sql` creates `ohmail_admin`, whose
 * grants make `SELECT subject FROM messages` raise 42501; this is the handle staff surfaces run
 * on. A second connection, not a role swap: the API must read subject/snippet for the account's
 * own user, and `SET ROLE` leaks across a transaction-mode pooler. Mechanism 1: {@link
 * ContentBlind}, a brand only {@link adminDbFor} mints — `deps.db` in a staff read is a type
 * error. Mechanism 2: the boot attestation — the bite tests, then {@link STAFF_CAPABILITY_SQL}
 * against {@link STAFF_SELECT_GRANTS}. Success memoised; failure never cached.
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
 * The bite tests, in order; every one must raise {@link DENIED_SQLSTATE}. `message_bodies` is
 * here by name because it is the relation the Critical finding escaped through: a role denied
 * `messages.subject` and granted `message_bodies` passed the original probe. The third bite,
 * `select count(*) from messages`, names no column on purpose: the row-existence oracle is not a
 * column finding — staff could count rows for a mailbox, send a probe with a chosen Message-ID,
 * and watch the count move. No `WHERE false` on it: a privilege refusal on `count(*)` arrives at
 * plan time anyway, so it is as cheap and strictly stronger.
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
 * Attest that `db` is connected as a role whose effective capabilities are a subset of the staff
 * allowlist; throw {@link NotContentBlindError} otherwise. Two mechanisms, in order, both
 * required: {@link CONTENT_BITE_TESTS} — all three must raise 42501, fast, and the
 * pasted-runtime-credentials accident gets a one-line answer; then {@link STAFF_CAPABILITY_SQL} —
 * the census, compared to {@link STAFF_SELECT_GRANTS}; excess refuses the brand and names itself
 * (shortfall does not — {@link staffCapabilityExcess} explains the asymmetry). Exported so the pg
 * guard can call it against a role it chose — "delete the attestation" is a red test, not a
 * silent widening.
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
 * The boot attestation's outcome as a short, non-throwing, disclosure-safe string for `/health`
 * to publish beside `adminFault`. The census used to surface only as a per-request 503 the first
 * time a staff route was hit: a wrong-but-plausible role left `/health` green and the console
 * dark until someone loaded it. It awaits the memoised factory, so it pays the probe round trips
 * only on the first call per cold instance (success cached, failure retried), never throws, and
 * never makes `/health` fatal. Disclosure-safe by construction: a {@link NotContentBlindError}
 * carries only `pg_catalog` identifiers, and any other failure collapses to a fixed string — a
 * driver message can name the host and role, and this value is published.
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
