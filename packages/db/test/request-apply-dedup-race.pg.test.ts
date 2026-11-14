import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { applyMessageMove, MOVE_DESTINATIONS } from "../src/request-apply.js";
import { REQUEST_KINDS } from "@trafficflow/core/adapters/organizer-lease";
import type { Tx } from "../src/change-log.js";
import { brandDialect } from "../src/dialect/index.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  mail 0094 ON REAL POSTGRES — the widened kind CHECK, and two drains racing one dedup key
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two things PGlite cannot answer, and they are the two this file exists for.
 *
 * ── (1) THE WIDENED CHECK IS WHAT THE SERVER DOES, not what the code believes ──────────────
 *
 * `organizer_requests_kind_closed` gained two members. A green run against a database that never
 * applied the migration would say nothing at all, so the migrations are applied here and both the
 * admission and the refusal are read off the server. The vocabulary is READ FROM THE CODE
 * (`REQUEST_KINDS`) rather than retyped: a seventh kind added to the code and not to the
 * constraint is a row the database rejects at the instant a reader tries to queue it, and
 * retyping the list here is what lets the two drift in exactly that direction.
 *
 * ── (2) THE DEDUP RACE, which is the whole reason this file is `.pg.test.ts` ───────────────
 *
 * Two drain cycles can meet the same request record — a cycle that overran, a second process, a
 * retry after an ambiguous failure. Both resolve the same `(mailbox_id, dedup_key)` and both write
 * `folder_state` for the same message. Under PGlite that interleaving does not exist: statements
 * from two "connections" serialize, so a green there is a statement about a single-threaded
 * database and this repository has already paid three times for believing one.
 *
 * What must hold, and each is asserted separately below:
 *   · ONE `folder_state` row, whatever the interleaving — the upsert is keyed on `message_id`.
 *   · `observed_folder` still the worker's value, not either writer's guess.
 *   · Neither transaction reports success while having written nothing (the failure that looks
 *     like health: an applier that swallowed a unique violation and answered `applied`).
 *
 * `REPEATABLE READ` is deliberately NOT used here: the drain runs at the driver's default (READ
 * COMMITTED), and testing a stricter level than production runs would measure a database nobody
 * deploys.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MAIL_DIR = join(HERE, "..", "..", "db-mail", "drizzle");
const ADMIN_URL = PG_TEST_URL;
const PG_UP = await realPgAvailable(ADMIN_URL);

const ACCT = randomUUID();
const NOW = new Date("2026-09-07T12:00:00.000Z");

describe.skipIf(!PG_UP)("mail 0094 on real Postgres", () => {
  const dbName = `tf_move_race_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase;
  let mailboxId: string;

  beforeAll(async () => {
    admin = postgres(ADMIN_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    // `max: 4` — the race needs two REAL connections. One would serialize the interleaving away
    // and the case would pass by not being the case at all.
    client = postgres(url.toString(), { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client), "pg");
    await migrate(db, { migrationsFolder: MAIL_DIR, migrationsSchema: "drizzle_mail" });

    await db.execute(sql`INSERT INTO accounts (id, name) VALUES (${ACCT}, 'move race')`);
    const rows = await db.execute<{ id: string }>(sql`
      INSERT INTO mailboxes (account_id, provider, address)
      VALUES (${ACCT}, 'imap', ${`${randomUUID()}@x.example`})
      RETURNING id`);
    mailboxId = (rows as unknown as Array<{ id: string }>)[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 }).catch(() => {});
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => {});
    await admin?.end({ timeout: 5 }).catch(() => {});
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  /** One message with a fresh dedup key, plus the `folder_state` row the worker owns. */
  async function seedMessage(observed: string): Promise<{ id: string; dedupKey: string }> {
    const dedupKey = randomUUID().replace(/-/g, "");
    const th = await db.execute<{ id: string }>(sql`
      INSERT INTO threads (account_id, subject) VALUES (${ACCT}, 'race') RETURNING id`);
    const threadId = (th as unknown as Array<{ id: string }>)[0]!.id;
    const rows = await db.execute<{ id: string }>(sql`
      INSERT INTO messages (account_id, mailbox_id, thread_id, dedup_key, message_id_header, body_hash, native_locator)
      VALUES (${ACCT}, ${mailboxId}, ${threadId}, ${dedupKey}, ${`<${dedupKey}@x.example>`}, ${randomUUID()},
              ${JSON.stringify({ folder: observed, uidvalidity: "1", uid: 7 })}::jsonb)
      RETURNING id`);
    const id = (rows as unknown as Array<{ id: string }>)[0]!.id;
    await db.execute(sql`
      INSERT INTO folder_state (message_id, account_id, desired_folder, observed_folder, last_set_by, reconcile_status, conflict)
      SELECT id, account_id, ${observed}, ${observed}, 'worker', 'clean', false FROM messages WHERE id = ${id}`);
    return { id, dedupKey };
  }

  /* ══ (1) THE WIDENED CHECK ══════════════════════════════════════════════════════════════ */

  it("the constraint exists under the name the schema census asks for", async () => {
    const rows = await db.execute<{ conname: string }>(sql`
      SELECT conname FROM pg_constraint WHERE conname = 'organizer_requests_kind_closed'`);
    expect((rows as unknown as unknown[]).length).toBe(1);
  });

  it("every kind the CODE writes is admitted — the constraint is not narrower than REQUEST_KINDS", async () => {
    for (const kind of REQUEST_KINDS) {
      await db.execute(sql`
        INSERT INTO organizer_requests (id, account_id, mailbox_id, kind, payload, decided_at, state)
        VALUES (${randomUUID()}, ${ACCT}, ${mailboxId}, ${kind}, ${"{}"}::jsonb, now(), 'pending')`)
        .catch((err: unknown) => {
          throw new Error(`the database refused kind '${kind}', which this build writes: ${String(err)}`);
        });
    }
    const rows = await db.execute<{ n: string }>(sql`
      SELECT count(DISTINCT kind)::text AS n FROM organizer_requests`);
    expect(Number((rows as unknown as Array<{ n: string }>)[0]!.n)).toBe(REQUEST_KINDS.length);
  });

  it("the two NEW members are admitted by name, so a green above cannot be vacuous", async () => {
    // Named explicitly as well as swept: if `REQUEST_KINDS` were ever shortened, the sweep above
    // would pass over a narrower list and report nothing.
    for (const kind of ["message.move", "profile.update"]) {
      expect(REQUEST_KINDS as readonly string[], `${kind} left REQUEST_KINDS`).toContain(kind);
      await db.execute(sql`
        INSERT INTO organizer_requests (id, account_id, mailbox_id, kind, payload, decided_at, state)
        VALUES (${randomUUID()}, ${ACCT}, ${mailboxId}, ${kind}, ${"{}"}::jsonb, now(), 'pending')`);
    }
  });

  it("an unrecognised kind is STILL refused — the set is closed, not merely wider", async () => {
    /* The half a widening migration can quietly lose. `DROP CONSTRAINT` + `ADD CONSTRAINT` is two
       statements, and a file that dropped and failed to re-add would pass every admission case
       above while the column had become free text — and the drain's fall-through branch is the one
       that moves somebody's mail. */
    let refused = false;
    await db.execute(sql`
      INSERT INTO organizer_requests (id, account_id, mailbox_id, kind, payload, decided_at, state)
      VALUES (${randomUUID()}, ${ACCT}, ${mailboxId}, 'message.shred', ${"{}"}::jsonb, now(), 'pending')`)
      .catch(() => { refused = true; });
    expect(refused, "the database accepted a kind no applier exists for").toBe(true);
  });

  /* ══ (2) THE DEDUP RACE ════════════════════════════════════════════════════════════════ */

  it("two concurrent applies of ONE dedup key leave ONE row, with observed preserved", async () => {
    const msg = await seedMessage("ohmail/Screener");
    const payload = { dedupKey: msg.dedupKey, destination: "reads" };

    /* BOTH TRANSACTIONS OPEN BEFORE EITHER WRITES. Awaiting them in sequence would test a
       sequence; `Promise.all` over two transactions on a pool of four is what puts two real
       backends inside the window at once. */
    const [a, b] = await Promise.all([
      db.transaction((tx) => applyMessageMove(tx as unknown as Tx, {
        accountId: ACCT, mailboxId, payload, now: NOW,
      })),
      db.transaction((tx) => applyMessageMove(tx as unknown as Tx, {
        accountId: ACCT, mailboxId, payload, now: NOW,
      })),
    ]);

    /* NEITHER MAY REPORT SUCCESS HAVING WRITTEN NOTHING. That is the failure shaped like health:
       an applier that swallowed a unique violation and answered `applied` would leave the reader
       acked and the mail unmoved, with no error anywhere. Both applied, or one threw — never one
       silently applying nothing. */
    expect(a.applied, "the first apply reported no move").toBe(true);
    expect(b.applied, "the second apply reported no move").toBe(true);

    const rows = await db.execute<{ desired: string; observed: string; status: string; by: string; n: string }>(sql`
      SELECT desired_folder AS desired, observed_folder AS observed, reconcile_status AS status,
             last_set_by AS by, count(*) OVER ()::text AS n
      FROM folder_state WHERE message_id = ${msg.id}`);
    const got = rows as unknown as Array<{ desired: string; observed: string; status: string; by: string; n: string }>;
    expect(got.length, "two racing applies produced more than one folder_state row").toBe(1);
    expect(got[0]!.desired).toBe("ohmail/News");
    // The worker's own value, from BEFORE either apply. Either writer overwriting it would assert
    // a physical move neither performed.
    expect(got[0]!.observed, "observed_folder was overwritten by a racing apply").toBe("ohmail/Screener");
    expect(got[0]!.status).toBe("pending");
    expect(got[0]!.by).toBe("us");
  }, 60_000);

  it("two concurrent applies to DIFFERENT destinations settle on one of them, never a blend", async () => {
    /* The interleaving with a real outcome to choose. Whichever commits last wins, and the point
       is that the row is INTERNALLY CONSISTENT either way — one desired folder, one pending
       status, the worker's observed value intact. A blend (say, one writer's desired with the
       other's status) is the state this asserts is unrepresentable. */
    const msg = await seedMessage("INBOX");
    const [a, b] = await Promise.all([
      db.transaction((tx) => applyMessageMove(tx as unknown as Tx, {
        accountId: ACCT, mailboxId, payload: { dedupKey: msg.dedupKey, destination: "reads" }, now: NOW,
      })),
      db.transaction((tx) => applyMessageMove(tx as unknown as Tx, {
        accountId: ACCT, mailboxId, payload: { dedupKey: msg.dedupKey, destination: "receipts" }, now: NOW,
      })),
    ]);
    expect(a.applied && b.applied).toBe(true);

    const rows = await db.execute<{ desired: string; observed: string; status: string }>(sql`
      SELECT desired_folder AS desired, observed_folder AS observed, reconcile_status AS status
      FROM folder_state WHERE message_id = ${msg.id}`);
    const got = rows as unknown as Array<{ desired: string; observed: string; status: string }>;
    expect(got.length).toBe(1);
    expect(["ohmail/News", "ohmail/Receipts"],
      "the surviving desired_folder is neither writer's — the row is a blend")
      .toContain(got[0]!.desired);
    expect(got[0]!.observed).toBe("INBOX");
    expect(got[0]!.status).toBe("pending");
  }, 60_000);

  it("the change feed carries one move per apply — duplicates are the client's problem, not a lost write", async () => {
    /* `change_log` is deliberately NOT deduplicated: two racing cycles emit two `move` rows for one
       message, the client's apply is idempotent by contract (convergence under duplicates), and
       making the ledger conditional on a read is where a real race would hide. Asserted so the
       decision is visible rather than discovered — and the floor is what matters: fewer rows than
       applies would mean a write was lost. */
    const msg = await seedMessage("INBOX");
    const payload = { dedupKey: msg.dedupKey, destination: "screened" };
    await Promise.all([
      db.transaction((tx) => applyMessageMove(tx as unknown as Tx, { accountId: ACCT, mailboxId, payload, now: NOW })),
      db.transaction((tx) => applyMessageMove(tx as unknown as Tx, { accountId: ACCT, mailboxId, payload, now: NOW })),
    ]);
    const rows = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM change_log
      WHERE account_id = ${ACCT} AND entity_id = ${msg.id} AND op = 'move'`);
    expect(Number((rows as unknown as Array<{ n: string }>)[0]!.n),
      "a racing apply lost its change_log row").toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("`trash` resolves against the mailbox row under concurrency too, or refuses cleanly", async () => {
    // The one destination that needs a second read. With no Trash discovered both applies must
    // refuse and neither may write — a half-applied refusal would leave a pending intent to move
    // mail into a folder that does not exist.
    const msg = await seedMessage("INBOX");
    const payload = { dedupKey: msg.dedupKey, destination: "trash" };
    expect(MOVE_DESTINATIONS.get("trash"), "trash stopped being per-mailbox").toBeNull();
    const [a, b] = await Promise.all([
      db.transaction((tx) => applyMessageMove(tx as unknown as Tx, { accountId: ACCT, mailboxId, payload, now: NOW })),
      db.transaction((tx) => applyMessageMove(tx as unknown as Tx, { accountId: ACCT, mailboxId, payload, now: NOW })),
    ]);
    expect(a).toEqual({ applied: false, refusal: "no_trash_folder" });
    expect(b).toEqual({ applied: false, refusal: "no_trash_folder" });
    const rows = await db.execute<{ desired: string }>(sql`
      SELECT desired_folder AS desired FROM folder_state WHERE message_id = ${msg.id}`);
    // The worker's own row is untouched — still its own desired value, not a Trash guess.
    expect((rows as unknown as Array<{ desired: string }>)[0]!.desired).toBe("INBOX");
  }, 60_000);
});
