import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * `message_instances` AGAINST REAL POSTGRES — mail 0028.
 *
 * ── WHY THIS FILE CANNOT BE A PGlite TEST ────────────────────────────────────────────────────
 *
 * The table's identity is `UNIQUE (message_id) WHERE is_primary` — a PARTIAL unique index, which is
 * exactly the class of object PGlite has misled this repository about before (AGENTS.md: three
 * production bugs were invisible to it and only appeared against real Postgres). The whole model
 * rests on that predicate: without it a non-partial unique on `message_id` refuses the SECOND
 * instance the table exists to hold, and without the index at all two rows can both claim to be one
 * message's primary — so `messages.native_locator` and the instance table can disagree about where a
 * message physically is, and the adapter is then told to move a UID that belongs to something else.
 *
 * The locator unique is the other half, and its `uidvalidity` column is the part worth proving: a
 * UID number is meaningless outside the server epoch that issued it, and a folder that resets
 * commonly re-allocates from low numbers. Drop the epoch from the key and the same physical slot
 * under two epochs collides, so the new message cannot be recorded, its body is never fetched, and
 * the cursor advances past it. Permanently.
 *
 * ── AND WHY THE BACKFILL IS EXECUTED FROM THE MIGRATION FILE ITSELF ──────────────────────────
 *
 * 0028 carries the only DATA statement in the whole post-split journal history. Re-typing it here
 * would test a copy; reading it out of the shipped `.sql` and running it tests the statement that
 * production runs — including its `ON CONFLICT DO NOTHING`, which is what makes `openLocalDb`'s
 * re-run-on-every-launch survivable.
 */

const DB_URL = PG_TEST_URL;
const HAVE_PG = await realPgAvailable(DB_URL);

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MIGRATION = join(HERE, "..", "..", "db-mail", "drizzle", "0028_message_instances.sql");

/** The migration's `INSERT … SELECT` backfill, read out of the file production applies. */
function backfillStatement(): string {
  const chunks = readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint");
  const hit = chunks.find((c) => /INSERT INTO "message_instances"/i.test(c));
  if (!hit) throw new Error("0028 no longer contains an INSERT INTO message_instances — re-review it");
  return hit.trim();
}

const code = (err: unknown): string => String((err as { code?: unknown }).code ?? "unknown");

describe.skipIf(!HAVE_PG)("message_instances constraints (real Postgres)", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let accountId: string;
  let mailboxA: string;
  let mailboxB: string;
  let messageOne: string;
  let messageTwo: string;

  beforeAll(async () => {
    client = postgres(DB_URL, { max: 1, onnotice: () => {} });
    db = brandDialect(drizzle(client), "pg");
    accountId = randomUUID();
    mailboxA = randomUUID();
    mailboxB = randomUUID();
    messageOne = randomUUID();
    messageTwo = randomUUID();
    await db.execute(sql`insert into accounts (id, name) values (${accountId}, 'mi-check')`);
    for (const [id, addr] of [[mailboxA, "a"], [mailboxB, "b"]] as const) {
      await db.execute(sql`
        insert into mailboxes (id, account_id, provider, address)
        values (${id}, ${accountId}, 'imap', ${`${addr}-${id}@mi.test`})`);
    }
    for (const [id, key] of [[messageOne, "one"], [messageTwo, "two"]] as const) {
      await db.execute(sql`
        insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address)
        values (${id}, ${accountId}, ${mailboxA}, 'h', ${`fp1:${key}-${id}`}, 's', 'a@b.test')`);
    }
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await db.execute(sql`delete from message_instances where account_id = ${accountId}`).catch(() => undefined);
    await db.execute(sql`delete from messages where account_id = ${accountId}`).catch(() => undefined);
    await db.execute(sql`delete from mailboxes where account_id = ${accountId}`).catch(() => undefined);
    await db.execute(sql`delete from accounts where id = ${accountId}`).catch(() => undefined);
    await client.end({ timeout: 5 });
  });

  /** Insert one instance. Resolves to the driver's SQLSTATE, or null on success. */
  async function insert(o: {
    mailboxId: string; messageId: string; folder: string; uidvalidity: number; uid: number;
    isPrimary: boolean;
  }): Promise<string | null> {
    try {
      await db.execute(sql`
        insert into message_instances
          (account_id, mailbox_id, message_id, folder, uidvalidity, uid, is_primary)
        values (${accountId}, ${o.mailboxId}, ${o.messageId}, ${o.folder},
                ${o.uidvalidity}, ${o.uid}, ${o.isPrimary})`);
      return null;
    } catch (err) {
      return code(err);
    }
  }

  it("accepts a primary instance, then a SECOND non-primary instance of the same message", async () => {
    // The whole reason the primary unique is PARTIAL. A non-partial `UNIQUE (message_id)` refuses
    // the second row here — and the second row is the `external_copy` this slice exists to record,
    // so the table would be unable to hold the very thing it was built for.
    expect(await insert({
      mailboxId: mailboxA, messageId: messageOne, folder: "INBOX", uidvalidity: 10, uid: 5,
      isPrimary: true,
    })).toBeNull();
    expect(await insert({
      mailboxId: mailboxA, messageId: messageOne, folder: "ohmail/News", uidvalidity: 10, uid: 6,
      isPrimary: false,
    })).toBeNull();
  });

  it("REFUSES a second PRIMARY for one message — 23505 on message_instances_primary_uq", async () => {
    // Absent this index, `messages.native_locator` (the primary's mirror) and the table can disagree
    // about where a message is, and `setPrimaryInstance`'s UPDATE would move an arbitrary one of two.
    expect(await insert({
      mailboxId: mailboxA, messageId: messageOne, folder: "Archive", uidvalidity: 10, uid: 7,
      isPrimary: true,
    })).toBe("23505");
  });

  it("REFUSES two messages at ONE locator — 23505 on message_instances_locator_uq", async () => {
    // One UID inside one epoch is one physical place. Two rows claiming it would let the known-set
    // report a locator for a message that is not there, and `applyExternalFlag`-style locator lookups
    // would resolve to the wrong row.
    expect(await insert({
      mailboxId: mailboxA, messageId: messageTwo, folder: "INBOX", uidvalidity: 10, uid: 5,
      isPrimary: true,
    })).toBe("23505");
  });

  it("ACCEPTS the same (folder, uid) under a DIFFERENT EPOCH — the epoch is in the key", async () => {
    // A folder that resets its UIDVALIDITY commonly re-allocates from low numbers, so `INBOX#5`
    // under epoch 11 is a DIFFERENT message from `INBOX#5` under epoch 10. Drop `uidvalidity` from
    // the unique and this is 23505: the new message cannot be recorded, its body is never fetched,
    // and the cursor advances past it — CODEX-X1H finding 2, one layer down.
    expect(await insert({
      mailboxId: mailboxA, messageId: messageTwo, folder: "INBOX", uidvalidity: 11, uid: 5,
      isPrimary: true,
    })).toBeNull();
  });

  it("ACCEPTS the same (folder, epoch, uid) in a DIFFERENT MAILBOX — the account boundary", async () => {
    // `(folder, uid)` repeats across every mailbox on the planet. `mailbox_id` leads the key, so one
    // account's IMAP server can never dictate another's locator — the "Account isolation is absolute, and it binds staff too" invariant, expressed as an index.
    const other = randomUUID();
    await db.execute(sql`
      insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address)
      values (${other}, ${accountId}, ${mailboxB}, 'h', ${`fp1:other-${other}`}, 's', 'a@b.test')`);
    expect(await insert({
      mailboxId: mailboxB, messageId: other, folder: "INBOX", uidvalidity: 10, uid: 5,
      isPrimary: true,
    })).toBeNull();
  });

  it("is_primary DEFAULTS to false — a copy cannot claim the primary slot by omission", async () => {
    // The schema half of the consent boundary. `recordInstance` is the call that records a DECLINED
    // copy; if the column defaulted to true, that call would silently take over the primary slot and
    // the adoption this whole slice prevents would arrive through the DDL instead of the code.
    const third = randomUUID();
    await db.execute(sql`
      insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address)
      values (${third}, ${accountId}, ${mailboxA}, 'h', ${`fp1:third-${third}`}, 's', 'a@b.test')`);
    await db.execute(sql`
      insert into message_instances (account_id, mailbox_id, message_id, folder, uidvalidity, uid)
      values (${accountId}, ${mailboxA}, ${third}, 'Junk', 99, 1)`);
    const rows = await db.execute<{ is_primary: boolean }>(sql`
      select is_primary from message_instances where message_id = ${third}`);
    expect([...rows].map((r) => r.is_primary)).toEqual([false]);
  });
});

describe.skipIf(!HAVE_PG)("0028's backfill copies a locator VERBATIM and is replayable", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let accountId: string;
  let mailboxId: string;

  beforeAll(async () => {
    client = postgres(DB_URL, { max: 1, onnotice: () => {} });
    db = brandDialect(drizzle(client), "pg");
    accountId = randomUUID();
    mailboxId = randomUUID();
    await db.execute(sql`insert into accounts (id, name) values (${accountId}, 'mi-backfill')`);
    await db.execute(sql`
      insert into mailboxes (id, account_id, provider, address)
      values (${mailboxId}, ${accountId}, 'imap', ${`bf-${mailboxId}@mi.test`})`);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await db.execute(sql`delete from message_instances where account_id = ${accountId}`).catch(() => undefined);
    await db.execute(sql`delete from messages where account_id = ${accountId}`).catch(() => undefined);
    await db.execute(sql`delete from mailboxes where account_id = ${accountId}`).catch(() => undefined);
    await db.execute(sql`delete from accounts where id = ${accountId}`).catch(() => undefined);
    await client.end({ timeout: 5 });
  });

  async function seed(locator: unknown): Promise<string> {
    const id = randomUUID();
    await db.execute(sql`
      insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address, native_locator)
      values (${id}, ${accountId}, ${mailboxId}, 'h', ${`mid:legacy-${id}`}, 's', 'a@b.test',
              ${locator === null ? null : sql`${JSON.stringify(locator)}::jsonb`})`);
    return id;
  }

  it("gives every native_locator row exactly one PRIMARY instance, and is idempotent", async () => {
    // The acceptance criterion, executed: `message_instances` equals the `native_locator IS NOT NULL`
    // count immediately after 0028. Row counts are scoped to this test's own account so the shared
    // Postgres cannot make it flaky.
    const ok = await seed({ folder: "INBOX", ref: "42:7" });
    const withoutLocator = await seed(null);
    const malformed = await seed({ folder: "INBOX", ref: "not-a-ref" });
    const noFolderKey = await seed({ ref: "42:9" });

    const statement = backfillStatement();
    await db.execute(sql.raw(statement));

    const rows = await db.execute<{
      message_id: string; folder: string; uidvalidity: string; uid: string; is_primary: boolean;
    }>(sql`
      select message_id, folder, uidvalidity::text as uidvalidity, uid::text as uid, is_primary
        from message_instances where account_id = ${accountId} order by message_id`);
    const byMessage = new Map([...rows].map((r) => [r.message_id, r]));

    // The locator is copied VERBATIM — 42 and 7, not recomputed from anything.
    expect(byMessage.get(ok)).toMatchObject({
      folder: "INBOX", uidvalidity: "42", uid: "7", is_primary: true,
    });
    // A row with no locator gets NO instance. That is what makes `primaryInstanceVanished` honest:
    // a message with nothing to be absent from must never read as a disappearance.
    expect(byMessage.has(withoutLocator)).toBe(false);
    // A ref that `makeRef` did not write lands as epoch 0 rather than being SKIPPED, so the count
    // identity holds — and epoch 0 is already the sentinel `buildCursor` drops, so the entry is
    // simply re-enumerated. Same outcome as the `parseUidValidity` fallback it replaces.
    expect(byMessage.get(malformed)).toMatchObject({ uidvalidity: "0", uid: "0", is_primary: true });
    // …and a locator with no `folder` key becomes the empty string rather than violating NOT NULL.
    expect(byMessage.get(noFolderKey)).toMatchObject({ folder: "", is_primary: true });

    const before = rows.length;
    expect(before).toBe(3);

    // REPLAY. `openLocalDb` re-runs both journals on every launch and any recovery from a
    // `PartialMigrationError` replays this file. A bare INSERT would raise 23505 on the partial
    // unique here and take the whole migration with it.
    await db.execute(sql.raw(statement));
    const after = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from message_instances where account_id = ${accountId}`);
    expect(Number([...after][0]!.n)).toBe(before);
  });

  it("a replay after the instance MOVED does not resurrect the old locator", async () => {
    // The dangerous replay: production has been running, a message has been organized, and the
    // migration runs again. The backfill must not re-assert the ARRIVAL locator over the current one.
    const id = await seed({ folder: "INBOX", ref: "42:100" });
    const statement = backfillStatement();
    await db.execute(sql.raw(statement));
    // The worker moves it, exactly as `updateLocator` does: mirror and instance together.
    await db.execute(sql`
      update messages set native_locator = '{"folder":"ohmail/News","ref":"42:200"}'::jsonb
       where id = ${id}`);
    await db.execute(sql`
      update message_instances set folder = 'ohmail/News', uid = 200
       where message_id = ${id} and is_primary`);

    await db.execute(sql.raw(statement));

    // `uid` is int8 since mail 0131, which postgres.js hands back as a string: read as text.
    const rows = await db.execute<{ folder: string; uid: string }>(sql`
      select folder, uid::text as uid from message_instances where message_id = ${id}`);
    // ONE row, still at the moved locator. `ON CONFLICT DO NOTHING` is what makes that true: the
    // partial unique refuses the second primary and the statement declines rather than failing.
    expect([...rows]).toEqual([{ folder: "ohmail/News", uid: "200" }]);
  });
});
