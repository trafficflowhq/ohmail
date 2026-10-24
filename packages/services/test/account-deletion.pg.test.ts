import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, inArray, sql } from "drizzle-orm";
import {
  accounts, drafts, flagState, mailboxes, messageFailures, messageInstances, messages,
  outboundSendFingerprints, outboundSends, pairingTokens, users,
} from "@trafficflow/db";
import {
  accountLifecycleNotices, attachmentStaging, claimRefundObligations, creditRefundObligations,
  pruneErasedNotices, schema,
} from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { ERASED_REFRESH_KEEP_DAYS } from "../../db/src/erased-bearers.js";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { deleteAccount, ErasureUnwarnedError, type ServiceContext } from "../src/index.js";
import {
  EMAIL_NOT_A_CUSTOMERS, EXPIRED_NOT_DELETED, LATER, NOW, RETAINED, accountScopedTables,
  emailBearingTables, erasureScopeTables, rowsOf, seedFullAccount, unseededScopedTables, type Db,
} from "./helpers/erasure-fixture.js";

/**
 * ART. 17 ERASURE, ON REAL POSTGRES — the file the service's header claimed existed for months
 * and which had never been added on any branch.
 *
 * ## Why PGlite green was worth nothing here
 *
 * It was not that PGlite enforces foreign keys differently — it enforces them fine. It is that
 * the PGlite suite's oracle was a CATALOG SWEEP over tables carrying an `account_id`, and a sweep
 * can only report a table it finds ROWS in. `seedFullAccount` never populated
 * `message_instances`, `message_failures` or `flag_state`, so the sweep counted zero in each,
 * passed, and went on passing while `DELETE /account` raised `23503` for every account that had
 * ever fetched mail. A guard whose reach is decided by a fixture is a guard that stops where
 * somebody's attention stopped.
 *
 * ## So this file's oracle is the CATALOG, not the fixture
 *
 * `erasureScopeTables` walks `information_schema` for every table reachable from `accounts` — by
 * the `account_id` column, then transitively through foreign keys in the child direction — and
 * the structural case below demands that each one be either NAMED IN `result.deleted` (which
 * `deleteAccount` reports at RUNTIME, so the oracle cannot drift away from the code) or on a
 * written exemption list. A table added next month fails this suite until somebody rules on it,
 * which is the property the old comment claimed and did not have.
 *
 * The behavioural half stays here too, because a name in `result.deleted` proves a statement was
 * issued and not that it emptied anything: the full-shape case seeds an account with the mail a
 * real sync leaves behind and then asserts, table by table out of the catalog, that nothing of it
 * survives.
 *
 * Run against the SHARED test Postgres, so every assertion is scoped to the account under test —
 * rows from other files are present throughout and a global `count(*)` would be meaningless.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: Db;

const ctxFor = (accountId: string, userId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId,
  now: () => NOW,
  requestId: "erasure-pg",
});

/** `count(*)` for one account in one table, by name — the sweep's primitive. */
async function countFor(table: string, accountId: string): Promise<number> {
  const rows = await db.execute(
    sql`select count(*)::int as c from ${sql.identifier(table)} where account_id = ${accountId}`,
  );
  return rowsOf<{ c: number }>(rows)[0]!.c;
}

/** The columns of a table that can hold free text — what a row kept past erasure must rule on. */
async function freeTextColumns(table: string): Promise<string[]> {
  return rowsOf<{ column_name: string }>(await db.execute(sql`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
      and data_type in ('text', 'character varying', 'character', 'json', 'jsonb')
    order by column_name`)).map((r) => r.column_name);
}

describe.skipIf(!PG_UP)("Art. 17 erasure — real Postgres, real foreign keys", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg") as unknown as Db;
  }, 180_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("erases an account with the FULL synced shape — the path that used to raise 23503", async () => {
    // The regression, stated as the thing that actually happened: an account with mail in it
    // could not be erased at all. `message_instances` FKs both `mailboxes` and `messages`,
    // `message_failures` FKs `mailboxes`, `flag_state` FKs `messages`, all `ON DELETE no action`,
    // and all three are written by ordinary sync. Any one of them left behind aborts the
    // transaction, so the whole erasure rolls back and the caller gets a 500.
    const seeded = await seedFullAccount(db, "Erasable");

    // The seed is REAL before we believe anything about the delete.
    expect(await countFor("message_instances", seeded.accountId)).toBe(2);
    expect(await countFor("message_failures", seeded.accountId)).toBe(1);
    expect(await db.select().from(flagState).where(eq(flagState.messageId, seeded.messageId)))
      .toHaveLength(1);

    const result = await deleteAccount(ctxFor(seeded.accountId, seeded.userId));

    expect(result.usersErased).toBe(1);
    expect(result.deleted.message_instances).toBe(2);
    expect(result.deleted.message_failures).toBe(1);
    expect(result.deleted.flag_state).toBe(1);
    // Both `routing_decisions` shapes — a pipeline decision and a bought screener suggestion,
    // which share the table and are told apart by `input_provenance`.
    expect(result.deleted.routing_decisions).toBe(2);

    // And the mail itself is gone, checked against the tables rather than the report.
    expect(await db.select().from(messages).where(eq(messages.accountId, seeded.accountId)))
      .toHaveLength(0);
    expect(await db.select().from(mailboxes).where(eq(mailboxes.accountId, seeded.accountId)))
      .toHaveLength(0);
    expect(await db.select().from(messageInstances)
      .where(eq(messageInstances.accountId, seeded.accountId))).toHaveLength(0);
    expect(await db.select().from(messageFailures)
      .where(eq(messageFailures.accountId, seeded.accountId))).toHaveLength(0);
    expect(await db.select().from(flagState).where(eq(flagState.messageId, seeded.messageId)))
      .toHaveLength(0);
  }, 60_000);

  it("STRUCTURAL — every FK-reachable table is erased, or on the written exemption list", async () => {
    // THE GUARD THIS SLICE EXISTS TO ADD. Nothing here is a list of tables somebody remembered:
    // the scope comes from `information_schema` and the coverage comes from what `deleteAccount`
    // reports at runtime. Add a table with an `account_id`, or one that references anything in
    // the account's graph, and it appears in `scope`, is absent from both `covered` and the
    // exemption sets, and fails right here — with its own name in the message.
    const scope = await erasureScopeTables(db);

    // The walk is real, not an empty set that would pass vacuously. These eight are the ones the
    // old `account_id`-only sweep could not reach or did not seed.
    expect(scope).toEqual(expect.arrayContaining([
      "message_instances", "message_failures", "flag_state", "message_bodies", "folder_state",
      "mailbox_credentials", "attachment_staging", "account_settings",
    ]));
    expect(scope.length).toBeGreaterThan(45);
    // …and it does NOT drag in the operator's own identity tables: only the CHILD direction is
    // followed, so a customer's erasure has no opinion about staff. Reversing the walk in
    // `erasureScopeTables` is what these two refuse — the edge that used to make the point
    // (`account_suspensions.suspended_by -> staff_users`) left with the billing tables.
    expect(scope).not.toContain("staff_users");
    expect(scope).not.toContain("staff_sessions");

    const seeded = await seedFullAccount(db, "Structural");
    const result = await deleteAccount(ctxFor(seeded.accountId, seeded.userId));

    const covered = new Set([...Object.keys(result.deleted), ...EXPIRED_NOT_DELETED, ...RETAINED]);
    const unruled = scope.filter((t) => !covered.has(t));
    expect(
      unruled,
      "a table in the account's foreign-key graph that erasure has no ruling for — either delete " +
        "it in account-deletion-service.ts, or add it to RETAINED / EXPIRED_NOT_DELETED in " +
        "helpers/erasure-fixture.ts with the reason written down",
    ).toEqual([]);

    // `pairing_tokens` is USER-scoped (no account column), so the account-scoped sweep below
    // cannot count it — asserted here directly instead. The fixture seeded a LIVE device-pair
    // token, which is a credential that would still open this account after erasure: zero rows
    // is the fact, and `result.deleted` reporting the statement ran is only evidence for it.
    expect(result.deleted.pairing_tokens).toBe(1);
    expect(await db.select().from(pairingTokens)
      .where(eq(pairingTokens.createdByUserId, seeded.userId))).toHaveLength(0);
  }, 60_000);

  it("STRUCTURAL — every table keyed by an ADDRESS is redacted, or ruled out in writing", async () => {
    // and the guard the row asked for. The structural case above walks the account's
    // foreign-key graph, and the signup funnel is not in it: `invites` and `waitlist` hold a
    // person by their ADDRESS and carry nothing that names the account, so both sat outside every
    // oracle this file had while keeping an erased person's address on file.
    //
    // The second scope is the catalog again, not a list: every public table with an `email`
    // column that the account graph does not already cover. Each must be named in
    // `result.redacted` or on the written `EMAIL_NOT_A_CUSTOMERS` list.
    const scope = new Set(await erasureScopeTables(db));
    const funnel = (await emailBearingTables(db)).filter((t) => !scope.has(t));

    // The walk is real, not an empty set that would pass vacuously — and `users` is NOT here,
    // because the account graph already reaches it and deletes it outright.
    expect(funnel).toEqual(expect.arrayContaining(["invites", "waitlist"]));
    expect(funnel).not.toContain("users");

    const seeded = await seedFullAccount(db, "Funnel");
    const result = await deleteAccount(ctxFor(seeded.accountId, seeded.userId));

    const covered = new Set([...Object.keys(result.redacted), ...EMAIL_NOT_A_CUSTOMERS]);
    const unruled = funnel.filter((t) => !covered.has(t));
    expect(
      unruled,
      "a table stores a person by their address and erasure has no ruling for it — either redact " +
        "it in account-deletion-service.ts, or add it to EMAIL_NOT_A_CUSTOMERS in " +
        "helpers/erasure-fixture.ts with the reason written down",
    ).toEqual([]);

    // A name in `result.redacted` proves a statement ran, not that it emptied anything: the
    // address itself, counted out of the two tables by hand.
    const left = rowsOf<{ c: number }>(await db.execute(sql`
      select ((select count(*) from invites where email = ${seeded.email})
           + (select count(*) from waitlist where email = ${seeded.email}))::int as c
    `));
    expect(left[0]!.c, "the erased address survives in the signup funnel").toBe(0);

    // And the funnel ROW is still there — the operator's count is a fact about the service.
    const kept = rowsOf<{ c: number }>(await db.execute(sql`
      select ((select count(*) from invites where id = ${seeded.inviteId})
           + (select count(*) from waitlist where id = ${seeded.waitlistId}))::int as c
    `));
    expect(kept[0]!.c, "the funnel rows were deleted rather than pseudonymised").toBe(2);
  }, 60_000);

  it("leaves NOTHING for that account in any account-scoped table but the account row", async () => {
    // The behavioural half of the structural case: a name in `result.deleted` proves a statement
    // ran, not that it emptied anything. This counts rows, per table, out of the catalog.
    const seeded = await seedFullAccount(db, "Swept");
    const scope = new Set(await erasureScopeTables(db));
    const scoped = (await accountScopedTables(db)).filter((t) => scope.has(t));

    // SEED COVERAGE FIRST: a zero after the delete is evidence only where the count was
    // non-zero before it. `screener_suggest_owed` sat in this very loop unseeded and was counted
    // 0 -> 0 with no deleter anywhere — green for a table nothing erased. An unseedable table is
    // a red, not a skip.
    expect(
      await unseededScopedTables(db, seeded.accountId, scoped),
      "an account-scoped table seedFullAccount leaves empty — the sweep below passes over it " +
        "vacuously; teach the fixture its row in helpers/erasure-fixture.ts",
    ).toEqual([]);

    await deleteAccount(ctxFor(seeded.accountId, seeded.userId));

    const survivors: string[] = [];
    for (const t of scoped) {
      if (RETAINED.has(t) || EXPIRED_NOT_DELETED.has(t)) continue;
      const c = await countFor(t, seeded.accountId);
      if (c > 0) survivors.push(`${t} (${c})`);
    }
    expect(survivors, "personal data survived erasure").toEqual([]);

    // The account survives, pseudonymously — the record whoever operates metering keeps points
    // at this id, and a uuid with a blank name is not personal data.
    const [acct] = await db.select().from(accounts).where(eq(accounts.id, seeded.accountId));
    expect(acct, "the pseudonymous subject must survive").toBeDefined();
    expect(acct!.name).toBe("");
    // …carrying the erasure fence's stamp (mail 0079): the zero counts above say the sweep ran,
    // the stamp is what stops a LATE settings write un-zeroing them a millisecond later —
    // every settings writer refuses on it (`erasure-fence.ts`; the race itself is driven in
    // `settings-reset-deadlock.pg.test.ts`).
    expect(acct!.erasedAt, "the erasure fence's stamp is missing").not.toBeNull();
  }, 60_000);

  /**
   * THE ONE ROW A RETENTION ERASURE KEEPS: the delivered erasure warning for the date it erases on,
   * so ohmail can still show the warning went out, until the worker's prune ten years after the
   * erasure. A self-serve erasure keeps none.
   */
  describe("the delivered erasure warning", () => {
    const A = new Date("2026-08-20T00:00:00.000Z");
    const B = new Date("2026-08-27T00:00:00.000Z");
    /** A full account with a delivered warning at A and a claim never delivered at B. */
    async function warnedAccount(name: string) {
      const seeded = await seedFullAccount(db, name);
      await db.insert(accountLifecycleNotices).values([
        { accountId: seeded.accountId, kind: "erasure_week", anchor: A, sentAt: A, deliveredAt: A },
        { accountId: seeded.accountId, kind: "erasure_week", anchor: B, sentAt: B },
      ]);
      return seeded;
    }

    it("a retention erasure keeps that warning and nothing else; a self-serve twin keeps nothing", async () => {
      const scope = new Set(await erasureScopeTables(db));
      const scoped = (await accountScopedTables(db)).filter((t) => scope.has(t));
      const survivors = async (accountId: string) => {
        const out: string[] = [];
        for (const t of scoped) {
          if (RETAINED.has(t) || EXPIRED_NOT_DELETED.has(t)) continue;
          const c = await countFor(t, accountId);
          if (c > 0) out.push(`${t} (${c})`);
        }
        return out;
      };
      const retention = await warnedAccount("Retention");
      await deleteAccount(ctxFor(retention.accountId, retention.userId), { warnedFor: A });
      expect(await survivors(retention.accountId)).toEqual(["account_lifecycle_notices (1)"]);
      expect((await db.select().from(accountLifecycleNotices)
        .where(eq(accountLifecycleNotices.accountId, retention.accountId)))
        .map((n) => [n.kind, n.anchor, n.deliveredAt])).toEqual([["erasure_week", A, A]]);

      const selfServe = await warnedAccount("Self Serve");
      await deleteAccount(ctxFor(selfServe.accountId, selfServe.userId));
      expect(await survivors(selfServe.accountId)).toEqual([]);
    }, 60_000);

    it("REFUSES a retention erasure whose date has no delivered warning, and erases nothing", async () => {
      const seeded = await warnedAccount("Unwarned");
      await expect(deleteAccount(ctxFor(seeded.accountId, seeded.userId), { warnedFor: B }))
        .rejects.toBeInstanceOf(ErasureUnwarnedError);
      const [acct] = await db.select().from(accounts).where(eq(accounts.id, seeded.accountId));
      expect(acct!.erasedAt, "the fence's stamp committed without the erasure").toBeNull();
      expect(await db.select().from(users).where(eq(users.accountId, seeded.accountId))).toHaveLength(1);
      expect(await countFor("account_lifecycle_notices", seeded.accountId)).toBe(3);
    }, 60_000);

    it("the hourly prune deletes it ten years after the erasure, and nothing of an account not erased", async () => {
      const erased = await warnedAccount("Pruned");
      await deleteAccount(ctxFor(erased.accountId, erased.userId), { warnedFor: A });
      const live = await warnedAccount("Not Erased");
      const tenYearsOn = new Date(NOW);
      tenYearsOn.setUTCFullYear(NOW.getUTCFullYear() + 10);
      await pruneErasedNotices(db as unknown as Tx, new Date(tenYearsOn.getTime() - 60_000));
      expect(await countFor("account_lifecycle_notices", erased.accountId)).toBe(1);
      await pruneErasedNotices(db as unknown as Tx, tenYearsOn);
      expect(await countFor("account_lifecycle_notices", erased.accountId)).toBe(0);
      await pruneErasedNotices(db as unknown as Tx, new Date("2040-01-01T00:00:00.000Z"));
      expect(await countFor("account_lifecycle_notices", live.accountId)).toBe(3);
    }, 60_000);

    it("CENSUS — the kept row's only free-text column is its kind, a closed set", async () => {
      expect(await freeTextColumns("account_lifecycle_notices")).toEqual(["kind"]);
      const checks = rowsOf<{ def: string }>(await db.execute(sql`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'account_lifecycle_notices_kind_closed'`));
      expect(checks[0]?.def ?? "", "`kind` is no longer a closed set").toMatch(/kind.*(IN|ANY)/i);
    });
  });

  it("REFUSES a table the fixture cannot seed — the census's positive control", async () => {
    // The admitting shape, planted: an account-scoped table with no seeder and no deleter. BOTH
    // census arms must name it — the structural arm as unruled, the seed-coverage arm as unseeded
    // — through the REAL walk, the REAL fixture and the REAL service, so this reddens if either
    // arm's deciding line stops asking. Synthetic because the real tables are all seeded and
    // ruled: a control is chosen from a subject that HAS the property under test.
    await db.execute(sql`drop table if exists zz_erasure_census_control`);
    await db.execute(sql`create table zz_erasure_census_control (account_id uuid not null)`);
    try {
      const scope = await erasureScopeTables(db);
      expect(scope, "the walk must see a planted account-scoped table").toContain("zz_erasure_census_control");

      const seeded = await seedFullAccount(db, "Census Control");
      const scoped = (await accountScopedTables(db)).filter((t) => scope.includes(t));
      expect(await unseededScopedTables(db, seeded.accountId, scoped))
        .toEqual(["zz_erasure_census_control"]);

      const result = await deleteAccount(ctxFor(seeded.accountId, seeded.userId));
      const covered = new Set([...Object.keys(result.deleted), ...EXPIRED_NOT_DELETED, ...RETAINED]);
      expect(covered.has("zz_erasure_census_control"), "nothing may rule on the planted table").toBe(false);
    } finally {
      await db.execute(sql`drop table zz_erasure_census_control`);
    }
  }, 60_000);

  it("expires the staged attachment ticket instead of orphaning its bytes in the bucket", async () => {
    // The one exemption, and the assertion that keeps it from being a hole. The row is the delete
    // key the worker's sweep removes the OBJECT by; deleting it here would leave the attachment
    // in storage for the life of the deployment with nothing left that knows its path.
    const seeded = await seedFullAccount(db, "Stager");

    const [before] = await db.select().from(attachmentStaging)
      .where(eq(attachmentStaging.id, seeded.stagingTicketId));
    expect(before!.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());

    const result = await deleteAccount(ctxFor(seeded.accountId, seeded.userId));
    expect(result.stagingTicketsExpired).toBe(1);

    const [after] = await db.select().from(attachmentStaging)
      .where(eq(attachmentStaging.id, seeded.stagingTicketId));
    expect(after, "the row must SURVIVE — it is the sweep's delete key").toBeDefined();
    expect(after!.expiresAt.getTime(), "due now, so the next sweep takes row and object")
      .toBe(NOW.getTime());
    expect(after!.objectPath).toBe(before!.objectPath);
  }, 60_000);

  /**
   * THE CASCADE, AGAINST A REAL DATABASE — because this is the one place it can be observed.
   *
   * `outbound_send_fingerprints.send_id` references `outbound_sends`, and erasure deletes
   * reservations directly. With a plain reference that raised SQLSTATE 23503 and the account could
   * not be erased. The reference cascades now.
   *
   * The non-pg twin of this case exists and passes, and it is NOT sufficient evidence: PGlite and
   * Postgres can differ on foreign-key enforcement, and this constraint is the sort of thing an
   * in-memory engine is happy about either way. The mutation that made this real was itself a
   * lesson — removing the cascade from the TypeScript schema left every test green, because the
   * database is built from the MIGRATIONS; only removing it from the migration SQL reddened
   * anything.
   */
  it("erases an account whose reservation carries a content claim — the cascade, on real Postgres", async () => {
    const seeded = await seedFullAccount(db, "Cascade");
    const [draft] = await db.insert(drafts).values({
      accountId: seeded.accountId, mailboxId: seeded.mailboxId,
      subject: "s", body: "b", to: [{ name: null, address: "you@example.com" }], status: "sent",
    }).returning();
    const [res] = await db.insert(outboundSends).values({
      accountId: seeded.accountId, idempotencyKey: `cascade-${seeded.accountId}`,
      draftId: draft!.id, mintedMessageId: "<cascade@example.com>", status: "sent",
    }).returning();
    await db.insert(outboundSendFingerprints).values({
      accountId: seeded.accountId, mailboxId: seeded.mailboxId,
      fingerprint: "b".repeat(64), sendId: res!.id,
    });

    // This is the whole assertion: it used to raise 23503 and now completes.
    await deleteAccount(ctxFor(seeded.accountId, seeded.userId));

    expect(await db.select().from(outboundSends)
      .where(eq(outboundSends.accountId, seeded.accountId))).toHaveLength(0);
    expect(await db.select().from(outboundSendFingerprints)
      .where(eq(outboundSendFingerprints.accountId, seeded.accountId)),
      "the claim goes with the reservation it pointed at").toHaveLength(0);
  });

  it("is idempotent — a retried erasure is a no-op, not a second 23503", async () => {
    // The caller retries after a network failure, and the second call must not raise. It is also
    // the case the `expires_at > now` predicate on the staging update exists for: without it the
    // ticket would be re-expired, and reported, for ever.
    const seeded = await seedFullAccount(db, "Retried");

    const first = await deleteAccount(ctxFor(seeded.accountId, seeded.userId));
    expect(first.usersErased).toBe(1);
    expect(first.stagingTicketsExpired).toBe(1);

    const second = await deleteAccount(ctxFor(seeded.accountId, seeded.userId));
    expect(second.usersErased).toBe(0);
    expect(Object.values(second.deleted).reduce((a, b) => a + b, 0)).toBe(0);
    expect(second.stagingTicketsExpired).toBe(0);
  }, 60_000);

  it("touches nothing belonging to another account", async () => {
    const mine = await seedFullAccount(db, "Erased");
    const theirs = await seedFullAccount(db, "Untouched");

    await deleteAccount(ctxFor(mine.accountId, mine.userId));

    expect(await db.select().from(users).where(eq(users.accountId, theirs.accountId)))
      .toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.accountId, theirs.accountId)))
      .toHaveLength(1);
    expect(await countFor("message_instances", theirs.accountId)).toBe(2);
    expect(await countFor("message_failures", theirs.accountId)).toBe(1);
    expect(await db.select().from(flagState).where(eq(flagState.messageId, theirs.messageId)))
      .toHaveLength(1);
    const [other] = await db.select().from(accounts).where(eq(accounts.id, theirs.accountId));
    expect(other!.name).toBe("Untouched");
  }, 60_000);

  /**
   * ── THE COST OF ERASURE DOES NOT GROW WITH THE MAILBOX ──
   *
   * `message_bodies`, `folder_state` and `flag_state` key off the MESSAGE, not the account, so
   * erasure needs to name the account's messages. It used to name them by selecting every message
   * uuid into a JS array and binding that array into three `IN` predicates — **one bind parameter
   * per message, three times over.** PostgreSQL refuses a statement past its bind-parameter
   * ceiling, so past a certain account size the statement is rejected and the whole
   * transaction aborts: self-serve erasure stopped working exactly for the largest real accounts,
   * which is an Art. 17 obligation that broke as the account grew.
   *
   * **Seeding enough messages to watch it fail is not the test**, and a test that took that long
   * would not be run. The property that matters is one level up and is exact: the number of bind
   * parameters must not be a function of the row count. So this counts the parameters PostgreSQL
   * is actually sent, by tapping the driver, and compares two accounts of different sizes.
   *
   * THE MUTATION-WATCH. In `account-deletion-service.ts`, restore the materialized list —
   * `const messageIds = (await tx.select({ id: messages.id })…).map((m) => m.id)` and
   * `inArray(messageBodies.messageId, messageIds)` — and this goes red on the equality: the wide
   * account issues a statement carrying one parameter per message while the narrow one does not.
   * Watched fail and restored. The behavioural cases above stay green through the mutation, which
   * is why this assertion has to exist separately.
   */
  it("binds a CONSTANT number of parameters however many messages the account holds", async () => {
    /** The widest parameter array any single statement carried, while the tap is armed. */
    let widest = 0;

    /**
     * Arm one postgres.js handle so every statement it issues is measured.
     *
     * drizzle-orm/postgres-js issues every statement as `client.unsafe(sql, params)`
     * (`postgres-js/session.cjs:84`), so wrapping that one method sees the parameter array.
     */
    const arm = (handle: unknown): void => {
      const h = handle as { unsafe?: unknown };
      if (typeof h.unsafe !== "function") {
        throw new Error("cannot reach the driver to count bind parameters");
      }
      const inner = (h.unsafe as (...a: unknown[]) => unknown).bind(h);
      h.unsafe = (...args: unknown[]) => {
        const params = args[1];
        if (Array.isArray(params)) widest = Math.max(widest, params.length);
        return inner(...args);
      };
    };

    /**
     * AND THE TRANSACTION'S OWN HANDLE, which is the half that made the first version of this
     * measure NOTHING.
     *
     * `deleteAccount` runs entirely inside one `db.transaction(...)`, and drizzle enters it
     * through `client.begin(fn)` (`postgres-js/session.cjs:122`). postgres.js hands `fn` a
     * DIFFERENT `sql` handle bound to the reserved connection, and every statement in the
     * transaction goes through THAT one — so a tap on the outer handle alone saw zero statements
     * and the self-check below fired, which is what it is for. Arming the inner handle as it is
     * created is the fix; without it this whole case would have been a tautology.
     */
    const origUnsafe = (client as unknown as { unsafe: unknown }).unsafe;
    const origBegin = (client as unknown as { begin: (...a: unknown[]) => unknown }).begin.bind(client);
    (client as unknown as { begin: unknown }).begin = (...args: unknown[]) => {
      const i = args.findIndex((a) => typeof a === "function");
      if (i < 0) return origBegin(...args);
      const fn = args[i] as (h: unknown) => unknown;
      const next = [...args];
      next[i] = (handle: unknown) => { arm(handle); return fn(handle); };
      return origBegin(...next);
    };
    arm(client);

    try {
      const narrow = await seedFullAccount(db, "Narrow");
      widest = 0;
      await deleteAccount(ctxFor(narrow.accountId, narrow.userId));
      const narrowWidest = widest;

      // The same shape with EXTRA MAIL — and every one of these rows carries a `message_bodies`,
      // `folder_state` and `flag_state` child, which are precisely the three deletes that used to
      // bind per message.
      const wide = await seedFullAccount(db, "Wide");
      const extra = 120;
      for (let i = 0; i < extra; i++) {
        const [m] = await db.insert(messages).values({
          accountId: wide.accountId, mailboxId: wide.mailboxId,
          bodyHash: `bulk-${i}`, dedupKey: `bulk:${wide.accountId}:${i}`,
          subject: `bulk ${i}`, fromAddress: "bulk@sender.example",
        }).returning({ id: messages.id });
        await db.insert(flagState).values({
          messageId: m!.id, desiredSeen: false, observedSeen: false, lastSetBy: "us",
        });
      }
      expect(await db.select().from(messages).where(eq(messages.accountId, wide.accountId)))
        .toHaveLength(extra + 1);

      widest = 0;
      await deleteAccount(ctxFor(wide.accountId, wide.userId));
      const wideWidest = widest;

      // The tap fired at all — otherwise both numbers would be 0 and the equality below would be
      // a tautology.
      expect(narrowWidest, "the bind-parameter measurement must not be zero").toBeGreaterThan(0);

      // THE PROPERTY. Extra messages must buy zero extra bind parameters.
      expect(wideWidest, `widest statement: narrow ${narrowWidest} params, wide ${wideWidest}`)
        .toBe(narrowWidest);
      // …and it is genuinely small, not merely equal — a shape that bound the whole account twice
      // over could still be equal if both sides were wide.
      expect(wideWidest).toBeLessThan(20);
    } finally {
      (client as unknown as { begin: unknown }).begin = origBegin;
      (client as unknown as { unsafe: unknown }).unsafe = origUnsafe;
    }
  }, 120_000);

  it("keeps the refresh token's hash past the token's own window, on real Postgres", async () => {
    // ERASED-ACCOUNT-DEVICE-PAST-REFRESH-WINDOW-KEEPS-COPY: the interval arithmetic and its bind
    // parameter are the driver split PGlite cannot read.
    const seeded = await seedFullAccount(db, "Kept Bearer");
    await deleteAccount(ctxFor(seeded.accountId, seeded.userId));
    const rows = rowsOf<{ token_hash: string; expires_at: Date }>(await db.execute(sql`
      select token_hash, expires_at from erased_bearers
      where account_id = ${seeded.accountId} and token_hash like 'hash-%'`));
    expect(rows.map((r) => new Date(r.expires_at).toISOString()))
      .toEqual([new Date(LATER.getTime() + ERASED_REFRESH_KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString()]);
  }, 60_000);

  /**
   * A REFUND STILL OWED OUTLIVES THE ERASURE (PENDING-REFUND-IS-DROPPED-AT-ERASURE). Money owed to
   * the person is a financial record: the pending row is kept, pseudonymised, and the drain can
   * still claim it; a settled one is only a reminder and goes. Real Postgres, because the keep and
   * the deletes are one transaction with the `accounts` stamp.
   */
  describe("refund obligations at erasure", () => {
    const OLD = new Date("1970-01-02T00:00:00.000Z");
    const planted: string[] = [];
    afterEach(async () => {
      if (planted.length > 0) {
        await db.delete(creditRefundObligations).where(inArray(creditRefundObligations.id, planted.splice(0)));
      }
    });

    /** One pending and one settled debt; the pending one leased, faulted and carrying meta. */
    async function owe(accountId: string, tag: string) {
      const [pending] = await db.insert(creditRefundObligations).values({
        accountId, action: "screener_suggest", attemptKey: `ak-p-${tag}`, attempt: `at-p-${tag}`,
        reason: "drafter_failed", meta: { draftId: `d-${tag}` }, owedAt: OLD, tries: 3,
        lastFault: "release_unreachable", claimedUntil: new Date(NOW.getTime() + 3_600_000),
      }).returning();
      const [settled] = await db.insert(creditRefundObligations).values({
        accountId, action: "screener_suggest", attemptKey: `ak-s-${tag}`, attempt: `at-s-${tag}`,
        reason: "drafter_failed", settledAt: NOW,
      }).returning();
      planted.push(pending!.id, settled!.id);
      return { pending: pending!, settled: settled! };
    }
    const rowById = async (id: string) =>
      (await db.select().from(creditRefundObligations).where(eq(creditRefundObligations.id, id)))[0];

    it("keeps the PENDING debt pseudonymised, drops the SETTLED one, and the drain can claim it", async () => {
      const seeded = await seedFullAccount(db, "Owed");
      const { pending, settled } = await owe(seeded.accountId, seeded.accountId);

      const result = await deleteAccount(ctxFor(seeded.accountId, seeded.userId), { drainsRefunds: true });

      expect(await rowById(settled.id), "a settled debt outlived the erasure").toBeUndefined();
      const kept = await rowById(pending.id);
      expect(kept, "the debt still owed was dropped by the erasure").toBeDefined();
      expect({ meta: kept!.meta, lastFault: kept!.lastFault, claimedUntil: kept!.claimedUntil })
        .toEqual({ meta: null, lastFault: null, claimedUntil: null });
      expect({
        accountId: kept!.accountId, action: kept!.action, attemptKey: kept!.attemptKey,
        attempt: kept!.attempt, reason: kept!.reason, tries: kept!.tries, owedAt: kept!.owedAt,
      }).toEqual({
        accountId: pending.accountId, action: pending.action, attemptKey: pending.attemptKey,
        attempt: pending.attempt, reason: pending.reason, tries: pending.tries, owedAt: pending.owedAt,
      });

      // The drain's own claim reads it back for the erased account (oldest first, so it is first).
      const claimed = await claimRefundObligations(db as unknown as Tx, NOW, { limit: 1 });
      expect(claimed.map((c) => [c.id, c.accountId, c.meta])).toEqual([[pending.id, seeded.accountId, null]]);
      // The report: the kept debt apart, and the deletes count the fixture's settled row and this one.
      expect(result.retainedPending).toBe(1);
      expect(result.deleted.credit_refund_obligations).toBe(2);
    }, 60_000);

    it("a host that drains nothing keeps nothing — every obligation goes", async () => {
      const seeded = await seedFullAccount(db, "Unmetered");
      const { pending, settled } = await owe(seeded.accountId, seeded.accountId);

      const result = await deleteAccount(ctxFor(seeded.accountId, seeded.userId));

      expect(await rowById(pending.id), "an undrained host kept a debt nothing will pay").toBeUndefined();
      expect(await rowById(settled.id)).toBeUndefined();
      expect(result.deleted.credit_refund_obligations).toBe(3);
      expect(result.retainedPending).toBe(0);
    }, 60_000);

    it("the keep is ONE transaction with the erasure — a later fault leaves the debt as it was", async () => {
      const seeded = await seedFullAccount(db, "Rolled Back");
      const { pending, settled } = await owe(seeded.accountId, seeded.accountId);
      // A statement AFTER the refund arm fails, for this account only.
      await db.execute(sql.raw(`
        create or replace function zz_erasure_refund_fault() returns trigger language plpgsql as $$
        begin
          if old.account_id = '${seeded.accountId}' then raise exception 'zz planted fault'; end if;
          return old;
        end $$`));
      await db.execute(sql`create trigger zz_erasure_refund_fault before delete on account_lifecycle_notices
        for each row execute function zz_erasure_refund_fault()`);
      try {
        await expect(deleteAccount(ctxFor(seeded.accountId, seeded.userId), { drainsRefunds: true }))
          .rejects.toThrow();
      } finally {
        await db.execute(sql`drop trigger if exists zz_erasure_refund_fault on account_lifecycle_notices`);
        await db.execute(sql`drop function if exists zz_erasure_refund_fault()`);
      }
      const kept = await rowById(pending.id);
      expect(kept!.meta, "the pseudonymise committed without the erasure").toEqual({ draftId: `d-${seeded.accountId}` });
      expect(kept!.lastFault).toBe("release_unreachable");
      expect(await rowById(settled.id), "the settled delete committed without the erasure").toBeDefined();
      const [acct] = await db.select().from(accounts).where(eq(accounts.id, seeded.accountId));
      expect(acct!.erasedAt).toBeNull();
    }, 60_000);

    /**
     * THE CENSUS: the kept row must name nobody, so every column that can hold free text is ruled
     * here. `meta` and `last_fault` are cleared at erasure; the rest are identifiers we minted or
     * a CHECK-closed word. A new text or json column fails until it is ruled.
     */
    const RULED: Record<string, string> = {
      meta: "cleared at erasure",
      last_fault: "cleared at erasure",
      reason: "a closed set, CHECK-constrained",
      action: "a SpendAction word, 40 characters at most",
      attempt_key: "an id this server minted",
      attempt: "the attempt id the program returned",
    };

    it("CENSUS — no column of a kept debt but meta and last_fault can carry free text", async () => {
      const cols = await freeTextColumns("credit_refund_obligations");
      expect(cols.length, "the census read no column").toBeGreaterThan(0);
      expect(cols.filter((c) => !(c in RULED)), "an unruled free-text column on credit_refund_obligations").toEqual([]);
      const checks = rowsOf<{ def: string }>(await db.execute(sql`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'credit_refund_obligations_reason_check'`));
      expect(checks[0]?.def ?? "", "`reason` is no longer a closed set").toMatch(/reason.*IN|ANY/i);
    });

    it("CENSUS CONTROL — a planted free-text column is named", async () => {
      await db.execute(sql`drop table if exists zz_refund_census_control`);
      // No `account_id`, so no erasure census elsewhere reads it as an account table.
      await db.execute(sql`create table zz_refund_census_control (meta jsonb, last_fault text, reason text, note text)`);
      try {
        const cols = await freeTextColumns("zz_refund_census_control");
        expect(cols.filter((c) => !(c in RULED))).toEqual(["note"]);
      } finally {
        await db.execute(sql`drop table zz_refund_census_control`);
      }
    });
  });
});
