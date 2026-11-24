import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { sql } from "drizzle-orm";
import {
  runMigrations, migrateToOldHeads, readJournalOf, MAIL_JOURNAL, MAIL_MIGRATIONS_DIR,
} from "../src/admin.js";
import {
  findActiveAddressDuplicates, assertNoActiveAddressDuplicates,
  resolveActiveAddressDuplicates, activeAddressIndexExists, ACTIVE_ADDRESS_UQ,
} from "../src/mailbox-dedup.js";
import { parseDedupArgs } from "../src/mailbox-dedup-cli.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * THE DEDUP PRELUDE'S RULE, AND THE GUARD THAT NOW STANDS IN FRONT OF IT (0021 review #6).
 *
 * Mail `0021_mailbox_address_unique` resolves pre-existing duplicates by keeping the OLDEST row
 * and deleting the others' credentials. Production held zero duplicates when it shipped, so
 * nothing was harmed there — and no test in this repository had ever put a duplicate in front of
 * it, so nobody had watched what it does. This file does both: it reproduces the destruction
 * against the SHIPPED statement, and it proves the guard refuses the migration instead.
 *
 * ── WHY IT BUILDS A "0021 PENDING" DATABASE BY HAND ─────────────────────────────────────
 *
 * The state that matters — a POPULATED database that has not applied 0021 — cannot be reached
 * forwards: the migrator applies the whole journal in one pass, so there is no moment at which
 * you can seed rows in between. So each case migrates fully, then drops the index and deletes
 * 0021's bookkeeping row, which puts the database in exactly the state a developer's or a
 * self-hoster's would have been in the day before 0021 shipped. `runMigrations` genuinely has
 * 0021 pending after that; nothing here is simulated.
 *
 * Real Postgres, in throwaway databases with random names: PGlite cannot host the concurrent
 * transactions and the migrator behaviour this is about, and a fixed database name would let two
 * runs drop each other's mid-migration (the `journal-split.pg.test.ts` note).
 */

const ADMIN_URL = PG_TEST_URL;

const SUFFIX = randomUUID().replace(/-/g, "").slice(0, 12);
const PG_UP = await realPgAvailable(ADMIN_URL);

const urlFor = (name: string): string => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
};

/** 0021's own journal entry — the `when` whose bookkeeping row has to go for it to be pending. */
const ENTRY_0021 = readJournalOf(MAIL_JOURNAL).find((e) => e.tag === "0021_mailbox_address_unique");

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = new Date("2026-08-01T12:00:00.000Z");

/**
 * THE ASYMMETRIC PAIR, and it is the review's scenario verbatim.
 *
 *   A — created 60 days ago, `status='error'`, last synced 45 days ago. It HAS an imap
 *       credential row, and that credential is expired at the provider. The database cannot see
 *       that, which is the entire reason a SQL rule must not pick a winner.
 *   B — the user's working replacement: two days old, `status='connected'`, synced a minute ago,
 *       imap + smtp credentials, and all of the message history that is actually arriving.
 *
 * 0021 ranks by `(created_at, id)` and keeps A.
 */
interface Pair { accountId: string; address: string; a: string; b: string }

async function seedPair(db: ReturnType<typeof drizzle>): Promise<Pair> {
  const accountId = randomUUID();
  const address = `dup-${accountId.slice(0, 8)}@example.test`;
  await db.execute(sql`insert into accounts (id, name) values (${accountId}, ${`dedup-${accountId.slice(0, 8)}`})`);

  const mk = async (status: string, createdAt: Date, lastSyncAt: Date | null): Promise<string> => {
    const r = await db.execute(sql`
      insert into mailboxes (account_id, provider, address, status, created_at, last_sync_at)
      values (${accountId}, 'imap', ${address}, ${status}, ${createdAt.toISOString()}::timestamptz,
              ${lastSyncAt === null ? null : lastSyncAt.toISOString()}::timestamptz)
      returning id`);
    return (r as unknown as Array<{ id: string }>)[0]!.id;
  };
  const cred = async (mailboxId: string, transport: string): Promise<void> => {
    await db.execute(sql`
      insert into mailbox_credentials (mailbox_id, transport, secret_enc, key_version)
      values (${mailboxId}, ${transport}, ${`enc-${transport}-${mailboxId.slice(0, 8)}`}, 1)`);
  };

  const a = await mk("error", new Date(NOW.getTime() - 60 * DAY), new Date(NOW.getTime() - 45 * DAY));
  const b = await mk("connected", new Date(NOW.getTime() - 2 * DAY), new Date(NOW.getTime() - MINUTE));
  await cred(a, "imap");
  await cred(b, "imap");
  await cred(b, "smtp");
  return { accountId, address, a, b };
}

const statusOf = async (db: ReturnType<typeof drizzle>, id: string): Promise<string | null> => {
  const r = await db.execute(sql`select status from mailboxes where id = ${id}::uuid`);
  return (r as unknown as Array<{ status: string }>)[0]?.status ?? null;
};

const credCount = async (db: ReturnType<typeof drizzle>, id: string): Promise<number> => {
  const r = await db.execute(sql`select count(*)::int as n from mailbox_credentials where mailbox_id = ${id}::uuid`);
  return Number((r as unknown as Array<{ n: number }>)[0]!.n);
};

/**
 * Put a fully-migrated database back into the state it was in the day before 0021 shipped.
 *
 * ── WHY THIS DELETES `>=` AND NOT `=`, WHICH IS THE WHOLE DRIZZLE DEFECT AGAIN ──
 *
 * Deleting only 0021's own bookkeeping row was correct while 0021 was the NEWEST mail entry,
 * and it silently stopped being correct the moment `0022_message_body_html_cap` landed above
 * it. drizzle's migrator reads `order by created_at desc limit 1` and applies an entry iff
 * `max(created_at) < entry.when` — so with 0022's row still present, `max` is 0022's `when`,
 * which is GREATER than 0021's, and `runMigrations` skips 0021 **forever**. The test caught it
 * exactly where it should: `activeAddressIndexExists` came back false after a migration that
 * reported success.
 *
 * So "the day before 0021" has to mean every entry at or above it, and every object those
 * entries build — otherwise this helper simulates a state no real database was ever in, and
 * the migration under test never runs.
 */
async function unapply0021(db: ReturnType<typeof drizzle>): Promise<void> {
  await db.execute(sql.raw(`drop index if exists "${ACTIVE_ADDRESS_UQ}"`));
  // 0022's object, dropped for the same reason its journal row goes: this rolls the database
  // back PAST it, so the migrator must rebuild both.
  await db.execute(sql.raw(
    `alter table "message_bodies" drop constraint if exists "message_bodies_html_cap"`,
  ));
  // 0027's object, for the same reason. The rule this helper's header states — "every entry at or
  // above 0021, and every object those entries build" — is a maintenance obligation on every
  // future migration that creates a named object, and mail 0027's CHECK is the first one to
  // exercise it: without this line the re-migration raises 42710 (`already exists`) and the pass
  // this file is testing never completes. That is also why 0027 wraps its ADD in a
  // `duplicate_object` catch; both halves are needed, because the DROP is what makes the rewind
  // truthful and the catch is what makes the journal replayable.
  await db.execute(sql.raw(
    `alter table "mailboxes" drop constraint if exists "mailboxes_disabled_reason_closed"`,
  ));
  // 0037's object, on the same rule, and it is the second time the obligation was missed: the
  // migration shipped its `ADD CONSTRAINT` bare, so the rewind below re-ran it and the pass died
  // with 42710 (`constraint "drafts_html_cap" for relation "drafts" already exists`). Both halves
  // landed together — the catch in `0037_draft_html.sql`, and this DROP. Every future migration
  // that creates a NAMED object above 0021 owes this file a line; a constraint additionally owes
  // its own file a `duplicate_object` catch, because a DROP here cannot make production replayable.
  await db.execute(sql.raw(
    `alter table "drafts" drop constraint if exists "drafts_html_cap"`,
  ));
  await db.execute(
    sql`delete from drizzle_mail.__drizzle_migrations where created_at >= ${ENTRY_0021!.when}`,
  );
}

describe.skipIf(!PG_UP)("duplicate active mailbox addresses, and 0021's rule for them", () => {
  let admin: ReturnType<typeof postgres>;
  const created: string[] = [];

  /** A throwaway database with the full schema, then rolled back to "0021 pending". */
  async function pendingDb(tag: string): Promise<{ url: string; db: ReturnType<typeof drizzle>; client: ReturnType<typeof postgres> }> {
    const name = `ohmail_dedup_${tag}_${SUFFIX}`;
    await admin.unsafe(`create database "${name}"`);
    created.push(name);
    const url = urlFor(name);
    // The 1.0 road: 0021 is that road's, and the replay over it stops at its head.
    await migrateToOldHeads(url);
    const client = postgres(url, { max: 2, onnotice: () => {} });
    const db = brandDialect(drizzle(client), "pg");
    await unapply0021(db);
    return { url, db, client };
  }

  beforeAll(async () => {
    expect(ENTRY_0021, "0021 must still be in the mail journal").toBeDefined();
    admin = postgres(ADMIN_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
  }, 60_000);

  /* The drops in parallel and the hook under its own bound: four sequential `drop database` calls
     plus the admin end have no trouble exceeding vitest's 10 s default, and a teardown that runs
     out of time reports as a failed file with every test green. */
  afterAll(async () => {
    await Promise.all(created.map((name) =>
      admin?.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {})));
    await admin?.end({ timeout: 5 }).catch(() => {});
  }, 60_000);

  /**
   * THE DEFECT, REPRODUCED AGAINST THE SHIPPED SQL.
   *
   * This executes statement 1 of `0021_mailbox_address_unique.sql` verbatim — read from the file,
   * split on `--> statement-breakpoint`, exactly as drizzle's `readMigrationFiles` does — so it is
   * the production rule and not a paraphrase of it.
   *
   * It is a CHARACTERIZATION test of behaviour that is already applied in production and must
   * never be edited (the statement is sha256-pinned in `journal-split.test.ts`). It is not a
   * specification: if it ever fails, 0021 was changed, and that is the thing to investigate.
   */
  it("0021's prelude keeps the BROKEN row and deletes the working one's credentials", async () => {
    const { db, client } = await pendingDb("prelude");
    try {
      const p = await seedPair(db);

      const chunks = readFileSync(join(MAIL_MIGRATIONS_DIR, "0021_mailbox_address_unique.sql"), "utf8")
        .split("--> statement-breakpoint");
      const prelude = chunks[0]!;
      expect(prelude, "statement 1 must still be the dedup prelude").toMatch(/row_number\(\) OVER/i);
      await db.execute(sql.raw(prelude));

      // A is old, quarantined, 45 days stale and holds a dead credential. It wins.
      expect(await statusOf(db, p.a)).toBe("error");
      expect(await credCount(db, p.a)).toBe(1);
      // B — connected, syncing, the one the user is actually using — is disabled, and its
      // credentials are gone. They were envelope-encrypted and exist nowhere else.
      expect(await statusOf(db, p.b)).toBe("disabled");
      expect(await credCount(db, p.b)).toBe(0);

      // …and the index the prelude cleared the way for now REFUSES to let B come back until
      // somebody disables A. That is the second half of the harm.
      await db.execute(sql.raw(
        `create unique index "${ACTIVE_ADDRESS_UQ}" on "mailboxes" ("account_id", lower("address")) ` +
        `where "status" <> 'disabled'`,
      ));
      await expect(
        db.execute(sql`update mailboxes set status = 'connected' where id = ${p.b}::uuid`),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 180_000);

  it("runMigrations REFUSES a pending database that holds duplicates, and changes nothing", async () => {
    const { url, db, client } = await pendingDb("guard");
    try {
      const p = await seedPair(db);

      const err = await runMigrations(url).catch((e: unknown) => e);
      expect(err, "the migration must not proceed").toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/refusing to migrate/);
      expect((err as Error).message).toContain(p.a);
      expect((err as Error).message).toContain(p.b);
      // The refusal lands in a deploy log, so it names ids and never the customer's address.
      expect((err as Error).message).not.toContain(p.address);

      // NOTHING was touched — not the rows, not the credentials, not the schema.
      expect(await statusOf(db, p.a)).toBe("error");
      expect(await statusOf(db, p.b)).toBe("connected");
      expect(await credCount(db, p.b)).toBe(2);
      expect(await activeAddressIndexExists(db)).toBe(false);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 180_000);

  it("the operator resolves it, keeping the WORKING row, and the migration then completes", async () => {
    const { url, db, client } = await pendingDb("resolve");
    try {
      const p = await seedPair(db);

      // The evidence the operator reads. Ordered as 0021 would rank it, so the row the
      // migration WOULD have kept is the one shown first — and it is visibly the dead one.
      const groups = await findActiveAddressDuplicates(db);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.rows.map((r) => r.id)).toEqual([p.a, p.b]);
      expect(groups[0]!.key).toBe(p.address.toLowerCase());
      const [rowA, rowB] = groups[0]!.rows;
      expect(rowA!.status).toBe("error");
      expect(rowA!.transports).toEqual(["imap"]);
      expect(rowB!.status).toBe("connected");
      expect(rowB!.transports).toEqual(["imap", "smtp"]);
      expect(rowB!.lastSyncAt!.getTime()).toBeGreaterThan(rowA!.lastSyncAt!.getTime());

      // Naming B — the choice 0021 could not have made.
      const outcomes = await resolveActiveAddressDuplicates(db as never, [p.b], NOW);
      expect(outcomes).toEqual([{
        accountId: p.accountId, key: p.address.toLowerCase(),
        kept: p.b, disabled: [p.a], credentialsDeleted: 1,
      }]);
      expect(await statusOf(db, p.a)).toBe("disabled");
      expect(await credCount(db, p.a)).toBe(0);
      expect(await statusOf(db, p.b)).toBe("connected");
      expect(await credCount(db, p.b)).toBe(2);

      // …and now the migration runs, builds the index, and the working mailbox is the one left.
      await migrateToOldHeads(url);
      expect(await activeAddressIndexExists(db)).toBe(true);
      expect(await statusOf(db, p.b)).toBe("connected");

      // Re-running applies nothing and the guard is a no-op once the index exists.
      await migrateToOldHeads(url);
      expect(await findActiveAddressDuplicates(db)).toEqual([]);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 180_000);

  it("the resolver refuses every ambiguous instruction, and writes nothing when it does", async () => {
    const { db, client } = await pendingDb("refuse");
    try {
      const p = await seedPair(db);
      const intact = async (): Promise<void> => {
        expect(await statusOf(db, p.a)).toBe("error");
        expect(await statusOf(db, p.b)).toBe("connected");
        expect(await credCount(db, p.a)).toBe(1);
        expect(await credCount(db, p.b)).toBe(2);
      };

      // No keeper at all — the default posture. It does not fall back to "oldest".
      await expect(resolveActiveAddressDuplicates(db as never, [], NOW))
        .rejects.toThrow(/no --keep names any of its 2 active rows/);
      await intact();

      // Both — "keep them all" is not a resolution, it is the state being resolved.
      await expect(resolveActiveAddressDuplicates(db as never, [p.a, p.b], NOW))
        .rejects.toThrow(/exactly one row per group may survive/);
      await intact();

      // An id that is not in any group: a typo must not silently resolve nothing.
      await expect(resolveActiveAddressDuplicates(db as never, [randomUUID()], NOW))
        .rejects.toThrow(/does not name an active row in any duplicate group/);
      await intact();
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 180_000);

  it("the guard is silent on a database that is already indexed, or has no mailboxes yet", async () => {
    // The two skip paths, asserted so the guard cannot become a per-migration cost nobody
    // measured. A fully-migrated database: index present ⇒ duplicates unrepresentable.
    const name = `ohmail_dedup_skip_${SUFFIX}`;
    await admin.unsafe(`create database "${name}"`);
    created.push(name);
    const url = urlFor(name);
    const client = postgres(url, { max: 1, onnotice: () => {} });
    const db = brandDialect(drizzle(client), "pg");
    try {
      // A VIRGIN database: no `mailboxes` table at all, and the guard must not throw on it —
      // this is the path every fresh provision and every CI container takes.
      await expect(assertNoActiveAddressDuplicates(db)).resolves.toBeUndefined();
      expect(await findActiveAddressDuplicates(db)).toEqual([]);

      await runMigrations(url);
      expect(await activeAddressIndexExists(db)).toBe(true);
      await expect(assertNoActiveAddressDuplicates(db)).resolves.toBeUndefined();
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 180_000);
});

/** The CLI's argument grammar — no database needed, and it is where a typo becomes destructive. */
describe("db:mailboxes:dedup argument parsing", () => {
  it("accepts --keep <id> and --keep=<id>, repeatably", () => {
    expect(parseDedupArgs(["--keep", "a", "--keep=b"]).keeps).toEqual(["a", "b"]);
    expect(parseDedupArgs([]).keeps).toEqual([]);
  });

  it("refuses an unknown argument rather than ignoring it", () => {
    // A silently-ignored `--yes` or `--force` is how a report-only run turns into a write.
    expect(() => parseDedupArgs(["--force"])).toThrow(/unknown argument/);
    expect(() => parseDedupArgs(["--keep"])).toThrow(/--keep needs a mailbox id/);
    expect(() => parseDedupArgs(["--keep="])).toThrow(/--keep needs a mailbox id/);
  });

  it("refuses the same id twice — it would read as covering two groups", () => {
    expect(() => parseDedupArgs(["--keep", "a", "--keep", "a"])).toThrow(/was given twice/);
  });
});
